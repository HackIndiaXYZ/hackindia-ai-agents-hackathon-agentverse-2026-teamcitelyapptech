import * as api from './services/api';
import { adapter } from './lib/adapter';
import { asset, INGEST_DEFAULTS, TIMEOUTS } from './config';
const pendingFiles = new Map<string, File>();
import type { DocumentPage, Annotation, AnnotationCreate, Note, NoteRevision } from './types/api';
import * as ranges from './lib/ranges.mjs';
import {pollUpload} from './lib/upload-poll.mjs';
import {startUpload as startUploadSafely} from './lib/upload-start.mjs';
import {workspacePresence} from './lib/presence.mjs';
import {loadSnapshot, saveSnapshot} from './lib/snapshot.mjs';
import { ensureAwake, markServerReady, markServerUnknown, wakingMessage } from './lib/wake';
const pages = new Map<string, DocumentPage[]>();
// Writes (and answers being generated) currently in flight. The workspace only
// swaps views in-page when this is zero: a write's continuation updates local
// bookkeeping for the view that started it, so it must not outlive that view.
// Reads are not counted — their continuations check they are still current.
let inflightWrites = 0;
const viewerModules: Record<string, Promise<any>> = {};
const trackWrite = <T>(p: Promise<T>): Promise<T> => { inflightWrites++; return p.finally(() => { inflightWrites--; }); };
const send = <T>(path:string, method:string, value:unknown, signal?:AbortSignal) => api.request<T>(path, {method,headers:api.authHeaders({'Content-Type':'application/json'}),body:value === undefined ? undefined : JSON.stringify(value),timeout:TIMEOUTS.query,signal});
/** Reads are retried after a transient failure (no response, 502/503/504),
 *  waiting for the server to report ready in between. Writes are never retried
 *  here: they are revision-checked, and an ambiguous failure is reconciled by
 *  re-reading (the existing 409 path), not by sending the write again. */
async function retryRead<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { const value = await run(); markServerReady(); return value; }
    catch (e) {
      if (!(e instanceof api.ApiError) || !e.isTransient || attempt >= 2) throw e;
      markServerUnknown();
      await ensureAwake({ signal });
    }
  }
}
const request = <T>(path:string, method='GET', value?:unknown, signal?:AbortSignal): Promise<T> =>
  method === 'GET' ? retryRead(() => send<T>(path, method, value, signal), signal) : trackWrite(send<T>(path, method, value, signal));
const setBootStatus = (text: string) => { const el = document.querySelector('#root .boot span'); if (el) el.textContent = text; };
const statePath = (key:string) => '/state/' + encodeURIComponent(key);
const bridge = {
 asset, pages, pendingFiles, ranges, development: process.env.NODE_ENV !== 'production',
 // Formats rendered from the original file. Off unless enabled at build time.
 viewers: { docx: process.env.NEXT_PUBLIC_VIEWER_DOCX === 'true', pdf: process.env.NEXT_PUBLIC_VIEWER_PDF === 'true', xlsx: process.env.NEXT_PUBLIC_VIEWER_XLSX === 'true', pptx: process.env.NEXT_PUBLIC_VIEWER_PPTX === 'true' },
 loadViewer: (kind: 'docx' | 'xlsx' | 'pptx' | 'pdf') => (viewerModules[kind] ||= import(/* webpackIgnore: true */ asset(`/viewers/${kind}.js`))),
 originalFile: (id: string, signal?: AbortSignal) => api.fetchOriginal(id, signal),
 inflightWrites: () => inflightWrites,
 /** Demo allowance for the signed-in account (404 from an older backend reads as unlimited). */
 usage: () => retryRead(() => api.getUsage()).catch(e => { if (e instanceof api.ApiError && e.status === 404) return { limited: false }; throw e; }),
 /** The signed-in user from this device's session, without asking the
  *  server — null when signed out or the privacy policy is not accepted. */
 async sessionUser() { const s = await adapter.session(); return s?.acceptedPrivacyVersion ? s.user : null; },
 snapshot: { load: loadSnapshot, save: saveSnapshot },
 wakingMessage,
 async init() {
  const session = await adapter.session();
  if (!session) { location.replace(asset('/signin/')); throw Error('Please sign in to open your workspace.'); }
  if (!session.acceptedPrivacyVersion) { location.replace(asset('/home/')); throw Error('Review the privacy policy to continue.'); }
  // Presence and keep-warm in one: while the workspace is visible and in use,
  // this tab tells the server about once a minute (which also keeps the
  // scale-to-zero backend awake: reading or writing notes sends nothing),
  // and says so when it is hidden or closed. That is the admin console's
  // "online". It stops 10 minutes after the last input, so a forgotten tab
  // lets the server sleep. Until the server is confirmed awake it is a plain
  // health read (nothing but the wake itself is sent to a sleeping server).
  // The first signal of the visit also records it, with the timezone.
  let awake = false;
  const tab = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
  const timezone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; } })();
  const presence = workspacePresence({
   ready: () => awake,
   warm: () => { void api.getHealth().then(() => markServerReady(), () => {}); },
   send: (signal, leaving) => {
    const sent = api.sendPresence({...signal, state: signal.state as api.PresenceState, tab, ...(signal.first ? {timezone, path: location.pathname} : {})}, leaving);
    // A failed signal is retried by the next one; a transient failure
    // means the server may be waking, so check it the way reads do.
    return sent?.then(() => markServerReady(), e => { if (e instanceof api.ApiError && e.isTransient) markServerUnknown(); throw e; });
   },
  });
  // Signed out in this tab: nothing more. (Signing out in another tab of
  // this browser removes the token, so this one has nothing to send with,
  // and the server has already stopped counting every tab of the browser.)
  window.addEventListener('rag:signed-out', () => presence.stop());
  // Wait for a scale-to-zero backend before the first read, instead of letting
  // that read time out mid-wake. Bounded; a timeout reaches boot()'s Retry.
  let ticker: ReturnType<typeof setInterval> | undefined;
  try {
   await ensureAwake({ onState: s => {
    if (s !== 'waking' || ticker) return;
    const started = Date.now();
    setBootStatus(wakingMessage(0));
    ticker = setInterval(() => setBootStatus(wakingMessage(Date.now() - started)), 1000);
   } });
  } finally { clearInterval(ticker); }
  awake = true;
  presence.beat();
  const profile = await bridge.read('profile');
  const pending = JSON.parse(sessionStorage.getItem('citely.pending-profile') || 'null');
  if(pending?.email === session.user.email) {
   await bridge.write('profile',{name:pending.name},profile.revision);
   sessionStorage.removeItem('citely.pending-profile');
   return {...session.user,name:pending.name};
  }
  return {...session.user,name:profile.value?.name || session.user.email.split('@')[0]};
 },
 async logout() { await adapter.signOut(); location.assign(asset('/signin/')); },
 // Browsers trusted to skip the emailed sign-in code, and "sign out everywhere".
 trustedBrowsers: async () => (await api.listTrustedBrowsers()).items,
 removeTrustedBrowser: (id: string) => api.removeTrustedBrowser(id),
 // Signing out fires rag:signed-out, whose listener below goes to /signin/.
 async signOutEverywhere() { await adapter.signOutEverywhere(); },
 async read(key:string) { return request<{value:any;revision:number}>(statePath(key)); },
 async write(key:string,value:unknown,revision:number) { return request<{revision:number;updated:string}>(statePath(key),'PUT',{value,revision}); },
 documents: () => retryRead(() => api.listDocuments()),
 deleteDocument: api.deleteDocument,
 async loadPages(id:string, signal?:AbortSignal) { pages.set(id,await request<DocumentPage[]>('/documents/'+encodeURIComponent(id)+'/pages','GET',undefined,signal)); return pages.get(id)!; },
 annotations: (conversation:string) => request<Annotation[]>('/conversations/'+encodeURIComponent(conversation)+'/annotations'),
 createAnnotation: (conversation:string, value:AnnotationCreate) => request<Annotation>('/conversations/'+encodeURIComponent(conversation)+'/annotations','POST',value),
 deleteAnnotation: (id:string) => request('/annotations/'+encodeURIComponent(id),'DELETE'),
 deleteConversationAnnotations: (conversation:string) => request('/conversations/'+encodeURIComponent(conversation)+'/annotations','DELETE'),
 note: (conversation:string) => request<Note>('/conversations/'+encodeURIComponent(conversation)+'/notes'),
 saveNote: (conversation:string, content:string, expected_revision:number, workspace_id:string) => request<Note>('/conversations/'+encodeURIComponent(conversation)+'/notes','PUT',{content,expected_revision,workspace_id}),
 deleteNote: (conversation:string) => request('/conversations/'+encodeURIComponent(conversation)+'/notes','DELETE'),
 noteHistory: (conversation:string) => request<NoteRevision[]>('/conversations/'+encodeURIComponent(conversation)+'/notes/versions'),
 restoreNote: (conversation:string, revision:number) => request<Note>('/conversations/'+encodeURIComponent(conversation)+'/notes/versions/'+revision+'/restore','POST'),
 history: (id:string) => retryRead(() => api.getChatHistory(id)),
 deleteHistory: (id:string) => request('/documents/'+encodeURIComponent(id)+'/history','DELETE'),
 async deleteConversation(spaceId:string, deskId:string, deskType:'file'|'folder') {
  // Order matters only in that each step is independently safe to retry: if
  // one fails partway, re-running this deletes what's left rather than
  // erroring on an already-gone row.
  await Promise.all([
   bridge.deleteState('chat:'+spaceId+':'+deskId),
   bridge.deleteNote(spaceId+':'+deskId),
   bridge.deleteConversationAnnotations(spaceId+':'+deskId),
   deskType==='file' ? bridge.deleteHistory(deskId) : Promise.resolve(),
  ]);
 },
 deleteState: (key:string) => request(statePath(key),'DELETE'),
 async ask(ids:string[],question:string,progress:api.AnswerProgress={}) {
  if (!ids.length) throw Error('Add a ready document before asking a question.');
  if (ids.length > 25) throw Error('Folder conversations support up to 25 connected documents.');
  return trackWrite(api.queryStream(ids[0],question,INGEST_DEFAULTS.topK,ids.slice(1),progress));
 },
 startUpload: (file:File,signal?:AbortSignal,clientUploadId?:string,onWait?:(text:string)=>void) => trackWrite(startUploadSafely(
  s => api.ingestAsync({file,...INGEST_DEFAULTS,clientUploadId},s),
  {signal,onWait,isTransient:(e:unknown) => { const t = e instanceof api.ApiError && e.isTransient; if (t) markServerUnknown(); return t; },
   awake:({signal}:{signal?:AbortSignal}) => ensureAwake({signal})})),
 // Samples the admin offers in Upload. Listed once the server is awake;
 // using one is an upload (same retry-safe start, job and limits).
 samples: async () => { await ensureAwake(); return (await api.listSamples()).groups; },
 startSample: (sampleId:string,signal?:AbortSignal,clientUploadId?:string,onWait?:(text:string)=>void) => trackWrite(startUploadSafely(
  s => api.useSample(sampleId,clientUploadId,s),
  {signal,onWait,isTransient:(e:unknown) => { const t = e instanceof api.ApiError && e.isTransient; if (t) markServerUnknown(); return t; },
   awake:({signal}:{signal?:AbortSignal}) => ensureAwake({signal})})),
 pollUpload: (job:any,options:any) => pollUpload(job,api.getIngestJob,{timeout:TIMEOUTS.ingest,...options}),
};
(window as any).CitelyAPI = bridge;
window.addEventListener('rag:signed-out',()=>location.replace(asset('/signin/')));
// Tells services/api that this page already redirects when the session ends.
(window as any).__citelySignOutRedirects = true;

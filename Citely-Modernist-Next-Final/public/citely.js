'use strict';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone=v=>JSON.parse(JSON.stringify(v)), uid=()=>crypto.randomUUID?crypto.randomUUID():Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join(''), clock=()=>new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
const theme='modernist';
const paths={file:'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h4',folder:'M3 6h7l2 3h9v12H3z M3 6V4h6l3 3',grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',list:'M8 6h13M8 12h13M8 18h13M3 6h1M3 12h1M3 18h1',chat:'M3 4h18v13H8l-5 4z',arrow:'M5 12h14M13 6l6 6-6 6',upload:'M12 17V3M6 9l6-6 6 6M4 17v4h16v-4',search:'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14M15 15l6 6',plus:'M12 4v16M4 12h16',sun:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1',note:'M5 3h14v18H5zM8 8h8M8 12h8M8 16h5',team:'M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M2 21v-3a6 6 0 0 1 12 0v3M16 4a4 4 0 0 1 0 8M18 15a5 5 0 0 1 4 5',save:'M4 3h14l3 3v15H3V3z M7 3v6h10V3M7 21v-8h10v8',download:'M12 3v13M7 11l5 5 5-5M3 18v3h18v-3',share:'M9 12l6-6M9 12l6 6M18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6M6 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6M18 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6',highlighter:'m5 16 9-12 6 5-9 12-6-5z M3 21h9',check:'m4 12 5 5L20 6',copy:'M8 8h13v13H8zM16 8V3H3v13h5',more:'M5 11v2M12 11v2M19 11v2',back:'M19 12H5M11 6l-6 6 6 6',close:'m5 5 14 14M19 5 5 19',trash:'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 11v6 M14 11v6'};
function ico(n){return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[n]||paths.file}"/></svg>`}
function logo(){return `<div class="source-point" role="img" aria-label="Citely"><img class="source-point-light" src="${esc(window.CitelyAPI.asset('/branding/citely-02-evidence-accent.svg'))}" width="674" height="256" alt=""><img class="source-point-dark" src="${esc(window.CitelyAPI.asset('/branding/citely-03-night.svg'))}" width="674" height="256" alt=""></div>`}
const initialCatalog={orgs:[{id:'personal',name:'Personal',spaces:[{id:'org',name:'My workspace',docs:[],folders:[]}]}]};
let directory=[];
const pageCache=window.CitelyAPI.pages;
const R=window.CitelyAPI.ranges;
let savedAnnotations=[],annotationsReady=false,annotationError='',annotationBusy=false;
let noteBase={revision:0,content:''},notesReady=false,noteError='',activeCitationId=null,activeMessageId=null;
// When the open citation was opened, and a counter that flips the flash
// animation on each click so it replays (see annotations.css).
let citationFlashAt=-Infinity,citationFlashes=0,flashTimer=0;const FLASH_MS=3500;
function flashCitation(){
 citationFlashAt=performance.now();citationFlashes++;clearTimeout(flashTimer);
 flashTimer=setTimeout(()=>{const paper=$('#paper');if(paper)paper.classList.add('flash-done')},FLASH_MS);
}
function flashAttrs(){const elapsed=Math.round(performance.now()-citationFlashAt);return ` data-flash="${citationFlashes}" style="--flash-delay:-${Math.max(0,elapsed)}ms`+'"'}
function flashClass(){return performance.now()-citationFlashAt>FLASH_MS?' flash-done':citationFlashes%2?' flash-b':''}
const pageErrors=new Map(),pageLoading=new Set(),pageRequests=new Map();
let statusMessage='',citationNavigation=0,chatBase='';
const warnedCitations=new Set();
// Originals rendered as documents. Keyed by document id: a rendered original is
// document-level state, valid in any conversation that shows that document.
const originalInfo=new Map(),viewerRoots=new Map(),viewerLoads=new Map(),viewerFailed=new Set(),viewerPage=new Map(),viewerKinds=new Map(),viewerModules={},viewerRevealed=new Map();
// Original-file info arrives with the document list at boot. A document added
// later in the session (an upload) is looked up once, on demand.
const originalInfoAsked=new Set();let originalInfoRefresh=null;
function refreshOriginalInfo(){
 return originalInfoRefresh||=(async()=>{
  try{for(const d of await window.CitelyAPI.documents())originalInfo.set(d.id,{has:!!d.has_original,compatible:d.original_compatible!==false})}catch{}
  finally{originalInfoRefresh=null;redrawFallbackThumbs();render()}
 })();
}
const params=new URLSearchParams(location.search);
let dark=false, catalog=null, currentSpace=params.get('space')||'org',folderId=null,view='home',fileView='list',query='',selection=new Set(),deskId=params.get('desk'),desk=null,work=null,annotationRecords={},activeDocId=null,currentPage=4,zoom=100,landscape=false,dirty=false,dirtyAnn=new Set(),busy=false,mobilePane='document',highlightTool=false,tempCitations=[],docFilter='all',tabScroll=0,chatScroll=null,guest=null,signedIn=true,draft='',storageVersions=new Map();
try{dark=(localStorage.getItem('citely-'+theme+'-mode')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'))==='dark'}catch{}
// The embedded demo follows the website theme without changing product sessions.
if(window.CitelyAPI.demo)window.addEventListener('message',e=>{if(e.origin!==location.origin||e.source!==parent||e.data?.type!=='citely-demo-theme'||!['light','dark'].includes(e.data.theme))return;dark=e.data.theme==='dark';if(catalog)render();});
function space(){for(const o of catalog.orgs){const w=o.spaces.find(s=>s.id===currentSpace);if(w)return w}return catalog.orgs[0].spaces[0]}
function organization(){return catalog.orgs.find(o=>o.spaces.some(w=>w.id===space().id))}
function allSpaces(){return catalog.orgs.flatMap(o=>o.spaces.map(w=>({...w,orgName:o.name})))}
function doc(id){return allSpaces().flatMap(w=>w.docs).find(d=>d.id===id)}
function scopeDocs(){return desk?.type==='folder'?space().docs.filter(d=>d.folder===desk.id):[doc(desk?.id)].filter(Boolean)}
function activeDoc(){if(!activeDocId)return scopeDocs()[0];return doc(activeDocId)||{id:activeDocId,name:tempCitations.find(c=>c.docId===activeDocId)?.source||'Document',pages:Math.max(currentPage,...(pageCache.get(activeDocId)||[]).map(p=>p.page))}}
function initials(n){return n.split(' ').slice(0,2).map(n=>n[0]||'').join('').toUpperCase()}
let toastTimer,editRevision=0,unreadMessages=false;
// Instant open: while the server wakes, the workspace is shown from the copy
// kept on this device (lib/snapshot.mjs). `connecting` holds every action
// that needs the server until boot() has loaded the real data.
// Demo allowance from /me/usage ({limited:false} for the admin or when off).
// The server enforces it; this only explains it and avoids pointless requests.
let usageInfo={limited:false};
async function refreshUsage(){try{const next=await window.CitelyAPI.usage();const changed=JSON.stringify(next)!==JSON.stringify(usageInfo);usageInfo=next;if(changed)render()}catch{}}
function allowance(kind){return usageInfo.limited?usageInfo[kind]:null}
const dailyAllowance=()=>usageInfo?.period==='daily';
function limitText(kind){const a=allowance(kind);if(!a)return '';const noun=kind==='questions'?'questions':'document uploads';
 if(a.used>=a.limit&&dailyAllowance())return `You've used today's ${a.limit} ${noun}. They reset tomorrow.`;
 return a.used>=a.limit?`You've used all ${a.limit} ${noun} in this demo. Thank you for trying Citely!`:`The live demo has reached today's ${kind==='questions'?'question':'upload'} limit. Please try again tomorrow, or explore the guided demo.`}
// What the account has but can't use today because the whole site's daily
// limit (shared by everyone) is nearly reached. Shown, so "3 of 5" after a
// reset is explained instead of looking like the reset didn't work.
const heldBack=a=>Math.max(0,a.limit-Math.min(a.used,a.limit)-a.remaining);
const heldNote=a=>heldBack(a)?` · ${heldBack(a)} held back by the live demo's shared daily limit`:'';
function usageNote(kind){const a=allowance(kind);if(!a)return '';return a.remaining>0?`${a.remaining} of ${a.limit} demo ${kind} left${dailyAllowance()?' today':''}${heldNote(a)}`:limitText(kind)}
const outOf=kind=>{const a=allowance(kind);return !!a&&a.remaining<=0};
// The upload allowance as a meter, shown in the Upload dialog: a bar of the
// account's uploads plus the per-file limits, or the note once they're used up.
function uploadMeter(){const a=allowance('uploads');if(!a)return '';
 // The bar and the words must say the same thing. remaining is what is really
 // left: the account's own uploads, further limited by the whole site's daily
 // cap (shared by everyone). Boxes the account owns but the daily cap holds
 // back are drawn dashed, and the words say why there are fewer.
 const used=Math.min(a.used,a.limit),free=Math.max(0,Math.min(a.remaining,a.limit-used)),held=Math.max(0,a.limit-used-free);
 const bar=Array.from({length:a.limit},(_,i)=>`<i class="${i<used?'used':i<used+free?'':'capped'}"></i>`).join('');
 const words=a.remaining>0?`<strong>${free} of ${a.limit}</strong> demo uploads left${dailyAllowance()?' today':''}${heldNote(a)} · up to ${usageInfo.max_upload_mb} MB and ${usageInfo.max_pages} pages each`:esc(limitText('uploads'));
 return `<div class="usage-meter${a.remaining<=0?' exhausted':''}" role="status" aria-label="${esc(usageNote('uploads'))}"><span class="usage-bar" aria-hidden="true">${bar}</span><span>${words}</span></div>`}
let connecting=false,connectingSince=0,connectError='',connectTicker=0,snapshotTimer=0,lastSnapshotDesk=null,signedOut=false;
const SERVER_ACTIONS='[data-upload],[data-new-folder],[data-group],[data-move],[data-bulk-delete],[data-delete-doc],[data-delete-conversation],[data-rename],[data-manage],[data-retry],[data-retry-page],[data-share],[data-share-notes],[data-export],[data-collaborate],[data-more],[data-citation],[data-annotation],[data-delete-annotation],#save-changes,#keep-citations,#highlight-tool,#notes-history,[data-prompt]';
function connectingText(){return connectError?'Could not reach the server: '+connectError:window.CitelyAPI.wakingMessage(Date.now()-connectingSince)}
function holdForServer(){toast('Connecting to the server… this will work as soon as it is ready.')}
document.addEventListener('click',e=>{if(!window.CitelyAPI.demo)return;if(e.target.closest?.('#more-team,#more-share,[data-manage],[data-workspaces]')){e.preventDefault();e.stopImmediatePropagation();if(typeof dxClosePop==='function')dxClosePop();modal('Your private workspace',`<p class="modal-description">Sharing, invitations and account management are available in the full product. This demo stays private in your browser tab and sends nothing to other people.</p><p class="fine-print">You can explore files, folders, conversations, original documents, highlights, notes and exports here.</p>`);}},true);
document.addEventListener('click',e=>{if(connecting&&e.target.closest?.(SERVER_ACTIONS)){e.preventDefault();e.stopImmediatePropagation();holdForServer()}},true);
function snapshotNow(){
 if(signedOut||connecting||!catalog||!directory[0])return;
 if(deskId&&desk&&work)lastSnapshotDesk={space:currentSpace,id:deskId,type:desk.type,name:desk.name,work:{...chatSnapshot(),notes:work.notes}};
 window.CitelyAPI.snapshot.save({savedAt:Date.now(),user:directory[0],catalog,
  documents:[...originalInfo].map(([id,o])=>({id,has_original:o.has,original_compatible:o.compatible})),desk:lastSnapshotDesk});
}
function scheduleSnapshot(){clearTimeout(snapshotTimer);snapshotTimer=setTimeout(snapshotNow,1500)}
window.addEventListener('pagehide',()=>{clearTimeout(snapshotTimer);snapshotNow()});
// Signing out removes the copy (lib/adapter.ts); never write it back afterwards.
window.addEventListener('rag:signed-out',()=>{signedOut=true;clearTimeout(snapshotTimer)});
/** Shows the workspace from this device's copy, if there is one, while the
 *  server wakes. Returns false (and leaves the boot screen) when there isn't. */
async function restoreSnapshot(){
 const user=await window.CitelyAPI.sessionUser();if(!user)return false;
 const snap=window.CitelyAPI.snapshot.load(user.id);if(!snap)return false;
 directory=[snap.user];catalog=snap.catalog;lastSnapshotDesk=snap.desk||null;
 for(const d of snap.documents||[])originalInfo.set(d.id,{has:!!d.has_original,compatible:d.original_compatible!==false});
 if(!allSpaces().some(w=>w.id===currentSpace))currentSpace=allSpaces()[0].id;
 if(deskId){
  const cached=lastSnapshotDesk&&lastSnapshotDesk.id===deskId&&lastSnapshotDesk.space===currentSpace?lastSnapshotDesk:null;
  if(!cached||!(space().folders.some(f=>f.id===deskId)||doc(deskId)))return false;   // that conversation isn't saved here
  showCachedDesk(cached);
 }
 connecting=true;connectingSince=Date.now();render();
 connectTicker=setInterval(()=>{const pill=$('#connecting-pill span');if(pill)pill.textContent=connectingText()},1000);
 return true;
}
function showCachedDesk(cached){
 desk={type:cached.type,id:cached.id,name:cached.name};work=clone(cached.work);work.notes ||= '';
 work.messages=(work.messages||[]).map(m=>({...m,citations:mapCitations(m.citations||[],desk.id)}));
 chatBase=JSON.stringify(chatSnapshot());annotationRecords={};
 const last=work.messages.filter(m=>m.role==='assistant').at(-1);tempCitations=last?.citations||[];activeMessageId=last?.id||null;
 activeDocId=tempCitations[0]?.docId||scopeDocs()[0]?.id;currentPage=tempCitations[0]?.page||1;docFilter=tempCitations.length?'cited':'all';
}
function connected(){connecting=false;connectError='';clearInterval(connectTicker)}
// Library history follows locations, not changes to a file or theme.
let libraryHistory=[],libraryHistoryIndex=-1;
const fileScrollPositions=new Map();
function syncLibraryHistory(){
 const next={space:currentSpace,folder:folderId,view,place:filePlace};
 if(JSON.stringify(next)===JSON.stringify(libraryHistory[libraryHistoryIndex]))return;
 libraryHistory=libraryHistory.slice(0,libraryHistoryIndex+1);
 libraryHistory.push(next);libraryHistoryIndex=libraryHistory.length-1;
}
function travelLibrary(direction){
 const index=libraryHistoryIndex+direction,state=libraryHistory[index];
 if(!state)return;
 libraryHistoryIndex=index;currentSpace=state.space;folderId=state.folder;view=state.view;filePlace=state.place||'all';
 query='';selection.clear();render();
}
function historyButtons(){return `<div class="history-buttons" role="group" aria-label="Navigation history"><button class="icon-button" data-history="-1" aria-label="Go back" title="Go back" ${libraryHistoryIndex<=0?'disabled':''}>${ico('back')}</button><button class="icon-button" data-history="1" aria-label="Go forward" title="Go forward" ${libraryHistoryIndex>=libraryHistory.length-1?'disabled':''}>${ico('arrow')}</button></div>`}

function toast(t){$('#toast').textContent=t;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),3500)}
function modal(title,body,eyebrow){const m=$('#modal');m.classList.remove('wide');m.innerHTML=`<header>${eyebrow?`<div><span class="modal-eyebrow">${esc(eyebrow)}</span><h2 id="modal-title">${esc(title)}</h2></div>`:`<h2 id="modal-title">${esc(title)}</h2>`}<button class="icon-button" data-close aria-label="Close">${ico('close')}</button></header>${body}`;m.setAttribute('aria-labelledby','modal-title');m.dataset.theme=theme;m.dataset.dark=dark;m.querySelector('[data-close]').onclick=()=>m.close();if(!m.open)m.showModal();m.onclick=e=>{if(e.target===m)m.close()}}
function fail(e){console.error(e);toast(e.message||'Something went wrong. Please try again.')}
async function readRecord(key){const data=await window.CitelyAPI.read(key);storageVersions.set(key,data.revision);return data.value}
async function writeRecord(key,value){const data=await window.CitelyAPI.write(key,value,storageVersions.get(key)||0);storageVersions.set(key,data.revision);return data}
let catalogWrites=Promise.resolve();
function saveCatalog(){const save=catalogWrites.catch(()=>{}).then(()=>writeRecord('catalog',clone(catalog)));catalogWrites=save;return save}
// A dialog that changes the catalog. One submission at a time, with the button
// saying what is happening. A failed save may still have landed (the response
// was lost while the server woke), so the server copy is checked before an
// error is shown: if the change is there, the dialog completes normally.
async function catalogChange(form,{busyLabel,apply,landed,done,showError}){
 if(form.dataset.busy)return;form.dataset.busy='1';
 const button=form.querySelector('button.primary,button[type=submit],button:not([type])'),label=button?.textContent;
 if(button){button.disabled=true;button.textContent=busyLabel}
 const before=clone(catalog),snapshot=apply();
 try{await saveCatalog();done()}
 catch(e){
  let onServer=false;try{const fresh=await window.CitelyAPI.read('catalog');onServer=!!fresh.value&&landed(fresh.value,snapshot);if(onServer)storageVersions.set('catalog',fresh.revision)}catch{}
  if(onServer){done();return}
  catalog=before;showError(e.message);
 }finally{delete form.dataset.busy;if(button&&button.isConnected){button.disabled=false;button.textContent=label}}
}
const spaceIn=(c,id)=>c.orgs.flatMap(o=>o.spaces).find(w=>w.id===id);
function annotations(id){return {...(annotationRecords[id]||{layout:'portrait',zoom:100}),marks:savedAnnotations.filter(a=>a.document_id===id).map(a=>({...a,page:a.page_number}))}}
function newWork(){return {notes:'',members:[directory[0]],invites:[],access:'private',messages:[]}}
async function boot(){const restored=await restoreSnapshot();try{const user=await window.CitelyAPI.init();directory=[{id:user.id,name:user.name,email:user.email}];const documentsPending=window.CitelyAPI.documents();documentsPending.catch(()=>{});catalog=await readRecord('catalog');if(!catalog){catalog=clone(initialCatalog);try{await saveCatalog()}catch(e){catalog=await readRecord('catalog');if(!catalog)throw e}}if(!allSpaces().some(w=>w.id===currentSpace))currentSpace=allSpaces()[0].id;await syncDocuments(documentsPending);connected();void refreshUsage();if(deskId)await loadDesk();render();snapshotNow()}catch(e){if(restored&&connecting){connectError=e.message;render();return}$('#root').innerHTML=`<div class="boot">${logo()}<span>${esc(e.message)}</span><button class="button" onclick="location.reload()">Retry</button></div>`}}
async function loadDesk(){
 // Opening another conversation while this one is still loading must not let
 // this load finish into it: every continuation checks it is still current.
 const epoch=deskEpoch,stale=()=>epoch!==deskEpoch;
 const f=space().folders.find(f=>f.id===deskId),d=doc(deskId);
 if(!f&&!d){deskId=null;history.replaceState(null,'',window.CitelyAPI.asset('/studio.html'));toast('This item is no longer available.');return}
 desk={type:f?'folder':'file',id:deskId,name:f?.name||d.name};
 const record=await readRecord(workKey());if(stale())return;work=record;
 if(!work){work=newWork();if(desk.type==='file'){const history=await window.CitelyAPI.history(desk.id);if(stale())return;work.messages=history.flatMap(t=>[{id:t.id+'-question',role:'user',name:directory[0].name,text:t.question,time:new Date(t.created_at).toLocaleTimeString(),citations:[]},{id:t.id,role:'assistant',name:'Citely',text:t.answer,time:new Date(t.created_at).toLocaleTimeString(),citations:mapCitations(t.sources,desk.id)}]);}}
 work.notes ||= '';work.messages.forEach(m=>{m.id ||= uid();m.citations=mapCitations(m.citations||[],desk.id)});
 chatBase=JSON.stringify(chatSnapshot());annotationRecords={};
 const last=work.messages.filter(m=>m.role==='assistant').at(-1);tempCitations=last?.citations||[];activeMessageId=last?.id||null;
 activeDocId=tempCitations[0]?.docId||scopeDocs()[0]?.id;currentPage=tempCitations[0]?.page||1;setActiveView();docFilter=tempCitations.length?'cited':'all';
 render();
 await Promise.allSettled([loadNotes(),loadAnnotations(),...[...new Set([...scopeDocs().map(d=>d.id),...tempCitations.map(c=>c.docId)])].map(async id=>{const d={id};try{const view=await readRecord('view:'+d.id);if(stale())return;annotationRecords[d.id]=view||{layout:'portrait',zoom:100}}catch(e){if(!stale())notifyStatus(e.message)}await loadPageText(d.id)})]);if(stale())return;setActiveView();render();
}
function setActiveView(){const a=annotations(activeDocId);landscape=a.layout==='landscape';zoom=a.zoom||100;currentPage=Math.min(currentPage,activeDoc()?.pages||1)}
function modeButton(){return `<button class="icon-button appearance" data-mode title="Switch to ${dark?'light':'dark'} mode" aria-label="Switch to ${dark?'light':'dark'} mode">${ico('sun')}</button>`}
function background(){return '<div class="art-background" aria-hidden="true"><i></i><i></i><i></i><div class="grid-lines"></div></div>'}
function render(){if(!catalog)return;
 // Re-rendering replaces the whole workspace, which used to drop keyboard
 // focus: typing in the notes or question box while something loaded in the
 // background lost keystrokes. Remember the focused field and caret, restore
 // them below.
 const focused=document.activeElement,focusId=focused?.id&&$('#root')?.contains(focused)?focused.id:null;
 const caret=focusId&&typeof focused.selectionStart==='number'?[focused.selectionStart,focused.selectionEnd,focused.scrollTop]:null;
 const viewerFocus=focused?.closest?.('[data-original-host]')?.dataset.documentId;
 renderNow();
 if(viewerFocus&&document.activeElement===document.body)viewerModule(viewerFocus)?.restoreFocus?.(viewerRoots.get(viewerFocus));
 if(focusId){const el=document.getElementById(focusId);if(el&&el!==document.activeElement&&!el.disabled){el.focus({preventScroll:true});if(caret&&el.setSelectionRange){try{el.setSelectionRange(caret[0],caret[1]);el.scrollTop=caret[2]}catch{}}}}
}
// A redraw replaces the whole workspace, including the document pane, which used to snap
// back to its first page while the page counter still said otherwise (every saved highlight,
// answer or tool toggle did it). The pane's scroll position is kept across a redraw, but only
// for the same document on the same page: opening another page or citation scrolls on its own.
function paperScrollState(){const v=$('#paper-viewport');return v&&deskId&&desk?{doc:activeDoc()?.id,page:currentPage,top:v.scrollTop}:null}
function restorePaperScroll(keep){
 if(!keep||!keep.top||!deskId||!desk||activeDoc()?.id!==keep.doc||currentPage!==keep.page)return;
 const put=()=>{const v=$('#paper-viewport');if(!v)return;const before=v.style.scrollBehavior;v.style.scrollBehavior='auto';v.scrollTop=keep.top;v.style.scrollBehavior=before};
 put();requestAnimationFrame(put);   // again once the original has laid itself out
}
// Scrolls the document pane only. scrollIntoView also scrolls every ancestor, the window included,
// which pushed the top of the app out of view whenever the page had any spare height.
function scrollPaperTo(target,block='start',behavior='auto'){
 const v=$('#paper-viewport');if(!v||!target||!v.contains(target))return;
 const t=target.getBoundingClientRect(),r=v.getBoundingClientRect();
 let top=v.scrollTop+(t.top-r.top);if(block==='center')top-=(v.clientHeight-t.height)/2;
 v.scrollTo({top:Math.max(0,top),behavior})}
function renderNow(){syncUploadScope();if(!deskId&&!guest)syncLibraryHistory();const oldFiles=$('#file-items');if(oldFiles)fileScrollPositions.set(oldFiles.dataset.scrollKey,oldFiles.scrollTop);const old=$('#messages');if(old)chatScroll=old.scrollTop;const paperKeep=paperScrollState();document.body.dataset.theme=theme;document.body.dataset.mode=dark?'dark':'light';document.body.className=deskId?'desk-body':!guest?'library-files':'';const markup=background()+(deskId&&desk?deskHTML():libraryHTML())+(connecting?`<div class="connecting-pill" id="connecting-pill" role="status"><span>${esc(connectingText())}</span>${connectError?'<button class="text-button" onclick="location.reload()">Retry</button>':''}</div>`:''),rootEl=$('#root');if(!(deskId&&desk)&&rootEl.querySelector(':scope>.lx-shell'))morph(rootEl,markup);else rootEl.innerHTML=markup;if(!connecting)scheduleSnapshot();if(deskId&&desk){paintPageText();mountOriginal();restorePaperScroll(paperKeep);const ne=$('#notes-editor');if(ne)ne.value=work.notes;}bindCommon();if(deskId&&desk)bindDesk();else{bindLibrary();paintThumbs()}const files=$('#file-items');if(files)files.scrollTop=fileScrollPositions.get(files.dataset.scrollKey)||0}
// ---- Library (Files / Overview / Team) -----------------------------------
// One shell: top bar (brand, workspace menu, sections, account menu), a side
// bar (upload, folder, places, folders) and the main panel. Every change is
// applied in place by morph() below, so nothing on screen is rebuilt: rows,
// thumbnails, scroll and focus stay put, and entrance animations only play
// for things that are actually new.
let menu=null;
let sideCollapsed=(()=>{try{return localStorage.getItem('citely-side-collapsed')==='1'}catch{return false}})();
function toggleSide(){sideCollapsed=!sideCollapsed;try{localStorage.setItem('citely-side-collapsed',sideCollapsed?'1':'0')}catch{}render()}
const recentKey=()=>'citely-recent:'+currentSpace;
function recentMap(){try{return JSON.parse(localStorage.getItem(recentKey())||'{}')}catch{return {}}}
function noteOpened(id){if(!doc(id))return;try{const m=recentMap();m[id]=Date.now();localStorage.setItem(recentKey(),JSON.stringify(m))}catch{}}
function recentDocs(){const m=recentMap();return space().docs.filter(d=>m[d.id]).sort((a,b)=>m[b.id]-m[a.id])}
function themeChoice(){try{return localStorage.getItem('citely-'+theme+'-mode')||'system'}catch{return 'system'}}
function setThemeChoice(choice){try{localStorage.setItem('citely-'+theme+'-mode',choice)}catch{}dark=choice==='system'?matchMedia('(prefers-color-scheme: dark)').matches:choice==='dark';render()}
try{matchMedia('(prefers-color-scheme: dark)').addEventListener('change',e=>{if(themeChoice()==='system'){dark=e.matches;render()}})}catch{}
const fileKinds={pdf:['PDF','#B42318'],doc:['DOC','#2F62C9'],docx:['DOCX','#2F62C9'],ppt:['PPT','#C05A14'],pptx:['PPTX','#C05A14'],xls:['XLS','#1E7A45'],xlsx:['XLSX','#1E7A45'],csv:['CSV','#1E7A45']};
function kindOf(name){const ext=(String(name).split('.').pop()||'').toLowerCase();return fileKinds[ext]||[(ext||'file').toUpperCase().slice(0,4),'#5F646C']}
const chevron=`<svg class="lx-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
const docsIn=id=>space().docs.filter(d=>d.folder===id);
function wsMenuHTML(){return `<button class="lx-scrim" data-key="scrim-ws" data-close-menus aria-label="Close workspace menu"></button><div class="lx-menu lx-ws-menu" data-key="menu-ws" role="menu">${catalog.orgs.map(o=>`<div class="lx-menu-group"><div class="lx-menu-label"><span>${esc(o.name)}</span><button class="text-button" data-newspace="${o.id}">+ Workspace</button></div>${o.spaces.map(w=>`<button class="lx-mi" role="menuitem" data-switch="${w.id}"><span class="lx-ws-avatar small">${esc(initials(w.name))}</span><span class="lx-mi-text"><strong>${esc(w.name)}</strong><small>${w.docs.length} ${w.docs.length===1?'file':'files'}</small></span>${w.id===currentSpace?`<span class="lx-current" aria-label="Current">${ico('check')}</span>`:''}</button>`).join('')}</div>`).join('')}<div class="lx-menu-rule"></div><button class="lx-mi" role="menuitem" data-rename>${ico('note')}Rename this workspace</button><button class="lx-mi" role="menuitem" data-create-org>${ico('plus')}Create organization</button></div>`}
function avatarMenuHTML(){const me=directory[0],c=themeChoice();return `<button class="lx-scrim" data-key="scrim-avatar" data-close-menus aria-label="Close account menu"></button><div class="lx-menu lx-account-menu" data-key="menu-avatar" role="menu"><div class="lx-account-card"><span class="lx-avatar big">${esc(initials(me.name))}</span><span><strong>${esc(me.name)}</strong><small>${esc(me.email)}</small></span></div><div class="lx-menu-label"><span>Appearance</span></div><div class="lx-theme" role="group" aria-label="Appearance">${[['light','sun','Light'],['dark','moon','Dark'],['system','screen','System']].map(([v,i,n])=>`<button data-theme-choice="${v}" aria-pressed="${c===v}" class="${c===v?'on':''}">${i==='sun'?ico('sun'):lxIcon(i)}<span>${n}</span></button>`).join('')}</div>${c==='system'?`<p class="lx-theme-note">Following your device: ${dark?'dark':'light'}</p>`:''}<div class="lx-menu-rule"></div><button class="lx-mi" role="menuitem" data-manage>${ico('download')}Copy or export workspace</button><button class="lx-mi" role="menuitem" data-tour>${lxIcon('play')}How it works</button>${window.CitelyAPI.demo?'':`<button class="lx-mi" role="menuitem" data-trusted>${lxIcon('screen')}Trusted browsers</button>`}${window.CitelyAPI.demo?`<button class="lx-mi" role="menuitem" data-demo-reset>${lxIcon('clock')}Reset demo</button><a class="lx-mi" href="${esc(window.CitelyAPI.asset('/'))}" target="_top">${lxIcon('signout')}Back to Citely</a>`:`<button class="lx-mi lx-danger" role="menuitem" data-logout>${lxIcon('signout')}Sign out</button>`}</div>`}
const lxPaths={moon:'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',screen:'M3 4h18v12H3z M8 20h8 M12 16v4',play:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M10 8l6 4-6 4z',signout:'M15 4h4v16h-4 M10 17l-5-5 5-5 M5 12h11',clock:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2',all:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',panel:'M3 4h18v16H3z M9 4v16',pencil:'M4 20h4L19 9l-4-4L4 16v4z',pages:'M6 3h9l4 4v14H6z M14 3v5h5',disk:'M4 7c0-2 16-2 16 0v10c0 2-16 2-16 0z M4 7c0 2 16 2 16 0 M4 12c0 2 16 2 16 0'};
function lxIcon(n){return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${lxPaths[n]}"/></svg>`}
function libraryHTML(){const o=organization(),w=space(),me=directory[0],recents=recentDocs().length;
 return `<div class="lx-shell${menu?' menu-open':''}${sideCollapsed?' side-collapsed':''}"><header class="lx-top" data-key="top"><button class="icon-button lx-side-toggle" data-toggle-side aria-label="${sideCollapsed?'Show':'Hide'} the sidebar" title="${sideCollapsed?'Show':'Hide'} the sidebar" aria-expanded="${!sideCollapsed}">${lxIcon('panel')}</button><a class="brand lx-brand" href="${window.CitelyAPI.asset('/')}" aria-label="Citely website">${logo()}</a><div class="lx-ws"><button class="lx-ws-btn" data-menu="ws" aria-haspopup="true" aria-expanded="${menu==='ws'}"><span class="lx-ws-avatar">${esc(initials(w.name))}</span><span class="lx-ws-text"><small>${esc(o.name)}</small><strong>${esc(w.name)}</strong></span>${chevron}</button>${menu==='ws'?wsMenuHTML():''}</div><button class="icon-button lx-rename" data-rename aria-label="Rename workspace" title="Rename workspace">${lxIcon('pencil')}</button><nav class="lx-tabs" aria-label="Sections">${[['home','Files'],['overview','Overview'],['team','Team']].map(([v,n])=>`<button data-view="${v}" class="lx-tab ${view===v?'active':''}" ${view===v?'aria-current="page"':''}>${n}${v==='team'?'<span class="lx-soon">Soon</span>':''}</button>`).join('')}</nav><div class="lx-account"><button class="lx-avatar-btn" data-menu="avatar" aria-haspopup="true" aria-expanded="${menu==='avatar'}" aria-label="Account and appearance"><span class="lx-avatar">${esc(initials(me.name))}</span>${chevron}</button>${menu==='avatar'?avatarMenuHTML():''}</div></header><div class="lx-palette" data-key="palette" aria-hidden="true"></div>
 <div class="lx-body" data-key="body"><aside class="lx-side" data-key="side" aria-label="Library"><div class="lx-side-actions"><button class="button primary" data-upload ${outOf('uploads')?'data-exhausted':''} title="Upload">${ico('upload')}<span>Upload</span></button><button class="button" data-new-folder title="New folder">${ico('plus')}<span>Folder</span></button></div><nav class="lx-places"><button class="lx-place ${view==='home'&&filePlace==='all'&&!folderId&&!query?'active':''}" data-root-folder title="All files">${lxIcon('all')}<span>All files</span><b>${w.docs.length}</b></button><button class="lx-place ${view==='home'&&filePlace==='recent'&&!query?'active':''}" data-recent title="Recently opened">${lxIcon('clock')}<span>Recently opened</span><b>${recents}</b></button></nav><div class="lx-folders" data-key="folders"><div class="lx-side-head"><span>Folders</span><b>${w.folders.length}</b></div>${w.folders.length?[...w.folders].sort((a,b)=>a.name.localeCompare(b.name)).map(f=>`<button class="lx-place ${view==='home'&&folderId===f.id&&!query?'active':''}" data-folder="${f.id}" title="${esc(f.name)}">${ico('folder')}<span>${esc(f.name)}</span><b>${docsIn(f.id).length}</b></button>`).join(''):'<p class="lx-hint">Group related files so you can chat with them together.</p>'}</div><div class="lx-side-foot"><p>Start with a source.<br>Leave with an answer.</p><button class="text-button" data-tour>See the workflow ${ico('arrow')}</button></div></aside>
 <main class="lx-main" data-key="view-${view}">${view!=='home'?`<div class="lx-subbar" data-key="subbar">${historyButtons()}</div>`:''}${view==='overview'?overviewHTML():view==='team'?teamHTML():filesHTML()}</main></div></div>`}
let filePlace='all';
function placeDocs(){return filePlace==='recent'&&!query?recentDocs():visibleDocs()}
function filesHTML(){const w=space(),f=w.folders.find(f=>f.id===folderId),inFolder=f&&filePlace==='all';
 const crumb=query?`<span aria-hidden="true">/</span><strong>Search</strong>`:filePlace==='recent'?`<span aria-hidden="true">/</span><strong>Recently opened</strong>`:inFolder?`<span aria-hidden="true">/</span><strong>${esc(f.name)}</strong>`:'';
 const count=inFolder?docsIn(f.id).length:w.docs.length;
 return `<div class="lx-files" data-key="files">${inFolder?`<div class="lx-folder-head" data-key="fh-${f.id}"><div><span class="eyebrow">FOLDER</span><h1>${esc(f.name)}</h1><p>${count} ${count===1?'document':'documents'}. Chat with the whole folder or any file in it.</p></div><div class="lx-folder-actions"><button class="button primary" data-open="${f.id}" ${count?'':'disabled'}>${ico('chat')}Chat with folder →</button><button class="button destructive-quiet" data-delete-folder="${f.id}">${ico('trash')}Delete folder</button></div></div>`:''}
 <section class="lx-panel" data-key="panel" id="file-panel" aria-label="Files"><div class="lx-drop" data-key="drop" aria-hidden="true">${ico('upload')}<strong>Drop to add to ${esc(inFolder?f.name:w.name)}</strong><span>PDF, Word, PowerPoint, Excel or images</span></div>
 <div class="lx-toolbar" data-key="toolbar">${historyButtons()}<nav class="lx-crumbs" aria-label="Breadcrumb"><button data-root-folder class="${crumb?'':'here'}">${esc(w.name)}</button>${crumb}</nav><label class="lx-search">${ico('search')}<input id="file-search" value="${esc(query)}" placeholder="Search every file and folder" aria-label="Search files"></label><button class="button lx-toolbar-upload" data-upload ${outOf('uploads')?'data-exhausted':''}>${ico('upload')}<span>Upload</span></button><div class="view-switch" role="group" aria-label="File view"><button data-fileview="list" class="${fileView==='list'?'active':''}" aria-pressed="${fileView==='list'}" aria-label="List view">${ico('list')}</button><button data-fileview="grid" class="${fileView==='grid'?'active':''}" aria-pressed="${fileView==='grid'}" aria-label="Grid view">${ico('grid')}</button></div></div>
 ${selection.size?`<div class="lx-bulk" data-key="bulk" role="toolbar" aria-label="Selected files"><strong>${selection.size} selected</strong><button class="text-button" data-group>${ico('folder')}New folder with selection</button><button class="text-button" data-move>Move to…</button><button class="text-button" data-export-selected>${ico('download')}Export</button><button class="text-button destructive" data-bulk-delete>${ico('trash')}Delete</button><button class="text-button lx-bulk-clear" data-clear>Clear</button></div>`:''}
 <div id="file-items" role="region" aria-label="Files and folders" tabindex="0" data-scroll-key="${esc(currentSpace+':'+(folderId||'root')+':'+filePlace)}">${itemsHTML()}</div>
 <footer class="lx-foot" data-key="foot"><span>${filePlace==='recent'&&!query?recentDocs().length+' recently opened':count+' '+(count===1?'document':'documents')+(inFolder?' in this folder':' and '+w.folders.length+' '+(w.folders.length===1?'folder':'folders')+' in '+esc(w.name))}</span><span>Notes and annotations are saved with each document</span></footer></section></div>`}
function visibleDocs(){return space().docs.filter(d=>(query?true:d.folder===folderId)&&d.name.toLowerCase().includes(query.toLowerCase()))}
function visibleFolders(){return folderId||(filePlace==='recent'&&!query)?[]:space().folders.filter(f=>f.name.toLowerCase().includes(query.toLowerCase()))}
function statusHTML(d){return `<span class="status ${d.status==='Ready'?'ready':d.status==='Failed'?'failed':'processing'}"><i class="lx-dot" aria-hidden="true"></i>${esc(d.status)}${d.uploadError?`<small role="status">${esc(d.uploadError)}</small>`:d.uploadNote?`<small role="status">${esc(d.uploadNote)}</small>`:''}</span>`}
function docActionHTML(d){return `<button class="row-action" ${d.status==='Failed'||d.uploadError?`data-retry="${d.id}"`:`data-open="${d.id}"`} ${!['Ready','Failed'].includes(d.status)&&!d.uploadError?'disabled':''}>${d.uploadError?'Retry status':d.status==='Ready'?'Open chat →':d.status==='Failed'?'Retry upload':'Preparing…'}</button>`}
function thumbHTML(d){const [label,color]=kindOf(d.name);return `<span class="lx-thumb" data-thumb="${esc(d.id)}" data-keep style="--kind:${color}"><span class="lx-thumb-badge">${esc(label)}</span><span class="lx-thumb-lines" aria-hidden="true"><i></i><i></i><i></i><i></i></span></span>`}
function emptyMark(){const src=window.CitelyAPI.asset('/branding/citely-04-app-tile.svg');return `<span class="lx-empty-mark" aria-hidden="true"><img class="lx-empty-glow" src="${src}" alt=""><img class="lx-empty-logo" src="${src}" alt=""></span>`}
function folderThumbHTML(f){const ds=docsIn(f.id).slice(0,3);return `<span class="lx-thumb lx-folder-thumb" aria-hidden="true">${ico('folder')}${ds.length?`<span class="lx-folder-kinds">${ds.map(d=>{const [l,c]=kindOf(d.name);return `<i style="--kind:${c}">${esc(l)}</i>`}).join('')}</span>`:''}</span>`}
function itemsHTML(){const ds=placeDocs(),fs=visibleFolders();const recent=filePlace==='recent'&&!query;
 if(!ds.length&&!fs.length)return `<div class="empty lx-empty" data-key="empty">${query||recent?`<span class="lx-empty-icon">${ico(recent?'chat':'search')}</span>`:emptyMark()}<h3>${query?'No matches':recent?'Nothing opened yet':'A little room to think.'}</h3><p>${query?'Nothing here is named like that. Try a shorter search.':recent?'Files show up here once you open a chat with them.':'Upload documents or move files into this folder.'}</p>${query||recent?'':'<button class="button primary" data-upload>Add a document</button>'}</div>`;
 const all=ds.length&&ds.every(d=>selection.has(d.id)),where=d=>query&&d.folder?' · in '+esc(space().folders.find(f=>f.id===d.folder)?.name||''):'';
 const head=fileView==='list'?`<div class="lx-head" data-key="head"><label class="lx-check"><input type="checkbox" id="select-all" ${all?'checked':''} aria-label="Select all files"></label><span>Name</span><span>Type and size</span><span>Status</span><span class="lx-head-actions">Actions</span></div>`:`<div class="lx-grid-head" data-key="ghead"><label class="lx-check"><input type="checkbox" id="select-all" ${all?'checked':''}><span>Select all</span></label></div>`;
 const folders=fs.map((f,i)=>{const n=docsIn(f.id).length;return `<div class="lx-item lx-folder" data-key="f:${esc(f.id)}" style="--i:${Math.min(i,8)}"><span class="lx-check"></span><button class="lx-name" data-folder="${f.id}">${folderThumbHTML(f)}<span class="lx-name-text"><strong>${esc(f.name)}</strong><small>${n} ${n===1?'document':'documents'} · connected sources</small></span></button><span class="lx-type">Folder</span><span class="status collection"><i class="lx-dot" aria-hidden="true"></i>${n?'Collection':'Empty'}</span><span class="row-actions"><button class="row-action" data-open="${f.id}" ${n?'':'disabled'}>Chat with folder →</button><button class="icon-button row-delete" data-delete-folder="${f.id}" aria-label="Delete folder ${esc(f.name)}" title="Delete folder">${ico('trash')}</button></span></div>`}).join('');
 const docs=ds.map((d,i)=>{const [label]=kindOf(d.name);return `<div class="lx-item ${selection.has(d.id)?'selected':''}" data-key="d:${esc(d.id)}" data-file-id="${esc(d.id)}" style="--i:${Math.min(fs.length+i,8)}"><label class="lx-check"><input type="checkbox" aria-label="Select ${esc(d.name)}" data-select="${d.id}" ${selection.has(d.id)?'checked':''}></label><button class="lx-name" data-open="${d.id}">${thumbHTML(d)}<span class="lx-name-text"><strong>${esc(d.name)}</strong><small>${d.pages?d.pages+(d.pages==1?' page · ':' pages · '):''}${esc(d.added||'Today')}${where(d)}</small></span></button><span class="lx-type">${esc(label)} · ${esc(d.size)}</span>${statusHTML(d)}<span class="row-actions">${docActionHTML(d)}<button class="icon-button row-delete" data-delete-doc="${d.id}" aria-label="Delete ${esc(d.name)}" title="Delete ${esc(d.name)}">${ico('trash')}</button></span></div>`}).join('');
 return `<div class="lx-collection ${fileView}" data-key="collection-${fileView}">${head}${folders}${docs}</div>`}

// ---- In-place updates ---------------------------------------------------
// Patches the live DOM to match freshly built HTML: same elements are kept
// (matched by data-key, else by position and tag), only differences are
// written. An element marked data-keep keeps its children (thumbnails).
function morph(target,html){const t=document.createElement('template');t.innerHTML=html;morphChildren(target,t.content)}
const nodeKey=n=>n.nodeType===1?(n.getAttribute('data-key')||(n.id?'#'+n.id:null)):null;
function sameNode(a,b){return a.nodeType===b.nodeType&&(a.nodeType!==1||(a.tagName===b.tagName&&nodeKey(a)===nodeKey(b)))}
function morphChildren(from,to){
 const keyed=new Map();for(const n of from.childNodes){const k=nodeKey(n);if(k)keyed.set(k,n)}
 const fresh=[...to.childNodes];
 fresh.forEach((n,i)=>{const k=nodeKey(n),here=from.childNodes[i]||null;let match=k?keyed.get(k):here&&!nodeKey(here)&&sameNode(here,n)?here:null;
  if(match&&!sameNode(match,n))match=null;
  if(match){if(k)keyed.delete(k);if(match!==here)from.insertBefore(match,here);patchNode(match,n)}
  else from.insertBefore(n,here)});
 while(from.childNodes.length>fresh.length)from.lastChild.remove();
}
function patchNode(a,b){
 if(a.nodeType!==1){if(a.nodeValue!==b.nodeValue)a.nodeValue=b.nodeValue;return}
 if(a.hasAttribute('data-keep'))return;   // owns its own content and state (a drawn thumbnail)
 for(const {name,value} of [...b.attributes])if(a.getAttribute(name)!==value&&!(name==='value'&&a===document.activeElement))a.setAttribute(name,value);
 for(const {name} of [...a.attributes])if(!b.hasAttribute(name)&&!(a.tagName==='DETAILS'&&name==='open'))a.removeAttribute(name);
 if(a.tagName==='INPUT'){if(a.type==='checkbox'||a.type==='radio')a.checked=b.hasAttribute('checked');else if(a!==document.activeElement&&a.value!==(b.getAttribute('value')??''))a.value=b.getAttribute('value')??''}
 morphChildren(a,b);
}

// ---- Thumbnails ---------------------------------------------------------
// The first page, slide or sheet of each file, drawn once per session and
// only when its row scrolls into view. Word, Excel and PowerPoint come from
// the original file through the same viewers the reader uses; other files
// show the start of their first page's text.
const thumbs=new Map(),thumbJobs=new Map();let thumbQueue=[],thumbActive=0,thumbObserver=null,thumbResize=null;
function thumbSource(d){const ext=(d.name.split('.').pop()||'').toLowerCase(),v=window.CitelyAPI.viewers||{};if(['docx','xlsx','pptx','pdf'].includes(ext)&&v[ext]&&originalInfo.get(d.id)?.has)return ext;return 'text'}
const officeThumb=d=>{const ext=(d.name.split('.').pop()||'').toLowerCase();return ['docx','xlsx','pptx','pdf'].includes(ext)&&!!(window.CitelyAPI.viewers||{})[ext]};
async function buildThumb(d){if(officeThumb(d)&&!originalInfo.has(d.id))await refreshOriginalInfo();const kind=thumbSource(d);
 if(kind!=='text'){const [mod,bytes]=await Promise.all([window.CitelyAPI.loadViewer(kind),window.CitelyAPI.originalFile(d.id)]);if(!mod.thumbnail)throw Error('No thumbnail');const t=await mod.thumbnail(bytes);return {...t,kind}}
 if(!pageCache.get(d.id))await window.CitelyAPI.loadPages(d.id);
 const page=pageCache.get(d.id)?.find(p=>p.page===1)||pageCache.get(d.id)?.[0];const text=String(page?.text||'').trim();if(!text)throw Error('No text');
 const el=document.createElement('div');el.className='thumb-text';const h=document.createElement('strong');h.textContent=d.name.replace(/\.[^.]+$/,'');const p=document.createElement('p');p.textContent=text.slice(0,900);el.append(h,p);return {element:el,width:420,height:560,kind}}
function placeThumb(host,t){const stage=document.createElement('span');stage.className='lx-thumb-stage kind-'+t.kind;stage.style.width=t.width+'px';stage.style.height=t.height+'px';stage.append(t.element);const badge=host.querySelector('.lx-thumb-badge');host.replaceChildren(stage);if(badge)host.append(badge);host.classList.add('has-thumb');host.dataset.ratio=t.width/t.height>1.15?'wide':'tall';fitThumb(host)}
function fitThumb(host){const stage=host.firstElementChild;if(!stage?.classList.contains('lx-thumb-stage'))return;const w=parseFloat(stage.style.width),h=parseFloat(stage.style.height),bw=host.clientWidth,bh=host.clientHeight;if(!bw||!bh)return;
 // Fit the width; a page runs off the bottom like paper in a tray, a slide sits centred.
 const s=bw/w,y=Math.max(0,(bh-h*s)/2);stage.style.transform=`translate(0,${y}px) scale(${s})`}
function pumpThumbs(){while(thumbActive<2&&thumbQueue.length){const id=thumbQueue.shift(),d=doc(id);if(!d||thumbs.has(id)||thumbJobs.has(id))continue;thumbActive++;const job=buildThumb(d).then(t=>{thumbs.set(id,t);for(const host of $$(`[data-thumb="${CSS.escape(id)}"]`))placeThumb(host,t)}).catch(()=>{thumbs.set(id,null)}).finally(()=>{thumbActive--;thumbJobs.delete(id);pumpThumbs()});thumbJobs.set(id,job)}}
// A thumbnail drawn from text before the original was known is replaced once it is.
function redrawFallbackThumbs(){for(const [id,t] of thumbs){const d=doc(id);if(!d||(t&&t.kind!=='text')||thumbSource(d)==='text')continue;thumbs.delete(id);for(const host of $$(`[data-thumb="${CSS.escape(id)}"]`)){host.classList.remove('has-thumb');delete host.dataset.watched}}}
function paintThumbs(){
 if(!thumbObserver&&'IntersectionObserver' in window)thumbObserver=new IntersectionObserver(es=>{for(const e of es){if(!e.isIntersecting)continue;thumbObserver.unobserve(e.target);const id=e.target.dataset.thumb;if(!thumbs.has(id)&&!thumbQueue.includes(id)){thumbQueue.push(id);pumpThumbs()}}},{rootMargin:'200px'});
 if(!thumbResize&&'ResizeObserver' in window)thumbResize=new ResizeObserver(es=>es.forEach(e=>fitThumb(e.target)));
 for(const host of $$('[data-thumb]')){const id=host.dataset.thumb,d=doc(id),t=thumbs.get(id);
  if(t&&!host.classList.contains('has-thumb'))placeThumb(host,t);
  if(!host.dataset.watched){host.dataset.watched='1';thumbResize?.observe(host);if(!t&&d?.status==='Ready'&&!connecting)thumbObserver?.observe(host)}
  else if(!t&&d?.status==='Ready'&&!connecting&&!thumbJobs.has(id)&&!thumbQueue.includes(id))thumbObserver?.observe(host)}
}

// ---- Folders: delete ------------------------------------------------------
function confirmDeleteFolder(id){
 const f=space().folders.find(x=>x.id===id);if(!f)return;const docs=docsIn(id),n=docs.length;
 modal(`Delete folder "${f.name}"?`,`<form id="folder-delete-form">${n?`<p class="modal-description">It holds ${n} ${n===1?'document':'documents'}. Choose what happens to ${n===1?'it':'them'}.</p><div class="lx-choices"><label class="lx-choice"><input type="radio" name="folder-docs" value="keep" checked><span><strong>Keep the ${n===1?'document':'documents'}</strong><small>${n===1?'It moves':'They move'} to All files. Conversations and highlights stay.</small></span></label><label class="lx-choice danger"><input type="radio" name="folder-docs" value="delete"><span><strong>Delete the ${n===1?'document':'documents'} too</strong><small>Permanently deletes ${n===1?'it':'them'}, with extracted text, highlights and conversations. This cannot be undone.</small></span></label></div>`:'<p class="modal-description">The folder is empty. Deleting it removes only the folder.</p>'}<p class="form-error" id="delete-error"></p><div class="inline-actions"><button type="button" class="button" id="delete-cancel">Cancel</button><button class="button primary destructive" id="delete-confirm">Delete folder</button></div></form>`);
 $('#delete-cancel').onclick=()=>$('#modal').close();
 $('#folder-delete-form').onsubmit=async e=>{e.preventDefault();if(e.target.dataset.busy)return;const withDocs=n&&e.target.elements['folder-docs'].value==='delete',spaceId=currentSpace;
  if(withDocs){e.target.dataset.busy='1';const b=$('#delete-confirm');b.disabled=true;b.textContent='Deleting documents…';const failed=[];
   for(const d of docs){try{await window.CitelyAPI.deleteDocument(d.id);for(const w of catalog.orgs.flatMap(o=>o.spaces))w.docs=w.docs.filter(x=>x.id!==d.id);selection.delete(d.id)}catch(err){failed.push(d.name+': '+err.message)}}
   delete e.target.dataset.busy;b.disabled=false;b.textContent='Delete folder';
   if(failed.length){try{await saveCatalog()}catch{}render();$('#delete-error').textContent='Some documents could not be deleted, so the folder was kept: '+failed.join('; ');return}}
  await catalogChange(e.target,{busyLabel:'Deleting…',
   apply:()=>{const w=spaceIn(catalog,spaceId);w.folders=w.folders.filter(x=>x.id!==id);w.docs.forEach(d=>{if(d.folder===id)d.folder=null});if(folderId===id)folderId=null},
   landed:fresh=>!spaceIn(fresh,spaceId)?.folders.some(x=>x.id===id),
   done:()=>{$('#modal').close();render();toast(withDocs?'Folder and its documents deleted.':n?'Folder deleted. Its documents moved to All files.':'Folder deleted.')},
   showError:m=>{$('#delete-error').textContent=m}})}}

// ---- Export selected files ----------------------------------------------
async function exportSelected(){const w=space(),ids=new Set(selection),docs=w.docs.filter(d=>ids.has(d.id));if(!docs.length)return;
 toast('Preparing your export…');try{const folders=w.folders.filter(f=>docs.some(d=>d.folder===f.id));const bundle=await bundleFor({...w,docs,folders});download('citely-selection.json',JSON.stringify(bundle,null,2),'application/json');toast(`Exported ${docs.length} ${docs.length===1?'document':'documents'}.`)}catch(e){fail(e)}}

// ---- Drag and drop onto the file panel ----------------------------------
const UPLOAD_TYPES=/\.(pdf|txt|md|csv|json|docx|pptx|xlsx|png|jpe?g|webp)$/i;
function bindDrop(){const panel=$('#file-panel');if(!panel||panel.dataset.dropBound)return;panel.dataset.dropBound='1';let depth=0;
 panel.addEventListener('dragenter',e=>{if(![...(e.dataTransfer?.types||[])].includes('Files'))return;e.preventDefault();depth++;panel.classList.add('dragging')});
 panel.addEventListener('dragover',e=>{if(![...(e.dataTransfer?.types||[])].includes('Files'))return;e.preventDefault();e.dataTransfer.dropEffect='copy'});
 panel.addEventListener('dragleave',()=>{depth=Math.max(0,depth-1);if(!depth)panel.classList.remove('dragging')});
 panel.addEventListener('drop',e=>{e.preventDefault();depth=0;panel.classList.remove('dragging');const files=[...(e.dataTransfer?.files||[])];if(!files.length)return;
  if(window.CitelyAPI.demo){toast('In the demo, add sample files with Upload.');return}if(connecting){holdForServer();return}if(outOf('uploads')){notifyLimit('uploads');return}
  const ok=files.filter(f=>UPLOAD_TYPES.test(f.name)),skipped=files.length-ok.length;if(skipped)toast(`${skipped} ${skipped===1?'file is':'files are'} not a supported type and ${skipped===1?'was':'were'} skipped.`);if(ok.length)void addDocuments(ok)})}
// Overview: the workspace at a glance, built only from its own documents,
// folders, statuses and what this device opened recently.
function sizeBytes(s){const m=/([\d.]+)\s*(KB|MB|GB|B)/i.exec(String(s||''));if(!m)return 0;return parseFloat(m[1])*({b:1,kb:1024,mb:1048576,gb:1073741824}[m[2].toLowerCase()])}
function sizeText(b){return b>=1073741824?(b/1073741824).toFixed(1)+' GB':b>=1048576?(b/1048576).toFixed(1)+' MB':Math.max(b>0?1:0,Math.round(b/1024))+' KB'}
function ovDocRow(d,extra=''){const f=d.folder&&space().folders.find(x=>x.id===d.folder);return `<div class="ov-doc" data-key="ov:${esc(d.id)}">${thumbHTML(d)}<span class="ov-doc-text"><strong title="${esc(d.name)}">${esc(d.name)}</strong><small>${d.pages?d.pages+(d.pages==1?' page · ':' pages · '):''}${f?'in '+esc(f.name):'All files'}${extra}</small>${statusHTML(d)}</span>${d.status==='Ready'?`<button class="row-action" data-open="${d.id}">Open chat →</button>`:d.status==='Failed'||d.uploadError?`<button class="row-action" data-retry="${d.id}">Retry</button>`:''}</div>`}
function overviewHTML(){const w=space(),docs=w.docs,ready=docs.filter(d=>d.status==='Ready').length,attention=docs.filter(d=>d.status==='Failed'||d.uploadError),busyDocs=docs.filter(d=>!['Ready','Failed'].includes(d.status)&&!d.uploadError);
 const bytes=docs.reduce((n,d)=>n+sizeBytes(d.size),0),pages=docs.reduce((n,d)=>n+(Number(d.pages)||0),0);
 const types={};docs.forEach(d=>{const [l,c]=kindOf(d.name);(types[l]||=(types[l]={label:l,color:c,n:0})).n++});const comp=Object.values(types).sort((a,b)=>b.n-a.n);
 const recent=recentDocs().slice(0,4),added=[...docs].reverse().slice(0,4),up=allowance('uploads'),qs=allowance('questions');
 const tile=(icon,n,label,note)=>`<div class="ov-tile"><span class="ov-tile-icon">${icon}</span><strong>${n}</strong><span>${label}</span>${note?`<small>${note}</small>`:''}</div>`;
 const meter=(a,noun)=>{const used=a.limit-a.remaining,pct=a.limit?Math.min(100,Math.round(used/a.limit*100)):0;return `<div class="ov-meter"><div><strong>${a.remaining}</strong> of ${a.limit} ${noun} left${heldBack(a)?`<small class="ov-held">${heldBack(a)} held back by the live demo's shared daily limit (it resets at midnight, India time)</small>`:''}</div><span class="ov-meter-bar"><i style="width:${pct}%"></i></span></div>`};
 return `<div class="ov" data-key="ov">
 <header class="ov-head"><div><span class="eyebrow">OVERVIEW</span><h1>${esc(w.name)}</h1><p>${esc(organization().name)} workspace · ${docs.length} ${docs.length===1?'document':'documents'} in ${w.folders.length} ${w.folders.length===1?'folder':'folders'}</p></div><div class="ov-actions"><button class="button primary" data-upload ${outOf('uploads')?'data-exhausted':''}>${ico('upload')}Upload</button><button class="button" data-new-folder>${ico('plus')}New folder</button><button class="text-button" data-tour>How it works ${ico('arrow')}</button></div></header>
 <section class="ov-tiles" aria-label="Workspace totals">${tile(ico('file'),docs.length,'Documents',docs.length?`${ready} ready${busyDocs.length?' · '+busyDocs.length+' processing':''}`:'Upload your first source')}${tile(lxIcon('pages'),pages,'Pages indexed',pages?'Searchable with citations':'Counted as files are indexed')}${tile(lxIcon('disk'),sizeText(bytes),'Stored','Originals kept for the reader')}${tile(ico('folder'),w.folders.length,'Folders',w.folders.length?'Ask across a whole folder':'Group related files')}</section>
 ${attention.length?`<section class="ov-card ov-attention"><h2>Needs attention</h2>${attention.map(d=>ovDocRow(d)).join('')}</section>`:''}
 <div class="ov-cols"><div class="ov-col">
  <section class="ov-card"><h2>Continue where you left off</h2>${recent.length?recent.map(d=>ovDocRow(d)).join(''):`<p class="ov-empty">Files you open a chat with show up here, newest first.</p>`}</section>
  <section class="ov-card"><h2>Documents by type</h2>${comp.length?`<div class="ov-bar">${comp.map(t=>`<i style="flex-grow:${t.n};background:${t.color}" title="${esc(t.label)}: ${t.n}"></i>`).join('')}</div><div class="ov-legend">${comp.map(t=>`<span><i style="background:${t.color}"></i>${esc(t.label)}<strong>${t.n}</strong></span>`).join('')}</div>`:`<p class="ov-empty">The mix of file types appears once you add documents.</p>`}</section>
  <section class="ov-card"><h2>Folders</h2>${w.folders.length?[...w.folders].sort((a,b)=>docsIn(b.id).length-docsIn(a.id).length).slice(0,6).map(f=>{const n=docsIn(f.id).length;return `<div class="ov-folder" data-key="ovf:${esc(f.id)}"><button class="ov-folder-name" data-folder="${f.id}">${ico('folder')}<span>${esc(f.name)}</span></button><small>${n} ${n===1?'document':'documents'}</small><button class="row-action" data-open="${f.id}" ${n?'':'disabled'}>Chat →</button></div>`}).join(''):`<p class="ov-empty">Folders let you ask one question across several files. Select files, then choose New folder with selection.</p>`}</section>
 </div><div class="ov-col">
  <section class="ov-card"><h2>Recently added</h2>${added.length?added.map(d=>ovDocRow(d,d.added?' · '+esc(d.added):'')).join(''):`<p class="ov-empty">Nothing here yet. Upload a PDF, Word, PowerPoint or Excel file to begin.</p>`}</section>
  ${up||qs?`<section class="ov-card"><h2>Demo allowance</h2>${up?meter(up,'uploads'):''}${qs?meter(qs,'questions'):''}${usageInfo.max_upload_mb?`<p class="ov-note">Each upload can be up to ${usageInfo.max_upload_mb} MB and ${usageInfo.max_pages} pages.</p>`:''}</section>`:''}
 </div>
 </div></div>`}
function teamHTML(){return `<div class="library-content"><div class="library-title"><div><span class="eyebrow">TEAM · COMING SOON</span><h1>Better, together.</h1><p>Shared spaces where your team asks, highlights and takes notes in one place.</p></div></div><div class="team-introduction"><div class="avatars">${directory.slice(0,3).map(u=>`<span>${esc(initials(u.name))}</span>`).join('')}</div><div><h2>Team features are coming soon.</h2><p>Invite colleagues to a workspace, share conversations and notes, and see who added what. Until then, export a conversation from its More menu to share a copy.</p></div></div></div>`}
function workKey(){return 'chat:'+currentSpace+':'+desk.id}
// ---- Conversation desk ----------------------------------------------------
// Three flat columns divided by 1px rules: chat | document | notes, under one
// top bar, with a narrow icon rail. Chat and notes collapse (top-bar buttons,
// the headers' own buttons, Ctrl/Cmd + [ and ]); on narrow screens they become
// drawers. Menus hold the rarely used actions. Everything the old desk could
// do is still here, behind the same ids and handlers.
const dxStore=k=>{try{return localStorage.getItem('citely-dx-'+k)==='1'}catch{return false}};
let dxCollapsed={left:dxStore('left'),right:dxStore('right')},dxDrawer=null,dxTab='notes',dxPop=null,dxNote=null,dxComposing=false;
// Material Symbols Outlined (weight 300, Apache-2.0) as inline paths: the desk
// matches its design without an icon font, which the page's CSP does not allow.
const msPaths={"tune":"M440-120v-240h80v80h320v80H520v80h-80Zm-320-80v-80h240v80H120Zm160-160v-80H120v-80h160v-80h80v240h-80Zm160-80v-80h400v80H440Zm160-160v-240h80v80h160v80H680v80h-80Zm-480-80v-80h400v80H120Z","add":"M457.31-457.31H220v-45.38h237.31V-740h45.38v237.31H740v45.38H502.69V-220h-45.38v-237.31Z","arrow_back":"M266.31-457.31 512-212l-32 32-300-300 300-300 32 32-245.69 245.31H780v45.38H266.31Z","arrow_upward":"M457.31-180v-513.69L212-448.39 180-480l300-300 300 300-32 31.61-245.31-245.3V-180h-45.38Z","article":"M287.77-289.39h256.54v-45.38H287.77v45.38Zm0-167.92h384.46v-45.38H287.77v45.38Zm0-167.92h384.46v-45.38H287.77v45.38ZM197.69-140q-23.53 0-40.61-17.08T140-197.69v-564.62q0-23.53 17.08-40.61T197.69-820h564.62q23.53 0 40.61 17.08T820-762.31v564.62q0 23.53-17.08 40.61T762.31-140H197.69Zm0-45.39h564.62q4.61 0 8.46-3.84 3.84-3.85 3.84-8.46v-564.62q0-4.61-3.84-8.46-3.85-3.84-8.46-3.84H197.69q-4.61 0-8.46 3.84-3.84 3.85-3.84 8.46v564.62q0 4.61 3.84 8.46 3.85 3.84 8.46 3.84Zm-12.3-589.22v589.22-589.22Z","bookmark_add":"M220-150v-616.15q0-23.23 17.08-40.46t40.61-17.23h264.23v45.38H277.69q-4.61 0-8.46 3.85-3.84 3.84-3.84 8.46v546.69L480-310.54l214.61 91.08v-319H740V-150L480-261.54 220-150Zm45.39-628.46h276.53-276.53Zm429.22 174.61v-87.3h-87.3v-45.39h87.3v-87.3H740v87.3h87.31v45.39H740v87.3h-45.39Z","check_circle":"M421-311.46 690.54-581l-34.85-34.23L421-380.15 302.54-498.61l-33.85 34.23L421-311.46ZM480.07-100q-78.22 0-147.4-29.92t-120.99-81.71q-51.81-51.79-81.75-120.94Q100-401.71 100-479.93q0-78.84 29.92-148.21t81.71-120.68q51.79-51.31 120.94-81.25Q401.71-860 479.93-860q78.84 0 148.21 29.92t120.68 81.21q51.31 51.29 81.25 120.63Q860-558.9 860-480.07q0 78.22-29.92 147.4t-81.21 120.99q-51.29 51.81-120.63 81.75Q558.9-100 480.07-100Zm-.07-45.39q139.69 0 237.15-97.76 97.46-97.77 97.46-236.85 0-139.69-97.46-237.15-97.46-97.46-237.15-97.46-139.08 0-236.85 97.46-97.76 97.46-97.76 237.15 0 139.08 97.76 236.85 97.77 97.76 236.85 97.76ZM480-480Z","chevron_left":"M560.62-253.85 333.85-480.62l226.77-227.15 32.61 32.62-194.15 194.53 194.15 194.16-32.61 32.61Z","chevron_right":"M536.92-480.62 342.77-675.15l32.61-32.62 226.77 227.15-226.77 226.77-32.61-32.61 194.15-194.16Z","close":"m250.92-218.92-32-32L448-480 218.92-709.08l32-32L480-512l229.08-229.08 32 32L512-480l229.08 229.08-32 32L480-448 250.92-218.92Z","close_fullscreen":"M131.62-100 100-131.62l303-303H180V-480h300v300h-45.38v-223l-303 303ZM480-480v-300h45.38v223l303-303L860-828.38l-303 303h223V-480H480Z","computer":"M55.39-150.77v-45.39h849.22v45.39H55.39Zm102.3-100q-23.53 0-40.61-17.08T100-308.46v-444.61q0-23.53 17.08-40.62 17.08-17.08 40.61-17.08h644.62q23.53 0 40.61 17.08Q860-776.6 860-753.07v444.61q0 23.53-17.08 40.61t-40.61 17.08H157.69Zm0-45.38h644.62q4.61 0 8.46-3.85 3.84-3.85 3.84-8.46v-444.61q0-4.62-3.84-8.47-3.85-3.84-8.46-3.84H157.69q-4.61 0-8.46 3.84-3.84 3.85-3.84 8.47v444.61q0 4.61 3.84 8.46 3.85 3.85 8.46 3.85Zm-12.3 0v-469.23 469.23Z","content_copy":"M318.46-230.77q-23.53 0-40.61-17.08t-17.08-40.61v-513.85q0-23.53 17.08-40.61T318.46-860h393.85q23.52 0 40.61 17.08Q770-825.84 770-802.31v513.85q0 23.53-17.08 40.61-17.09 17.08-40.61 17.08H318.46Zm0-45.39h393.85q4.61 0 8.46-3.84 3.84-3.85 3.84-8.46v-513.85q0-4.61-3.84-8.46-3.85-3.84-8.46-3.84H318.46q-4.61 0-8.46 3.84-3.85 3.85-3.85 8.46v513.85q0 4.61 3.85 8.46 3.85 3.84 8.46 3.84ZM207.69-120q-23.52 0-40.61-17.08Q150-154.17 150-177.7v-559.22h45.39v559.22q0 4.62 3.84 8.47 3.85 3.84 8.46 3.84h439.23V-120H207.69Zm98.46-156.16v-538.45 538.45Z","crop_landscape":"M157.69-180q-23.53 0-40.61-17.08T100-237.69v-484.62q0-23.53 17.08-40.61T157.69-780h644.62q23.53 0 40.61 17.08T860-722.31v484.62q0 23.53-17.08 40.61T802.31-180H157.69Zm0-45.39h644.62q4.61 0 8.46-3.84 3.84-3.85 3.84-8.46v-484.62q0-4.61-3.84-8.46-3.85-3.84-8.46-3.84H157.69q-4.61 0-8.46 3.84-3.84 3.85-3.84 8.46v484.62q0 4.61 3.84 8.46 3.85 3.84 8.46 3.84Zm-12.3 0v-509.22 509.22Z","crop_portrait":"M722.31-100H237.69q-23.53 0-40.61-17.08T180-157.69v-644.62q0-23.53 17.08-40.61T237.69-860h484.62q23.53 0 40.61 17.08T780-802.31v644.62q0 23.53-17.08 40.61T722.31-100Zm-484.62-45.39h484.62q5.38 0 8.84-3.46t3.46-8.84v-644.62q0-5.38-3.46-8.84t-8.84-3.46H237.69q-5.38 0-8.84 3.46t-3.46 8.84v644.62q0 5.38 3.46 8.84t8.84 3.46Zm-12.3 0v-669.22 669.22Z","dark_mode":"M481.15-140q-141.66 0-240.83-99.17-99.16-99.16-99.16-240.83 0-135.77 92.11-232.88 92.11-97.12 225.57-105.2 4.16 0 9.12.31 4.96.31 13.96.49-27.15 30.9-41.96 71.74-14.81 40.85-14.81 85.54 0 98.33 68.84 167.17Q562.82-424 661.15-424q44.31 0 85.35-13.69 41.04-13.69 71.5-38.61.23 7.38.54 11.23.3 3.84.3 7.38-7.69 133.46-104.8 225.57Q616.92-140 481.15-140Zm0-45.39q103.23 0 181.35-62.49 78.11-62.5 101.19-149.66-23.46 9.46-49.82 14.19-26.36 4.74-52.72 4.74-116.92 0-199.15-82.23T379.77-660q0-23.23 4.42-48.62 4.42-25.38 15.5-56.15-92.61 28.16-152.88 107.47-60.27 79.31-60.27 177.3 0 122.77 85.92 208.69t208.69 85.92Zm-5.53-289.69Z","data_object":"M578.08-180v-45.39h98.84q24.08 0 40.89-16.29 16.8-16.3 16.8-40.24v-96.93q0-34.69 21.54-61.77 21.54-27.07 55-36.53v-5.7q-33.46-8.84-55-36.23-21.54-27.38-21.54-62.07v-96.93q0-23.94-16.67-40.24-16.68-16.29-41.02-16.29h-98.84V-780h98.84q43.31 0 73.19 29.79Q780-720.42 780-678.08v96.93q0 24.33 17.06 40.82 17.06 16.49 41.79 16.49H860v87.68h-21.15q-24.73 0-41.79 16.49T780-378.85v96.93q0 42.34-29.99 72.13Q720.03-180 676.92-180h-98.84Zm-295 0q-42.89 0-72.99-29.79Q180-239.58 180-281.92v-96.93q0-24.33-17.06-40.82-17.06-16.49-41.79-16.49H100v-87.68h21.15q24.73 0 41.79-16.49T180-581.15v-96.93q0-42.34 30.18-72.13Q240.35-780 283.08-780h99.23v45.39h-99.23q-24.08 0-40.89 16.29-16.8 16.3-16.8 40.24v96.93q0 34.69-21.54 62.07-21.54 27.39-55 36.23v5.7q33.46 9.41 55 36.51 21.54 27.1 21.54 61.79v96.93q0 23.94 16.68 40.24 16.68 16.29 41.01 16.29h99.23V-180h-99.23Z","delete":"M278.31-140q-23.6 0-40.65-17.05-17.04-17.05-17.04-40.64v-544.23H180v-45.39h171.08v-28.07h257.84v28.07H780v45.39h-40.62v544.23q0 23.53-17.08 40.61T681.69-140H278.31ZM694-741.92H266v544.23q0 5.38 3.65 8.84 3.66 3.46 8.66 3.46h403.38q4.62 0 8.46-3.84 3.85-3.85 3.85-8.46v-544.23ZM381.23-269.85h45.39v-388.61h-45.39v388.61Zm152.15 0h45.39v-388.61h-45.39v388.61ZM266-741.92v556.53-556.53Z","delete_sweep":"M597.69-242.69v-45.39h129.23v45.39H597.69Zm0-354.93V-643h260v45.38h-260Zm0 177.47v-45.39h216.54v45.39H597.69ZM146.16-665.77h-43.85v-45.27h161.92v-36.65h112.69v36.54h161.92v45.38H495v388.08q0 23.53-17.08 40.61T437.31-220H203.85q-23.53 0-40.61-17.08t-17.08-40.61v-388.08Zm45.38 0v388.08q0 4.61 3.65 8.46 3.66 3.84 8.66 3.84h233.46q4.61 0 8.46-3.84 3.85-3.85 3.85-8.46v-388.08H191.54Zm0 0v400.38-400.38Z","description":"M329.39-257.31h301.22v-45.38H329.39v45.38Zm0-167.31h301.22V-470H329.39v45.38ZM237.69-100q-23.53 0-40.61-17.08T180-157.69v-644.62q0-23.53 17.08-40.61T237.69-860h347.54L780-665.23v507.54q0 23.53-17.08 40.61T722.31-100H237.69Zm324.85-544.77v-169.84H237.69q-4.61 0-8.46 3.84-3.84 3.85-3.84 8.46v644.62q0 4.61 3.84 8.46 3.85 3.84 8.46 3.84h484.62q4.61 0 8.46-3.84 3.84-3.85 3.84-8.46v-487.08H562.54ZM225.39-814.61v169.84-169.84 669.22-669.22Z","download":"M480-323.39 314.31-489.08l32.61-32.23 110.39 110V-780h45.38v368.69l110.39-110 32.61 32.23L480-323.39ZM237.69-180q-23.53 0-40.61-17.08T180-237.69V-363h45.39v125.31q0 4.61 3.84 8.46 3.85 3.84 8.46 3.84h484.62q4.61 0 8.46-3.84 3.84-3.85 3.84-8.46V-363H780v125.31q0 23.53-17.08 40.61T722.31-180H237.69Z","expand_more":"M480-357.85 253.85-584l32.61-32.61L480-423.08l193.54-193.53L706.15-584 480-357.85Z","fit_screen":"M814.61-607.31v-115q0-4.61-3.84-8.46-3.85-3.84-8.46-3.84h-115V-780h115q23.53 0 40.61 17.08T860-722.31v115h-45.39Zm-714.61 0v-115q0-23.53 17.08-40.61T157.69-780h115v45.39h-115q-4.61 0-8.46 3.84-3.84 3.85-3.84 8.46v115H100ZM687.31-180v-45.39h115q4.61 0 8.46-3.84 3.84-3.85 3.84-8.46v-115H860v115q0 23.53-17.08 40.61T802.31-180h-115Zm-529.62 0q-23.53 0-40.61-17.08T100-237.69v-115h45.39v115q0 4.61 3.84 8.46 3.85 3.84 8.46 3.84h115V-180h-115Zm70-127.69v-344.62h504.62v344.62H227.69Zm45.39-45.39h413.84v-253.84H273.08v253.84Zm0 0v-253.84 253.84Z","folder":"M157.69-180q-23.53 0-40.61-17.35Q100-214.69 100-237.69v-484.62q0-23 17.08-40.34Q134.16-780 157.69-780h249.46l65.39 65.39h329.77q23 0 40.34 17.34Q860-679.92 860-656.92v419.23q0 23-17.35 40.34Q825.31-180 802.31-180H157.69Zm0-45.39h644.62q5.38 0 8.84-3.46t3.46-8.84v-419.23q0-5.39-3.46-8.85t-8.84-3.46H454.08l-65.39-65.38h-231q-5.38 0-8.84 3.46t-3.46 8.84v484.62q0 5.38 3.46 8.84t8.84 3.46Zm-12.3 0v-509.22 509.22Z","folder_open":"M155.39-180q-21.85 0-38.62-16.77Q100-213.54 100-235.39v-486.92q0-21.84 17.92-39.77Q135.85-780 157.69-780h249.46l65.39 65.39h329.77q19.53 0 35.34 13.69 15.81 13.69 18.89 31.69H453.08l-65.39-65.38h-230q-5.38 0-8.84 3.46t-3.46 8.84v484.62q0 4.23 2.11 6.92 2.12 2.69 5.58 4.62l97.77-370h676.46l-99.7 374.38q-5.61 21.31-20.26 31.54Q792.69-180 770.38-180H155.39Zm45.3-45.39h581.23l84-325.38H284.69l-84 325.38Zm0 0 84-325.38-84 325.38Zm-55.3-443.84v-65.38 65.38Z","format_quote":"m260.31-253.85 95.54-165.07q-7.31 2.53-16.39 3.8-9.07 1.27-17.15 1.27-61 0-103.58-42.93-42.57-42.93-42.57-103.22 0-61 42.57-103.58 42.58-42.57 103.58-42.57 60.29 0 103.22 42.57 42.93 42.58 42.93 103.45 0 19.98-5.11 38.55-5.12 18.58-14.97 35.43l-133.77 232.3h-54.3Zm355.38 0 95.54-165.07q-7.31 2.53-16.38 3.8-9.08 1.27-17.16 1.27-61 0-103.57-42.93-42.58-42.93-42.58-103.22 0-61.38 42.58-103.77 42.57-42.38 103.57-42.38 60.29 0 103.22 42.57 42.93 42.58 42.93 103.45 0 19.98-5.11 38.55-5.12 18.58-14.96 35.43L670-253.85h-54.31ZM322.03-471.54q36.74 0 62.74-25.72t26-62.46q0-36.74-25.72-62.74t-62.46-26q-36.74 0-62.74 25.72t-26 62.46q0 36.74 25.72 62.74 25.71 26 62.46 26Zm355.38 0q36.74 0 62.74-25.72t26-62.46q0-36.74-25.72-62.74-25.71-26-62.46-26-36.74 0-62.74 25.72t-26 62.46q0 36.74 25.72 62.74t62.46 26Zm.28-88.46Zm-355.38 0Z","forum":"M852.31-134.47 711.38-275.39H305.39q-23.17 0-39.66-16.49-16.5-16.5-16.5-39.66v-53.85h435.39q23.5 0 40.59-17.09 17.1-17.1 17.1-40.6V-720h53.84q23.17 0 39.66 16.5 16.5 16.49 16.5 39.65v529.38ZM153.08-419.23 230-496.15h389.23q5.39 0 8.85-3.47 3.46-3.46 3.46-8.84v-293.85q0-5.38-3.46-8.84t-8.85-3.46H165.39q-5.39 0-8.85 3.46t-3.46 8.84v383.08Zm-45.39 110v-493.08q0-23.5 17.1-40.59 17.1-17.1 40.6-17.1h453.84q23.5 0 40.6 17.1 17.09 17.09 17.09 40.59v293.85q0 23.5-17.09 40.59-17.1 17.1-40.6 17.1h-370L107.69-309.23Zm45.39-199.23v-306.15 306.15Z","forward_10":"M368.46-318.85v-203.53h-53.23v-39.39h93.62v242.92h-40.39Zm140.46 0q-17.93 0-30.39-12.45-12.45-12.46-12.45-30.39v-157.23q0-17.93 12.45-30.39 12.46-12.46 30.39-12.46h77.62q17.93 0 30.39 12.46 12.45 12.46 12.45 30.39v157.23q0 17.93-12.45 30.39-12.46 12.45-30.39 12.45h-77.62Zm2.16-40.38h73.3q2.31 0 3.47-1.15 1.15-1.16 1.15-3.47v-153.92q0-2.31-1.15-3.46-1.16-1.15-3.47-1.15h-73.3q-2.31 0-3.47 1.15-1.15 1.15-1.15 3.46v153.92q0 2.31 1.15 3.47 1.16 1.15 3.47 1.15ZM480-100q-70.77 0-132.61-26.46-61.85-26.46-108.16-72.77-46.31-46.31-72.77-108.16Q140-369.23 140-440q0-70.77 26.46-132.61 26.46-61.85 72.77-108.16 46.31-46.31 108.16-72.77Q409.23-780 480-780h21.77l-76.08-76.08 31-30.99 128.15 127.76-127.38 127.77-31-30.61 72.08-72.46H480q-123.11 0-208.86 85.74-85.75 85.74-85.75 208.83 0 123.09 85.74 208.87t208.83 85.78q123.09 0 208.87-85.75T774.61-440H820q0 70.77-26.46 132.61-26.46 61.85-72.77 108.16-46.31 46.31-108.16 72.77Q550.77-100 480-100Z","graphic_eq":"M298.85-257.69v-444.62h45.38v444.62h-45.38ZM457.31-100v-760h45.38v760h-45.38ZM140-413.85v-132.3h45.39v132.3H140Zm476.15 156.16v-444.62h45.39v444.62h-45.39Zm158.46-156.16v-132.3H820v132.3h-45.39Z","group_add":"M484.77-497.15q23.31-27.77 33.5-58.7 10.19-30.92 10.19-69.96 0-39.04-10.19-69.77-10.19-30.73-33.5-58.5 64.46-12.38 112.15 23.58 47.69 35.96 47.69 104.89 0 68.92-47.69 104.69-47.69 35.76-112.15 23.77Zm207.15 309.46v-74.77q0-44.01-20.61-81.7-20.62-37.69-72.69-62.68 135.3 18.15 188.42 53.99 53.11 35.85 53.11 90.39v74.77H691.92Zm94.23-269v-94.62h-94.61v-45.38h94.61v-94.62h45.39v94.62h94.61v45.38h-94.61v94.62h-45.39Zm-455.96-36.23q-57.94 0-95.22-37.47-37.28-37.48-37.28-95.42 0-57.94 37.28-95.22t95.22-37.28q57.95 0 95.42 37.28t37.47 95.22q0 57.94-37.47 95.42-37.47 37.47-95.42 37.47ZM33.85-187.69v-75.93q0-30 16.58-55.03Q67-343.69 95.31-356.54q66.61-29.31 121.58-42.92 54.96-13.62 113.3-13.62 58.35 0 112.81 13.62 54.46 13.61 121.46 42.92 27.92 12.85 45 37.89 17.08 25.03 17.08 55.03v75.93H33.85Zm296.54-350.62q37.46 0 62.38-24.92t24.92-62.38q0-37.47-24.92-62.39t-62.58-24.92q-37.65 0-62.38 24.92-24.73 24.92-24.73 62.39 0 37.46 24.71 62.38t62.6 24.92ZM79.23-233.08h501.92v-30.54q0-15.55-8.76-29.58-8.77-14.03-26.93-22.8-62.46-29.31-111.11-40.5-48.65-11.19-104.16-11.19T226.34-356.5Q178-345.31 114.31-316q-16.92 8.15-26 22.46-9.08 14.31-9.08 29.92v30.54Zm251.16-392.53Zm0 392.53Z","groups":"M20-248.46v-41.46q0-36.65 39.77-60.29t103.68-23.64q10.25 0 21.09.7 10.85.69 21.85 2.34-6.85 16.2-10.47 32.47-3.61 16.28-3.61 33.34v56.54H20Zm240 0v-55q0-28.09 15.77-51.35 15.77-23.27 45.46-40.57 29.69-17.31 70.16-25.96 40.46-8.66 88.46-8.66 48.92 0 89.38 8.66 40.46 8.65 70.15 25.96 29.7 17.3 45.16 40.57Q700-331.55 700-303.46v55H260Zm507.69 0v-56.42q0-17.97-3.11-34.24-3.12-16.26-10.35-31.61 11.77-1.73 22.36-2.42 10.6-.7 20.72-.7 64.03 0 103.36 23.2Q940-327.46 940-289.92v41.46H767.69ZM305-293.85h350v-8.69q1.15-36.61-47.23-59.34-48.39-22.73-127.77-22.73-79 0-127.58 22.73-48.57 22.73-47.42 59.96v8.07ZM162.54-405.38q-25 0-42.81-17.95-17.81-17.94-17.81-43.21 0-25.15 17.95-42.96 17.94-17.81 43.21-17.81 25.15 0 43.15 17.81t18 43.51q0 24.61-17.79 42.61t-43.9 18Zm634.33 0q-24.72 0-42.72-18.07-18-18.06-18-42.97 0-25.27 18.07-43.08 18.06-17.81 43.16-17.81 25.46 0 43.27 17.81 17.81 17.81 17.81 43.4 0 24.96-17.76 42.84-17.76 17.88-43.83 17.88ZM480.14-460q-43.22 0-73.6-30.29-30.38-30.28-30.38-73.55 0-44.14 30.28-73.99 30.29-29.86 73.56-29.86 44.13 0 73.99 29.82 29.85 29.81 29.85 73.89 0 43.21-29.81 73.6Q524.21-460 480.14-460Zm.4-45.38q24.69 0 41.31-16.97 16.61-16.96 16.61-42.04 0-24.68-16.72-41.3-16.71-16.61-41.39-16.61-24.58 0-41.7 16.71-17.11 16.72-17.11 41.4 0 24.58 16.96 41.69 16.97 17.12 42.04 17.12ZM480-293.85Zm0-269.99Z","handyman":"M753.56-100.39q-5.95 0-10.75-2-4.81-2-9.43-6.61l-229.3-229.31q-4.62-4.61-6.81-9.38-2.19-4.77-2.19-10.62 0-5.84 2.19-10.65 2.19-4.81 6.81-9.43l75.77-75.76q4.61-4.62 9.45-6.81 4.85-2.19 10.78-2.19 5.79 0 10.51 2.19t9.72 6.81l229.3 229.3q4.62 4.62 6.62 9.48t2 10.81q0 5.94-2 10.75t-6.62 9.42L773.85-109q-4.62 4.61-9.48 6.61t-10.81 2Zm.05-51.61 52.62-52.62-206.54-206.54-52.61 52.62L753.61-152Zm-548.28 51.61q-5.94 0-11.06-2t-9.73-6.61l-75.15-74.77q-4.62-4.62-6.62-9.81-2-5.18-2-11.11t2-10.93q2-5 6.52-9.52l218.56-218.55h84.23L447.39-479 272.77-653.62h-57L101.92-767.46l89-89 113.85 113.85v57L479.38-511l128.47-128.46L532-715.31l50.61-50.61H480.77l-14.92-14.54 117.61-117.62L598-883.54v102.23l50.61-50.61 170.16 169.38q14.22 14.01 21.95 32.47 7.74 18.46 7.74 39.11 0 15.96-4.96 31.58-4.96 15.61-13.89 28.69l-83.46-83.46-56.38 56.38-49.69-49.69-196.39 196.38v84.39L225.52-108.91q-4.52 4.52-9.38 6.52-4.86 2-10.81 2Zm.06-51.99 205.38-205.39v-52.62h-52.62L152.77-205l52.62 52.62Zm0 0L152.77-205l26.55 26.07 26.07 26.55Zm548.22.38 52.62-52.62L753.61-152Z","help":"M484.02-260.46q13.29 0 22.56-9.49 9.27-9.48 9.27-22.76 0-12.91-9.3-22.37-9.29-9.46-22.57-9.46-13.29 0-22.75 9.48-9.46 9.49-9.46 22.39 0 13.28 9.48 22.75 9.49 9.46 22.77 9.46ZM456.31-398h45.54q.38-24.46 7.65-44.04 7.27-19.58 37.04-44.88 29.84-26.39 42.46-49.85 12.61-23.46 12.61-51.66 0-49.42-32.34-79.88-32.35-30.46-83.65-30.46-44.39 0-78.62 22.77-34.23 22.77-50.46 59.62l41.84 16.15q11.39-26.85 32.43-41.77 21.04-14.92 51.81-14.92 36.69 0 57.3 20.04 20.62 20.03 20.62 49.42 0 21.61-12.23 40.15T513-508.92q-29.23 26-42.96 51.3-13.73 25.31-13.73 59.62Zm23.76 298q-78.22 0-147.4-29.92t-120.99-81.71q-51.81-51.79-81.75-120.94Q100-401.71 100-479.93q0-78.84 29.92-148.21t81.71-120.68q51.79-51.31 120.94-81.25Q401.71-860 479.93-860q78.84 0 148.21 29.92t120.68 81.21q51.31 51.29 81.25 120.63Q860-558.9 860-480.07q0 78.22-29.92 147.4t-81.21 120.99q-51.29 51.81-120.63 81.75Q558.9-100 480.07-100Zm-.07-45.39q139.69 0 237.15-97.76 97.46-97.77 97.46-236.85 0-139.69-97.46-237.15-97.46-97.46-237.15-97.46-139.08 0-236.85 97.46-97.76 97.46-97.76 237.15 0 139.08 97.76 236.85 97.77 97.76 236.85 97.76ZM480-480Z","history":"M477-140q-137.85 0-235.5-95.69T140-469.85h45.39Q190-351 273.69-268.19q83.7 82.8 203.31 82.8 124.31 0 210.58-87.07 86.27-87.08 86.27-211.39 0-122.07-86.89-206.42-86.88-84.34-209.96-84.34-64.54 0-121.73 28.3-57.19 28.31-100.42 75.85h100.77v45.38H175.46V-805h45.39v103.69q49.31-55.23 115.8-86.96Q403.15-820 477-820q70.77 0 132.92 26.46 62.16 26.46 108.77 72.46 46.62 46 73.58 107.54 26.96 61.54 26.96 131.92 0 70.77-26.96 133.12-26.96 62.35-73.58 108.46-46.61 46.12-108.77 73.08Q547.77-140 477-140Zm131.85-182.77L458.31-471.69v-210.54h45.38v191.69l137.77 135.16-32.61 32.61Z","home":"M225.39-185.39h155.76v-244.99h197.7v244.99h155.76v-381.92L480-759.23 225.39-567.44v382.05ZM180-140v-450l300-225.77L780-590v450H533.46v-245H426.54v245H180Zm300-332.62Z","ink_highlighter":"M551.31-411.23 439.38-523.15 225.46-309.62q-3.46 3.47-3.46 8.47t3.46 8.46l95 95q3.46 3.84 8.46 3.84 5 0 8.47-3.84l213.92-213.54ZM472-555.77l111.92 111.92 208.39-208.38q3.46-3.46 3.46-8.85 0-5.38-3.46-8.84l-94.23-94.23q-3.46-3.46-8.85-3.46-5.38 0-8.85 3.46L472-555.77Zm-48.61-16 176.53 176.54L376.69-172q-17.84 17.84-47.88 17.84-30.04 0-48.27-17.84l-11.39-11.77-48.38 48.38H98.08l109.23-109.23-5.54-5.92q-20.46-20.08-20.15-50.11.3-30.04 20.77-50.5l221-220.62Zm0 0 226.99-227q16.62-16.61 41.08-16.61 24.46 0 41.08 16.61L825.31-706q16.61 16.62 16.3 43-.3 26.38-16.92 43L599.92-395.23 423.39-571.77Z","ios_share":"M237.69-60q-23.53 0-40.61-17.08T180-117.69v-465.92q0-23.53 17.08-40.61 17.08-17.09 40.61-17.09h138.23v45.39H237.69q-4.61 0-8.46 3.84-3.84 3.85-3.84 8.47v465.92q0 4.61 3.84 8.46 3.85 3.84 8.46 3.84h484.62q4.61 0 8.46-3.84 3.84-3.85 3.84-8.46v-465.92q0-4.62-3.84-8.47-3.85-3.84-8.46-3.84H582.85v-45.39h139.46q23.53 0 40.61 17.09Q780-607.14 780-583.61v465.92q0 23.53-17.08 40.61T722.31-60H237.69Zm219-289.69v-448.54l-91.46 91.46-33-32.61 147.15-146.77 146.77 146.77-32.61 32.61-91.46-91.46v448.54h-45.39Z","left_panel_close":"M644.15-354v-252L517.77-480l126.38 126ZM197.69-140q-23.59 0-40.64-17.05T140-197.69v-564.62q0-23.59 17.05-40.64T197.69-820h564.62q23.59 0 40.64 17.05T820-762.31v564.62q0 23.59-17.05 40.64T762.31-140H197.69Zm127.39-45.39v-589.22H197.69q-4.61 0-8.46 3.84-3.84 3.85-3.84 8.46v564.62q0 4.61 3.84 8.46 3.85 3.84 8.46 3.84h127.39Zm45.38 0h391.85q4.61 0 8.46-3.84 3.84-3.85 3.84-8.46v-564.62q0-4.61-3.84-8.46-3.85-3.84-8.46-3.84H370.46v589.22Zm-45.38 0H185.39h139.69Z","left_panel_open":"M517.77-606v252l126.38-126-126.38-126ZM197.69-140q-23.59 0-40.64-17.05T140-197.69v-564.62q0-23.59 17.05-40.64T197.69-820h564.62q23.59 0 40.64 17.05T820-762.31v564.62q0 23.59-17.05 40.64T762.31-140H197.69Zm127.39-45.39v-589.22H197.69q-4.61 0-8.46 3.84-3.84 3.85-3.84 8.46v564.62q0 4.61 3.84 8.46 3.85 3.84 8.46 3.84h127.39Zm45.38 0h391.85q4.61 0 8.46-3.84 3.84-3.85 3.84-8.46v-564.62q0-4.61-3.84-8.46-3.85-3.84-8.46-3.84H370.46v589.22Zm-45.38 0H185.39h139.69Z","light_mode":"M480-345.39q55.69 0 95.15-39.46 39.46-39.46 39.46-95.15 0-55.69-39.46-95.15-39.46-39.46-95.15-39.46-55.69 0-95.15 39.46-39.46 39.46-39.46 95.15 0 55.69 39.46 95.15 39.46 39.46 95.15 39.46Zm0 45.39q-74.92 0-127.46-52.54Q300-405.08 300-480q0-74.92 52.54-127.46Q405.08-660 480-660q74.92 0 127.46 52.54Q660-554.92 660-480q0 74.92-52.54 127.46Q554.92-300 480-300ZM200-457.31H50v-45.38h150v45.38Zm710 0H760v-45.38h150v45.38ZM457.31-760v-150h45.38v150h-45.38Zm0 710v-150h45.38v150h-45.38ZM267.39-662.62l-93.08-90.46 32.23-33.61L296.77-694l-29.38 31.38Zm486.69 488.7-91.46-92.7L693.61-298l92.08 91.08-31.61 33ZM662-693.61l91.08-92.08 33.61 31.61-92.08 91.46L662-693.61ZM173.92-206.54 266-298l31.23 31.23-90.69 92.85-32.62-32.62ZM480-480Z","logout":"M197.69-140q-23.53 0-40.61-17.08T140-197.69v-564.62q0-23.53 17.08-40.61T197.69-820h282.08v45.39H197.69q-4.61 0-8.46 3.84-3.84 3.85-3.84 8.46v564.62q0 4.61 3.84 8.46 3.85 3.84 8.46 3.84h282.08V-140H197.69Zm470.62-187.69-33-32.23 97.38-97.39H363.85v-45.38h367.61l-97.38-97.39 32.61-32.61L820-479.19l-151.69 151.5Z","more_horiz":"M225.55-443.54q-15.1 0-25.71-10.75-10.61-10.74-10.61-25.83 0-15.09 10.75-25.72 10.74-10.62 25.83-10.62 15.09 0 25.91 10.75 10.82 10.74 10.82 25.83 0 15.09-10.87 25.72-10.86 10.62-26.12 10.62Zm254.33 0q-15.09 0-25.72-10.75-10.62-10.74-10.62-25.83 0-15.09 10.75-25.72 10.74-10.62 25.83-10.62 15.09 0 25.72 10.75 10.62 10.74 10.62 25.83 0 15.09-10.75 25.72-10.74 10.62-25.83 10.62Zm254.31 0q-15.09 0-25.91-10.75-10.82-10.74-10.82-25.83 0-15.09 10.87-25.72 10.86-10.62 26.12-10.62 15.1 0 25.71 10.75 10.61 10.74 10.61 25.83 0 15.09-10.75 25.72-10.74 10.62-25.83 10.62Z","note_add":"M457.31-245.54h45.38v-126.69H630v-45.38H502.69v-127.31h-45.38v127.31H330v45.38h127.31v126.69ZM237.69-100q-23.53 0-40.61-17.08T180-157.69v-644.62q0-23.53 17.08-40.61T237.69-860h347.54L780-665.23v507.54q0 23.53-17.08 40.61T722.31-100H237.69Zm324.85-544.77v-169.84H237.69q-4.61 0-8.46 3.84-3.84 3.85-3.84 8.46v644.62q0 4.61 3.84 8.46 3.85 3.84 8.46 3.84h484.62q4.61 0 8.46-3.84 3.84-3.85 3.84-8.46v-487.08H562.54ZM225.39-814.61v169.84-169.84 669.22-669.22Z","pause":"M533.85-220v-520H740v520H533.85ZM220-220v-520h206.54v520H220Zm359.23-45.39h115.38v-429.22H579.23v429.22Zm-313.84 0h115.76v-429.22H265.39v429.22Zm0-429.22v429.22-429.22Zm313.84 0v429.22-429.22Z","pause_fill":"M556.54-220v-520h160.77v520H556.54Zm-313.85 0v-520h161.16v520H242.69Z","play_arrow":"M340-238.39v-487.68l383.07 243.84L340-238.39Zm45.39-243.84Zm0 161 253.99-161-253.99-161v322Z","play_arrow_fill":"M340-238.39v-487.68l383.07 243.84L340-238.39Z","remove":"M220-457.31v-45.38h520v45.38H220Z","replay_10":"M480-100q-70.77 0-132.61-26.46-61.85-26.46-108.16-72.77-46.31-46.31-72.77-108.16Q140-369.23 140-440h45.39q0 122.69 85.78 208.65 85.78 85.96 208.83 85.96 123.05 0 208.83-85.78 85.78-85.78 85.78-208.83 0-123.05-84.03-208.83-84.04-85.78-206.73-85.78h-22.39l71.46 71.46-32 31.61-127.38-127.77 128.15-127.76 31.39 30.99L457-780h23q70.77 0 132.61 26.46 61.85 26.46 108.16 72.77 46.31 46.31 72.77 108.16Q820-510.77 820-440q0 70.77-26.46 132.61-26.46 61.85-72.77 108.16-46.31 46.31-108.16 72.77Q550.77-100 480-100ZM368.46-318.85v-203.53h-53.23v-39.39h93.62v242.92h-40.39Zm140.46 0q-17.93 0-30.39-12.45-12.45-12.46-12.45-30.39v-157.23q0-17.93 12.45-30.39 12.46-12.46 30.39-12.46h77.62q17.93 0 30.39 12.46 12.45 12.46 12.45 30.39v157.23q0 17.93-12.45 30.39-12.46 12.45-30.39 12.45h-77.62Zm2.16-40.38h73.3q2.31 0 3.47-1.15 1.15-1.16 1.15-3.47v-153.92q0-2.31-1.15-3.46-1.16-1.15-3.47-1.15h-73.3q-2.31 0-3.47 1.15-1.15 1.15-1.15 3.46v153.92q0 2.31 1.15 3.47 1.16 1.15 3.47 1.15Z","restart_alt":"M447.92-142.77q-113.77-11.15-190.84-96Q180-323.62 180-439.38q0-68.93 31.08-130.2 31.07-61.26 86.23-102.34l32.23 32.61q-49.85 33-77 86.46-27.15 53.47-27.15 113.47 0 96.92 63.49 167.99 63.5 71.08 159.04 83.24v45.38Zm65.39.77v-45.39q96.15-14.3 159.04-84.88 62.88-70.58 62.88-167.11 0-106.7-73.96-180.66T480.62-694h-26.54l65.77 65.77-32.62 32.61-121.07-121.07 121.07-121.08 32.62 32.62-65.77 65.77h26.54q125.53 0 212.76 87.73 87.23 87.73 87.23 212.27 0 115.76-76.76 200.42-76.77 84.65-190.54 96.96Z","right_panel_close":"M315.85-606v252l126.38-126-126.38-126ZM197.69-140q-23.59 0-40.64-17.05T140-197.69v-564.62q0-23.59 17.05-40.64T197.69-820h564.62q23.59 0 40.64 17.05T820-762.31v564.62q0 23.59-17.05 40.64T762.31-140H197.69Zm437.23-45.39h139.69v-576.92q0-4.61-3.84-8.46-3.85-3.84-8.46-3.84H634.92v589.22Zm-45.38 0v-589.22H197.69q-4.61 0-8.46 3.84-3.84 3.85-3.84 8.46v564.62q0 4.61 3.84 8.46 3.85 3.84 8.46 3.84h391.85Zm45.38 0h139.69-139.69Z","right_panel_open":"M442.23-354v-252L315.85-480l126.38 126ZM197.69-140q-23.59 0-40.64-17.05T140-197.69v-564.62q0-23.59 17.05-40.64T197.69-820h564.62q23.59 0 40.64 17.05T820-762.31v564.62q0 23.59-17.05 40.64T762.31-140H197.69Zm437.23-45.39h139.69v-576.92q0-4.61-3.84-8.46-3.85-3.84-8.46-3.84H634.92v589.22Zm-45.38 0v-589.22H197.69q-4.61 0-8.46 3.84-3.84 3.85-3.84 8.46v564.62q0 4.61 3.84 8.46 3.85 3.84 8.46 3.84h391.85Zm45.38 0h139.69-139.69Z","schedule":"m630.08-295.46 33.84-33.85-159-160.01v-200.22h-45.38v218.85l170.54 175.23ZM480.07-100q-78.22 0-147.4-29.92t-120.99-81.71q-51.81-51.79-81.75-120.94Q100-401.71 100-479.93q0-78.22 29.92-147.4t81.71-120.99q51.79-51.81 120.94-81.75Q401.71-860 479.93-860q78.22 0 147.4 29.92t120.99 81.71q51.81 51.79 81.75 120.94Q860-558.29 860-480.07q0 78.22-29.92 147.4t-81.71 120.99q-51.79 51.81-120.94 81.75Q558.29-100 480.07-100ZM480-480Zm0 334.61q138.08 0 236.35-98.26 98.26-98.27 98.26-236.35 0-138.08-98.26-236.35-98.27-98.26-236.35-98.26-138.08 0-236.35 98.26-98.26 98.27-98.26 236.35 0 138.08 98.26 236.35 98.27 98.26 236.35 98.26Z","settings":"m400.69-100-18.07-120.23q-20.54-7-44.23-20.35-23.7-13.34-40.85-28.27l-111.85 50.93-79.92-141.31 101.08-74.38q-2-10.54-2.89-23.01-.88-12.46-.88-23 0-10.15.88-22.61.89-12.46 2.89-24.16l-101.08-74.76 79.92-140.16 111.46 50.16q18.31-14.93 41.24-28.08 22.92-13.15 43.84-19.54L400.69-860h158.62l18.07 120.62q22.08 8.15 44.16 20.23 22.07 12.07 39.77 28l113.38-50.16 79.54 140.16-102.62 74.3q2.77 11.93 3.47 24 .69 12.08.69 22.85 0 10.38-.89 22.15-.88 11.77-3.27 24.47l102.23 74.15-79.92 141.31-112.61-51.31q-18.7 15.69-40.35 28.96-21.65 13.27-43.58 19.65L559.31-100H400.69Zm36.46-45.39h85.31L536.85-257q31.84-8 59.42-23.85 27.58-15.84 52.73-40.23l104.46 45.23 40-70.84L701-414.92q4-17.77 6.31-33.5 2.3-15.73 2.3-31.58 0-16.62-2-31.96-2-15.35-6.61-32.35l93.23-69-40-70.84-105.62 45.23q-21.07-23.69-50.84-41.77Q568-698.77 536.46-703l-13.61-111.61h-85.7l-13.23 111.23q-33.23 6.61-61.19 22.65t-52.11 41.42l-104.85-44.84-40 70.84 92.46 67.85q-4.38 15.84-6.69 32.15-2.31 16.31-2.31 33.69 0 16.62 2.31 32.54 2.31 15.93 6.31 32.16l-92.08 68.23 40 70.84 104.46-44.84q24 24.38 52.15 40.23 28.16 15.84 61.16 23.84l13.61 111.23Zm41.7-221.92q47.07 0 79.88-32.81 32.81-32.8 32.81-79.88t-32.81-79.88q-32.81-32.81-79.88-32.81-46.7 0-79.7 32.81-32.99 32.8-32.99 79.88t32.99 79.88q33 32.81 79.7 32.81ZM480-480Z","table_rows":"M774.61-197.69v-148.16H185.39v148.16q0 5.38 3.46 8.84t8.84 3.46h564.62q5.38 0 8.84-3.46t3.46-8.84Zm0-193.54v-177.54H185.39v177.54h589.22Zm0-222.92v-148.16q0-5.38-3.46-8.84t-8.84-3.46H197.69q-5.38 0-8.84 3.46t-3.46 8.84v148.16h589.22ZM197.69-140q-23.53 0-40.61-17.08T140-197.69v-564.62q0-23.53 17.08-40.61T197.69-820h564.62q23.53 0 40.61 17.08T820-762.31v564.62q0 23.53-17.08 40.61T762.31-140H197.69Z","tune":"M440.46-130v-209.23h45.39V-257H830v45.38H485.85V-130h-45.39ZM130-211.62V-257h225.08v45.38H130Zm179.69-164.07v-81.62H130v-45.38h179.69v-82.85h45.39v209.85h-45.39Zm130.77-81.62v-45.38H830v45.38H440.46Zm164.46-163.84V-830h45.39v81.62H830V-703H650.31v81.85h-45.39ZM130-703v-45.38h389.54V-703H130Z"};
function ms(n,size=20){return `<svg class="ms" viewBox="0 -960 960 960" width="${size}" height="${size}" fill="currentColor" aria-hidden="true"><path d="${msPaths[n]||''}"/></svg>`}
const dxNarrow=side=>side==='left'?innerWidth<=860:innerWidth<=1200;
const dxShown=side=>dxNarrow(side)?dxDrawer===(side==='left'?'chat':'notes'):!dxCollapsed[side];
function dxClasses(){return 'dx-shell'+(dxCollapsed.left?' dx-cl':'')+(dxCollapsed.right?' dx-cr':'')+(dxDrawer==='chat'?' dx-sc':'')+(dxDrawer==='notes'?' dx-sn':'')}
function dxSyncPanels(){const root=$('.dx-shell');if(!root)return;root.classList.toggle('dx-cl',dxCollapsed.left);root.classList.toggle('dx-cr',dxCollapsed.right);root.classList.toggle('dx-sc',dxDrawer==='chat');root.classList.toggle('dx-sn',dxDrawer==='notes');
 for(const [side,id,name] of [['left','dx-tgl-left','chat'],['right','dx-tgl-right','notes']]){const b=document.getElementById(id);if(!b)continue;const v=dxShown(side);b.setAttribute('aria-expanded',String(v));b.setAttribute('aria-label',(v?'Hide ':'Show ')+name);b.dataset.tip=(v?'Hide ':'Show ')+name+(side==='left'?'  (Ctrl [)':'  (Ctrl ])');b.innerHTML=ms(side+'_panel_'+(v?'close':'open'))}}
function dxTogglePanel(side){if(dxNarrow(side)){const want=side==='left'?'chat':'notes';dxDrawer=dxDrawer===want?null:want}else{dxCollapsed[side]=!dxCollapsed[side];try{localStorage.setItem('citely-dx-'+side,dxCollapsed[side]?'1':'0')}catch{}}dxSyncPanels()}
function dxShowNotes(){if(dxNarrow('right'))dxDrawer='notes';else if(dxCollapsed.right){dxCollapsed.right=false;try{localStorage.setItem('citely-dx-right','0')}catch{}}}
function dxClosePop(){document.querySelectorAll('.dx-pop').forEach(p=>p.hidden=true);document.querySelectorAll('[data-dx-pop][aria-expanded=true],#notes-history[aria-expanded=true]').forEach(b=>b.setAttribute('aria-expanded','false'));dxPop=null}
function dxPlace(p,anchor){const r=anchor.getBoundingClientRect(),w=p.offsetWidth,h=p.offsetHeight;let left=r.right-w,top=r.bottom+6;
 if(anchor.closest('.dx-rail')){left=r.right+10;top=Math.min(r.top,innerHeight-h-10)}else if(anchor.classList.contains('dx-file'))left=r.left;
 left=Math.max(10,Math.min(left,innerWidth-w-10));if(top+h>innerHeight-10)top=Math.max(10,r.top-h-6);p.style.left=left+'px';p.style.top=top+'px'}
function dxOpenPop(name,anchor,{keepFocus=false}={}){const p=document.getElementById('dx-pop-'+name);if(!p)return;if(dxPop===name&&!keepFocus){dxClosePop();return}dxClosePop();p.hidden=false;anchor.setAttribute('aria-expanded','true');dxPlace(p,anchor);dxPop=name;if(!keepFocus&&!(name==='tools'&&window.getSelection()?.toString()))p.querySelector('button:not([disabled]),a')?.focus({preventScroll:true})}
// Saved notes live in the conversation record next to the messages, so Save
// keeps them with everything else and Delete conversation removes them.
const savedNotes=()=>(work.saved ||= []);
const plainAnswer=m=>m.text.replace(/\s*\[\d+\]/g,'').trim();
function citeShort(c){const a=c.anchor;return a?.format==='pptx'?'S'+(a.slide_index+1):a?.format==='xlsx'?a.range:'p.'+c.page}
function citeLong(c){return anchorLabel(c.anchor)||'Page '+c.page}
function pageWord(d){return viewerKind(d)==='pptx'?'Slide':'Page'}
function dxAgo(t){const s=(Date.now()-t)/1000;return s<60?'Just now':s<3600?Math.floor(s/60)+' min ago':s<86400?Math.floor(s/3600)+' h ago':Math.floor(s/86400)+' d ago'}
function dxChatText(){return work.messages.map(m=>`${m.name}: ${m.role==='assistant'?plainAnswer(m):m.text}`).join('\n\n')}
// ---- Resizable side panels --------------------------------------------------
// Drag the edge of the chat or notes column (or focus it and use the arrow
// keys; double-click resets). Widths are remembered on this device.
const DXW={left:[280,560,340],right:[260,520,320]};
const dxWStore=k=>{try{return Number(localStorage.getItem('citely-dx-w-'+k))||0}catch{return 0}};
let dxW={left:dxWStore('left')||DXW.left[2],right:dxWStore('right')||DXW.right[2]};
function dxSaveW(side){try{localStorage.setItem('citely-dx-w-'+side,String(dxW[side]))}catch{}}
function dxApplyW(){const s=$('.dx-shell');if(s){s.style.setProperty('--dx-chat-w',dxW.left+'px');s.style.setProperty('--dx-notes-w',dxW.right+'px')}$$('[data-dx-resize]').forEach(h=>h.setAttribute('aria-valuenow',String(dxW[h.dataset.dxResize])))}
function dxClampW(side,v){const [min,max]=DXW[side],o=side==='left'?'right':'left',other=dxShown(o)&&!dxNarrow(o)?dxW[o]:0;return Math.round(Math.max(min,Math.min(max,innerWidth-56-other-360,v)))}
function bindResize(){$$('[data-dx-resize]').forEach(h=>{const side=h.dataset.dxResize,sign=side==='left'?1:-1;
 h.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();h.setPointerCapture(e.pointerId);const x0=e.clientX,w0=dxW[side],shell=$('.dx-shell');shell.classList.add('dx-resizing');
  h.onpointermove=ev=>{dxW[side]=dxClampW(side,w0+sign*(ev.clientX-x0));dxApplyW()};
  h.onpointerup=h.onpointercancel=()=>{h.onpointermove=null;shell.classList.remove('dx-resizing');dxSaveW(side)}};
 h.onkeydown=e=>{const step=e.shiftKey?48:16;let v=dxW[side];if(e.key==='ArrowLeft')v-=sign*step;else if(e.key==='ArrowRight')v+=sign*step;else if(e.key==='Home')v=DXW[side][2];else return;e.preventDefault();dxW[side]=dxClampW(side,v);dxApplyW();dxSaveW(side)};
 h.ondblclick=()=>{dxW[side]=DXW[side][2];dxApplyW();dxSaveW(side)}})}
// ---- Coming soon --------------------------------------------------------------
const SOON={share:['Share this conversation','Sharing a conversation by link or email is coming soon. For now, export a copy and send it yourself.'],notes:['Share notes','Sharing notes with other people is coming soon. For now, export them as Markdown.'],collab:['Collaborate','Inviting people to ask, highlight and take notes in one conversation is coming soon.'],audio:['Audio overview','Turn your sources into a short episode to listen to, with formats, languages and lengths to choose from. Coming soon to your workspace. You can try it now in the interactive demo.']};
function comingSoon(kind){const [title,text]=SOON[kind];if(typeof dxClosePop==='function')dxClosePop();modal(title,`<p class="modal-description">${text}</p>${(kind==='share'||kind==='notes')&&deskId?'<button class="button primary" id="soon-export">Export instead</button>':''}`,'COMING SOON');$('#soon-export')?.addEventListener('click',exportChatModal)}
const soonTag='<span class="dx-soon">Soon</span>';
// ---- Audio overview -------------------------------------------------------------
// Live in the demo: a short episode scripted from the prepared sample answers and
// read aloud by the browser's own voice (nothing is sent anywhere). Coming soon in
// the real workspace. The timeline runs on a clock, so it also works without a voice.
const AU_FMTS=[['deep','Deep Dive','Two hosts unpack and connect the topics in your sources.'],['brief','Brief','A short overview of the core ideas.'],['critique','Critique','An expert review with constructive feedback on the material.'],['debate','Debate','Two hosts argue different perspectives on your sources.']];
const AU_LENS={short:'Short',default:'Default',long:'Long'};
const AU_LANGS=[['English','en'],['Hindi','hi'],['Hinglish','en-IN'],['Spanish','es'],['French','fr'],['German','de']];
const AU_BARS=Array.from({length:64},(_,i)=>16+Math.round(Math.abs(Math.sin(i*1.7)*.6+Math.sin(i*.43)*.4)*80));
let dxAudio=null,auTimer=null,auUtter=null,auLineNow=-1,auHold=0,auGen=null;
const au=()=>(dxAudio ||= {state:'none',visible:false,playing:false,t:0,dur:0,fmt:'deep',len:'default',lang:'English',src:'all',focus:'',speed:1,lines:[]});
const mmss=s=>{s=Math.max(0,Math.round(s));return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')};
const auIndex=a=>{const i=a.lines.findIndex(l=>a.t<l.start+l.dur);return i<0?a.lines.length-1:i};
function auScript(a){
 const docs=scopeDocs().filter(d=>a.src==='all'||d.id===a.src),ep=window.CitelyAPI.demo.episode(docs.map(d=>d.id));
 let items=ep.flatMap(f=>f.answers.map(x=>({...x,file:f.name})));items=a.len==='short'?items.slice(0,2):a.len==='default'?items.slice(0,4):items;
 const title=desk.name,focus=a.focus.trim(),L=[],say=(who,text)=>L.push({who,text}),A='Host 1',B='Host 2';
 if(a.fmt==='deep'){say(A,`Welcome to the deep dive. Today we're looking at ${title}.`);say(B,`${docs.length===1?'One file':docs.length+' files'}, and everything we say comes straight from ${docs.length===1?'it':'them'}.`);if(focus)say(A,`You asked us to focus on ${focus}. Let's keep that in mind.`);items.forEach((x,i)=>{say(A,(i?'Next question. ':'')+x.question);say(B,x.answer);if(a.len==='long'&&x.quotes[0])say(A,`The source puts it like this: ${x.quotes[0]}`)});say(B,'That is the picture. Open the citations in Citely to check each point.')}
 else if(a.fmt==='brief'){say('Narrator',`A brief on ${title}.`);if(focus)say('Narrator',`Focus: ${focus}.`);items.forEach(x=>say('Narrator',x.answer));if(a.len==='long')items.forEach(x=>{if(x.quotes[0])say('Narrator',`In the source's words: ${x.quotes[0]}`)});say('Narrator','That is the brief.')}
 else if(a.fmt==='critique'){say('Reviewer',`A review of ${title}.`);if(focus)say('Reviewer',`With a focus on ${focus}.`);items.forEach(x=>{say('Reviewer',`On ${x.label.toLowerCase()}: ${x.answer}`);say('Reviewer',`What works: the point is specific and traceable to ${x.file}. What to check: whether it gives enough context to act on.`)});say('Reviewer','Overall the material is clear. Check each citation before relying on it.')}
 else{say(A,`Today's debate: what does ${title} really tell us?`);if(focus)say(B,`And we'll keep coming back to ${focus}.`);items.forEach((x,i)=>{say(A,`Here's my case. ${x.answer}`);say(B,i<items.length-1?`Maybe, but don't stop there. ${items[i+1].answer}`:'Fair, but the sources alone cannot tell us what happens next.')});say(A,"Let's leave it there. Every point is cited in the chat, so you can decide.")}
 let t=0;return L.map(l=>{const dur=Math.max(2,l.text.split(/\s+/).length/2.6);const o={...l,start:t,dur};t+=dur;return o})}
function auVoice(a,who){if(!('speechSynthesis' in window))return null;const vs=speechSynthesis.getVoices(),code=(AU_LANGS.find(l=>l[0]===a.lang)?.[1]||'en').toLowerCase(),base=code.split('-')[0];let pool=vs.filter(v=>v.lang.toLowerCase().startsWith(code));if(!pool.length)pool=vs.filter(v=>v.lang.toLowerCase().startsWith(base));if(!pool.length)pool=vs.filter(v=>/^en/i.test(v.lang));const hosts=[...new Set(a.lines.map(l=>l.who))];return {voice:pool[hosts.indexOf(who)%Math.max(1,pool.length)]||null,second:hosts.indexOf(who)===1&&pool.length<2}}
function auSpeak(i){const a=au(),l=a.lines[i];auLineNow=i;auHold=0;if(!('speechSynthesis' in window)||!l)return;speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(l.text),v=auVoice(a,l.who);if(v?.voice){u.voice=v.voice;u.lang=v.voice.lang}if(v?.second)u.pitch=.8;u.rate=a.speed;
 u.onstart=()=>{u.started=true};u.onend=u.onerror=()=>{if(auUtter!==u)return;auUtter=null;const a=au();if(a.playing&&u.started&&a.t<l.start+l.dur)a.t=l.start+l.dur};auUtter=u;speechSynthesis.speak(u)}
function auHush(){clearInterval(auTimer);auTimer=null;auUtter=null;if('speechSynthesis' in window)speechSynthesis.cancel()}
function auPlay(){const a=au();if(a.t>=a.dur)a.t=0;a.t=a.lines[auIndex(a)].start;a.playing=true;auSpeak(auIndex(a));clearInterval(auTimer);
 auTimer=setInterval(()=>{const a=au(),l=a.lines[auLineNow],end=l?l.start+l.dur:a.dur;let t=a.t+.25*a.speed;
  if(auUtter?.started&&t>=end-.05&&auHold<4){auHold+=.25;a.t=end-.05;auPaint();return}   // the voice is still talking: let it finish
  a.t=Math.min(t,a.dur);if(a.t>=a.dur){auPause();auRender();return}const i=auIndex(a);if(i!==auLineNow)auSpeak(i);auPaint()},250);auRender()}
function auPause(){au().playing=false;auHush();auRender()}
function auSeek(t){const a=au();a.t=Math.max(0,Math.min(a.dur,t));if(a.playing){a.t=a.lines[auIndex(a)].start;auSpeak(auIndex(a))}auRender()}
function auStopAll(){auHush();clearTimeout(auGen);auGen=null;dxAudio=null}
function auPlayerHTML(){const a=au();if(!a.visible||!window.CitelyAPI.demo)return '';const f=AU_FMTS.find(x=>x[0]===a.fmt),past=a.dur?Math.floor(a.t/a.dur*AU_BARS.length):0,l=a.state==='ready'&&a.lines[auIndex(a)];
 return `<div class="dx-player${a.playing?' playing':''}" id="dx-player" role="region" aria-label="Audio overview">
  <div class="dx-prow"><div class="dx-pmeta"><span class="dx-label">${f[1].toUpperCase()}</span><b>${esc(desk.name)} · ${esc(a.lang)} · ${AU_LENS[a.len].toLowerCase()}</b></div><button class="dx-i" data-au-custom data-tip="Customize" aria-label="Customize audio">${ms('tune')}</button><button class="dx-i" data-au-close aria-label="Close player">${ms('close')}</button></div>
  ${a.state!=='ready'?'<div class="dx-prow"><div class="dx-gen"><i></i></div><span class="dx-ptime">Generating…</span></div>':`<div class="dx-prow"><button class="dx-i" data-au-seek="-10" aria-label="Back 10 seconds">${ms('replay_10')}</button><button class="dx-play" data-au-play aria-label="${a.playing?'Pause':'Play'}">${ms(a.playing?'pause_fill':'play_arrow_fill',24)}</button><button class="dx-i" data-au-seek="10" aria-label="Forward 10 seconds">${ms('forward_10')}</button><div class="dx-wave" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="${Math.round(a.dur)}" aria-valuenow="${Math.round(a.t)}" aria-valuetext="${mmss(a.t)}">${AU_BARS.map((h,i)=>`<i class="${i<past?'past':''}" style="--h:${h}%;--d:${(i%7)*-.12}s"></i>`).join('')}</div><span class="dx-ptime">${mmss(a.t)} / ${mmss(a.dur)}</span><button class="dx-b quiet dx-speed" data-au-speed aria-label="Playback speed">${a.speed}x</button></div>
  <p class="dx-caption"><b>${esc(l?.who||'')}</b> ${esc(l?.text||'')}</p>`}</div>`}
function auPaint(){const a=au(),p=$('#dx-player');if(!p)return;const past=a.dur?Math.floor(a.t/a.dur*AU_BARS.length):0,l=a.lines[auIndex(a)];p.querySelectorAll('.dx-wave i').forEach((b,i)=>b.classList.toggle('past',i<past));const w=p.querySelector('.dx-wave');w?.setAttribute('aria-valuenow',String(Math.round(a.t)));w?.setAttribute('aria-valuetext',mmss(a.t));const tm=p.querySelector('.dx-ptime');if(tm&&a.state==='ready')tm.textContent=`${mmss(a.t)} / ${mmss(a.dur)}`;const c=p.querySelector('.dx-caption');if(c&&l)c.innerHTML=`<b>${esc(l.who)}</b> ${esc(l.text)}`}
function auRender(){const p=$('#dx-player');if(!p){render();return}const focus=document.activeElement?.closest?.('#dx-player [data-au-play],#dx-player [data-au-speed],#dx-player .dx-wave');const sel=focus&&(focus.matches('[data-au-play]')?'[data-au-play]':focus.matches('[data-au-speed]')?'[data-au-speed]':'.dx-wave');p.outerHTML=auPlayerHTML();bindAudio();if(sel)$('#dx-player '+sel)?.focus();$$('[data-au-toggle]').forEach(b=>b.classList.toggle('on',au().visible))}
function bindAudio(){
 $$('[data-au-play]').forEach(b=>b.onclick=()=>au().playing?auPause():auPlay());
 $$('[data-au-seek]').forEach(b=>b.onclick=()=>auSeek(au().t+Number(b.dataset.auSeek)));
 $$('[data-au-speed]').forEach(b=>b.onclick=()=>{const a=au(),s=[1,1.25,1.5,2,.75];a.speed=s[(s.indexOf(a.speed)+1)%s.length];if(a.playing)auSpeak(auIndex(a));auRender()});
 $$('#dx-player .dx-wave').forEach(w=>{w.onclick=e=>{const r=w.getBoundingClientRect();auSeek((e.clientX-r.left)/r.width*au().dur)};w.onkeydown=e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();auSeek(au().t+(e.key==='ArrowRight'?5:-5))}else if(e.key===' '||e.key==='Enter'){e.preventDefault();au().playing?auPause():auPlay()}}});
 $$('[data-au-custom]').forEach(b=>b.onclick=auDialog);
 $$('[data-au-close]').forEach(b=>b.onclick=()=>{const a=au();a.visible=false;a.playing=false;auHush();render()});
}
function auGenerate(show){const a=au(),epoch=deskEpoch;auHush();a.playing=false;a.lines=auScript(a);a.dur=a.lines.at(-1).start+a.lines.at(-1).dur;a.t=0;a.state='generating';if(show)a.visible=true;render();clearTimeout(auGen);
 auGen=setTimeout(()=>{if(epoch!==deskEpoch)return;a.state='ready';if(a.visible)render();toast(a.visible?'Audio overview ready.':'Audio overview ready. Open it from Tools.')},2400)}
function auDialog(){const a=au(),docs=scopeDocs();if(!window.CitelyAPI.demo){comingSoon('audio');return}dxClosePop();
 modal('Customize the episode',`<div class="dx-au"><div><span class="dx-flabel">FORMAT</span><div class="dx-fmts" role="radiogroup" aria-label="Format">${AU_FMTS.map(f=>`<button type="button" class="dx-fmt${a.fmt===f[0]?' on':''}" role="radio" aria-checked="${a.fmt===f[0]}" data-au-fmt="${f[0]}">${ms('check_circle',18)}<b>${f[1]}</b><span>${f[2]}</span></button>`).join('')}</div></div>
  <div class="dx-g3"><label><span class="dx-flabel">LANGUAGE</span><select class="dx-field" id="au-lang">${AU_LANGS.map(([l])=>`<option ${a.lang===l?'selected':''}>${l}</option>`).join('')}</select></label><div><span class="dx-flabel">LENGTH</span><div class="dx-segs" role="group" aria-label="Length">${Object.entries(AU_LENS).map(([k,n])=>`<button type="button" class="${a.len===k?'on':''}" aria-pressed="${a.len===k}" data-au-len="${k}">${n}</button>`).join('')}</div></div><label><span class="dx-flabel">SOURCES</span><select class="dx-field" id="au-src"><option value="all">${docs.length===1?'1 source':'All '+docs.length+' sources'}</option>${docs.length>1?docs.map(d=>`<option value="${esc(d.id)}" ${a.src===d.id?'selected':''}>${esc(d.name)}</option>`).join(''):''}</select></label></div>
  <label><span class="dx-flabel">FOCUS</span><textarea class="dx-area" id="au-focus" placeholder="What should the hosts focus on? e.g. the main risks">${esc(a.focus)}</textarea></label><div class="dx-sugs">${['Key numbers','Main risks','Next steps'].map(s=>`<button type="button" data-au-focus="${s}">${s}</button>`).join('')}</div>
  <p class="fine-print">Demo: the episode is scripted from the prepared sample answers in English and read aloud by your browser's voice. Nothing is sent to an AI service.</p></div>
  <div class="dx-mf"><button class="dx-b quiet" id="au-later">Generate later</button><button class="dx-b primary" id="au-now">Generate now</button></div>`,'AUDIO OVERVIEW');
 const m=$('#modal');m.classList.add('wide');
 $$('[data-au-fmt]').forEach(b=>b.onclick=()=>{a.fmt=b.dataset.auFmt;$$('[data-au-fmt]').forEach(x=>{x.classList.toggle('on',x===b);x.setAttribute('aria-checked',String(x===b))})});
 $$('[data-au-len]').forEach(b=>b.onclick=()=>{a.len=b.dataset.auLen;$$('[data-au-len]').forEach(x=>{x.classList.toggle('on',x===b);x.setAttribute('aria-pressed',String(x===b))})});
 $$('[data-au-focus]').forEach(b=>b.onclick=()=>{const f=$('#au-focus');f.value=(f.value.trim()?f.value.trim()+' ':'')+b.dataset.auFocus+'.';f.focus()});
 const read=()=>{a.lang=$('#au-lang').value;a.src=$('#au-src').value;a.focus=$('#au-focus').value};
 $('#au-later').onclick=()=>{read();m.close();auGenerate(false);toast('Audio overview queued.')};
 $('#au-now').onclick=()=>{read();m.close();auGenerate(true)};
}
function auToggle(){if(!window.CitelyAPI.demo){comingSoon('audio');return}const a=au();if(a.state==='none'){auDialog();return}a.visible=!a.visible;if(!a.visible){a.playing=false;auHush()}render()}
function dxNotesHTML(){
 const list=savedNotes(),open=dxNote&&list.find(n=>n.id===dxNote);
 if(open)return `<div class="dx-full"><div class="dx-crumb"><button data-close-note>Notes</button>${ms('chevron_right',15)}<span>Note</span><span class="dx-grow"></span><button class="dx-i" data-delete-note="${esc(open.id)}" data-tip="Delete" aria-label="Delete note">${ms('delete')}</button><button class="dx-i" data-close-note data-tip="Collapse" aria-label="Collapse note">${ms('close_fullscreen')}</button></div>
  <input class="dx-ftitle" data-note-field="title" aria-label="Title" value="${esc(open.title)}"><div class="dx-mt dx-mt-open"><span>${esc(new Date(open.at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}))}</span>${open.cite?`<button class="dx-cite" data-note-cite="${esc(open.id)}">${esc(open.cite.label)}</button>`:''}</div>
  <textarea class="dx-fbody" data-note-field="body" aria-label="Note">${esc(open.body)}</textarea></div>`;
 const ad=activeDoc();
 return `<div class="dx-sec"><label class="dx-label" for="notes-editor">WORKING NOTES</label><button class="dx-i dx-i30" id="notes-history" aria-haspopup="true" aria-expanded="false" data-tip="History" aria-label="Revision history">${ms('history',18)}</button></div>
  <textarea id="notes-editor" class="dx-wn" ${!notesReady?'disabled':''} placeholder="What matters? Capture your thinking here...">${esc(work.notes)}</textarea>
  <div class="dx-rev" role="status">${notesReady?'Revision '+noteBase.revision+(noteBase.created_at?', saved '+esc(new Date(noteBase.created_at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})):''):esc(noteError||'Loading notes…')}${noteError?' <button class="text-button" id="retry-notes">Retry</button>':''}</div>
  <div class="dx-list"><div class="dx-sec"><span class="dx-label">SAVED</span></div>
  ${dxComposing?`<div class="dx-composer"><input id="dx-new-title" aria-label="Title" placeholder="Title"><textarea id="dx-new-body" aria-label="Note" placeholder="Write a note.${ad?` It will cite ${pageWord(ad).toLowerCase()} ${currentPage}.`:''}"></textarea><div class="dx-crow"><button class="dx-b quiet" data-cancel-note>Cancel</button><button class="dx-b primary" data-add-note>Save note</button></div></div>`:''}
  ${list.map(n=>`<button class="dx-row" data-open-note="${esc(n.id)}"><h4>${esc(n.title)}</h4><p>${esc(n.body)}</p><div class="dx-mt"><span>${dxAgo(n.at)}</span>${n.cite?`<span class="c">${esc(n.cite.label)}</span>`:''}</div></button>`).join('')}
  ${!list.length&&!dxComposing?'<div class="dx-empty"><b>No saved notes</b>Add one below, or save an answer from the chat.</div>':''}</div>`}
function deskHTML(){
 if(mobilePane==='document'){dxDrawer=null;mobilePane=''}   // opening a citation brings the document forward
 const docs=scopeDocs(),n=docs.length,folderDesk=desk.type==='folder',me=directory[0],ad=activeDoc(),total=ad?.pages||1,lim=outOf('questions'),demo=window.CitelyAPI.demo;
 const kind=ad?kindOf(ad.name):['FILE','#5F646C'],home=window.CitelyAPI.asset('/studio.html')+'?space='+encodeURIComponent(currentSpace);
 const pop=(name,w,html)=>`<div class="dx-pop" id="dx-pop-${name}" role="menu" hidden${w?` style="width:${w}px"`:''}>${html}</div>`;
 const mi=(attrs,icon,label,extra='',k='')=>`<button class="dx-mi${extra?' '+extra:''}" role="menuitem" ${attrs}>${ms(icon,18)}<span>${label}</span>${k?`<span class="dx-k">${k}</span>`:''}</button>`;
 const theme=themeChoice(),cited=tempCitations.length>0;
 const leave=demo?mi('data-demo-reset','restart_alt','Reset demo')+`<a class="dx-mi" href="${esc(window.CitelyAPI.asset('/'))}" target="_top">${ms('logout',18)}<span>Back to Citely</span></a>`:mi('data-logout','logout','Sign out','dx-danger');
 const hint=statusMessage?esc(statusMessage):highlightTool?(viewerKind(ad)==='xlsx'?'Select cells to highlight':'Select text to highlight'):'';
 return `<div class="${dxClasses()}" style="--dx-chat-w:${dxW.left}px;--dx-notes-w:${dxW.right}px">
 <nav class="dx-rail" aria-label="Main"><a class="dx-brand" href="${esc(window.CitelyAPI.asset('/'))}"${demo?' target="_top"':''} aria-label="Citely website">${logo()}</a>
  <a class="dx-ri" href="${home}" data-dx-home="overview" data-tip="Home" aria-label="Home">${ms('home')}</a>
  <button class="dx-ri on" data-tip="Conversation" aria-label="Conversation" aria-current="page">${ms('forum')}</button>
  <a class="dx-ri" href="${home}" data-dx-home="home" data-tip="Library" aria-label="Library">${ms('folder_open')}</a>
  <div class="dx-grow"></div>
  <button class="dx-ri" data-dx-pop="account" aria-haspopup="true" aria-expanded="false" data-tip="Settings" aria-label="Settings">${ms('settings')}</button>
  <button class="dx-avatar" data-dx-pop="account" aria-haspopup="true" aria-expanded="false" aria-label="Account">${esc(initials(me.name))}</button></nav>
 <header class="dx-top">
  <a class="desk-back-home dx-i" href="${home}" data-tip="Back to Home" aria-label="Back to Home">${ms('arrow_back')}</a>
  <button class="dx-i" id="dx-tgl-left" data-dx-panel="left" aria-expanded="${dxShown('left')}" aria-label="${dxShown('left')?'Hide':'Show'} chat">${ms('left_panel_'+(dxShown('left')?'close':'open'))}</button>
  <div class="desk-identity dx-title"><strong>${esc(desk.name)}</strong><small class="dx-wide">${esc(space().name)} / ${folderDesk?'Folder conversation':'Document conversation'}</small></div>
  <span class="save-state dx-saved${dirty?' dirty':''}" id="save-state" role="status" aria-live="polite"><i></i><span>${busy?'Saving…':dirty?'Unsaved changes':'All changes saved'}</span></span>
  <button class="dx-b primary" id="save-changes" aria-label="Save changes" ${busy?'disabled':''}>${busy?'Saving…':'Save'}</button>
  <button class="dx-b quiet dx-wide" data-share>${ms('ios_share',18)}Share</button>
  <button class="dx-i" data-dx-pop="more" aria-haspopup="true" aria-expanded="false" data-tip="More" aria-label="More actions">${ms('more_horiz')}</button>
  <button class="dx-i" id="dx-tgl-right" data-dx-panel="right" aria-expanded="${dxShown('right')}" aria-label="${dxShown('right')?'Hide':'Show'} notes">${ms('right_panel_'+(dxShown('right')?'close':'open'))}</button>
 </header>
 <div class="dx-cols">
  <section class="dx-col dx-chat conversation-pane" aria-label="Conversation">
   <div class="dx-head"><div><span class="dx-label">01 / CONVERSATION</span><h2>${folderDesk?'Ask the collection':'Ask this document'}</h2></div>
    ${work.members.length>1?`<span class="avatars small" title="${work.members.map(u=>esc(u.name)).join(', ')}">${work.members.map(u=>`<span>${esc(initials(u.name))}</span>`).join('')}</span>`:''}
    <button class="dx-i" data-dx-pop="chat" aria-haspopup="true" aria-expanded="false" aria-label="Conversation options">${ms('more_horiz')}</button></div>
   <div class="message-region"><div class="messages" id="messages" role="log" aria-label="Chat messages" aria-live="polite"><div class="dx-welcome"><div class="dx-who"><span class="dx-label">CITELY</span></div><p>Ask anything about <b>${esc(desk.name)}</b>. Answers come only from your files, and each claim links to the ${n===1&&ad&&viewerKind(ad)==='pptx'?'slide':'passage'} it came from.</p></div>${work.messages.map(messageHTML).join('')}</div><button class="new-messages" id="new-messages" ${unreadMessages?'':'hidden'}>↓ New messages</button></div>
   <form id="chat-form" class="composer"><div class="dx-box"><textarea id="message-input" aria-label="Message Citely" ${lim?'disabled':''} placeholder="${lim?esc(limitText('questions')):connecting?'Connecting to the server… you can type, and send once it is ready':`Ask about ${folderDesk?'these files':'this document'}...`}" rows="1">${esc(draft)}</textarea><div class="dx-boxrow"><small>${ms('description',15)}${n} ${n===1?'source':'sources'}</small><button class="dx-send" aria-label="Send message" type="submit" ${lim||!draft.trim()?'disabled':''}>${ms('arrow_upward')}</button></div></div>
    <div class="prompt-suggestions">${demo?demo.prompts(docs.map(d=>d.id)).map(p=>`<button type="button" data-prompt="${esc(p.question)}">${esc(p.label)}</button>`).join(''):'<button type="button" data-prompt="Summarize the key takeaways.">Key takeaways</button><button type="button" data-prompt="What are the main risks?">Main risks</button>'+(n===1&&ad?`<button type="button" data-prompt="Explain ${pageWord(ad).toLowerCase()} ${currentPage}.">Explain this ${pageWord(ad).toLowerCase()}</button>`:'')}</div>
    ${usageInfo.limited?`<small class="usage-note${lim?' exhausted':''}" role="status">${esc(usageNote('questions'))}</small>`:''}</form>
   <div class="dx-resize" data-dx-resize="left" role="separator" aria-orientation="vertical" aria-label="Resize chat" aria-valuemin="280" aria-valuemax="560" aria-valuenow="${dxW.left}" tabindex="0" title="Drag to resize. Double-click to reset."></div>
  </section>
  <section class="dx-col dx-doc document-pane" aria-label="Document">
   <div class="dx-dbar">
    <button class="dx-file" data-dx-pop="sources" aria-haspopup="true" aria-expanded="false" aria-label="Sources">${ad?`<span class="dx-ext" style="background:${kind[1]}">${esc(kind[0])}</span><span class="dx-fn">${esc(ad.name)}</span>`:'<span class="dx-fn">No source</span>'}${ms('expand_more',18)}</button>
    <div class="page-control dx-pager"><button class="dx-i" data-page="-1" aria-label="Previous ${ad?pageWord(ad).toLowerCase():'page'}">${ms('chevron_left')}</button><span>${currentPage} <em>/ ${total}</em></span><button class="dx-i" data-page="1" aria-label="Next ${ad?pageWord(ad).toLowerCase():'page'}">${ms('chevron_right')}</button></div>
    <button class="dx-tg tools${highlightTool?' hl on':au().visible?' au on':''}" data-dx-pop="tools" aria-haspopup="true" aria-expanded="false" aria-label="Tools">${ms(highlightTool?'ink_highlighter':au().visible?'graphic_eq':'handyman',18)}<span class="dx-wide">${highlightTool?'Highlighter on':'Tools'}</span>${ms('expand_more',16)}</button>
    <span class="dx-vsep"></span>
    <button class="dx-i" data-dx-pop="view" aria-haspopup="true" aria-expanded="false" data-tip="View" aria-label="View options">${ms('tune')}</button>
   </div>
   <div class="dx-stage${highlightTool?' hlmode':''}${au().visible&&demo?' has-player':''}"><button class="dx-edge l" data-dx-panel="left" aria-label="Show chat" title="Show chat">${ms('chevron_right',16)}</button><button class="dx-edge r" data-dx-panel="right" aria-label="Show notes" title="Show notes">${ms('chevron_left',16)}</button>
    <div class="highlight-hint dx-hlnote" id="highlight-hint" role="status">${hint}</div>
    <div class="paper-viewport" id="paper-viewport">${paperHTML()}</div>${auPlayerHTML()}</div>
  </section>
  <aside class="dx-col dx-notes notes-pane" aria-label="Notes and highlights">
   <div class="dx-resize" data-dx-resize="right" role="separator" aria-orientation="vertical" aria-label="Resize notes" aria-valuemin="260" aria-valuemax="520" aria-valuenow="${dxW.right}" tabindex="0" title="Drag to resize. Double-click to reset."></div>
   <div class="dx-head"><div><span class="dx-label">03 / YOUR THINKING</span><h2>Notes &amp; highlights</h2></div></div>
   <div class="dx-tools"><button class="dx-tg hl${highlightTool?' on':''}" data-dx-hl aria-pressed="${highlightTool}">${ms('ink_highlighter',18)}Highlighter</button><button class="dx-tg keep" id="keep-citations" ${!cited||annotationBusy||!annotationsReady?'disabled':''}>${ms('bookmark_add',18)}${annotationBusy?'Saving…':'Keep citations'}</button></div>
   <div class="dx-tabs" role="tablist"><button role="tab" class="dx-tab${dxTab==='notes'?' on':''}" data-dx-tab="notes" aria-selected="${dxTab==='notes'}">Notes <sup>${savedNotes().length}</sup></button><button role="tab" class="dx-tab${dxTab==='hls'?' on':''}" data-dx-tab="hls" aria-selected="${dxTab==='hls'}">Highlights <sup>${savedAnnotations.length}</sup></button></div>
   <div class="dx-nbody"><div class="dx-npane" ${dxTab==='notes'?'':'hidden'}>${dxNotesHTML()}</div>
    <div class="dx-npane saved-highlights" ${dxTab==='hls'?'':'hidden'}><div id="highlight-list">${highlightsHTML()}</div></div></div>
   <footer class="dx-nfoot"><button class="dx-b" data-new-note>${ms('add',18)}New note</button></footer>
  </aside>
 </div>
 ${pop('account',260,`<div class="dx-acct"><span class="dx-avatar big">${esc(initials(me.name))}</span><span><b>${esc(me.name)}</b><small>${esc(me.email)}</small></span></div><span class="dx-label dx-pad">APPEARANCE</span><div class="dx-tri" role="group" aria-label="Appearance">${[['light','light_mode','Light'],['dark','dark_mode','Dark'],['system','computer','System']].map(([v,i,t])=>`<button data-theme-choice="${v}" aria-pressed="${theme===v}" class="${theme===v?'on':''}">${ms(i)}${t}</button>`).join('')}</div><hr>${mi('data-dx-howto','help','How it works')}${demo?'':mi('data-trusted','computer','Trusted browsers')}${leave}`)}
 ${pop('more',0,`${mi('data-collaborate','group_add','Collaborate','',soonTag)}${mi('data-share','ios_share','Share conversation','',soonTag)}${mi('data-share-notes','ios_share','Share notes','',soonTag)}<hr><span class="dx-label dx-pad">EXPORT</span>${mi('data-export-notes','article','Notes &amp; highlights','','.md')}${mi('data-export-csv','table_rows','Highlights','','.csv')}${mi('data-export-chat','forum','Conversation','','.md')}${mi('data-export-json','data_object','Full session','','.json')}<hr>${mi('data-delete-conversation','delete','Delete conversation','dx-danger')}<div class="dx-narrow-only"><hr>${mi('data-dx-theme-flip',dark?'light_mode':'dark_mode',dark?'Light mode':'Dark mode')}${leave}</div>`)}
 ${pop('chat',0,`${mi('data-dx-copy-chat','content_copy','Copy conversation')}${mi('data-dx-clear-chat','delete_sweep','Clear conversation','dx-danger')}`)}
 ${pop('sources',280,`<span class="dx-label dx-pad">SHOW</span><div class="source-filter">${`<button class="dx-mi${docFilter!=='cited'?' on':''}" role="menuitem" data-source-filter="all">${ms('folder',18)}<span>All files</span><span class="dx-k"></span></button><button class="dx-mi${docFilter==='cited'?' on':''}" role="menuitem" data-source-filter="cited" ${!cited?'disabled':''}>${ms('format_quote',18)}<span>Cited in this chat</span><span class="dx-k"></span></button>`}</div><hr><span class="dx-label dx-pad">SOURCES · ${n}</span><div class="source-tabs dx-sources">${sourceTabs()}</div>`)}
 ${pop('view',240,`<span class="dx-label dx-pad">ZOOM</span><div class="zoom-control dx-zrow"><button class="dx-i" data-zoom="-10" aria-label="Zoom out">${ms('remove')}</button><output>${zoom}%</output><button class="dx-i" data-zoom="10" aria-label="Zoom in">${ms('add')}</button><button class="dx-i" id="zoom-reset" aria-label="Reset zoom" data-tip="Reset">${ms('fit_screen')}</button></div><hr><span class="dx-label dx-pad">PAGE</span><button class="dx-mi${landscape?' on':''}" role="menuitem" data-layout="landscape">${ms('crop_landscape',18)}<span>Landscape</span><span class="dx-k"></span></button><button class="dx-mi${!landscape?' on':''}" role="menuitem" data-layout="portrait">${ms('crop_portrait',18)}<span>Portrait</span><span class="dx-k"></span></button><hr><span class="dx-label dx-pad">COLOUR KEY</span><div class="dx-key"><i class="citation-dot"></i>Opened citation (fades)</div><div class="dx-key dx-keyl"><i class="saved-dot"></i>Saved highlight</div>`)}
 ${pop('tools',250,`<span class="dx-label dx-pad">TOOLS</span><button class="dx-mi${highlightTool?' on':''}" role="menuitem" id="highlight-tool" aria-pressed="${highlightTool}">${ms('ink_highlighter',18)}<span>Highlighter</span><span class="dx-k"></span></button><button class="dx-mi${demo&&au().visible?' on':''}" role="menuitem" data-au-toggle>${ms('graphic_eq',18)}<span>Audio overview</span><span class="dx-k">${demo?'':soonTag}</span></button>`)}
 ${pop('history',240,'')}
 </div>`}
function dxHowto(){modal('Start with a source. Leave with an answer.',`<div class="dx-howto">${[['Ask.','Answers come only from the files in this conversation.'],['Check the citation.','Click a citation tag to open the passage. It flashes blue.'],['Keep what matters.','Highlight text, keep citations, or save an answer to a note.']].map(([b,t],i)=>`<div class="dx-hrow"><b>0${i+1}</b><span><b>${b}</b> ${t}</span></div>`).join('')}</div>`,'HOW IT WORKS')}
async function dxHistory(anchor){
 const p=document.getElementById('dx-pop-history');if(!p||!anchor)return noteHistory();if(dxPop==='history'){dxClosePop();return}
 p.innerHTML='<div class="dx-pmsg">Loading revisions…</div>';dxOpenPop('history',anchor);const epoch=deskEpoch;
 try{const versions=(await window.CitelyAPI.noteHistory(conversationId())).sort((a,b)=>b.revision-a.revision);if(epoch!==deskEpoch||dxPop!=='history')return;
  p.innerHTML=versions.length?'<span class="dx-label dx-pad">REVISIONS</span>'+versions.map(v=>`<button class="dx-mi" role="menuitem" data-note-revision="${v.revision}" title="${esc(new Date(v.created_at).toLocaleString())}${v.created_by?' · '+esc(v.created_by):''}">${ms('history',18)}<span>Revision ${v.revision}</span><span class="dx-k">${esc(new Date(v.created_at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}))}</span></button>`).join(''):'<div class="dx-pmsg">No revisions yet. Save to create one.</div>';
  p.querySelectorAll('[data-note-revision]').forEach(b=>b.onclick=()=>{dxClosePop();previewNoteRevision(versions.find(v=>v.revision===Number(b.dataset.noteRevision)))});
 }catch(e){if(epoch!==deskEpoch||dxPop!=='history')return;p.innerHTML=`<div class="dx-pmsg">${esc(e.message)} <button class="text-button" data-history-retry>Retry</button></div>`;p.querySelector('[data-history-retry]').onclick=()=>{dxClosePop();dxHistory(anchor)}}
 if(dxPop==='history')dxPlace(p,anchor);
}
function highlightsCsv(){const q=s=>'"'+String(s).replace(/"/g,'""')+'"';return 'document,location,text\n'+savedAnnotations.map(a=>[q(doc(a.document_id)?.name||'Document'),q(anchorLabel(a.anchor)||'Page '+a.page_number),q(a.quote)].join(',')).join('\n')}
function transcript(){return '# '+desk.name+'\n\n'+work.messages.map(m=>'## '+m.name+' · '+m.time+'\n'+m.text+'\n'+(m.citations||[]).map((c,i)=>'['+(i+1)+'] '+(doc(c.docId)?.name||'Source')+' · '+citeLong(c)).join('\n')).join('\n\n')}
function sessionJson(){return JSON.stringify({title:desk.name,work,annotations:savedAnnotations,sources:scopeDocs(),notice:'Original PDF bytes are not retained by the backend.'},null,2)}
function bindDx(){
 // A redraw (background data arriving) rebuilds the menus closed. Reopen the
 // one that was open, in place and without moving focus, so a menu never
 // vanishes under the pointer. History fills in on demand, so it just closes.
 const reopen=dxPop;
 dxPop=null;
 const go=(b,next)=>b.addEventListener('click',e=>{if(e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();if(leaveDesk()&&next!=='home'){view=next;render()}});
 $$('[data-dx-home]').forEach(a=>go(a,a.dataset.dxHome));
 $$('[data-dx-panel]').forEach(b=>b.onclick=()=>dxTogglePanel(b.dataset.dxPanel));
 $$('[data-dx-pop]').forEach(b=>b.onclick=e=>{e.stopPropagation();dxOpenPop(b.dataset.dxPop,b)});
 $$('[data-dx-tab]').forEach(b=>b.onclick=()=>{dxTab=b.dataset.dxTab;render()});
 $$('[data-dx-hl]').forEach(b=>b.onclick=()=>$('#highlight-tool').click());
 $$('[data-dx-howto]').forEach(b=>b.onclick=dxHowto);
 $$('[data-dx-copy-chat]').forEach(b=>b.onclick=()=>{dxClosePop();(navigator.clipboard?navigator.clipboard.writeText(dxChatText()):Promise.reject()).then(()=>toast('Conversation copied.'),()=>toast('Copy was blocked by the browser.'))});
 $$('[data-dx-clear-chat]').forEach(b=>b.onclick=()=>{dxClosePop();if(!work.messages.length){toast('The conversation is already empty.');return}if(!confirm('Clear every message in this conversation? Notes and highlights stay. Save to make it permanent.'))return;work.messages=[];tempCitations=[];activeMessageId=null;activeCitationId=null;docFilter='all';chatScroll=null;markDirty();render();toast('Conversation cleared. Save to keep this change.')});
 $$('[data-copy-answer]').forEach(b=>b.onclick=()=>{const m=work.messages[Number(b.dataset.copyAnswer)];(navigator.clipboard?navigator.clipboard.writeText(plainAnswer(m)):Promise.reject()).then(()=>toast('Answer copied.'),()=>toast('Copy was blocked by the browser.'))});
 $$('[data-dx-theme-flip]').forEach(b=>b.onclick=()=>setThemeChoice(dark?'light':'dark'));
 $$('[data-theme-choice]').forEach(b=>b.onclick=()=>setThemeChoice(b.dataset.themeChoice));
 $$('[data-export-notes]').forEach(b=>b.onclick=()=>{download('citely-notes.md',notesText(),'text/markdown');toast('Notes exported.')});
 $$('[data-export-csv]').forEach(b=>b.onclick=()=>{download('citely-highlights.csv',highlightsCsv(),'text/csv');toast('Highlights exported.')});
 $$('[data-export-chat]').forEach(b=>b.onclick=()=>{download('citely-chat.md',transcript(),'text/markdown');toast('Conversation exported.')});
 $$('[data-export-json]').forEach(b=>b.onclick=()=>{download('citely-session.json',sessionJson(),'application/json');toast('Session exported.')});
 // Saved notes
 $$('[data-new-note]').forEach(b=>b.onclick=()=>{dxTab='notes';dxNote=null;dxComposing=true;dxShowNotes();render();setTimeout(()=>$('#dx-new-title')?.focus(),30)});
 $$('[data-cancel-note]').forEach(b=>b.onclick=()=>{dxComposing=false;render()});
 $$('[data-add-note]').forEach(b=>b.onclick=()=>{const t=$('#dx-new-title').value.trim(),body=$('#dx-new-body').value.trim();if(!t&&!body){$('#dx-new-title').focus();return}const ad=activeDoc();savedNotes().unshift({id:uid(),title:t||body.slice(0,48),body,at:Date.now(),cite:ad?{docId:ad.id,page:currentPage,label:pageWord(ad)+' '+currentPage}:null});dxComposing=false;markDirty();render();toast('Note added. Save to keep it.')});
 $$('[data-open-note]').forEach(b=>b.onclick=()=>{dxNote=b.dataset.openNote;render()});
 $$('[data-close-note]').forEach(b=>b.onclick=()=>{dxNote=null;render()});
 $$('[data-delete-note]').forEach(b=>b.onclick=()=>{work.saved=savedNotes().filter(x=>x.id!==b.dataset.deleteNote);dxNote=null;markDirty();render();toast('Note deleted. Save to keep this change.')});
 $$('[data-note-field]').forEach(f=>f.oninput=()=>{const note=savedNotes().find(x=>x.id===dxNote);if(note){note[f.dataset.noteField]=f.value;markDirty()}});
 $$('[data-note-cite]').forEach(b=>b.onclick=()=>{const c=savedNotes().find(x=>x.id===b.dataset.noteCite)?.cite;if(!c||!doc(c.docId)){toast('That source is no longer in this conversation.');return}activeDocId=c.docId;docFilter='all';setActiveView();currentPage=c.page;mobilePane='document';render()});
 $$('[data-note-answer]').forEach(b=>b.onclick=()=>{const i=Number(b.dataset.noteAnswer),m=work.messages[i],q=work.messages.slice(0,i).reverse().find(x=>x.role!=='assistant'),c=m.citations?.[0];savedNotes().unshift({id:uid(),title:(q?.text||'Saved answer').slice(0,80),body:plainAnswer(m),at:Date.now(),cite:c?{docId:c.docId,page:c.page,label:citeLong(c)}:null});dxTab='notes';dxNote=null;dxShowNotes();markDirty();render();toast('Saved to notes.')});
 const input=$('#message-input'),send=$('.dx-send'),fit=()=>{input.style.height='auto';input.style.height=Math.min(input.scrollHeight,140)+'px'};
 if(input){fit();input.addEventListener('input',()=>{fit();if(send&&!outOf('questions'))send.disabled=!input.value.trim()})}
 $('#notes-history')?.addEventListener('click',e=>{e.stopPropagation();dxHistory(e.currentTarget)});
 $$('.dx-pop button,.dx-pop a').forEach(b=>b.addEventListener('click',()=>{if(!b.matches('[data-zoom],[data-layout],[data-theme-choice],#zoom-reset,[data-source-filter],[data-history-retry]'))dxClosePop()}));
 $$('[data-au-toggle]').forEach(b=>b.onclick=()=>{dxClosePop();auToggle()});
 $$('[data-dx-pop="tools"],#dx-pop-tools button').forEach(b=>b.addEventListener('pointerdown',e=>e.preventDefault()));
 bindAudio();bindResize();
 dxSyncPanels();
 if(reopen&&reopen!=='history'){const anchor=$(`[data-dx-pop="${reopen}"]`);if(anchor)dxOpenPop(reopen,anchor,{keepFocus:true})}
}
document.addEventListener('click',e=>{if(dxPop&&!e.target.closest('.dx-pop')&&!e.target.closest('[data-dx-pop]')&&!e.target.closest('#notes-history'))dxClosePop()});
document.addEventListener('keydown',e=>{if(!deskId)return;
 if(e.key==='Escape'&&!$('#modal')?.open){if(dxPop){const was=dxPop;dxClosePop();(was==='history'?$('#notes-history'):$(`[data-dx-pop="${was}"]`))?.focus()}else if(dxDrawer){dxDrawer=null;dxSyncPanels()}}
 if((e.ctrlKey||e.metaKey)&&(e.key==='['||e.key===']')){e.preventDefault();dxTogglePanel(e.key==='['?'left':'right')}});
addEventListener('resize',()=>{if(deskId)dxSyncPanels()});
// Answers are written in whatever shape the question asked for: paragraphs,
// headings, bullet lists of any kind (nested too), numbered or lettered lists,
// tables. The text is HTML-escaped BEFORE this runs and only these shapes are
// rebuilt, so nothing a model or a document says can add markup. Citation
// chips are carried through as tokens so a "|" or a line break inside one
// can never split a table cell or a list item.
function mdInline(t){return t.replace(/&lt;br\s*\/?\s*&gt;/gi,'<br>').replace(/\*\*([^*\n]+?)\*\*/g,'<strong>$1</strong>').replace(/(^|[\s(])\*(?!\s)([^*\n]+?)(?<!\s)\*(?=[\s).,;:!?]|$)/g,'$1<em>$2</em>')}
function mdTable(rows){
 const cells=r=>r.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
 if(rows.length<2||!/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(rows[1]))return null;
 const head=cells(rows[0]),body=rows.slice(2).map(cells);
 return `<div class="md-table"><table><thead><tr>${head.map(c=>`<th>${mdInline(c)}</th>`).join('')}</tr></thead><tbody>${body.map(r=>`<tr>${head.map((_,i)=>`<td>${mdInline(r[i]??'')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`}
const MD_BULLET=/^([-*+•●▪◦‣–])\s+/,MD_NUMBER=/^(\d+)[.)]\s+/,MD_LETTER=/^([a-z]|[ivx]+)[.)]\s+/i;
function mdItemKind(t){return MD_BULLET.test(t)?'ul':MD_NUMBER.test(t)?'ol':MD_LETTER.test(t)?'ol-a':''}
// One list from consecutive item lines; deeper-indented items nest under the one before.
function mdList(items){
 const build=(start,depth)=>{const first=items[start],kind=first.kind,tag=kind==='ul'?'ul':'ol';
  const attrs=kind==='ol'?((n=>n>1?` start="${n}"`:'')(parseInt(first.text,10))):kind==='ol-a'?` type="${/^[ivx]+[.)]/i.test(first.text)&&!/^[a-h][.)]/i.test(first.text)?'i':'a'}"`:'';
  let html=`<${tag}${attrs}>`,i=start;
  while(i<items.length&&items[i].depth>=depth){
   if(items[i].depth>depth){const [inner,next]=build(i,items[i].depth);html=html.replace(/<\/li>$/,inner+'</li>');i=next;continue}
   if(items[i].kind!==kind&&i>start)break;
   html+=`<li>${mdInline(items[i].text.replace(MD_BULLET,'').replace(MD_NUMBER,'').replace(MD_LETTER,''))}</li>`;i++}
  return [html+`</${tag}>`,i]};
 let out='',i=0;while(i<items.length){const [html,next]=build(i,items[i].depth);out+=html;i=next}return out}
function mdBlocks(text){
 const out=[];let kind='',buf=[];
 const flush=()=>{if(!buf.length)return;
  if(kind==='list')out.push(mdList(buf));
  else{const table=kind==='table'?mdTable(buf):null;out.push(table||`<p>${buf.map(mdInline).join('<br>')}</p>`)}
  buf=[];kind=''};
 for(const raw of text.split('\n')){const t=raw.trim();if(!t){if(kind!=='list')flush();continue}
  const heading=t.match(/^(#{1,4})\s+(.+)$/);
  if(heading){flush();out.push(`<h4 class="md-h">${mdInline(heading[2].replace(/\s*#+$/,''))}</h4>`);continue}
  if(/^(\*{3,}|-{3,}|_{3,})$/.test(t)){flush();continue}
  const item=mdItemKind(t),k=item?'list':/^\|.*\|$/.test(t)?'table':'p';
  if(k!==kind){flush();kind=k}
  buf.push(k==='list'?{kind:item,text:t,depth:Math.floor((raw.match(/^\s*/)[0].replace(/\t/g,'    ').length)/2)}:t)}
 flush();return out.join('')}
function messageHTML(m,i){
 if(m.role!=='assistant'){const own=m.name===directory[0].name;return `<article class="message ${own?'own':'peer'}" title="${esc(m.name)} · ${esc(m.time)}">${own?'':`<div class="message-meta"><strong>${esc(m.name)}</strong><time>${esc(m.time)}</time></div>`}<div class="message-body">${esc(m.text).replace(/\n/g,'<br>')}</div></article>`}
 const cs=m.citations||[],used=new Set();
 const chip=c=>{const name=doc(c.docId)?.name||'Source',number=cs.indexOf(c)+1,label=esc(name)+' · '+esc(citeLong(c));return `<span class="dx-evidence"><button class="dx-cite" data-citation="${esc(c.citation_id)}" data-turn="${esc(m.id)}" aria-pressed="${activeMessageId===m.id&&activeCitationId===c.citation_id}" aria-label="Open source ${number}: ${label}" title="${label}">${number}</button><span class="dx-evidence-preview"><strong>${label}</strong><span>${esc(c.quote||'Open source for context.')}</span></span></span>`};
 const tokens=[],token=h=>{tokens.push(h);return '\u0001'+(tokens.length-1)+'\u0002'};
 // Deduplicate only within one citation group. Later claims must retain
 // their references, even when they draw on the same source sentence.
 const body=esc(m.text).replace(/\[\d+\](?:[ \t]*\[\d+\])*/g,group=>{
  const seen=new Set();return [...group.matchAll(/\[(\d+)\]/g)].map((match)=>{
   const c=cs[Number(match[1])-1];if(!c)return match[0];
   const key=c.citation_id||c;used.add(c);if(seen.has(key))return '';seen.add(key);return token(chip(c));
  }).join(' ');
 });
 const rest=cs.filter(c=>!used.has(c));
 let blocks=mdBlocks(body).replace(/\u0001(\d+)\u0002/g,(_,n)=>tokens[Number(n)]);
 if(rest.length){const links=`<span class="citation-links">${rest.map(chip).join('')}</span>`;blocks+=used.size?`<details class="dx-answer-sources"><summary>More sources · ${rest.length}</summary>${links}</details>`:`<p class="citation-links-row">${links}</p>`;}
 const notes=[cs.some(c=>c.evidence_role==='legacy-context')?'Retrieved sources for this older answer; passage usage was not recorded.':'',...cs.filter(c=>citationUnavailable(c)).map(c=>`${citeLong(c)}: precise passage location unavailable.`)].filter(Boolean);
 return `<article class="message assistant"><div class="message-meta dx-who"><strong><img class="source-point-icon" src="${esc(window.CitelyAPI.asset('/branding/citely-04-app-tile.svg'))}" width="256" height="256" alt="" aria-hidden="true">CITELY</strong></div><div class="message-body">${blocks}</div>${notes.map(t=>`<small class="dx-cnote">${esc(t)}</small>`).join('')}<div class="dx-acts"><button class="dx-i" data-note-answer="${i}" data-tip="Save to note" aria-label="Save to note">${ms('note_add',17)}</button><button class="dx-i" data-copy-answer="${i}" data-tip="Copy" aria-label="Copy answer">${ms('content_copy',17)}</button></div></article>`}

// "Regions A3:F3" or "Slide 4" reads better than a page number.
function anchorLabel(a){return a?.format==='xlsx'?esc(a.sheet_name+' '+a.range):a?.format==='pptx'?'Slide '+(a.slide_index+1):''}
function sourceTabs(){let ds=[...new Map([...scopeDocs(),...tempCitations.map(c=>doc(c.docId)).filter(Boolean)].map(d=>[d.id,d])).values()];if(docFilter==='cited'&&tempCitations.length)ds=ds.filter(d=>tempCitations.some(c=>c.docId===d.id));return ds.map(d=>{const k=kindOf(d.name),on=activeDocId===d.id;return `<button class="dx-mi${on?' on active':''}" role="menuitem" data-source="${d.id}"><span class="dx-ext" style="background:${k[1]}">${esc(k[0])}</span><span>${esc(d.name)}</span><span class="dx-k">${tempCitations.some(c=>c.docId===d.id)?'<i class="dx-citedot" title="Cited in this chat"></i>':''}</span></button>`}).join('')}
// Which viewer a file's original would open in, if that viewer is enabled.
function viewerFor(d){
 const v=window.CitelyAPI.viewers||{},name=d?.name||'';
 return v.docx&&/\.docx$/i.test(name)?'docx':v.pdf&&/\.pdf$/i.test(name)?'pdf':v.xlsx&&/\.xlsx$/i.test(name)?'xlsx':v.pptx&&/\.pptx$/i.test(name)?'pptx':null;
}
function viewerKind(d){
 if(!d||viewerFailed.has(d.id)||!originalInfo.get(d.id)?.has)return null;
 return viewerFor(d);
}
const viewerModule=id=>viewerModules[viewerKinds.get(id)];
// Spreadsheets and decks address their own units (cells, shapes) and scroll
// themselves; documents are text ranges inside the paper.
const pagedViewer=kind=>kind==='xlsx'||kind==='pptx';
function paperHTML(){
 const d=activeDoc();if(!d)return '<div class="empty"><h3>No source files yet.</h3><p>Add ready files to this folder to begin.</p></div>';
 if(connecting)return `<div class="empty connecting-doc" role="status"><h3>Connecting to the server…</h3><p>${esc(d.name)} will open here as soon as it is ready.</p></div>`;
 const kind=viewerKind(d);
 // Spreadsheets and decks scale themselves (CSS zoom would skew their geometry).
 if(kind)return `<div class="original-paper${kind==='xlsx'?' original-sheet':kind==='pptx'?' original-slides':''}${flashClass()}" id="paper"${flashAttrs().replace('style="',pagedViewer(kind)?'style="':`style="--zoom:${zoom/100};`)}><div class="original-host" data-original-host data-viewer-kind="${kind}" data-document-id="${esc(d.id)}">${viewerRoots.has(d.id)?'':'<p role="status" class="original-status">Opening the original document…</p>'}</div></div>`;
 const page=pageFor(d.id,currentPage);
 let text=page?`<p class="page-text" data-page-text data-document-id="${esc(d.id)}" data-page-number="${currentPage}"></p>`:`<p role="status">${pageLoading.has(d.id)?'Loading page text…':esc(pageErrors.get(d.id)||'Page text unavailable.')} ${pageLoading.has(d.id)?'':`<button class="text-button" data-retry-page="${esc(d.id)}">Retry</button>`}</p>`;
 return `<article class="paper ${landscape?'landscape':''} ${highlightTool?'highlight-enabled':''}${flashClass()}" id="paper"${flashAttrs().replace('style="',`style="--zoom:${zoom/100};`)}><header class="paper-brand"><strong>Citely</strong><span>${esc(d.name.replace('.pdf','').toUpperCase())}</span></header><div class="paper-kicker">${String(currentPage).padStart(2,'0')} / EXTRACTED DOCUMENT TEXT</div><h1>${esc(d.name)}</h1><div class="paper-rule"></div><h3>Extracted document text</h3>${text}<div class="paper-foot"><span>EXTRACTED SOURCE TEXT</span><b>${currentPage}</b></div></article>`;
}
function highlightsHTML(){if(!annotationsReady)return `<p role="status" class="dx-empty empty-highlights">${esc(annotationError||'Loading annotations…')}${annotationError?' <button class="text-button" id="retry-annotations">Retry</button>':''}</p>`;const many=scopeDocs().length>1;return savedAnnotations.length?savedAnnotations.map(a=>{const name=doc(a.document_id)?.name||'Document',where=anchorLabel(a.anchor)||'Page '+a.page_number;return `<div class="highlight-card"><div class="dx-hq"><q>${esc(a.quote)}</q>${annotationUnavailable(a)?'<em class="dx-cnote">Belongs to an older extraction or has no precise location.</em>':''}</div><div class="dx-hside"><button class="dx-pg" data-annotation="${esc(a.id)}" title="${esc(name)} · ${where}"><small>${many?esc(name.replace(/\.[a-z]+$/i,''))+' · ':''}${where}</small></button><button class="dx-i remove-highlight" data-delete-annotation="${esc(a.id)}" aria-label="Delete highlight from ${esc(name)}, page ${a.page_number}" ${annotationBusy?'disabled':''}>${ms('close',16)}</button></div></div>`}).join(''):'<div class="dx-empty empty-highlights"><b>A good passage is worth keeping.</b>Turn on the highlighter and select text, or open a citation and choose Keep citations.</div>'}

function markDirty(){editRevision++;dirty=true;const s=$('#save-state');if(s){s.classList.add('dirty');(s.querySelector('span')||s).textContent='Unsaved changes'}}
async function saveChanges(){
 if(busy)return;busy=true;const revision=editRevision,snapshot=chatSnapshot(),pending=[...dirtyAnn].map(id=>[id,{layout:annotations(id).layout,zoom:annotations(id).zoom}]);render();
 try{
  if(!notesReady)throw Error(noteError||'Wait for notes to finish loading.');
  if(work.notes!==noteBase.content){const saved=await window.CitelyAPI.saveNote(conversationId(),work.notes,noteBase.revision,currentSpace);noteBase=saved;}
  for(const [id,value] of pending){await writeRecord('view:'+id,value);if(annotations(id).layout===value.layout&&annotations(id).zoom===value.zoom)dirtyAnn.delete(id)}
  await writeRecord(workKey(),snapshot);chatBase=JSON.stringify(snapshot);dirty=editRevision!==revision||work.notes!==noteBase.content||dirtyAnn.size>0;notifyStatus(dirty?'Saved. Newer edits are still unsaved.':'All changes saved');
 }catch(e){dirty=true;if(e.status===409&&work.notes!==noteBase.content)await noteConflict();else notifyStatus(e.message)}finally{busy=false;render()}
}


function bindCommon(){if(window.CitelyAPI.demo)$$('a.brand').forEach(a=>a.target='_top');$$('[data-logout]').forEach(b=>b.onclick=()=>window.CitelyAPI.logout());$$('[data-demo-reset]').forEach(b=>b.onclick=()=>window.CitelyAPI.demo?.reset());$$('[data-trusted]').forEach(b=>b.onclick=()=>{if(menu){menu=null;render()}if(typeof dxClosePop==='function')dxClosePop();trustedBrowsersModal()});$$('button[data-mode]').forEach(b=>b.onclick=()=>setThemeChoice(dark?'light':'dark'));$$('[data-view]').forEach(b=>b.onclick=()=>{view=b.dataset.view;menu=null;render()});$$('[data-open]').forEach(b=>b.onclick=()=>openDesk(b.dataset.open));$$('[data-tour]').forEach(b=>b.onclick=()=>{if(menu){menu=null;render()}tourModal(0)});$$('[data-workspaces]').forEach(b=>b.onclick=workspacePicker);$$('[data-upload]').forEach(b=>b.onclick=uploadModal)}
// Opening a menu item that leads to a dialog closes the menu first.
const fromMenu=fn=>()=>{if(menu){menu=null;render()}fn()};
function bindLibrary(){$$('[data-history]').forEach(b=>b.onclick=()=>travelLibrary(Number(b.dataset.history)));$$('[data-manage]').forEach(b=>b.onclick=fromMenu(manageWorkspace));$$('[data-toggle-side]').forEach(b=>b.onclick=toggleSide);$$('[data-menu]').forEach(b=>b.onclick=()=>{menu=menu===b.dataset.menu?null:b.dataset.menu;render()});$$('[data-close-menus]').forEach(b=>b.onclick=()=>{menu=null;render()});$$('[data-theme-choice]').forEach(b=>b.onclick=()=>setThemeChoice(b.dataset.themeChoice));$$('[data-switch]').forEach(b=>b.onclick=()=>{currentSpace=b.dataset.switch;folderId=null;filePlace='all';selection.clear();query='';menu=null;render()});$$('[data-newspace]').forEach(b=>b.onclick=fromMenu(()=>workspaceForm('create',b.dataset.newspace)));$$('[data-create-org]').forEach(b=>b.onclick=fromMenu(()=>workspaceForm('org')));$$('[data-rename]').forEach(b=>b.onclick=fromMenu(()=>workspaceForm('rename')));$$('[data-root-folder]').forEach(b=>b.onclick=()=>{view='home';folderId=null;filePlace='all';selection.clear();query='';render()});$$('[data-recent]').forEach(b=>b.onclick=()=>{view='home';folderId=null;filePlace='recent';selection.clear();query='';render()});$$('[data-new-folder],[data-group]').forEach(b=>b.onclick=()=>folderModal());$$('[data-folder]').forEach(b=>b.onclick=()=>{view='home';folderId=b.dataset.folder;filePlace='all';query='';selection.clear();render()});$$('[data-delete-folder]').forEach(b=>b.onclick=e=>{e.stopPropagation();confirmDeleteFolder(b.dataset.deleteFolder)});if(view!=='home'){return}const search=$('#file-search');search.oninput=e=>{query=e.target.value;selection.clear();render();$('#file-items').scrollTop=0};$$('[data-fileview]').forEach(b=>b.onclick=()=>{fileView=b.dataset.fileview;render()});const all=$('#select-all');if(all)all.onchange=e=>{selection=e.target.checked?new Set(placeDocs().map(d=>d.id)):new Set();render()};$$('[data-clear]').forEach(b=>b.onclick=()=>{selection.clear();render()});$$('[data-move]').forEach(b=>b.onclick=moveModal);$$('[data-bulk-delete]').forEach(b=>b.onclick=()=>confirmDeleteDocuments([...selection]));$$('[data-export-selected]').forEach(b=>b.onclick=()=>void exportSelected());bindFileItems();bindDrop()}
function bindFileItems(){$$('[data-select]').forEach(b=>b.onchange=()=>{b.checked?selection.add(b.dataset.select):selection.delete(b.dataset.select);render()});$$('[data-open]').forEach(b=>b.onclick=()=>openDesk(b.dataset.open));$$('[data-upload]').forEach(b=>b.onclick=uploadModal);$$('[data-retry]').forEach(b=>b.onclick=()=>retryUpload(b.dataset.retry));$$('[data-delete-doc]').forEach(b=>b.onclick=e=>{e.stopPropagation();confirmDeleteDocuments([b.dataset.deleteDoc])})}
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&menu&&!$('#modal')?.open){const was=menu;menu=null;render();$(`[data-menu="${was}"]`)?.focus()}});
// ---- In-page navigation -------------------------------------------------
// Home and conversations swap in place instead of reloading the page (which
// re-ran the whole boot sequence on every click). Leaving a conversation
// in-page is only allowed when nothing it started is still in flight; then no
// late response can land in another view. Otherwise it falls back to a full
// reload — exactly the old behaviour — so data integrity never depends on it.
let leavingConfirmed=false;
// Incremented whenever the conversation view is torn down. A read that
// resolves after its view is gone sees a different epoch and does nothing.
let deskEpoch=0;
const studioUrl=q=>window.CitelyAPI.asset('/studio.html')+q;
const deskUrl=id=>studioUrl('?desk='+encodeURIComponent(id)+'&space='+encodeURIComponent(currentSpace));
function deskIdle(){return window.CitelyAPI.inflightWrites()===0&&!busy&&!annotationBusy}
function resetDeskState(){
 deskEpoch++;
 savedAnnotations=[];annotationsReady=false;annotationError='';annotationBusy=false;
 noteBase={revision:0,content:''};notesReady=false;noteError='';activeCitationId=null;activeMessageId=null;
 statusMessage='';citationNavigation++;chatBase='';warnedCitations.clear();
 desk=null;work=null;annotationRecords={};activeDocId=null;currentPage=4;zoom=100;landscape=false;
 dirty=false;dirtyAnn=new Set();busy=false;mobilePane='document';highlightTool=false;tempCitations=[];
 docFilter='all';tabScroll=0;chatScroll=null;draft='';dxNote=null;dxComposing=false;auStopAll();
}
function closeModal(){const m=$('#modal');if(m?.open)m.close()}
async function enterDesk(id){
 closeModal();resetDeskState();deskId=id;
 // Still waking: show the conversation saved on this device; boot() loads the real one.
 if(connecting){if(lastSnapshotDesk?.id===id)showCachedDesk(lastSnapshotDesk);render();return}
 try{await loadDesk()}catch(e){if(deskId===id){notifyStatus(e.message);toast(e.message)}}
 // Render unless a newer navigation has taken over (deskId is null when the
 // item turned out to be gone and loadDesk fell back to Home).
 if(deskId===id||deskId===null)render();
}
/** Returns false if the user chose to stay. */
function leaveDesk(push=true){
 if(dirty&&!confirm('You have unsaved changes in this conversation. Leave without saving?'))return false;
 const url=studioUrl('?space='+encodeURIComponent(currentSpace));
 if(!deskIdle()){leavingConfirmed=true;location.assign(url);return true}
 if(push)history.pushState({space:currentSpace},'',url);
 closeModal();resetDeskState();deskId=null;view='home';render();return true;
}
window.addEventListener('popstate',()=>{
 const p=new URLSearchParams(location.search),target=p.get('desk');
 if(deskId&&target!==deskId){
  if(dirty&&!confirm('You have unsaved changes in this conversation. Leave without saving?')){history.pushState({desk:deskId,space:currentSpace},'',deskUrl(deskId));return}
  if(!deskIdle()){leavingConfirmed=true;location.reload();return}
  closeModal();resetDeskState();deskId=null;
 }
 currentSpace=p.get('space')||currentSpace;
 if(target&&target!==deskId)void enterDesk(target);else{view='home';render()}
});
async function openDesk(id){if(!id){toast('Upload a document first.');return}noteOpened(id);if(connecting&&!(lastSnapshotDesk&&lastSnapshotDesk.id===id&&lastSnapshotDesk.space===currentSpace)){holdForServer();return}const d=doc(id);if(d&&d.status!=='Ready'){toast('Wait until this document is ready.');return}const f=space().folders.find(f=>f.id===id);if(f&&!space().docs.some(d=>d.folder===id&&d.status==='Ready')){toast('Add a ready document to this folder first.');return}history.pushState({desk:id,space:currentSpace},'',deskUrl(id));void enterDesk(id)}
function bindDesk(){$('.desk-back-home')?.addEventListener('click',e=>{if(e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();leaveDesk()});const m=$('#messages');m.scrollTop=chatScroll===null?m.scrollHeight:chatScroll;m.onscroll=()=>{chatScroll=m.scrollTop;if(m.scrollHeight-m.scrollTop-m.clientHeight<60){unreadMessages=false;$('#new-messages').hidden=true}};$('#new-messages').onclick=()=>{m.scrollTop=m.scrollHeight};$('#chat-form').onsubmit=e=>{e.preventDefault();sendMessage()};$('#message-input').oninput=e=>draft=e.target.value;$('#message-input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();sendMessage()}};$$('[data-prompt]').forEach(b=>b.onclick=()=>{draft=b.dataset.prompt;sendMessage()});$('#notes-editor')?.addEventListener('input',e=>{work.notes=e.target.value;markDirty()});$('#retry-notes')?.addEventListener('click',loadNotes);$('#retry-annotations')?.addEventListener('click',loadAnnotations);$$('[data-retry-page]').forEach(b=>b.onclick=()=>loadPageText(b.dataset.retryPage));$('#save-changes').onclick=saveChanges;$$('[data-citation]').forEach(b=>b.onclick=()=>showCitation(b.dataset.turn,b.dataset.citation));$$('[data-source-filter]').forEach(b=>b.onclick=()=>{docFilter=b.dataset.sourceFilter;if(docFilter==='cited'&&!tempCitations.some(c=>c.docId===activeDocId)&&tempCitations.length){activeDocId=tempCitations[0].docId;setActiveView()}render()});$$('[data-source]').forEach(b=>b.onclick=()=>{activeDocId=b.dataset.source;currentPage=tempCitations.find(c=>c.docId===activeDocId)?.page||1;setActiveView();render()});$$('[data-zoom]').forEach(b=>b.onclick=()=>{zoom=Math.max(50,Math.min(180,zoom+Number(b.dataset.zoom)));updatePreviewSettings()});$('#zoom-reset').onclick=()=>{zoom=100;updatePreviewSettings()};$$('[data-layout]').forEach(b=>b.onclick=()=>{landscape=b.dataset.layout==='landscape';updatePreviewSettings()});$$('[data-page]').forEach(b=>b.onclick=()=>{currentPage=Math.max(1,Math.min(activeDoc()?.pages||1,currentPage+Number(b.dataset.page)));render()});$$('button[data-pane]').forEach(b=>b.onclick=()=>{mobilePane=b.dataset.pane;render()});$('#highlight-tool').onpointerdown=e=>e.preventDefault();$('#highlight-tool').onclick=()=>{highlightTool=!highlightTool;if(highlightTool)statusMessage='';if(highlightTool&&window.getSelection()?.toString()){$('#highlight-tool').classList.add('active');captureHighlight();return}render()};$('#keep-citations').onclick=keepCitations;$('#paper')?.addEventListener('pointerup',captureHighlight);$('#paper')?.addEventListener('keyup',e=>{if(e.key==='Shift')captureHighlight()});$$('[data-delete-annotation]').forEach(b=>b.onclick=()=>deleteHighlight(b.dataset.deleteAnnotation));$$('[data-annotation]').forEach(b=>b.onclick=()=>openAnnotation(b.dataset.annotation));$$('[data-share-notes]').forEach(b=>b.onclick=()=>shareModal('notes'));$$('[data-share]').forEach(b=>b.onclick=()=>shareModal('chat'));$$('[data-collaborate]').forEach(b=>b.onclick=collaborateModal);$$('[data-delete-conversation]').forEach(b=>b.onclick=()=>{dxClosePop();confirmDeleteConversation()});bindDx();}
async function sendMessage(){const text=draft.trim();if(!text||busy)return;if(connecting){holdForServer();return}if(outOf('questions')){notifyLimit('questions');return}busy=true;draft='';appendMessage({role:'user',name:directory[0].name,text,time:clock(),citations:[]});markDirty();const input=$('#message-input');input.value='';input.disabled=true;showThinking();try{const result=await window.CitelyAPI.ask(scopeDocs().filter(d=>d.status==='Ready').map(d=>d.id),text,{onDelta:showDraft,onReset:draftReset});hideThinking();const c=mapCitations(result.sources,desk.id);appendMessage({role:'assistant',name:'Citely',text:result.answer,time:clock(),citations:c});tempCitations=c;activeMessageId=work.messages.at(-1).id;activeCitationId=null;docFilter=c.length?'cited':'all';if(c.length){activeDocId=c[0].docId;currentPage=c[0].page;setActiveView()}markDirty();const revision=editRevision;const chat=chatSnapshot();await writeRecord(workKey(),chat);chatBase=JSON.stringify(chat);dirty=editRevision!==revision||dirtyAnn.size>0||work.notes!==noteBase.content;toast('Answer saved.');void refreshUsage();}catch(e){draft=text;if(e?.limit){await refreshUsage();notifyLimit(e.limit.startsWith('question')?'questions':'uploads',e.message)}else fail(e)}finally{hideThinking();busy=false;render()}}
// A Citely message that stays until the answer arrives, so a slow answer (the
// server may be waking, or checking the answer against the sources) never
// looks like nothing is happening. The wording moves on as time passes.
const THINKING=[[0,'Finding evidence in your sources…'],[7,'Reading the passages…'],[16,'Checking the answer against the sources…'],[40,'Still working. Long documents take a little longer…']];
let thinkingTimer=0;
function showThinking(){hideThinking();const region=$('#messages');if(!region)return;
 region.insertAdjacentHTML('beforeend',`<article class="message assistant message-thinking" id="thinking" role="status" aria-live="polite"><div class="message-meta dx-who"><strong><img class="source-point-icon" src="${esc(window.CitelyAPI.asset('/branding/citely-04-app-tile.svg'))}" width="256" height="256" alt="" aria-hidden="true">CITELY</strong></div><div class="message-body"><span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="thinking-text">${THINKING[0][1]}</span></div></article>`);
 region.scrollTop=region.scrollHeight;const t0=Date.now();
 thinkingTimer=setInterval(()=>{const el=$('#thinking .thinking-text');if(!el){hideThinking();return}const s=(Date.now()-t0)/1000;const line=[...THINKING].reverse().find(([from])=>s>=from)[1];if(el.textContent!==line)el.textContent=line},1000)}
function hideThinking(){clearInterval(thinkingTimer);thinkingTimer=0;$('#thinking')?.remove()}
// The answer as it is being written (checked, whole sentences, from the
// server's stream) shown in the same bubble. The final answer, with its
// citations, replaces it when it arrives.
// Where to scroll when an answer appears. One taller than the chat area starts at the TOP of the
// view, so the reader begins at its beginning (scrolling to the bottom left the first part, and
// the question, cut off above). One that fits follows the bottom, as before.
function followMessage(region,el){
 if(!region||!el)return;
 if(el.offsetHeight>region.clientHeight-24){region.scrollTop=Math.max(0,el.getBoundingClientRect().top-region.getBoundingClientRect().top+region.scrollTop-12);return}
 region.scrollTop=region.scrollHeight}
function showDraft(text){if(!$('#thinking'))showThinking();clearInterval(thinkingTimer);thinkingTimer=0;const box=$('#thinking'),body=box?.querySelector('.message-body');if(!body)return;
 const region=$('#messages'),atEnd=region&&region.scrollHeight-region.scrollTop-region.clientHeight<80;
 box.classList.add('message-drafting');box.setAttribute('aria-busy','true');
 body.innerHTML=`<div class="draft-text">${mdBlocks(esc(text))}</div><span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="sr-only">Citely is writing the answer.</span>`;
 if(atEnd)followMessage(region,box)}
function draftReset(){showThinking();const el=$('#thinking .thinking-text');if(el)el.textContent='Checking the answer against the sources…';clearInterval(thinkingTimer);thinkingTimer=0}
function appendMessage(m){m.id ||= uid();const region=$('#messages'),near=region.scrollHeight-region.scrollTop-region.clientHeight<100;work.messages.push(m);region.insertAdjacentHTML('beforeend',messageHTML(m,work.messages.length-1));if(near){followMessage(region,region.lastElementChild);chatScroll=region.scrollTop}else{unreadMessages=true;$('#new-messages').hidden=false}}
async function showCitation(turnId,citationId){
 const m=work.messages.find(m=>m.id===turnId),c=m?.citations.find(c=>c.citation_id===citationId);if(!c)return;
 const navigation=++citationNavigation;flashCitation();activeMessageId=m.id;activeCitationId=c.citation_id;tempCitations=m.citations;docFilter='cited';activeDocId=c.docId;currentPage=c.page;mobilePane='document';setActiveView();currentPage=c.page;statusMessage='';render();
 if(!pageCache.has(c.docId))await loadPageText(c.docId);
 if(navigation!==citationNavigation)return;
 // A spreadsheet or slide viewer places the citation by its cells or shape
 // (and says so itself if it can't); the text-offset check is for text views.
 const placedByAnchor=c.anchor?.format&&viewerKind(doc(c.docId))===c.anchor.format;
 if(!placedByAnchor&&!R.locatable(pageFor(c.docId,c.page),c)){warnCitation(c);notifyStatus('Precise passage location unavailable.');render();return}
 render();requestAnimationFrame(()=>{if(navigation!==citationNavigation)return;const target=document.getElementById('citation-'+encodeURIComponent(c.citation_id));scrollPaperTo(target,'center',matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth');target?.focus({preventScroll:true})});
}

function updatePreviewSettings(){if(!activeDoc())return;annotationRecords[activeDocId]={...annotations(activeDocId),layout:landscape?'landscape':'portrait',zoom};dirtyAnn.add(activeDocId);markDirty();render()}
async function addHighlight(value){if(savedAnnotations.some(a=>R.annotationKey(a)===R.annotationKey(value)))return false;const a=await window.CitelyAPI.createAnnotation(conversationId(),value);if(!savedAnnotations.some(x=>x.id===a.id))savedAnnotations.push(a);return true}

// The part of a citation's anchor an annotation stores; a slide citation must
// be narrowed to one shape or cell (it then has a quote) to be kept as one.
function keptAnchor(a){
 if(a?.format==='xlsx')return {format:'xlsx',sheet_name:a.sheet_name,sheet_index:a.sheet_index,range:a.range};
 if(a?.format==='pptx'&&a.quote)return {format:'pptx',slide_index:a.slide_index,shape_id:a.shape_id,row:a.row??null,col:a.col??null,quote:a.quote,...(Number.isInteger(a.offset)?{offset:a.offset}:{})};
 return null;
}
async function keepCitations(){
 if(annotationBusy||!annotationsReady)return;annotationBusy=true;render();let added=0,existing=0,skipped=0,failed=0;
 try{for(const original of tempCitations){const page=pageFor(original.docId,original.page),c=R.browserCitation(page,original);if(!R.locatable(page,c)){warnCitation(c);skipped++;continue}try{const made=await addHighlight({document_id:c.docId,workspace_id:currentSpace,kind:'citation',citation_id:c.citation_id,page_number:c.page,quote:page.text.slice(c.page_char_start,c.page_char_end),page_char_start:c.page_char_start,page_char_end:c.page_char_end,extraction_version:page.extraction_version,...(keptAnchor(c.anchor)?{anchor:keptAnchor(c.anchor)}:{})});made?added++:existing++}catch(e){failed++;annotationError=e.message}}
 notifyStatus(`${added} citations saved${existing?'; '+existing+' already saved':''}${skipped?'; '+skipped+' unavailable (no precise range)':''}${failed?'; '+failed+' failed: '+annotationError:''}.`);
 }finally{annotationBusy=false;render()}
}

async function captureHighlight(){
 if(!highlightTool||annotationBusy||!annotationsReady)return;const selection=window.getSelection();if(!selection||selection.isCollapsed||!selection.rangeCount)return;
 const range=selection.getRangeAt(0),node=range.startContainer.nodeType===1?range.startContainer:range.startContainer.parentElement,container=node.closest('[data-page-text]');
 const originalHost=node.closest('[data-original-host]');if(originalHost)return captureOriginalHighlight(originalHost.dataset.documentId,range,selection);
 if(!container||!$('#paper-viewport').contains(container)){notifyStatus('Select text within one page.');return}
 const offsets=R.rangeToPageOffsets(container,range),id=container.dataset.documentId,pageNumber=Number(container.dataset.pageNumber),page=pageFor(id,pageNumber);
 if(!page?.extraction_version){notifyStatus('This page has no stable extraction version. Reload the reader before highlighting.');return}
 if(!offsets||page.text.slice(offsets.start,offsets.end)!==offsets.quote){notifyStatus('Select a continuous range within one page. Cross-page selections cannot be saved.');return}
 annotationBusy=true;notifyStatus('Saving highlight…');
 try{await addHighlight({document_id:id,workspace_id:currentSpace,kind:'manual-highlight',page_number:pageNumber,quote:offsets.quote,page_char_start:offsets.start,page_char_end:offsets.end,extraction_version:page.extraction_version});selection.removeAllRanges();annotationBusy=false;notifyStatus('Highlight saved.');render()}catch(e){notifyStatus('Highlight not saved: '+e.message+' Select the passage again to retry.')}finally{annotationBusy=false;$$('[data-delete-annotation]').forEach(b=>b.disabled=false)}
}

function workspacePicker(){modal('Organizations & workspaces',`<p class="modal-description">A separate place for each kind of work.</p><div class="workspace-list">${catalog.orgs.map(o=>`<section><header><strong>${esc(o.name)}</strong><button class="text-button" data-newspace="${o.id}">+ Workspace</button></header>${o.spaces.map(w=>`<button class="workspace-option ${w.id===currentSpace?'chosen':''}" data-switch="${w.id}"><span>${ico('folder')}${esc(w.name)}</span><small>${w.docs.length} files ${w.id===currentSpace?'✓':''}</small></button>`).join('')}</section>`).join('')}</div><button class="button" id="create-org">+ Create organization</button><button class="button" id="account-signout">Sign out</button>`);$$('[data-switch]').forEach(b=>b.onclick=()=>{currentSpace=b.dataset.switch;folderId=null;selection.clear();query='';$('#modal').close();render()});$$('[data-newspace]').forEach(b=>b.onclick=()=>workspaceForm('create',b.dataset.newspace));$('#create-org').onclick=()=>workspaceForm('org');$('#account-signout').onclick=()=>window.CitelyAPI.logout()}
function workspaceForm(type,orgId=organization().id){const o=catalog.orgs.find(o=>o.id===orgId);modal(type==='rename'?'Rename workspace':type==='org'?'Create organization':'Create workspace',`<form id="name-form"><label class="field">${type==='org'?'Organization name':'Workspace name'}<input id="new-name" required maxlength="70" value="${type==='rename'?esc(space().name):''}" placeholder="${type==='org'?'Citely Labs':'Research, Product, or Personal'}"></label><p class="form-error" id="form-error"></p><button class="button primary">${type==='rename'?'Save name':'Create'}</button></form>`);$('#name-form').onsubmit=async e=>{e.preventDefault();if(e.target.dataset.busy)return;const name=$('#new-name').value.trim();if(!name)return;const duplicate=type==='org'?catalog.orgs.some(o=>o.name.toLowerCase()===name.toLowerCase()):o.spaces.some(w=>w.name.toLowerCase()===name.toLowerCase()&&(type!=='rename'||w.id!==currentSpace));if(duplicate){$('#form-error').textContent='That name is already used. Choose another.';return}const old=currentSpace;await catalogChange(e.target,{busyLabel:'Saving…',
  apply:()=>{if(type==='rename'){space().name=name;return {id:currentSpace}}const w={id:uid(),name:type==='org'?'Organization workspace':name,docs:[],folders:[]};if(type==='org')catalog.orgs.push({id:uid(),name,spaces:[w]});else o.spaces.push(w);currentSpace=w.id;folderId=null;selection.clear();return w},
  landed:(fresh,w)=>type==='rename'?spaceIn(fresh,w.id)?.name===name:!!spaceIn(fresh,w.id),
  done:()=>{$('#modal').close();render();toast('Workspace saved.')},
  showError:m=>{currentSpace=old;$('#form-error').textContent=m}})}}
function folderModal(){const count=selection.size;modal(count?'New folder with selection':'Create folder',`<form id="folder-form"><label class="field">Folder name<input id="folder-name" required maxlength="70" placeholder="e.g. Finance report"></label><p class="modal-description">${count?`${count} selected files will move into this folder.`:'Group related documents so you can ask questions across them.'}</p><p class="form-error" id="folder-error"></p><button class="button primary">Create folder</button></form>`);$('#folder-form').onsubmit=async e=>{e.preventDefault();if(e.target.dataset.busy)return;const name=$('#folder-name').value.trim();if(!name)return;if(space().folders.some(f=>f.name.toLowerCase()===name.toLowerCase())){$('#folder-error').textContent='A folder with that name already exists.';return}const spaceId=currentSpace;await catalogChange(e.target,{busyLabel:'Creating…',
  apply:()=>{const f={id:uid(),name};space().folders.push(f);space().docs.forEach(d=>{if(selection.has(d.id))d.folder=f.id});return f},
  landed:(fresh,f)=>!!spaceIn(fresh,spaceId)?.folders.some(x=>x.id===f.id),
  done:()=>{selection.clear();folderId=null;$('#modal').close();render();toast('Folder created.')},
  showError:m=>{$('#folder-error').textContent=m}})}}
function moveModal(){modal('Move selected files',`<form id="move-form"><label class="field">Destination<select id="move-target"><option value="">All files (outside folders)</option>${space().folders.map(f=>`<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select></label><p>${selection.size} documents selected.</p><p class="form-error" id="move-error"></p><button class="button primary">Move files</button></form>`);$('#move-form').onsubmit=async e=>{e.preventDefault();if(e.target.dataset.busy)return;const spaceId=currentSpace,f=$('#move-target').value||null,ids=[...selection];await catalogChange(e.target,{busyLabel:'Moving…',
  apply:()=>{space().docs.forEach(d=>{if(selection.has(d.id))d.folder=f})},
  landed:fresh=>ids.every(id=>(spaceIn(fresh,spaceId)?.docs.find(d=>d.id===id)?.folder??null)===f),
  done:()=>{selection.clear();$('#modal').close();render();toast('Files moved.')},
  showError:m=>{$('#move-error').textContent=m}})}}
function confirmDeleteDocuments(ids){
 const docs=ids.map(id=>doc(id)).filter(Boolean);if(!docs.length)return;
 const list=docs.length>1?'<ul class="delete-list">'+docs.map(d=>`<li>${esc(d.name)}</li>`).join('')+'</ul>':'';
 modal(docs.length>1?`Delete ${docs.length} documents?`:`Delete "${esc(docs[0].name)}"?`,`<p class="modal-description">This permanently deletes ${docs.length>1?'these documents':'this document'}, ${docs.length>1?'their':'its'} extracted text, search index, saved highlights, and conversation history. This cannot be undone.</p>${list}<p class="form-error" id="delete-error"></p><div class="inline-actions"><button class="button" id="delete-cancel">Cancel</button><button class="button primary destructive" id="delete-confirm">${docs.length>1?'Delete documents':'Delete document'}</button></div>`);
 $('#delete-cancel').onclick=()=>$('#modal').close();
 $('#delete-confirm').onclick=()=>deleteDocumentsNow(ids);
}
async function deleteDocumentsNow(ids){
 const confirmButton=$('#delete-confirm'),cancelButton=$('#delete-cancel');
 confirmButton.disabled=true;cancelButton.disabled=true;confirmButton.textContent='Deleting…';
 const succeeded=[],failed=[];
 for(const id of ids){try{await window.CitelyAPI.deleteDocument(id);succeeded.push(id)}catch(e){failed.push([id,e.message])}}
 if(succeeded.length){
  for(const w of catalog.orgs.flatMap(o=>o.spaces))w.docs=w.docs.filter(d=>!succeeded.includes(d.id));
  for(const id of succeeded)selection.delete(id);
  try{await saveCatalog()}catch(e){failed.push(['catalog',e.message])}
 }
 if(failed.length&&!succeeded.length){confirmButton.disabled=false;cancelButton.disabled=false;confirmButton.textContent=ids.length>1?'Delete documents':'Delete document';$('#delete-error').textContent=failed.map(([id,msg])=>(doc(id)?.name||id)+': '+msg).join('; ');return}
 $('#modal').close();render();
 if(failed.length)toast(`${succeeded.length} deleted. ${failed.length} could not be deleted: `+failed.map(([id,msg])=>(doc(id)?.name||id)+' — '+msg).join('; '));
 else toast(succeeded.length>1?`${succeeded.length} documents deleted.`:'Document deleted.');
}
function uploadModal(){if(window.CitelyAPI.demo)return demoUploadModal();if(outOf('uploads')){notifyLimit('uploads');return}modal('Add documents',`<p class="modal-description">Upload your sources to index them for grounded answers.</p>${uploadMeter()}<label class="upload-picker">${ico('upload')}<strong>Choose documents</strong><input type="file" multiple accept=".pdf,.txt,.md,.csv,.json,.docx,.pptx,.xlsx,.png,.jpg,.jpeg,.webp" id="upload-input"></label>${window.CitelyAPI.samples?'<section class="sample-picker" id="sample-picker" aria-labelledby="sample-title"><h3 id="sample-title">No file to hand? Try a sample</h3><div id="sample-list" role="status">Loading samples…</div></section>':''}<p class="form-error" id="upload-error"></p>`);$('#upload-input').onchange=e=>addDocuments([...e.target.files]);if(window.CitelyAPI.samples)void loadSamples()}
// Samples the admin offers, grouped by type. Using one is an upload: it
// counts toward the upload limit and appears as a row like any file.
const SAMPLE_KINDS={PDF:'PDF',DOCX:'Word',PPTX:'PowerPoint',XLSX:'Excel'};
async function loadSamples(){const list=$('#sample-list');try{const groups=await window.CitelyAPI.samples();if(!$('#sample-list'))return;if(!groups.length){$('#sample-picker')?.remove();return}const have=new Set(space().docs.map(d=>d.name));list.removeAttribute('role');list.innerHTML=groups.map(g=>`<div class="sample-group"><span class="sample-kind">${esc(SAMPLE_KINDS[g.kind]||g.kind)}</span>${g.items.map(x=>`<button class="sample-choice" data-sample="${esc(x.id)}">${ico('file')}<span class="sample-name">${esc(x.name)}<small>${esc(x.filename)} · ${sizeText(x.bytes)}${have.has(x.filename)?' · already in this workspace':''}</small></span>${ico('plus')}</button>`).join('')}</div>`).join('');const all=groups.flatMap(g=>g.items);$$('[data-sample]').forEach(b=>b.onclick=()=>{const x=all.find(i=>i.id===b.dataset.sample);if(x)addDocuments([{sampleId:x.id,name:x.filename,size:x.bytes}])})}catch(e){if($('#sample-list'))list.textContent='Samples couldn’t load: '+e.message}}
function demoUploadModal(){
 const choices=window.CitelyAPI.demo.choices();
 modal('Add documents',`<p class="modal-description">Try the upload workflow with a prepared original file. Processing is simulated locally; no personal files are uploaded.</p><div class="demo-upload-list">${choices.map(d=>`<button class="button" data-sample-file="${esc(d.id)}">${ico('file')}<span>${esc(d.name)}</span>${ico('plus')}</button>`).join('')||'<p>All sample files are in your library. Delete one or reset the demo to try again.</p>'}</div><p id="upload-error" class="form-error" role="status"></p>`);
 $$('[data-sample-file]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{const file=await window.CitelyAPI.demo.file(b.dataset.sampleFile);await addDocuments([file])}catch(e){$('#upload-error').textContent=e.message;b.disabled=false}});
}
function notifyLimit(kind,message){const text=message||limitText(kind);toast(text);statusMessage=text;const hint=$('#highlight-hint');if(hint)hint.textContent=text}
async function addDocuments(files){const left=allowance('uploads');if(left){if(left.remaining<=0){notifyLimit('uploads');return}if(files.length>left.remaining){toast(`You can upload ${left.remaining} more ${left.remaining===1?'document':'documents'} in this demo, so only the first ${left.remaining===1?'one':left.remaining} will be added.`);files=[...files].slice(0,left.remaining)}}const target=space(),folder=folderId;$('#modal').close();for(const file of files){const d={id:uid(),name:file.name,size:sizeText(file.size),pages:0,kind:'document',folder,status:'Queued',added:'Just now'};target.docs.push(d);window.CitelyAPI.pendingFiles.set(d.id,file);patchUploadRow(d,target.id);void processUpload(d,file,target.id);}}
async function bundleFor(w){const records={};const ids=[...w.docs.map(d=>d.id),...w.folders.map(f=>f.id)];await Promise.all(ids.map(async id=>{const v=await readRecord('chat:'+w.id+':'+id);if(v){const note=await window.CitelyAPI.note(w.id+':'+id);records['chat:'+id]={...v,notes:note.content,annotations:await window.CitelyAPI.annotations(w.id+':'+id)}}}));await Promise.all(w.docs.map(async d=>{const v=await readRecord('annotation:'+d.id);if(v)records['annotation:'+d.id]=v}));return {format:'citely-workspace-v1',exportedAt:new Date().toISOString(),workspace:clone(w),records,notice:'Contains document metadata, notes, conversations, and annotations. Original PDF bytes are not included.'}}
function download(name,text,type='text/plain'){const u=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}
function manageWorkspace(){modal('Copy or export workspace',`<p class="modal-description">Keep your folder structure, conversations, notes, and saved highlights. Exports remain private until you share them.</p><div class="action-menu"><button id="copy-workspace">${ico('copy')}Copy to another workspace</button><button id="export-workspace">${ico('download')}Download workspace bundle (.json)</button><label class="import-action">${ico('upload')}Import a workspace bundle<input type="file" id="import-workspace" accept="application/json,.json"></label></div><p class="fine-print">The bundle contains document metadata, not original PDF files. Team membership and sharing access are not copied.</p><p id="bundle-status" class="modal-description" role="status"></p>`);$('#copy-workspace').onclick=()=>copyModal();$('#export-workspace').onclick=async()=>{const b=$('#export-workspace');b.disabled=true;$('#bundle-status').textContent='Preparing your workspace…';try{const bundle=await bundleFor(space());download('citely-workspace.json',JSON.stringify(bundle,null,2),'application/json');$('#bundle-status').textContent='Workspace exported.'}catch(e){$('#bundle-status').textContent=e.message}finally{b.disabled=false}};$('#import-workspace').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{if(f.size>5000000)throw Error('This bundle is too large. Maximum 5 MB.');const bundle=JSON.parse(await f.text());validateBundle(bundle);copyModal(bundle)}catch(e){$('#bundle-status').textContent=e.message}}}
function validateBundle(b){if(b?.format!=='citely-workspace-v1'||!b.workspace||!Array.isArray(b.workspace.docs)||!Array.isArray(b.workspace.folders)||b.workspace.docs.length>200||b.workspace.folders.length>100||typeof b.workspace.name!=='string'||typeof b.records!=='object')throw Error('This is not a supported Citely workspace bundle.');if(!b.workspace.docs.every(d=>typeof d.id==='string'&&typeof d.name==='string'&&Number.isInteger(d.pages)&&d.pages>0)||!b.workspace.folders.every(f=>typeof f.id==='string'&&typeof f.name==='string'))throw Error('The bundle contains invalid files or folders.');for(const [key,v] of Object.entries(b.records)){if(key.startsWith('chat:')&&(!Array.isArray(v.messages)||typeof v.notes!=='string'||!v.messages.every(m=>typeof m.text==='string'&&typeof m.name==='string'&&Array.isArray(m.citations))))throw Error('The bundle contains invalid conversations.');if(key.startsWith('annotation:')&&(!Array.isArray(v.marks)||!v.marks.every(m=>typeof m.quote==='string'&&typeof m.passage==='string'&&Number.isInteger(m.page))))throw Error('The bundle contains invalid annotations.')}}
function copyModal(imported=null){modal(imported?'Import workspace':'Copy workspace',`<form id="copy-form"><label class="field">Destination<select id="copy-destination"><option value="new">Create a new workspace</option>${allSpaces().filter(w=>w.id!==currentSpace||imported).map(w=>`<option value="${w.id}">${esc(w.orgName)} / ${esc(w.name)}</option>`).join('')}</select></label><label class="field" id="copy-name-field">New workspace name<input id="copy-name" maxlength="70" value="${esc((imported?.workspace.name||space().name)+' — copy')}"></label><p class="modal-description">${imported?'Import':'Copy'} files and folders with new identities. Source highlights remain shared across your workspaces.</p><p id="copy-status" role="status" class="form-error"></p><button class="button primary" id="copy-submit">${imported?'Import':'Copy'} workspace</button></form>`);$('#copy-destination').onchange=e=>$('#copy-name-field').hidden=e.target.value!=='new';$('#copy-form').onsubmit=async e=>{e.preventDefault();const target=$('#copy-destination').value,name=$('#copy-name').value.trim();if(target==='new'&&!name)return;$('#copy-submit').disabled=true;$('#copy-status').textContent='Preparing the copy…';try{const bundle=imported||await bundleFor(space());validateBundle(bundle);const w=await copyBundle(bundle,target,name);$('#modal').close();currentSpace=w.id;folderId=null;selection.clear();query='';render();toast('Workspace copied. Source highlights remain shared.')}catch(e){$('#copy-status').textContent=e.message;$('#copy-submit').disabled=false}}}
async function copyBundle(bundle,target,name){const before=clone(catalog);const fresh=await readRecord('catalog');if(fresh)catalog=fresh;let destination=target==='new'?{id:uid(),name,docs:[],folders:[]}:allSpaces().find(w=>w.id===target);if(!destination)throw Error('The destination workspace no longer exists.');if(target==='new'){if(organization().spaces.some(w=>w.name.toLowerCase()===name.toLowerCase()))throw Error('A workspace with that name already exists.');organization().spaces.push(destination)}else destination=catalog.orgs.flatMap(o=>o.spaces).find(w=>w.id===target);const owned=new Set((await window.CitelyAPI.documents()).map(d=>d.id));if(bundle.workspace.docs.some(d=>!owned.has(d.id)))throw Error('Upload the original documents to this account before importing their workspace.');const map=new Map([...bundle.workspace.docs.map(x=>[x.id,x.id]),...bundle.workspace.folders.map(x=>[x.id,uid()])]);const newFolders=bundle.workspace.folders.map(f=>({...clone(f),id:map.get(f.id),name:destination.folders.some(a=>a.name===f.name)?f.name+' — copy':f.name}));const newDocs=bundle.workspace.docs.map(d=>({...clone(d),id:map.get(d.id),folder:map.get(d.folder)||null}));try{for(const [key,v] of Object.entries(bundle.records)){const id=key.slice(key.indexOf(':')+1),newId=map.get(id);if(!newId)continue;const value=clone(v);if(key.startsWith('chat:')){value.members=[directory[0]];value.invites=[];value.access='private';value.messages.forEach(m=>{m.citations=(m.citations||[]).map(c=>({...c,docId:map.get(c.docId)})).filter(c=>c.docId)});await writeRecord('chat:'+destination.id+':'+newId,value)}else if(key.startsWith('annotation:')){if(await readRecord('annotation:'+newId))continue;value.marks.forEach(m=>m.id=uid());await writeRecord('annotation:'+newId,value)}}destination.folders.push(...newFolders);destination.docs.push(...newDocs);await saveCatalog();return destination}catch(e){catalog=before;throw e}}
function confirmDeleteConversation(){
 const scope=desk.type==='folder'?'folder conversation':'document conversation',subject=esc(desk.name);
 const otherNote=desk.type==='file'?'':' Highlights kept in other conversations on the same documents are not affected.';
 modal('Delete this conversation?',`<p class="modal-description">This permanently deletes the chat messages, notes, and highlights kept in this ${scope} for <strong>${subject}</strong>.${otherNote} The source ${desk.type==='folder'?'documents remain':'document remains'} in your files. This cannot be undone.</p><p class="form-error" id="delete-conv-error"></p><div class="inline-actions"><button class="button" id="delete-conv-cancel">Cancel</button><button class="button primary destructive" id="delete-conv-confirm">Delete conversation</button></div>`);
 $('#delete-conv-cancel').onclick=()=>$('#modal').close();
 $('#delete-conv-confirm').onclick=deleteConversationNow;
}
async function deleteConversationNow(){
 const confirmButton=$('#delete-conv-confirm'),cancelButton=$('#delete-conv-cancel');
 confirmButton.disabled=true;cancelButton.disabled=true;confirmButton.textContent='Deleting…';
 try{
  await window.CitelyAPI.deleteConversation(currentSpace,desk.id,desk.type);
  dirty=false;
  location.assign(window.CitelyAPI.asset('/studio.html')+'?space='+encodeURIComponent(currentSpace));
 }catch(e){
  confirmButton.disabled=false;cancelButton.disabled=false;confirmButton.textContent='Delete conversation';
  $('#delete-conv-error').textContent=e.message;
 }
}
function collaborateModal(){comingSoon('collab')}
function exportChatModal(){modal('Export this working session',`<p class="modal-description">Take your conversation and notes with you.</p><div class="action-menu"><button id="export-transcript">${ico('chat')}Chat transcript (.md)</button><button id="export-notes">${ico('note')}Notes & highlights (.md)</button><button id="export-session">${ico('download')}Full session (.json)</button></div><p class="fine-print">Exports include unsaved edits. PDF bytes are not included.</p>`,'EXPORT');$('#export-transcript').onclick=()=>download('citely-chat.md',transcript());$('#export-notes').onclick=()=>download('citely-notes.md',notesText());$('#export-session').onclick=()=>download('citely-session.json',sessionJson(),'application/json')}
function notesText(){return '# '+desk.name+' — Notes\n\n## Working notes\n\n'+(work.notes||'_Empty_')+'\n\n## Saved notes\n'+(savedNotes().map(n=>'\n### '+n.title+'\n\n'+n.body+(n.cite?'\n\n_'+(doc(n.cite.docId)?.name||'Source')+' · '+n.cite.label+'_':'')).join('\n')||'\n_None_')+'\n\n## Saved passages\n'+scopeDocs().map(d=>[d.id,annotations(d.id)]).flatMap(([id,a])=>a.marks.map(m=>'\n> '+m.quote+'\n\n'+(doc(id)?.name||'Source')+' · page '+m.page)).join('\n')}
let sharingType='chat',sharingAccess='private';
function shareModal(type){comingSoon(type==='notes'?'notes':'share')}
// Browsers this account trusted to skip the emailed sign-in code, with
// "Sign out everywhere" (every device signed out, every trust forgotten).
async function trustedBrowsersModal(){
 const day=d=>new Date(d).toLocaleDateString([],{day:'numeric',month:'short',year:'numeric'});
 modal('Trusted browsers','<p role="status">Loading…</p>','ACCOUNT');
 let items;try{items=await window.CitelyAPI.trustedBrowsers()}catch(e){modal('Trusted browsers',`<p role="alert">${esc(e.message)}</p>`,'ACCOUNT');return}
 modal('Trusted browsers',`<p class="modal-description">These browsers skip the emailed sign-in code until the date shown.</p>${items.length?`<div class="trusted-list">${items.map(b=>`<div class="trusted-row"><span><strong>${esc(b.label||'Browser')}</strong><small>Trusted ${day(b.created_at)} · until ${day(b.expires_at)}${b.last_used_at?' · last used '+day(b.last_used_at):''}</small></span><button class="text-button" data-untrust="${esc(b.id)}">Remove</button></div>`).join('')}</div>`:'<p class="modal-description">No browser is trusted. You’ll get a code each time you sign in.</p>'}<div class="inline-actions"><button class="button primary destructive" id="signout-all">Sign out everywhere</button></div><p class="fine-print">Signs you out on every device, including this one, and forgets every trusted browser.</p>`,'ACCOUNT');
 $$('[data-untrust]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await window.CitelyAPI.removeTrustedBrowser(b.dataset.untrust);toast('Browser removed.');trustedBrowsersModal()}catch(e){b.disabled=false;toast(e.message)}});
 $('#signout-all').onclick=async()=>{if(!confirm('Sign out on every device and forget every trusted browser?'))return;$('#signout-all').disabled=true;try{await window.CitelyAPI.signOutEverywhere()}catch(e){$('#signout-all').disabled=false;toast(e.message)}};
}
function tourModal(step){const steps=[['Collect your sources','Select related documents and choose New folder with selection.'],['Ask across the collection','Open the folder’s chat workspace. Only cited files appear in the source strip.'],['Keep the good parts','Add an answer to notes, keep a highlighted passage, and save changes.']];modal('From files to understanding',`<div class="tour-slide"><span>0${step+1} / 03</span><h2>${steps[step][0]}</h2><p>${steps[step][1]}</p><div class="tour-progress">${steps.map((_,i)=>`<i class="${i===step?'active':''}"></i>`).join('')}</div></div><button class="button primary" id="tour-next">${step===2?'Explore your files':'Next step →'}</button><p class="fine-print">Collect sources, ask questions, and save the evidence.</p>`);$('#tour-next').onclick=()=>{if(step<2)tourModal(step+1);else{$('#modal').close();view='home';render()}}}
window.addEventListener('beforeunload',e=>{if(dirty&&!leavingConfirmed){e.preventDefault();e.returnValue=''}});
window.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'&&deskId&&!guest){e.preventDefault();saveChanges()}if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='a'&&!deskId&&view==='home'&&!['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)&&!$('#modal').open){e.preventDefault();selection=new Set(visibleDocs().map(d=>d.id));render()}});
function mapCitations(sources,fallback){return R.uniqueCitations(sources.map((c,i)=>({...c,evidence_role:c.evidence_role||'legacy-context',offset_unit:c.offset_unit||'codepoint',docId:c.document_id||c.docId||fallback,page:Number(c.page)||Number(c.page_number)||1,citation_id:c.citation_id||'legacy-'+(c.document_id||c.docId||fallback)+'-'+(c.page||1)+'-'+(c.chunk_id??i)})));}

async function syncDocuments(pending){const documents=await (pending||window.CitelyAPI.documents()),owned=new Map(documents.map(d=>[d.id,d])),seen=new Set();for(const d of documents)originalInfo.set(d.id,{has:!!d.has_original,compatible:d.original_compatible!==false});for(const w of catalog.orgs.flatMap(o=>o.spaces)){w.docs=w.docs.filter(d=>owned.has(d.id)||d.jobId);for(const d of w.docs){const real=owned.get(d.id);if(!real)continue;Object.assign(d,{name:real.filename,pages:real.pages||1,status:'Ready'});seen.add(d.id)}}const target=space();for(const d of documents){if(!seen.has(d.id))target.docs.push({id:d.id,name:d.filename,pages:d.pages||1,size:'—',kind:'document',status:'Ready',folder:null,added:new Date(d.ingested_at).toLocaleDateString()});}await saveCatalog();}
const uploadControllers=new Map();let uploadSpace=null,uploadsStopped=false;
function stopUploadChecks(){uploadsStopped=true;for(const c of uploadControllers.values())c.abort();uploadControllers.clear()}
window.addEventListener('pagehide',stopUploadChecks);window.addEventListener('rag:signed-out',stopUploadChecks);
function syncUploadScope(){
 if(uploadSpace===currentSpace||uploadsStopped)return;
 for(const c of uploadControllers.values())c.abort();uploadControllers.clear();uploadSpace=currentSpace;
 queueMicrotask(()=>{if(uploadsStopped)return;for(const d of space().docs){if(d.jobId&&['Queued','Processing'].includes(d.status)&&!d.uploadError)void processUpload(d,null,currentSpace)}});
}
function patchUploadRow(d,spaceId,previousId=d.id){
 if(previousId!==d.id&&selection.delete(previousId))selection.add(d.id);
 if(previousId!==d.id&&thumbs.has(previousId)){thumbs.set(d.id,thumbs.get(previousId));thumbs.delete(previousId)}
 if(uploadsStopped||currentSpace!==spaceId||deskId||view!=='home')return;
 render();
 let live=$('#upload-status-live');if(!live){live=document.createElement('span');live.id='upload-status-live';live.setAttribute('role','status');live.setAttribute('aria-live','polite');live.className='upload-announcement';document.body.append(live);}
 live.textContent=d.name+': '+(d.uploadError||d.uploadNote||d.status);
}
async function processUpload(d,file,spaceId=currentSpace){
 if(uploadControllers.has(d.id)||uploadsStopped||spaceId!==currentSpace)return;
 const key=d.id,controller=new AbortController();uploadControllers.set(key,controller);d.uploadError='';
 const active=()=>!controller.signal.aborted&&!uploadsStopped&&currentSpace===spaceId;
 try{
  // The row's own id doubles as the upload's id, so a resend after a timeout
  // finds the job the server already has instead of ingesting twice.
  let job=d.jobId?{job_id:d.jobId,status:d.status==='Processing'?'running':'queued'}:await (file?.sampleId?window.CitelyAPI.startSample(file.sampleId,controller.signal,d.id,note=>{if(active()){d.uploadNote=note;patchUploadRow(d,spaceId)}}):window.CitelyAPI.startUpload(file,controller.signal,d.id,note=>{if(active()){d.uploadNote=note;patchUploadRow(d,spaceId)}}));
  delete d.uploadNote;
  if(!active())return;
  d.jobId=job.job_id;await saveCatalog();
  const result=await window.CitelyAPI.pollUpload(job,{signal:controller.signal,
   onStatus:job=>{if(!active())return;d.status=job.status==='queued'?'Queued':job.status==='failed'?'Failed':job.status==='succeeded'?'Ready':'Processing';patchUploadRow(d,spaceId);},
   onError:message=>{if(active()){d.uploadError=message;patchUploadRow(d,spaceId);}}});
  if(!active())return;
  window.CitelyAPI.pendingFiles.delete(key);Object.assign(d,{id:result.document_id,pages:result.pages,status:'Ready',uploadError:''});delete d.jobId;
  patchUploadRow(d,spaceId,key);await saveCatalog();void refreshUsage();if(viewerFor(d))void refreshOriginalInfo();if(active())toast('Document ready to chat.');
 }catch(e){void refreshUsage();if(active()){delete d.uploadNote;if(!d.jobId)d.status='Failed';d.uploadError=e.message;patchUploadRow(d,spaceId);try{await saveCatalog()}catch(saveError){d.uploadError+=' '+saveError.message;patchUploadRow(d,spaceId)}}}
 finally{if(uploadControllers.get(key)===controller)uploadControllers.delete(key);}
}
async function retryUpload(id){const d=doc(id),file=window.CitelyAPI.pendingFiles.get(id);if(!d)return;if(!d.jobId&&!file){uploadModal();return}if(d.status==='Failed')delete d.jobId;await processUpload(d,file)}
function conversationId(){return currentSpace+':'+desk.id}
function chatSnapshot(){const {notes,...chat}=work;return chat}
function paintPageText(){const container=$('[data-page-text]'),d=activeDoc(),page=d&&pageFor(d.id,currentPage);if(container&&page)R.paintRanges(container,page,tempCitations.filter(c=>c.docId===d.id&&c.page===currentPage&&(c.evidence_role==='cited'||c.citation_id===activeCitationId)),savedAnnotations.filter(a=>a.document_id===d.id&&a.page_number===currentPage),activeCitationId)}
function mountOriginal(){
 const shown=deskId&&activeDoc();
 if(shown&&viewerFor(shown)&&!originalInfo.has(shown.id)&&!originalInfoAsked.has(shown.id)){originalInfoAsked.add(shown.id);void refreshOriginalInfo()}
 const host=$('[data-original-host]');if(!host)return;
 const id=host.dataset.documentId,kind=host.dataset.viewerKind,root=viewerRoots.get(id);
 if(root){
  if(root.parentNode!==host){host.replaceChildren(root);viewerModule(id)?.attached?.(root)}
  if(pagedViewer(kind))viewerModule(id).setZoom(root,zoom/100);
  paintOriginal(id);scrollOriginalToPage(id,root);return;
 }
 if(viewerLoads.has(id))return;
 const epoch=deskEpoch;
 viewerLoads.set(id,(async()=>{
  try{
   const [mod,data]=await Promise.all([window.CitelyAPI.loadViewer(kind),window.CitelyAPI.originalFile(id)]);
   viewerModules[kind]=mod;viewerKinds.set(id,kind);
   const made=await mod.render(data);viewerRoots.set(id,made);
   if(pagedViewer(kind))bindPagedViewer(id,made);
   // Keep a few rendered originals for quick switching; drop the oldest.
   while(viewerRoots.size>3){const oldest=viewerRoots.keys().next().value;viewerModule(oldest)?.destroy?.(viewerRoots.get(oldest));viewerRoots.delete(oldest);viewerPage.delete(oldest);viewerRevealed.delete(oldest)}
  }catch(e){if(!e?.isCancelled){viewerFailed.add(id);if(epoch===deskEpoch)notifyStatus('The original could not be displayed, so the extracted text is shown.')}}
  finally{viewerLoads.delete(id);if(epoch===deskEpoch)render()}
 })());
}
// Paged viewers report page (sheet/slide) changes; the spreadsheet viewer
// also reports finished cell selections.
function bindPagedViewer(id,root){
 root.addEventListener('viewer-page',e=>{if(activeDoc()?.id!==id)return;currentPage=e.detail.index+1;viewerPage.set(id,currentPage);const label=$('.page-control span');if(label)label.textContent=`${currentPage} / ${activeDoc()?.pages||1}`});
 root.addEventListener('viewer-select',e=>{if(highlightTool&&e.detail)void captureCellHighlight(id,root,e.detail)});
}
// A cell or shape anchor counts only against the extraction it was made on.
function anchorTarget(id,item){
 const a=item.anchor;if(!a||a.format!==viewerKinds.get(id))return null;
 const page=pageFor(id,item.page??item.page_number);
 if(!page?.extraction_version||item.extraction_version!==page.extraction_version)return null;
 return {...a};
}
function paintPaged(id,root,mod){
 const targets=[],actives=[];let activeMissing=false;
 const add=(item,classes,active)=>{const t=anchorTarget(id,item);if(!t){if(active)activeMissing=true;return}targets.push({...t,classes,active});actives.push(active)};
 for(const c of tempCitations.filter(c=>c.docId===id&&(c.evidence_role==='cited'||c.citation_id===activeCitationId))){const active=c.citation_id===activeCitationId;add(c,active?['citation-range','current-citation']:['citation-range'],active)}
 for(const a of savedAnnotations.filter(a=>a.document_id===id)){const active=activeCitationId==='saved:'+a.id;add(a,active?['permanent-mark','current-citation']:['permanent-mark'],active)}
 const placed=mod.setTargets(root,targets);
 placed.forEach((ok,i)=>{if(!ok&&actives[i])activeMissing=true});
 // Bring the current citation into view once, not on every repaint, so the
 // reader's own scrolling is never undone.
 const active=targets.find((t,i)=>t.active&&placed[i]),key=activeCitationId+'|'+activeMessageId;
 if(active&&viewerRevealed.get(id)!==key){viewerRevealed.set(id,key);mod.reveal(root,active)}
 if(activeMissing)setHint(viewerKinds.get(id)==='pptx'?'This citation could not be placed on the slide, so it cannot be highlighted here.':'This citation has no cell location in this spreadsheet, so it cannot be highlighted here.');
}
async function captureSlideHighlight(id,range,selection){
 const root=viewerRoots.get(id),mod=viewerModule(id);if(!root||!mod)return;
 if(!originalInfo.get(id)?.compatible){notifyStatus('Highlights can only be saved in the extracted text for this document.');return}
 const {anchor,error}=mod.selectionAnchor(root,range);if(error){notifyStatus(error);return}
 const page=pageFor(id,anchor.slide_index+1);
 if(!page?.extraction_version){notifyStatus('This slide is still loading. Select the passage again in a moment.');return}
 annotationBusy=true;notifyStatus('Saving highlight…');
 try{await addHighlight({document_id:id,workspace_id:currentSpace,kind:'manual-highlight',page_number:anchor.slide_index+1,quote:anchor.quote,extraction_version:page.extraction_version,anchor});selection.removeAllRanges();annotationBusy=false;notifyStatus('Highlight saved.');render()}
 catch(e){notifyStatus('Highlight not saved: '+e.message+' Select the passage again to retry.')}
 finally{annotationBusy=false}
}
async function captureCellHighlight(id,root,anchor){
 if(annotationBusy){notifyStatus('Still saving the previous highlight. Select the cells again in a moment.');return}
 if(!annotationsReady)return;
 if(!originalInfo.get(id)?.compatible){notifyStatus('Highlights can only be saved in the extracted text for this document.');return}
 const page=pageFor(id,anchor.sheet_index+1);
 if(!page?.extraction_version){notifyStatus('This sheet is still loading. Select the cells again in a moment.');return}
 if(!anchor.quote){notifyStatus('Select cells that contain values to highlight them.');return}
 annotationBusy=true;notifyStatus('Saving highlight…');
 try{await addHighlight({document_id:id,workspace_id:currentSpace,kind:'manual-highlight',page_number:anchor.sheet_index+1,quote:anchor.quote.slice(0,20000),extraction_version:page.extraction_version,anchor:{format:'xlsx',sheet_name:anchor.sheet_name,sheet_index:anchor.sheet_index,range:anchor.range}});viewerModule(id)?.clearSelection(root,anchor.range);annotationBusy=false;notifyStatus('Highlight saved.');render()}
 catch(e){notifyStatus('Highlight not saved: '+e.message+' Select the cells again to retry.')}
 finally{annotationBusy=false}
}
function paintOriginal(id){
 const root=viewerRoots.get(id),mod=viewerModule(id);if(!root||!mod)return;
 if(pagedViewer(viewerKinds.get(id))){
  if(!originalInfo.get(id)?.compatible){mod.setTargets(root,[]);setHint('Highlights from the extracted text are not shown on this original because it differs from it.');return}
  return paintPaged(id,root,mod);
 }
 mod.clearMarks(root);mod.clearRegions?.(root);
 // An original attached despite not matching the stored extraction: its
 // offsets describe other text. Never move highlights onto it.
 if(!originalInfo.get(id)?.compatible){setHint('Highlights from the extracted text are not shown on this original because it differs from it.');return}
 const collected=mod.collectText(root),targets=[],regions=[];let activeMissing=false;
 const place=(item,classes,active)=>{
  // Text read from a picture or a scanned page has no text in the original to find:
  // it is shown as a marked region of its page.
  if(item.anchor?.evidence_region&&mod.paintRegions){if(active)regions.push({page:Number(item.anchor.page??item.page??item.page_number),box:item.anchor.box,classes:['pdf-region-citation','current-citation'],id:'citation-'+encodeURIComponent(activeCitationId)});return}
  const page=pageFor(id,item.page??item.page_number);if(!page)return;
  const c=R.browserCitation(page,item);
  if(!R.locatable(page,c)){if(active)activeMissing=true;return}
  const anchor=mod.anchorFromRaw(page.text,c.page_char_start,c.page_char_end),hit=anchor&&mod.locate(collected,anchor);
  if(hit?.status==='resolved')targets.push({start:hit.start,end:hit.end,classes,id:active?'citation-'+encodeURIComponent(activeCitationId):undefined});
  else if(active)activeMissing=true;
 };
 for(const c of tempCitations.filter(c=>c.docId===id&&(c.evidence_role==='cited'||c.citation_id===activeCitationId))){const active=c.citation_id===activeCitationId;place(c,active?['citation-range','current-citation']:['citation-range'],active)}
 for(const a of savedAnnotations.filter(a=>a.document_id===id)){const active=activeCitationId==='saved:'+a.id;place(a,active?['permanent-mark','current-citation']:['permanent-mark'],active)}
 mod.paintMarks(root,collected,targets);mod.paintRegions?.(root,regions);
 if(activeMissing)setHint('This passage could not be placed precisely in the original. It is highlighted in the extracted text.');
}
function setHint(message){statusMessage=message;const hint=$('#highlight-hint');if(hint)hint.textContent=message}
function scrollOriginalToPage(id,root){
 // Follows the page control only when the page actually changes.
 if(viewerPage.get(id)===currentPage)return;viewerPage.set(id,currentPage);
 const mod=viewerModule(id);
 if(viewerKinds.get(id)==='xlsx'){mod.showSheet(root,currentPage-1);return}
 if(viewerKinds.get(id)==='pptx'){mod.showSlide(root,currentPage-1);return}
 const pages=mod?.pages?.(root)||[];scrollPaperTo(pages[currentPage-1],'start');
}
async function captureOriginalHighlight(id,range,selection){
 // Spreadsheet highlights come from cell selection (viewer-select), not text;
 // a slide selection becomes a shape anchor.
 if(viewerKinds.get(id)==='xlsx')return;
 if(viewerKinds.get(id)==='pptx')return captureSlideHighlight(id,range,selection);
 const root=viewerRoots.get(id),mod=viewerModule(id);if(!root||!mod)return;
 if(!originalInfo.get(id)?.compatible){notifyStatus('Highlights can only be saved in the extracted text for this document.');return}
 const anchor=mod.selectionAnchor(root,mod.collectText(root),range);
 if(!anchor||anchor.quote.length<3){notifyStatus('Select a longer passage to highlight.');return}
 const pages=(pageCache.get(id)||[]).filter(p=>p.extraction_version);
 const spot=mod.locateOnPages(anchor,pages.map(p=>({page:p.page,text:p.text})));
 if(spot.status!=='resolved'){notifyStatus(spot.status==='ambiguous'?'That passage appears more than once. Select a longer passage so it can be saved precisely.':'That passage could not be matched to the document text, so it was not saved.');return}
 const page=pageFor(id,spot.page);
 annotationBusy=true;notifyStatus('Saving highlight…');
 try{await addHighlight({document_id:id,workspace_id:currentSpace,kind:'manual-highlight',page_number:spot.page,quote:page.text.slice(spot.start,spot.end),page_char_start:spot.start,page_char_end:spot.end,extraction_version:page.extraction_version});selection.removeAllRanges();annotationBusy=false;notifyStatus('Highlight saved.');render()}
 catch(e){notifyStatus('Highlight not saved: '+e.message+' Select the passage again to retry.')}
 finally{annotationBusy=false}
}
function pageFor(id,page){return pageCache.get(id)?.find(p=>p.page===page)}
function notifyStatus(message){statusMessage=message;toast(message);const hint=$('#highlight-hint');if(hint)hint.textContent=message}
function warnCitation(c){if(!window.CitelyAPI.development||warnedCitations.has(c.citation_id))return;warnedCitations.add(c.citation_id);console.warn('Unlocatable citation',{citation_id:c.citation_id,page_char_start:c.page_char_start,page_char_end:c.page_char_end})}
function citationUnavailable(c){const page=pageFor(c.docId,c.page);if(c.anchor?.format&&viewerKind(doc(c.docId))===c.anchor.format)return !!page&&page.extraction_version!==c.extraction_version;if(!page)return !Number.isInteger(c.page_char_start)||!Number.isInteger(c.page_char_end);const missing=!R.locatable(page,c);if(missing)warnCitation(c);return missing}
function annotationUnavailable(a){const page=pageFor(a.document_id,a.page_number);if(a.anchor)return !!page&&page.extraction_version!==a.extraction_version;return page&&!R.locatable(page,a)}
function loadPageText(id){
 if(pageRequests.has(id))return pageRequests.get(id);
 const pending=(async()=>{pageLoading.add(id);pageErrors.delete(id);render();
 try{await window.CitelyAPI.loadPages(id)}catch(e){pageErrors.set(id,e.message);notifyStatus('Page text could not be loaded. Retry in the reader.')}finally{pageLoading.delete(id);pageRequests.delete(id);render()}})();
 pageRequests.set(id,pending);return pending;
}
async function loadAnnotations(){
 const epoch=deskEpoch;annotationsReady=false;annotationError='';render();
 try{const list=await window.CitelyAPI.annotations(conversationId());if(epoch!==deskEpoch)return;savedAnnotations=list;annotationsReady=true}catch(e){if(epoch===deskEpoch)annotationError=e.message}finally{if(epoch===deskEpoch)render()}
}
async function loadNotes(){
 const epoch=deskEpoch;notesReady=false;noteError='';render();
 try{const latest=await window.CitelyAPI.note(conversationId());if(epoch!==deskEpoch)return;noteBase=latest;
 // Preserve legacy notes as a visible, unsaved draft until the user explicitly saves them.
 if(latest.revision||!work.notes)work.notes=latest.content;else dirty=true;
 notesReady=true;
 }catch(e){if(epoch===deskEpoch)noteError=e.message}finally{if(epoch===deskEpoch)render()}
}
async function deleteHighlight(id){
 if(annotationBusy)return;annotationBusy=true;render();
 try{await window.CitelyAPI.deleteAnnotation(id);savedAnnotations=savedAnnotations.filter(a=>a.id!==id);if(activeCitationId==='saved:'+id){activeCitationId=null;tempCitations=[]}notifyStatus('Highlight deleted.')}catch(e){notifyStatus('Highlight was not deleted: '+e.message)}finally{annotationBusy=false;render()}
}
async function openAnnotation(id){
 const a=savedAnnotations.find(a=>a.id===id);if(!a)return;
 flashCitation();activeDocId=a.document_id;currentPage=a.page_number;docFilter='all';mobilePane='document';activeMessageId=null;activeCitationId='saved:'+a.id;
 tempCitations=[{...a,docId:a.document_id,page:a.page_number,citation_id:activeCitationId}];setActiveView();currentPage=a.page_number;render();
 const epoch=deskEpoch;
 if(!pageCache.has(a.document_id))await loadPageText(a.document_id);
 if(epoch!==deskEpoch)return;
 if(annotationUnavailable(a)||(!a.anchor&&!R.locatable(pageFor(a.document_id,a.page_number),a))){notifyStatus('This highlight belongs to an older extraction or its precise passage location is unavailable.');render();return}
 render();requestAnimationFrame(()=>{const target=document.getElementById('citation-'+encodeURIComponent(activeCitationId));scrollPaperTo(target,'center');target?.focus({preventScroll:true})});
}
async function copyNote(text,selector){try{await navigator.clipboard.writeText(text);toast('Copied.')}catch{const el=$(selector);el.focus();el.select();toast('Select and copy this text.')}}
async function noteConflict(){
 let latest;const epoch=deskEpoch;
 try{latest=await window.CitelyAPI.note(conversationId());if(epoch!==deskEpoch)return}catch(e){if(epoch!==deskEpoch)return;modal('Notes conflict',`<p role="alert">Your unsaved text is preserved. The latest revision could not be loaded: ${esc(e.message)}</p><button class="button" id="retry-conflict">Retry</button>`);$('#retry-conflict').onclick=noteConflict;return}
 const local=work.notes;
 modal('Notes conflict',`<p role="alert">409 Conflict: a newer note revision was saved elsewhere. Your unsaved text is preserved.</p><label class="field">Your unsaved version<textarea id="conflict-local" readonly>${esc(local)}</textarea></label><button class="text-button" id="copy-local">Copy your version</button><label class="field">Latest saved version · revision ${latest.revision}<textarea id="conflict-server" readonly>${esc(latest.content)}</textarea></label><button class="text-button" id="copy-server">Copy saved version</button><div class="inline-actions"><button class="button" id="use-server">Reload latest saved version</button><button class="button primary" id="save-local-revision">Save my version as a new revision</button></div><p id="conflict-status" role="status"></p>`);
 $('#copy-local').onclick=()=>copyNote(local,'#conflict-local');$('#copy-server').onclick=()=>copyNote(latest.content,'#conflict-server');
 $('#use-server').onclick=()=>{noteBase=latest;work.notes=latest.content;dirty=dirtyAnn.size>0||JSON.stringify(chatSnapshot())!==chatBase;$('#modal').close();notifyStatus('Loaded saved revision '+latest.revision);render()};
 $('#save-local-revision').onclick=async()=>{const button=$('#save-local-revision');button.disabled=true;$('#conflict-status').textContent='Saving a new revision…';try{const saved=await window.CitelyAPI.saveNote(conversationId(),local,latest.revision,currentSpace);noteBase=saved;if(work.notes===local)work.notes=saved.content;dirty=work.notes!==noteBase.content||dirtyAnn.size>0||JSON.stringify(chatSnapshot())!==chatBase;$('#modal').close();notifyStatus('Saved revision '+saved.revision);render()}catch(e){if(e.status===409)await noteConflict();else{$('#conflict-status').textContent=e.message;button.disabled=false}}};
}
async function noteHistory(){
 const epoch=deskEpoch;modal('Note history','<p role="status">Loading note history…</p>');
 try{const versions=await window.CitelyAPI.noteHistory(conversationId());if(epoch!==deskEpoch)return;
 modal('Note history',`<p class="modal-description">Restoring appends a new revision. Earlier versions remain available.</p><div class="action-menu">${versions.sort((a,b)=>b.revision-a.revision).map(v=>`<button data-note-revision="${v.revision}">Revision ${v.revision} · ${esc(new Date(v.created_at).toLocaleString())}${v.created_by?' · '+esc(v.created_by):''}</button>`).join('')||'<p>No saved revisions yet.</p>'}</div>`);
 $$('[data-note-revision]').forEach(b=>b.onclick=()=>previewNoteRevision(versions.find(v=>v.revision===Number(b.dataset.noteRevision))));
 }catch(e){if(epoch!==deskEpoch)return;modal('Note history',`<p role="alert">${esc(e.message)}</p><button class="button" id="retry-history">Retry</button>`);$('#retry-history').onclick=noteHistory}
}
function previewNoteRevision(version){
 const unsaved=work.notes!==noteBase.content;
 modal('Note revision '+version.revision,`<label class="field">Saved content<textarea readonly id="history-content">${esc(version.content)}</textarea></label>${unsaved?'<p role="alert">You have unsaved notes. Restoring will replace the editor text. Copy your draft first if you want to keep it.</p><button class="text-button" id="copy-draft">Copy unsaved draft</button><label class="field"><input type="checkbox" id="confirm-restore"> I confirm replacing my unsaved notes.</label>':''}<div class="inline-actions"><button class="button" id="back-history">Back to history</button><button class="button primary" id="restore-revision" ${unsaved?'disabled':''}>Restore as a new revision</button></div><p role="status" id="restore-status"></p>`);
 $('#back-history').onclick=()=>{const h=$('#notes-history');if(h){$('#modal').close();dxHistory(h)}else noteHistory()};$('#copy-draft')?.addEventListener('click',()=>copyNote(work.notes,'#notes-editor'));
 $('#confirm-restore')?.addEventListener('change',e=>$('#restore-revision').disabled=!e.target.checked);
 $('#restore-revision').onclick=async()=>{const b=$('#restore-revision'),draftAtRestore=work.notes;b.disabled=true;$('#restore-status').textContent='Restoring revision…';try{const saved=await window.CitelyAPI.restoreNote(conversationId(),version.revision);noteBase=saved;if(work.notes===draftAtRestore)work.notes=saved.content;dirty=work.notes!==noteBase.content||dirtyAnn.size>0||JSON.stringify(chatSnapshot())!==chatBase;$('#modal').close();notifyStatus('Restored as revision '+saved.revision);render()}catch(e){if(e.status===409)await noteConflict();else{$('#restore-status').textContent=e.message;b.disabled=false}}};
}

boot();

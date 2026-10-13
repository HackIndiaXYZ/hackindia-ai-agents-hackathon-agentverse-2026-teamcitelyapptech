/** Standalone bridge for demo.html. Deliberately imports no API/auth/wake client. */
import fixtures from './lib/studio-demo-data.json';
import * as ranges from './lib/ranges.mjs';
const KEY='citely.studio-demo.v2';
const base=new URL('.',location.href);
const asset=(path:string)=>new URL(path==='/studio.html'?'demo.html':path.replace(/^\//,''),base).pathname;
const copy=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
const user={id:'demo-visitor',name:'Demo visitor',email:'Sample workspace'};
const byId=(id:string)=>{const d=fixtures.find(d=>d.id===id);if(!d)throw Error('Choose a bundled demo file.');return d;};
function fresh(){const initial=fixtures.filter(d=>d.initial);return {version:2,ids:initial.map(d=>d.id),records:{catalog:{revision:1,value:{orgs:[{id:'personal',name:'Personal',spaces:[{id:'org',name:'Acme review',folders:[{id:'review',name:'Quarterly review'}],docs:initial.map(d=>({id:d.id,name:d.filename,pages:d.pages.length,size:Math.round(d.size/1024)+' KB',kind:'document',status:'Ready',folder:d.id==='annual'?null:'review',added:'Sample file'}))}]}]}}} as Record<string,any>,annotations:[] as any[],notes:{} as Record<string,any>,jobs:{} as Record<string,any>};}
let state=fresh();
try{const raw=sessionStorage.getItem(KEY);if(raw&&raw.length<2000000){const s=JSON.parse(raw);if(s.version===2&&Array.isArray(s.ids)&&s.ids.every((id:string)=>fixtures.some(d=>d.id===id))&&s.records?.catalog?.value?.orgs?.[0]?.spaces?.length&&Array.isArray(s.annotations)&&s.notes&&s.jobs)state=s;}}catch{}
function persist(){try{sessionStorage.setItem(KEY,JSON.stringify(state));}catch{throw Error('Demo storage is full or unavailable. Export your notes, then reset the demo.');}}
const modules:Record<string,Promise<any>>={},pages=new Map(),sampleFiles=new WeakMap<File,string>();
function sleep(ms:number,signal?:AbortSignal){return new Promise<void>((resolve,reject)=>{if(signal?.aborted)return reject(new DOMException('Cancelled','AbortError'));const stop=()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'));};const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve();},ms);signal?.addEventListener('abort',stop,{once:true});});}
const error=(message:string,status=409)=>Object.assign(new Error(message),{status});
function note(conversation:string){return state.notes[conversation]||{conversation_id:conversation,workspace_id:conversation.split(':')[0],content:'',revision:0,versions:[]};}
function saveNote(conversation:string,content:string,expected:number,workspace:string){const n=note(conversation);if(n.revision!==expected)throw error('A newer demo note revision exists.');const next={...n,content,workspace_id:workspace,revision:n.revision+1,updated_at:new Date().toISOString(),created_at:new Date().toISOString()};next.versions=[...n.versions,{...next,versions:undefined}].slice(-20);state.notes[conversation]=next;persist();return copy(next);}
const demo={
 choices:()=>fixtures.filter(d=>!state.ids.includes(d.id)).map(d=>({id:d.id,name:d.filename})),
 async file(id:string){const d=byId(id);if(state.ids.includes(id))throw Error('This sample is already in your library.');const response=await fetch(asset('/demo-files/'+encodeURIComponent(d.filename)),{credentials:'omit'});if(!response.ok)throw Error('The sample file could not be loaded.');const file=new File([await response.arrayBuffer()],d.filename);sampleFiles.set(file,id);return file;},
 prompts:(ids:string[])=>ids.flatMap(id=>byId(id).answers).slice(0,3).map(a=>({question:a.question,label:a.label})),
 episode:(ids:string[])=>ids.map(id=>{const d=byId(id);return {name:d.filename,answers:d.answers.map((a:any)=>({question:a.question,label:a.label,answer:a.answer,quotes:a.sources.map((s:any)=>String(s.quote||'').replace(/\s+/g,' ').trim()).filter((q:string)=>q&&!/\d\s+\d/.test(q))}))};}),
 reset(){if(confirm('Reset all sample files, chats, highlights and notes?')){sessionStorage.removeItem(KEY);location.assign(asset('/studio.html'));}},
};
const bridge={
 asset,pages,ranges,demo,development:false,viewers:{docx:true,xlsx:true,pptx:true},pendingFiles:new Map(),inflightWrites:()=>0,
 loadViewer:(kind:string)=>{if(!['docx','xlsx','pptx'].includes(kind))throw Error('Unsupported sample viewer.');return modules[kind]||=(import(/* webpackIgnore: true */ asset('/viewers/'+kind+'.js')));},
 async originalFile(id:string,signal?:AbortSignal){const d=byId(id);const response=await fetch(asset('/demo-files/'+encodeURIComponent(d.filename)),{signal,credentials:'omit'});if(!response.ok)throw Error('Sample original unavailable.');return response.arrayBuffer();},
 sessionUser:async()=>null,snapshot:{load:()=>null,save:()=>{}},wakingMessage:()=> 'Opening the sample workspace…',init:async()=>copy(user),logout:async()=>{window.top!.location.assign(asset('/'));},
 async read(key:string){return copy(state.records[key]||{value:null,revision:0});},
 async write(key:string,value:any,revision:number){const prev=state.records[key];if((prev?.revision||0)!==revision)throw error('A newer demo version was saved.');const record={value:copy(value),revision:revision+1,updated:new Date().toISOString()};state.records[key]=record;persist();return copy(record);},
 async deleteState(key:string){delete state.records[key];persist();},
 documents:async()=>state.ids.map((id:string)=>{const d=byId(id);return {id,filename:d.filename,pages:d.pages.length,ingested_at:'2025-11-01',has_original:true,original_compatible:true};}),
 async deleteDocument(id:string){state.ids=state.ids.filter((i:string)=>i!==id);state.annotations=state.annotations.filter(a=>a.document_id!==id);persist();},
 async loadPages(id:string){pages.set(id,copy(byId(id).pages));return pages.get(id);},
 annotations:async(conversation:string)=>copy(state.annotations.filter(a=>a.conversation_id===conversation)),
 async createAnnotation(conversation:string,value:any){const old=state.annotations.find(a=>a.conversation_id===conversation&&ranges.annotationKey(a)===ranges.annotationKey(value));if(old)return copy(old);const saved={...copy(value),id:crypto.randomUUID(),conversation_id:conversation,created_at:new Date().toISOString()};state.annotations.push(saved);persist();return copy(saved);},
 async deleteAnnotation(id:string){state.annotations=state.annotations.filter(a=>a.id!==id);persist();},
 async deleteConversationAnnotations(conversation:string){state.annotations=state.annotations.filter(a=>a.conversation_id!==conversation);persist();},
 note:async(conversation:string)=>copy(note(conversation)),saveNote:async(c:string,text:string,rev:number,w:string)=>saveNote(c,text,rev,w),
 async deleteNote(c:string){delete state.notes[c];persist();},
 noteHistory:async(c:string)=>copy(note(c).versions),
 async restoreNote(c:string,revision:number){const n=note(c),v=n.versions.find((v:any)=>v.revision===revision);if(!v)throw Error('This demo revision is unavailable.');return saveNote(c,v.content,n.revision,n.workspace_id);},
 history:async()=>[],deleteHistory:async()=>{},
 async deleteConversation(space:string,desk:string){delete state.records['chat:'+space+':'+desk];delete state.notes[space+':'+desk];state.annotations=state.annotations.filter(a=>a.conversation_id!==space+':'+desk);persist();},
 async ask(ids:string[],question:string){const answers=ids.flatMap(id=>byId(id).answers);const clean=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]/g,'');let a=answers.find(a=>clean(a.question)===clean(question));if(!a){const q=question.toLowerCase();const label=/risk/.test(q)?'Main risks':/retention/.test(q)?'Retention':/cash/.test(q)?'Cash position':/assum/.test(q)?'Assumptions':/board|recommend/.test(q)?'Board decision':/priorit/.test(q)?'Priorities':/customer|research/.test(q)?'Customer findings':/revenue|growth|summar|takeaway/.test(q)?undefined:'';a=label===undefined?answers[0]:answers.find(a=>a.label===label);}
 await sleep(450);return a?copy({answer:a.answer,sources:a.sources}):{answer:'This demo uses prepared answers. Choose one of the suggested questions below to explore this file. No question is sent to an AI service.',sources:[]};},
 async startUpload(file:File,signal?:AbortSignal,clientId?:string){const id=sampleFiles.get(file);if(!id)throw Error('Only bundled sample files can be added in this demo.');await sleep(250,signal);const job={job_id:'sample-'+clientId,id,status:'queued'};state.jobs[job.job_id]=job;persist();return copy(job);},
 async pollUpload(job:any,options:any){const saved=state.jobs[job.job_id];if(!saved)throw Error('Reset the demo and try adding the sample again.');options.onStatus?.({status:'queued'});await sleep(500,options.signal);options.onStatus?.({status:'running'});await sleep(900,options.signal);if(!state.ids.includes(saved.id))state.ids.push(saved.id);saved.status='succeeded';persist();return {document_id:saved.id,pages:byId(saved.id).pages.length};},
};
(window as any).CitelyAPI=bridge;
// Personal files are never read. Non-local collaboration features stay honest.
document.addEventListener('dragover',e=>e.preventDefault());
document.addEventListener('drop',e=>{e.preventDefault();const t=document.getElementById('toast')!;t.textContent='Use Upload to choose a bundled sample. Personal files are not accepted.';t.classList.add('show');setTimeout(()=>t.classList.remove('show'),3500);});

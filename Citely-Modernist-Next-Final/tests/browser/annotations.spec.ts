import {test,expect,Page} from '@playwright/test';
import realIngest from '../fixtures/real-ingest.json';
const text=('Revenue grew through enterprise expansion. Operating cash flow supported product development.\n').repeat(8)+'End of page.';
const range=(id:string,start:number|null,end:number|null,extra={})=>({citation_id:id,document_id:'doc1',evidence_role:'cited',page:1,page_char_start:start,page_char_end:end,quote:start===null||end===null?null:text.slice(start,end),content:'Evidence',extraction_version:'v1',...extra});
async function setup(page:Page,sources=[range('first',0,327),range('second',328,528)],pageText=text,answer='Two merged supporting citations.'){
 const state:any={annotations:[],note:{content:'',revision:0,conversation_id:'org:doc1',workspace_id:'org'},versions:[],writes:[],creates:0,failAnnotation:false,failDelete:false,failPages:false,failNotes:false};
 const docs=[{id:'doc1',filename:'Citation acceptance.txt',pages:2,ingested_at:'2026-09-19'},{id:'doc2',filename:'Second source.txt',pages:2,ingested_at:'2026-09-19'}];
 const records=new Map<string,any>([['catalog',{value:{orgs:[{id:'personal',name:'Personal',spaces:[{id:'org',name:'My workspace',folders:[],docs:docs.map(d=>({...d,name:d.filename,status:'Ready'}))}]}]},revision:1}]]);
 await page.addInitScript(()=>{localStorage.setItem('rag.jwt','e30.'+btoa(JSON.stringify({exp:9999999999}))+'.test');localStorage.setItem('rag.user',JSON.stringify({id:'test-owner',email:'test@example.com',privacyPolicyAccepted:true}));});
 await page.route(/(127\.0\.0\.1:8000|rag-api-staging\.)/,async route=>{
  const req=route.request(),path=decodeURIComponent(new URL(req.url()).pathname);let data:any={},status=200;
  if(path==='/health'||path==='/ready')data={status:'ok',ready:true,readiness:'ready'};
  else if(path==='/warmup')data={status:'ok'};
  else if(path==='/documents')data=docs;
  else if(path.endsWith('/pages')){if(state.failPages){status=503;data={detail:'Page loading failed'}}else data=[1,2].map(page=>({page,text:pageText,extraction_version:sources[0]?.extraction_version==='1'?'1':'v1'}));}
  else if(path.endsWith('/history'))data=[{id:'answer-turn',question:'Summarize the evidence',answer,sources,created_at:'2026-09-19T00:00:00Z'}];
  else if(path.startsWith('/state/')){const key=path.slice(7),record=records.get(key)||{value:null,revision:0};if(req.method()==='PUT'){const body=req.postDataJSON();if(body.revision!==record.revision){status=409;data={detail:'State conflict'}}else{data={revision:record.revision+1};records.set(key,{...data,value:body.value})}}else data=record;}
  else if(path.endsWith('/annotations')){if(req.method()==='POST'){if(state.failAnnotation){status=503;data={detail:'Annotation service unavailable'}}else{state.creates++;data={...req.postDataJSON(),id:'a'+state.creates,conversation_id:'org:doc1',created_at:'2026-09-19',updated_at:'2026-09-19'};state.annotations.push(data)}}else data=state.annotations;}
  else if(path.startsWith('/annotations/')){if(state.failDelete){status=503;data={detail:'Deletion failed'}}else{state.annotations=state.annotations.filter((a:any)=>a.id!==path.split('/').at(-1));data={deleted:true}}}
  else if(path.endsWith('/notes/versions'))data=state.versions;
  else if(path.endsWith('/restore')){const n=Number(path.split('/').at(-2));state.note={...state.note,content:state.versions.find((v:any)=>v.revision===n).content,revision:state.note.revision+1};state.versions.unshift({...state.note,created_at:'2026-09-19'});data=state.note;}
  else if(path.endsWith('/notes')){if(state.failNotes){status=503;data={detail:'Notes loading failed'}}else if(req.method()==='PUT'){const body=req.postDataJSON();state.writes.push(body);if(body.expected_revision!==state.note.revision){status=409;data={detail:'These notes were changed elsewhere'}}else{state.note={...state.note,content:body.content,revision:state.note.revision+1};state.versions.unshift({...state.note,created_at:'2026-09-19',created_by:'test-owner'});data=state.note}}else data=state.note;}
  else if(path==='/me/usage')data={limited:false};
  else if(path==='/me/presence')return route.fulfill({status:204});
  else throw Error('Unexpected API request '+path);
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
 });
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('studio.html?desk=doc1&space=org');await expect(page.locator('#notes-editor')).toBeEnabled();await expect(page.locator('[data-page-text]')).toHaveText(pageText);
 return {state,errors};
}
test('two merged citations render exact independent ranges, activate and scroll only clicked target',async({page})=>{
 const {errors}=await setup(page);await expect(page.locator('[data-citation]')).toHaveCount(2);await expect(page.locator('.citation-range')).toHaveCount(2);
 expect(await page.locator('.citation-range').allTextContents()).toEqual([text.slice(0,327),text.slice(328,528)]);
 await page.evaluate(()=>{(window as any).scrollTargets=[];(window as any).paneScrolls=0;Element.prototype.scrollIntoView=function(this:Element){(window as any).scrollTargets.push(this.id)};const orig=HTMLElement.prototype.scrollTo as any;HTMLElement.prototype.scrollTo=function(this:HTMLElement,...a:any[]){if(this.id==='paper-viewport')(window as any).paneScrolls++;return orig.apply(this,a)} as any});
 for(const id of ['first','second']){await page.locator(`[data-citation="${id}"]`).click();await expect(page.locator('[data-citation][aria-pressed=true]')).toHaveCount(1);await expect(page.locator(`#citation-${id}`)).toBeFocused();await expect(page.locator(`#citation-${id}`)).toBeInViewport();expect(await page.evaluate(()=>(window as any).paneScrolls)).toBeGreaterThanOrEqual(['first','second'].indexOf(id)+1);expect(await page.evaluate(()=>(window as any).scrollTargets)).toEqual([]);}
 await page.locator('button.dx-avatar').click();await page.locator(`#dx-pop-account [data-theme-choice="${await page.evaluate(()=>document.body.dataset.mode==='dark'?'light':'dark')}"]`).click();await expect(page.locator('[data-citation="second"]')).toHaveAttribute('aria-pressed','true');await expect(page.locator('[data-page-text]')).toHaveText(text);expect(errors).toEqual([]);
});
test('duplicate backend citation identity does not create extra chips',async({page})=>{await setup(page,[range('first',0,327),range('first',0,327),range('second',328,528)]);await expect(page.locator('[data-citation]')).toHaveCount(2)});
test('missing, invalid and stale offsets stay clickable without any fallback mark',async({page})=>{
 await setup(page,[range('missing',null,null),range('negative',-1,5),range('stale',0,10,{extraction_version:'old'})]);await expect(page.locator('.citation-range')).toHaveCount(0);
 await page.locator('[data-citation="missing"]').click();await expect(page.locator('#highlight-hint')).toHaveText('Precise passage location unavailable.');await expect(page.locator('.citation-range')).toHaveCount(0);
});
test('citation opens its own document and page',async({page})=>{await setup(page,[range('other',20,50,{document_id:'doc2',page:2})]);await page.locator('[data-citation="other"]').click();await expect(page.locator('[data-page-text]')).toHaveAttribute('data-document-id','doc2');await expect(page.locator('[data-page-text]')).toHaveAttribute('data-page-number','2');await expect(page.locator('#citation-other')).toHaveText(text.slice(20,50))});
test('DOM selections cross adjacent spans on one page; cross-page selections are rejected',async({page})=>{
 await setup(page);const result=await page.evaluate(()=>{
 const R=(window as any).CitelyAPI.ranges,host=document.createElement('div');host.innerHTML='<p data-page-text><span>Alpha </span><mark>beta</mark><span> gamma</span></p><p data-page-text>Other page</p>';document.body.append(host);const [one,two]=host.children;const r=document.createRange();r.setStart(one.firstChild!.firstChild!,2);r.setEnd(one.lastChild!.firstChild!,4);const same=R.rangeToPageOffsets(one,r);r.setEnd(two.firstChild!,4);const cross=R.rangeToPageOffsets(one,r);host.remove();return {same,cross};});
 expect(result.same).toEqual({start:2,end:14,quote:'pha beta gam'});expect(result.cross).toBeNull();
});
test('kept citations persist, deduplicate, and deletion remains deleted after reload',async({page})=>{
 const {state}=await setup(page);await page.locator('#keep-citations').click();await expect(page.locator('.highlight-card')).toHaveCount(2);expect(state.creates).toBe(2);expect(state.annotations.map((a:any)=>[a.page_char_start,a.page_char_end])).toEqual([[0,327],[328,528]]);
 await page.locator('#keep-citations').click();await expect(page.locator('#highlight-hint')).toContainText('already saved');expect(state.creates).toBe(2);
 await page.reload();await expect(page.locator('.highlight-card')).toHaveCount(2);await page.locator('[data-dx-tab="hls"]').click();await page.locator('[data-delete-annotation]').first().click();await expect(page.locator('.highlight-card')).toHaveCount(1);await page.reload();await expect(page.locator('.highlight-card')).toHaveCount(1);
});
test('manual highlight across rendered inline ranges persists exact quote and offsets',async({page})=>{
 const {state}=await setup(page);await page.locator('[data-dx-pop="tools"]').click();await page.locator('#highlight-tool').click();await page.evaluate(()=>{const p=document.querySelector('[data-page-text]')!,walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT);const nodes:Text[]=[];let n;while(n=walker.nextNode())nodes.push(n as Text);const range=document.createRange();range.setStart(nodes[0],320);range.setEnd(nodes[2],12);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);document.querySelector('#paper')!.dispatchEvent(new Event('pointerup'));});
 await expect(page.locator('.highlight-card')).toHaveCount(1);expect(state.annotations[0]).toMatchObject({kind:'manual-highlight',document_id:'doc1',conversation_id:'org:doc1',page_number:1,page_char_start:320,page_char_end:340,quote:text.slice(320,340),extraction_version:'v1'});await page.reload();await expect(page.locator('.highlight-card')).toHaveCount(1);
});
test('note revision saves, survives reload, and history restore appends a revision',async({page})=>{
 const {state}=await setup(page);await page.locator('#notes-editor').fill('First version');await page.locator('#save-changes').click();await expect(page.locator('#save-state')).toHaveText('All changes saved');expect(state.writes[0].expected_revision).toBe(0);
 await page.reload();await expect(page.locator('#notes-editor')).toHaveValue('First version');await page.locator('#notes-editor').fill('Second version');await page.locator('#save-changes').click();await expect(page.locator('#save-state')).toHaveText('All changes saved');
 await page.locator('#notes-history').click();await page.locator('[data-note-revision="1"]').click();await expect(page.locator('#history-content')).toHaveValue('First version');await page.locator('#restore-revision').click();await expect(page.locator('#notes-editor')).toHaveValue('First version');expect(state.note.revision).toBe(3);await page.reload();await expect(page.locator('#notes-editor')).toHaveValue('First version');
});
test('409 preserves local text without retry, compares versions and deliberately saves new revision',async({page})=>{
 const {state}=await setup(page);await page.locator('#notes-editor').fill('Local unsaved text');state.note={...state.note,content:'Remote newer text',revision:1};await page.locator('#save-changes').click();await expect(page.locator('#modal')).toContainText('409 Conflict');await expect(page.locator('#conflict-local')).toHaveValue('Local unsaved text');await expect(page.locator('#conflict-server')).toHaveValue('Remote newer text');expect(state.writes).toHaveLength(1);expect(state.note.content).toBe('Remote newer text');await page.locator('#save-local-revision').click();await expect(page.locator('#modal')).not.toBeVisible();expect(state.writes[1].expected_revision).toBe(1);expect(state.note.content).toBe('Local unsaved text');expect(state.note.revision).toBe(2);
});
test('restore requires explicit confirmation before discarding dirty notes',async({page})=>{
 const {state}=await setup(page);state.versions=[{revision:1,content:'Earlier text',created_at:'2026-09-19'}];await page.locator('#notes-editor').fill('Unsaved');await page.locator('#notes-history').click();await page.locator('[data-note-revision="1"]').click();await expect(page.locator('#restore-revision')).toBeDisabled();await page.locator('#confirm-restore').check();await page.locator('#restore-revision').click();await expect(page.locator('#notes-editor')).toHaveValue('Earlier text');
});
for(const mode of ['light','dark'])test(`${mode} shows the opened citation in blue and saved highlights in light yellow`,async({page})=>{
 await page.emulateMedia({colorScheme:mode as 'light'|'dark'});await setup(page);await page.locator('#keep-citations').click();await expect(page.locator('.highlight-card')).toHaveCount(2);await page.locator('[data-citation="second"]').click();const colors=await page.evaluate(()=>({flash:getComputedStyle(document.querySelector('.current-citation')!).boxShadow,saved:getComputedStyle(document.querySelector('.permanent-mark:not(.current-citation)')!).backgroundColor}));expect(colors.flash).toMatch(/rgba\(78, 137, 232, 0\.28\)/);expect(colors.saved).toBe('rgba(255, 213, 0, 0.28)');await page.screenshot({path:`test-results/precise-${mode}.png`,fullPage:true});
});
test('failed annotation create and delete preserve recoverable UI state',async({page})=>{
 const {state}=await setup(page);state.failAnnotation=true;await page.locator('#keep-citations').click();await expect(page.locator('#highlight-hint')).toContainText('failed');await expect(page.locator('.highlight-card')).toHaveCount(0);state.failAnnotation=false;await page.locator('#keep-citations').click();await expect(page.locator('.highlight-card')).toHaveCount(2);state.failDelete=true;await page.locator('[data-dx-tab="hls"]').click();await page.locator('[data-delete-annotation]').first().click();await expect(page.locator('#highlight-hint')).toContainText('not deleted');await expect(page.locator('.highlight-card')).toHaveCount(2);
});

test('existing real-ingest response renders exactly 0–327 and 328–528 with the original page string',async({page})=>{
 await setup(page,realIngest.sources.map(s=>({...s,document_id:'doc1',evidence_role:'legacy-context'})),realIngest.pages[0].text);
 await expect(page.locator('[data-citation]')).toHaveCount(2);
 await expect(page.locator('.citation-range')).toHaveCount(0);
 await page.locator('[data-citation]').first().click();expect(await page.locator('.current-citation').textContent()).toBe(realIngest.pages[0].text.slice(0,327));
 expect(await page.locator('[data-page-text]').textContent()).toBe(realIngest.pages[0].text);
 await page.locator('[data-citation]').last().click();expect(await page.locator('.current-citation').textContent()).toBe(realIngest.pages[0].text.slice(328,528));await page.locator('#keep-citations').click();await expect(page.locator('.highlight-card')).toHaveCount(2);
 await page.screenshot({path:'test-results/real-ingest-precise.png',fullPage:true});await page.reload();await expect(page.locator('.highlight-card')).toHaveCount(2);
});
test('page and notes loading errors can be retried independently',async({page})=>{
 const {state}=await setup(page);state.failPages=true;state.failNotes=true;await page.reload();await expect(page.locator('[data-retry-page]')).toBeVisible();await expect(page.locator('#retry-notes')).toBeVisible();await expect(page.locator('#notes-editor')).toBeDisabled();
 // The initial reader placeholder also has Retry before its first request.
 // Wait for the actual failure before making the fixture healthy.
 await expect(page.locator('[data-retry-page]').locator('..')).toContainText('Page loading failed');
 state.failPages=false;state.failNotes=false;await page.locator('[data-retry-page]').click();await expect(page.locator('[data-page-text]')).toHaveText(text);await page.locator('#retry-notes').click();await expect(page.locator('#notes-editor')).toBeEnabled();
});
test('409 can explicitly reload the saved version without writing over it',async({page})=>{
 const {state}=await setup(page);await page.locator('#notes-editor').fill('Local draft');state.note={...state.note,content:'Server text',revision:1};await page.locator('#save-changes').click();await page.locator('#use-server').click();await expect(page.locator('#notes-editor')).toHaveValue('Server text');expect(state.writes).toHaveLength(1);expect(state.note.revision).toBe(1);
});
test('notes failure keeps the unsaved editor text',async({page})=>{
 const {state}=await setup(page);await page.locator('#notes-editor').fill('Keep this draft');state.failNotes=true;await page.locator('#save-changes').click();await expect(page.locator('#notes-editor')).toHaveValue('Keep this draft');await expect(page.locator('#save-state')).toHaveText('Unsaved changes');expect(state.note.content).toBe('');
});

test('page DOM preserves exact whitespace, CRLF and literal markup',async({page})=>{
 const raw='  Alpha\r\n<b>not HTML</b>\u0000 omega  ';
 await setup(page,[range('exact',2,7,{quote:raw.slice(2,7)})],raw);
 expect(await page.locator('[data-page-text]').textContent()).toBe(raw);expect(await page.locator('.citation-range').textContent()).toBe(raw.slice(2,7));await expect(page.locator('[data-page-text] b')).toHaveCount(0);
});

test('legacy codepoint Unicode citation saves the exact UTF-16 quote',async({page})=>{
 const raw='😀 intro\nPrecise supporting text. Fin.';
 const points=Array.from(raw),start=points.join('').indexOf('Precise')-1,end=start+24;
 const quote=points.slice(start,end).join('');
 const {state}=await setup(page,[range('unicode',start,end,{quote,offset_unit:'codepoint'})],raw);
 await page.locator('[data-citation]').click();await expect(page.locator('.current-citation')).toHaveText(quote);
 // Wait for the save to land before inspecting it: the click only starts an
 // async POST, so reading the mock synchronously raced the request.
 await page.locator('#keep-citations').click();await expect(page.locator('.highlight-card')).toHaveCount(1);expect(state.annotations[0].page_char_start).toBe(start+1);expect(state.annotations[0].quote).toBe(quote);
 await page.reload();await expect(page.locator('.permanent-mark')).toHaveText(quote);
});

test('late page load cannot activate a previously clicked citation',async({page})=>{
 await setup(page,[range('one',10,25),range('two',50,70,{document_id:'doc2'})]);
 await page.evaluate(()=>(window as any).CitelyAPI.pages.delete('doc2'));
 let calls=0;await page.route('**/documents/doc2/pages',async route=>{calls++;await new Promise(r=>setTimeout(r,400));await route.fulfill({json:[{page:1,text,extraction_version:'v1'}]});});
 await page.locator('[data-citation="two"]').click();await page.locator('[data-citation="two"]').click();await page.locator('[data-citation="one"]').click();await page.waitForTimeout(500);
 expect(calls).toBe(1);await expect(page.locator('[data-citation="one"]')).toHaveAttribute('aria-pressed','true');await expect(page.locator('[data-page-text]')).toHaveAttribute('data-document-id','doc1');
});

test('select first then Highlighter preserves selection until acknowledgement',async({page})=>{
 const {state}=await setup(page,[]);
 await page.evaluate(()=>{const node=document.querySelector('[data-page-text]')!.firstChild!;const range=document.createRange();range.setStart(node,5);range.setEnd(node,27);const selection=getSelection()!;selection.removeAllRanges();selection.addRange(range)});
 await page.locator('[data-dx-pop="tools"]').click();await page.locator('#highlight-tool').click();await expect(page.locator('#highlight-hint')).toHaveText('Highlight saved.');expect(state.annotations[0].quote).toBe(text.slice(5,27));
 await page.reload();await expect(page.locator('.permanent-mark')).toHaveText(text.slice(5,27));
});


test('citations deduplicate locally, remain beside later claims and open exact evidence',async({page})=>{
 const {errors}=await setup(page,[range('first',0,39),range('second',40,91)],text,
   '**Revenue** grew. [1] [1]\n\n- Development continued. [2]\n- Revenue remains relevant. [1]');
 await expect(page.locator('.message-body strong').first()).toHaveText('Revenue');
 await expect(page.locator('.dx-cite')).toHaveCount(3);
 await expect(page.locator('.dx-cite')).toHaveText(['1','2','1']);
 await page.locator('.dx-cite').first().focus();
 await expect(page.locator('.dx-evidence-preview').first()).toBeVisible();
 await page.locator('.dx-cite[data-citation="second"]').click();
 await expect(page.locator('#citation-second')).toBeFocused();
 expect(errors).toEqual([]);
});

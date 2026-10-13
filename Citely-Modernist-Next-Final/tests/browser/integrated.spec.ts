import {test,expect,Page} from '@playwright/test';
test.skip(!process.env.CITELY_INTEGRATED,'Requires disposable real API: scripts/citely_test_server.py');
test.describe.configure({mode:'serial'});
let session:any,docs:any[],headers:any;
const api='http://127.0.0.1:8000';
test.beforeAll(async({request})=>{
 const login=await request.post(api+'/auth/login',{data:{email:'fixture@example.invalid',password:'Fixture-password-123'}});
 expect(login.status()).toBe(200);session=await login.json();headers={Authorization:'Bearer '+session.access_token};
 docs=await (await request.get(api+'/documents',{headers})).json();
});
test.beforeEach(async({page})=>{
 await page.addInitScript(s=>{localStorage.setItem('rag.jwt',s.access_token);localStorage.setItem('rag.user',JSON.stringify({id:s.user_id,email:s.email,privacyPolicyAccepted:true}));},session);
});
async function select(page:Page,start:number,end:number,backward=false){
 await page.evaluate(({start,end,backward})=>{
  const container=document.querySelector('[data-page-text]')!,text=container.textContent!;
  container.replaceChildren();for(const s of [text.slice(0,start+3),text.slice(start+3,end-2),text.slice(end-2)]){const span=document.createElement('span');span.textContent=s;container.append(span);}
  const nodes=[...container.childNodes].map(n=>n.firstChild!),selection=getSelection()!;
  if(backward)selection.setBaseAndExtent(nodes[2],2,nodes[0],start);
  else selection.setBaseAndExtent(nodes[0],start,nodes[2],2);
  document.querySelector('#paper')!.dispatchEvent(new Event('pointerup'));
 },{start,end,backward});
}
test('real legacy history: unavailable old anchor, independent backward Unicode highlight, acknowledged persistence and delete',async({page,request})=>{
 const d=docs.find(d=>d.filename==='Legacy-synopsis.txt');
 await page.goto('studio.html?desk='+d.id+'&space=org');
 await expect(page.locator('[data-page-text]')).toBeVisible();await expect(page.locator('[data-dx-pop="tools"]')).toBeVisible();
 await page.locator('[data-citation]').click();await expect(page.locator('#highlight-hint')).toContainText('Precise passage location unavailable');await expect(page.locator('.current-citation')).toHaveCount(0);
 await page.locator('[data-dx-pop="tools"]').click();await page.locator('#highlight-tool').click();
 const raw=(await page.locator('[data-page-text]').textContent())!,start=raw.indexOf('quality gate scores'),end=start+36;
 const response=page.waitForResponse(r=>r.url().endsWith('/annotations')&&r.request().method()==='POST');
 await select(page,start,end,true);const saved=await response;expect(saved.status()).toBe(201);
 const annotation=await saved.json();expect(annotation.quote).toBe(raw.slice(start,end));expect(annotation.page_char_start).toBe(start);expect(annotation.extraction_version).toMatch(/^legacy-preview-/);
 await expect(page.locator('#highlight-hint')).toHaveText('Highlight saved.');
 await page.reload();await expect(page.locator('.permanent-mark')).toHaveText(raw.slice(start,end));
 await page.screenshot({path:'test-results/real-api-legacy-highlight.png',fullPage:true});
 await page.locator('[data-dx-tab="hls"]').click();await page.locator('[data-delete-annotation]').click();await expect(page.locator('.highlight-card')).toHaveCount(0);await page.reload();await expect(page.locator('.highlight-card')).toHaveCount(0);
 const history=await (await request.get(api+'/documents/'+d.id+'/history',{headers})).json();expect(history[0].answer).toBe('Old answer with missing offsets.');
});
for(const filename of ['Legacy-synopsis.txt','Disposable-synopsis.txt'])test(`real retrieval and page API: ${filename}, new question cites exact used passages`,async({page,request})=>{
 const d=docs.find(d=>d.filename===filename);await page.goto('studio.html?desk='+d.id+'&space=org');await expect(page.locator('#notes-editor')).toBeEnabled();
 const pending=page.waitForResponse(r=>r.url().endsWith('/query/stream'));
 await page.locator('#message-input').fill('Explain the quality gate.');await page.getByRole('button',{name:'Send message',exact:true}).click();
 const response=await pending;expect(response.status()).toBe(200);const answer=(await response.text()).trim().split('\n').map(l=>JSON.parse(l)).find((e:any)=>e.type==='done').response;expect(answer.answer).toContain('chunk length');expect(answer.sources.length).toBeGreaterThan(0);expect(answer.sources.length).toBeLessThan(10);
 expect(answer.request_id).toBeTruthy();console.log('Integrated query',JSON.stringify({document_id:d.id,conversation_id:'org:'+d.id,request_id:answer.request_id,sources:answer.sources.map((s:any)=>({id:s.citation_id,start:s.page_char_start,end:s.page_char_end,version:s.extraction_version}))}));
 const pages=await (await request.get(api+'/documents/'+d.id+'/pages',{headers})).json();
 for(const source of answer.sources){const text=pages.find((p:any)=>p.page===source.page).text;expect(source.offset_unit).toBe('utf16');expect(text.slice(source.page_char_start,source.page_char_end)).toBe(source.quote);await page.locator('[data-citation="'+source.citation_id+'"]').last().click();expect((await page.locator('.current-citation').allTextContents()).join('')).toBe(source.quote);}
 await page.screenshot({path:'test-results/real-api-citations-'+filename+'.png',fullPage:true});
 await page.locator('#keep-citations').click();await expect(page.locator('.highlight-card')).toHaveCount(answer.sources.length);await page.reload();await expect(page.locator('.highlight-card')).toHaveCount(answer.sources.length);
 const originalCount=(await (await request.get(api+'/documents/'+d.id+'/history',{headers})).json()).length;expect(originalCount).toBeGreaterThanOrEqual(filename.startsWith('Legacy')?2:1);
});
test('real concurrent uploads keep workspace DOM, search, selection and modal through transient poll failure',async({page})=>{
 await page.goto('studio.html');await expect(page.locator('#file-search')).toBeVisible();await page.locator('#file-search').fill('synopsis');await page.locator('[data-select]').first().check();await page.waitForTimeout(30);
 let navigations=0;page.on('framenavigated',f=>{if(f===page.mainFrame())navigations++});
 await page.evaluate(()=>{(window as any).originalRoot=document.querySelector('.lx-shell');(window as any).originalSearch=document.querySelector('#file-search');});
 let failed=false;await page.route('**/ingest/jobs/*',async route=>{if(!failed){failed=true;await route.fulfill({status:503,json:{detail:'Temporary fixture network failure'}})}else await route.continue();});
 await page.locator('[data-upload]').first().click();await page.locator('#upload-input').setInputFiles(['A','B'].map(name=>({name:'new-synopsis-'+name+'.txt',mimeType:'text/plain',buffer:Buffer.from(('Test upload '+name+'. This is meaningful disposable source text. ').repeat(20))})));
 await page.locator('[data-new-folder]').click();await page.locator('#folder-name').fill('Keep my unfinished folder');
 await expect(page.locator('[data-file-id]').filter({hasText:'new-synopsis-A.txt'}).locator('.status')).toHaveText('Ready',{timeout:60000});
 await expect(page.locator('[data-file-id]').filter({hasText:'new-synopsis-B.txt'}).locator('.status')).toHaveText('Ready',{timeout:60000});
 expect(failed).toBe(true);expect(navigations).toBe(0);expect(await page.evaluate(()=>(window as any).originalRoot===document.querySelector('.lx-shell')&&(window as any).originalSearch===document.querySelector('#file-search'))).toBe(true);
 await expect(page.locator('#file-search')).toHaveValue('synopsis');expect(await page.locator('[data-select]:checked').count()).toBe(1);await expect(page.locator('#folder-name')).toHaveValue('Keep my unfinished folder');await page.screenshot({path:'test-results/real-api-upload-no-refresh.png',fullPage:true});
});

test('workspace switch cancels polling and returning resumes the original job without reupload',async({page})=>{
 await page.goto('studio.html');await page.locator('[data-workspaces]').click();await page.locator('[data-newspace]').first().click();await page.locator('#new-name').fill('Disposable alternate workspace');await page.getByRole('button',{name:'Create',exact:true}).click();await expect(page.locator('#modal')).not.toBeVisible();
 const other=await page.evaluate('currentSpace');await page.locator('[data-workspaces]').click();await page.locator('[data-switch="org"]').click();
 let uploads=0,polls=0;page.on('request',r=>{if(r.url().endsWith('/ingest/async'))uploads++;if(r.url().includes('/ingest/jobs/'))polls++});
 await page.locator('[data-upload]').first().click();await page.locator('#upload-input').setInputFiles({name:'switch-proof.txt',mimeType:'text/plain',buffer:Buffer.from('A disposable source to verify upload status cancellation. '.repeat(20))});
 await page.waitForResponse(r=>r.url().endsWith('/ingest/async'));
 await page.locator('[data-workspaces]').click();await page.locator('[data-switch="'+other+'"]').click();const before=polls;
 await page.waitForTimeout(3500);expect(polls).toBe(before);await expect(page.locator('#file-items')).not.toContainText('switch-proof.txt');
 await page.locator('[data-workspaces]').click();await page.locator('[data-switch="org"]').click();await expect(page.locator('[data-file-id]').filter({hasText:'switch-proof.txt'}).locator('.status')).toHaveText('Ready',{timeout:60000});expect(uploads).toBe(1);
});

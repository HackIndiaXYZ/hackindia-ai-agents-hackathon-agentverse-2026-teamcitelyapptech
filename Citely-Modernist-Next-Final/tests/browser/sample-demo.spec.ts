import {test,expect,Page} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
// Where the build under test is served: /dev/ for the dev build, / for production.
const base=()=>new URL(test.info().project.use.baseURL!).pathname;
// The preview server's own address (PREVIEW_PORT lets several checkouts test at once).
const origin=()=>new URL(test.info().project.use.baseURL!).origin;
async function start(page:Page,path='demo.html'){
 const traffic:string[]=[],errors:string[]=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{if(!r.url().startsWith(origin()+'/')&&!r.url().startsWith('data:')&&!r.url().startsWith('blob:'))traffic.push(r.url());});
 await page.route('**/*',r=>new URL(r.request().url()).origin===origin()?r.continue():r.abort());
 await page.goto(path);await expect(page.locator('.lx-shell,.dx-shell')).toBeVisible();
 return {traffic,errors};
}
async function annual(page:Page){await page.locator('[data-open=annual]').first().click();await expect(page.locator('.original-docx section.docx').first()).toBeVisible();}

test('the real library and original Word viewer work without the live bridge or backend',async({page})=>{
 const requests:string[]=[];page.on('request',r=>requests.push(r.url()));const audit=await start(page);
 await annual(page);await expect(page.locator('#paper-viewport')).not.toContainText('EXTRACTED DOCUMENT TEXT');
 await page.getByRole('button',{name:'Revenue growth',exact:true}).click();await expect(page.locator('.citation-links button')).toHaveCount(2);
 await page.locator('.citation-links button').nth(0).click();await expect(page.locator('.original-docx mark.current-citation')).toHaveText('Revenue increased by 24%, driven primarily by expansion within enterprise accounts.');
 await page.locator('.citation-links button').nth(1).click();await expect(page.locator('.original-docx mark.current-citation')).toHaveText('Enterprise customers represented 62% of total revenue.');
 await page.getByRole('button',{name:'Main risks',exact:true}).click();await page.locator('.citation-links button').last().click();await expect(page.locator('.page-control')).toContainText('2 / 2');
 await page.getByRole('link',{name:'Back to Home',exact:true}).click();await expect(page.locator('.lx-shell')).toBeVisible();await expect(page).toHaveURL(/demo.html/);
 await page.goBack();await expect(page.locator('.dx-shell')).toBeVisible();await page.goForward();await expect(page.locator('.lx-shell')).toBeVisible();
 await page.reload();await expect(page.locator('.lx-shell')).toBeVisible();
 expect(requests.some(u=>u.includes('/studio-api.js'))).toBe(false);expect(audit.traffic).toEqual([]);expect(audit.errors).toEqual([]);
});

test('Upload uses a bundled original through queued, processing and ready, then opens in chat',async({page})=>{
 const audit=await start(page);await page.getByRole('button',{name:'Upload',exact:true}).first().click();await expect(page.locator('input[type=file]')).toHaveCount(0);
 await page.locator('[data-sample-file=memo]').click();const row=page.locator('[data-file-id]').filter({hasText:'Customer research memo.docx'});
 await expect(row).toContainText('Queued');await expect(row).toContainText('Processing');await expect(row).toContainText('Ready');
 await page.reload();await page.locator('[data-open=memo]').first().click();await expect(page.locator('.original-docx section.docx')).toBeVisible();
 await page.getByRole('button',{name:'Customer findings',exact:true}).click();await expect(page.locator('.message.assistant')).toContainText('twelve sample customers');
 expect(audit.traffic).toEqual([]);expect(audit.errors).toEqual([]);
});

test('Excel and PowerPoint load their real original-file renderers with precise anchors',async({page})=>{
 const audit=await start(page,'demo.html?desk=cash&space=org');
 await expect(page.locator('.original-xlsx')).toBeVisible();await expect(page.locator('#paper-viewport')).not.toContainText('EXTRACTED DOCUMENT TEXT');
 await page.getByRole('button',{name:'Cash position',exact:true}).click();await page.locator('[data-citation]').first().click();await expect(page.locator('.original-xlsx .current-citation').first()).toBeVisible();
 await page.getByRole('link',{name:'Back to Home',exact:true}).click();await page.locator('button.lx-name[data-folder=review]').click();await page.locator('[data-open=board]').first().click();
 await expect(page.locator('.original-pptx')).toBeVisible();await page.getByRole('button',{name:'Board decision',exact:true}).click();await page.locator('[data-citation]').first().click();await expect(page.locator('.original-pptx .current-citation').first()).toBeVisible();
 expect(audit.traffic).toEqual([]);expect(audit.errors).toEqual([]);
});

test('shared notes, revisions, kept citations and original-text highlights persist locally',async({page})=>{
 const audit=await start(page);await annual(page);await page.getByRole('button',{name:'Revenue growth',exact:true}).click();await expect(page.locator('[data-citation]')).toHaveCount(2);await page.locator('#keep-citations').click();await expect(page.locator('.highlight-card')).toHaveCount(2);
 await page.locator('#notes-editor').fill('Review the revenue evidence.');await page.locator('#save-changes').click();await expect(page.locator('#save-state')).toHaveText('All changes saved');
 await page.locator('#notes-editor').fill('Discuss the cost risks.');await page.locator('#save-changes').click();await expect(page.locator('#save-state')).toHaveText('All changes saved');
 await page.locator('#notes-history').click();await page.locator('[data-note-revision="1"]').click();await page.locator('#restore-revision').click();await expect(page.locator('#notes-editor')).toHaveValue('Review the revenue evidence.');
 await page.locator('[data-dx-pop="tools"]').click();await page.locator('#highlight-tool').click();await page.locator('.original-docx').evaluate(root=>{const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);while(w.nextNode()){const n=w.currentNode,i=n.textContent!.indexOf('Net revenue retention reached 118%');if(i>=0){const r=document.createRange();r.setStart(n,i);r.setEnd(n,i+33);const s=getSelection()!;s.removeAllRanges();s.addRange(r);document.querySelector('#paper')!.dispatchEvent(new Event('pointerup',{bubbles:true}));break;}}});await expect(page.locator('.highlight-card')).toHaveCount(3);
 await page.reload();await expect(page.locator('#notes-editor')).toHaveValue('Review the revenue evidence.');await expect(page.locator('.highlight-card')).toHaveCount(3);
 await page.locator('[data-dx-tab="hls"]').click();await page.locator('[data-delete-annotation]').last().click();await expect(page.locator('.highlight-card')).toHaveCount(2);await page.reload();await expect(page.locator('.highlight-card')).toHaveCount(2);
 expect(audit.traffic).toEqual([]);expect(audit.errors).toEqual([]);
});

test('personal files and arbitrary questions cannot invoke a backend; reset preserves real auth',async({page})=>{
 await page.addInitScript(()=>{localStorage.setItem('rag.jwt','keep-real-token');sessionStorage.setItem('other-session','keep');});const audit=await start(page);
 const rejection=await page.evaluate(async()=>{try{await (window as any).CitelyAPI.startUpload(new File(['private'],'secret.docx'));return 'failed';}catch(e){return (e as Error).message;}});expect(rejection).toContain('Only bundled sample');
 await annual(page);await page.getByLabel('Message Citely').fill('Find my private bank records online');await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(page.locator('.message.assistant')).toContainText('No question is sent');
 page.on('dialog',d=>d.accept());await page.locator('button.dx-avatar').click();await page.locator('#dx-pop-account [data-demo-reset]').click();await expect(page.locator('.lx-shell')).toBeVisible();expect(await page.evaluate(()=>localStorage.getItem('rag.jwt'))).toBe('keep-real-token');expect(await page.evaluate(()=>sessionStorage.getItem('other-session'))).toBe('keep');expect(audit.traffic).toEqual([]);
});

for(const width of [390,1440])for(const mode of ['light','dark'])test(`real demo layout and original viewer at ${width}px ${mode}`,async({page})=>{
 await page.setViewportSize({width,height:1000});await page.addInitScript(t=>localStorage.setItem('citely-modernist-mode',t),mode);const audit=await start(page);await expect(page.getByRole('button',{name:'Grid view',exact:true})).toBeInViewport();expect(await page.getByRole('button',{name:'Grid view',exact:true}).evaluate(e=>e.getBoundingClientRect().right<=innerWidth)).toBe(true);await mkdir('/tmp/citely-real-demo-preview',{recursive:true});await page.screenshot({path:`/tmp/citely-real-demo-preview/home-${width}-${mode}.png`});
 await annual(page);if(width<760)await page.locator('#dx-tgl-left').click();await page.getByRole('button',{name:'Revenue growth',exact:true}).click();await page.locator('[data-citation]').first().click();await expect(page.locator('.original-docx mark.current-citation')).toBeVisible();
 await page.screenshot({path:`/tmp/citely-real-demo-preview/workspace-${width}-${mode}.png`});
 if(width<760){await page.locator('#dx-tgl-right').click();await expect(page.locator('#notes-editor')).toBeVisible();await page.locator('#dx-tgl-left').click();await expect(page.locator('#message-input')).toBeVisible();}
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(audit.errors).toEqual([]);expect(audit.traffic).toEqual([]);
});

test('homepage embeds the shared app and offers an uncluttered full-size demo',async({page})=>{
 await page.goto('');await page.getByTestId('sample-demo').scrollIntoViewIfNeeded();await page.getByRole('button',{name:'Open full demo ↗'}).click();await expect(page.getByRole('dialog')).toContainText('synthetic documents');await expect(page.getByRole('link',{name:'Continue to full demo →'})).toHaveAttribute('href',base()+'demo.html');
});

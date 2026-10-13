// Capture the real frontend with fictional sample data. Never reads a user account.
import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const preview = process.env.PREVIEW_URL || 'http://127.0.0.1:4175/dev/';
const output = new URL('../public/screenshots/', import.meta.url);
await mkdir(output, {recursive:true});
const text = 'COMMUNITY GARDEN PLAN\n\nA shared space to grow, learn and meet.\n\nThe community garden will open in October. Volunteer sessions will take place every Saturday morning.\n\nThe first phase includes preparing the soil, building six raised beds and planting seasonal vegetables. Each bed will have a clearly labelled crop plan.\n\nWatering and maintenance\n\nA weekly rota will cover watering and path maintenance. Rainwater collected in two storage tanks will supplement the main supply.\n\nNext steps\n\nConfirm the planting calendar, invite volunteers and prepare a simple checklist for the opening day. The team will review progress at the end of each month.';
const quote = 'The community garden will open in October. Volunteer sessions will take place every Saturday morning.';
const start = text.indexOf(quote);
const sources = [{citation_id:'garden-opening',document_id:'garden',filename:'Community garden plan.txt',page:1,page_char_start:start,page_char_end:start+quote.length,quote,content:quote,extraction_version:'v1',offset_unit:'utf16',evidence_role:'cited'}];
const docs = ['Community garden plan.txt','Volunteer checklist.md','Planting schedule.csv'].map((filename,i)=>({id:i?'sample-'+i:'garden',filename,pages:1,ingested_at:'2026-09-20'}));
const browser = await chromium.launch();
try {
  for (const theme of ['light','dark']) {
    const page = await browser.newPage({viewport:{width:1600,height:1000},deviceScaleFactor:1,reducedMotion:'reduce'});
    await page.addInitScript(mode=>{
      localStorage.setItem('citely-modernist-mode',mode);
      localStorage.setItem('rag.jwt','e30.'+btoa(JSON.stringify({exp:9999999999}))+'.sample');
      localStorage.setItem('rag.user',JSON.stringify({id:'sample-owner',name:'Sample workspace',email:'demo@example.com',privacyPolicyAccepted:true}));
    },theme);
    const records = new Map([['catalog',{value:{orgs:[{id:'personal',name:'Personal',spaces:[{id:'org',name:'Garden project',folders:[],docs:docs.map(d=>({...d,name:d.filename,status:'Ready',folder:null}))}]}]},revision:1}]]);
    let notes = '';
    await page.route('**/*',async route=>{
      const req=route.request(), url=new URL(req.url());
      if(url.origin===new URL(preview).origin)return route.continue();
      if(!/(127\.0\.0\.1:8000|localhost:8000|rag-api-staging\.)/.test(url.host))return route.abort();
      const path=decodeURIComponent(url.pathname);let data={};
      if(path==='/health'||path==='/warmup')data={status:'ok'};
      else if(path==='/documents')data=docs;
      else if(path.endsWith('/pages'))data=[{page:1,text,extraction_version:'v1'}];
      else if(path.endsWith('/history'))data=[{id:'sample-answer',question:'When does the garden open, and how can volunteers help?',answer:'The garden opens in October. Volunteers can join every Saturday morning to help prepare the garden and care for the plants.',sources,created_at:'2026-09-20T09:00:00Z'}];
      else if(path.startsWith('/state/')){
        const key=path.slice(7);data=records.get(key)||{value:null,revision:0};
        if(req.method()==='PUT'){data={value:req.postDataJSON().value,revision:data.revision+1};records.set(key,data);}
      }
      else if(path.endsWith('/annotations'))data=[];
      else if(path.endsWith('/notes'))data={content:notes,revision:notes?1:0,conversation_id:'org:garden',workspace_id:'org'};
      else throw Error('Unexpected screenshot API request: '+path);
      return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    });
    const capture = async name => {
      await page.addStyleTag({content:'*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}'});
      if(name!=='library') {
        await expect(page.locator('[data-page-text]')).toHaveText(text);
        await page.locator('.paper').evaluate(el => { el.parentElement.scrollTop = 0; });
      }
      await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
      await page.screenshot({path:new URL(`${name}-${theme}.jpg`,output).pathname,type:'jpeg',quality:88});
    };
    await page.goto(new URL('studio.html?space=org',preview).href);
    await expect(page.locator('#file-items')).toContainText('Community garden plan.txt');
    await capture('library');
    await page.goto(new URL('studio.html?desk=garden&space=org',preview).href);
    await expect(page.locator('#notes-editor')).toBeEnabled();
    await expect(page.locator('[data-citation]')).toHaveCount(1);
    await capture('document-chat');
    await page.locator('[data-citation]').click();
    await expect(page.locator('.current-citation')).toHaveText(quote);
    await capture('source-citation');
    notes='OPENING DAY\n\n• October opening; Saturday morning volunteer sessions.\n• Confirm the planting calendar.\n• Prepare the volunteer checklist.\n\nSOURCE CHECK\nOpening date and volunteer schedule checked against page 1 of the garden plan.';
    await page.reload();
    await expect(page.locator('#notes-editor')).toHaveValue(notes);
    await page.locator('[data-citation]').click();
    await capture('workspace');
    await page.close();
  }
} finally {await browser.close();}
console.log('Captured eight product screenshots using fictional sample documents.');

// Read-only deployed UI probe. ALL API calls are intercepted with disposable
// responses; no live account is used and no backend data is mutated.
const {chromium}=require('../Citely-Modernist-Next-Final/node_modules/playwright');
(async()=>{
 const browser=await chromium.launch();const page=await browser.newPage();
 const records=new Map();let completed=false,polls=0,navigations=0;
 await page.addInitScript(()=>{localStorage.setItem('rag.jwt','e30.'+btoa(JSON.stringify({exp:9999999999}))+'.fixture');localStorage.setItem('rag.user',JSON.stringify({id:'disposable',email:'fixture@example.invalid',privacyPolicyAccepted:true}));});
 await page.route(/rag-api-staging\./,async route=>{
  const req=route.request(),path=decodeURIComponent(new URL(req.url()).pathname);let data={};
  if(path.startsWith('/state/')){const old=records.get(path)||{value:null,revision:0};if(req.method()==='PUT'){data={value:req.postDataJSON().value,revision:old.revision+1};records.set(path,data)}else data=old;}
  else if(path==='/documents')data=completed?[{id:'disposable-doc',filename:'disposable-status.txt',pages:1,ingested_at:'2026-09-20'}]:[];
  else if(path==='/ingest/async')data={job_id:'disposable-job',status:'queued'};
  else if(path.includes('/ingest/jobs/')){polls++;completed=true;data={job_id:'disposable-job',status:'succeeded',result:{document_id:'disposable-doc',pages:1}};}
  else if(!['/health','/ready','/warmup'].includes(path))throw Error('Unexpected API path '+path);
  await route.fulfill({json:data});
 });
 await page.goto('https://citely.example/dev/studio.html');await page.locator('#file-search').waitFor();
 page.on('framenavigated',f=>{if(f===page.mainFrame())navigations++});
 await page.evaluate(()=>{window.probeRoot=document.querySelector('.library-shell');window.rootReplacements=0;new MutationObserver(records=>{window.rootReplacements+=records.filter(r=>r.target.id==='root'&&r.type==='childList').length}).observe(document.querySelector('#root'),{childList:true});});
 await page.locator('[data-upload]').first().click();await page.locator('#upload-input').setInputFiles({name:'disposable-status.txt',mimeType:'text/plain',buffer:Buffer.from('Disposable upload status diagnostic.')});
 await page.getByRole('button',{name:'Open chat →',exact:true}).waitFor();
 console.log(JSON.stringify({browserNavigations:navigations,jobPolls:polls,...await page.evaluate(()=>({rootReplacements:window.rootReplacements,sameWorkspaceNode:window.probeRoot===document.querySelector('.library-shell')}))}));
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});

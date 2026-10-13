// Replay a diagnostic's actual generated answers in the deployed reader.
// All API requests use disposable intercepted responses; no live account writes.
// Usage: node scripts/verify_citely_answers.cjs REPORT.json SYNOPSIS.docx OUTPUT_DIR
const {chromium}=require('../Citely-Modernist-Next-Final/node_modules/playwright');
const {execFileSync}=require('child_process');
const fs=require('fs'),path=require('path'),assert=require('assert');

(async()=>{
  const [reportPath,documentPath,outputDir]=process.argv.slice(2);
  if(!outputDir)throw Error('Expected report, DOCX and output directory');
  const report=JSON.parse(fs.readFileSync(reportPath,'utf8'));
  assert(report.parser_limit?.includes('local DOCX XML'),'Only local XML diagnostic pages can be reproduced here');
  const text=execFileSync(path.resolve('.venv/bin/python'),['-c',
    "import sys,zipfile,xml.etree.ElementTree as E; z=zipfile.ZipFile(sys.argv[1]); root=E.fromstring(z.read('word/document.xml')); sys.stdout.write('\\n'.join(''.join(p.itertext()) for p in root.findall('.//w:p',{'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'})))",
    documentPath],{encoding:'utf8'});
  fs.mkdirSync(outputDir,{recursive:true});
  const browser=await chromium.launch();
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    const id=report.document_id,version=report.extraction_versions[0];
    let current;
    await page.addInitScript(()=>{
      localStorage.setItem('rag.jwt','e30.'+btoa(JSON.stringify({exp:9999999999}))+'.fixture');
      localStorage.setItem('rag.user',JSON.stringify({id:'disposable',email:'fixture@example.invalid',privacyPolicyAccepted:true}));
    });
    await page.route(/(?:rag-api-staging\.|127\.0\.0\.1:8000)/,async route=>{
      const pathname=decodeURIComponent(new URL(route.request().url()).pathname);let data;
      if(pathname==='/documents')data=[{id,filename:path.basename(documentPath),pages:1,ingested_at:'2026-09-20'}];
      else if(pathname.endsWith('/history'))data=[{id:'answer',question:current.question,answer:current.response.answer,sources:current.response.sources,created_at:'2026-09-20T00:00:00Z'}];
      else if(pathname.endsWith('/pages'))data=[{page:1,text,extraction_version:version}];
      else if(pathname.startsWith('/state/'))data=route.request().method()==='PUT'?{revision:1}:{value:null,revision:0};
      else if(pathname.endsWith('/notes'))data={content:'',revision:0};
      else if(pathname.endsWith('/annotations'))data=[];
      else if(['/health','/ready','/warmup'].includes(pathname))data={status:'ok',ready:true,readiness:'ready'};
      else throw Error('Unexpected API route '+pathname);
      await route.fulfill({json:data});
    });
    const results=[];
    for(const [index,run] of report.runs.entries()){
      current=run;
      await page.goto((process.env.PREVIEW_URL||'https://citely.example/dev/')+'studio.html?desk='+id+'&space=org');
      await page.locator('[data-page-text]').waitFor();
      await page.waitForFunction(()=>document.querySelector('#notes-editor')&&!document.querySelector('#notes-editor').disabled);
      assert.equal(await page.locator('[data-page-text]').textContent(),text);
      assert.equal(await page.locator('[data-citation]').count(),run.response.sources.length);
      let clicks=0;
      for(const source of run.response.sources){
        assert.equal(source.offset_unit,'utf16');
        assert.equal(source.extraction_version,version);
        assert(Number.isInteger(source.page_char_start)&&Number.isInteger(source.page_char_end));
        assert.equal(text.slice(source.page_char_start,source.page_char_end),source.quote);
        assert(source.page_char_end-source.page_char_start<text.length);
        await page.locator('[data-citation="'+source.citation_id+'"]').click();
        await page.waitForFunction(quote=>Array.from(document.querySelectorAll('.current-citation')).map(n=>n.textContent).join('')===quote,source.quote);
        assert.equal(await page.locator('[data-citation][aria-pressed=true]').count(),1);
        clicks++;
      }
      await page.waitForTimeout(400); // let existing entrance/scroll animations settle
      const screenshot=path.join(outputDir,'answer-'+String(index+1).padStart(2,'0')+'.png');
      await page.screenshot({path:screenshot,fullPage:true});
      results.push({question:run.question,citations:run.response.sources.length,exact_clicks:clicks,screenshot});
    }
    const summary={runs:results.length,exact_citation_clicks:results.reduce((n,r)=>n+r.exact_clicks,0),results};
    fs.writeFileSync(path.join(outputDir,'results.json'),JSON.stringify(summary,null,2));
    console.log(JSON.stringify(summary));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});

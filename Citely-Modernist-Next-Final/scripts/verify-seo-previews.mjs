import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { PUBLIC_ROUTES } from '../lib/seo-data.mjs';
const [root, evidence, baseline] = process.argv.slice(2);
if(!root||!evidence) throw Error('Usage: verify-seo-previews.mjs BUILD_ROOT EVIDENCE_DIR [BASELINE_OUT]');
await mkdir(evidence,{recursive:true});
const privateRoutes=['/privacy/','/signin/','/forgot-password/','/reset-password/','/verify-email/','/auth/callback/','/home/','/workbench/'];
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.mp4':'video/mp4','.xml':'application/xml','.txt':'text/plain'};
const server=http.createServer(async(req,res)=>{try{
  let p=decodeURIComponent(new URL(req.url,'http://localhost').pathname),dir=path.join(root,'production','out');
  if(p.startsWith('/dev/')){p=p.slice(4);dir=path.join(root,'dev','out');}
  let file=path.resolve(dir,'.'+p);if(!file.startsWith(dir+path.sep)&&file!==dir)throw Error();
  if((await stat(file)).isDirectory())file=path.join(file,'index.html');
  res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');res.end(await readFile(file));
}catch{res.writeHead(404);res.end('Not found');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const baselineServer=baseline?http.createServer(async(req,res)=>{try{
  const p=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  let file=path.resolve(baseline,'.'+p);if(!file.startsWith(baseline+path.sep)&&file!==baseline)throw Error();
  if((await stat(file)).isDirectory())file=path.join(file,'index.html');
  res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');res.end(await readFile(file));
}catch{res.writeHead(404);res.end();}}):null;
if(baselineServer)await new Promise(resolve=>baselineServer.listen(0,'127.0.0.1',resolve));
const baselineOrigin=baselineServer?`http://127.0.0.1:${baselineServer.address().port}`:null;
const browser=await chromium.launch();
const results={artifacts:[],screenshots:[],noJavaScript:[],heroComparison:[]};
async function context(options={}) {
  const ctx=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',...options});
  // Deterministic local rendering; no auth/API calls or external account connections.
  await ctx.route('**/*',route=>[origin,baselineOrigin].filter(Boolean).some(base=>route.request().url().startsWith(base))?route.continue():route.abort());
  return ctx;
}
try {
  for(const [name,prefix] of [['production',''],['dev','/dev']]){
    const dir=path.join(root,name,'out'),robots=await readFile(path.join(dir,'robots.txt'),'utf8'),sitemap=await readFile(path.join(dir,'sitemap.xml'),'utf8');
    if(prefix){assert.match(robots,/Disallow: \//);assert.ok(!robots.includes('Sitemap:'));assert.ok(!sitemap.includes('<loc>'));}
    else {assert.match(robots,/Allow: \//);assert.ok(!robots.includes('Disallow:'));assert.match(robots,/Sitemap: https:\/\/citely.example\/sitemap.xml/);assert.deepEqual([...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(m=>m[1]),PUBLIC_ROUTES.map(r=>'https://citely.example'+r));}
    assert.ok(!sitemap.includes('lastmod'));
    const ctx=await context({javaScriptEnabled:false}),page=await ctx.newPage(),titles=new Set(),descriptions=new Set();
    for(const route of [...PUBLIC_ROUTES,...privateRoutes]){
      const html=await readFile(path.join(dir,route,'index.html'),'utf8');assert.ok(!html.includes('/dev/dev/'));
      const response=await page.goto(origin+prefix+route);assert.equal(response.status(),200);
      const actual=await page.evaluate(()=>({title:document.title,canonical:document.querySelector('link[rel="canonical"]')?.href,robots:document.querySelector('meta[name="robots"]')?.content,description:document.querySelector('meta[name="description"]')?.content,og:document.querySelector('meta[property="og:url"]')?.content,image:document.querySelector('meta[property="og:image"]')?.content,json:[...document.querySelectorAll('script[type="application/ld+json"]')].map(el=>JSON.parse(el.textContent)),h1:document.querySelectorAll('h1').length}));
      const url='https://citely.example'+prefix+route;
      assert.equal(actual.canonical,url);assert.equal(actual.og,url);assert.equal(actual.image,'https://citely.example'+prefix+'/og-default.png');
      assert.equal(actual.robots,prefix||privateRoutes.includes(route)?'noindex, nofollow':'index, follow');
      const checkUrls = value => {
        if(!value || typeof value!=='object') return;
        for(const [key,child] of Object.entries(value)) {
          if(['url','contentUrl','logo','@id','item'].includes(key) && typeof child==='string') assert.match(child,/^https?:\/\//);
          checkUrls(child);
        }
      };
      actual.json.forEach(checkUrls);
      if(PUBLIC_ROUTES.includes(route)){
        assert.equal(actual.h1,1);assert.ok(!titles.has(actual.title));titles.add(actual.title);assert.ok(!descriptions.has(actual.description));descriptions.add(actual.description);
        const assets=await page.locator('script[src],link[rel="stylesheet"],link[rel="icon"],img[src]').evaluateAll(els=>els.map(el=>el.src||el.href).filter(url=>url.startsWith(location.origin)));
        for(const asset of assets)assert.equal((await page.request.get(asset)).status(),200,asset);
      }
      if(route==='/'){
        const faq=actual.json.find(j=>j['@type']==='FAQPage');
        const visible=await page.locator('#faq details').evaluateAll(els=>els.map(el=>({q:el.querySelector('summary').childNodes[0].textContent.trim(),a:el.querySelector('p').textContent})));
        assert.deepEqual(faq.mainEntity.map(q=>({q:q.name,a:q.acceptedAnswer.text})),visible);
      }
      results.artifacts.push({shape:name,route,...actual});
    }
    await page.goto(origin+prefix+'/studio.html');assert.equal(await page.locator('meta[name="robots"]').getAttribute('content'),'noindex, nofollow');
    assert.equal((await page.request.get(origin+prefix+'/og-default.png')).status(),200);
    await ctx.close();
  }
  for(const [width,label] of [[1440,'desktop'],[768,'tablet'],[390,'mobile']])for(const theme of ['light','dark']){
    const ctx=await context({viewport:{width,height:1000}});await ctx.addInitScript(t=>localStorage.setItem('citely-modernist-mode',t),theme);
    const page=await ctx.newPage();
    for(const route of PUBLIC_ROUTES){
      await page.goto(origin+route);await page.locator('h1').waitFor();
      await page.addStyleTag({content:'*,*::before,*::after{animation:none!important;transition:none!important}.reveal{opacity:1!important;transform:none!important}'});
      assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${route} overflow ${width}`);
      // Exercise the actual marketing theme control, not the workspace's data-mode attribute.
      const toggle=page.locator('button.mode-switch').first();await toggle.click();await toggle.click();
      for(const screenshot of await page.locator('.product-screenshot > a:visible').all()) {
        const img=screenshot.locator('img');
        await img.scrollIntoViewIfNeeded();
        await img.evaluate(async el => {if(!el.complete)await new Promise((resolve,reject)=>{el.addEventListener('load',resolve,{once:true});el.addEventListener('error',reject,{once:true});});});
        assert.ok(await img.evaluate(el=>el.naturalWidth===1600 && el.naturalHeight===1000));
        assert.ok((await img.getAttribute('src')).endsWith(`-${theme}.jpg`));
        assert.equal(await screenshot.getAttribute('href'),await img.getAttribute('src'));
        assert.ok((await img.getAttribute('alt')).length>20);
      }
      await page.evaluate(()=>scrollTo(0,0));
      const file=`${route==='/'?'home':route.split('/').filter(Boolean).join('-')}-${label}-${theme}.png`;
      await page.screenshot({path:path.join(evidence,file),fullPage:true});results.screenshots.push(file);
      if(route==='/'&&baseline){
        const current=await page.locator('.hero-heading').screenshot();
        await writeFile(path.join(evidence,`current-hero-${label}-${theme}.png`),current);
        await page.goto(baselineOrigin+'/');await page.addStyleTag({content:'*,*::before,*::after{animation:none!important;transition:none!important}.reveal{opacity:1!important;transform:none!important}'});
        assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
        const before=await page.locator('.hero-heading').screenshot();
        await writeFile(path.join(evidence,`baseline-hero-${label}-${theme}.png`),before);
        results.heroComparison.push({width,theme,identical:current.equals(before)});
        // Record pixel equality; inspect differences before accepting a visual comparison.
      }
    }
    await ctx.close();
  }
  for(const theme of ['light','dark']){
    const ctx=await context({javaScriptEnabled:false,colorScheme:theme}),page=await ctx.newPage();
    for(const route of PUBLIC_ROUTES.filter(r=>r!='/')){
      await page.goto(origin+route);
      // JS-off users receive the legible default theme; also inspect dark CSS independently.
      if(theme==='dark')await page.evaluate(()=>document.documentElement.dataset.theme='dark');
      const legible=await page.locator('article h1, article h2, article p').evaluateAll(els=>els.every(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.visibility!=='hidden'&&s.display!=='none'&&Number(s.opacity)>0&&r.width>0&&r.height>0;}));
      assert.ok(legible);assert.equal(await page.locator('article .reveal').count(),0);
      results.noJavaScript.push({route,theme,legible});
    }
    await ctx.close();
  }
  await writeFile(path.join(evidence,'results.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify({metadataPages:results.artifacts.length,screenshots:results.screenshots.length,noJavaScript:results.noJavaScript.length,heroComparison:results.heroComparison},null,2));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));if(baselineServer)await new Promise(resolve=>baselineServer.close(resolve));}

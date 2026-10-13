import {test,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';

for(const width of [320,390,768,1024,1366,1440,1920,2560]) for(const theme of ['light','dark']) {
 test(`public layouts fit at 100% zoom: ${width}px ${theme}`,async({page,baseURL})=>{
  await page.setViewportSize({width,height:width===1366?768:900});
  await page.addInitScript(theme=>localStorage.setItem('citely-modernist-mode',theme),theme);
  const results=[];
  for(const route of ['', 'how-it-works/','features/document-chat/','features/source-citations/','about/','privacy/','try-demo/','signin/']) {
   await page.goto(new URL(route,baseURL!).href);
   await page.evaluate(()=>document.fonts.ready);
   const dims=await page.evaluate(()=>{
    // Do not let the body's overflow rule hide an actual layout problem.
    document.body.style.overflowX='visible';
    const hero=document.querySelector('.hero');const player=document.querySelector('.film-player');
    return {viewport:innerWidth,scroll:document.documentElement.scrollWidth,zoom:getComputedStyle(document.body).zoom,
     hero:hero?.getBoundingClientRect().width,headline:hero?parseFloat(getComputedStyle(hero.querySelector('h1')!).fontSize):undefined,
     film:player?.getBoundingClientRect().width,bodyFont:parseFloat(getComputedStyle(document.body).fontSize)};
   });
   expect(dims.scroll,route).toBeLessThanOrEqual(width+1);expect(dims.zoom).toBe('1');expect(dims.bodyFont).toBeGreaterThanOrEqual(16);
   if(route===''){
    expect(dims.hero!).toBeLessThanOrEqual(1280);expect(dims.film!).toBeLessThanOrEqual(1024);expect(dims.headline!).toBeLessThanOrEqual(104);
    if(width<=760){expect(await page.locator('.hero-divider').evaluate(el=>parseFloat(getComputedStyle(el).letterSpacing))).toBeGreaterThanOrEqual(0);}
    if(width>=1024){const heroCta=page.locator('.hero-ctas');expect((await heroCta.boundingBox())!.y+(await heroCta.boundingBox())!.height).toBeLessThan(768);}
   }
   if(route!=='signin/'){
    await expect(page.locator('.marketing-header')).toBeVisible();
    const cta=page.locator('.marketing-header').getByRole('link',{name:'Sign up'});await expect(cta).toBeInViewport();
   }
   results.push({route,...dims});
   if(['','try-demo/','how-it-works/'].includes(route)){
    await mkdir('/tmp/citely-layout-review',{recursive:true});
    await page.screenshot({path:`/tmp/citely-layout-review/after-${route?route.replaceAll('/','-'):'landing'}-${width}-${theme}.png`});
   }
  }
  await writeFile(`/tmp/citely-layout-review/metrics-${width}-${theme}.json`,JSON.stringify(results,null,2));
 });
}

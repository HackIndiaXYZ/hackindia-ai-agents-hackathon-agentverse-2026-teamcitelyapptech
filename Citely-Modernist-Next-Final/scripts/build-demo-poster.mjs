// Re-render the existing title-card composition with the approved Source Point SVG.
import {chromium} from '@playwright/test';
import {readFile} from 'node:fs/promises';
const logo=await readFile(new URL('../public/branding/citely-03-night.svg',import.meta.url));
const browser=await chromium.launch();
try {
  const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});
  await page.setContent(`<style>*{box-sizing:border-box}body{margin:0;background:#20201e repeating-linear-gradient(90deg,transparent 0 119px,#ffffff09 119px 121px);color:#f5f4ef;font-family:Arial,sans-serif}.label{position:absolute;font-size:18px;color:#b7b7ad}.top{left:93px;top:77px}.logo{position:absolute;left:455px;top:195px;width:720px;height:auto}.tagline{position:absolute;left:490px;top:477px;font-size:60px}.line{position:absolute;left:494px;top:584px;width:938px;height:6px;background:#e82b15}.detail{position:absolute;left:494px;top:650px;font-size:44px;color:#b7b7ad}.button{position:absolute;left:494px;top:771px;width:584px;height:86px;background:#e82b15;padding:19px 32px;font-size:34px;font-weight:bold}.button span{float:right;font-weight:normal}.foot{left:93px;bottom:90px}.right{right:98px;bottom:90px}</style><div class="label top">LESS SEARCHING. MORE KNOWING.</div><img class="logo" alt="Citely" src="data:image/svg+xml;base64,${logo.toString('base64')}"><div class="tagline">Grounded answers, cited.</div><div class="line"></div><div class="detail">Bring your files. Find your clarity.</div><div class="button">Explore the Citely demo <span>↗</span></div><div class="label foot">CITELY</div><div class="label right">PRODUCT PREVIEW · SAMPLE CONTENT</div>`);
  await page.locator('img').evaluate(el=>el.decode());
  await page.screenshot({path:new URL('../public/citely-demo-poster.jpg',import.meta.url).pathname,type:'jpeg',quality:90});
} finally {await browser.close();}

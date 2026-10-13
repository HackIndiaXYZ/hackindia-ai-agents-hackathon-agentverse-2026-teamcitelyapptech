import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PRODUCT_DEFINITION, TAGLINE } from '../lib/seo-data.mjs';
const tokens = await readFile(new URL('../styles/tokens.css',import.meta.url),'utf8');
const logo = await readFile(new URL('../public/branding/citely-02-evidence-accent.svg',import.meta.url),'utf8');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({viewport:{width:1200,height:630},deviceScaleFactor:1});
  await page.setContent(`<style>${tokens}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Arial,sans-serif;padding:64px}header{font-size:38px;font-weight:700;border-bottom:2px solid var(--ink);padding-bottom:26px}sup{color:var(--red)}h1{font-size:76px;letter-spacing:-4px;line-height:1.02;margin:48px 0 28px;max-width:950px}p{font-size:26px;line-height:1.4;max-width:940px}footer{font-size:18px;color:var(--red);margin-top:30px}</style><header><img alt="Citely" style="display:block;width:190px;height:72px;margin:-14px 0 -14px" src="data:image/svg+xml;base64,${Buffer.from(logo).toString('base64')}" /></header><h1>${TAGLINE}</h1><p>${PRODUCT_DEFINITION}</p><footer>CITELYAPP.TECH · AI DOCUMENT CHAT · BETA</footer>`);
  await page.screenshot({path:new URL('../public/og-default.png',import.meta.url).pathname});
} finally {await browser.close();}

import { test, expect } from '@playwright/test';
import { mockApi, signedIn } from './mock-api';
import { mkdir } from 'node:fs/promises';

for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
  test(`Source Point assets on ${theme} surfaces at ${width}px`, async ({page, baseURL}) => {
    await page.setViewportSize({width,height:1000});
    await page.addInitScript(value => localStorage.setItem('citely-modernist-mode', value), theme);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(baseURL!).origin ? route.continue() : route.abort());
    for (const route of ['', 'signin/', 'how-it-works/', 'features/source-citations/']) {
      await page.goto(new URL(route,baseURL!).href);
      for (const mark of await page.locator('.source-point:visible').all()) {
        const editorial = await mark.evaluate(el => !!el.closest('.auth-editorial'));
        const variant = editorial || theme === 'dark' ? 'dark' : 'light';
        await expect(mark.locator('img:visible')).toHaveCount(1);
        await expect(mark.locator(`.source-point-${variant}`)).toBeVisible();
        expect(await mark.locator('img:visible').evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth === 674)).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await mkdir('/tmp/citely-branding-previews', {recursive:true});
      if (route === '' || route === 'signin/') await page.screenshot({path:`/tmp/citely-branding-previews/${route ? 'signin' : 'landing'}-${width}-${theme}.png`,fullPage:false});
      const favicon = await page.locator('link[rel="icon"]').first().getAttribute('href');
      const icon = await page.request.get(new URL(favicon!,page.url()).href);
      expect(icon.ok()).toBe(true);
      expect(await icon.text()).toContain('Citely / App tile');
    }
    const manifest = await (await page.request.get(new URL('manifest.webmanifest',baseURL!).href)).json();
    for (const icon of manifest.icons) expect((await page.request.get(new URL(icon.src,baseURL!).href)).ok()).toBe(true);
    expect(errors).toEqual([]);
  });
}

test('server-rendered wordmark is visible without hydration',async ({browser,baseURL})=>{
  const context=await browser.newContext({javaScriptEnabled:false});
  const page=await context.newPage();
  await page.goto(baseURL!);
  await expect(page.locator('.marketing-header .source-point-light')).toBeVisible();
  await expect(page.locator('.marketing-header .source-point-dark')).toBeHidden();
  await context.close();
});

for (const width of [1440, 390]) test(`workspace brand switches both directions at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:1000});
  await signedIn(page); await mockApi(page);
  await page.addInitScript(()=>localStorage.setItem('citely-modernist-mode','dark'));
  await page.goto('studio.html?space=org');
  await expect(page.locator('#file-search')).toBeVisible();
  for (const mode of ['dark','light','dark']) {
    if (await page.locator('body').getAttribute('data-mode') !== mode) { await page.locator('[data-menu="avatar"]').click(); await page.locator(`[data-theme-choice="${mode}"]`).click(); await page.keyboard.press('Escape'); }
    await expect(page.locator('.brand .source-point-'+mode)).toBeVisible();
    await expect(page.locator('.brand .source-point img:visible')).toHaveCount(1);
    expect(await page.locator('.brand .source-point img:visible').evaluate((el:HTMLImageElement)=>el.naturalWidth)).toBe(674);
    await page.screenshot({path:`/tmp/citely-branding-previews/library-${width}-${mode}.png`});
  }
  await page.locator('button.lx-name[data-open="doc1"]').click();
  await expect(page.locator('#notes-editor')).toBeEnabled();
  if (width < 600) await page.locator('#dx-tgl-left').click();
  await page.locator('#message-input').fill('What does this document say?');
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(page.locator('.message .source-point-icon').first()).toBeVisible();
  await page.screenshot({path:`/tmp/citely-branding-previews/workspace-${width}.png`});
});

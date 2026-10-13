import { expect, test } from '@playwright/test';
// Where the build under test is served: /dev/ for the dev build, / for production.
const base=()=>new URL(test.info().project.use.baseURL!).pathname;

test('landing demo notice explains the boundary before opening the tour', async ({page}) => {
  await page.goto('');
  await page.getByTestId('sample-demo').scrollIntoViewIfNeeded();
  await page.getByRole('button',{name:'Open full demo ↗'}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog).toContainText('synthetic documents');
  await expect(dialog).toContainText('does not upload your files');
  const continueLink=dialog.getByRole('link',{name:'Continue to full demo →'});
  await expect(continueLink).toHaveAttribute('href',base()+'demo.html');
  await expect(continueLink).not.toHaveAttribute('target','_blank');
});

test('documentation is navigable and theme-aware on mobile', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await page.goto('documentation/');
  await expect(page.getByRole('heading',{name:'Understand the product. Follow the evidence.'})).toBeVisible();
  await expect(page.locator('.poster-card')).toHaveCount(16);
  // Shown as light 720px WebP copies; the link still opens the full-size PNG.
  await expect(page.locator('.poster-card img').first()).toHaveAttribute('src',/web\/Citely-D1-Intro\.webp$/);
  await expect(page.locator('.poster-card img').last()).toHaveAttribute('src',/web\/Citely-D6-3-Takeaway\.webp$/);
  await expect(page.locator('.poster-card > a').first()).toHaveAttribute('href',/building-in-public\/Citely-D1-Intro\.png$/);
  await page.getByRole('link',{name:'Document ingestion pipeline'}).first().click();
  await expect(page).toHaveURL(/documentation\/ingestion-pipeline\/$/);
  await expect(page.getByRole('heading',{name:'Document ingestion pipeline'})).toBeVisible();
  await page.getByRole('button',{name:'Switch to dark mode'}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await expect(page.locator('.docs-nav')).toBeVisible();
});

test('documentation routes and external social links are public', async ({page}) => {
  await page.goto('documentation/citations-annotations/');
  await expect(page.getByRole('heading',{name:'Citations, highlights and notes'})).toBeVisible();
  await expect(page.getByRole('link',{name:'Instagram ↗'})).toHaveAttribute('href','https://www.instagram.com/citely.example/');
  await expect(page.getByRole('link',{name:'Citely on X (Twitter)'})).toHaveAttribute('href','https://x.com/citely-example');
});

test('all supplied posters load at their full uncropped ratio',async({page})=>{
  await page.goto('documentation/');
  const posters=page.locator('.poster-card img');
  await expect(posters).toHaveCount(16);
  for(let index=0;index<16;index++){
    const poster=posters.nth(index);
    await poster.scrollIntoViewIfNeeded();
    await expect.poll(()=>poster.evaluate((image:HTMLImageElement)=>({natural:[image.naturalWidth,image.naturalHeight],fit:getComputedStyle(image).objectFit,ratio:Math.round(image.getBoundingClientRect().width/image.getBoundingClientRect().height*100)}))).toEqual({natural:[720,900],fit:'contain',ratio:80});
  }
});

test('full demo provides a same-tab route back to Citely',async({page})=>{
  await page.goto('demo.html');
  await page.locator('[data-menu="avatar"]').click();
  await expect(page.getByRole('link',{name:'Back to Citely'})).toHaveAttribute('href',base());
  await expect(page.getByRole('link',{name:'Back to Citely'})).toHaveAttribute('target','_top');
});

test('screenshots are light WebP copies; the one at the top loads straight away, the rest when near', async ({page}) => {
  await page.goto('documentation/');
  const top = page.locator('.product-screenshot').first();
  for (const theme of ['light', 'dark']) {
    const img = top.locator(`.product-screenshot-${theme} img`);
    await expect(img).toHaveAttribute('src', new RegExp(`screenshots/web/workspace-${theme}\\.webp$`));
    await expect(img).toHaveAttribute('loading', 'eager');
    await expect(img).toHaveAttribute('fetchpriority', 'high');
    await expect(top.locator(`a.product-screenshot-${theme}`)).toHaveAttribute('href', new RegExp(`screenshots/workspace-${theme}\\.jpg$`));
  }
  await page.goto('how-it-works/');
  const below = page.locator('.product-screenshot img');
  expect(await below.count()).toBeGreaterThan(0);
  for (const img of await below.all()) await expect(img).toHaveAttribute('loading', 'lazy');
});

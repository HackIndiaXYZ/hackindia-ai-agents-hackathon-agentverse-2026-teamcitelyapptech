import { test, expect } from '@playwright/test';

const routes = ['', 'privacy/', 'how-it-works/', 'features/document-chat/', 'features/source-citations/', 'about/'];
for (const width of [1440, 768, 390, 320]) {
  test(`shared marketing header, theme and Learn menu at ${width}px`, async ({page, baseURL}) => {
    await page.setViewportSize({width, height:900});
    const origin = new URL(baseURL!).origin;
    await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    for (const route of routes) {
      await page.goto(new URL(route, baseURL!).href);
      const header = page.locator('.marketing-header');
      await expect(header).toHaveCount(1);
      await expect(page.locator('.site-header')).toHaveCount(1);
      await expect(header.locator('.connectivity')).toHaveCount(0);
      const toggle = header.locator('button.mode-switch');
      await expect(toggle.locator('svg')).toBeVisible();
      const before = await page.locator('html').getAttribute('data-theme');
      await toggle.click();
      const after = before === 'dark' ? 'light' : 'dark';
      await expect(page.locator('html')).toHaveAttribute('data-theme', after);
      await expect(toggle).toHaveAttribute('aria-label', `Switch to ${before} mode`);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', after);
      const summary = header.locator('summary');
      await summary.focus();
      await page.keyboard.press('Enter');
      await expect(header.getByRole('link', {name:'Document chat',exact:true})).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(summary).toBeFocused();
      await expect(header.locator('details')).not.toHaveAttribute('open');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
    await page.locator('.learn-menu summary').click();
    await page.getByRole('link', {name:'Source citations',exact:true}).first().click();
    await expect(page).toHaveURL(/\/features\/source-citations\/$/);
    await expect(page.locator('.learn-menu')).not.toHaveAttribute('open');
  });
}

import {test, expect} from '@playwright/test';

/** Cloudflare Web Analytics loads only when the build has a site token
 *  (prod and dev deploys). Test and local builds have none, so nothing is
 *  counted and nothing is requested from Cloudflare. Which pages count is
 *  decided by countsPage() in components/WebAnalytics.tsx. */
test('builds without a site token load no analytics', async ({page}) => {
  const requested: string[] = [];
  page.on('request', r => { if (r.url().includes('cloudflareinsights')) requested.push(r.url()); });
  await page.route(/127\.0\.0\.1:8000/, r => r.fulfill({status: 503, body: '{}'}));
  for (const path of ['', 'documentation/', 'signin/']) {
    await page.goto(path);
    await page.waitForTimeout(300);
    await expect(page.locator('script[data-cf-beacon]')).toHaveCount(0);
  }
  expect(requested).toEqual([]);
});

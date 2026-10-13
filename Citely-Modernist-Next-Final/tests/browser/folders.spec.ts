import {test, expect} from '@playwright/test';
import {mockApi, signedIn} from './mock-api';

test.beforeEach(async ({page}) => { await signedIn(page); });

const savedFolders = (api: any) => api.records.get('catalog').value.orgs[0].spaces[0].folders.map((f: any) => f.name);

test('pressing Create twice during a slow save makes one folder and closes the dialog', async ({page}) => {
  const opts: any = {};
  const api = await mockApi(page, opts);
  await page.goto('studio.html?space=org');
  await expect(page.locator('#file-search')).toBeVisible();
  opts.catalogPutDelayMs = 1500;                                     // the mock reads its options live
  const putsBefore = api.log.filter(r => r.method === 'PUT' && r.path === '/state/catalog').length;
  await page.locator('[data-new-folder]').click();
  await page.locator('#folder-name').fill('aiml');
  await page.evaluate(() => { const f = document.querySelector<HTMLFormElement>('#folder-form')!; f.requestSubmit(); f.requestSubmit(); });
  await expect(page.locator('#folder-form button.primary')).toHaveText('Creating…');
  await expect(page.locator('#modal')).not.toBeVisible({timeout: 10000});
  await expect(page.locator('#folder-error')).toHaveText('');
  await expect(page.locator('#toast')).toHaveText('Folder created.');
  expect(savedFolders(api)).toEqual(['aiml']);
  expect(api.log.filter(r => r.method === 'PUT' && r.path === '/state/catalog').length - putsBefore).toBe(1);
});

test('a save that landed although its response was lost counts as created, not as an error', async ({page}) => {
  const opts: any = {};
  const api = await mockApi(page, opts);
  await page.goto('studio.html?space=org');
  await expect(page.locator('#file-search')).toBeVisible();
  opts.catalogPutLostOnce = true;
  await page.locator('[data-new-folder]').click();
  await page.locator('#folder-name').fill('aiml');
  await page.locator('#folder-form button.primary').click();
  await expect(page.locator('#modal')).not.toBeVisible({timeout: 10000});
  await expect(page.locator('#toast')).toHaveText('Folder created.');
  await expect(page.locator('#file-items')).toContainText('aiml');
  expect(savedFolders(api)).toEqual(['aiml']);
});

test('a save that really failed restores the dialog with an error', async ({page}) => {
  const api = await mockApi(page);
  await page.goto('studio.html?space=org');
  await expect(page.locator('#file-search')).toBeVisible();
  await page.route(/127\.0\.0\.1:8000\/state\/catalog/, r => r.request().method() === 'PUT' ? r.fulfill({status: 422, json: {detail: 'Catalog is too large.'}}) : r.fallback());
  await page.locator('[data-new-folder]').click();
  await page.locator('#folder-name').fill('aiml');
  await page.locator('#folder-form button.primary').click();
  await expect(page.locator('#folder-error')).toHaveText('Catalog is too large.');
  await expect(page.locator('#folder-form button.primary')).toHaveText('Create folder');
  await expect(page.locator('#folder-form button.primary')).toBeEnabled();
  expect(savedFolders(api)).toEqual([]);
});

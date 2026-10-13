import {test, expect} from '@playwright/test';
import {mockApi} from './mock-api';

// The "Review and approve" button in an access-request email opens this page
// on citely.example. Looking approves nobody; one press approves once.
test('approve page shows who it is for and approves once, on a press', async ({page}) => {
  await mockApi(page);
  let posts = 0, approved = false;
  await page.route(/\/access\/approval/, async route => {
    if (route.request().method() === 'GET') return route.fulfill({json: {email: 'judge@example.org', approved}});
    posts++;
    await new Promise(r => setTimeout(r, 300));
    const newly = !approved; approved = true;
    return route.fulfill({json: {email: 'judge@example.org', approved: true, newly}});
  });
  await page.goto('approve/?token=abc');
  await expect(page.getByRole('heading', {name: 'Approve access?'})).toBeVisible();
  await expect(page.locator('.approve-page')).toContainText('judge@example.org');
  expect(posts).toBe(0);
  await page.getByRole('button', {name: 'Approve'}).dblclick();
  await expect(page.getByRole('heading', {name: 'judge@example.org can now sign up.'})).toBeVisible();
  await expect(page.locator('.approve-page')).toContainText("We've emailed them the sign-up link.");
  expect(posts).toBe(1);
});

test('an expired or forged link explains instead of approving', async ({page}) => {
  await mockApi(page);
  let posts = 0;
  await page.route(/\/access\/approval/, route => {
    if (route.request().method() !== 'GET') posts++;
    return route.fulfill({status: 400, json: {detail: 'This approval link is invalid or has expired. Ask the person to request access again.'}});
  });
  await page.goto('approve/?token=forged');
  await expect(page.getByRole('heading', {name: 'This link can’t be used'})).toBeVisible();
  await expect(page.locator('.approve-page')).toContainText('invalid or has expired');
  await expect(page.getByRole('button', {name: 'Approve'})).toHaveCount(0);
  expect(posts).toBe(0);
});

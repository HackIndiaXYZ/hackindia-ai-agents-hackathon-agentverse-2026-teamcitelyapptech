import {test, expect} from '@playwright/test';
import {mockApi, signedIn} from './mock-api';

/** Who signs up how (personal mailboxes with Google/GitHub, work addresses
 *  with a password), who resets a work password (the admin), and the
 *  workspace telling the server when its tab is hidden or closed. */

test('sign-up says who uses what, and stops a personal address before anything is sent', async ({page}) => {
  const api = await mockApi(page);
  await page.goto('signin/?mode=signup');
  await expect(page.locator('.auth-policy')).toContainText('Personal email (Gmail, Outlook, iCloud…)? Continue with Google or GitHub.');
  await expect(page.locator('.auth-divider')).toHaveText('or sign up with a work email');
  await page.getByLabel('Email').fill('someone@gmail.com');
  await expect(page.locator('.auth-hint')).toContainText("That’s a personal address");
  await expect(page.getByRole('button', {name: /Create account/})).toBeDisabled();
  await page.getByLabel('Email').fill('someone@acme-corp.example');
  await expect(page.locator('.auth-hint')).toHaveCount(0);
  expect(api.log.filter(r => r.path === '/auth/signup')).toEqual([]);
  // Signing in is unchanged: no policy note, any address.
  await page.goto('signin/');
  await expect(page.locator('.auth-policy')).toHaveCount(0);
  await expect(page.locator('.auth-divider')).toHaveText('or continue with email');
});

test('a work address asking for a reset is told the administrator resets it', async ({page}) => {
  await page.route(/127\.0\.0\.1:8000\/auth\/request-password-reset/, r => r.fulfill({status: 202, json:
    {detail: 'Passwords for work accounts are reset by the Citely administrator. Ask them to send you a reset link.', admin_reset: true}}));
  await page.route(/127\.0\.0\.1:8000\/health/, r => r.fulfill({status: 200, json: {status: 'ok'}}));
  await page.goto('forgot-password/');
  await page.getByLabel('Email').fill('member@acme-corp.example');
  await page.getByRole('button', {name: /reset|Send/i}).click();
  await expect(page.locator('.auth-result')).toHaveText('Passwords for work accounts are reset by the Citely administrator. Ask them to send you a reset link.');
});

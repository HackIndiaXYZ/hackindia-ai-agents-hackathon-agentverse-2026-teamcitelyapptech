import {test, expect} from '@playwright/test';
import {mockApi} from './mock-api';

const fillLogin = async (page: any) => {
  await page.locator('#email').fill('person@example.com');
  await page.locator('#password').fill('Correct-horse-1');
};

test('login waits for a waking server, says so, and submits exactly once despite repeated presses', async ({page}) => {
  const api = await mockApi(page, {readySequence: [503, 503, 503, 200]});
  await page.goto('signin/?mode=signin');
  await fillLogin(page);
  // Three submits in quick succession, before React can disable the form.
  await page.evaluate(() => { const f = document.querySelector('form')!; for (let i = 0; i < 3; i++) f.requestSubmit(); });
  await expect(page.locator('[role=status].auth-result')).toContainText('Waking up the server');
  await page.waitForURL(/\/home\/?/, {timeout: 15000});
  const logins = api.log.filter(r => r.path === '/auth/login');
  expect(logins.length).toBe(1);
  const lastNotReady = Math.max(...api.log.filter(r => r.path === '/health' && r.status === 503).map(r => r.t));
  expect(logins[0].t).toBeGreaterThanOrEqual(lastNotReady);   // never sent before ready
});

test('login is retried once after a transient failure and succeeds', async ({page}) => {
  const api = await mockApi(page, {loginFailures: 1});
  await page.goto('signin/?mode=signin');
  await fillLogin(page);
  await page.locator('button.submit-button').click();
  await page.waitForURL(/\/home\/?/, {timeout: 15000});
  expect(api.log.filter(r => r.path === '/auth/login').length).toBe(2);
});

test('a wrong password is not retried', async ({page}) => {
  await mockApi(page);
  let attempts = 0;
  await page.route(/127\.0\.0\.1:8000\/auth\/login/, r => { attempts++; return r.fulfill({status: 401, json: {detail: 'Incorrect email or password'}}); });
  await page.goto('signin/?mode=signin');
  await fillLogin(page);
  await page.locator('button.submit-button').click();
  await expect(page.locator('[role=alert].auth-result')).toHaveText('Incorrect email or password');
  await page.waitForTimeout(500);
  expect(attempts).toBe(1);
});

test('the sign-up link opens account creation for anyone, says accounts are reviewed, and offers a guided demo', async ({page}) => {
  const api = await mockApi(page);
  await page.goto('signin/?mode=signup');
  await expect(page.getByRole('heading', {name: 'Create your account.'})).toBeVisible();
  await expect(page.getByText('Create your account. We review new accounts and email you as soon as you’re in.')).toBeVisible();
  await page.getByRole('button', {name: 'Already have an account? Log in'}).click();
  await expect(page.getByRole('link', {name: /Request demo access/})).toHaveAttribute('href', /try-demo/);
  expect(api.log.filter(r => r.path === '/auth/signup').length).toBe(0);
});

test('OAuth callback exchanges the single-use code only after the server is ready, exactly once', async ({page}) => {
  const api = await mockApi(page, {readySequence: [503, 503, 200]});
  await page.addInitScript(() => sessionStorage.setItem('rag.oauthState', 'google:abc'));
  await page.goto('auth/callback/?code=one-time-code&state=google:abc');
  // Signed in, the callback goes to /home/, which forwards straight on to the
  // workspace. Wait for arriving at either; waiting for /home/ to finish
  // loading raced that forward and timed out on fast machines.
  await page.waitForURL(/\/(home\/?|studio\.html)/, {timeout: 15000, waitUntil: 'commit'});
  const exchanges = api.log.filter(r => r.path === '/auth/google/callback');
  expect(exchanges.length).toBe(1);
  const readyOk = api.log.find(r => r.path === '/health' && r.status === 200)!.t;
  expect(exchanges[0].t).toBeGreaterThanOrEqual(readyOk);
});

test('sign-in does not wait for dependencies once the server answers', async ({page}) => {
  // The process is up (/health 200) but readiness is not: sign-in must go ahead.
  const api = await mockApi(page);
  // As the real backend answers while a dependency check is still pending.
  const notReady = {status: 'ok', ready: false, readiness: 'starting'};
  await page.route(/127\.0\.0\.1:8000\/health/, r => r.fulfill({status: 200, json: notReady}));
  await page.route(/127\.0\.0\.1:8000\/ready/, r => r.fulfill({status: 503, json: notReady}));
  await page.goto('signin/?mode=signin');
  await fillLogin(page);
  await page.locator('button.submit-button').click();
  await page.waitForURL(/\/home\/?/, {timeout: 10000});
  expect(api.log.filter(r => r.path === '/auth/login').length).toBe(1);
});

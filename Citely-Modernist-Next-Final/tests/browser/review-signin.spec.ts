import {test, expect} from '@playwright/test';
import {mockApi, signedIn, TRUSTED} from './mock-api';

/** Signed in: /home forwards to the workspace; wait until it has loaded there. */
const arrived = (page: any) => page.waitForURL(/studio\.html/);
/** Signed in once (not on every page load, unlike signedIn()), so a test can
 *  see Citely clear the session. */
const signInOnce = async (page: any) => {
  await page.goto('signin/');
  await page.evaluate(() => {
    localStorage.setItem('rag.jwt', 'e30.' + btoa(JSON.stringify({exp: 9999999999})) + '.test');
    localStorage.setItem('rag.user', JSON.stringify({id: 'test-owner', email: 'test@example.com', privacyPolicyAccepted: true}));
  });
};
const signIn = async (page: any) => {
  await page.getByLabel('Email').fill('test@example.com');
  await page.locator('input[type=password]').first().fill('Velvet-Harbor-73x');
  await page.getByRole('button', {name: /Log in/}).click();
};

test('an approved account confirms sign-in with the emailed code, and can trust this browser', async ({page}) => {
  const api = await mockApi(page, {account: {codeRequired: true}});
  await page.goto('signin/');
  await signIn(page);
  await expect(page.getByRole('heading', {name: 'Check your inbox.'})).toBeVisible();
  await expect(page.locator('.code-step')).toContainText('t••••@example.com');
  const trust = page.getByLabel('Trust this browser for 30 days');
  await expect(trust).toBeChecked();                                  // ticked by default
  await page.getByLabel('Sign-in code').fill('000000');
  await page.getByRole('button', {name: /Verify and sign in/}).click();
  await expect(page.locator('.code-step [role=alert]')).toContainText("That code isn't right");
  await page.getByLabel('Sign-in code').fill('123456');
  await page.getByRole('button', {name: /Verify and sign in/}).click();
  await arrived(page);
  const sent = api.log.find((r: any) => r.path === '/auth/login-code')!.body;
  expect(sent.trust_browser).toBe(true);
  expect(sent.browser_label).toMatch(/ on |Browser|Chrome|Firefox|Safari|Edge/);
  expect(await page.evaluate(() => localStorage.getItem('citely.trusted-browsers.v1'))).toContain(TRUSTED);
  // Next time from this browser: straight in, no code.
  await page.evaluate(() => { localStorage.removeItem('rag.jwt'); localStorage.removeItem('rag.user'); });
  await page.goto('signin/');
  await signIn(page);
  await arrived(page);
  const logins = api.log.filter((r: any) => r.path === '/auth/login');
  expect(logins.at(-1)!.body.trusted_browser).toBe(TRUSTED);
});

test('unticking trust keeps nothing on this browser; resend and "different account" work', async ({page}) => {
  const api = await mockApi(page, {account: {codeRequired: true}});
  await page.goto('signin/');
  await signIn(page);
  await expect(page.getByRole('button', {name: /Resend in \d+s/})).toBeDisabled();
  await page.getByRole('button', {name: 'Use a different account'}).click();
  await expect(page.getByRole('heading', {name: 'Back to better thinking.'})).toBeVisible();
  await signIn(page);
  await page.getByLabel('Trust this browser for 30 days').uncheck();
  await page.getByLabel('Sign-in code').fill('123456');
  await page.getByRole('button', {name: /Verify and sign in/}).click();
  await arrived(page);
  expect(api.log.find((r: any) => r.path === '/auth/login-code')!.body.trust_browser).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem('citely.trusted-browsers.v1'))).toBeNull();
});

test('Google sign-in asks for the code on the callback page when needed', async ({page}) => {
  await mockApi(page, {account: {codeRequired: true}});
  await page.addInitScript(() => sessionStorage.setItem('rag.oauthState', 'google:abc'));
  await page.goto('auth/callback/?code=one-time-code&state=google:abc');
  await expect(page.getByRole('heading', {name: 'Check your inbox.'})).toBeVisible();
  await expect(page.locator('.code-step')).toContainText('o••••@example.com');
});

for (const [status, heading] of [['pending', 'Your account is under review.'], ['declined', 'Your account wasn’t approved this time.']] as const) {
  test(`a ${status} account signs in to the review screen, with the demo and sign out`, async ({page}) => {
    await mockApi(page, {account: {status}});
    await page.goto('signin/');
    await signIn(page);
    await page.waitForURL(/\/review\/?/);
    await expect(page.getByRole('heading', {name: heading})).toBeVisible();
    await expect(page.getByRole('link', {name: /Try the demo/})).toHaveAttribute('href', /demo\.html$/);
    if (status === 'pending') {
      await expect(page.locator('.review-page')).toContainText('test@example.com');
      await expect(page.getByRole('button', {name: 'Check again'})).toBeVisible();
    } else {
      await expect(page.getByRole('button', {name: 'Check again'})).toHaveCount(0);
    }
    await page.getByRole('button', {name: 'Sign out'}).click();
    await page.waitForURL(/\/signin\/?/);
  });
}

test('an approved account opening the review screen goes on to the workspace', async ({page}) => {
  await signedIn(page);
  await mockApi(page);
  await page.goto('review/');
  await page.waitForURL(/\/(home\/?|studio\.html)/, {waitUntil: 'commit'});
});

test('a workspace refusing a pending account sends it to the review screen', async ({page}) => {
  await signedIn(page);
  await mockApi(page, {account: {status: 'pending', blocked: 'pending'}});
  await page.goto('studio.html?space=org');
  await page.waitForURL(/\/review\/?/);
  await expect(page.getByRole('heading', {name: 'Your account is under review.'})).toBeVisible();
});

test('a suspended account is signed out and told why', async ({page}) => {
  await mockApi(page, {account: {blocked: 'suspended'}});
  await signInOnce(page);
  await page.goto('studio.html?space=org');
  await page.waitForURL(/\/signin\/?/);
  await expect(page.locator('.auth-result[role=alert]')).toContainText('This account is suspended');
  expect(await page.evaluate(() => localStorage.getItem('rag.jwt'))).toBeNull();
});

test('the landing page offers Sign up and Request demo, in the hero and the header', async ({page}) => {
  await mockApi(page);
  await page.goto('');
  const hero = page.locator('.hero-ctas').first();
  await expect(hero.getByRole('link', {name: /Sign up/})).toHaveAttribute('href', /signin\/\?mode=signup$/);
  await expect(hero.getByRole('link', {name: /Request demo/})).toHaveAttribute('href', /try-demo\/$/);
  const header = page.locator('.marketing-header');
  await expect(header.getByRole('link', {name: /Sign up/})).toHaveAttribute('href', /signin\/\?mode=signup/);
  await expect(header.getByRole('link', {name: /Request demo/})).toHaveAttribute('href', /try-demo/);
});

test('trusted browsers can be reviewed and removed, and sign out everywhere ends every session', async ({page}) => {
  const api = await mockApi(page);
  await signInOnce(page);
  api.account.trusted.push({id: 'b1', label: 'Chrome on macOS', created_at: '2026-10-01T10:00:00Z', expires_at: '2026-10-31T10:00:00Z', last_used_at: null},
                          {id: 'b2', label: 'Safari on iOS', created_at: '2026-10-02T10:00:00Z', expires_at: '2026-11-01T10:00:00Z', last_used_at: null});
  await page.goto('studio.html?space=org');
  await expect(page.locator('#file-search')).toBeVisible();
  await page.locator('[data-menu="avatar"]').click();
  await page.getByRole('menuitem', {name: 'Trusted browsers'}).click();
  const dialog = page.locator('#modal');
  await expect(dialog).toContainText('Chrome on macOS');
  await expect(dialog).toContainText('Safari on iOS');
  await dialog.locator('[data-untrust="b1"]').click();
  await expect(dialog).not.toContainText('Chrome on macOS');
  page.on('dialog', d => d.accept());
  await dialog.getByRole('button', {name: 'Sign out everywhere'}).click();
  await page.waitForURL(/\/signin\/?/);
  expect(api.account.signedOutEverywhere).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('rag.jwt'))).toBeNull();
});

test('the approve page says it approves an existing account when there is one', async ({page}) => {
  await mockApi(page);
  let approved = false;
  await page.route(/\/access\/approval/, route => {
    if (route.request().method() === 'GET') return route.fulfill({json: {email: 'judge@example.org', approved, account: true}});
    approved = true;
    return route.fulfill({json: {email: 'judge@example.org', approved: true, newly: true, account: true}});
  });
  await page.goto('approve/?token=abc');
  await expect(page.getByRole('heading', {name: 'Approve this account?'})).toBeVisible();
  await page.getByRole('button', {name: 'Approve'}).click();
  await expect(page.getByRole('heading', {name: 'judge@example.org is approved.'})).toBeVisible();
  await expect(page.locator('.approve-page')).toContainText("We've emailed them that they can sign in.");
});

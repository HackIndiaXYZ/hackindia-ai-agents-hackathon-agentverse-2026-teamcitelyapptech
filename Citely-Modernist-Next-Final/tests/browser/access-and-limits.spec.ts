import {test, expect, Page} from '@playwright/test';
import {mockApi, signedIn} from './mock-api';

const STRONG = 'Velvet-Harbor-73x';

test.describe('creating an account', () => {
  test('the checklist guides the password, and the button waits for a strong one', async ({page}) => {
    await mockApi(page);
    await page.goto('signin/?mode=signup');
    await page.locator('#email').fill('judge@example.org');
    const create = page.getByRole('button', {name: /Create account/});
    await page.locator('#password').fill('password');
    await expect(page.locator('.password-meter b')).toHaveText('Too weak');
    await expect(page.locator('.password-checklist li.ok')).toHaveCount(2);   // not the email; no runs
    await expect(create).toBeDisabled();
    await page.locator('#password').fill(STRONG);
    await expect(page.locator('.password-meter b')).toHaveText('Strong');
    await expect(page.locator('.password-checklist li.ok')).toHaveCount(4);
    await expect(create).toBeEnabled();
    await expect(page.locator('[data-testid=turnstile]')).toHaveCount(0);     // no site key in this build
  });

  test('pressing Create account repeatedly sends one request, then asks for the code', async ({page}) => {
    const api = await mockApi(page);
    await page.goto('signin/?mode=signup');
    await page.locator('#email').fill(' judge@example.org ');
    await page.locator('#password').fill(STRONG);
    await page.evaluate(() => { const f = document.querySelector('form')!; for (let i = 0; i < 4; i++) f.requestSubmit(); });
    await page.waitForURL(/verify-email\/?\?email=judge%40example\.org/);
    const sent = api.log.filter(r => r.path === '/auth/signup');
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({email: 'judge@example.org', password: STRONG});
  });

  test("the server's reason is shown when it refuses", async ({page}) => {
    await mockApi(page);
    await page.route(/127\.0\.0\.1:8000\/auth\/signup/, r => r.fulfill({status: 400, json: {detail: "Temporary or disposable email addresses can't be used. Please use your regular email."}}));
    await page.goto('signin/?mode=signup');
    await page.locator('#email').fill('x@mailinator.com');
    await page.locator('#password').fill(STRONG);
    await page.getByRole('button', {name: /Create account/}).click();
    await expect(page.locator('[role=alert].auth-result')).toContainText('disposable email addresses');
    await expect(page).toHaveURL(/mode=signup/);
  });

  test('sign-in offers account creation to approved people', async ({page}) => {
    await mockApi(page);
    await page.goto('signin/');
    await page.getByRole('button', {name: 'New here? Create an account'}).click();
    await expect(page.getByRole('heading', {name: 'Create your account.'})).toBeVisible();
    await expect(page).toHaveURL(/mode=signup/);
  });

  test('a new password on reset gets the same checklist', async ({page}) => {
    await mockApi(page);
    await page.goto('reset-password/?email=judge%40example.org&token=' + 'x'.repeat(32));
    await page.locator('#password').fill('short');
    await expect(page.locator('.password-meter b')).toHaveText('Too weak');
  });
});

const limited = (questionsLeft: number, uploadsLeft: number, daily = false) => ({
  limited: true, max_upload_mb: 10, max_pages: 30,
  questions: {used: 5 - questionsLeft, limit: 5, remaining: questionsLeft, daily_exhausted: daily},
  uploads: {used: 3 - uploadsLeft, limit: 3, remaining: uploadsLeft, daily_exhausted: false},
});
const openDoc = (page: Page) => page.locator('button.lx-name[data-open="doc1"]').click();

test.describe('demo allowance in the workspace', () => {
  test.beforeEach(async ({page}) => { await signedIn(page); });

  test('questions and uploads left are shown', async ({page}) => {
    await mockApi(page, {usage: limited(4, 2)});
    await page.goto('studio.html?space=org');
    await expect(page.locator('#file-search')).toBeVisible();
    await expect(page.locator('.lx-side .usage-meter')).toHaveCount(0);       // shown in the Upload dialog, not the sidebar
    await page.locator('[data-upload]').first().click();
    const meter = page.locator('#modal .usage-meter');
    await expect(meter).toHaveText('2 of 3 demo uploads left · up to 10 MB and 30 pages each');
    await expect(meter.locator('.usage-bar i.used')).toHaveCount(1);
    await expect(meter.locator('.usage-bar i:not(.used)')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await openDoc(page);
    await expect(page.locator('.usage-note')).toHaveText('4 of 5 demo questions left');
    await expect(page.locator('#message-input')).toBeEnabled();
  });

  test('the bar and the words agree when the shared daily limit leaves fewer than the account owns', async ({page}) => {
    // This account has used none of its 3, but others took one of today's site-wide uploads: 2 are really left.
    await mockApi(page, {usage: {...limited(5, 3), uploads: {used: 0, limit: 3, remaining: 2, daily_exhausted: false}}});
    await page.goto('studio.html?space=org');
    await expect(page.locator('#file-search')).toBeVisible();
    await page.locator('[data-upload]').first().click();
    const meter = page.locator('#modal .usage-meter');
    await expect(meter).toContainText('2 of 3 demo uploads left');
    await expect(meter).toContainText("1 held back by the live demo's shared daily limit");
    await expect(meter.locator('.usage-bar i')).toHaveCount(3);
    await expect(meter.locator('.usage-bar i.used')).toHaveCount(0);
    await expect(meter.locator('.usage-bar i.capped')).toHaveCount(1);                           // 2 free + 1 held back = the 3 shown
    await expect(meter.locator('.usage-bar i:not(.used):not(.capped)')).toHaveCount(2);
  });

  test('after a reset, the questions counter says the shared daily limit is what holds it to 3', async ({page}) => {
    await mockApi(page, {usage: {...limited(5, 3), questions: {used: 0, limit: 5, remaining: 3, daily_exhausted: false}}});
    await page.goto('studio.html?space=org');
    await expect(page.locator('#file-search')).toBeVisible();
    await page.locator('.lx-tabs').getByRole('button', {name: 'Overview'}).click();
    await expect(page.locator('.ov-meter').filter({hasText: 'questions left'})).toContainText("2 held back by the live demo's shared daily limit");
    await page.locator('.lx-tabs').getByRole('button', {name: 'Files'}).click();
    await openDoc(page);
    await expect(page.locator('.usage-note')).toHaveText("3 of 5 demo questions left · 2 held back by the live demo's shared daily limit");
  });

  test('used, free and held back add up to the limit', async ({page}) => {
    await mockApi(page, {usage: {...limited(5, 3), uploads: {used: 1, limit: 3, remaining: 1, daily_exhausted: false}}});
    await page.goto('studio.html?space=org');
    await expect(page.locator('#file-search')).toBeVisible();
    await page.locator('[data-upload]').first().click();
    const meter = page.locator('#modal .usage-meter');
    await expect(meter).toContainText('1 of 3 demo uploads left');
    await expect(meter.locator('.usage-bar i.used')).toHaveCount(1);
    await expect(meter.locator('.usage-bar i.capped')).toHaveCount(1);
    await expect(meter.locator('.usage-bar i:not(.used):not(.capped)')).toHaveCount(1);
  });

  test('with no questions left, the box says thank you and nothing is sent', async ({page}) => {
    const api = await mockApi(page, {usage: limited(0, 2)});
    await page.goto('studio.html?space=org');
    await openDoc(page);
    await expect(page.locator('#message-input')).toBeDisabled();
    await expect(page.locator('#message-input')).toHaveAttribute('placeholder', "You've used all 5 questions in this demo. Thank you for trying Citely!");
    await expect(page.locator('.usage-note.exhausted')).toContainText('Thank you for trying Citely');
    expect(api.log.filter(r => r.path.startsWith('/query'))).toHaveLength(0);
  });

  test("today's limit across everyone is explained", async ({page}) => {
    // This person has used 2 of 5, but today's questions across everyone are gone.
    await mockApi(page, {usage: {...limited(3, 2), questions: {used: 2, limit: 5, remaining: 0, daily_exhausted: true}}});
    await page.goto('studio.html?space=org');
    await openDoc(page);
    await expect(page.locator('.usage-note')).toContainText("reached today's question limit");
  });

  test('a limit reached while asking shows the message and keeps the question', async ({page}) => {
    await mockApi(page, {usage: limited(1, 2), queryLimit: {header: 'question-account', message: "You've used all 5 questions in this demo. Thank you for trying Citely!"}});
    await page.goto('studio.html?space=org');
    await openDoc(page);
    await page.locator('#message-input').fill('One more question');
    await page.locator('#message-input').press('Enter');
    await expect(page.locator('#toast')).toHaveText("You've used all 5 questions in this demo. Thank you for trying Citely!");
    await expect(page.locator('#highlight-hint')).toContainText('Thank you for trying Citely');
  });

  test('with no uploads left, Upload explains instead of opening', async ({page}) => {
    await mockApi(page, {usage: limited(3, 0)});
    await page.goto('studio.html?space=org');
    await expect(page.locator('[data-upload]').first()).toHaveAttribute('data-exhausted', '');
    await page.locator('[data-upload]').first().click();
    await expect(page.locator('#toast')).toHaveText("You've used all 3 document uploads in this demo. Thank you for trying Citely!");
    await expect(page.locator('#upload-input')).toHaveCount(0);
  });

  test('selecting more files than are left adds only what is allowed', async ({page}) => {
    const api = await mockApi(page, {usage: limited(5, 1)});
    await page.goto('studio.html?space=org');
    await page.locator('[data-upload]').first().click();
    await page.locator('#upload-input').setInputFiles(['A', 'B', 'C'].map(n => ({name: `Deck ${n}.txt`, mimeType: 'text/plain', buffer: Buffer.from(('Source ' + n + '. ').repeat(40))})));
    await expect(page.locator('#toast')).toContainText('only the first one will be added');
    await expect.poll(() => api.ingested.length).toBe(1);
  });

  test('the admin (unlimited) sees no counters', async ({page}) => {
    await mockApi(page, {usage: {limited: false}});
    await page.goto('studio.html?space=org');
    await expect(page.locator('.usage-meter')).toHaveCount(0);
    await openDoc(page);
    await expect(page.locator('.usage-note')).toHaveCount(0);
  });
});

import {test, expect} from '@playwright/test';
import {mockApi, signedIn} from './mock-api';

/** While an answer is on its way, a Citely message with moving dots says so,
 *  and it is replaced by the answer (never left behind, never stacked). */
test('a working indicator shows until the answer arrives, and changes its words as time passes', async ({page}) => {
  await signedIn(page);
  await mockApi(page, {queryDelayMs: 3500});
  await page.goto('studio.html?space=org');
  await page.locator('button.lx-name[data-open="doc1"]').click();
  await page.locator('#message-input').fill('Give me a detailed summary');
  await page.locator('#message-input').press('Enter');
  const thinking = page.locator('#thinking');
  await expect(thinking).toBeVisible();
  await expect(thinking).toContainText('Finding evidence in your sources');
  await expect(thinking.locator('.thinking-dots i')).toHaveCount(3);
  await expect(page.locator('#thinking')).toHaveCount(1);                       // one, never stacked
  await expect(thinking).toBeHidden({timeout: 10_000});                          // the answer replaced it
  await expect(page.locator('.message.assistant').last()).not.toHaveClass(/message-thinking/);
  await expect(page.locator('#message-input')).toBeEnabled();
});

test('the working indicator is removed when the question fails', async ({page}) => {
  await signedIn(page);
  await mockApi(page, {queryDelayMs: 800, queryLimit: {header: 'question-account', message: "You've used all 5 questions in this demo. Thank you for trying Citely!"}});
  await page.goto('studio.html?space=org');
  await page.locator('button.lx-name[data-open="doc1"]').click();
  await page.locator('#message-input').fill('One more');
  await page.locator('#message-input').press('Enter');
  await expect(page.locator('#thinking')).toBeVisible();
  await expect(page.locator('#toast')).toContainText('Thank you for trying Citely');
  await expect(page.locator('#thinking')).toHaveCount(0);
});

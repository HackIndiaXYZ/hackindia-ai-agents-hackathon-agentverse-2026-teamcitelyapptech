import {test, expect} from '@playwright/test';
import {mockApi, signedIn} from './mock-api';

/** Answers in whatever shape the question asked for, rendered safely. */

const ASK = async (page: any, text = 'Summarise this') => {
  await page.locator('button.lx-name[data-open="doc1"]').click();
  await page.locator('#message-input').fill(text);
  await page.locator('#message-input').press('Enter');
};

test('bullets, numbers, tables and bold are drawn as such', async ({page}) => {
  await signedIn(page);
  await mockApi(page, {answer: ['The report covers **three** things:', '', '- First point', '- Second point', '', '1. Step one', '2. Step two', '',
    '| Risk | Impact |', '| --- | --- |', '| Delay | **High** |', '| Cost | Medium |', '', 'A closing line.'].join('\n')});
  await page.goto('studio.html?space=org');
  await ASK(page);
  const answer = page.locator('.message.assistant .message-body').last();
  await expect(answer.locator('ul > li')).toHaveText(['First point', 'Second point']);
  await expect(answer.locator('ol > li')).toHaveText(['Step one', 'Step two']);
  await expect(answer.locator('table thead th')).toHaveText(['Risk', 'Impact']);
  await expect(answer.locator('table tbody tr')).toHaveCount(2);
  await expect(answer.locator('table tbody tr').first().locator('td').nth(1).locator('strong')).toHaveText('High');
  await expect(answer.locator('p').first().locator('strong')).toHaveText('three');
  await expect(answer.locator('p').last()).toHaveText('A closing line.');
});

test('nothing in an answer can add markup', async ({page}) => {
  await signedIn(page);
  await mockApi(page, {answer: ['- <img src=x onerror="window.__pwned=1"> bullet', '', '| <script>window.__pwned=2</script> | b |', '| --- | --- |', '| <b onmouseover="window.__pwned=3">cell</b> | d |'].join('\n')});
  await page.goto('studio.html?space=org');
  await ASK(page);
  const answer = page.locator('.message.assistant .message-body').last();
  await expect(answer.locator('table')).toBeVisible();
  await expect(answer.locator('img, script, b')).toHaveCount(0);
  await expect(answer).toContainText('<img src=x onerror="window.__pwned=1"> bullet');
  expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
});

test('a half-written table or a stray pipe stays plain text', async ({page}) => {
  await signedIn(page);
  await mockApi(page, {answer: 'Option A | Option B\n\n| only a header |\n\nUse a pipe | like this.'});
  await page.goto('studio.html?space=org');
  await ASK(page);
  const answer = page.locator('.message.assistant .message-body').last();
  await expect(answer.locator('table')).toHaveCount(0);
  await expect(answer).toContainText('Option A | Option B');
  await expect(answer).toContainText('only a header');
});

test('headings, nested bullets of any kind, lettered lists and italics are drawn as such', async ({page}) => {
  await signedIn(page);
  await mockApi(page, {answer: ['## Key takeaways', '', '* OCR turns images into text', '  - Tesseract is one tool', '  - so is *PaddleOCR*', '• Prompting matters', '',
    'a) First option', 'b) Second option', '', '2 * 3 * 4 stays as it is', '', '---', 'The end.'].join('\n')});
  await page.goto('studio.html?space=org');
  await ASK(page);
  const answer = page.locator('.message.assistant .message-body').last();
  await expect(answer.locator('h4.md-h')).toHaveText('Key takeaways');
  await expect(answer.locator('> ul > li')).toHaveCount(2);
  await expect(answer.locator('> ul > li').first().locator('ul > li')).toHaveText(['Tesseract is one tool', 'so is PaddleOCR']);
  await expect(answer.locator('em')).toHaveText('PaddleOCR');
  await expect(answer.locator('ol[type="a"] > li')).toHaveText(['First option', 'Second option']);
  await expect(answer).toContainText('2 * 3 * 4 stays as it is');
  await expect(answer.locator('p').last()).toHaveText('The end.');
});

test('there is no format button: the format is whatever the question asks for', async ({page}) => {
  await signedIn(page);
  const api = await mockApi(page);
  await page.goto('studio.html?space=org');
  await page.locator('button.lx-name[data-open="doc1"]').click();
  await expect(page.locator('#message-input')).toBeVisible();
  await expect(page.locator('#chat-form .dx-boxrow button')).toHaveCount(1);              // only Send
  await expect(page.getByRole('button', {name: /answer format/i})).toHaveCount(0);
  await page.locator('#message-input').fill('Summarise this in 200 words as a table');
  await page.locator('#message-input').press('Enter');
  await expect.poll(() => api.log.filter(r => r.path === '/query/stream').length).toBe(1);
  const body = api.log.find(r => r.path === '/query/stream')!.body;
  expect(body.question).toBe('Summarise this in 200 words as a table');
  expect(body.answer_format).toBeUndefined();
  expect(body.target_words).toBeUndefined();
});


test('historical line breaks render safely inside table cells',async({page})=>{
 await signedIn(page);
 await mockApi(page,{answer:'| Step | Explanation |\n| --- | --- |\n| Divide | First<br>Second <img src=x onerror="window.__pwned=1"> |'});
 await page.goto('studio.html?space=org');await ASK(page);
 const answer=page.locator('.message.assistant .message-body').last();
 await expect(answer.locator('tbody tr')).toHaveCount(1);
 await expect(answer.locator('td br')).toHaveCount(1);
 await expect(answer.locator('img')).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).__pwned)).toBeUndefined();
});

test('a tall answer starts at the top of the chat so the reader begins at its beginning; a short one follows the bottom', async ({page}) => {
  await signedIn(page);
  const tall = ['Here is the full list:', ...Array.from({length: 60}, (_, i) => `- Item number ${i + 1} with some descriptive words to take up room`)].join('\n');
  await mockApi(page, {answer: tall});
  await page.goto('studio.html?space=org');
  await ASK(page, 'List everything');
  const region = page.locator('#messages');
  await expect(page.locator('.message.assistant:not(.message-thinking)').last()).toContainText('Here is the full list');
  await expect(page.locator('#thinking')).toHaveCount(0);
  const where = () => page.evaluate(() => {
    const r = document.querySelector('#messages')!.getBoundingClientRect(), a = [...document.querySelectorAll('.message.assistant:not(.message-thinking)')].pop()!.getBoundingClientRect();
    return {answerTop: Math.round(a.top - r.top), answerHeight: Math.round(a.height), paneHeight: Math.round(r.height)};
  });
  await expect.poll(async () => (await where()).answerTop).toBeGreaterThanOrEqual(0);       // its first line is in view, not cut off above
  const tallNow = await where();
  expect(tallNow.answerHeight).toBeGreaterThan(tallNow.paneHeight);                           // it really is taller than the pane
  expect(tallNow.answerTop).toBeLessThan(40);                                                 // and sits at the top of it
  await expect(region.getByText('Here is the full list')).toBeInViewport();
});

test('a short answer still follows the bottom of the chat', async ({page}) => {
  await signedIn(page);
  await mockApi(page, {answer: 'A short reply.'});
  await page.goto('studio.html?space=org');
  await ASK(page, 'Say something short');
  await expect(page.locator('.message.assistant:not(.message-thinking)').last()).toContainText('A short reply.');
  await expect.poll(() => page.evaluate(() => { const r = document.querySelector('#messages')!; return Math.round(r.scrollHeight - r.scrollTop - r.clientHeight); })).toBeLessThan(4);
});

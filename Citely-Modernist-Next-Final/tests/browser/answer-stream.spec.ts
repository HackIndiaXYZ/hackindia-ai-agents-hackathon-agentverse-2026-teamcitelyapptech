import {test, expect, Page} from '@playwright/test';
import {mockApi, signedIn} from './mock-api';

/** The answer shown while it is written. The stream is driven from the test,
 *  piece by piece, through the page's own fetch, so what the reader sees in
 *  between is checked, not just the end. */
async function controlledStream(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    const real = window.fetch.bind(window);
    w.__streams = [];
    window.fetch = (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.endsWith('/query/stream')) return real(input, init);
      let push!: (line: object) => void, end!: () => void;
      const body = new ReadableStream({start(c) {
        const enc = new TextEncoder();
        push = line => c.enqueue(enc.encode(JSON.stringify(line) + '\n'));
        end = () => c.close();
      }});
      w.__streams.push({push: (l: object) => push(l), end: () => end(), body: init?.body});
      return Promise.resolve(new Response(body, {status: 200, headers: {'Content-Type': 'application/x-ndjson'}}));
    };
  });
  return {
    send: (line: object) => page.evaluate(l => (window as any).__streams.at(-1).push(l), line),
    end: () => page.evaluate(() => (window as any).__streams.at(-1).end()),
    started: () => page.evaluate(() => (window as any).__streams.length),
  };
}

const ask = async (page: Page, text: string) => {
  await page.locator('button.lx-name[data-open="doc1"]').click();
  await page.locator('#message-input').fill(text);
  await page.locator('#message-input').press('Enter');
};
const done = (answer: string) => ({type: 'done', response: {request_id: 'r', answer, sources: [], model: 'm', collection_name: 'c'}});

test('the answer appears as it is written, then the checked final answer replaces it', async ({page}) => {
  await signedIn(page);
  await mockApi(page);
  const stream = await controlledStream(page);
  await page.goto('studio.html?space=org');
  await ask(page, 'Summarize the key takeaways.');
  await expect.poll(stream.started).toBe(1);
  const bubble = page.locator('#thinking');
  await expect(bubble).toContainText('Finding evidence in your sources');
  await stream.send({type: 'delta', text: 'The report covers OCR.'});
  await expect(bubble.locator('.draft-text')).toHaveText('The report covers OCR.');
  await expect(bubble).toHaveClass(/message-drafting/);
  await stream.send({type: 'delta', text: 'The report covers OCR.\n\n- Tesseract is one engine.\n- Prompting matters.'});
  await expect(bubble.locator('.draft-text li')).toHaveText(['Tesseract is one engine.', 'Prompting matters.']);
  await expect(page.locator('#message-input')).toBeDisabled();                      // still answering
  await stream.send(done('The report covers OCR [1].\n\n- Tesseract is one engine.\n- Prompting matters.\n- Evaluation needs labels.'));
  await stream.end();
  await expect(page.locator('#thinking')).toHaveCount(0);
  await expect(page.locator('.message.assistant .message-body').last().locator('li')).toHaveCount(3);
  await expect(page.locator('#message-input')).toBeEnabled();
});

test('a second attempt puts the bubble back to a status line', async ({page}) => {
  await signedIn(page);
  await mockApi(page);
  const stream = await controlledStream(page);
  await page.goto('studio.html?space=org');
  await ask(page, 'What engine is used?');
  await expect.poll(stream.started).toBe(1);
  await stream.send({type: 'delta', text: 'A first draft.'});
  await expect(page.locator('#thinking .draft-text')).toHaveText('A first draft.');
  await stream.send({type: 'reset'});
  await expect(page.locator('#thinking .draft-text')).toHaveCount(0);
  await expect(page.locator('#thinking')).toContainText('Checking the answer against the sources');
  await stream.send(done('Tesseract.'));
  await stream.end();
  await expect(page.locator('.message.assistant .message-body').last()).toHaveText('Tesseract.');
});

test('an error in the stream is shown and the question stays in the box', async ({page}) => {
  await signedIn(page);
  await mockApi(page);
  const stream = await controlledStream(page);
  await page.goto('studio.html?space=org');
  await ask(page, 'Anything?');
  await expect.poll(stream.started).toBe(1);
  await stream.send({type: 'delta', text: 'Half an answer.'});
  await stream.send({type: 'error', status: 404, detail: 'No index found for document doc1.'});
  await stream.end();
  await expect(page.locator('#toast')).toContainText('No index found for document doc1.');
  await expect(page.locator('#thinking')).toHaveCount(0);
  await expect(page.locator('#message-input')).toHaveValue('Anything?');
});

test('a stream cut off without a final answer says so', async ({page}) => {
  await signedIn(page);
  await mockApi(page);
  const stream = await controlledStream(page);
  await page.goto('studio.html?space=org');
  await ask(page, 'Anything?');
  await expect.poll(stream.started).toBe(1);
  await stream.send({type: 'delta', text: 'Half an answer.'});
  await stream.end();
  await expect(page.locator('#toast')).toContainText('The answer was interrupted. Please ask again.');
  await expect(page.locator('#thinking')).toHaveCount(0);
});

test('a server without the streaming route is asked the ordinary way', async ({page}) => {
  await signedIn(page);
  const api = await mockApi(page);
  await page.route(/\/query\/stream$/, route => route.fulfill({status: 404, contentType: 'application/json', headers: {'Access-Control-Allow-Origin': '*'}, body: JSON.stringify({detail: 'Not Found'})}));
  await page.goto('studio.html?space=org');
  await ask(page, 'Old server?');
  await expect(page.locator('.message.assistant .message-body').last()).toHaveText('ANSWER FOR doc1');
  expect(api.log.filter(r => r.path === '/query')).toHaveLength(1);
});

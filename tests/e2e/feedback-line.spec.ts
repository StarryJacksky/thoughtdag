import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

// A writer and a critic that read each other, in a real browser. The
// critic is asked under the writer's draft; a wire drawn from the critic
// back onto the writer would close a loop, and is made a feedback line: it
// holds the critique the critic has finished, says so on the canvas, and
// says when there is a newer one. The critic answering again asks the
// writer nothing; the writer asked again reads the newer critique, and the
// line moves to it.
//
// No model is called. Every request for an answer is answered by this file
// with a numbered draft or critique, by what the question asks for.

const MODEL = 'provider-a/model-one';
const asked: { question: string; text: string }[] = [];
let drafts = 0;
let critiques = 0;

test.use({ viewport: { width: 1600, height: 1000 } });

async function answering(page: Page) {
  asked.length = 0;
  drafts = 0;
  critiques = 0;
  await page.addInitScript(() => {
    localStorage.setItem('thoughtdag.seeded', 'yes');
    localStorage.setItem('thoughtdag.tutorialDone', '1');
  });
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'Access-Control-Allow-Origin': '*' } });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
    const url = new URL(request.url());
    if (url.pathname === '/api/models') {
      return json(route, { models: [{ id: MODEL, name: 'model-one', provider: 'provider-a', vision: false }], default: MODEL, capabilities: { webSearch: false, searchEngine: '', scholarSearch: false, vision: false } });
    }
    if (url.pathname === '/api/stream') {
      let body: { messages?: { role?: string; content?: unknown }[] } = {};
      try { body = JSON.parse(request.postData() ?? '{}'); } catch { /* not JSON */ }
      const messages = body.messages ?? [];
      const question = String(messages.filter((m) => m.role === 'user').at(-1)?.content ?? '');
      const text = JSON.stringify(messages);
      asked.push({ question, text });
      const answer = question.includes('C_TASK') ? `C_CRITIQUE_${++critiques}` : question.includes('W_TASK') ? `W_DRAFT_${++drafts}` : 'SOMETHING_ELSE';
      return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'Access-Control-Allow-Origin': '*' }, body: `data: ${JSON.stringify({ text: answer })}\n\ndata: [DONE]\n\n` });
    }
    // everything else the page asks its proxy for (summaries, recall, memory) gets nothing
    return json(route, {}, 404);
  });
}

const cardOf = (page: Page, text: string): Locator => page.locator('.react-flow__node', { hasText: text });
/** Wait until the canvas has stopped gliding: its pan and zoom are the same over three looks in a row. */
async function viewAtRest(page: Page) {
  const view = page.locator('.react-flow__viewport');
  let same = 0;
  let last = '';
  await page.waitForTimeout(200);
  for (let i = 0; i < 60 && same < 3; i++) {
    const now = (await view.getAttribute('style')) ?? '';
    same = now === last ? same + 1 : 0;
    last = now;
    await page.waitForTimeout(100);
  }
}
async function fit(page: Page) {
  await viewAtRest(page);
  await page.locator('.react-flow__controls-fitview').click();
  await viewAtRest(page);
}
/** Drag from a node's bottom handle and let go at a point, or on another node. */
async function dragWire(page: Page, from: Locator, to: Locator | { x: number; y: number }) {
  await viewAtRest(page);
  const handle = (await from.locator('.react-flow__handle[data-handleid="continue"]').boundingBox())!;
  const end = 'x' in to ? to : await (async () => { const box = (await to.boundingBox())!; return { x: box.x + box.width / 2, y: box.y + Math.min(60, box.height / 2) }; })();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 12, handle.y + handle.height / 2 + 12, { steps: 3 });
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
}
/** Ask a card's question again, with the button under its answer. */
async function askAgain(card: Locator) {
  await card.getByTitle('Regenerate', { exact: true }).click();
}

test('a wire that would close a loop is a feedback line: it holds the critique the writer reads, until the writer is asked again', async ({ page }) => {
  await answering(page);
  await page.goto('/');

  // the writer
  await page.getByPlaceholder('What would you like to explore?').fill('W_TASK: write the paragraph.');
  await page.keyboard.press('Enter');
  const writer = cardOf(page, 'W_TASK: write the paragraph.');
  await expect(writer).toContainText('W_DRAFT_1');

  // the critic, asked under the writer's draft: a wire from the writer let go on empty canvas
  for (let i = 0; i < 3; i++) await page.locator('.react-flow__controls-zoomout').click();
  await viewAtRest(page);
  const box = (await writer.boundingBox())!;
  await dragWire(page, writer, { x: box.x + box.width / 2, y: box.y + box.height + 220 });
  const empty = page.locator('.react-flow__node').filter({ has: page.getByPlaceholder('Type a question… whatever flows in along the edges is its context') });
  await expect(empty).toHaveCount(1);
  await empty.locator('textarea').fill('C_TASK: criticise the paragraph.');
  await empty.locator('textarea').press('Enter');
  const critic = cardOf(page, 'C_TASK: criticise the paragraph.');
  await expect(critic).toContainText('C_CRITIQUE_1');
  expect(asked.at(-1)!.text, 'the critic read the draft').toContain('W_DRAFT_1');

  // the critic wired back onto the writer: a feedback line holding the first critique, said so
  await fit(page);
  const before = asked.length;
  await dragWire(page, critic, writer);
  const label = page.locator('[data-feedback-edge]');
  await expect(label).toHaveCount(1);
  await expect(label).toHaveAttribute('data-feedback-edge', '0');
  await expect(label).toHaveText('Feedback · answer 1');
  await expect(page.getByText('so it was made as a feedback line')).toBeVisible();
  expect(asked.length, 'wiring asked nothing').toBe(before);

  // the critic answers again: the line says there is a newer critique, and the writer is not asked
  await askAgain(critic);
  await expect(critic).toContainText('C_CRITIQUE_2');
  await expect(label).toHaveAttribute('data-feedback-newer', 'true');
  await expect(label).toContainText('newer answer');
  await page.waitForTimeout(500);
  expect(asked.length, 'only the critic was asked').toBe(before + 1);
  if (process.env.T26B_SHOT) await page.screenshot({ path: process.env.T26B_SHOT.replace('.png', '-newer.png') });

  // the writer asked again reads the newer critique, and the line moves to it
  await askAgain(writer);
  await expect(writer).toContainText('W_DRAFT_2');
  expect(asked.at(-1)!.question).toContain('W_TASK');
  expect(asked.at(-1)!.text).toContain('C_CRITIQUE_2');
  expect(asked.at(-1)!.text).not.toContain('C_CRITIQUE_1');
  await expect(label).toHaveAttribute('data-feedback-edge', '1');
  await expect(label).toHaveText('Feedback · answer 2');
  // its answer was written against what it reads now: it is not said to be out of date
  await expect(writer.locator('[data-stale-badge]')).toHaveCount(0);
  await expect(critic.locator('[data-stale-badge]'), 'the critic has a newer draft to read: that one is').toHaveCount(1);
  if (process.env.T26B_SHOT) await page.screenshot({ path: process.env.T26B_SHOT });
});

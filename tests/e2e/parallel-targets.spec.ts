import { expect, test, type Page, type Route } from '@playwright/test';

// Two tasks answering at once, in a real browser. No model is called: this file
// answers every request, and says when. One fails while the other goes on; what one
// is told is not shown on the other.

const FIRST = 'FIRST_TASK: what does the first say?';
const SECOND = 'SECOND_TASK: what does the second say?';
const released: Record<string, () => void> = {};
const sse = (frames: unknown[]) => frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';

test.use({ viewport: { width: 1600, height: 1000 } });

async function answering(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('thoughtdag.seeded', 'yes');
    localStorage.setItem('thoughtdag.tutorialDone', '1');
  });
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'Access-Control-Allow-Origin': '*' } });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
    const url = new URL(request.url());
    if (url.pathname === '/api/models') return json(route, { models: [{ id: 'provider-a/model-one', name: 'model-one', provider: 'provider-a', vision: false }], default: 'provider-a/model-one', capabilities: { webSearch: false, search: false } });
    if (url.pathname === '/api/stream') {
      const text = request.postData() ?? '';
      const first = text.includes('FIRST_TASK');
      // each waits until the test says, so that the second can finish before the first
      await new Promise<void>((resolve) => { released[first ? 'first' : 'second'] = resolve; });
      return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'Access-Control-Allow-Origin': '*' }, body: first ? sse([{ error: 'FIRST_FAILED_ON_PURPOSE' }]) : sse([{ text: 'SECOND_ANSWER_B7' }]) });
    }
    return json(route, {}, 404);
  });
}
const cardOf = (page: Page, text: string) => page.locator('.react-flow__node', { hasText: text });

test('[T28] two tasks at once: the second answers while the first waits, the first fails, and the second keeps its answer', async ({ page }) => {
  await answering(page);
  await page.goto('/');
  await page.getByPlaceholder('What would you like to explore?').fill(FIRST);
  await page.keyboard.press('Enter');
  await expect.poll(() => !!released.first).toBe(true);
  for (let i = 0; i < 4; i++) await page.locator('.react-flow__controls-zoomout').click();
  const pane = (await page.locator('.react-flow__pane').boundingBox())!;
  await page.getByTitle('Ask node: wire material in and ask here; the answer draws only on incoming edges').dragTo(page.locator('.react-flow__pane'), { targetPosition: { x: pane.width * 0.75, y: pane.height * 0.4 } });
  const input = page.getByPlaceholder('Type a question… whatever flows in along');
  await input.fill(SECOND);
  await input.press('Enter');
  await expect.poll(() => !!released.second).toBe(true);

  released.second();
  await expect(cardOf(page, SECOND)).toContainText('SECOND_ANSWER_B7');
  // the first is still at it: the other's end has not touched it
  await expect(cardOf(page, FIRST)).not.toContainText('SECOND_ANSWER_B7');
  released.first();
  await expect(page.getByText(/FIRST_FAILED_ON_PURPOSE/).first()).toBeVisible();
  await expect(cardOf(page, SECOND)).toContainText('SECOND_ANSWER_B7');
  await expect(cardOf(page, FIRST)).not.toContainText('SECOND_ANSWER_B7');
});

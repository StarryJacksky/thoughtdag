import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

// Wiring from any side of a card, in a real browser. No model is called: this file
// answers every request with a fixed answer.

test.use({ viewport: { width: 1600, height: 1000 } });

async function start(page: Page) {
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
    if (url.pathname === '/api/stream') return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'Access-Control-Allow-Origin': '*' }, body: `data: ${JSON.stringify({ text: 'AN_ANSWER' })}\n\ndata: [DONE]\n\n` });
    return json(route, {}, 404);
  });
  await page.goto('/');
}

const cardOf = (page: Page, text: string): Locator => page.locator('.react-flow__node', { hasText: text });
const handleOf = (card: Locator, side: string) => card.locator(`.react-flow__handle[data-handleid="${side}"]`);
async function settled(locator: Locator) {
  let last = await locator.boundingBox();
  for (let i = 0; i < 40; i++) {
    await locator.page().waitForTimeout(80);
    const now = await locator.boundingBox();
    if (last && now && Math.abs(now.x - last.x) < 0.5 && Math.abs(now.y - last.y) < 0.5) return now;
    last = now;
  }
  return last!;
}
async function drag(page: Page, from: Locator, to: Locator) {
  const a = await settled(from);
  const b = await settled(to);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 10, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
}
/** Two tasks side by side, in view. */
async function twoTasks(page: Page) {
  await page.getByPlaceholder('What would you like to explore?').fill('FIRST?');
  await page.keyboard.press('Enter');
  await expect(cardOf(page, 'FIRST?')).toContainText('AN_ANSWER');
  for (let i = 0; i < 3; i++) await page.locator('.react-flow__controls-zoomout').click();
  const pane = (await page.locator('.react-flow__pane').boundingBox())!;
  await page.getByTitle('Ask node: wire material in and ask here; the answer draws only on incoming edges').dragTo(page.locator('.react-flow__pane'), { targetPosition: { x: pane.width * 0.92, y: pane.height * 0.8 } });
  const input = page.getByPlaceholder('Type a question… whatever flows in along');
  await input.fill('SECOND?');
  await input.press('Enter');
  await expect(cardOf(page, 'SECOND?')).toContainText('AN_ANSWER');
  await page.locator('.react-flow__controls-fitview').click();
  await page.waitForTimeout(500);
  return { first: cardOf(page, 'FIRST?'), second: cardOf(page, 'SECOND?') };
}
const edgeCount = (page: Page) => page.locator('.react-flow__edge').count();
const ids = async (card: Locator) => (await card.getAttribute('data-id'))!;
const edgeBetween = (page: Page, source: string, target: string) => page.locator(`.react-flow__edge[data-testid="rf__edge-crosslink-${source}-${target}"]`);

for (const [fromSide, toSide] of [['branch', 'left'], ['left', 'branch'], ['top', 'continue'], ['continue', 'top']]) {
  test(`[T26c] drawn from the ${fromSide} of one card to the ${toSide} of another: a line from the first to the second`, async ({ page }) => {
    await start(page);
    const { first, second } = await twoTasks(page);
    const before = await edgeCount(page);
    await drag(page, handleOf(first, fromSide), handleOf(second, toSide));
    await expect.poll(() => edgeCount(page)).toBe(before + 1);
    await expect(edgeBetween(page, await ids(first), await ids(second))).toHaveCount(1);
    await expect(edgeBetween(page, await ids(second), await ids(first))).toHaveCount(0);
  });
}

test('[T26c] every side of a card can be taken hold of', async ({ page }) => {
  await start(page);
  const { first } = await twoTasks(page);
  for (const side of ['top', 'continue', 'left', 'branch']) {
    await expect(handleOf(first, side)).toBeVisible();
    const box = await handleOf(first, side).boundingBox();
    expect(box!.width).toBeGreaterThan(4);
  }
});

test('[T26c] dropped on empty canvas from the left of a card: a new question, wired from there', async ({ page }) => {
  await start(page);
  await page.getByPlaceholder('What would you like to explore?').fill('FIRST?');
  await page.keyboard.press('Enter');
  const first = cardOf(page, 'FIRST?');
  await expect(first).toContainText('AN_ANSWER');
  const before = await page.locator('.react-flow__node').count();
  const at = await settled(handleOf(first, 'left'));
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.down();
  await page.mouse.move(at.x - 40, at.y + 20, { steps: 4 });
  await page.mouse.move(Math.max(120, at.x - 400), at.y + 60, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('.react-flow__node')).toHaveCount(before + 1);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
});

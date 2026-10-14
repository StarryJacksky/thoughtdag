import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

// AI tasks on one canvas, in a real browser: two tasks bound to two
// different models, a note wired to both, one of the two edges taken away,
// and a panel for each task open side by side in the one window.
//
// No model is called. The model list and every request for an answer are
// answered by this file: the list names two synthetic API models, and a
// request for an answer is recorded (which model it was for, what it was
// sent) and then refused. Agents (the runtimes the desktop shell runs) are
// not in a browser; tasks bound to them are covered in tests/unit/targets.test.ts.

const MODEL_ONE = 'provider-a/model-one';
const MODEL_TWO = 'provider-b/model-two';
const asked: { model?: string; text: string }[] = [];

test.use({ viewport: { width: 1600, height: 1000 } });

async function withoutModels(page: Page) {
  asked.length = 0;
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
      const model = (id: string) => ({ id, name: id.split('/')[1], provider: id.split('/')[0], vision: false });
      return json(route, { models: [model(MODEL_ONE), model(MODEL_TWO)], default: MODEL_ONE, capabilities: { webSearch: false, searchEngine: '', scholarSearch: false, vision: false } });
    }
    if (url.pathname === '/api/stream' || url.pathname === '/api/claude') {
      let body: { model?: string; messages?: { content?: unknown }[] } = {};
      try { body = JSON.parse(request.postData() ?? '{}'); } catch { /* not JSON */ }
      asked.push({ model: body.model, text: JSON.stringify(body.messages ?? []) });
      return json(route, { error: 'synthetic: no model is called in this test' }, 500);
    }
    // everything else the page asks its proxy for (summaries, recall, memory) gets nothing
    return json(route, {}, 404);
  });
}

/** The card of the question node that holds `text`, and what stands above it. */
const cardOf = (page: Page, text: string): Locator => page.locator('.react-flow__node', { hasText: text });
const inputsOf = (card: Locator) => card.locator('[data-target-inputs]');
/** Wait until the canvas has stopped gliding: its pan and zoom are the same over three looks in a row. */
async function viewAtRest(page: Page) {
  const view = page.locator('.react-flow__viewport');
  let same = 0;
  let last = '';
  await page.waitForTimeout(200); // a glide that was just asked for has started by now
  for (let i = 0; i < 60 && same < 3; i++) {
    const now = (await view.getAttribute('style')) ?? '';
    same = now === last ? same + 1 : 0;
    last = now;
    await page.waitForTimeout(100);
  }
}
/**
 * Bring every card into view. A card that is out of view is not drawn at
 * all, so it can be neither looked at nor dropped on. A glide that is
 * under way (the canvas goes to a new card by itself) is waited out first,
 * or it would undo the fit.
 */
async function fit(page: Page) {
  await viewAtRest(page);
  await page.locator('.react-flow__controls-fitview').click();
  await viewAtRest(page);
}
/** Where something is once the view has stopped moving (the canvas glides when it is fitted or a card is added). */
async function atRest(page: Page, locator: Locator) {
  let last = await locator.boundingBox();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(80);
    const now = await locator.boundingBox();
    if (last && now && Math.abs(now.x - last.x) < 0.5 && Math.abs(now.y - last.y) < 0.5 && Math.abs(now.width - last.width) < 0.5) return now;
    last = now;
  }
  return last!;
}
/** Drag from a node's bottom handle onto another node: the gesture that wires one into the other. */
async function wire(page: Page, from: Locator, to: Locator) {
  const handle = await atRest(page, from.locator('.react-flow__handle[data-handleid="continue"]'));
  const target = await atRest(page, to);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 12, handle.y + handle.height / 2 + 12, { steps: 3 });
  await page.mouse.move(target.x + target.width / 2, target.y + Math.min(60, target.height / 2), { steps: 12 });
  await page.mouse.up();
}

test('two tasks on one canvas run on their own models, share a note by an edge each, and have a panel each', async ({ page, context }) => {
  await withoutModels(page);
  await page.goto('/');

  // the first question is a task like any other: it is bound to the toolbar's model when it is sent
  await page.getByPlaceholder('What would you like to explore?').fill('X_TASK: write the estimator paragraph.');
  await page.keyboard.press('Enter');
  const x = cardOf(page, 'X_TASK: write the estimator paragraph.');
  await expect(x.locator('[data-target-chip="bound"] [data-target-label]')).toHaveText('model-one · API');
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0].model).toBe(MODEL_ONE);
  // room on the canvas for what comes next
  for (let i = 0; i < 4; i++) await page.locator('.react-flow__controls-zoomout').click();

  // a second task, for another model, chosen when it is made
  await page.locator('[data-new-task]').click();
  await expect(page.locator('[data-new-task-menu] [data-target-heading]')).toHaveText(['Models through an API']);
  await page.locator(`[data-new-task-menu] [data-target-option="${MODEL_TWO}"]`).click();
  const y = page.locator('.react-flow__node', { has: page.locator(`[data-target-chip][data-target-model="${MODEL_TWO}"]`) });
  await expect(y).toHaveCount(1);
  await expect(y.locator('[data-target-label]')).toHaveText('model-two · API');
  // changing the toolbar's model later is not this task's business: X stays on the one it was sent with
  await expect(x.locator('[data-target-label]')).toHaveText('model-one · API');

  // a note, as shared material
  // dragged from the palette to an empty place below the two tasks
  const palette = (await page.getByTitle('Add a note: feeds downstream context as [Note] once connected').boundingBox())!;
  await page.mouse.move(palette.x + palette.width / 2, palette.y + palette.height / 2);
  await page.mouse.down();
  await page.mouse.move(500, 700, { steps: 8 });
  await page.mouse.move(520, 820, { steps: 8 });
  await page.mouse.up();
  const editing = page.locator('.react-flow__node').filter({ has: page.locator('textarea') }).last();
  const noteId = await editing.getAttribute('data-id');
  await editing.locator('textarea').fill('SHARED_C_L5: both analyses use the 2024 survey wave.');
  await editing.locator('textarea').blur();
  const note = page.locator(`.react-flow__node[data-id="${noteId}"]`);
  await expect(note).toHaveCount(1);

  // wiring it to each task makes an edge each, and asks no model anything
  const before = asked.length;
  // everything in view, as a person would have it before drawing a wire
  await fit(page);
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await wire(page, note, y);
  // the canvas lays a task out under what was wired to it: everything is brought back into view
  await fit(page);
  await expect(inputsOf(y)).toHaveAttribute('data-target-inputs', '1');
  await wire(page, note, x);
  await fit(page);
  await expect(inputsOf(x)).toHaveAttribute('data-target-inputs', '1');
  await expect(page.locator('.react-flow__node'), 'no wire fell on the empty canvas and made a card of its own').toHaveCount(3);
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  expect(asked.length, 'wiring sent nothing').toBe(before);
  await expect(y.locator('textarea'), 'the task that was wired to is still waiting for its question').toBeVisible();

  // taking the edge into X away leaves the one into Y
  const xId = await x.getAttribute('data-id');
  await page.locator(`.react-flow__edge[data-id$="-${xId}"]`).click({ force: true });
  await page.keyboard.press('Backspace');
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await expect(inputsOf(x)).toHaveAttribute('data-target-inputs', '0');
  await expect(inputsOf(y)).toHaveAttribute('data-target-inputs', '1');
  await expect(note, 'the note is still on the canvas').toHaveCount(1);

  // Y's question goes to Y's model, with the note it is wired to
  await y.locator('textarea').fill('Y_TASK: draft the reply to the reviewer.');
  await y.locator('textarea').press('Enter');
  await expect.poll(() => asked.length).toBe(before + 1);
  expect(asked.at(-1)!.model).toBe(MODEL_TWO);
  expect(asked.at(-1)!.text).toContain('SHARED_C_L5');
  expect(asked.at(-1)!.text).not.toContain('X_TASK');

  // a panel for each task, side by side, in this one window
  const yCard = cardOf(page, 'Y_TASK: draft the reply to the reviewer.');
  await x.locator('[data-task-open-panel]').click();
  await yCard.locator('[data-task-open-panel]').click();
  const panels = page.locator('[data-surface] [data-task-panel]');
  await expect(panels).toHaveCount(2);
  await expect(panels.filter({ hasText: 'X_TASK: write the estimator paragraph.' })).toBeVisible();
  await expect(panels.filter({ hasText: 'Y_TASK: draft the reply to the reviewer.' })).toBeVisible();
  expect(context.pages().length, 'no window was opened for them').toBe(1);
  if (process.env.T26_SHOT) await page.screenshot({ path: process.env.T26_SHOT });
});

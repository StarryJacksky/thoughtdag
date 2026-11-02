import { expect, test, type Route } from '@playwright/test';

// The attachment entry of a follow-up question, in a real browser. No model is called:
// this file answers every request. A file from this computer goes as it always did; a
// Space is listed and says why it cannot be used, with no interface to reach one yet.

test.use({ viewport: { width: 1600, height: 1000 } });

test('[T37] the paperclip offers this computer and a Space: the first attaches, the second says why not', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('thoughtdag.seeded', 'yes');
    localStorage.setItem('thoughtdag.tutorialDone', '1');
  });
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'Access-Control-Allow-Origin': '*' } });
  const asked: string[] = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
    const url = new URL(request.url());
    if (url.pathname === '/api/models') return json(route, { models: [{ id: 'provider-a/model-one', name: 'model-one', provider: 'provider-a', vision: false }], default: 'provider-a/model-one', capabilities: { webSearch: false, search: false } });
    if (url.pathname === '/api/stream') {
      asked.push(request.postData() ?? '');
      return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'Access-Control-Allow-Origin': '*' }, body: `data: ${JSON.stringify({ text: 'AN_ANSWER_A1' })}\n\ndata: [DONE]\n\n` });
    }
    return json(route, {}, 404);
  });
  await page.goto('/');
  await page.getByPlaceholder('What would you like to explore?').fill('THE_QUESTION?');
  await page.keyboard.press('Enter');
  const card = page.locator('.react-flow__node', { hasText: 'THE_QUESTION?' });
  await expect(card).toContainText('AN_ANSWER_A1');
  await card.locator('[data-task-open-panel]').click();
  const panel = page.locator('[data-surface] [data-task-panel]');
  await expect(panel).toHaveCount(1);
  const before = asked.length;

  const clip = panel.getByTitle('Attach files to this follow-up', { exact: false });
  await clip.click();
  const menu = page.locator('[data-source-menu]');
  await expect(menu.locator('[data-source="local-file"]')).toBeEnabled();
  await expect(menu.locator('[data-source="space"]')).toBeDisabled();
  await expect(menu.locator('[data-source-blocked]')).not.toBeEmpty();

  const choosing = page.waitForEvent('filechooser');
  await menu.locator('[data-source="local-file"]').click();
  const chooser = await choosing;
  await chooser.setFiles({ name: 'a-note.txt', mimeType: 'text/plain', buffer: Buffer.from('SYNTHETIC_NOTE') });
  await expect(page.getByText('a-note.txt').first()).toBeVisible();
  await expect(menu).toHaveCount(0);
  expect(asked.length).toBe(before); // choosing sends nothing
});

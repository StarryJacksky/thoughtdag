import { expect, test } from '@playwright/test';

// The end-to-end chain itself: the dev server comes up and the canvas
// reaches its empty landing in the local Chrome.
test('the canvas boots to its empty landing', async ({ page }) => {
  // no first-run example canvas: the test asserts the empty state
  await page.addInitScript(() => localStorage.setItem('thoughtdag.seeded', 'yes'));
  await page.goto('/');
  await expect(page.getByPlaceholder('What would you like to explore?')).toBeVisible();
});

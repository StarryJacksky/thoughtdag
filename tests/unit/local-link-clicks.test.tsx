import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Markdown } from '../../src/components/Markdown';

afterEach(() => vi.unstubAllGlobals());

it('local Markdown links handle middle and Shift clicks without web navigation', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const previous = window.desktopLocal;
  const opened: string[] = [];
  window.desktopLocal = {
    open: async (path) => { opened.push(path); return { ok: true }; },
    image: async () => null,
  };
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Markdown base="/synthetic/project">{'[Local note](notes/example.md)'}</Markdown>));
    const link = container.querySelector('a')!;
    expect(link.dataset.localPath).toBe('/synthetic/project/notes/example.md');
    for (const event of [
      new MouseEvent('click', { bubbles: true, cancelable: true }),
      new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }),
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }),
    ]) {
      await act(async () => { link.dispatchEvent(event); });
      expect(event.defaultPrevented, `${event.type}, button ${event.button}`).toBe(true);
    }
    expect(opened).toEqual(Array(3).fill('/synthetic/project/notes/example.md'));
    const rightClick = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 });
    await act(async () => { link.dispatchEvent(rightClick); });
    expect(rightClick.defaultPrevented).toBe(false);
    expect(opened).toHaveLength(3);
  } finally {
    await act(async () => root.unmount());
    window.desktopLocal = previous;
  }
});

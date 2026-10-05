// Mounting a React tree in the test DOM without a testing library: a root,
// `act` around everything that changes it, and the events a person's hand
// would cause.

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  container: HTMLElement;
  /** render again, or render something else in the same place */
  rerender(node: ReactNode): Promise<void>;
  unmount(): Promise<void>;
}

export async function mount(node: ReactNode): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(node); });
  return {
    container,
    rerender: async (next) => { await act(async () => { root.render(next); }); },
    unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

/** Do something that changes what is shown, and let it settle. */
export const during = (work: () => void | Promise<void>): Promise<void> => act(async () => { await work(); });

/** A pointer event at a point, as the frame's drag handlers see it. */
export function pointer(target: Element, type: 'pointerdown' | 'pointermove' | 'pointerup', at: { x: number; y: number }, pointerId = 1): void {
  const Init = (window as unknown as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  const event = new Init(type, { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: 0, buttons: type === 'pointerup' ? 0 : 1 } as MouseEventInit);
  if (!('pointerId' in event)) Object.defineProperty(event, 'pointerId', { value: pointerId });
  target.dispatchEvent(event);
}

/** A key pressed with the focus on `target`. Resolves with whether a listener on the window heard it. */
export function keyHeardByWindow(target: Element, init: KeyboardEventInit): boolean {
  let heard = false;
  const listener = () => { heard = true; };
  window.addEventListener('keydown', listener);
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  window.removeEventListener('keydown', listener);
  return heard;
}

/**
 * The test DOM lays nothing out. An editor that measures text gets empty
 * answers here instead of a missing method. Call once before mounting one.
 */
export function withoutLayout(): void {
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) });
}

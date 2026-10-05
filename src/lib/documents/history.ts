// The text of a document as a sequence of edits, and the way back through
// them. A change replaces the characters from `from` to `to` with `insert`;
// the changes of one edit are all placed against the text as it was before
// any of them, in order, without overlapping. Undo belongs to the document,
// not to a view: whoever typed, any view can take it back.

export interface Change { from: number; to: number; insert: string }

/** Whether `changes` fit `text`: whole numbers, inside the text, ascending, not overlapping. */
export function validChanges(text: string, changes: readonly Change[]): boolean {
  if (!Array.isArray(changes) || changes.length === 0) return false;
  let end = 0;
  for (const c of changes) {
    if (!c || !Number.isInteger(c.from) || !Number.isInteger(c.to) || typeof c.insert !== 'string') return false;
    if (c.from < end || c.to < c.from || c.to > text.length) return false;
    end = c.to;
  }
  return true;
}

/**
 * Apply `changes` to `text`. Resolves with the new text and the changes
 * that take it back: the same edit seen from the other side, placed
 * against the new text.
 */
export function applyChanges(text: string, changes: readonly Change[]): { text: string; inverse: Change[] } {
  let out = '';
  let at = 0;
  let shift = 0;
  const inverse: Change[] = [];
  for (const c of changes) {
    out += text.slice(at, c.from) + c.insert;
    inverse.push({ from: c.from + shift, to: c.from + shift + c.insert.length, insert: text.slice(c.from, c.to) });
    shift += c.insert.length - (c.to - c.from);
    at = c.to;
  }
  return { text: out + text.slice(at), inverse };
}

/** The one change that turns `before` into `after`: what differs between their common start and their common end. None when they are equal. */
export function changeBetween(before: string, after: string): Change[] {
  if (before === after) return [];
  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
  return [{ from: start, to: endBefore, insert: after.slice(start, endAfter) }];
}

interface Step { changes: Change[]; inverse: Change[]; surfaceId: string | null; at: number }

/** Typing that continues within this long, at the place the last typing ended, is the same step. */
const RUN_MS = 700;

/** The steps that can be taken back and put back. */
export class History {
  private done: Step[] = [];
  private undone: Step[] = [];

  /** Note an edit that was made. What could be redone is forgotten: the text has gone another way. */
  push(changes: Change[], inverse: Change[], surfaceId: string | null, at: number): void {
    this.undone = [];
    const last = this.done[this.done.length - 1];
    const typed = changes.length === 1 && changes[0].from === changes[0].to && changes[0].insert.length > 0 && !changes[0].insert.includes('\n');
    const lastTyped = last && last.changes.length === 1 && last.changes[0].from === last.changes[0].to && !last.changes[0].insert.includes('\n');
    if (typed && lastTyped && last.surfaceId === surfaceId && at - last.at <= RUN_MS && changes[0].from === last.changes[0].from + last.changes[0].insert.length) {
      // a run of typing: one step that inserts all of it, and one that takes all of it away
      const insert = last.changes[0].insert + changes[0].insert;
      last.changes = [{ from: last.changes[0].from, to: last.changes[0].from, insert }];
      last.inverse = [{ from: last.changes[0].from, to: last.changes[0].from + insert.length, insert: '' }];
      last.at = at;
      return;
    }
    this.done.push({ changes, inverse, surfaceId, at });
  }

  /** The changes that take the last step back, or null when there is none. */
  undo(): Change[] | null {
    const step = this.done.pop();
    if (!step) return null;
    this.undone.push(step);
    return step.inverse;
  }

  /** The changes that put the last undone step back, or null when there is none. */
  redo(): Change[] | null {
    const step = this.undone.pop();
    if (!step) return null;
    this.done.push(step);
    return step.changes;
  }

  get canUndo(): boolean { return this.done.length > 0; }
  get canRedo(): boolean { return this.undone.length > 0; }
}

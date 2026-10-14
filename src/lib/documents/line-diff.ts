// Two texts, line by line: which lines are the same in both and which are
// not. It is what a person looks at to settle a conflict, so it shows
// both sides whole and in order, a changed line beside the line it stands
// against, and a line only one side has beside nothing.

export interface DiffRow {
  /** the line as mine has it; null when only theirs has a line here */
  mine: string | null;
  /** the line as theirs has it; null when only mine has a line here */
  theirs: string | null;
  changed: boolean;
}

/** Above this many lines on a side the texts are compared line for line in place: finding moved blocks would take too long. */
const MAX_LINES = 3000;

const linesOf = (text: string): string[] => {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  // a text that ends in a line break has no further, empty line
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/**
 * The rows of `mine` beside `theirs`. Lines both have, in the same order,
 * are found first (the longest run of them); what lies between them on
 * each side is paired up in order, and what is left over on one side
 * stands alone.
 */
export function compareLines(mine: string, theirs: string): DiffRow[] {
  const a = linesOf(mine);
  const b = linesOf(theirs);
  const rows: DiffRow[] = [];
  /** the lines of each side between two lines they share: paired in order, the rest alone */
  const between = (left: string[], right: string[]) => {
    const pairs = Math.min(left.length, right.length);
    for (let i = 0; i < pairs; i++) rows.push({ mine: left[i], theirs: right[i], changed: true });
    for (let i = pairs; i < left.length; i++) rows.push({ mine: left[i], theirs: null, changed: true });
    for (let i = pairs; i < right.length; i++) rows.push({ mine: null, theirs: right[i], changed: true });
  };
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    const length = Math.max(a.length, b.length);
    for (let i = 0; i < length; i++) rows.push({ mine: a[i] ?? null, theirs: b[i] ?? null, changed: a[i] !== b[i] });
    return rows;
  }
  // longest common subsequence of lines: common[i][j] is its length for a[i..] and b[j..]
  const common: Uint16Array[] = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
  }
  let [i, j] = [0, 0];
  let left: string[] = [];
  let right: string[] = [];
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      between(left, right);
      [left, right] = [[], []];
      rows.push({ mine: a[i], theirs: b[j], changed: false });
      i++; j++;
    } else if (common[i + 1][j] >= common[i][j + 1]) left.push(a[i++]);
    else right.push(b[j++]);
  }
  between([...left, ...a.slice(i)], [...right, ...b.slice(j)]);
  return rows;
}

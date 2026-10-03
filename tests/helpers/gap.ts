import { it } from 'vitest';

// A known gap: the assertion states the behavior the research-workspace plan
// requires and fails on today's code. It runs as an expected failure, so the
// suite stays green while the gap is on record. VITE_TDAG_SHOW_GAPS=1 runs it
// as an ordinary test instead, printing the failing assertion (the evidence).
// When a later task closes the gap, the expected failure starts passing and
// vitest reports it: switch that case to `it` then.
export const gap = import.meta.env.VITE_TDAG_SHOW_GAPS ? it : it.fails;

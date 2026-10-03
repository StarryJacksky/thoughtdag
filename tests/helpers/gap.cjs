// A known gap, for host-side tests (the node:test twin of tests/helpers/gap.ts).
// The body asserts what the research-workspace plan requires and fails on
// today's code; here that failure is the expected result, so the suite stays
// green while the gap is on record. TDAG_SHOW_GAPS=1 (or
// VITE_TDAG_SHOW_GAPS=1) runs the body as an ordinary test and prints the
// failing assertion. When a later task closes the gap the body passes, and
// this reports it: turn that case into an ordinary test then.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const SHOW = !!(process.env.TDAG_SHOW_GAPS || process.env.VITE_TDAG_SHOW_GAPS);

function gap(name, body) {
  test(name, async (t) => {
    if (SHOW) return body(t);
    let failure = null;
    try { await body(t); } catch (e) { failure = e; }
    if (!failure) assert.fail('this gap is closed: turn it into an ordinary test');
    // only a failed assertion is the gap; anything else is a broken test
    if (failure.code !== 'ERR_ASSERTION') throw failure;
    return undefined;
  });
}

module.exports = { gap };

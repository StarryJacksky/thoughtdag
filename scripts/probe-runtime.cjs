#!/usr/bin/env node
// What an installed runtime can do, on this machine: node scripts/probe-runtime.cjs codex <path-to-binary>
// Reaches no model and starts no thread; the probe runs in a home of its own (runtime/agents/codex-capabilities.cjs).
'use strict';
const { probeCodex } = require('../runtime/agents/codex-capabilities.cjs');

const PROBES = { codex: probeCodex };
const [name, binary] = process.argv.slice(2);
if (!PROBES[name] || !binary) {
  console.error(`usage: probe-runtime.cjs <${Object.keys(PROBES).join('|')}> <path-to-binary>`);
  process.exit(2);
}
PROBES[name](binary).then((report) => console.log(JSON.stringify(report, null, 2)));

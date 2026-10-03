// Two AI tasks on one canvas, at the host: what each agent can read on disk.
// The canvas hands each run only its own material files (see
// tests/unit/multi-ai-baseline.test.ts), but they are written under the one
// working directory the canvas has. This drives the host's real material
// writer and the capturing fakes to see what is on disk when each turn starts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installFakeRuntimes, runToEnd } = require('../helpers/fake-runtimes.cjs');
const { gap } = require('../helpers/gap.cjs');

// before the runtimes load: they read HOME and cache the binary they find
const fake = installFakeRuntimes();
const { writeMaterials } = require('../../runtime/agents/ops.cjs');
const { createCodexRuntime } = require('../../runtime/agents/codex.cjs');
const { createClaudeRuntime } = require('../../runtime/agents/claude.cjs');

const codex = createCodexRuntime();
const claude = createClaudeRuntime();
test.after(() => { codex.shutdown(); claude.shutdown(); fake.cleanup(); });

const A = { name: 'a-notes.md', content: 'A_ONLY_K7: estimator memo, trimmed mean at five percent.' };
const B = { name: 'b-notes.md', content: 'B_ONLY_Q9: reviewer letter, asks for a robustness section.' };

/** Task X (Codex, material A) runs, then task Y (Claude Code, material B), in one directory. */
async function runBoth() {
  fake.clear();
  // a fresh directory each time: what is read must come from this pass alone
  fs.rmSync(path.join(fake.project, '.thoughtdag', 'materials'), { recursive: true, force: true });
  await writeMaterials(fake.project, [A]);
  await runToEnd(codex, { runtime: 'codex', cwd: fake.project, prompt: 'X_TASK', model: { provider: 'codex', id: 'gpt-synthetic' } });
  await writeMaterials(fake.project, [B]);
  await runToEnd(claude, { runtime: 'claude-code', cwd: fake.project, prompt: 'Y_TASK', model: { provider: 'claude-code', id: 'sonnet' } });
  const readable = (runtime) => fake.read(runtime).find((r) => r.kind === 'readable').files.map((f) => f.content).join('\n');
  return { x: readable('codex'), y: readable('claude') };
}

test('each task can read the material written for it', async () => {
  const { x, y } = await runBoth();
  assert.ok(x.includes('A_ONLY_K7'));
  assert.ok(y.includes('B_ONLY_Q9'));
});

test('the first task to run cannot read material written later for the other', async () => {
  const { x } = await runBoth();
  assert.ok(!x.includes('B_ONLY_Q9'));
});

gap('[T27] a task cannot read material that was written for another task in the same directory', async () => {
  const { y } = await runBoth();
  assert.ok(!y.includes('A_ONLY_K7'), 'task Y can read A_ONLY_K7, which was wired only to task X');
});

// Running a file of the workspace with the tools installed on this
// machine: a script by its interpreter, a program compiled and then run, a
// LaTeX source compiled to a PDF beside it. Only when asked, only the file
// asked for, never through a shell. On real temp folders, with the real
// interpreters and compilers where this machine has them; a test that
// needs one this machine lacks says so and is skipped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, entryIdOf } = require('./helpers/workspace-fixture.cjs');
const { createRunner, findTool, SEARCH_DIRS } = require('../../runtime/workspace/runner.cjs');

const setup = fixture(test, 'runner');
const has = (tool) => findTool(tool, process.env.PATH) !== null;

/** A runner over a fresh workspace, with every event it sends kept by run. */
async function withRunner(options = {}) {
  const made = await setup();
  const events = [];
  const runner = createRunner({ service: made.service, send: (owner, event) => events.push({ owner, ...event }), ...options });
  /** Put a file in the workspace and give it its identity. */
  const file = async (relativePath, content) => {
    fs.mkdirSync(path.dirname(made.at(relativePath)), { recursive: true });
    fs.writeFileSync(made.at(relativePath), content);
    return (await made.service.registerEntry(made.workspace.workspaceId, entryIdOf(relativePath))).fileId;
  };
  /** Run a file and wait for its end. Resolves with the run's events, in order. */
  const run = async (fileId, owner = 7) => {
    const runId = await runner.start(owner, fileId);
    for (let i = 0; i < 2400 && !events.some((e) => e.runId === runId && e.type === 'end'); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    return events.filter((e) => e.runId === runId);
  };
  const out = (runEvents, stream) => runEvents.filter((e) => e.type === 'output' && (!stream || e.stream === stream)).map((e) => e.text).join('');
  const end = (runEvents) => runEvents.find((e) => e.type === 'end');
  return { ...made, runner, events, file, run, out, end };
}

test('a script is run by its interpreter in its own folder, its output and its errors kept apart, and its exit told', { skip: !has('python3') && 'no python3 here' }, async () => {
  const { file, run, out, end, at } = await withRunner();
  const id = await file('analysis/stats.py', 'import os, sys\nprint("OUT_LINE_1")\nprint(os.getcwd())\nprint("ERR_LINE_1", file=sys.stderr)\nsys.exit(3)\n');
  const events = await run(id);
  assert.equal(events[0].type, 'start');
  assert.match(events[0].command, /python3/);
  assert.equal(out(events, 'stdout'), `OUT_LINE_1\n${fs.realpathSync(at('analysis'))}\n`);
  assert.equal(out(events, 'stderr'), 'ERR_LINE_1\n');
  assert.deepEqual([end(events).status, end(events).code], ['failed', 3]);
  assert.equal(typeof end(events).ms, 'number');
});

test('a file whose name holds spaces and shell characters is handed over as a name, never read by a shell', { skip: !has('python3') && 'no python3 here' }, async () => {
  const { file, run, out, end, at } = await withRunner();
  fs.writeFileSync(at('notes/keep-me.txt'), 'STILL_HERE');
  const id = await file('notes/a b; rm keep-me.txt $(touch PWNED).py', 'print("RAN_SAFELY")\n');
  const events = await run(id);
  assert.equal(end(events).status, 'ok');
  assert.equal(out(events, 'stdout'), 'RAN_SAFELY\n');
  assert.equal(fs.readFileSync(at('notes/keep-me.txt'), 'utf8'), 'STILL_HERE');
  assert.equal(fs.existsSync(at('notes/PWNED')), false);
});

test('a C program is compiled and then run; one that does not compile is not run, and the compiler\'s words are shown', { skip: !has('cc') && 'no C compiler here' }, async () => {
  const { file, run, out, end, at } = await withRunner();
  const good = await file('src/hello.c', '#include <stdio.h>\nint main(void) { printf("C_RAN_%d\\n", 6 * 7); return 0; }\n');
  const ok = await run(good);
  assert.equal(end(ok).status, 'ok');
  assert.equal(out(ok, 'stdout'), 'C_RAN_42\n');
  assert.equal(ok.filter((e) => e.type === 'step').length, 2, 'two steps: compile, run');
  // the program was built outside the workspace, and nothing was left in it
  assert.deepEqual(fs.readdirSync(at('src')), ['hello.c']);

  const bad = await file('src/broken.c', 'int main(void) { return undeclared_name; }\n');
  const failed = await run(bad);
  assert.equal(end(failed).status, 'failed');
  assert.match(out(failed, 'stderr'), /undeclared_name/);
  assert.equal(failed.filter((e) => e.type === 'step').length, 1, 'what did not compile is not run');
});

for (const [language, tool, relativePath, source, steps] of [
  ['C++', 'c++', 'src/hello.cpp', '#include <iostream>\nint main() { std::cout << "CPP_RAN_" << 6 * 7 << "\\n"; return 0; }\n', 2],
  ['Rust', 'rustc', 'src/hello.rs', 'fn main() { println!("RUST_RAN_{}", 6 * 7); }\n', 2],
  ['Go', 'go', 'src/hello.go', 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Printf("GO_RAN_%d\\n", 6*7) }\n', 1],
]) {
  test(`a ${language} program is compiled and run with the compiler installed here, and nothing is left beside it`, { skip: !has(tool) && `no ${tool} here` }, async () => {
    const { file, run, out, end, at } = await withRunner();
    const id = await file(relativePath, source);
    const events = await run(id);
    assert.equal(end(events).status, 'ok', out(events, 'stderr'));
    assert.equal(out(events, 'stdout'), `${language === 'C++' ? 'CPP' : language.toUpperCase()}_RAN_42\n`);
    assert.equal(events.filter((e) => e.type === 'step').length, steps);
    assert.deepEqual(fs.readdirSync(at('src')), [path.basename(relativePath)]);
  });
}

test('a run can be stopped: the process and what it started end, and the run says it was stopped', { skip: !has('python3') && 'no python3 here' }, async () => {
  const { file, runner, events, end } = await withRunner();
  const id = await file('slow.py', 'import time, sys\nprint("STARTED", flush=True)\ntime.sleep(60)\nprint("NEVER")\n');
  const runId = await runner.start(7, id);
  for (let i = 0; i < 100 && !events.some((e) => e.runId === runId && e.type === 'output'); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  const stopped = Date.now();
  await assert.rejects(runner.stop(8, runId), { code: 'not-yours' }, 'only the page that started it can stop it');
  await runner.stop(7, runId);
  for (let i = 0; i < 100 && !events.some((e) => e.runId === runId && e.type === 'end'); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  const ended = end(events.filter((e) => e.runId === runId));
  assert.equal(ended.status, 'stopped');
  assert.ok(Date.now() - stopped < 4000);
  assert.ok(!events.some((e) => e.runId === runId && e.type === 'output' && e.text.includes('NEVER')));
});

test('the runs of a page that goes away are stopped with it', { skip: !has('python3') && 'no python3 here' }, async () => {
  const { file, runner, events } = await withRunner();
  const id = await file('slow.py', 'import time\ntime.sleep(60)\n');
  const runId = await runner.start(7, id);
  await new Promise((resolve) => setTimeout(resolve, 200));
  runner.releaseOwner(7);
  for (let i = 0; i < 100 && !events.some((e) => e.runId === runId && e.type === 'end'); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(events.find((e) => e.runId === runId && e.type === 'end').status, 'stopped');
});

test('what can run a file is told before it is run: the tools it needs, and which of them this machine lacks', async () => {
  const { file, runner } = await withRunner({ path: '/nowhere-at-all', searchDirs: [] });
  assert.deepEqual(await runner.tools(await file('a.py', 'print(1)\n')), { kind: 'script', label: 'Python', needs: ['python3'], missing: ['python3'] });
  assert.deepEqual(await runner.tools(await file('b.rs', 'fn main(){}\n')), { kind: 'compiled', label: 'Rust', needs: ['rustc'], missing: ['rustc'] });
  assert.deepEqual(await runner.tools(await file('c.tex', '\\documentclass{article}\n')), { kind: 'latex', label: 'LaTeX', needs: ['pdflatex'], missing: ['pdflatex'], engine: 'pdflatex' });
  assert.deepEqual(await runner.tools(await file('d.txt', 'plain')), { kind: null, label: null, needs: [], missing: [] });
  // nothing runs a plain text file
  await assert.rejects(runner.start(7, await file('e.txt', 'plain')), { code: 'unsupported' });
});

test('a run that needs a tool this machine lacks ends at once and names it', async () => {
  const { file, run, end } = await withRunner({ path: '/nowhere-at-all', searchDirs: [] });
  const events = await run(await file('a.py', 'print(1)\n'));
  assert.deepEqual([end(events).status, end(events).missing], ['unavailable', ['python3']]);
});

test('the folders where tools are installed on this kind of machine are looked in as well as the PATH a window is given', () => {
  assert.ok(SEARCH_DIRS.includes('/opt/homebrew/bin'));
  assert.ok(SEARCH_DIRS.includes('/Library/TeX/texbin'));
  // a tool found only in one of those folders is found
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tdag-tool-'));
  fs.writeFileSync(path.join(dir, 'made-up-tool'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(findTool('made-up-tool', '/usr/bin', [dir]), path.join(dir, 'made-up-tool'));
  assert.equal(findTool('made-up-tool', '/usr/bin', []), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a LaTeX source is compiled to a PDF beside it, which is a file of the workspace; compiling again replaces it and it stays the same file', async () => {
  // a stand-in latexmk that does what latexmk does to the output directory, so this case runs on any machine
  const tools = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tdag-fake-tex-'));
  fs.writeFileSync(path.join(tools, 'latexmk'), '#!/bin/sh\nout=""\nfor a in "$@"; do case "$a" in -outdir=*) out="${a#-outdir=}";; esac; src="$a"; done\nname=$(basename "$src" .tex)\nprintf "%%PDF-1.4 FAKE %s\\n" "$(date +%s%N)" > "$out/$name.pdf"\necho "Latexmk: All targets up-to-date"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(tools, 'pdflatex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const { file, run, end, at, service, workspace } = await withRunner({ path: `${tools}:/usr/bin:/bin`, searchDirs: [] });
  const heard = [];
  await service.subscribeWorkspace(workspace.workspaceId, (event) => heard.push([event.change, event.record.relativePath]));
  const id = await file('paper/main.tex', '\\documentclass{article}\\begin{document}Hi\\end{document}\n');
  const first = await run(id);
  assert.equal(end(first).status, 'ok');
  assert.ok(fs.readFileSync(at('paper/main.pdf'), 'utf8').startsWith('%PDF-1.4 FAKE'));
  const pdf = end(first).output;
  assert.equal((await service.resourceRecord(pdf)).relativePath, 'paper/main.pdf');
  // nothing the compiler leaves behind is left in the workspace: only the source and its PDF
  assert.deepEqual(fs.readdirSync(at('paper')).sort(), ['main.pdf', 'main.tex']);
  const before = fs.readFileSync(at('paper/main.pdf'), 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await run(id);
  assert.equal(end(second).output, pdf, 'the same file, compiled again');
  assert.notEqual(fs.readFileSync(at('paper/main.pdf'), 'utf8'), before);
  assert.ok(heard.some(([change, where]) => change === 'content' && where === 'paper/main.pdf'), 'a reader showing it hears that it changed');
  fs.rmSync(tools, { recursive: true, force: true });
});

test('a LaTeX source that does not compile leaves the PDF there was, and says why', async () => {
  const tools = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tdag-fake-tex-'));
  fs.writeFileSync(path.join(tools, 'latexmk'), '#!/bin/sh\necho "./main.tex:3: Undefined control sequence." >&2\nexit 12\n', { mode: 0o755 });
  fs.writeFileSync(path.join(tools, 'pdflatex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const { file, run, end, out, at } = await withRunner({ path: `${tools}:/usr/bin:/bin`, searchDirs: [] });
  fs.mkdirSync(at('paper'), { recursive: true });
  fs.writeFileSync(at('paper/main.pdf'), '%PDF-1.4 THE OLD ONE');
  const id = await file('paper/main.tex', '\\documentclass{article}\\begin{document}\\nosuchcommand\\end{document}\n');
  const events = await run(id);
  assert.equal(end(events).status, 'failed');
  assert.match(out(events, 'stderr'), /Undefined control sequence/);
  assert.equal(fs.readFileSync(at('paper/main.pdf'), 'utf8'), '%PDF-1.4 THE OLD ONE');
  fs.rmSync(tools, { recursive: true, force: true });
});

test('a real LaTeX source, with a formula and with Chinese, compiles to a real PDF', { skip: !(has('latexmk') && has('xelatex')) && 'no TeX here' }, async () => {
  const { file, run, end, at } = await withRunner();
  const id = await file('paper/real.tex', '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nThe mean is $\\bar x = \\frac{1}{n}\\sum_i x_i$.\n\\begin{equation}E = mc^2\\end{equation}\n\\end{document}\n');
  const events = await run(id);
  assert.equal(end(events).status, 'ok', events.filter((e) => e.type === 'output').map((e) => e.text).join('').slice(-2000));
  assert.ok(fs.readFileSync(at('paper/real.pdf')).subarray(0, 5).toString() === '%PDF-');
  const zh = await file('paper/zh.tex', '\\documentclass{ctexart}\n\\begin{document}\n中文正文，公式 $a^2+b^2=c^2$。\n\\end{document}\n');
  const zhEvents = await run(zh);
  assert.equal(end(zhEvents).status, 'ok', zhEvents.filter((e) => e.type === 'output').map((e) => e.text).join('').slice(-2000));
  assert.ok(fs.readFileSync(at('paper/zh.pdf')).subarray(0, 5).toString() === '%PDF-');
});

const builtInTectonic = findTool('tectonic', process.env.PATH);

test('a LaTeX source compiles with the engine the app brings when this machine has no TeX: nothing to install', { skip: !builtInTectonic && 'no Tectonic here to stand for the one the app ships' }, async () => {
  // no TeX on the PATH and none in the folders TeX is installed in: only the built-in engine
  const { file, run, end, at, runner } = await withRunner({ path: '/usr/bin:/bin', searchDirs: [], tectonic: builtInTectonic });
  const id = await file('paper/plain.tex', '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nThe mean is $\\bar x = \\frac{1}{n}\\sum_i x_i$.\n\\end{document}\n');
  assert.deepEqual(await runner.tools(id), { kind: 'latex', label: 'LaTeX', needs: [], missing: [], engine: 'tectonic' });
  const events = await run(id);
  assert.equal(end(events).status, 'ok', events.filter((e) => e.type === 'output').map((e) => e.text).join('').slice(-2000));
  assert.equal(fs.readFileSync(at('paper/plain.pdf')).subarray(0, 5).toString(), '%PDF-');
  assert.deepEqual(fs.readdirSync(at('paper')).sort(), ['plain.pdf', 'plain.tex']);
});

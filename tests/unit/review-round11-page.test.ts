import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootAutoBackup, backupActiveProject, disableAutoBackup, enableAutoBackup } from '../../src/lib/local-backup';
import { useUiStore } from '../../src/lib/ui-store';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import type { ThoughtNode } from '../../src/types';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';

// The rest of R11-01 from the review of c440c81: the host keeps the order in
// which writeBackup is called, but the page sent each backup on its own after
// an asynchronous step, and the host reads a whole body before calling
// writeBackup. So an older backup could still reach the disk last. All of it
// on a stand-in host with synthetic canvases; one test writes through the real
// host module into a temp folder.

/** A vault read that is slow for the next backup: `release` lets it through. */
const vault = vi.hoisted(() => ({ hold: null as Promise<void> | null }));
vi.mock('../../src/lib/attachment-vault', async (original) => {
  const actual = await original<typeof import('../../src/lib/attachment-vault')>();
  return {
    ...actual,
    inlineVaultedContent: async (nodes: ThoughtNode[]) => {
      const hold = vault.hold;
      vault.hold = null;
      if (hold) await hold;
      return actual.inlineVaultedContent(nodes);
    },
  };
});

const CANVAS = 'canvas-1';
const FOLDER = '/synthetic/backups';

function thought(question: string): ThoughtNode {
  return {
    id: 'n1', type: 'thought', position: { x: 0, y: 0 }, dragHandle: '.drag-handle',
    data: {
      question, response: '', responses: [], responseIndex: -1, isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false,
      tokenCount: 0, highlights: [], highlightMode: 'tag', attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [],
      roleMode: 'inherit', isRoot: true, isBranch: false,
    },
  };
}
const canvasSays = (question: string) => useStore.setState({ nodes: [thought(question)] });
const questionIn = (json: string | undefined) => JSON.parse(json ?? '{}').nodes?.[0]?.data?.question;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const heldOpen = () => {
  let release = () => {};
  const passage = new Promise<void>((resolve) => { release = resolve; });
  return { passage, release };
};

/** A host that answers a backup only when told to, and puts it on its disk at that moment. */
function slowHost() {
  const disk = new Map<string, string>();
  const asked: { dir: string; name: string; json: string; answered: boolean; answer: (error?: Error) => void }[] = [];
  const backupJson = vi.fn((dir: string, name: string, json: string) => new Promise<{ file: string }>((resolve, reject) => {
    const entry = {
      dir, name, json, answered: false,
      answer(error?: Error) {
        entry.answered = true;
        if (error) { reject(error); return; }
        disk.set(`${dir}/${name}`, json);
        resolve({ file: `${dir}/${name}` });
      },
    };
    asked.push(entry);
  }));
  const inFlight = () => asked.filter((a) => !a.answered);
  /** Whatever is being written, the latest first and each one once it has come: the order a slow older body gives. */
  const answerNewestFirst = async () => {
    await settle();
    for (let next = inFlight().at(-1); next; next = inFlight().at(-1)) {
      next.answer();
      await settle();
    }
  };
  return { disk, asked, backupJson, inFlight, answerNewestFirst };
}

let desktop: FakeDesktop;
const useHost = async (host: { backupJson: (dir: string, name: string, json: string) => Promise<{ file: string }> }, pickCwd: () => Promise<string | null> = async () => FOLDER) => {
  window.desktopAgents = { ...window.desktopAgents!, backupJson: host.backupJson, pickCwd };
  localStorage.setItem('thoughtdag.backupDirPath', FOLDER);
  await bootAutoBackup();
};

beforeAll(() => bootProjects());
beforeEach(() => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
  desktop = installFakeDesktop();
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [{ id: CANVAS, name: 'alpha', createdAt: 0, updatedAt: 0, agentCwd: '/synthetic/project' }], activeId: CANVAS, switching: false });
  useUiStore.setState({ toasts: [] });
  useUiStore.getState().setLastAutoBackupAt(null);
  vault.hold = null;
});
afterEach(async () => {
  vi.useRealTimers();
  await disableAutoBackup();
  await settle(); // a backup a failed test left waiting
  desktop.uninstall();
  vi.unstubAllGlobals();
  localStorage.removeItem('thoughtdag.lastBackupAt');
  useUiStore.getState().setLastAutoBackupAt(null);
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [], activeId: null, switching: false });
});

describe('[R11-01] backups from the page, in the order asked', () => {
  it('[R11-01] the host being slower with the older backup: the backup asked for last is the one on disk', async () => {
    const host = slowHost();
    await useHost(host);
    canvasSays('OLDER');
    const older = backupActiveProject();
    canvasSays('LATEST');
    const latest = backupActiveProject();
    await host.answerNewestFirst();
    await Promise.all([older, latest]);
    expect(host.asked.map((a) => questionIn(a.json))).toEqual(['OLDER', 'LATEST']);
    expect(questionIn(host.disk.get(`${FOLDER}/alpha.thoughtdag.json`))).toBe('LATEST');
  });

  it('[R11-01] one backup is on its way at a time: the next is sent once the one before it is answered', async () => {
    const host = slowHost();
    await useHost(host);
    canvasSays('FIRST');
    const first = backupActiveProject();
    canvasSays('SECOND');
    const second = backupActiveProject();
    canvasSays('THIRD');
    const third = backupActiveProject();
    await settle();
    expect(host.inFlight().map((a) => questionIn(a.json))).toEqual(['FIRST']);
    host.inFlight()[0].answer();
    await settle();
    expect(host.inFlight().map((a) => questionIn(a.json))).toEqual(['SECOND']);
    host.inFlight()[0].answer();
    await settle();
    expect(host.inFlight().map((a) => questionIn(a.json))).toEqual(['THIRD']);
    host.inFlight()[0].answer();
    await Promise.all([first, second, third]);
  });

  it('[R11-01] the automatic backup on its way and "back up now": the later one is the one on disk', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: false });
    const host = slowHost();
    window.desktopAgents = { ...window.desktopAgents!, backupJson: host.backupJson, pickCwd: async () => FOLDER };
    localStorage.setItem('thoughtdag.backupDirPath', FOLDER);
    await bootAutoBackup();
    canvasSays('AUTOMATIC');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.asked.map((a) => questionIn(a.json))).toEqual(['AUTOMATIC']);
    canvasSays('BACK_UP_NOW');
    const now = backupActiveProject();
    await vi.advanceTimersByTimeAsync(0);
    for (let next = host.inFlight().at(-1); next; next = host.inFlight().at(-1)) {
      next.answer();
      await vi.advanceTimersByTimeAsync(0);
    }
    await now;
    expect(questionIn(host.disk.get(`${FOLDER}/alpha.thoughtdag.json`))).toBe('BACK_UP_NOW');
  });

  it('[R11-01] the older backup slow to read its attachments from the vault: the later one still ends on disk', async () => {
    const host = slowHost();
    await useHost(host);
    const slow = heldOpen();
    vault.hold = slow.passage;
    canvasSays('OLDER');
    const older = backupActiveProject();
    canvasSays('LATEST');
    const latest = backupActiveProject();
    await settle();
    // a later backup that has overtaken is answered while the older one is still reading
    host.inFlight().at(-1)?.answer();
    await settle();
    slow.release();
    await host.answerNewestFirst();
    await Promise.all([older, latest]);
    expect(questionIn(host.disk.get(`${FOLDER}/alpha.thoughtdag.json`))).toBe('LATEST');
  });

  it('[R11-01] a backup that waits its turn writes the canvas as it was when asked for', async () => {
    const host = slowHost();
    await useHost(host);
    canvasSays('ONE');
    const first = backupActiveProject();
    canvasSays('TWO');
    const second = backupActiveProject();
    canvasSays('THREE, not asked for yet');
    await host.answerNewestFirst();
    await Promise.all([first, second]);
    expect(host.asked.map((a) => questionIn(a.json)).sort()).toEqual(['ONE', 'TWO']);
  });

  it('[R11-01] a backup of one canvas stays that canvas\'s when the person switches while it reads the vault', async () => {
    const host = slowHost();
    await useHost(host);
    const slow = heldOpen();
    vault.hold = slow.passage;
    canvasSays('WHAT_ALPHA_SAYS');
    const backup = backupActiveProject();
    useProjects.setState({
      projects: [
        { id: CANVAS, name: 'alpha', createdAt: 0, updatedAt: 0, agentCwd: '/synthetic/project' },
        { id: 'canvas-2', name: 'beta', createdAt: 0, updatedAt: 0, agentCwd: '/synthetic/project' },
      ],
      activeId: 'canvas-2',
    });
    canvasSays('WHAT_BETA_SAYS');
    slow.release();
    await host.answerNewestFirst();
    expect(await backup, 'the name reported is the canvas written').toBe('alpha');
    expect(host.asked.map((a) => a.name)).toEqual(['alpha.thoughtdag.json']);
    const written = JSON.parse(host.asked[0].json);
    expect(written.name).toBe('alpha');
    expect(written.projectId).toBe(CANVAS);
    expect(written.nodes[0].data.question).toBe('WHAT_ALPHA_SAYS');
  });

  it('[R11-01] a session mirror asked for before a switch goes to its own file in the cli/ drawer', async () => {
    const host = slowHost();
    await useHost(host);
    const slow = heldOpen();
    vault.hold = slow.passage;
    useProjects.setState({
      projects: [
        { id: CANVAS, name: 'mirror', createdAt: 0, updatedAt: 0, agentCwd: '/synthetic/project', sourceSession: { runtime: 'codex', sessionId: '1a2b3c4d-synthetic' } } as never,
        { id: 'canvas-2', name: 'beta', createdAt: 0, updatedAt: 0, agentCwd: '/synthetic/project' },
      ],
      activeId: CANVAS,
    });
    canvasSays('WHAT_THE_MIRROR_SAYS');
    const backup = backupActiveProject();
    useProjects.setState({ activeId: 'canvas-2' });
    slow.release();
    await host.answerNewestFirst();
    await backup;
    expect(host.asked.map((a) => a.name)).toEqual(['cli/mirror-1a2b3c4d.thoughtdag.json']);
  });

  it('[R11-01] a backup that fails fails only itself: the one behind it is written, and only that one moves the time of the last backup', async () => {
    const host = slowHost();
    await useHost(host);
    canvasSays('FAILS');
    const failing = backupActiveProject();
    canvasSays('WRITTEN');
    const behind = backupActiveProject();
    await settle();
    host.asked[0].answer(new Error('ENOSPC: the disk is full'));
    await expect(failing, 'the one who asked is told').rejects.toThrow('ENOSPC');
    expect(useUiStore.getState().lastAutoBackupAt).toBeNull();
    await settle();
    expect(host.inFlight().map((a) => questionIn(a.json))).toEqual(['WRITTEN']);
    host.inFlight()[0].answer();
    await behind;
    expect(questionIn(host.disk.get(`${FOLDER}/alpha.thoughtdag.json`))).toBe('WRITTEN');
    expect(useUiStore.getState().lastAutoBackupAt).not.toBeNull();
  });

  it('[R11-01] a folder let go while a backup waits its turn is not written to', async () => {
    const host = slowHost();
    await useHost(host);
    canvasSays('ON_ITS_WAY');
    const first = backupActiveProject();
    canvasSays('WAITING');
    const waiting = backupActiveProject();
    await settle();
    expect(host.inFlight()).toHaveLength(1);
    await disableAutoBackup();
    host.inFlight()[0].answer();
    await first;
    expect(await waiting, 'nothing was written').toBeNull();
    expect(host.asked.map((a) => questionIn(a.json))).toEqual(['ON_ITS_WAY']);
  });

  it('[R11-01] a new folder picked while a backup waits its turn: what waited for the old folder goes nowhere, and the new folder gets the canvas', async () => {
    const host = slowHost();
    await useHost(host, async () => '/synthetic/another');
    canvasSays('ON_ITS_WAY');
    const first = backupActiveProject();
    canvasSays('WAITING');
    const waiting = backupActiveProject();
    await settle();
    const picked = enableAutoBackup();
    await settle();
    host.inFlight()[0].answer();
    await first;
    expect(await waiting).toBeNull();
    await settle();
    expect(host.inFlight().map((a) => [a.dir, questionIn(a.json)])).toEqual([['/synthetic/another', 'WAITING']]);
    host.inFlight()[0].answer();
    expect(await picked).toBe(true);
    expect(host.asked.map((a) => a.dir)).toEqual([FOLDER, '/synthetic/another']);
  });

  it('[R11-01] an empty canvas writes nothing and holds nothing up', async () => {
    const host = slowHost();
    await useHost(host);
    expect(await backupActiveProject()).toBeNull();
    expect(host.asked).toEqual([]);
    canvasSays('NOT_EMPTY');
    const backup = backupActiveProject();
    await host.answerNewestFirst();
    expect(await backup).toBe('alpha');
  });

  it('[R11-01] a browser tab writing through a folder handle keeps the same order', async () => {
    const disk = new Map<string, string>();
    const closing: { json: string; finish: () => void }[] = [];
    class FolderHandle {
      name = 'synthetic-folder';
      async getDirectoryHandle() { return this; }
      async getFileHandle(fileName: string) {
        return {
          createWritable: async () => {
            let json = '';
            return {
              write: async (data: string) => { json = data; },
              close: () => new Promise<void>((resolve) => { closing.push({ json, finish: () => { disk.set(fileName, json); resolve(); } }); }),
            };
          },
        };
      }
    }
    const withoutHostWrite = { ...window.desktopAgents! };
    delete withoutHostWrite.backupJson;
    window.desktopAgents = withoutHostWrite;
    vi.stubGlobal('showDirectoryPicker', async () => new FolderHandle());
    expect(await enableAutoBackup()).toBe(true); // an empty canvas: nothing to write yet
    canvasSays('OLDER');
    const older = backupActiveProject();
    canvasSays('LATEST');
    const latest = backupActiveProject();
    await settle();
    for (let next = closing.pop(); next; next = closing.pop()) { next.finish(); await settle(); }
    await Promise.all([older, latest]);
    expect(questionIn(disk.get('alpha.thoughtdag.json'))).toBe('LATEST');
  });

  it('[R11-01] through the real host module into a real folder, with the older backups the slower to arrive: the last one asked for is on disk', async () => {
    const { writeBackup } = createRequire(import.meta.url)('../../runtime/backup-write.cjs') as { writeBackup: (body: { dir: string; name: string; json: string }) => Promise<string> };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-r11-page-'));
    try {
      let delay = 60;
      const backupJson = async (at: string, name: string, json: string) => {
        const arrives = delay;
        delay -= 20;
        await new Promise((resolve) => setTimeout(resolve, arrives));
        return { file: await writeBackup({ dir: at, name, json }) };
      };
      window.desktopAgents = { ...window.desktopAgents!, backupJson, pickCwd: async () => dir };
      localStorage.setItem('thoughtdag.backupDirPath', dir);
      await bootAutoBackup();
      const writes: Promise<string | null>[] = [];
      for (const said of ['FIRST', 'SECOND', 'THIRD', 'FOURTH']) {
        canvasSays(said);
        writes.push(backupActiveProject());
      }
      await Promise.all(writes);
      expect(questionIn(fs.readFileSync(path.join(dir, 'alpha.thoughtdag.json'), 'utf8'))).toBe('FOURTH');
      expect(fs.readdirSync(dir), 'and nothing is left beside it').toEqual(['alpha.thoughtdag.json']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

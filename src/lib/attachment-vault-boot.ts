import { get as idbGet } from 'idb-keyval';
import { useStore } from '../store';
import { useProjects, projectStorageKey } from '../store/projects';
import { internNodes, gcVault, vaultIdOf } from './attachment-vault';
import type { ThoughtNode } from '../types';

// Store-aware vault plumbing lives in its own module: attachment-vault.ts
// is imported from inside the store's module graph (lib/attachments), so
// importing the store THERE would be circular. Only App boots these.

/** Older canvases carry PDF bytes inline — lighten the ACTIVE canvas once
    after it hydrates. Idempotent; the lightened graph re-persists via the
    normal middleware. */
export async function migrateActiveCanvasToVault(): Promise<void> {
  const { nodes } = useStore.getState();
  if (!nodes.some((n) => n.data.attachments?.some((a) => a.type === 'application/pdf' && a.content && !a.contentInVault))) return;
  const interned = await internNodes(nodes);
  // Guard against a project switch racing the async intern
  if (useStore.getState().nodes !== nodes) return;
  useStore.setState({ nodes: interned });
}

/** The vault keys these nodes' attachments read their payloads from. */
export function referencedVaultIds(nodes: ThoughtNode[], into = new Set<string>()): Set<string> {
  for (const n of nodes) for (const a of n.data.attachments ?? []) { into.add(a.id); into.add(vaultIdOf(a)); }
  return into;
}

/** Boot sweep: collect every attachment id across ALL projects (persisted
    payloads + the live one), then drop unreferenced vault entries. */
export async function gcVaultAtBoot(): Promise<void> {
  try {
    const ids = referencedVaultIds(useStore.getState().nodes);
    for (const p of useProjects.getState().projects) {
      const raw = await idbGet(projectStorageKey(p.id)).catch(() => null);
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const nodes = (parsed?.state?.nodes ?? []) as ThoughtNode[];
      referencedVaultIds(nodes, ids);
    }
    const swept = await gcVault(ids);
    if (swept > 0) console.info(`[thoughtdag] vault GC: swept ${swept} orphaned payload(s)`);
  } catch (err) {
    console.warn('[thoughtdag] vault GC failed:', err);
  }
}

// "Upstream changed", judged. The fingerprint says an answer was written
// against upstream content that has since changed; it cannot say whether
// the change matters. With a judge, each newly stale node is compared
// against what it read at generation time (a per-upstream-node record of
// hash and opening text) and the judge answers one question: does the
// change bear on this answer? Below the bar the amber badge stays off and
// the stale mark stays out of the context. Without a judge, or when the
// node predates the record, the fingerprint's verdict stands.
import { useStore } from '../store';
import { upstreamParts } from '../store/context-builder';
import { baselineOf } from './context/staleness';
import { judgeAvailable, decideStaleness, STALE_BAR, type StaleCase } from './judge';
import type { StaleVerdict } from '../store/types';

type StaleState = { staleIds: string[]; staleFps: Record<string, string>; staleVerdicts: Record<string, StaleVerdict> };

/** The judge looked at this node's current staleness and found the change irrelevant. */
export const staleHiddenByJudge = (s: Pick<StaleState, 'staleFps' | 'staleVerdicts'>, id: string): boolean => {
  const v = s.staleVerdicts[id];
  return !!v && v.fp === s.staleFps[id] && v.p < STALE_BAR;
};

/** The stale nodes the UI shows and the context marks: the fingerprint's set minus the judge's dismissals. */
export const shownStaleIds = (s: StaleState): string[] => s.staleIds.filter((id) => !staleHiddenByJudge(s, id));

/** The current verdict for a node, when it matches the staleness being shown. */
export const currentStaleVerdict = (s: Pick<StaleState, 'staleFps' | 'staleVerdicts'>, id: string): StaleVerdict | undefined => {
  const v = s.staleVerdicts[id];
  return v && v.fp === s.staleFps[id] ? v : undefined;
};

const BATCH = 8;
let running = false;
const tried = new Set<string>();

/** Judge every stale node that has no verdict for its current staleness. Runs in the background; safe to call often. */
export async function judgeStaleness(): Promise<void> {
  if (running || !judgeAvailable()) return;
  const st = useStore.getState();
  const pending = st.staleIds.filter((id) => st.staleVerdicts[id]?.fp !== st.staleFps[id] && !tried.has(`${id}:${st.staleFps[id]}`));
  if (!pending.length) return;
  running = true;
  try {
    const { nodes, edges } = st;
    const cases: StaleCase[] = [];
    for (const id of pending.slice(0, BATCH)) {
      tried.add(`${id}:${st.staleFps[id]}`);
      const n = nodes.find((x) => x.id === id);
      const recorded = n ? baselineOf(n.data).contextParts : undefined;
      if (!n || !recorded) continue; // nothing recorded about what it read: the fingerprint's verdict stands
      const now = upstreamParts(id, nodes, edges);
      const changes: StaleCase['changes'] = [];
      for (const [uid, part] of Object.entries(now)) {
        const old = recorded[uid];
        if (!old || old.h !== part.h) changes.push({ node: uid, before: old?.head ?? '', after: part.text });
      }
      for (const uid of Object.keys(recorded)) if (!now[uid]) changes.push({ node: uid, before: recorded[uid].head, after: '' });
      if (!changes.length) continue; // drifted for a reason the record cannot show (structure, materials): stays flagged
      cases.push({ id, question: n.data.question, answer: n.data.response, changes });
    }
    if (cases.length) {
      const ps = await decideStaleness(cases);
      const verdicts: Record<string, StaleVerdict> = {};
      for (const c of cases) verdicts[c.id] = { fp: st.staleFps[c.id], p: ps[c.id], changed: c.changes.map((ch) => ch.node) };
      useStore.getState().setStaleVerdicts(verdicts);
    }
  } catch { /* the fingerprint's verdict stands until the next change */ } finally { running = false; }
  const again = useStore.getState();
  if (again.staleIds.some((id) => again.staleVerdicts[id]?.fp !== again.staleFps[id] && !tried.has(`${id}:${again.staleFps[id]}`))) void judgeStaleness();
}

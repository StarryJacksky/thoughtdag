// Which nodes are new on the canvas. A node that waits for its question
// takes the focus when it is made, once. It does not when its canvas is
// opened with it already there (the page loaded again, another canvas
// switched to), and it does not again when it comes back into view (the
// canvas does not keep the nodes it does not show mounted). Then the focus
// stays where it was put: in the document in front, or wherever the person
// is typing.

import { useStore } from '../store';

/** nodes that were there when their canvas was opened, or have already had their turn at the focus */
const seen = new Set<string>();
useStore.persist.onFinishHydration((state) => { for (const node of state.nodes) seen.add(node.id); });

/** Whether the node of this id was made since its canvas was opened and has not had the focus yet. Asking changes nothing. */
export const isFreshNode = (id: string): boolean => !seen.has(id);

/** The node has had its turn at the focus: it does not ask for it again. */
export const markNodeSeen = (id: string): void => { seen.add(id); };

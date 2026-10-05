// Which opening of which canvas is in the store right now, as a number
// that goes up every time the canvas is, or is about to be, another one:
// a switch, a reload of the canvas from storage, going away and coming
// back. Work that was started for one visit and comes back during another
// compares the number it started with to the number now, and stands down
// if they differ. The canvas's id alone cannot tell "came back to the same
// canvas" from "never left".

import { useStore } from '../../store';
import { useProjects } from '../../store/projects';

let visit = 0;

/** The number of the visit that is in the store now. */
export const canvasVisit = (): number => visit;

// the store is swapped while `switching` is set and before the active id changes, so both mark a new visit
useProjects.subscribe((now, before) => {
  if (now.activeId !== before.activeId || (now.switching && !before.switching)) visit++;
});
// every load of a canvas from storage, whatever asked for it
useStore.persist?.onHydrate(() => { visit++; });

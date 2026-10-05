// The page's subscriptions to workspaces, as the shell holds them. A page
// asks to hear about a workspace's files; the shell watches that folder for
// as long as the page that asked is there. When that page goes away (its
// window is closed, it is reloaded, its process dies) what it subscribed to
// is released with it: nothing keeps watching for a listener that is gone.
// The folders stay granted; only the watching stops.
'use strict';

/**
 * `service` is the workspace service; `send(event)` delivers an event to
 * the page. One subscription per workspace, however often it is asked for.
 */
function createSubscriptionHub({ service, send }) {
  const held = new Map(); // workspaceId → { owner, stop: Promise<() => void> }

  function release(workspaceId) {
    const entry = held.get(workspaceId);
    if (!entry) return;
    held.delete(workspaceId);
    // a subscription still being set up is released as soon as it is there
    void entry.stop.then((stop) => stop(), () => {});
  }

  return {
    /** Start hearing about a workspace, for the page `owner` (its web-contents id). Resolves once the workspace is being listened to. */
    async subscribe(workspaceId, owner = null) {
      const id = String(workspaceId);
      let entry = held.get(id);
      if (!entry) {
        entry = { owner, stop: service.subscribeWorkspace(id, send) };
        held.set(id, entry);
        const mine = entry;
        // a subscription that could not be made is not held: asking again tries again
        entry.stop.catch(() => { if (held.get(id) === mine) held.delete(id); });
      } else {
        entry.owner = owner;
      }
      await entry.stop;
      return true;
    },

    unsubscribe(workspaceId) {
      release(String(workspaceId));
      return true;
    },

    /** Release everything the page `owner` subscribed to: that page is gone. */
    releaseOwner(owner) {
      for (const [id, entry] of [...held]) if (entry.owner === owner) release(id);
    },

    /** Look again at every workspace that is being listened to (the window came back to the front). */
    rescanAll() {
      for (const id of held.keys()) void service.rescanWorkspace(id).catch(() => {});
    },

    /** The workspaces being listened to. */
    active: () => [...held.keys()],
  };
}

/**
 * Tie a page's subscriptions to the page: when `contents` (an Electron
 * WebContents) is destroyed, loses its process, or loads another document,
 * what it subscribed to is released. A change of fragment or history state
 * inside the same document is not a new page.
 */
function releaseWithPage(hub, contents) {
  const owner = contents.id; // read now: a destroyed page cannot be asked for it
  const gone = () => hub.releaseOwner(owner);
  contents.on('destroyed', gone);
  contents.on('render-process-gone', gone);
  contents.on('did-start-navigation', (details, _url, isInPlace, isMainFrame) => {
    const mainFrame = details?.isMainFrame ?? isMainFrame;
    const sameDocument = details?.isSameDocument ?? isInPlace;
    if (mainFrame && !sameDocument) gone();
  });
}

module.exports = { createSubscriptionHub, releaseWithPage };

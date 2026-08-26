// Switching sync on, and looking at what it has been doing.
//
// A dialog of its own rather than a section of `settings.ts`, whose own comment
// explains why: that one is "the one preference the app has", and a preference
// is not this. Sync has state that changes without anyone touching it, a
// two-branch setup flow, and faults that need a next step — none of which
// belongs beside a text-size chooser.
//
// Not a screen either. A screen means a `ViewName`, the hidden-root rule and
// the switch tests, and this is opened, read and closed.

import { openDialog } from "./dialog-shell";
import {
  onSyncState,
  syncConnect,
  syncCreate,
  syncDisconnect,
  syncNow,
  syncPreflight,
  syncProbe,
  syncSummary,
  type GhAccount,
  type SyncState,
  type SyncSummary,
} from "./ipc";
import { agoLabel, blockedCopy, faultCopy, repoCopy } from "./sync-copy";

/** The name offered when creating. Fixed rather than generated from anything
 *  local: it is the name the *second* machine will look for. */
export const DEFAULT_REPO_NAME = "cowork-deck-memory";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** Draw sync into any box, and keep it honest for as long as it is on screen.
 *
 *  Two callers: the dialog below, which the first-run offer opens, and the Settings
 *  window's "Config repository" section. One implementation rather than two,
 *  because there is one set of facts and five states of them — not set up, running,
 *  waiting on an answer, faulted, and impossible — and a second rendering would
 *  drift from this one on the third state nobody remembered to update.
 *
 *  `dispose` is not optional for the caller: the loop pushes state after every
 *  cycle, and a subscription left behind would keep drawing into a box that is no
 *  longer in the document. */
export function mountSync(body: HTMLElement): { dispose: () => void } {
  let unlisten: (() => void) | null = null;
  let gone = false;
  const render = async () => {
    if (gone) return;
    body.replaceChildren();
    const summary = await syncSummary();
    if (summary.on) renderOn(body, summary, render);
    else await renderOff(body, render);
  };
  void render();
  void onSyncState((s: SyncState) => {
    // The loop pushes after every cycle, so a panel left open stays honest
    // without polling.
    void syncSummary().then((sum) => {
      if (gone || !sum.on) return;
      body.replaceChildren();
      renderOn(body, { ...sum, state: s }, render);
    });
  }).then((u) => {
    // A dispose that beat the listen call would otherwise leak it.
    if (gone) u();
    else unlisten = u;
  });
  return { dispose: () => { gone = true; unlisten?.(); } };
}

/** Open it. Resolves when the dialog closes. */
export function syncDialog(): Promise<void> {
  return new Promise((resolve) => {
    let live: { dispose: () => void } | null = null;
    const finish = () => {
      live?.dispose();
      close();
      resolve();
    };

    const { box, close } = openDialog({
      onCancel: finish,
      // Enter must not switch sync on. Publishing a person's session history is
      // not something a stray keystroke gets to do.
      onAccept: () => {},
      labelledBy: "sync-title",
    });

    const title = el("div", "modal-title", "Memory sync");
    title.id = "sync-title";
    box.append(title);

    const body = el("div", "sync-body");
    box.append(body);

    const actions = el("div", "modal-actions");
    const done = el("button", "modal-ok", "Close");
    done.onclick = finish;
    actions.append(done);
    box.append(actions);

    live = mountSync(body);
  });
}

/** Sync is running. What it has done, and what is wrong if anything is. */
function renderOn(body: HTMLElement, summary: SyncSummary, refresh: () => void) {
  const now = Math.floor(Date.now() / 1000);

  const where = el("p", "form-hint");
  where.textContent = `Syncing to ${summary.remote ?? "a repository"} as “${summary.machine.label}”.`;
  body.append(where);

  // The age of the last push, always visible and never behind a click. A sync
  // broken for three weeks and a working one look identical from outside until
  // a disk dies and the remote turns out to be a month stale.
  const when = el("p", "sync-when");
  when.textContent =
    `Last sent ${agoLabel(summary.state.lastPush, now)}`
    + ` · last received ${agoLabel(summary.state.lastPull, now)}`;
  body.append(when);

  if (summary.state.fault) {
    const copy = faultCopy(summary.state.fault);
    const fault = el("div", "sync-fault");
    fault.append(el("p", "sync-fault-text", copy.text));
    if (copy.action) {
      const act = el("button", "modal-ok", copy.action);
      act.onclick = () => void syncNow().then(refresh);
      fault.append(act);
    }
    body.append(fault);
  }

  const row = el("div", "sync-row");
  const now_ = el("button", "modal-ok", "Sync now");
  now_.onclick = () => void syncNow().then(refresh);
  const off = el("button", "modal-cancel", "Stop syncing");
  off.onclick = () => void syncDisconnect().then(refresh);
  row.append(now_, off);
  body.append(row);

  const note = el("p", "form-hint");
  note.textContent =
    "Stopping leaves the repository and everything in it alone; it only stops "
    + "this machine sending to it.";
  body.append(note);
}

/** Sync is off. What it would do, and what stands in the way. */
async function renderOff(body: HTMLElement, refresh: () => void) {
  const what = el("p", "form-hint");
  what.textContent =
    "Keeps your workspaces, scenarios and the memory of past sessions in a "
    + "private GitHub repository, so a second machine has them too. Session "
    + "layout, window state and connected accounts stay on this machine.";
  body.append(what);

  const pre = await syncPreflight();

  if (pre.error) {
    // A failed listing is a fault, not an empty one: telling someone with two
    // accounts that they have none is its own bug.
    body.append(el("p", "sync-fault-text", `GitHub accounts could not be read: ${pre.error}`));
    return;
  }
  if (pre.blocked) {
    const copy = blockedCopy(pre.blocked);
    body.append(el("p", "sync-fault-text", copy.text));
    return;
  }

  const picked = { account: pre.accounts[0] as GhAccount | undefined };
  if (pre.accounts.length > 1) {
    const label = el("label", "form-label", "Account");
    const select = el("select", "form-input");
    for (const a of pre.accounts) {
      const opt = el("option", undefined, `${a.login} · ${a.host}`);
      opt.value = `${a.host}/${a.login}`;
      select.append(opt);
    }
    select.onchange = () => {
      picked.account = pre.accounts.find((a) => `${a.host}/${a.login}` === select.value);
    };
    label.append(select);
    body.append(label);
  }

  const status = el("p", "sync-status");
  body.append(status);

  // Both paths, both visible. Connecting is not an edge case: it is what every
  // machine after the first one does, and a wizard that only creates leaves the
  // second machine with a second repository and a divergent memory.
  const create = el("button", "modal-ok", `Create ${DEFAULT_REPO_NAME} (private)`);
  create.onclick = () => {
    const a = picked.account;
    if (!a) return;
    status.textContent = "Creating…";
    void syncCreate(a.host, a.login, DEFAULT_REPO_NAME)
      .then(refresh)
      .catch((e) => {
        status.textContent = String(e);
      });
  };

  const existingLabel = el("label", "form-label", "…or connect one you already have");
  const existing = el("input", "form-input");
  existing.placeholder = "owner/repository";
  existingLabel.append(existing);

  const connect = el("button", "modal-cancel", "Connect");
  connect.onclick = () => {
    const a = picked.account;
    const repo = existing.value.trim();
    if (!a || !repo) return;
    status.textContent = "Checking…";
    void syncProbe(a.host, a.login, repo).then((state) => {
      const copy = repoCopy(state);
      status.textContent = copy.text;
      if (!copy.ok) return;
      void syncConnect(a.host, a.login, repo, `https://${a.host}/${repo}.git`)
        .then(refresh)
        .catch((e) => {
          status.textContent = String(e);
        });
    });
  };

  const row = el("div", "sync-row");
  row.append(create);
  body.append(row, existingLabel, connect);

  const privacy = el("p", "form-hint");
  privacy.textContent =
    "The repository is private. It will hold your session summaries and project "
    + "facts, so it is worth keeping that way.";
  body.append(privacy);
}

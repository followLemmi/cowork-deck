// The one time the deck mentions memory sync without being asked.
//
// A banner rather than a dialog, for the reason `board.ts` already gives for the
// card-migration offer: it survives a restart and does not demand a decision at
// the moment the app opens. Somebody who has just launched the deck wants their
// sessions back, not a question — and a question that blocks that is the fastest
// way to teach people to dismiss things unread.

import type { UiState, Workspace } from "./ipc";

export interface OfferInput {
  /** Whether sync is already running. */
  on: boolean;
  /** Workspaces this machine has. */
  workspaces: Pick<Workspace, "id">[];
  ui: Pick<UiState, "syncOfferDismissed">;
}

/** Whether to say anything at all.
 *
 *  Three conditions, and the third is the one worth arguing about: a fresh
 *  install with no workspaces is not offered sync, because there is nothing yet
 *  to lose and nothing to carry to a second machine. Selling a feature before it
 *  can do anything is how a first run becomes a queue of notices. */
export function shouldOffer(o: OfferInput): boolean {
  if (o.on) return false;
  if (o.ui.syncOfferDismissed) return false;
  return o.workspaces.length > 0;
}

/** What the banner says.
 *
 *  Names what travels *and* what does not, in that order, because the second is
 *  the half people assume wrong — and because an offer to publish anything is
 *  owed a straight answer about what it publishes before it is accepted. */
export function offerText(workspaceCount: number): string {
  const n = workspaceCount;
  return (
    `Your ${n} workspace${n === 1 ? "" : "s"}, their scenarios and the memory of past `
    + `sessions can be kept in a private GitHub repository, so a second machine has `
    + `them too. Session layout and connected accounts stay on this machine.`
  );
}

/** Build the banner. `onSetUp` opens the dialog; `onDismiss` puts it away for
 *  good on this machine.
 *
 *  Two buttons and no close cross: a third way out that means something
 *  different from either of them is a decision nobody wanted to make. "Not now"
 *  is honest about what it does — it is the last time the deck brings this up
 *  by itself, and the palette still has it.
 */
export function offerBanner(
  workspaceCount: number,
  onSetUp: () => void,
  onDismiss: () => void,
): HTMLElement {
  const box = document.createElement("div");
  box.className = "sync-offer";
  // A region rather than an alert: an alert interrupts a screen reader in the
  // middle of whatever the person was doing, and this is an offer, not news.
  box.setAttribute("role", "region");
  box.setAttribute("aria-label", "Memory sync");

  const text = document.createElement("p");
  text.className = "sync-offer-text";
  text.textContent = offerText(workspaceCount);
  box.append(text);

  const row = document.createElement("div");
  row.className = "sync-offer-actions";

  const setup = document.createElement("button");
  setup.className = "modal-ok";
  setup.textContent = "Set it up";
  setup.onclick = onSetUp;

  const not = document.createElement("button");
  not.className = "modal-cancel";
  not.textContent = "Not now";
  not.onclick = onDismiss;

  row.append(setup, not);
  box.append(row);
  return box;
}

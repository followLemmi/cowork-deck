// Whether a closing session gets a note, and the question that asks.
//
// This is the only thing in the memory write path a person sees, and it is where
// consent lives. Capture reads a whole session transcript, sends it to a model,
// and **the call is billed to their own Claude account** — none of which is
// something to start doing on somebody's behalf because they closed a tile.
//
// The decision is split from the dialog on purpose: `decideCapture` is a pure
// function over three facts, so the rules about when *not* to ask can be tested
// without a DOM, and they are the half worth getting right. A question asked at
// the wrong moment is not a smaller fault than a missing one — being asked on
// every close is how a question becomes a reflex click, and a reflex click is
// not consent.

import { openDialog } from "./dialog-shell";
import { labeledCheck } from "./forms";

/** What the backend says about whether a note is even possible here. */
export interface CaptureOffer {
  available: boolean;
  reason?: string;
}

export interface CaptureDecision {
  /** Ask, write without asking, or write nothing and say nothing. */
  action: "ask" | "capture" | "skip";
  /** Why nothing is happening, when there is something worth logging. */
  reason?: string;
}

/** What to do about a note for a session that is closing.
 *
 *  `remembered` is `ui_state.captureOnClose`: `undefined` for never asked, which
 *  is deliberately not the same as `false`.
 *
 *  Deliberately knows nothing about whether a note is *possible* here, which is
 *  a separate question with a separate owner. It is guarded twice, in the two
 *  places it means something different:
 *
 *  - before **asking**, by `askWorthPutting` — a question about spending money on
 *    something that cannot work is worse than no offer at all;
 *  - before **queueing**, by `enqueue_on_close` in Rust — a remembered "yes" must
 *    not queue a job for a session this build cannot read, which would be a
 *    failed job on every close of such a tile, forever, for somebody who agreed
 *    to notes once and about something else.
 *
 *  Folding both into here would have meant fetching the offer on every close,
 *  including the closes of people who have already said no. */
export function decideCapture(remembered: boolean | undefined): CaptureDecision {
  if (remembered === true) return { action: "capture" };
  if (remembered === false) return { action: "skip" };
  return { action: "ask" };
}

/** Whether the question is worth putting to somebody at all.
 *
 *  Asked only on the path that is about to open a dialog, so the round trip it
 *  costs is free next to the dialog it might prevent. */
export function askWorthPutting(offer: CaptureOffer): CaptureDecision {
  return offer.available ? { action: "ask" } : { action: "skip", reason: offer.reason };
}

export interface CaptureAnswer {
  capture: boolean;
  /** Whether this answer stands for every close from now on. */
  remember: boolean;
}

/** The question itself. */
export function captureQuestion(name: string): string {
  return `Write a note about “${name}” before it closes?`;
}

/** The part that must not be left out, and must not be a footnote.
 *
 *  What is sent, to whom, and who pays. A person who finds out from an invoice
 *  was not asked, so this sits above the buttons rather than under them — and it
 *  says "your own Claude account" rather than "an API", because the second reads
 *  like somebody else's bill. */
export function captureCostNotice(): string {
  return (
    "This session's transcript is sent to a model to be summarised, and the call runs "
    + "on your own Claude account — so it spends from your plan or your API budget. "
    + "The note is saved on this machine, and is what later sessions search."
  );
}

/** Ask, and resolve what was answered.
 *
 *  Escape and the backdrop mean no, like every other dialog here, and no is a
 *  complete answer: it is not remembered unless the box is ticked, so a person
 *  who dismisses this is asked again next time rather than having been taken to
 *  have opted out for good. */
export function askCapture(name: string): Promise<CaptureAnswer> {
  return new Promise((resolve) => {
    let remember = false;
    const finish = (capture: boolean) => {
      close();
      resolve({ capture, remember });
    };

    const { box, close } = openDialog({
      onCancel: () => finish(false),
      onAccept: () => finish(true),
      labelledBy: "capture-title",
    });

    const title = document.createElement("div");
    title.className = "modal-title";
    title.id = "capture-title";
    title.textContent = captureQuestion(name);

    const cost = document.createElement("p");
    cost.className = "form-hint";
    cost.textContent = captureCostNotice();

    const boxEl = document.createElement("input");
    boxEl.type = "checkbox";
    boxEl.dataset.fk = "capture-remember";
    boxEl.onchange = () => {
      remember = boxEl.checked;
    };
    const label = labeledCheck("Remember my answer for every session", boxEl);

    const row = document.createElement("div");
    row.className = "modal-actions";
    const no = document.createElement("button");
    no.className = "modal-cancel";
    no.textContent = "No note";
    no.onclick = () => finish(false);
    const yes = document.createElement("button");
    yes.className = "modal-ok";
    yes.textContent = "Write the note";
    yes.onclick = () => finish(true);
    row.append(no, yes);

    box.append(title, cost, label, row);
    // The refusal takes focus, not the button that spends money. Enter still
    // accepts — `dialog-shell` owns that — so this costs the keyboard nothing and
    // makes the default click the harmless one.
    no.focus();
  });
}

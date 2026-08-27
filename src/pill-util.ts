/** Pure label formatting for the status pill. No DOM/Tauri dependency — unit-tested
 *  directly without a jsdom environment, which is the whole reason this file is
 *  separate from `pill.ts`: the rule below is a rule, and it is tested as one.
 */

/** What the deck is up against, as the pill needs it. The same shape
 *  `deckLimit` produces in `usage.ts`, restated as an input here so this file
 *  keeps its promise of importing nothing. */
export interface PillLimit {
  exhausted: boolean;
  /** Epoch ms, or `null` when it is not known. */
  resetsAt: number | null;
}

/** What the pill says.
 *
 *  **Exhaustion outranks a waiting count**, and that is the decision this
 *  function exists to hold. When the budget is spent, "3 waiting for input" is a
 *  lie by omission: nothing is waiting for input, nothing is waiting for
 *  anything, and the sentence sends somebody back to the app to find three
 *  terminals that will not accept a keystroke's worth of progress. The count is
 *  still true, and it is still the wrong thing to say — what changes what the
 *  person does next is the ceiling.
 *
 *  A reset time is carried when there is one, and its absence is said plainly
 *  rather than left as an implication. A pill that said "limit" and stopped would
 *  leave the reader unable to tell "we do not know when" from "we did not
 *  bother".
 */
export function pillLabel(n: number, limit?: PillLimit | null, now = Date.now()): string {
  if (limit?.exhausted) {
    if (limit.resetsAt === null) return "limit · no reset time known";
    return `limit · resets ${clock(limit.resetsAt, now)}`;
  }
  return `${n} waiting for input`;
}

/** Whether the pill should be up at all.
 *
 *  Two reasons now, and the second is the point of #305: a spent budget is
 *  exactly the state a person needs told about while they are not looking at the
 *  window. Before this, stepping away from an exhausted deck showed nothing,
 *  because nothing was waiting for input.
 */
export function pillWanted(n: number, limit?: PillLimit | null): boolean {
  return n > 0 || limit?.exhausted === true;
}

/** A reset time at the precision a 200-pixel pill can carry: a clock for today,
 *  a day and a clock for anything further out. Deliberately a local copy of the
 *  shorter half of `formatReset` — the pill is a separate page with its own
 *  module graph, and importing the app's usage module into it to format one
 *  string would pull the IPC surface into a window that has none. */
function clock(at: number, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (new Date(now).toDateString() === d.toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

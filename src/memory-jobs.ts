// What has been captured, what failed, and what it cost.
//
// The queue keeps finished jobs on purpose — #364's retention says why: "a queue
// that forgets succeeded jobs cannot answer 'did this session get captured?'" —
// and until now nothing asked it. The cost went to stderr, which is not where
// anybody looks for a number they are paying.
//
// # A dialog rather than a fourth rail page
//
// The rail's three pages are places you work: the deck, the journal you browse,
// the scenarios you keep. This is a status readout you open, read and close — and
// a rail page costs an icon, the ink, a keyboard stop and its own tests to say the
// same four things. Said plainly rather than quietly downgraded: if it turns out
// to be somewhere people live, it should become a page.
//
// # Retrying spends money
//
// The same sentence the close-time question owes, owed again here. A person who
// has fixed whatever broke should not have to close another tile to find out, and
// should not press a button that costs them something without being told.

import { openDialog } from "./dialog-shell";
import {
  memoryJobs, memoryRetryJob, memoryStatus, onMemoryChanged, revealPath,
  type MemoryJob, type MemoryStatus,
} from "./ipc";
import { megabytes } from "./memory-model";

/** How much of a failure's reason is shown before it is folded away.
 *
 *  `lastError` can hold up to 2000 characters of model output — ours to keep
 *  (#365), and useful when a parse failed — but a wall of it as a list row's
 *  headline buries the one line that says which job. */
const REASON_HEAD = 140;

export interface Spend {
  /** Jobs that made a model call. */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Only from jobs whose cost carried a dollar figure. */
  usd: number;
  /** Whether every call that cost something reported a dollar figure. When it did
   *  not, the total is a floor rather than a sum, and saying so beats a number
   *  that is quietly short. */
  complete: boolean;
}

/** What the captures on this machine have cost.
 *
 *  Over the jobs the queue still holds, which is bounded by its retention — so
 *  this is "recently", not "ever", and the sentence built from it says so. */
export function spend(jobs: MemoryJob[]): Spend {
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let usd = 0;
  let complete = true;
  for (const job of jobs) {
    if (!job.cost) continue;
    calls += 1;
    inputTokens += job.cost.inputTokens;
    outputTokens += job.cost.outputTokens;
    if (typeof job.cost.usd === "number") usd += job.cost.usd;
    else complete = false;
  }
  return { calls, inputTokens, outputTokens, usd, complete };
}

/** The spend, in a sentence. */
export function spendLine(s: Spend): string {
  if (s.calls === 0) return "No session has been summarised yet, so nothing has been spent.";
  const notes = s.calls === 1 ? "1 note" : `${s.calls} notes`;
  const tokens = `${s.inputTokens.toLocaleString()} in, ${s.outputTokens.toLocaleString()} out`;
  if (s.usd === 0) return `${notes} written recently — ${tokens}.`;
  const money = `$${s.usd.toFixed(4)}`;
  // "At least", because a job whose CLI reported no dollar figure contributes
  // tokens and no money: a bare total would be quietly short.
  return `${notes} written recently — ${tokens}, ${s.complete ? "" : "at least "}${money}.`;
}

/** Whether the index has fallen behind the notes on disk.
 *
 *  Two shapes of behind, and only one is worth saying. Files present with no
 *  chunks is the measured 120-letter floor (#375) and is reported by the search
 *  surface already; an index that has never run is what this says. */
export function staleLine(status: MemoryStatus): string | null {
  if (status.model.state !== "present") {
    return `Nothing is indexed: searching needs the ${megabytes(status.model.total)} model, `
      + "offered under Settings → Session notes.";
  }
  if (status.state === "absent") {
    return "The notes have not been indexed yet. It runs in the background.";
  }
  return null;
}

/** One job, in a line. */
export function jobLine(job: MemoryJob): string {
  const who = job.sessionName ?? job.sessionId;
  switch (job.state) {
    case "queued":
      return `${who} — waiting to be summarised`;
    case "running":
      return `${who} — being summarised now`;
    case "done":
      return job.notePath ? `${who} — written` : `${who} — nothing worth writing`;
    case "failed":
      return `${who} — gave up after ${job.attempts} ${job.attempts === 1 ? "try" : "tries"}`;
  }
}

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

/** Open it. */
export function openMemoryJobs(): void {
  let gone = false;
  let unlisten: (() => void) | null = null;
  const { box, close } = openDialog({
    // Every way out goes through `finish`, so the subscription is dropped
    // whichever way the dialog was left — Escape, the backdrop, or the button.
    onCancel: () => finish(),
    // Enter accepts nothing here: there is no field and no decision, only rows
    // with their own buttons.
    onAccept: () => {},
    labelledBy: "memory-jobs-title",
  });
  const finish = () => {
    gone = true;
    unlisten?.();
    close();
  };

  const title = el("div", "modal-title", "What has been captured");
  title.id = "memory-jobs-title";
  const summary = el("p", "form-hint");
  summary.dataset.fk = "jobs-summary";
  const stale = el("p", "form-hint");
  stale.dataset.fk = "jobs-stale";
  const list = el("div", "notes-list");
  list.dataset.fk = "jobs-list";
  // Said once, at the bottom, rather than beside every button: it is the same
  // fact each time and a repeated warning is a warning nobody reads.
  const cost = el(
    "p",
    "form-hint",
    "Trying a job again runs the summary once more, on your own Claude account. "
      + "This machine only — each machine keeps its own queue.",
  );

  const row = (job: MemoryJob) => {
    const wrap = el("div", "notes-row");
    wrap.dataset.job = job.jobId;
    const head = el("div", "notes-row-head");
    head.append(el("span", "notes-row-title", jobLine(job)));
    if (job.cost) {
      const c = job.cost;
      const money = typeof c.usd === "number" ? `, $${c.usd.toFixed(4)}` : "";
      head.append(
        el("span", "notes-row-when", `${c.inputTokens} in, ${c.outputTokens} out${money}`),
      );
    }
    if (job.state === "failed") {
      const again = el("button", "rooms-add", "Try again");
      again.type = "button";
      again.dataset.fk = `job-retry-${job.jobId}`;
      again.onclick = () => {
        again.disabled = true;
        void memoryRetryJob(job.jobId).catch((e) => {
          again.disabled = false;
          wrap.append(el("p", "rooms-fault", String(e)));
        });
      };
      head.append(again);
    }
    if (job.notePath) {
      const show = el("button", "rooms-add", "Show the note");
      show.type = "button";
      show.dataset.fk = `job-note-${job.jobId}`;
      show.onclick = () => {
        void revealPath(job.notePath!).catch((e) => {
          wrap.append(el("p", "rooms-fault", String(e)));
        });
      };
      head.append(show);
    }
    wrap.append(head);
    /* The reason, as detail. It can hold model output — bounded at 2000
       characters and kept because a parse failure is otherwise a mystery — so it
       goes under the line that says which job, trimmed, rather than becoming the
       row's headline. */
    if (job.lastError) {
      const reason = job.lastError.length > REASON_HEAD
        ? `${job.lastError.slice(0, REASON_HEAD)}…`
        : job.lastError;
      const detail = el("div", "notes-row-text", reason);
      detail.title = job.lastError;
      wrap.append(detail);
    }
    return wrap;
  };

  const render = async () => {
    if (gone) return;
    let jobs: MemoryJob[];
    try {
      jobs = await memoryJobs();
    } catch (e) {
      if (gone) return;
      summary.textContent = `The queue could not be read (${e}).`;
      return;
    }
    if (gone) return;
    summary.textContent = spendLine(spend(jobs));

    // Newest first: what just happened is what somebody opened this to see.
    const shown = [...jobs].reverse();
    list.replaceChildren();
    if (shown.length === 0) {
      list.append(
        el("p", "form-hint", "No sessions have been closed with a note on this machine yet."),
      );
    }
    for (const job of shown) list.append(row(job));

    try {
      const status = await memoryStatus();
      if (gone) return;
      const line = staleLine(status);
      stale.textContent = line ?? "";
      stale.hidden = line === null;
    } catch {
      // Not worth a message of its own: the jobs are the point here, and the
      // model's own surface says what is missing where it is offered.
      stale.hidden = true;
    }
  };

  box.append(title, summary, stale, list, cost);
  void render();
  try {
    void onMemoryChanged(() => void render())
      .then((un) => {
        if (gone) un();
        else unlisten = un;
      })
      .catch((e) => console.debug("memory job updates unavailable", e));
  } catch (e) {
    console.debug("memory job updates unavailable", e);
  }

}

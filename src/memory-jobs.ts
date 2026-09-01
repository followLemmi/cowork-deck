// What has been captured, what failed, and what it cost.
//
// The queue keeps finished jobs on purpose — #364's retention says why: "a queue
// that forgets succeeded jobs cannot answer 'did this session get captured?'" —
// and until now nothing asked it. The cost went to stderr, which is not where
// anybody looks for a number they are paying.
//
// # A section of the memory page, and no longer a dialog
//
// #378 shipped this as a dialog and said what would retire it: "a rail page costs
// an icon, the ink, a keyboard stop and its own tests to say the same four
// things… if it turns out to be somewhere people live, it should become a page."
// #380 gave memory a page for its own reasons, and a second door onto one set of
// facts is how they drift — so this moved rather than staying beside it.
//
// **Collapsed on arrival.** What somebody opens the memory page for is their
// notes; a list of jobs above them would put the plumbing in front of the point.
// So it sits below both the corpus and the controls that write into it, folded,
// with its own count on the header.
//
// # Retrying spends money
//
// The same sentence the close-time question owes, owed again here. A person who
// has fixed whatever broke should not have to close another tile to find out, and
// should not press a button that costs them something without being told. It
// survives the move, as does the second sentence beside it: the queue is THIS
// machine's, because a queued job names a transcript path here.

import {
  memoryJobs, memoryRetryJob, memoryStatus, revealPath,
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

/** The two sentences the move must not lose.
 *
 *  Both were in the dialog and both are easy to drop when a layout changes. The
 *  first is the one a button that spends somebody's money owes; the second
 *  answers "why is this list different on my other machine" before it is asked —
 *  a queued job names a transcript path here.
 *
 *  Said once, at the foot, rather than beside every button: it is the same fact
 *  each time, and a repeated warning is a warning nobody reads. */
export const RETRY_NOTICE =
  "Trying a job again runs the summary once more, on your own Claude account. "
  + "This machine only — each machine keeps its own queue.";

export interface CaptureRecord {
  /** The section, for the memory page to append. */
  readonly mount: HTMLElement;
  /** Re-read the queue and repaint. Driven by the page rather than by a
   *  subscription of its own: the page already re-reads on `memory://changed`
   *  while it is on screen, and a second listener would repaint a section nobody
   *  is looking at. */
  refresh: () => Promise<void>;
  /** Unfold it, for the palette entry that used to open the dialog. */
  reveal: () => void;
}

/** Build the section. */
export function mountCaptureRecord(): CaptureRecord {
  /* Not `.mem-group`: it borrows that class's HEADER, because unfolding is the
     same act, but it is not one of the note groups — and a selector counting the
     groups on the page must not count the plumbing among them. */
  const mount = el("section", "mem-jobs");
  const toggle = el("button", "mem-group-head");
  toggle.type = "button";
  toggle.dataset.fk = "jobs-toggle";
  const label = el("span", "mem-group-title", "What has been captured");
  const count = el("span", "mem-group-count", "");
  toggle.append(label, count);
  const body = el("div", "mem-jobs-body");
  // Collapsed on arrival: the notes are the point, and the plumbing is what you
  // go looking for when something did not happen.
  body.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
  toggle.onclick = () => {
    body.hidden = !body.hidden;
    toggle.setAttribute("aria-expanded", String(!body.hidden));
  };

  const summary = el("p", "mem-write-note");
  summary.dataset.fk = "jobs-summary";
  const stale = el("p", "mem-write-note");
  stale.dataset.fk = "jobs-stale";
  const list = el("div", "mem-rows");
  list.dataset.fk = "jobs-list";
  const notice = el("p", "mem-write-note", RETRY_NOTICE);
  body.append(summary, stale, list, notice);
  mount.append(toggle, body);

  /** One job, in as many lines as the column has room for.
   *
   *  Stacked rather than crowded: this column is 280–384px, and a job already
   *  carries a name, a state, a token count and up to two buttons. The honest
   *  answer to that is fewer facts per line, not a smaller type size. */
  const row = (job: MemoryJob) => {
    const wrap = el("div", "notes-row mem-job");
    wrap.dataset.job = job.jobId;
    wrap.append(el("div", "notes-row-title", jobLine(job)));
    if (job.cost) {
      const c = job.cost;
      const money = typeof c.usd === "number" ? `, $${c.usd.toFixed(4)}` : "";
      wrap.append(
        el("div", "notes-row-when", `${c.inputTokens} in, ${c.outputTokens} out${money}`),
      );
    }
    /* The reason, as detail. It can hold model output — bounded at 2000
       characters and kept because a parse failure is otherwise a mystery — so it
       goes under the line that says which job, trimmed, rather than becoming the
       row's headline. Whole on hover. */
    if (job.lastError) {
      const reason = job.lastError.length > REASON_HEAD
        ? `${job.lastError.slice(0, REASON_HEAD)}…`
        : job.lastError;
      const detail = el("div", "notes-row-text", reason);
      detail.title = job.lastError;
      wrap.append(detail);
    }
    const acts = el("div", "mem-job-acts");
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
      acts.append(again);
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
      acts.append(show);
    }
    if (acts.childElementCount > 0) wrap.append(acts);
    return wrap;
  };

  const refresh = async () => {
    let jobs: MemoryJob[];
    try {
      jobs = await memoryJobs();
    } catch (e) {
      summary.textContent = `The queue could not be read (${e}).`;
      count.textContent = "";
      return;
    }
    summary.textContent = spendLine(spend(jobs));
    /* The count on the header, so a folded section still says whether anything
       needs a person. Failures rather than jobs: the number worth seeing without
       unfolding is the one that means something did not happen. */
    const failed = jobs.filter((j) => j.state === "failed").length;
    count.textContent = failed > 0 ? `${failed} failed` : String(jobs.length);
    toggle.classList.toggle("has-fault", failed > 0);

    // Newest first: what just happened is what somebody opened this to see.
    const shown = [...jobs].reverse();
    list.replaceChildren();
    if (shown.length === 0) {
      list.append(
        el("p", "mem-write-note", "No sessions have been closed with a note on this machine yet."),
      );
    }
    for (const job of shown) list.append(row(job));

    try {
      const status = await memoryStatus();
      const line = staleLine(status);
      stale.textContent = line ?? "";
      stale.hidden = line === null;
    } catch {
      // Not worth a message of its own: the jobs are the point here, and the
      // model's own surface says what is missing where it is offered.
      stale.hidden = true;
    }
  };

  return {
    mount,
    refresh,
    reveal: () => {
      body.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      // Guarded: jsdom has no layout and no `scrollIntoView`, and this is a
      // convenience — losing it must not cost the unfolding it accompanies.
      toggle.scrollIntoView?.({ block: "nearest" });
      toggle.focus();
    },
  };
}

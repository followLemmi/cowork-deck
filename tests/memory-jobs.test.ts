// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  jobLine, openMemoryJobs, spend, spendLine, staleLine,
} from "../src/memory-jobs";
import type { MemoryJob, MemoryStatus } from "../src/ipc";

const jobs = vi.fn();
const retry = vi.fn();
const status = vi.fn();
const reveal = vi.fn();
let changed: (() => void) | null = null;
const unlisten = vi.fn();
vi.mock("../src/ipc", () => ({
  memoryJobs: () => jobs(),
  memoryRetryJob: (id: string) => retry(id),
  memoryStatus: () => status(),
  revealPath: (p: string) => reveal(p),
  onMemoryChanged: (fn: () => void) => {
    changed = fn;
    return Promise.resolve(unlisten);
  },
}));

const TOTAL = 479_383_128;
const ready = (over: Partial<MemoryStatus> = {}): MemoryStatus => ({
  root: "/r", cache: "/r/.index", state: "ready", files: 3, chunks: 9, dim: 384,
  model: { dir: "/r/.model", state: "present", have: TOTAL, total: TOTAL },
  ...over,
});

const job = (over: Partial<MemoryJob> = {}): MemoryJob => ({
  jobId: "j-1",
  queuedAt: 1,
  sessionId: "s-1",
  workspaceId: "ws-1",
  transcriptPath: "/t/s-1.jsonl",
  cliKind: "claude",
  sessionName: "relay",
  state: "done",
  attempts: 1,
  lastError: null,
  notePath: "/r/ws-1/Sessions/2026-08/31-a.md",
  cost: { inputTokens: 756, outputTokens: 4704, usd: 0.0257 },
  ...over,
});

/* The number went to stderr until now, which is not where anybody looks for
   something they are paying. */
describe("what the captures have cost", () => {
  it("adds up only the jobs that made a call", () => {
    const s = spend([
      job(),
      job({ jobId: "j-2", cost: { inputTokens: 100, outputTokens: 200, usd: 0.001 } }),
      // An empty session: a success that spent nothing.
      job({ jobId: "j-3", cost: null, notePath: null }),
    ]);
    expect(s.calls).toBe(2);
    expect(s.inputTokens).toBe(856);
    expect(s.outputTokens).toBe(4904);
    expect(s.usd).toBeCloseTo(0.0267, 6);
    expect(s.complete).toBe(true);
  });

  /** A bare total over a call whose CLI reported no dollar figure would be
   *  quietly short, which is the one way a money number must not be wrong. */
  it("says the total is a floor when a call reported no money", () => {
    const s = spend([
      job(),
      job({ jobId: "j-2", cost: { inputTokens: 10, outputTokens: 20 } }),
    ]);
    expect(s.complete).toBe(false);
    expect(spendLine(s)).toContain("at least $");
  });

  it("says nothing has been spent when nothing has", () => {
    expect(spendLine(spend([]))).toContain("nothing has been spent");
    expect(spendLine(spend([job({ cost: null })]))).toContain("nothing has been spent");
  });

  /** "Recently", because the queue's retention bounds what there is to add up —
   *  a sentence claiming a lifetime total would be wrong the moment it pruned. */
  it("does not claim to be a lifetime total", () => {
    expect(spendLine(spend([job()]))).toContain("recently");
  });

  it("counts one note as one note", () => {
    expect(spendLine(spend([job()]))).toContain("1 note written");
  });
});

describe("what a job's line says", () => {
  it("names each state in words", () => {
    expect(jobLine(job({ state: "queued" }))).toContain("waiting to be summarised");
    expect(jobLine(job({ state: "running" }))).toContain("being summarised now");
    expect(jobLine(job({ state: "done" }))).toContain("written");
  });

  /** A success that wrote nothing is not a failure, and the line must not read
   *  like one: an empty session is the case capture is designed to skip. */
  it("tells a note that was not worth writing from one that failed", () => {
    expect(jobLine(job({ state: "done", notePath: null }))).toContain("nothing worth writing");
    expect(jobLine(job({ state: "failed", attempts: 3 }))).toContain("gave up after 3 tries");
    expect(jobLine(job({ state: "failed", attempts: 1 }))).toContain("1 try");
  });

  it("falls back to the session id when the tile had no name", () => {
    expect(jobLine(job({ sessionName: null }))).toContain("s-1");
  });
});

describe("staleness", () => {
  it("says nothing when the index is up with the model in place", () => {
    expect(staleLine(ready())).toBeNull();
  });

  /** The model blocks indexing, so reporting "not indexed" to somebody who has
   *  not downloaded it would send them to fix the wrong thing — the same ordering
   *  `searchReadiness` applies. */
  it("blames the missing model before the missing index", () => {
    const line = staleLine(ready({
      state: "absent",
      model: { dir: "/r/.model", state: "absent", have: 0, total: TOTAL },
    }));
    expect(line).toContain("479 MB");
    expect(line).not.toContain("background");
  });

  it("says an index that has not run yet will", () => {
    expect(staleLine(ready({ state: "absent" }))).toContain("not been indexed yet");
  });
});

describe("the dialog", () => {
  const settled = () => new Promise((r) => setTimeout(r, 0));
  const box = () => document.querySelector(".modal-box") as HTMLElement;
  const fk = <T extends HTMLElement>(n: string) => box().querySelector<T>(`[data-fk="${n}"]`)!;

  beforeEach(() => {
    vi.clearAllMocks();
    changed = null;
    document.body.innerHTML = "";
    jobs.mockResolvedValue([job()]);
    status.mockResolvedValue(ready());
    retry.mockResolvedValue(true);
    reveal.mockResolvedValue(undefined);
  });

  it("shows the spend and each job", async () => {
    openMemoryJobs();
    await settled();
    expect(fk("jobs-summary").textContent).toContain("1 note written");
    expect(fk("jobs-list").textContent).toContain("relay");
    expect(fk("jobs-list").textContent).toContain("756 in, 4704 out, $0.0257");
  });

  /** Newest first: what just happened is what somebody opened this to see. */
  it("puts the newest job first", async () => {
    jobs.mockResolvedValue([job({ jobId: "old", sessionName: "older" }), job({ jobId: "new", sessionName: "newer" })]);
    openMemoryJobs();
    await settled();
    const rows = [...fk("jobs-list").querySelectorAll("[data-job]")];
    expect(rows[0].getAttribute("data-job")).toBe("new");
  });

  it("says so when nothing has been captured on this machine", async () => {
    jobs.mockResolvedValue([]);
    openMemoryJobs();
    await settled();
    expect(fk("jobs-list").textContent).toContain("No sessions have been closed with a note");
  });

  /** The one thing a person must be told before pressing it. */
  it("says a retry spends money, and that the queue is this machine's", async () => {
    openMemoryJobs();
    await settled();
    const text = box().textContent ?? "";
    expect(text).toContain("your own Claude account");
    expect(text).toContain("This machine only");
  });

  it("offers a retry only on a failed job", async () => {
    jobs.mockResolvedValue([job({ state: "done" })]);
    openMemoryJobs();
    await settled();
    expect(box().querySelector('[data-fk="job-retry-j-1"]')).toBeNull();

    document.body.innerHTML = "";
    jobs.mockResolvedValue([job({ state: "failed", notePath: null, lastError: "claude timed out" })]);
    openMemoryJobs();
    await settled();
    fk<HTMLButtonElement>("job-retry-j-1").click();
    await settled();
    expect(retry).toHaveBeenCalledWith("j-1");
  });

  /** `lastError` can hold two thousand characters of model output. As a headline
   *  it buries the one line saying which job. */
  it("shows a long reason as trimmed detail, with the whole of it on hover", async () => {
    const long = "x".repeat(500);
    jobs.mockResolvedValue([job({ state: "failed", notePath: null, lastError: long })]);
    openMemoryJobs();
    await settled();
    const detail = box().querySelector(".notes-row-text") as HTMLElement;
    expect(detail.textContent!.length).toBeLessThan(200);
    expect(detail.textContent!.endsWith("…")).toBe(true);
    expect(detail.title).toBe(long);
    // And the row still leads with which job it was.
    expect(box().querySelector(".notes-row-title")!.textContent).toContain("relay");
  });

  it("reveals a note that was written", async () => {
    openMemoryJobs();
    await settled();
    fk<HTMLButtonElement>("job-note-j-1").click();
    expect(reveal).toHaveBeenCalledWith("/r/ws-1/Sessions/2026-08/31-a.md");
  });

  it("re-reads when the queue moves, so a running job does not sit stale", async () => {
    openMemoryJobs();
    await settled();
    expect(jobs).toHaveBeenCalledTimes(1);
    changed!();
    await settled();
    expect(jobs).toHaveBeenCalledTimes(2);
  });

  it("reports a queue it could not read rather than an empty list", async () => {
    jobs.mockRejectedValue("memory is not wired up");
    openMemoryJobs();
    await settled();
    expect(fk("jobs-summary").textContent).toContain("could not be read");
  });

  /** The jobs are the point here; the model's own surface says what is missing
   *  where it is offered. */
  it("survives a status it could not read", async () => {
    status.mockRejectedValue("no sidecar");
    openMemoryJobs();
    await settled();
    expect(fk("jobs-list").textContent).toContain("relay");
    expect(fk("jobs-stale").hidden).toBe(true);
  });

  it("stops listening when it closes", async () => {
    openMemoryJobs();
    await settled();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(unlisten).toHaveBeenCalled();
    expect(document.querySelector(".modal-box")).toBeNull();
  });
});

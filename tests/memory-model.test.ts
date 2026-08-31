// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  megabytes, mountModel, progressLine, searchReadiness, statusLine,
} from "../src/memory-model";
import type { MemoryStatus } from "../src/ipc";

const status = vi.fn();
const download = vi.fn();
let modelHandler: ((e: unknown) => void) | null = null;
const unlisten = vi.fn();
vi.mock("../src/ipc", () => ({
  memoryStatus: () => status(),
  memoryDownloadModel: () => download(),
  onMemoryModel: (fn: (e: unknown) => void) => {
    modelHandler = fn;
    return Promise.resolve(unlisten);
  },
}));

const TOTAL = 479_383_128;
// `Omit` first: `Partial<MemoryStatus>` already declares `model`, so
// intersecting would ask for every field of it rather than allowing a few.
const of = (
  over: Omit<Partial<MemoryStatus>, "model"> & { model?: Partial<MemoryStatus["model"]> } = {},
) =>
  ({
    root: "/r", cache: "/r/.index", state: "ready", files: 12, chunks: 340, dim: 384,
    ...over,
    model: { dir: "/r/.model", state: "present", have: TOTAL, total: TOTAL, ...(over.model ?? {}) },
  }) as MemoryStatus;

/* An empty result is four different situations and only one of them means
   "nothing matched". A search that renders the other three as no results teaches
   people that memory does not work. */
describe("what a search may honestly claim", () => {
  it("is ready when there is a model and an index with something in it", () => {
    expect(searchReadiness(of())).toEqual({ ready: true });
  });

  it("asks for the model first, because nothing can be indexed without it", () => {
    const r = searchReadiness(of({ state: "absent", files: 0, chunks: 0, model: { state: "absent", have: 0 } }));
    expect(r.ready).toBe(false);
    expect(r.offerDownload).toBe(true);
    // The size, and that it is once, and that it stays local.
    expect(r.reason).toContain("479 MB");
    expect(r.reason).toContain("once per machine");
    expect(r.reason?.toLowerCase()).toContain("nothing leaves it");
    // Not the index, which is the wrong thing to go and fix.
    expect(r.reason).not.toContain("indexed");
  });

  /** ADR-0005's whole point about three states: reporting a resumable download as
   *  absent would invite starting 479 MB again with the bytes already there. */
  it("tells a part-finished download from an absent one, and says it resumes", () => {
    const r = searchReadiness(of({ model: { state: "partial", have: 120_000_000 } }));
    expect(r.ready).toBe(false);
    expect(r.offerDownload).toBe(true);
    expect(r.reason).toContain("120 MB of 479 MB");
    expect(r.reason).toContain("resumes");
  });

  it("says an index that has not run yet is not a missing model", () => {
    const r = searchReadiness(of({ state: "absent", files: 0, chunks: 0 }));
    expect(r.ready).toBe(false);
    expect(r.offerDownload).toBeUndefined();
    expect(r.reason).toContain("not been indexed yet");
  });

  it("says an empty corpus is empty rather than broken", () => {
    const r = searchReadiness(of({ state: "empty", files: 0, chunks: 0 }));
    expect(r.ready).toBe(false);
    expect(r.reason).toContain("no notes to search yet");
  });

  /* The measured case (#375): a chunk needs 120 letters, a diary's first lesson
     is about 80, so files can be indexed with nothing searchable in them. This is
     the one somebody would otherwise read as a broken search, because the file is
     right there on disk. */
  it("says notes that are too short to index are too short, not absent", () => {
    const r = searchReadiness(of({ state: "ready", files: 3, chunks: 0 }));
    expect(r.ready).toBe(false);
    expect(r.reason).toContain("too short to index");
    expect(r.reason).toContain("second lesson");
    expect(r.offerDownload).toBeUndefined();
  });
});

describe("the line the settings block shows", () => {
  it("counts what is there when everything is ready", () => {
    expect(statusLine(of())).toBe("12 notes indexed, 340 passages searchable.");
    expect(statusLine(of({ files: 1, chunks: 4 }))).toBe("1 note indexed, 4 passages searchable.");
  });

  it("otherwise says what is missing", () => {
    expect(statusLine(of({ model: { state: "absent", have: 0 } }))).toContain("479 MB");
  });
});

describe("progress", () => {
  it("counts up in megabytes", () => {
    expect(progressLine({ phase: "fetching", got: 12_000_000, total: TOTAL }))
      .toBe("Downloading — 12 MB of 479 MB.");
  });

  it("does not divide by a total it has not been told", () => {
    expect(progressLine({ phase: "fetching", got: 0, total: 0 })).toBe("Downloading…");
  });

  /* Its own phase because it is not instant, and because it is the step that
     decides whether the bytes are a working model rather than a plausible one. */
  it("says when it is checking the model works", () => {
    expect(progressLine({ phase: "verifying", got: TOTAL, total: TOTAL }))
      .toContain("Checking the model works");
  });

  it("carries a failure's own reason rather than a generic one", () => {
    expect(progressLine({ phase: "failed", got: 1, total: 2, error: "the mirror went quiet" }))
      .toBe("the mirror went quiet");
    expect(progressLine({ phase: "failed", got: 1, total: 2 })).toBe("The download failed.");
  });

  it("rounds to whole megabytes, because a byte count is not information", () => {
    expect(megabytes(479_383_128)).toBe("479 MB");
    expect(megabytes(0)).toBe("0 MB");
  });
});

describe("the settings block", () => {
  let body: HTMLElement;
  const settled = () => new Promise((r) => setTimeout(r, 0));
  const fk = <T extends HTMLElement>(n: string) => body.querySelector<T>(`[data-fk="${n}"]`)!;

  beforeEach(() => {
    vi.clearAllMocks();
    modelHandler = null;
    document.body.innerHTML = "";
    body = document.createElement("div");
    document.body.append(body);
    status.mockResolvedValue(of());
    download.mockResolvedValue(true);
  });

  it("offers nothing to download when the model is already here", async () => {
    mountModel(body);
    await settled();
    expect(fk("model-status").textContent).toContain("12 notes indexed");
    expect(fk<HTMLButtonElement>("model-download").hidden).toBe(true);
  });

  it("names the size on the button, so the cost is on the thing you press", async () => {
    status.mockResolvedValue(of({ model: { state: "absent", have: 0 } }));
    mountModel(body);
    await settled();
    const b = fk<HTMLButtonElement>("model-download");
    expect(b.hidden).toBe(false);
    expect(b.textContent).toBe("Download the model (479 MB)");
  });

  it("offers to finish rather than to start, when there is something to resume", async () => {
    status.mockResolvedValue(of({ model: { state: "partial", have: 120_000_000 } }));
    mountModel(body);
    await settled();
    expect(fk<HTMLButtonElement>("model-download").textContent).toBe("Finish the download");
  });

  it("starts a download and shows progress as it arrives", async () => {
    status.mockResolvedValue(of({ model: { state: "absent", have: 0 } }));
    mountModel(body);
    await settled();
    fk<HTMLButtonElement>("model-download").click();
    await settled();
    expect(download).toHaveBeenCalled();

    modelHandler!({ phase: "fetching", got: 5_000_000, total: TOTAL });
    expect(fk("model-status").textContent).toContain("5 MB of 479 MB");
    modelHandler!({ phase: "verifying", got: TOTAL, total: TOTAL });
    expect(fk("model-status").textContent).toContain("Checking the model works");
  });

  /* The sidecar owns whether the model is usable — the probe is inside it — so a
     surface that concluded "ready" for itself would be claiming the one thing it
     cannot know. */
  it("re-reads the status when a download ends rather than assuming it worked", async () => {
    status.mockResolvedValue(of({ model: { state: "absent", have: 0 } }));
    mountModel(body);
    await settled();
    expect(status).toHaveBeenCalledTimes(1);

    status.mockResolvedValue(of());
    modelHandler!({ phase: "ready", got: TOTAL, total: TOTAL });
    await settled();
    expect(status).toHaveBeenCalledTimes(2);
    expect(fk("model-status").textContent).toContain("12 notes indexed");
  });

  it("shows a failure and lets it be tried again", async () => {
    status.mockResolvedValue(of({ model: { state: "absent", have: 0 } }));
    mountModel(body);
    await settled();
    fk<HTMLButtonElement>("model-download").click();
    await settled();
    modelHandler!({ phase: "failed", got: 1, total: TOTAL, error: "the mirror went quiet" });
    await settled();
    // The reason survives the re-read. Replacing it with "you need a 479 MB
    // model" would throw away the only sentence saying what went wrong.
    expect(fk("model-status").textContent).toContain("the mirror went quiet");
    expect(fk<HTMLButtonElement>("model-download").disabled).toBe(false);
    expect(fk<HTMLButtonElement>("model-download").hidden).toBe(false);
  });

  it("reports a status it could not read rather than offering a download blindly", async () => {
    status.mockRejectedValue("the sidecar is not installed");
    mountModel(body);
    await settled();
    expect(fk("model-status").textContent).toContain("could not be read");
    expect(fk<HTMLButtonElement>("model-download").hidden).toBe(true);
  });

  it("stops listening when the settings window closes", async () => {
    const view = mountModel(body);
    await settled();
    view.dispose();
    expect(unlisten).toHaveBeenCalled();
  });
});

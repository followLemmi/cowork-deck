// The embedding model: whether it is here, what it costs to get, and what a
// search may honestly claim while it is not.
//
// Two things live here and the second is the one that matters more.
//
// `searchReadiness` turns the sidecar's status into a sentence. Every surface
// that searches needs it, because **an empty result is four different
// situations** and only one of them means "nothing matched". A search that
// renders the other three as no results teaches people that memory does not
// work — which is the same fault in a different place as a capture that reported
// an empty session because it could not read the log.
//
// `mountModel` is the settings block that offers the download and shows it
// happening. Small, and deliberately: the interesting decisions are ADR-0005's
// and they are already made — resume rather than restart, verify by a probe
// rather than a hash, three states rather than two.

import {
  memoryDownloadModel, memoryStatus, onMemoryModel,
  type MemoryModelEvent, type MemoryStatus,
} from "./ipc";

/** How big the model is, in words rather than bytes. */
export function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

export interface SearchReadiness {
  ready: boolean;
  /** Why not, in a sentence to show where the results would have been. */
  reason?: string;
  /** Whether the answer to it is a download. */
  offerDownload?: boolean;
}

/** What a search may claim, given what the sidecar reports.
 *
 *  The order is the order the causes actually block each other in, and it is why
 *  this is one function rather than a check at each call site: without the model
 *  nothing can be indexed, so reporting "nothing indexed" to somebody who has not
 *  downloaded it would send them to fix the wrong thing. */
export function searchReadiness(status: MemoryStatus): SearchReadiness {
  const m = status.model;
  if (m.state === "partial") {
    return {
      ready: false,
      reason:
        `The embedding model is partly downloaded — ${megabytes(m.have)} of `
        + `${megabytes(m.total)}. Finishing it resumes from there rather than starting again.`,
      offerDownload: true,
    };
  }
  if (m.state !== "present") {
    return {
      ready: false,
      reason:
        `Searching your notes needs a ${megabytes(m.total)} embedding model, downloaded `
        + `once per machine. It runs on your machine and nothing leaves it.`,
      offerDownload: true,
    };
  }
  if (status.state === "absent") {
    return {
      ready: false,
      reason: "Your notes have not been indexed yet. It happens in the background.",
    };
  }
  /* The measured case that would otherwise read as a broken search. A chunk needs
     120 letters to be indexed at all — the floor that keeps markdown skeletons
     out of results — and a diary's first lesson is about 80. So files can be
     present with nothing indexed from them, and a room becomes searchable at
     roughly its second lesson. See #375. */
  if (status.files > 0 && status.chunks === 0) {
    return {
      ready: false,
      reason:
        "Your notes are too short to index yet — a note needs a few lines before it "
        + "can be found. A diary room usually becomes searchable at its second lesson.",
    };
  }
  if (status.state === "empty" || status.chunks === 0) {
    return {
      ready: false,
      reason: "There are no notes to search yet. Closing a session with a note is what fills this.",
    };
  }
  return { ready: true };
}

/** What the settings block says about where things stand. */
export function statusLine(status: MemoryStatus): string {
  const r = searchReadiness(status);
  if (!r.ready) return r.reason ?? "";
  const notes = status.files === 1 ? "1 note" : `${status.files} notes`;
  return `${notes} indexed, ${status.chunks} passages searchable.`;
}

/** Progress, as a line rather than a bar's aria-label. */
export function progressLine(e: MemoryModelEvent): string {
  switch (e.phase) {
    case "fetching":
      return e.total > 0
        ? `Downloading — ${megabytes(e.got)} of ${megabytes(e.total)}.`
        : "Downloading…";
    /* Its own phase, because it is not instant and because it is the step that
       decides whether the bytes are a working model. ADR-0005: a damaged ONNX
       file may still load and still produce vectors, every search then returns
       plausible-looking nonsense, and nothing reports a fault. */
    case "verifying":
      return "Checking the model works…";
    case "ready":
      return "The model is ready. Your notes are being indexed.";
    case "failed":
      return e.error ?? "The download failed.";
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

export interface ModelView {
  dispose: () => void;
}

/** Build the block into `body`. */
export function mountModel(body: HTMLElement): ModelView {
  let gone = false;
  let unlisten: (() => void) | null = null;
  const line = el("p", "form-hint");
  line.dataset.fk = "model-status";
  const action = el("button", "rooms-add", "Download the model");
  action.type = "button";
  action.dataset.fk = "model-download";

  /** `keepLine` leaves the message alone and refreshes only the button.
   *
   *  It exists for one case and it is not cosmetic: after a failure, the line
   *  holds the reason the download failed, and re-rendering it would replace that
   *  with the generic "you need a 479 MB model" — throwing away the only sentence
   *  that says what went wrong. The button still has to come back, because the
   *  answer to most failures is to try again. */
  const render = async (keepLine = false) => {
    if (gone) return;
    let status: MemoryStatus;
    try {
      status = await memoryStatus();
    } catch (e) {
      if (gone) return;
      if (!keepLine) line.textContent = `Memory could not be read (${e}).`;
      action.hidden = true;
      return;
    }
    if (gone) return;
    if (!keepLine) line.textContent = statusLine(status);
    const r = searchReadiness(status);
    action.hidden = !r.offerDownload;
    action.textContent = status.model.state === "partial"
      ? "Finish the download"
      : `Download the model (${megabytes(status.model.total)})`;
  };

  action.onclick = () => {
    action.disabled = true;
    line.textContent = "Starting…";
    void memoryDownloadModel().catch((e) => {
      action.disabled = false;
      line.textContent = String(e);
    });
  };

  body.append(line, action);
  void render();
  /* Guarded, because this is the one call here that can throw *synchronously* —
     and a throw out of `mountModel` escapes the settings section's `fill` and
     leaves the pane half-built. Losing the subscription costs live progress and
     nothing else: the status is re-read whenever the block is opened. */
  try {
    subscribe();
  } catch (e) {
    console.debug("memory model progress unavailable", e);
  }

  function subscribe() {
      void onMemoryModel((e) => {
      if (gone) return;
      line.textContent = progressLine(e);
      // Re-read rather than infer: the sidecar owns whether the model is usable,
      // and "ready" here means the probe passed, which only it can say.
      if (e.phase === "ready" || e.phase === "failed") {
        action.disabled = false;
        // A failure keeps its own reason on screen; a success may say what it got.
        void render(e.phase === "failed");
      }
    }).then((un) => {
      if (gone) un();
      else unlisten = un;
    }).catch((e) => console.debug("memory model progress unavailable", e));
  }

  return {
    dispose: () => {
      gone = true;
      unlisten?.();
    },
  };
}

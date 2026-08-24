// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

/** A stand-in for the pill window that actually remembers whether it is up, so
 *  `isVisible()` answers what `show()`/`hide()` did to it — the whole point of
 *  asking the window instead of keeping a flag beside it. `startsUp` seeds the
 *  state the pill was in before the deck said anything. */
const { listenMock, showMock, hideMock, isVisibleMock, startsUp } = vi.hoisted(() => {
  let up = false;
  return {
    listenMock: vi.fn(),
    showMock: vi.fn(async () => {
      up = true;
    }),
    hideMock: vi.fn(async () => {
      up = false;
    }),
    isVisibleMock: vi.fn(async () => up),
    startsUp: (v: boolean) => {
      up = v;
    },
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
  emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main", onCloseRequested: async () => () => {}, destroy: async () => {}, show: showMock, hide: hideMock, isVisible: isVisibleMock }),
}));

/** Loads `src/pill.ts` fresh — it registers its listener at import time — and
 *  hands back the handler the app would call on `pill://count`. Awaiting the
 *  returned promise waits for the window call, not just the handler. */
async function loadPill() {
  document.body.innerHTML = `<div id="pill"><span id="pill-text"></span></div>`;
  vi.resetModules();
  await import("../src/pill");
  const [event, handler] = listenMock.mock.calls[0] as [
    string,
    (e: { payload: { n: number } }) => Promise<void>,
  ];
  expect(event).toBe("pill://count");
  return (n: number) => handler({ payload: { n } });
}

describe("the pill window's visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startsUp(false);
  });

  // The bug this file exists for: `show()` on macOS is `makeKeyAndOrderFront:`,
  // so re-showing an already-visible pill took the keyboard away from whoever
  // was answering a question. The count arrives every five seconds regardless.
  it("does not show itself again while it is already up", async () => {
    const count = await loadPill();

    await count(1);
    await count(1);
    await count(2);

    expect(showMock).toHaveBeenCalledTimes(1);
  });

  it("still redraws the label when the count changes under it", async () => {
    const count = await loadPill();

    await count(1);
    await count(3);

    expect(document.getElementById("pill-text")!.textContent).toBe("3 waiting for input");
  });

  // A pill that is up without this window having shown it — the window-state
  // plugin used to restore it that way at launch. Nothing else in the app will
  // take it down, so the first `n = 0` has to, or it sits there blank forever.
  it("takes down a pill that was already up when the first count arrived", async () => {
    startsUp(true);
    const count = await loadPill();

    await count(0);

    expect(hideMock).toHaveBeenCalledTimes(1);
  });

  it("hides once, and only when it was up", async () => {
    const count = await loadPill();

    await count(0);
    await count(1);
    await count(0);
    await count(0);

    expect(hideMock).toHaveBeenCalledTimes(1);
  });

  it("comes back up after having been hidden", async () => {
    const count = await loadPill();

    await count(1);
    await count(0);
    await count(1);

    expect(showMock).toHaveBeenCalledTimes(2);
  });

  // The count is re-sent every five seconds precisely so a window call that
  // failed gets another go; a rejection that wedged the queue would spend that.
  it("tries again on the next count after a failed show", async () => {
    const count = await loadPill();
    showMock.mockRejectedValueOnce(new Error("window busy"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await count(1);
    await count(1);

    expect(showMock).toHaveBeenCalledTimes(2);
  });
});

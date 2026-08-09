// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { listenMock, showMock, hideMock } = vi.hoisted(() => ({
  listenMock: vi.fn(),
  showMock: vi.fn().mockResolvedValue(undefined),
  hideMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
  emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ show: showMock, hide: hideMock }),
}));

/** Loads `src/pill.ts` fresh — it registers its listener at import time — and
 *  hands back the handler the app would call on `pill://count`. */
async function loadPill() {
  document.body.innerHTML = `<div id="pill"><span id="pill-text"></span></div>`;
  vi.resetModules();
  await import("../src/pill");
  const [event, handler] = listenMock.mock.calls[0] as [string, (e: { payload: { n: number } }) => Promise<void>];
  expect(event).toBe("pill://count");
  return (n: number) => handler({ payload: { n } });
}

describe("the pill window's visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// jsdom has no ResizeObserver; TerminalPanel's constructor needs one.
(globalThis as any).ResizeObserver ??= class {
  observe() {} unobserve() {} disconnect() {}
};
// Nor an IntersectionObserver. Left absent on purpose in the panel — `watchVisibility`
// treats "no IntersectionObserver" as "never on screen", so no unit test ever tries to
// make a WebGL context — but stubbed here so the branch that *does* exist is the one
// under test elsewhere, and so this file pins that its absence is survivable.
(globalThis as any).IntersectionObserver ??= class {
  observe() {} unobserve() {} disconnect() {}
};

// Each spawn builds a real `Channel`, whose constructor registers its handler with
// Tauri's injected internals. Standing that one function up — rather than mocking
// `Channel` away — is what lets the tests below drive the real ordering logic. Every
// registration is kept, so a test can tell a second channel from the first.
type Deliver = (raw: { index: number; message: ArrayBuffer }) => void;
const registered: Deliver[] = [];
(globalThis as any).window.__TAURI_INTERNALS__ = {
  transformCallback: (cb: Deliver) => registered.push(cb),
  unregisterCallback: () => {},
};
const latest = () => registered[registered.length - 1];

const written: unknown[] = [];
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon() {} open() {} onData() {} onResize() {} focus() {} clear() {} dispose() {}
    attachCustomKeyEventHandler() {}
    // Records the argument as it arrives: the point of these tests is that the
    // panel hands xterm exactly what it was given, so a mock that normalised the
    // type would test nothing.
    write(data: unknown) { written.push(data); }
    cols = 80; rows = 24;
    options: Record<string, unknown> = {};
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { findNext() {} findPrevious() {} } }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
vi.mock("../src/ipc", () => ({
  startSession: vi.fn(), startCommandSession: vi.fn(), writeSession: vi.fn(), resizeSession: vi.fn(),
}));

import { TerminalPanel } from "../src/terminal";

beforeEach(() => { written.length = 0; registered.length = 0 });

describe("TerminalPanel.write", () => {
  /** Agent output has to reach xterm as bytes. Only xterm's own decoder holds a
   *  partial UTF-8 sequence across a pty read boundary — decode it any earlier and
   *  a split glyph becomes replacement characters, which is a line drifting by a
   *  column or two. Converting to a string anywhere on this path would put the bug
   *  back, so the type is asserted, not just the content. */
  it("passes bytes through to xterm untouched", () => {
    const panel = new TerminalPanel("s", document.createElement("div"));
    const bytes = new TextEncoder().encode("─│⏺");
    panel.write(bytes);
    expect(written).toHaveLength(1);
    // `toBeInstanceOf` cannot be used here: jsdom is a second realm, so the
    // `Uint8Array` this file sees is not the constructor the value was built with.
    // `ArrayBuffer.isView` answers the question that matters — a view, not text —
    // and answers it across realms.
    expect(ArrayBuffer.isView(written[0])).toBe(true);
    expect(written[0]).toEqual(bytes);
  });

  /** The regression this pins is a frame that stops lining up. The backend cuts the
   *  stream on a byte boundary that respects no character, so a multi-byte glyph can
   *  arrive in two pieces. Only xterm's own stateful decoder can hold the first half
   *  until the second turns up — decode either piece on its own and one 3-byte glyph
   *  becomes replacement characters on both sides, one cell becomes three, and the
   *  rest of that line sits two columns right of where it belongs.
   *
   *  Delivered out of order on purpose. The pieces reach the channel as raw
   *  `ArrayBuffer`s and, once a batch clears 1KB, Tauri sends it over the custom
   *  protocol via an async `fetch` — so a small message emitted later can land
   *  first. `Channel` re-sorts on the index it was sent with, and it is that
   *  guarantee, not the arrival order, that keeps the byte stream intact. */
  it("delivers channel bytes to xterm in order, so a split glyph survives", async () => {
    const panel = new TerminalPanel("s", document.createElement("div"));
    await panel.start("/proj", "w1", null);
    const deliver = latest();
    expect(deliver).toBeDefined();

    const glyph = new TextEncoder().encode("─");        // e2 94 80, one cell
    const buf = (b: Uint8Array) => b.slice().buffer;    // detached copy, as the IPC hands over

    // Second half first: nothing may be drawn until the first arrives.
    deliver({ index: 1, message: buf(glyph.subarray(1)) });
    expect(written).toHaveLength(0);

    deliver({ index: 0, message: buf(glyph.subarray(0, 1)) });

    expect(written).toHaveLength(2);
    // Bytes, not text — see the assertion above for why `isView` and not `instanceof`.
    expect(written.every((w) => ArrayBuffer.isView(w))).toBe(true);
    const joined = new Uint8Array([
      ...(written[0] as Uint8Array), ...(written[1] as Uint8Array),
    ]);
    // Compared as plain arrays: `joined` is built with this file's `Uint8Array`
    // and `glyph` with jsdom's, and `toEqual` weighs the constructor. The bytes
    // are the claim, not which realm's view holds them.
    expect(Array.from(joined)).toEqual(Array.from(glyph));
    expect(new TextDecoder().decode(joined)).toBe("─");
  });

  /** The restart button reuses the panel, and a channel cannot be reused.
   *
   *  Tauri's `Channel` sends `{ end: true }` when its Rust half is dropped — which
   *  is what happens as a session's reader threads finish — and the JS half answers
   *  by unregistering its own callback id. Hand the same object to the next spawn
   *  and everything still *looks* right: the object exists, it serialises to the
   *  same id, the invoke succeeds. The backend's writes just land on an id that is
   *  no longer in the registry, and the bytes are dropped with a console warning.
   *  The restarted session would print nothing at all, so what is pinned here is
   *  that the second spawn gets a channel of its own and that it reaches xterm. */
  it("opens a new channel for every spawn, so a restarted session still draws", async () => {
    const panel = new TerminalPanel("s", document.createElement("div"));
    await panel.start("/proj", "w1", null);
    const first = latest();

    await panel.start("/proj", "w1", null, null, true);
    const second = latest();
    expect(second).not.toBe(first);

    second({ index: 0, message: new TextEncoder().encode("ok").slice().buffer });
    expect(written).toHaveLength(1);
    expect(new TextDecoder().decode(written[0] as Uint8Array)).toBe("ok");
  });

  /** The app's own status lines — `[restarting session...]`, the launch failures —
   *  are written as strings by `sessions.ts` and must keep working. */
  it("still accepts a string, for the app's own messages", () => {
    const panel = new TerminalPanel("s", document.createElement("div"));
    panel.write("\r\n[restarting session...]\r\n");
    expect(written).toEqual(["\r\n[restarting session...]\r\n"]);
  });
});

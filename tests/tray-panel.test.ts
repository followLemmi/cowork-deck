// @vitest-environment jsdom
/** What the status-area surface shows.
 *
 *  Both renderings, from the one `PANEL` list: the rows the Linux menu is built
 *  from, and the panel window's own DOM. Tested here rather than through either
 *  surface, which is the point of ADR-0013's split — no test can open a native
 *  menu or a window positioned under a status icon, and every rule about what a
 *  row says is a function of a snapshot. The Rust half is tested where it lives
 *  (`src-tauri/src/tray.rs`) and knows none of this.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/ipc", async (orig) => ({
  ...(await orig<typeof import("../src/ipc")>()),
  usageClearObserved: vi.fn().mockResolvedValue(undefined),
}));

import type { AiUsage, LimitWindow } from "../src/ipc";
import type { RemoteSession } from "../src/cross-window";
import {
  ACTIONS, PANEL_SECTIONS, byUrgency, fillPanel, parseAction, stateWord, trayPanel,
  type TrayFacts,
} from "../src/tray-panel";

const win = (over: Partial<LimitWindow> = {}): LimitWindow => ({
  id: "session", label: "Current session", usedFraction: null, amount: null,
  resetsAt: null, state: "unknown", source: "unknown", note: null, ...over,
});

const snap = (over: Partial<AiUsage> = {}): AiUsage => ({
  provider: "claude", label: "Claude", account: null, plan: null, windows: [],
  source: "unknown", fetchedAt: 0, error: null, probeCommand: null,
  needsCredential: false, ...over,
});

const session = (over: Partial<RemoteSession> = {}): RemoteSession => ({
  session: "s1", name: "relay", state: "working", ...over,
});

const facts = (over: Partial<TrayFacts> = {}): TrayFacts => ({
  usage: [], sessions: [], now: Date.parse("2026-09-01T12:00:00Z"), ...over,
});

/** The panel's sections, by heading, so a test can name the one it is about
 *  without depending on the order they are declared in. */
const section = (f: TrayFacts, heading: string) =>
  trayPanel(f).sections.find((s) => s.heading === heading)!;

const texts = (f: TrayFacts, heading: string) => section(f, heading).rows.map((r) => r.text);

describe("the shape of the panel", () => {
  it("draws one section per entry in PANEL and nothing else", () => {
    expect(trayPanel(facts()).sections).toHaveLength(PANEL_SECTIONS.length);
  });

  /** The claim #393 asks for: a section is an entry in a list, and the thing
   *  that renders it does not know how many there are. If this ever needs
   *  changing to add a section, the shape has stopped being the shape. */
  it("puts every section's rows through one renderer", () => {
    for (const s of trayPanel(facts()).sections) {
      expect(s.heading).not.toBe("");
      expect(s.rows.length).toBeGreaterThan(0);
    }
  });

  /** A heading over a blank is worse than a sentence, and it is enforced in
   *  `trayPanel` rather than trusted to each section — so a section added later
   *  cannot forget it. */
  it("never leaves a heading standing over nothing", () => {
    const empty = trayPanel(facts({ usage: [], sessions: [] }));
    for (const s of empty.sections) expect(s.rows.length).toBeGreaterThan(0);
  });
});

describe("the limits section", () => {
  /** ADR-0009 as amended: the account's own figure stands alone, because an
   *  unqualified number is what a person already assumes it to be. */
  it("gives the account's own figure no qualifier", () => {
    const f = facts({ usage: [snap({
      windows: [win({ usedFraction: 0.23, state: "ok", source: "reported" })],
      source: "reported",
    })] });
    expect(texts(f, "Limits")[0]).toBe("Claude · 23% used");
  });

  /** And the direction that misleads is still stopped, in the same words the
   *  block uses — one `tierNote`, two surfaces. */
  it("says when a number is this app's own counting", () => {
    const f = facts({ usage: [snap({
      windows: [win({ amount: { used: 412_000, limit: null, unit: "tokens" }, source: "observed" })],
      source: "observed",
    })] });
    expect(texts(f, "Limits")[0]).toBe("Claude · 412k tokens · this app only");
  });

  /** The same sentence the block prints, because it is the same function —
   *  `limitFoot`. Two surfaces with their own opinion about this is the bug the
   *  pure helpers exist to prevent. */
  it("says what an exhausted window means and when it lifts", () => {
    const now = Date.parse("2026-09-01T12:00:00Z");
    const resetsAt = Date.parse("2026-09-01T19:00:00Z");
    const f = facts({ now, usage: [snap({
      windows: [win({ state: "exhausted", source: "observed", resetsAt })],
    })] });
    const clock = new Date(resetsAt)
      .toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    expect(texts(f, "Limits")[0])
      .toBe(`Claude · no reading · this app only · nothing moves until ${clock}`);
  });

  it("says plainly when a spent window's reset is not known", () => {
    const f = facts({ usage: [snap({ windows: [win({ state: "exhausted" })] })] });
    expect(texts(f, "Limits")[0]).toContain("nothing moves — no reset time known");
  });

  /** Nothing detected is a sentence, not an empty section: an app on a machine
   *  with no AI on it should say so rather than show a gap. */
  it("says so when there is no AI on the machine", () => {
    expect(texts(facts(), "Limits")).toEqual(["No AI detected on this machine."]);
  });

  it("still names a provider that reported no windows at all", () => {
    const f = facts({ usage: [snap({ windows: [], error: "claude is not on the PATH" })] });
    expect(texts(f, "Limits")[0]).toBe("Claude · claude is not on the PATH");
  });

  /** The registry key, never the label: the deck looks the snapshot up by
   *  `provider` when the row is clicked. */
  it("opens the usage dialog for the provider a row is about", () => {
    const f = facts({ usage: [snap({ provider: "gemini", label: "Gemini CLI" })] });
    expect(section(f, "Limits").rows[0].action).toBe(ACTIONS.usage("gemini"));
  });
});

describe("the sessions section", () => {
  it("names what is waiting, and makes it clickable", () => {
    const f = facts({ sessions: [
      session({ session: "a", name: "relay", state: "waitingInput" }),
      session({ session: "b", name: "deck", state: "working" }),
    ] });
    expect(section(f, "Sessions").rows[0]).toEqual({
      text: "relay · waiting for input",
      action: ACTIONS.session("a"),
    });
  });

  /** The rest are a number. A list that mixed nine contentedly running sessions
   *  in with the three that are stuck would bury the three. */
  it("counts what is not waiting rather than listing it", () => {
    const f = facts({ sessions: [
      session({ session: "a", name: "relay", state: "waitingInput" }),
      session({ session: "b", state: "working" }),
      session({ session: "c", state: "idle" }),
    ] });
    expect(texts(f, "Sessions")).toEqual(["relay · waiting for input", "2 other sessions"]);
  });

  it("counts one other session in the singular", () => {
    const f = facts({ sessions: [
      session({ session: "a", name: "relay", state: "waitingInput" }),
      session({ session: "b", state: "working" }),
    ] });
    expect(texts(f, "Sessions")).toContain("1 other session");
  });

  /** A menu is a list somebody reads standing up. What is left over is counted,
   *  never dropped — a menu that silently stopped at six would be lying about
   *  how many people are waiting on you. */
  it("stops naming sessions after six and says how many it did not name", () => {
    const waiting = Array.from({ length: 9 }, (_, i) =>
      session({ session: `s${i}`, name: `w${i}`, state: "waitingInput" }));
    const rows = texts(facts({ sessions: waiting }), "Sessions");
    expect(rows).toHaveLength(7);
    expect(rows[6]).toBe("3 more waiting for input");
  });

  it("says nothing is waiting when the deck is busy but unblocked", () => {
    const f = facts({ sessions: [session({ state: "working" })] });
    expect(texts(f, "Sessions")).toEqual(["Nothing is waiting for input.", "1 other session"]);
  });

  it("says so when there are no sessions at all", () => {
    expect(texts(facts(), "Sessions")).toEqual(["No sessions are open."]);
  });
});

describe("the badge count", () => {
  it("is the sessions waiting, across every window", () => {
    const f = facts({ sessions: [
      session({ session: "a", state: "waitingInput" }),
      session({ session: "b", state: "waitingInput" }),
      session({ session: "c", state: "working" }),
    ] });
    expect(trayPanel(f).waiting).toBe(2);
  });

  it("is zero when nothing is waiting", () => {
    expect(trayPanel(facts({ sessions: [session()] })).waiting).toBe(0);
  });
});

describe("the tooltip", () => {
  /** The one thing the pill cannot say, because the pill is not up: the deck is
   *  running and has nothing to report. */
  it("is the app's name when there is nothing to say", () => {
    expect(trayPanel(facts()).tooltip).toBe("cowork-deck");
  });

  it("names the AI that has run out", () => {
    const f = facts({ usage: [snap({ windows: [win({ state: "exhausted" })] })] });
    expect(trayPanel(f).tooltip).toBe("cowork-deck — Claude has nothing left");
  });

  /** Naming one of two would be misleading, which is the same judgement
   *  `deckLimit` makes about its `provider`. */
  it("names none of them when more than one has", () => {
    const f = facts({ usage: [
      snap({ provider: "claude", label: "Claude", windows: [win({ state: "exhausted" })] }),
      snap({ provider: "gemini", label: "Gemini CLI", windows: [win({ state: "exhausted" })] }),
    ] });
    expect(trayPanel(f).tooltip).toBe("cowork-deck — more than one AI has nothing left");
  });

  /** Exhaustion outranks a waiting count here for the same reason it does in
   *  `pillLabel`: nothing is waiting for input if nothing can move. */
  it("puts a spent budget before a queue of questions", () => {
    const f = facts({
      usage: [snap({ windows: [win({ state: "exhausted" })] })],
      sessions: [session({ state: "waitingInput" })],
    });
    expect(trayPanel(f).tooltip).toContain("nothing left");
  });

  it("counts what is waiting when the budget is fine", () => {
    const f = facts({ sessions: [
      session({ session: "a", state: "waitingInput" }),
      session({ session: "b", state: "waitingInput" }),
    ] });
    expect(trayPanel(f).tooltip).toBe("cowork-deck — 2 sessions are waiting");
  });

  it("says one session in the singular", () => {
    const f = facts({ sessions: [session({ state: "waitingInput" })] });
    expect(trayPanel(f).tooltip).toBe("cowork-deck — 1 session is waiting");
  });
});

describe("how sessions are ordered and named", () => {
  /** By what wants a person: blocked, then broken, then finished-and-parked.
   *  The same order `nextWaitingAcross` and the top bar's ledger use. */
  it("puts what wants a person first", () => {
    const order = byUrgency([
      session({ session: "e", state: "ended" }),
      session({ session: "i", state: "idle" }),
      session({ session: "w", state: "working" }),
      session({ session: "d", state: "done" }),
      session({ session: "x", state: "error" }),
      session({ session: "q", state: "waitingInput" }),
    ]).map((s) => s.session);
    expect(order).toEqual(["q", "x", "d", "w", "i", "e"]);
  });

  /** Two draws must agree, or the panel reshuffles under a cursor every tick. */
  it("keeps the reported order inside a rank", () => {
    const same = ["a", "b", "c"].map((id) => session({ session: id, state: "working" }));
    expect(byUrgency(same).map((s) => s.session)).toEqual(["a", "b", "c"]);
  });

  /** `done` is not folded into `idle`: an agent parked at the prompt having
   *  finished is not one that never started, and the deck already keeps them
   *  apart. */
  it("says finished a turn and idle differently", () => {
    expect(stateWord("done")).toBe("finished a turn");
    expect(stateWord("idle")).toBe("idle");
    expect(stateWord("error")).toBe("stopped on an error");
  });
});

describe("the action vocabulary", () => {
  /** Both ends of the string, in one file, because Rust reads neither: it
   *  carries the action out to the menu and back verbatim. */
  it("round-trips what it mints", () => {
    expect(parseAction(ACTIONS.usage("claude"))).toEqual({ verb: "usage", id: "claude" });
    expect(parseAction(ACTIONS.session("01JABC"))).toEqual({ verb: "session", id: "01JABC" });
  });

  /** A session id is a ULID today and a UUID in a workspace label; neither
   *  contains a colon, but the split is on the FIRST one so that an id which one
   *  day does survives it. */
  it("splits on the first colon so an id may contain one", () => {
    expect(parseAction("session:a:b")).toEqual({ verb: "session", id: "a:b" });
  });

  it("round-trips the probe verb the panel needs and the deck answers", () => {
    expect(parseAction(ACTIONS.probe("claude"))).toEqual({ verb: "probe", id: "claude" });
  });

  it("refuses anything it did not mint", () => {
    expect(parseAction("quit")).toBeNull();
    expect(parseAction("open:")).toBeNull();
    expect(parseAction(":claude")).toBeNull();
    expect(parseAction("")).toBeNull();
  });
});

/* --- The panel window ------------------------------------------------------
   The half a menu could not draw, and the reason the surface is a window. */

describe("the panel, drawn", () => {
  const draw = (f: TrayFacts) => {
    const root = document.createElement("div");
    const acts: string[] = [];
    fillPanel(root, f, (a) => acts.push(a));
    return { root, acts };
  };

  it("draws one section per entry in PANEL, each with its heading", () => {
    const { root } = draw(facts());
    expect(root.querySelectorAll(".tray-sec")).toHaveLength(PANEL_SECTIONS.length);
    for (const el of root.querySelectorAll(".tray-sec")) {
      expect(el.querySelector("h2")!.textContent).not.toBe("");
      expect(el.querySelector(".tray-body")!.childNodes.length).toBeGreaterThan(0);
    }
  });

  /** The whole reason this is a window and not a menu. */
  it("draws a meter for a limit that has a share", () => {
    const f = facts({ usage: [snap({
      windows: [win({ usedFraction: 0.23, state: "ok", source: "reported" })],
    })] });
    const fill = draw(f).root.querySelector<HTMLElement>(".lim-meter .lim-fill")!;
    expect(fill.style.width).toBe("23%");
  });

  /** ADR-0009 survives the change of surface: the qualifier is beside the
   *  number here exactly as it is in the deck's own block, because it is drawn
   *  by the deck's own block. */
  it("prints the qualifier beside the reading", () => {
    const f = facts({ usage: [snap({
      windows: [win({ usedFraction: 0.5, state: "ok", source: "observed" })],
    })] });
    const row = draw(f).root.querySelector(".lim-row")!;
    expect(row.querySelector(".lim-src")!.textContent).toBe("this app only");
    expect(row.querySelector(".lim-reading")!.textContent).toBe("50% used");
  });

  it("leaves the account's own figure unqualified", () => {
    const f = facts({ usage: [snap({
      windows: [win({ usedFraction: 0.5, state: "ok", source: "reported" })],
    })] });
    const row = draw(f).root.querySelector(".lim-row")!;
    expect(row.querySelector(".lim-src")).toBeNull();
    expect(row.querySelector(".lim-reading")!.textContent).toBe("50% used");
  });

  /** No share, no meter — the same rule, drawn by the same code. */
  it("draws no meter where there is no share to draw one from", () => {
    const f = facts({ usage: [snap({
      windows: [win({ amount: { used: 412_000, limit: null, unit: "tokens" }, source: "observed" })],
    })] });
    expect(draw(f).root.querySelector(".lim-meter")).toBeNull();
  });

  /** The block hides itself when nothing is detected, which is right in the
   *  deck's panel and wrong under a heading this surface has already drawn. */
  it("says so under its own heading when there is no AI on the machine", () => {
    const body = draw(facts()).root.querySelector('[data-section="limits"] .tray-body')!;
    expect(body.textContent).toContain("No AI detected on this machine.");
    expect((body as HTMLElement).hidden).toBe(false);
  });

  it("sends a limit row's click to the deck as the provider it is about", () => {
    const f = facts({ usage: [snap({ provider: "gemini", label: "Gemini CLI" })] });
    const { root, acts } = draw(f);
    root.querySelector<HTMLElement>(".lim-open")!.click();
    expect(acts).toEqual([ACTIONS.usage("gemini")]);
  });

  /** The tray has no tiles, so the "Ask" button asks the deck for one rather
   *  than throwing itself against a host that cannot open one. */
  it("sends an unreadable row's Ask to the deck instead of opening a tile", () => {
    const f = facts({ usage: [snap({ probeCommand: "claude /usage" })] });
    const { root, acts } = draw(f);
    root.querySelector<HTMLElement>(".lim-probe")!.click();
    expect(acts).toEqual([ACTIONS.probe("claude")]);
  });

  /** The window lists the deck, where the menu lists only what is blocked. That
   *  is the one place the two renderings differ, and it is a budget rather than
   *  a content difference — the panel scrolls and a menu does not. */
  it("draws a row per session, urgent first, each carrying its state", () => {
    const f = facts({ sessions: [
      session({ session: "b", name: "deck", state: "working" }),
      session({ session: "a", name: "relay", state: "waitingInput" }),
    ] });
    const rows = draw(f).root.querySelectorAll<HTMLElement>(".tray-sess");
    expect(rows).toHaveLength(2);
    expect(rows[0].dataset.state).toBe("waitingInput");
    expect(rows[0].querySelector(".tray-sess-name")!.textContent).toBe("relay");
    expect(rows[0].querySelector(".tray-sess-state")!.textContent).toBe("waiting for input");
    expect(rows[1].querySelector(".tray-sess-state")!.textContent).toBe("working");
  });

  /** Every row in this panel is replaced whenever the deck reports, which it
   *  does on every render of its own. `tray-window.ts` puts the keyboard back
   *  afterwards by matching `data-focus-key`, and that only works if a row
   *  carries one — a person tabbed onto the ninth row has to come back to the
   *  ninth row rather than to the top of the panel. The same attribute and the
   *  same convention `LimitsBlock` already uses, so one walk finds either. */
  it("gives every session row a key a repaint can find it by", () => {
    const f = facts({ sessions: [
      session({ session: "a", name: "relay", state: "waitingInput" }),
      session({ session: "b", name: "deck", state: "working" }),
    ] });
    const keys = [...draw(f).root.querySelectorAll<HTMLElement>(".tray-sess")]
      .map((r) => r.dataset.focusKey);
    expect(keys).toEqual(["sess:a", "sess:b"]);
  });

  /** And a limits row keeps the key the block gives it, because the walk that
   *  restores focus does not know which section it is crossing. */
  it("keeps the block's own focus keys on the limits rows", () => {
    const f = facts({ usage: [snap({ windows: [win({ usedFraction: 0.4, state: "ok" })] })] });
    const row = draw(f).root.querySelector<HTMLElement>(".lim-open");
    expect(row!.dataset.focusKey).toBe("row:claude");
  });

  it("sends a session row's click to the deck", () => {
    const f = facts({ sessions: [session({ session: "a", state: "waitingInput" })] });
    const { root, acts } = draw(f);
    root.querySelector<HTMLElement>(".tray-sess")!.click();
    expect(acts).toEqual([ACTIONS.session("a")]);
  });

  /** A session's name comes from a transcript this app did not write, so it
   *  goes in as text. The same rule as `usage-block.ts` and `github-screen.ts`. */
  it("puts a session's own name in as text", () => {
    const nasty = '<img src=x onerror="alert(1)">';
    const f = facts({ sessions: [session({ name: nasty, state: "waitingInput" })] });
    const { root } = draw(f);
    expect(root.querySelector(".tray-sess-name")!.textContent).toBe(nasty);
    expect(root.querySelector("img")).toBeNull();
  });

  it("stops at ten rows and says how many it did not name", () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      session({ session: `s${i}`, name: `w${i}`, state: "waitingInput" }));
    const body = draw(facts({ sessions: many })).root
      .querySelector('[data-section="sessions"] .tray-body')!;
    expect(body.querySelectorAll(".tray-sess")).toHaveLength(10);
    expect(body.textContent).toContain("4 more sessions");
  });

  it("says one left over in the singular", () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      session({ session: `s${i}`, name: `w${i}`, state: "working" }));
    const body = draw(facts({ sessions: many })).root
      .querySelector('[data-section="sessions"] .tray-body')!;
    expect(body.textContent).toContain("1 more session");
  });

  /** The sentence and the list, not one instead of the other: "nothing is
   *  waiting" is worth more when you can see the eleven that are working. */
  it("says nothing is waiting AND still lists the sessions that are not", () => {
    const f = facts({ sessions: [session({ name: "relay", state: "working" })] });
    const body = draw(f).root.querySelector('[data-section="sessions"] .tray-body')!;
    expect(body.textContent).toContain("Nothing is waiting for input.");
    expect(body.querySelectorAll(".tray-sess")).toHaveLength(1);
  });

  it("says so when there are no sessions at all", () => {
    const body = draw(facts()).root.querySelector('[data-section="sessions"] .tray-body')!;
    expect(body.textContent).toContain("No sessions are open.");
  });

  /** Drawn twice with different facts is the ordinary case — the deck reports
   *  every few seconds — and a renderer that appended would grow without bound. */
  it("replaces what it drew rather than adding to it", () => {
    const root = document.createElement("div");
    const f = facts({ sessions: [session({ state: "waitingInput" })] });
    fillPanel(root, f, () => {});
    fillPanel(root, f, () => {});
    expect(root.querySelectorAll(".tray-sec")).toHaveLength(PANEL_SECTIONS.length);
    expect(root.querySelectorAll(".tray-sess")).toHaveLength(1);
  });
});

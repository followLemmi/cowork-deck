/** What the status-area menu says.
 *
 *  Tested at the model rather than through a menu, which is the point of
 *  ADR-0011's split: no test can open a native menu, and every rule about what a
 *  row reads as is a pure function of a snapshot. The Rust half is tested where
 *  it lives (`src-tauri/src/tray.rs`) and knows none of this.
 */
import { describe, it, expect } from "vitest";
import type { AiUsage, LimitWindow } from "../src/ipc";
import type { RemoteSession } from "../src/cross-window";
import { ACTIONS, PANEL_SECTIONS, parseAction, trayPanel, type TrayFacts } from "../src/tray-panel";

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
  /** ADR-0009 in a menu. A bare percentage here would break the same rule the
   *  deck's rows were built to keep. */
  it("carries the tier beside every reading", () => {
    const f = facts({ usage: [snap({
      windows: [win({ usedFraction: 0.23, state: "ok", source: "reported" })],
      source: "reported",
    })] });
    expect(texts(f, "Limits")[0]).toBe("Claude · Reported · 23% used");
  });

  it("says which tier a weaker number is on, in the same place", () => {
    const f = facts({ usage: [snap({
      windows: [win({ amount: { used: 412_000, limit: null, unit: "tokens" }, source: "observed" })],
      source: "observed",
    })] });
    expect(texts(f, "Limits")[0]).toBe("Claude · Observed · 412k tokens");
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
    expect(texts(f, "Limits")[0]).toBe(`Claude · Observed · no reading · nothing moves until ${clock}`);
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

  it("refuses anything it did not mint", () => {
    expect(parseAction("quit")).toBeNull();
    expect(parseAction("open:")).toBeNull();
    expect(parseAction(":claude")).toBeNull();
    expect(parseAction("")).toBeNull();
  });
});

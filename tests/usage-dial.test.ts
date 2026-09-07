// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
// The real stylesheet, for the same reason `applyView` is tested against it: the
// rules that matter here are cascade decisions, and a test against invented CSS
// would pass while the app drew something else.
import css from "../src/styles.css?raw";
import type { AiUsage, LimitWindow } from "../src/ipc";

vi.mock("../src/ipc", async (orig) => ({
  ...(await orig<typeof import("../src/ipc")>()),
  usageClearObserved: vi.fn().mockResolvedValue(undefined),
}));

import { LimitDials } from "../src/usage-dial";
import { installSprite } from "../src/icons";

const win = (over: Partial<LimitWindow> = {}): LimitWindow => ({
  id: "session", label: "Current session", usedFraction: null, amount: null,
  resetsAt: null, state: "unknown", source: "unknown", note: null, ...over,
});

const week = (over: Partial<LimitWindow> = {}) =>
  win({ id: "week", label: "Current week", ...over });

const snap = (over: Partial<AiUsage> = {}): AiUsage => ({
  provider: "claude", label: "Claude", account: null, plan: null, windows: [],
  source: "unknown", fetchedAt: 0, error: null, probeCommand: null,
  needsCredential: false, ...over,
});

const NOW = new Date("2026-08-27T13:30:00").getTime();
const RESET = new Date("2026-08-27T19:00:00").getTime();

let opened: { title: string; command: string; cwd: string }[] = [];

function mount(detail: "popover" | "inline" = "popover"): { el: HTMLElement; dials: LimitDials } {
  document.head.replaceChildren();
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  document.body.replaceChildren();
  installSprite();
  const el = document.createElement("div");
  el.id = "limits";
  document.body.append(el);
  const dials = new LimitDials(el, {
    detail,
    openCommandTile: (title, command, cwd) => { opened.push({ title, command, cwd }); },
    cwd: () => "/home/dev/code/relay",
  });
  return { el, dials };
}

const dial = (el: HTMLElement, provider: string) =>
  el.querySelector<HTMLButtonElement>(`.dial[data-provider="${provider}"]`)!;
const card = (el: HTMLElement) => el.querySelector<HTMLElement>(".dial-card")!;
const hover = (b: HTMLElement) => b.dispatchEvent(new MouseEvent("mouseenter"));
const unhover = (b: HTMLElement) => b.dispatchEvent(new MouseEvent("mouseleave"));

beforeEach(() => { opened = []; });

describe("the row of dials: one mark per AI, in a fixed place", () => {
  /** The defect the shape exists to fix. The line it replaced named whichever AI
   *  was worst off, so the word a person had learned to look for moved with the
   *  readings — which is a reading you find by reading, not a glance. */
  it("draws the same three in the same order whatever the readings say", () => {
    const { el, dials } = mount();
    dials.render([], NOW);
    const order = () => [...el.querySelectorAll<HTMLElement>(".dial")].map((d) => d.dataset.provider);
    expect(order()).toEqual(["claude", "codex", "gemini"]);

    dials.render([snap({ windows: [week({ usedFraction: 0.99, state: "exhausted" })] })], NOW);
    expect(order()).toEqual(["claude", "codex", "gemini"]);
  });

  /** A provider the registry grew without this file learning its name (#308).
   *  It must not fall off the screen — the lineup is three brands plus whatever
   *  else answered. */
  it("gives a provider it has never heard of a dial of its own", () => {
    const { el, dials } = mount();
    dials.render([snap({ provider: "copilot", label: "Copilot", windows: [week({ usedFraction: 0.4, state: "ok" })] })], NOW);
    expect([...el.querySelectorAll<HTMLElement>(".dial")].map((d) => d.dataset.provider))
      .toEqual(["claude", "codex", "gemini", "copilot"]);
  });

  /** Two of the three are a claim about the roadmap and not about the machine,
   *  so a snapshot for one of them is deliberately dropped: Gemini has a
   *  provider in Rust that can answer nothing without a credential this app will
   *  not take, and a permanent row of unknowns dressed as a live reading is
   *  worse than saying plainly that it is not ready. */
  it("holds a brand at coming soon even when the backend reported one", () => {
    const { el, dials } = mount();
    dials.render([snap({ provider: "gemini", label: "Gemini", windows: [week({ usedFraction: 0.5, state: "ok" })] })], NOW);
    const g = dial(el, "gemini");
    expect(g.dataset.soon).toBe("true");
    expect(g.getAttribute("aria-disabled")).toBe("true");
    expect(g.querySelector(".dial-arc")).toBeNull();
    expect(g.getAttribute("aria-label")).toBe("Gemini — coming soon");
  });

  it("says a brand that should answer did not, rather than drawing nothing", () => {
    const { el, dials } = mount();
    dials.render([], NOW);
    expect(el.hidden).toBe(false);
    expect(dial(el, "claude").getAttribute("aria-label"))
      .toBe("Claude — not found on this machine");
  });
});

describe("the ring: the week, and only the week", () => {
  /** The five hours is the more urgent number and it is not what a ring is for:
   *  a ring is a period coming round again, and the period worth planning
   *  against is the week. The five hours is the first thing in the card. */
  it("fills from the weekly window, not from the session's", () => {
    const { el, dials } = mount();
    dials.render([snap({ windows: [
      win({ usedFraction: 0.9, state: "near" }),
      week({ usedFraction: 0.25, state: "ok" }),
    ] })], NOW);
    const arc = dial(el, "claude").querySelector(".dial-arc")!;
    const circumference = 2 * Math.PI * 13.5;
    const [lit] = arc.getAttribute("stroke-dasharray")!.split(" ").map(Number);
    expect(lit).toBeCloseTo(circumference * 0.25, 1);
  });

  /** No share, no arc — the same rule the meter has always kept. An arc drawn at
   *  some arbitrary sweep would be this app inventing a denominator it has just
   *  said it does not have. */
  it("draws a bare track where there is no share to draw an arc from", () => {
    const { el, dials } = mount();
    dials.render([snap({ windows: [
      week({ amount: { used: 412_000, limit: null, unit: "tokens" }, source: "observed" }),
    ] })], NOW);
    expect(dial(el, "claude").querySelector(".dial-track")).not.toBeNull();
    expect(dial(el, "claude").querySelector(".dial-arc")).toBeNull();
  });

  it("takes its hue from the weekly window's own state", () => {
    const { el, dials } = mount();
    dials.render([snap({ windows: [week({ usedFraction: 0.92, state: "near" })] })], NOW);
    expect(dial(el, "claude").querySelector(".dial-ring")!.classList).toContain("lim-near");
    dials.render([snap({ windows: [week({ usedFraction: 1, state: "exhausted" })] })], NOW);
    expect(dial(el, "claude").querySelector(".dial-ring")!.classList).toContain("lim-out");
  });
});

describe("the dot: what the ring is not saying", () => {
  /** A dial showing a comfortable 12% while the deck is about to be refused
   *  would be answering the question nobody asked. */
  it("marks a session window in trouble behind a healthy week", () => {
    const { el, dials } = mount();
    dials.render([snap({ windows: [
      win({ usedFraction: 1, state: "exhausted", resetsAt: RESET }),
      week({ usedFraction: 0.12, state: "ok" }),
    ] })], NOW);
    expect(dial(el, "claude").dataset.alert).toBe("exhausted");
    expect(dial(el, "claude").querySelector(".dial-dot")).not.toBeNull();
    expect(dial(el, "claude").getAttribute("aria-label")).toContain("another window is spent");
  });

  it("marks nothing when the ring is already the worst of them", () => {
    const { el, dials } = mount();
    dials.render([snap({ windows: [
      win({ usedFraction: 0.1, state: "ok" }),
      week({ usedFraction: 0.95, state: "near" }),
    ] })], NOW);
    expect(dial(el, "claude").dataset.alert).toBeUndefined();
    expect(dial(el, "claude").querySelector(".dial-dot")).toBeNull();
  });
});

describe("the card: everything the dial had no room for", () => {
  it("opens under the pointer and closes when it leaves", () => {
    const { el, dials } = mount();
    dials.render([snap({ windows: [week({ usedFraction: 0.25, state: "ok" })] })], NOW);
    expect(card(el).hidden).toBe(true);

    hover(dial(el, "claude"));
    expect(card(el).hidden).toBe(false);
    expect(card(el).textContent).toContain("Claude");

    unhover(dial(el, "claude"));
    expect(card(el).hidden).toBe(true);
  });

  /** Both windows, and the one the ring drew FIRST — the card has to explain the
   *  drawing a person is looking at before it explains anything else. */
  it("leads with the window the ring drew and follows with the rest", () => {
    const { el, dials } = mount();
    dials.render([snap({
      account: "person@example.com",
      plan: "max",
      windows: [
        win({ usedFraction: 0.4, state: "ok", resetsAt: RESET, source: "reported" }),
        week({ usedFraction: 0.25, state: "ok", source: "reported" }),
      ],
    })], NOW);
    hover(dial(el, "claude"));
    const names = [...card(el).querySelectorAll(".dial-win .lim-name")].map((n) => n.textContent);
    expect(names).toEqual(["Current week", "Current session"]);
    // The two facts that explain an unexpected ceiling, and neither is guessable
    // from the numbers — which is why they are on the glance now.
    expect(card(el).querySelector(".lim-who")!.textContent).toBe("person@example.com · max");
    expect(card(el).textContent).toContain("resets 07:00 PM");
  });

  /** ADR-0009, on a surface with the room to keep it in full: the tier by name
   *  beside every reading, the strongest one included. */
  it("names the tier beside every reading", () => {
    const { el, dials } = mount();
    dials.render([snap({ windows: [
      week({ usedFraction: 0.25, state: "ok", source: "reported" }),
      win({ usedFraction: 0.4, state: "ok", source: "observed" }),
    ] })], NOW);
    hover(dial(el, "claude"));
    expect([...card(el).querySelectorAll(".dial-win .lim-src")].map((s) => s.textContent))
      .toEqual(["Reported", "Observed"]);
  });

  it("says what a held brand is and does not pretend to read it", () => {
    const { el, dials } = mount();
    dials.render([snap()], NOW);
    hover(dial(el, "codex"));
    expect(card(el).textContent).toContain("Coming soon");
    expect(card(el).querySelector(".dial-win")).toBeNull();
  });

  /** Folded is `display: none` rather than a shorter card — the bar must not
   *  grow, and the deck below it must not move. */
  it("costs the bar no height while it is shut", () => {
    const { el, dials } = mount();
    dials.render([snap({ windows: [week({ usedFraction: 0.25, state: "ok" })] })], NOW);
    expect(getComputedStyle(card(el)).display).toBe("none");
    expect(getComputedStyle(card(el)).position).toBe("absolute");
  });

  /** The description belongs to the dial it is describing and to no other, or a
   *  reader tabbing the row is read the same paragraph three times. */
  it("points exactly one dial at the card", () => {
    const { el, dials } = mount();
    dials.render([snap({ windows: [week({ usedFraction: 0.25, state: "ok" })] })], NOW);
    hover(dial(el, "claude"));
    const described = [...el.querySelectorAll(".dial")].filter((d) => d.hasAttribute("aria-describedby"));
    expect(described).toEqual([dial(el, "claude")]);
    expect(described[0].getAttribute("aria-describedby")).toBe(card(el).id);
  });
});

describe("what a press does", () => {
  it("opens the dialog for a live AI", () => {
    const { el, dials } = mount();
    dials.render([snap({ windows: [week({ usedFraction: 0.25, state: "ok" })] })], NOW);
    dial(el, "claude").click();
    expect(document.querySelector(".lim-screen")).not.toBeNull();
  });

  it("does nothing for a held one, because there is nothing behind it", () => {
    const { el, dials } = mount();
    dials.render([snap({ windows: [week({ usedFraction: 0.25, state: "ok" })] })], NOW);
    dial(el, "codex").click();
    expect(document.querySelector(".lim-screen")).toBeNull();
  });

  it("hands a press to the host where the surface has one", () => {
    const seen: string[] = [];
    document.body.replaceChildren();
    installSprite();
    const el = document.createElement("div");
    document.body.append(el);
    const dials = new LimitDials(el, {
      openDetail: (s) => seen.push(s.provider),
      openCommandTile: () => { throw new Error("not here"); },
      cwd: () => { throw new Error("not here"); },
    });
    dials.render([snap({ windows: [week({ usedFraction: 0.25, state: "ok" })] })], NOW);
    dial(el, "claude").click();
    expect(seen).toEqual(["claude"]);
  });
});

describe("the accessible name, which carries what the drawing does", () => {
  it("says the AI, the window, its tier, its reading and when it lifts", () => {
    const { el, dials } = mount();
    dials.render([snap({ windows: [
      week({ usedFraction: 0.62, state: "ok", resetsAt: RESET, source: "observed" }),
    ] })], NOW);
    expect(dial(el, "claude").getAttribute("aria-label"))
      .toBe("Claude, Current week: 62% used, this app only, resets 07:00 PM, — open the detail");
  });

  it("says so when a provider declared no window at all", () => {
    const { el, dials } = mount();
    dials.render([snap({ error: "token expired" })], NOW);
    expect(dial(el, "claude").getAttribute("aria-label"))
      .toBe("Claude, no windows, token expired, — open the detail");
  });
});

describe("what a repaint must not take", () => {
  /** This runs on a sixty-second timer and every element is replaced each time.
   *  Without this the keyboard is thrown back to the top of the document by a
   *  clock, mid-sentence. */
  it("puts the keyboard back on the dial it was on", () => {
    const { el, dials } = mount();
    const snaps = [snap({ windows: [week({ usedFraction: 0.25, state: "ok" })] })];
    dials.render(snaps, NOW);
    dial(el, "gemini").focus();
    dials.render(snaps, NOW + 60_000);
    expect(document.activeElement).toBe(dial(el, "gemini"));
  });
});

describe("the same row in the status-area panel, where nothing may float", () => {
  /** `#tray` clips what leaves it, so a popover there would be a card with its
   *  bottom sheared off. In the flow instead, and always showing something: a
   *  window opened deliberately can afford to have the answer already on it. */
  it("keeps the card in the flow and open from the first paint", () => {
    const { el, dials } = mount("inline");
    dials.render([snap({ windows: [week({ usedFraction: 0.25, state: "ok" })] })], NOW);
    expect(card(el).hidden).toBe(false);
    expect(card(el).classList).toContain("dial-card--inline");
    expect(getComputedStyle(card(el)).position).toBe("static");
    expect(card(el).dataset.provider).toBe("claude");
  });

  it("does not blank itself when the pointer leaves, which would leave a hole", () => {
    const { el, dials } = mount("inline");
    dials.render([snap({ windows: [week({ usedFraction: 0.25, state: "ok" })] })], NOW);
    hover(dial(el, "codex"));
    expect(card(el).dataset.provider).toBe("codex");
    unhover(dial(el, "codex"));
    expect(card(el).dataset.provider).toBe("codex");
    expect(card(el).hidden).toBe(false);
  });

  /** It opens on what wants a person, which is deliberately NOT the order the
   *  dials are drawn in: the row is fixed so it can be read by position, and the
   *  card is a reading, so it leads with the worst of them. */
  it("opens on the AI that is worst off rather than on the first one drawn", () => {
    const { el, dials } = mount("inline");
    dials.render([
      snap({ provider: "claude", windows: [week({ usedFraction: 0.1, state: "ok" })] }),
      snap({ provider: "copilot", label: "Copilot", windows: [week({ usedFraction: 1, state: "exhausted" })] }),
    ], NOW);
    expect(card(el).dataset.provider).toBe("copilot");
  });

  /** Nothing points at it: in the panel the card is a pane of the window rather
   *  than a description of any one dial, and every dial's own name carries its
   *  reading. */
  it("describes no dial, because it is not a popover", () => {
    const { el, dials } = mount("inline");
    dials.render([snap({ windows: [week({ usedFraction: 0.25, state: "ok" })] })], NOW);
    hover(dial(el, "claude"));
    expect(el.querySelector(".dial[aria-describedby]")).toBeNull();
  });
});

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

/** The deck's surface: one word in the bar with the dials behind it. */
function mount(): { el: HTMLElement; dials: LimitDials } {
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
    openCommandTile: (title, command, cwd) => { opened.push({ title, command, cwd }); },
    cwd: () => "/home/dev/code/relay",
  });
  return { el, dials };
}

/** The status-area panel's surface: the dials on show, and a card that floats
 *  over what is under them rather than pushing it down. */
function mountFloat(): { el: HTMLElement; mount: HTMLElement; dials: LimitDials } {
  document.head.replaceChildren();
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  document.body.replaceChildren();
  installSprite();
  const shell = document.createElement("div");
  shell.id = "tray";
  const el = document.createElement("div");
  shell.append(el);
  document.body.append(shell);
  const dials = new LimitDials(el, {
    detail: "float",
    cardMount: () => shell,
    openDetail: () => {},
    openCommandTile: () => { throw new Error("not here"); },
    cwd: () => { throw new Error("not here"); },
  });
  return { el, mount: shell, dials };
}

const trigger = (el: HTMLElement) => el.querySelector<HTMLButtonElement>(".dial-trigger")!;
const pop = (el: HTMLElement) => el.querySelector<HTMLElement>(".dial-pop")!;
const dial = (root: ParentNode, provider: string) =>
  root.querySelector<HTMLButtonElement>(`.dial[data-provider="${provider}"]`)!;
const card = (root: ParentNode) => root.querySelector<HTMLElement>(".dial-card")!;
const caption = (root: ParentNode, provider: string) =>
  dial(root, provider).querySelector<HTMLElement>(".dial-caption")!.textContent;
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

  /** The logos come in whole, on their owners' own 24-unit grid, rather than
   *  redrawn to match this app's stroke set: a mark's job is to be recognised,
   *  not to belong. `.icon` would render a filled path as nothing at all, which
   *  is why they are a separate symbol set and a separate class. */
  it("draws each AI's own logo, and a house icon for one it has none for", () => {
    const { el, dials } = mount();
    dials.render([snap({ provider: "copilot", label: "Copilot" })], NOW);
    for (const p of ["claude", "codex", "gemini"]) {
      const use = dial(el, p).querySelector(".brand use")!;
      expect(use.getAttribute("href")).toBe(`#b-${p}`);
    }
    expect(dial(el, "copilot").querySelector(".brand")).toBeNull();
    expect(dial(el, "copilot").querySelector(".icon use")!.getAttribute("href")).toBe("#i-sparkle");
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
    expect(caption(el, "claude")).toBe("25%");
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

/** The caption is not decoration, and this is the defect it was added for: a
 *  fresh week reads 0%, which draws an arc of zero length — indistinguishable
 *  from a ring that is not working. */
describe("the caption: the figure the ring cannot say", () => {
  it("prints the percentage, a fresh week included", () => {
    const { el, dials } = mount();
    dials.render([snap({ windows: [week({ usedFraction: 0, state: "ok" })] })], NOW);
    expect(caption(el, "claude")).toBe("0%");
    dials.render([snap({ windows: [week({ usedFraction: 0.624, state: "ok" })] })], NOW);
    expect(caption(el, "claude")).toBe("62%");
  });

  /** A dash where there is no share, for the same reason there is no arc: an
   *  absolute with no ceiling is not a percentage of anything. */
  it("prints a dash rather than a number it would have to invent", () => {
    const { el, dials } = mount();
    dials.render([snap({ windows: [
      week({ amount: { used: 412_000, limit: null, unit: "tokens" }, source: "observed" }),
    ] })], NOW);
    expect(caption(el, "claude")).toBe("—");
  });

  it("says what a held brand is instead of a reading it does not have", () => {
    const { el, dials } = mount();
    dials.render([snap()], NOW);
    expect(caption(el, "codex")).toBe("soon");
    expect(caption(el, "claude")).toBe("—");
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

describe("the one word in the top bar", () => {
  /** The dials are not in the bar (#498): it is a row of the deck's own state,
   *  and three logos parked in it read as three more controls. */
  it("is all the bar shows until somebody asks", () => {
    const { el, dials } = mount();
    dials.render([snap({ windows: [week({ usedFraction: 0.25, state: "ok" })] })], NOW);
    expect(trigger(el).textContent).toContain("Limits");
    expect(pop(el).hidden).toBe(true);
    expect(getComputedStyle(pop(el)).display).toBe("none");
    expect(getComputedStyle(pop(el)).position).toBe("absolute");
  });

  /** What does NOT go behind the press. Hiding the dials is only acceptable if
   *  the press is not needed to find out that something is wrong. */
  it("carries the alarm itself, so nothing has to be opened to see it", () => {
    const { el, dials } = mount();
    dials.render([snap({ windows: [week({ usedFraction: 0.2, state: "ok" })] })], NOW);
    expect(trigger(el).dataset.alarm).toBeUndefined();
    expect(trigger(el).querySelector(".dial-dot")).toBeNull();

    // A five-hour window in trouble reaches the word even though the ring the
    // dial draws is the week's and is fine.
    dials.render([snap({ windows: [
      win({ usedFraction: 0.98, state: "near" }),
      week({ usedFraction: 0.2, state: "ok" }),
    ] })], NOW);
    expect(trigger(el).dataset.alarm).toBe("near");
    expect(trigger(el).getAttribute("aria-label")).toContain("something is nearly spent");

    dials.render([snap({ windows: [week({ usedFraction: 1, state: "exhausted" })] })], NOW);
    expect(trigger(el).dataset.alarm).toBe("exhausted");
  });

  it("opens on a point and shuts when the pointer leaves the block", () => {
    const { el, dials } = mount();
    dials.render([snap({ windows: [week({ usedFraction: 0.25, state: "ok" })] })], NOW);
    hover(trigger(el));
    expect(pop(el).hidden).toBe(false);
    expect(trigger(el).getAttribute("aria-expanded")).toBe("true");
    // The popover is a DESCENDANT of the block, so the pointer travelling from
    // the word into the dials does not leave it. Only leaving the block does.
    unhover(el);
    expect(pop(el).hidden).toBe(true);
    expect(trigger(el).getAttribute("aria-expanded")).toBe("false");
  });

  /** A keyboard has no pointer to hold in place, which is the case the pin
   *  exists for: a press keeps the box open through both. */
  it("stays open on a press until it is pressed again", () => {
    const { el, dials } = mount();
    dials.render([snap({ windows: [week({ usedFraction: 0.25, state: "ok" })] })], NOW);
    trigger(el).click();
    expect(pop(el).hidden).toBe(false);
    unhover(el);
    expect(pop(el).hidden).toBe(false);
    trigger(el).click();
    expect(pop(el).hidden).toBe(true);
  });

  it("shuts on Escape and hands the keyboard back to the word", () => {
    const { el, dials } = mount();
    dials.render([snap({ windows: [week({ usedFraction: 0.25, state: "ok" })] })], NOW);
    trigger(el).click();
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(pop(el).hidden).toBe(true);
    expect(document.activeElement).toBe(trigger(el));
  });

  /** `el` outlives the paint, so the three listeners that close the popover are
   *  installed once in the constructor. Attaching them per paint would add one a
   *  minute for as long as the window is open — and the symptom would be this:
   *  a shut that fires again for every paint that ever happened. */
  it("does not accumulate a closing listener on every repaint", () => {
    const { el, dials } = mount();
    const snaps = [snap({ windows: [week({ usedFraction: 0.25, state: "ok" })] })];
    const spy = vi.spyOn(el, "addEventListener");
    for (let i = 0; i < 5; i++) dials.render(snaps, NOW + i * 60_000);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    // And it still closes after all those paints.
    hover(trigger(el));
    unhover(el);
    expect(pop(el).hidden).toBe(true);
  });
});

describe("the card: everything the dial had no room for", () => {
  /** It opens on what wants a person, which is deliberately NOT the order the
   *  dials are drawn in: the row is fixed so it can be read by position, and the
   *  card is a reading, so it leads with the worst of them. */
  it("opens on the AI that is worst off, and follows the pointer after that", () => {
    const { el, dials } = mount();
    dials.render([
      snap({ provider: "claude", windows: [week({ usedFraction: 0.1, state: "ok" })] }),
      snap({ provider: "copilot", label: "Copilot", windows: [week({ usedFraction: 1, state: "exhausted" })] }),
    ], NOW);
    hover(trigger(el));
    expect(card(el).dataset.provider).toBe("copilot");
    hover(dial(el, "claude"));
    expect(card(el).dataset.provider).toBe("claude");
  });

  /** Inside the popover something is always described: the box is already
   *  floating, and blanking its second half would collapse it under the pointer. */
  it("keeps saying something when the pointer leaves a dial", () => {
    const { el, dials } = mount();
    dials.render([snap({ windows: [week({ usedFraction: 0.25, state: "ok" })] })], NOW);
    hover(trigger(el));
    hover(dial(el, "codex"));
    unhover(dial(el, "codex"));
    expect(card(el).dataset.provider).toBe("codex");
    expect(card(el).hidden).toBe(false);
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
    hover(trigger(el));
    const names = [...card(el).querySelectorAll(".dial-win .lim-name")].map((n) => n.textContent);
    expect(names).toEqual(["Current week", "Current session"]);
    // The two facts that explain an unexpected ceiling, and neither is guessable
    // from the numbers — which is why they are on the glance now.
    expect(card(el).querySelector(".lim-who")!.textContent).toBe("person@example.com · max");
    expect(card(el).textContent).toContain("resets 07:00 PM");
  });

  /** ADR-0009 as AMENDED, which is the whole of the rule: the caveat is printed
   *  where a number could mislead, and the account's own accounting is printed
   *  plain. An unqualified number is the account's, which is what a person
   *  assumes anyway; the failure that record exists to prevent is this app's own
   *  narrower count being read as the account's, and only the weaker tiers can
   *  commit it. The tier NAMES live in the dialog, beside the sentences that
   *  define them. */
  it("qualifies a number that could mislead and leaves the account's plain", () => {
    const { el, dials } = mount();
    dials.render([snap({ windows: [
      week({ usedFraction: 0.25, state: "ok", source: "reported" }),
      win({ usedFraction: 0.4, state: "ok", source: "observed" }),
    ] })], NOW);
    hover(trigger(el));
    const boxes = [...card(el).querySelectorAll(".dial-win")];
    expect(boxes[0].querySelector(".lim-src")).toBeNull();
    expect(boxes[1].querySelector(".lim-src")!.textContent).toBe("this app only");
    expect(card(el).textContent).not.toContain("REPORTED");
    expect(card(el).textContent).not.toContain("Reported");
  });

  it("says what a held brand is and does not pretend to read it", () => {
    const { el, dials } = mount();
    dials.render([snap()], NOW);
    hover(trigger(el));
    hover(dial(el, "codex"));
    expect(card(el).textContent).toContain("Coming soon");
    expect(card(el).querySelector(".dial-win")).toBeNull();
  });
});

describe("what a press does", () => {
  it("opens the dialog for a live AI", () => {
    const { el, dials } = mount();
    dials.render([snap({ windows: [week({ usedFraction: 0.25, state: "ok" })] })], NOW);
    hover(trigger(el));
    dial(el, "claude").click();
    expect(document.querySelector(".lim-screen")).not.toBeNull();
  });

  it("does nothing for a held one, because there is nothing behind it", () => {
    const { el, dials } = mount();
    dials.render([snap({ windows: [week({ usedFraction: 0.25, state: "ok" })] })], NOW);
    hover(trigger(el));
    dial(el, "codex").click();
    expect(document.querySelector(".lim-screen")).toBeNull();
  });

  /** The status-area panel has no dialog to open, so it asks the deck for one.
   *  The hook is the only thing that differs; the dial is the same dial. */
  it("hands a press to the host where the surface has one", () => {
    document.body.replaceChildren();
    installSprite();
    const el = document.createElement("div");
    document.body.append(el);
    const seen: string[] = [];
    const dials = new LimitDials(el, {
      detail: "float",
      openDetail: (s) => seen.push(s.provider),
      openCommandTile: () => { throw new Error("the panel has no tiles"); },
      cwd: () => { throw new Error("the panel has no workspace"); },
    });
    dials.render([snap({ windows: [week({ usedFraction: 0.25, state: "ok" })] })], NOW);
    dial(el, "claude").click();
    expect(seen).toEqual(["claude"]);
  });
});

describe("the accessible name, which carries what the drawing does", () => {
  it("says the AI, the window, its reading and when it lifts", () => {
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

describe("the same row in the status-area panel, where nothing may push", () => {
  /** That window IS the glance, so its dials are on show rather than behind a
   *  word. What it must not do is GROW: a card in the flow pushed the sessions
   *  below it down every time a pointer crossed a logo. */
  it("shows its dials with no word in front of them", () => {
    const { el, dials } = mountFloat();
    dials.render([snap({ windows: [week({ usedFraction: 0.25, state: "ok" })] })], NOW);
    expect(el.querySelector(".dial-trigger")).toBeNull();
    expect(el.querySelectorAll(".dial").length).toBe(3);
  });

  /** Hung on the panel's own box rather than inside its scrolling list: an
   *  absolutely positioned card in a scroll container is clipped by it AND adds
   *  to its scroll height, so the content moves anyway. */
  it("floats the card outside the block, over whatever is under it", () => {
    const { el, mount: shell, dials } = mountFloat();
    dials.render([snap({ windows: [week({ usedFraction: 0.25, state: "ok" })] })], NOW);
    const c = card(shell);
    expect(c.parentElement).toBe(shell);
    expect(el.contains(c)).toBe(false);
    expect(c.classList).toContain("dial-card--float");
    expect(getComputedStyle(c).position).toBe("absolute");
  });

  it("says nothing until a pointer asks, and goes when it leaves", () => {
    const { el, mount: shell, dials } = mountFloat();
    dials.render([snap({ windows: [week({ usedFraction: 0.25, state: "ok" })] })], NOW);
    expect(card(shell).hidden).toBe(true);
    hover(dial(el, "claude"));
    expect(card(shell).hidden).toBe(false);
    expect(card(shell).dataset.provider).toBe("claude");
    unhover(dial(el, "claude"));
    expect(card(shell).hidden).toBe(true);
  });

  /** A floating card is a description OF the dial the pointer is on, and of no
   *  other — three dials pointing at one card would have a reader announce the
   *  same paragraph three times. */
  it("points exactly one dial at the card", () => {
    const { el, mount: shell, dials } = mountFloat();
    dials.render([snap({ windows: [week({ usedFraction: 0.25, state: "ok" })] })], NOW);
    hover(dial(el, "claude"));
    const described = [...el.querySelectorAll(".dial")].filter((d) => d.hasAttribute("aria-describedby"));
    expect(described).toEqual([dial(el, "claude")]);
    expect(described[0].getAttribute("aria-describedby")).toBe(card(shell).id);
  });

  /** The card is the one thing in that window which cannot remember itself: the
   *  panel replaces its whole document on every report from the deck. So the
   *  provider it was describing is carried in and honoured, or the card vanishes
   *  from under the pointer every five seconds. */
  it("re-opens the card on the dial the panel was showing before the repaint", () => {
    const { mount: shell, dials } = mountFloat();
    dials.selected = "gemini";
    dials.render([snap({ windows: [week({ usedFraction: 0.25, state: "ok" })] })], NOW);
    expect(card(shell).dataset.provider).toBe("gemini");
    expect(card(shell).textContent).toContain("Coming soon");
  });

  /** And the card it left behind goes with it. Its parent is not this block's
   *  element, so nothing else would empty it — two paints would leave two cards
   *  stacked on the panel. */
  it("takes its old card away when it paints again", () => {
    const { mount: shell, dials } = mountFloat();
    const snaps = [snap({ windows: [week({ usedFraction: 0.25, state: "ok" })] })];
    dials.render(snaps, NOW);
    dials.render(snaps, NOW + 60_000);
    expect(shell.querySelectorAll(".dial-card").length).toBe(1);
  });
});

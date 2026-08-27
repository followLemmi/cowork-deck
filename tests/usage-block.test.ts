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

import { LimitsBlock } from "../src/usage-block";

const win = (over: Partial<LimitWindow> = {}): LimitWindow => ({
  id: "session", label: "Current session", usedFraction: null, amount: null,
  resetsAt: null, state: "unknown", source: "unknown", note: null, ...over,
});

const snap = (over: Partial<AiUsage> = {}): AiUsage => ({
  provider: "claude", label: "Claude", account: null, plan: null, windows: [],
  source: "unknown", fetchedAt: 0, error: null, probeCommand: null,
  needsCredential: false, ...over,
});

const NOW = new Date("2026-08-27T13:30:00").getTime();
const RESET = new Date("2026-08-27T19:00:00").getTime();

let opened: { title: string; command: string; cwd: string }[] = [];

function mount(): { el: HTMLElement; block: LimitsBlock } {
  document.head.replaceChildren();
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  document.body.replaceChildren();
  const el = document.createElement("div");
  el.id = "limits";
  document.body.append(el);
  const block = new LimitsBlock(el, {
    openCommandTile: (title, command, cwd) => { opened.push({ title, command, cwd }); },
    cwd: () => "/home/dev/code/relay",
  });
  return { el, block };
}

beforeEach(() => { opened = []; });

describe("the limits block", () => {
  it("draws nothing at all when no AI is detected", () => {
    const { el, block } = mount();
    block.render([], NOW);
    expect(el.hidden).toBe(true);
    expect(el.querySelector(".lim-block")).toBe(null);
  });

  it("draws one row per detected AI, under one heading", () => {
    const { el, block } = mount();
    block.render([
      snap({ windows: [win({ usedFraction: 0.2, state: "ok", source: "reported" })] }),
      snap({ provider: "gemini", label: "Gemini", windows: [win({ id: "rpd", label: "Requests today" })] }),
    ], NOW);
    expect(el.querySelectorAll("h3").length).toBe(1);
    expect(el.querySelectorAll(".lim-row").length).toBe(2);
    expect([...el.querySelectorAll(".lim-name")].map((n) => n.textContent))
      .toEqual(["Claude", "Gemini"]);
  });

  /** The three states, and the absence of a fourth. */
  it("paints three distinct classes, and none of them is the working green", () => {
    const { el, block } = mount();
    block.render([
      snap({ provider: "a", windows: [win({ usedFraction: 0.2, state: "ok" })] }),
      snap({ provider: "b", windows: [win({ usedFraction: 0.9, state: "near" })] }),
      snap({ provider: "c", windows: [win({ state: "exhausted", resetsAt: RESET })] }),
    ], NOW);
    const meters = [...el.querySelectorAll(".lim-meter")];
    expect(meters.length).toBe(3);
    const classes = meters.map((m) => [...m.classList].find((c) => c.startsWith("lim-") && c !== "lim-meter"));
    expect(new Set(classes).size).toBe(3);
    // The healthy fill takes the neutral ink, and the two that mean something
    // take the two hues the rest of the app already uses for those meanings.
    const fill = (i: number) => getComputedStyle(meters[i].querySelector(".lim-fill")!).background;
    expect(fill(0)).toContain("--fg-dim");
    expect(fill(1)).toContain("--st-waiting");
    expect(fill(2)).toContain("--st-error");
    // And no rule anywhere in this block reaches for the working green.
    const block4 = css.slice(css.indexOf("--- Limits:"));
    expect(block4).not.toContain("--st-working");
  });

  /** An unknown row is the one a person can do something about, so it gets the
   *  action rather than a meter drawn at an arbitrary width. */
  it("gives an unknown row the action and no meter", () => {
    const { el, block } = mount();
    block.render([snap({ probeCommand: 'claude -p "/usage"', windows: [win()] })], NOW);
    expect(el.querySelector(".lim-meter")).toBe(null);
    const ask = el.querySelector<HTMLButtonElement>(".lim-probe")!;
    expect(ask).not.toBe(null);
    ask.click();
    expect(opened).toEqual([
      { title: "Claude: limits", command: 'claude -p "/usage"', cwd: "/home/dev/code/relay" },
    ]);
  });

  /** Two ways of saying nothing read as two facts. An unknown row says it has no
   *  reading once, and what it adds is the action rather than a second word for
   *  the same absence. */
  it("does not restate an absent reading in the row's foot", () => {
    const { el, block } = mount();
    block.render([snap({ probeCommand: "x", windows: [win()] })], NOW);
    expect(el.querySelector(".lim-foot")).toBe(null);
    expect(el.querySelector(".lim-reading")!.textContent).toBe("no reading");
  });

  it("does put an error in the foot, because that one is actionable", () => {
    const { el, block } = mount();
    block.render([snap({ error: "not signed in — run `claude auth login`", windows: [win()] })], NOW);
    expect(el.querySelector(".lim-foot")!.textContent).toContain("claude auth login");
  });

  it("offers no action when the provider named no command", () => {
    const { el, block } = mount();
    block.render([snap({ probeCommand: null, windows: [win()] })], NOW);
    expect(el.querySelector(".lim-probe")).toBe(null);
  });

  /** The window the registry padded is drawn as unknown, and a window nobody
   *  declared is simply not there — so the block never grows a row of its own
   *  accord and never loses one either. */
  it("draws exactly the windows the snapshot carries", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [
      win({ id: "session", usedFraction: 0.3, state: "ok" }),
      win({ id: "week", state: "unknown" }),
    ] })], NOW);
    // One row, showing the window that has something to say.
    expect(el.querySelectorAll(".lim-row").length).toBe(1);
    expect(el.querySelector(".lim-reading")!.textContent).toBe("30% used");
  });

  it("says what a spent row means in words, not only in colour", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({ state: "exhausted", resetsAt: RESET })] })], NOW);
    expect(el.querySelector(".lim-out-text")!.textContent).toContain("nothing moves until");
    expect(el.querySelector(".lim-row")!.getAttribute("data-state")).toBe("exhausted");
  });

  it("says so when a spent row has no reset time rather than leaving a gap", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({ state: "exhausted", resetsAt: null })] })], NOW);
    expect(el.querySelector(".lim-out-text")!.textContent).toContain("no reset time known");
  });

  /** The tier is on the row itself, at the same size as the number. Not a
   *  tooltip, not a title attribute — see ADR-0009. */
  it("prints the tier of the number it is showing", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({ usedFraction: 0.2, state: "ok", source: "reported" })] })], NOW);
    const tier = el.querySelector(".lim-src")!;
    expect(tier.textContent).toBe("Reported");
    expect(tier.classList.contains("lim-src--reported")).toBe(true);
  });

  it("prints the observed tier where the number is this app's own counting", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({
      amount: { used: 1_250_000, limit: null, unit: "tokens" }, source: "observed",
    })] })], NOW);
    expect(el.querySelector(".lim-src")!.textContent).toBe("Observed");
    expect(el.querySelector(".lim-reading")!.textContent).toBe("1.2M tokens");
  });

  /** A row's accessible name has to be the row's whole meaning: a reader should
   *  not have to assemble five spans into a sentence. */
  it("gives the row one accessible name carrying everything it shows", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({
      usedFraction: 0.42, state: "ok", source: "reported", resetsAt: RESET,
    })] })], NOW);
    const name = el.querySelector(".lim-open")!.getAttribute("aria-label")!;
    expect(name).toContain("Claude");
    expect(name).toContain("Current session");
    expect(name).toContain("42% used");
    expect(name).toContain("Reported");
    expect(name).toContain("resets");
  });

  /** Data from outside this app reaches the DOM as text and never as markup. */
  it("puts a provider's own strings in as text", () => {
    const { el, block } = mount();
    block.render([snap({
      label: "<img src=x onerror=alert(1)>",
      windows: [win({ usedFraction: 0.1, state: "ok" })],
    })], NOW);
    expect(el.querySelector("img")).toBe(null);
    expect(el.querySelector(".lim-name")!.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("keeps the block laid out by the stylesheet rather than by inline styles", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({ usedFraction: 0.25, state: "ok" })] })], NOW);
    const island = el.querySelector<HTMLElement>(".lim-block")!;
    expect(island.classList.contains("island")).toBe(true);
    expect(getComputedStyle(island).display).toBe("flex");
    // The one inline style there is: how full the meter is, which is data.
    expect(el.querySelector<HTMLElement>(".lim-fill")!.style.width).toBe("25%");
  });
});

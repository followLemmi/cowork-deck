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

/** The one press that turns the glance into the list. */
function unfold(el: HTMLElement): void {
  el.querySelector<HTMLButtonElement>(".lim-summary")!.click();
}

const strip = (el: HTMLElement) => el.querySelector<HTMLElement>(".lim-strip")!;
const list = (el: HTMLElement) => el.querySelector<HTMLElement>(".lim-list")!;
/** What the strip says on its own line, in the order a person reads it. */
const stripText = (el: HTMLElement, sel: string) =>
  strip(el).querySelector<HTMLElement>(sel)?.textContent ?? null;

beforeEach(() => { opened = []; });

describe("the limits strip: the one line that is always there", () => {
  it("draws nothing at all when no AI is detected", () => {
    const { el, block } = mount();
    block.render([], NOW);
    expect(el.hidden).toBe(true);
    expect(el.querySelector(".lim-strip")).toBe(null);
  });

  /** The defect this shape exists to fix (#392): the height the panel gives up
   *  must not grow with the number of connected AIs. */
  it("stays one strip and one folded list however many AIs are connected", () => {
    const { el, block } = mount();
    const four = ["claude", "gemini", "codex", "copilot"].map((provider, i) =>
      snap({ provider, label: provider, windows: [win({ usedFraction: 0.1 * i, state: "ok" })] }));
    block.render(four.slice(0, 1), NOW);
    expect(el.querySelectorAll(".lim-strip").length).toBe(1);
    block.render(four, NOW);
    expect(el.querySelectorAll(".lim-strip").length).toBe(1);
    // Every row is drawn, and none of them is taking panel height: the list is
    // folded, and folded is `display: none` rather than a shorter row.
    expect(list(el).querySelectorAll(".lim-row").length).toBe(4);
    expect(list(el).hidden).toBe(true);
    expect(getComputedStyle(list(el)).display).toBe("none");
  });

  /** And when it does open, it is bounded and scrolls — the one thing a fixed
   *  slab could not do. */
  it("caps the rows it opens rather than letting them push the page above", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({ usedFraction: 0.2, state: "ok" })] })], NOW);
    const style = getComputedStyle(list(el));
    expect(style.maxHeight).toContain("min(");
    expect(style.overflowY).toBe("auto");
  });

  /** The answer to "can I keep working" is whichever AI is worst off; the others
   *  cannot make that answer better. */
  it("names the AI that is worst off, not the first one detected", () => {
    const { el, block } = mount();
    block.render([
      snap({ provider: "a", label: "Alpha", windows: [win({ usedFraction: 0.1, state: "ok" })] }),
      snap({ provider: "b", label: "Beta", windows: [win({ state: "exhausted", resetsAt: RESET })] }),
      snap({ provider: "c", label: "Gamma", windows: [win({ usedFraction: 0.9, state: "near" })] }),
    ], NOW);
    expect(stripText(el, ".lim-name")).toBe("Beta");
    expect(strip(el).dataset.state).toBe("exhausted");
  });

  /** ADR-0009 as amended, on the surface that is always on screen: the account's
   *  own figure is the reading a person already assumes, so the line carries it
   *  and nothing else. A bare percentage is still not an acceptable compression
   *  of a reading — see the next test for the case that is not bare. */
  it("carries the account's own figure with nothing beside it", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({ usedFraction: 0.42, state: "ok", source: "reported" })] })], NOW);
    expect(stripText(el, ".lim-reading")).toBe("42% used");
    expect(strip(el).querySelector(".lim-src")).toBe(null);
  });

  /** And the direction that DOES mislead is stopped on the strip too: one
   *  `tierNote`, three surfaces. A qualifier the deck's rows print and the line
   *  above them does not would be the strip quietly overstating the runway. */
  it("qualifies a reading on the strip wherever a row would qualify it", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({ usedFraction: 0.42, state: "ok", source: "observed" })] })], NOW);
    expect(stripText(el, ".lim-src")).toBe("this app only");
    expect(strip(el).querySelector(".lim-src")!.classList.contains("lim-src--observed")).toBe(true);
    // After the reading, as on a row: it qualifies the number, so it follows it.
    const line = [...strip(el).querySelector(".lim-line")!.children].map((c) => c.className);
    expect(line.indexOf("lim-reading")).toBeLessThan(line.findIndex((c) => c.startsWith("lim-src")));
  });

  /** Four things fit on this line and five did not, and the meter was the one of
   *  the five that said what the reading beside it already said. So the state's
   *  hue moved to the words underneath rather than being dropped. */
  it("draws no meter, and takes the state's colour on its words instead", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({ usedFraction: 0.93, state: "near", resetsAt: RESET })] })], NOW);
    expect(strip(el).querySelector(".lim-meter")).toBe(null);
    const said = strip(el).querySelector(".lim-near-text")!;
    expect(said.textContent).toContain("nearly spent");
    expect(getComputedStyle(said).color).toContain("--st-waiting");
  });

  it("takes the spent hue on the same line, with the same words as a row", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({ state: "exhausted", resetsAt: RESET })] })], NOW);
    const said = strip(el).querySelector(".lim-out-text")!;
    expect(said.textContent).toContain("nothing moves until");
    expect(getComputedStyle(said).color).toContain("--st-error");
  });

  it("counts the AIs it is not naming", () => {
    const { el, block } = mount();
    block.render([
      snap({ provider: "a", windows: [win({ usedFraction: 0.5, state: "ok" })] }),
      snap({ provider: "b", windows: [win({ usedFraction: 0.2, state: "ok" })] }),
      snap({ provider: "c", windows: [win({ usedFraction: 0.1, state: "ok" })] }),
    ], NOW);
    expect(stripText(el, ".lim-rest")).toBe("+2");
  });

  /** A bare `+2` over two spent accounts would hide the thing the strip exists to
   *  surface — so it is said in words, on the second line, which the AI being
   *  named has already earned by being at least as badly off as any of them. */
  it("says in words when one of the others is spent too", () => {
    const { el, block } = mount();
    block.render([
      snap({ provider: "a", label: "Alpha", windows: [win({ state: "exhausted", resetsAt: RESET })] }),
      snap({ provider: "b", label: "Beta", windows: [win({ state: "exhausted", resetsAt: RESET })] }),
      snap({ provider: "c", label: "Gamma", windows: [win({ usedFraction: 0.1, state: "ok" })] }),
    ], NOW);
    expect(stripText(el, ".lim-rest")).toBe("+2");
    expect(stripText(el, ".lim-others")).toBe("(1 more spent)");
  });

  it("says so when one of the others is nearly spent", () => {
    const { el, block } = mount();
    block.render([
      snap({ provider: "a", windows: [win({ state: "exhausted", resetsAt: RESET })] }),
      snap({ provider: "b", windows: [win({ usedFraction: 0.95, state: "near" })] }),
    ], NOW);
    expect(stripText(el, ".lim-others")).toBe("(1 more nearly spent)");
  });

  it("says nothing about the others when there is nothing wrong with them", () => {
    const { el, block } = mount();
    block.render([
      snap({ provider: "a", windows: [win({ usedFraction: 0.95, state: "near", resetsAt: RESET })] }),
      snap({ provider: "b", windows: [win({ usedFraction: 0.1, state: "ok" })] }),
    ], NOW);
    expect(stripText(el, ".lim-rest")).toBe("+1");
    expect(strip(el).querySelector(".lim-others")).toBe(null);
  });

  /** One line while the answer is "keep working". Two only when being larger is
   *  the point rather than the complaint. */
  it("adds no second line while the reading is healthy", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({ usedFraction: 0.2, state: "ok", resetsAt: RESET })] })], NOW);
    expect(strip(el).querySelector(".lim-foot")).toBe(null);
  });

  it("says when a nearly-spent reading lifts, since that is when waiting is a plan", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({ usedFraction: 0.93, state: "near", resetsAt: RESET })] })], NOW);
    expect(stripText(el, ".lim-foot")).toContain("resets");
  });

  /** Kept, open or shut, and it used to be given up.
   *
   *  In the panel the rows opened ABOVE the strip, so an open strip was their
   *  head: it swapped its reading for the word "Limits", because every row below
   *  was already saying what it had been saying. In the bar (#461) the rows open
   *  below in a popover with its own edge, and the reading is the reason the bar
   *  carries the line at all — a bar that blanked its own number on a press would
   *  answer less the more you asked it. */
  it("keeps the glance while the rows are open", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({ usedFraction: 0.2, state: "ok" })] })], NOW);
    const reading = () => strip(el).querySelector<HTMLElement>(".lim-reading")!;
    expect(reading().textContent).toContain("20%");
    unfold(el);
    expect(strip(el).dataset.open).toBe("true");
    expect(getComputedStyle(reading()).display).not.toBe("none");
    expect(strip(el).querySelector(".lim-word")).toBeNull();
  });

  it("puts an error where the second line would be, because that one is actionable", () => {
    const { el, block } = mount();
    block.render([snap({ error: "not signed in — run `claude auth login`", windows: [win()] })], NOW);
    expect(stripText(el, ".lim-foot")).toContain("claude auth login");
  });

  /** The way out of an unreadable reading cannot be behind the fold — that is the
   *  one row with nothing to show for itself. */
  it("offers the probe beside the strip when the AI it names cannot be read", () => {
    const { el, block } = mount();
    block.render([snap({ probeCommand: 'claude -p "/usage"', windows: [win()] })], NOW);
    const ask = strip(el).querySelector<HTMLButtonElement>(".lim-probe")!;
    expect(ask).not.toBe(null);
    ask.click();
    expect(opened).toEqual([
      { title: "Claude: limits", command: 'claude -p "/usage"', cwd: "/home/dev/code/relay" },
    ]);
  });

  it("offers no probe beside a strip whose reading is fine", () => {
    const { el, block } = mount();
    block.render([snap({ probeCommand: "x", windows: [win({ usedFraction: 0.3, state: "ok" })] })], NOW);
    expect(strip(el).querySelector(".lim-probe")).toBe(null);
  });

  /** One sentence carrying everything the line shows, starting with the word the
   *  sighted reader gets from the strip's position and its tooltip instead. */
  it("gives the line one accessible name, and it names the block", () => {
    const { el, block } = mount();
    block.render([
      snap({ label: "Claude", windows: [win({ usedFraction: 0.93, state: "near", source: "reported", resetsAt: RESET })] }),
      snap({ provider: "b", label: "Gemini", windows: [win({ usedFraction: 0.1, state: "ok" })] }),
    ], NOW);
    const name = strip(el).querySelector(".lim-summary")!.getAttribute("aria-label")!;
    expect(name.startsWith("Limits")).toBe(true);
    expect(name).toContain("Claude");
    expect(name).toContain("93% used");
    // Nothing qualifying it: the reading is the account's own. The name says
    // what the line says, and a word that reached a screen reader but not the
    // screen would be two different lines for two different people.
    expect(name).not.toContain("Reported");
    expect(name).toContain("nearly spent");
    expect(name).toContain("1 more");
    // The visible label while the rows are open, so the name still starts with
    // what a person can see on it (WCAG 2.5.3).
    expect(name.startsWith("Limits")).toBe(true);
  });

  it("puts a provider's own strings in as text", () => {
    const { el, block } = mount();
    block.render([snap({
      label: "<img src=x onerror=alert(1)>",
      windows: [win({ usedFraction: 0.1, state: "ok" })],
    })], NOW);
    expect(el.querySelector("img")).toBe(null);
    expect(stripText(el, ".lim-name")).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("the rows behind the strip", () => {
  it("are a disclosure: one press shows them, another puts them away", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({ usedFraction: 0.2, state: "ok" })] })], NOW);
    const summary = el.querySelector<HTMLButtonElement>(".lim-summary")!;
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(summary.getAttribute("aria-controls")).toBe(list(el).id);
    unfold(el);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(list(el).hidden).toBe(false);
    unfold(el);
    expect(list(el).hidden).toBe(true);
  });

  /** Folded in place rather than through a re-render, so a keyboard is not thrown
   *  back to the top of the panel by its own press. */
  it("keep the focus on the control that opened them", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({ usedFraction: 0.2, state: "ok" })] })], NOW);
    const summary = el.querySelector<HTMLButtonElement>(".lim-summary")!;
    summary.focus();
    summary.click();
    expect(document.activeElement).toBe(summary);
  });

  /** The sixty-second read must not fold a list somebody is reading. */
  it("stay open across a repaint", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({ usedFraction: 0.2, state: "ok" })] })], NOW);
    unfold(el);
    block.render([snap({ windows: [win({ usedFraction: 0.3, state: "ok" })] })], NOW);
    expect(list(el).hidden).toBe(false);
    expect(el.querySelector(".lim-summary")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("draw one row per detected AI, worst off first", () => {
    const { el, block } = mount();
    block.render([
      snap({ windows: [win({ usedFraction: 0.2, state: "ok", source: "reported" })] }),
      snap({ provider: "gemini", label: "Gemini", windows: [win({ id: "rpd", label: "Requests today" })] }),
      snap({ provider: "codex", label: "Codex", windows: [win({ usedFraction: 0.9, state: "near" })] }),
    ], NOW);
    expect(el.querySelectorAll(".lim-row").length).toBe(3);
    // Codex is nearly spent, Claude has a reading, Gemini has none: the order the
    // strip ranks them in, not the order they were detected in.
    expect([...el.querySelectorAll(".lim-row .lim-name")].map((n) => n.textContent))
      .toEqual(["Codex", "Claude", "Gemini"]);
  });

  /** The claim ADR-0011 rests on. Ranked by detection order the two surfaces
   *  agreed only by luck, and the unlucky case is this one: the AI that is worst
   *  off is the one found LAST, so the strip named it and the list opened on
   *  somebody else — with the list capped and scrolling, possibly off-screen. */
  it("open a list topped by the AI the strip names", () => {
    const { el, block } = mount();
    block.render([
      snap({ windows: [win({ usedFraction: 0.2, state: "ok" })] }),
      snap({ provider: "gemini", label: "Gemini", windows: [win({ usedFraction: 0.4, state: "ok" })] }),
      snap({ provider: "copilot", label: "Copilot", windows: [win({ state: "exhausted", resetsAt: RESET })] }),
    ], NOW);
    expect(stripText(el, ".lim-name")).toBe("Copilot");
    unfold(el);
    expect(list(el).querySelector(".lim-row .lim-name")!.textContent).toBe("Copilot");
  });

  /** The three states, and the absence of a fourth. */
  it("paint three distinct classes, and none of them is the working green", () => {
    const { el, block } = mount();
    block.render([
      snap({ provider: "a", windows: [win({ usedFraction: 0.2, state: "ok" })] }),
      snap({ provider: "b", windows: [win({ usedFraction: 0.9, state: "near" })] }),
      snap({ provider: "c", windows: [win({ state: "exhausted", resetsAt: RESET })] }),
    ], NOW);
    const meters = [...list(el).querySelectorAll(".lim-row .lim-meter")];
    expect(meters.length).toBe(3);
    const classes = meters.map((m) => [...m.classList].find((c) => c.startsWith("lim-") && c !== "lim-meter"));
    expect(new Set(classes).size).toBe(3);
    // The healthy fill takes the neutral ink, and the two that mean something
    // take the two hues the rest of the app already uses for those meanings.
    // Keyed by the state and not by position: the rows are ranked, so which row
    // is which is the ranking's business and not this test's.
    const fill = (state: string) => getComputedStyle(
      list(el).querySelector(`.lim-row[data-state="${state}"] .lim-fill`)!,
    ).background;
    expect(fill("ok")).toContain("--fg-dim");
    expect(fill("near")).toContain("--st-waiting");
    expect(fill("exhausted")).toContain("--st-error");
    // And no rule anywhere in this block reaches for the working green.
    const rules = css.slice(css.indexOf("--- Limits:"));
    expect(rules).not.toContain("--st-working");
  });

  /** An unknown row is the one a person can do something about, so it gets the
   *  action rather than a meter drawn at an arbitrary width. */
  it("give an unknown row the action and no meter", () => {
    const { el, block } = mount();
    block.render([snap({ probeCommand: 'claude -p "/usage"', windows: [win()] })], NOW);
    const row = el.querySelector<HTMLElement>(".lim-row")!;
    expect(row.querySelector(".lim-meter")).toBe(null);
    const ask = row.querySelector<HTMLButtonElement>(".lim-probe")!;
    expect(ask).not.toBe(null);
    ask.click();
    expect(opened).toEqual([
      { title: "Claude: limits", command: 'claude -p "/usage"', cwd: "/home/dev/code/relay" },
    ]);
  });

  /** Two ways of saying nothing read as two facts. An unknown row says it has no
   *  reading once, and what it adds is the action rather than a second word for
   *  the same absence. */
  it("do not restate an absent reading in the row's foot", () => {
    const { el, block } = mount();
    block.render([snap({ probeCommand: "x", windows: [win()] })], NOW);
    const row = el.querySelector<HTMLElement>(".lim-row")!;
    expect(row.querySelector(".lim-foot")).toBe(null);
    expect(row.querySelector(".lim-reading")!.textContent).toBe("no reading");
  });

  it("do put an error in the foot, because that one is actionable", () => {
    const { el, block } = mount();
    block.render([snap({ error: "not signed in — run `claude auth login`", windows: [win()] })], NOW);
    expect(el.querySelector(".lim-row .lim-foot")!.textContent).toContain("claude auth login");
  });

  it("keep a healthy row's reset time, which is the one thing the strip drops", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({ usedFraction: 0.2, state: "ok", resetsAt: RESET })] })], NOW);
    expect(el.querySelector(".lim-row .lim-reset")!.textContent).toContain("resets");
    expect(strip(el).querySelector(".lim-foot")).toBe(null);
  });

  it("offer no action when the provider named no command", () => {
    const { el, block } = mount();
    block.render([snap({ probeCommand: null, windows: [win()] })], NOW);
    expect(el.querySelector(".lim-probe")).toBe(null);
  });

  /** The window the registry padded is drawn as unknown, and a window nobody
   *  declared is simply not there — so the block never grows a row of its own
   *  accord and never loses one either. */
  it("draw exactly the windows the snapshot carries", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [
      win({ id: "session", usedFraction: 0.3, state: "ok" }),
      win({ id: "week", state: "unknown" }),
    ] })], NOW);
    // One row, showing the window that has something to say.
    expect(el.querySelectorAll(".lim-row").length).toBe(1);
    expect(el.querySelector(".lim-row .lim-reading")!.textContent).toBe("30% used");
  });

  it("say what a spent row means in words, not only in colour", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({ state: "exhausted", resetsAt: RESET })] })], NOW);
    expect(el.querySelector(".lim-row .lim-out-text")!.textContent).toContain("nothing moves until");
    expect(el.querySelector(".lim-row")!.getAttribute("data-state")).toBe("exhausted");
  });

  it("say so when a spent row has no reset time rather than leaving a gap", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({ state: "exhausted", resetsAt: null })] })], NOW);
    expect(el.querySelector(".lim-row .lim-out-text")!.textContent).toContain("no reset time known");
  });

  /** The account's own figure needs no word beside it: an unqualified number is
   *  what a person already assumes it to be. ADR-0009's amendment — the tier
   *  name in a row was read by the record's own author, who asked what it
   *  meant. */
  it("print the account's own figure with nothing beside it", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({ usedFraction: 0.2, state: "ok", source: "reported" })] })], NOW);
    expect(el.querySelector(".lim-row .lim-reading")!.textContent).toBe("20% used");
    expect(el.querySelector(".lim-row .lim-src")).toBe(null);
  });

  /** And the direction that DOES mislead is still stopped: this app's own
   *  narrower count says so, in words rather than in a tier's name. */
  it("say a number is this app's own counting, after the number", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({
      amount: { used: 1_250_000, limit: null, unit: "tokens" }, source: "observed",
    })] })], NOW);
    const tier = el.querySelector(".lim-row .lim-src")!;
    expect(tier.textContent).toBe("this app only");
    expect(tier.classList.contains("lim-src--observed")).toBe(true);
    expect(el.querySelector(".lim-row .lim-reading")!.textContent).toBe("1.2M tokens");
    // After, not before: it qualifies the reading, so it follows it.
    const line = [...el.querySelector(".lim-row .lim-line")!.children].map((c) => c.className);
    expect(line.indexOf("lim-reading")).toBeLessThan(line.findIndex((c) => c.startsWith("lim-src")));
  });

  /** A row's accessible name has to be the row's whole meaning: a reader should
   *  not have to assemble five spans into a sentence. */
  it("give the row one accessible name carrying everything it shows", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({
      usedFraction: 0.42, state: "ok", source: "reported", resetsAt: RESET,
    })] })], NOW);
    const name = el.querySelector(".lim-open")!.getAttribute("aria-label")!;
    expect(name).toContain("Claude");
    expect(name).toContain("Current session");
    expect(name).toContain("42% used");
    expect(name).toContain("resets");
  });

  /** EVERYTHING it shows, and nothing it does not: the name says what the row
   *  says. A qualifier that reached a screen reader but not the screen would be
   *  two different rows for two different people. */
  it("carry the qualifier in the name exactly when the row carries it", () => {
    const { el, block } = mount();
    const nameOf = (source: "reported" | "observed") => {
      block.render([snap({ windows: [win({ usedFraction: 0.42, state: "ok", source })] })], NOW);
      return el.querySelector(".lim-row .lim-open")!.getAttribute("aria-label")!;
    };
    expect(nameOf("observed")).toContain("this app only");
    expect(nameOf("reported")).not.toContain("this app only");
  });

  /** Data from outside this app reaches the DOM as text and never as markup. */
  it("put a provider's own strings in as text", () => {
    const { el, block } = mount();
    block.render([snap({
      label: "<img src=x onerror=alert(1)>",
      windows: [win({ usedFraction: 0.1, state: "ok" })],
    })], NOW);
    expect(el.querySelector("img")).toBe(null);
    expect(el.querySelector(".lim-row .lim-name")!.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("stay laid out by the stylesheet rather than by inline styles", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({ usedFraction: 0.25, state: "ok" })] })], NOW);
    expect(getComputedStyle(el).display).toBe("flex");
    expect(getComputedStyle(list(el)).flexDirection).toBe("column");
    // The one inline style there is: how full the meter is, which is data.
    expect(el.querySelector<HTMLElement>(".lim-fill")!.style.width).toBe("25%");
  });

  /** A disclosure whose content comes before its own control reads, to anybody
   *  moving forward through the document, as content that button leads AWAY from.
   *  So the DOM is strip-then-rows — and since #461 the SCREEN is that way up too:
   *  the bar is at the top of the window, so the rows open downward and the
   *  `column-reverse` that used to reconcile the two orders is gone. */
  it("put the strip before the rows, in the DOM and on screen alike", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({ usedFraction: 0.25, state: "ok" })] })], NOW);
    expect([...el.children].map((c) => c.className.split(" ")[0]))
      .toEqual(["lim-strip", "lim-list"]);
    expect(getComputedStyle(el).flexDirection).not.toBe("column-reverse");
    // Out of the flow, so opening the rows costs the bar no height and the deck
    // below it does not move — which is the whole of what #461 was about.
    expect(getComputedStyle(list(el)).position).toBe("absolute");
  });

  /** The rows scroll, and a scroll container clips what leaves it. The global
   *  focus ring is an outline painted outside the button, so the last row in the
   *  list lost the bottom of its own ring. */
  it("draw the rows' focus ring inside them, where the scroll cannot clip it", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({ usedFraction: 0.25, state: "ok" })] })], NOW);
    const rules = css.slice(css.indexOf(".lim-list .lim-open:focus-visible"));
    expect(rules.slice(0, 160)).toContain("inset");
    expect(getComputedStyle(list(el)).overflowY).toBe("auto");
  });
});

describe("what a repaint must not take with it", () => {
  const four = () => ["claude", "gemini", "codex", "copilot"].map((provider) =>
    snap({ provider, label: provider, windows: [win({ usedFraction: 0.3, state: "ok" })] }));

  /** This runs on a sixty-second timer. A person reading row nine must not be
   *  returned to row one by a clock, and the keyboard must not be thrown back to
   *  the top of the document while they are using it. */
  it("keeps the focused row and the list's scroll across a re-read", () => {
    const { el, block } = mount();
    block.render(four(), NOW);
    unfold(el);
    const codex = () => list(el).querySelector<HTMLButtonElement>(
      '.lim-row[data-provider="codex"] .lim-open',
    )!;
    codex().focus();
    list(el).scrollTop = 24;
    block.render(four(), NOW);
    expect(document.activeElement).toBe(codex());
    expect(list(el).scrollTop).toBe(24);
  });

  it("keeps the strip itself focused when that is what was focused", () => {
    const { el, block } = mount();
    block.render(four(), NOW);
    const summary = () => el.querySelector<HTMLButtonElement>(".lim-summary")!;
    summary().focus();
    block.render(four(), NOW);
    expect(document.activeElement).toBe(summary());
  });

  /** And it must not GRAB focus either: a repaint while somebody is typing
   *  somewhere else in the app is not a request for the panel's foot. */
  it("leaves focus alone when it was somewhere else entirely", () => {
    const { el, block } = mount();
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    block.render(four(), NOW);
    elsewhere.focus();
    block.render(four(), NOW);
    expect(document.activeElement).toBe(elsewhere);
  });

  /** Folded is the default because folded is the answer. A block that has gone
   *  away keeps no fold to come back with. */
  it("comes back folded after every AI has gone away", () => {
    const { el, block } = mount();
    block.render([snap({ windows: [win({ usedFraction: 0.2, state: "ok" })] })], NOW);
    unfold(el);
    expect(list(el).hidden).toBe(false);
    block.render([], NOW);
    block.render([snap({ windows: [win({ usedFraction: 0.2, state: "ok" })] })], NOW);
    expect(list(el).hidden).toBe(true);
  });
});

/** An error arrives beside the windows rather than instead of them, so a reading
 *  and the reason it cannot be refreshed can both be true. */
describe("a reading that came with an error", () => {
  it("says what is wrong under a nearly-spent row with no reset time", () => {
    const { el, block } = mount();
    block.render([snap({
      error: "token expired — run `claude auth login`",
      windows: [win({ usedFraction: 0.92, state: "near" })],
    })], NOW);
    unfold(el);
    const foot = list(el).querySelector(".lim-row .lim-foot")!.textContent!;
    expect(foot).toContain("nearly spent");
    expect(foot).toContain("token expired");
  });

  it("still prefers the reset time when there is one", () => {
    const { el, block } = mount();
    block.render([snap({
      error: "token expired",
      windows: [win({ usedFraction: 0.92, state: "near", resetsAt: RESET })],
    })], NOW);
    unfold(el);
    const foot = list(el).querySelector(".lim-row .lim-foot")!.textContent!;
    expect(foot).toContain("nearly spent — resets");
    expect(foot).not.toContain("token expired");
  });
});

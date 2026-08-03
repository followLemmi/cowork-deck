// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import styles from "../src/styles.css?raw";
import { applyView, type ViewElements } from "../src/view";

function mount(): ViewElements {
  document.head.replaceChildren();
  const style = document.createElement("style");
  style.textContent = styles;
  document.head.append(style);
  // Mirrors index.html, including the `#stage` row and the `#viewbar` above it:
  // this is the one test that reads the real stylesheet, so a harness that does
  // not match the real structure could pass against a rule the app never gets.
  // The switch's buttons live in `#viewbar` in the app; here they stay detached
  // (below), because `applyView` only toggles their `active` class.
  document.body.innerHTML =
    '<div id="app"><nav id="viewbar"></nav><div id="stage">' +
    '<aside id="sidebar"><div id="ws"></div><div id="sk"></div>' +
    '<button id="new"></button><div id="list"></div></aside>' +
    '<main id="deck"></main><div id="board" class="hidden"></div>' +
    '<div id="pr" class="hidden"></div></div></div>';
  const pick = (sel: string) => document.querySelector<HTMLElement>(sel)!;
  return {
    deck: pick("#deck"),
    board: pick("#board"),
    pr: pick("#pr"),
    termBtn: document.createElement("button"),
    boardBtn: document.createElement("button"),
    prBtn: document.createElement("button"),
    terminalsOnly: [pick("#sk"), pick("#new"), pick("#list")],
  };
}

const shown = (el: HTMLElement) => getComputedStyle(el).display !== "none";

describe("applyView", () => {
  let el: ViewElements;
  beforeEach(() => { el = mount(); });

  it("shows exactly one screen at a time", () => {
    for (const view of ["deck", "board", "pr"] as const) {
      applyView(el, view);
      const visible = [el.deck, el.board, el.pr].filter(shown);
      expect(visible).toHaveLength(1);
    }
  });

  it("hides the deck on the board screen, against the real stylesheet", () => {
    applyView(el, "board");
    // The regression this test exists for: #deck { display: grid } is an id
    // selector and outweighs .tk-hidden, so asserting the class would pass
    // while the terminals stayed on screen.
    expect(getComputedStyle(el.deck).display).toBe("none");
    expect(shown(el.board)).toBe(true);
  });

  it("hides the deck on the PR screen, against the real stylesheet", () => {
    applyView(el, "pr");
    // Same trap as the board: #deck { display: grid } is an id selector and
    // outweighs .tk-hidden, so asserting the class would pass while the
    // terminals stayed on screen.
    expect(getComputedStyle(el.deck).display).toBe("none");
    expect(shown(el.pr)).toBe(true);
  });

  it("brings the deck back on the terminals screen", () => {
    applyView(el, "board");
    applyView(el, "deck");
    expect(getComputedStyle(el.deck).display).toBe("grid");
    expect(shown(el.board)).toBe(false);
  });

  it("hides the terminals-only sidebar blocks on the board screen", () => {
    applyView(el, "board");
    for (const node of el.terminalsOnly) expect(shown(node)).toBe(false);
  });

  it("hides the terminals-only sidebar blocks on the PR screen too", () => {
    applyView(el, "pr");
    for (const node of el.terminalsOnly) expect(shown(node)).toBe(false);
  });

  it("restores the terminals-only sidebar blocks", () => {
    applyView(el, "board");
    applyView(el, "deck");
    for (const node of el.terminalsOnly) expect(shown(node)).toBe(true);
  });

  it("marks the active button", () => {
    applyView(el, "board");
    expect(el.boardBtn.classList.contains("active")).toBe(true);
    expect(el.termBtn.classList.contains("active")).toBe(false);
    applyView(el, "deck");
    expect(el.termBtn.classList.contains("active")).toBe(true);
  });

  it("marks exactly one button active", () => {
    applyView(el, "pr");
    expect(el.prBtn.classList.contains("active")).toBe(true);
    expect(el.boardBtn.classList.contains("active")).toBe(false);
    expect(el.termBtn.classList.contains("active")).toBe(false);
  });
});

// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import styles from "../src/styles.css?raw";
import { applyView, type ViewElements } from "../src/view";

function mount(): ViewElements {
  document.head.replaceChildren();
  const style = document.createElement("style");
  style.textContent = styles;
  document.head.append(style);
  document.body.innerHTML =
    '<div id="app"><aside id="sidebar"><div id="ws"></div><div id="sk"></div>' +
    '<button id="new"></button><div id="list"></div></aside>' +
    '<main id="deck"></main><div id="board" class="hidden"></div></div>';
  const pick = (sel: string) => document.querySelector<HTMLElement>(sel)!;
  return {
    deck: pick("#deck"),
    board: pick("#board"),
    termBtn: document.createElement("button"),
    boardBtn: document.createElement("button"),
    terminalsOnly: [pick("#sk"), pick("#new"), pick("#list")],
  };
}

const shown = (el: HTMLElement) => getComputedStyle(el).display !== "none";

describe("applyView", () => {
  let el: ViewElements;
  beforeEach(() => { el = mount(); });

  it("hides the deck on the board screen, against the real stylesheet", () => {
    applyView(el, true);
    // The regression this test exists for: #deck { display: grid } is an id
    // selector and outweighs .tk-hidden, so asserting the class would pass
    // while the terminals stayed on screen.
    expect(getComputedStyle(el.deck).display).toBe("none");
    expect(shown(el.board)).toBe(true);
  });

  it("brings the deck back on the terminals screen", () => {
    applyView(el, true);
    applyView(el, false);
    expect(getComputedStyle(el.deck).display).toBe("grid");
    expect(shown(el.board)).toBe(false);
  });

  it("hides the terminals-only sidebar blocks on the board screen", () => {
    applyView(el, true);
    for (const node of el.terminalsOnly) expect(shown(node)).toBe(false);
  });

  it("restores the terminals-only sidebar blocks", () => {
    applyView(el, true);
    applyView(el, false);
    for (const node of el.terminalsOnly) expect(shown(node)).toBe(true);
  });

  it("marks the active button", () => {
    applyView(el, true);
    expect(el.boardBtn.classList.contains("active")).toBe(true);
    expect(el.termBtn.classList.contains("active")).toBe(false);
    applyView(el, false);
    expect(el.termBtn.classList.contains("active")).toBe(true);
  });
});

// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { brandIcon, icon, iconButton, installSprite, BRAND_NAMES, ICON_NAMES } from "../src/icons";

beforeEach(() => { document.body.innerHTML = ""; });

describe("installSprite", () => {
  it("defines every icon exactly once, however often it is called", () => {
    installSprite();
    installSprite();
    const symbols = document.querySelectorAll("svg symbol");
    // Two families in one sprite: the house icons on a 16-unit grid and the
    // AIs' own logos on their owners' 24 — see `BRAND_PATHS`.
    expect(symbols).toHaveLength(ICON_NAMES.length + BRAND_NAMES.length);
  });

  /** A logo is filled on a 24-unit grid, which is the opposite of everything in
   *  `PATHS`: `.icon` sets `fill: none; stroke: currentColor` and would render
   *  one as nothing at all. So they are their own symbols, their own class and
   *  their own function. */
  it("keeps the logos on their own grid, apart from the house icons", () => {
    installSprite();
    for (const name of BRAND_NAMES) {
      const sym = document.querySelector(`#b-${name}`)!;
      expect(sym.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(sym.querySelector("path")!.getAttribute("d")).not.toBe("");
    }
    const svg = brandIcon(BRAND_NAMES[0]);
    expect(svg.getAttribute("class")).toBe("brand");
    expect(svg.querySelector("use")!.getAttribute("href")).toBe(`#b-${BRAND_NAMES[0]}`);
  });

  it("gives every symbol an id the instances can reference", () => {
    installSprite();
    for (const name of ICON_NAMES) {
      expect(document.getElementById(`i-${name}`)).not.toBeNull();
    }
  });
});

describe("icon", () => {
  it("references the sprite instead of copying the geometry", () => {
    const svg = icon("pencil");
    expect(svg.querySelector("use")!.getAttribute("href")).toBe("#i-pencil");
  });

  // The glyph is decoration; the name lives on the button around it, or the
  // control would announce itself twice.
  it("is hidden from assistive tech", () => {
    expect(icon("pencil").getAttribute("aria-hidden")).toBe("true");
  });
});

describe("iconButton", () => {
  // The whole point of the helper: a label is impossible to forget because the
  // parameter is required. Emoji buttons had no accessible name at all.
  it("carries the label as both accessible name and tooltip", () => {
    const b = iconButton("trash", "Delete scenario Nightly review");
    expect(b.getAttribute("aria-label")).toBe("Delete scenario Nightly review");
    expect(b.title).toBe("Delete scenario Nightly review");
  });

  // Tests used to find buttons by their glyph text, which an SVG has none of.
  it("exposes a stable hook that does not depend on glyph text", () => {
    expect(iconButton("x", "Close").dataset.action).toBe("x");
  });

  it("is a real button with the shared icon-button class", () => {
    const b = iconButton("rotate", "Restart");
    expect(b.tagName).toBe("BUTTON");
    expect(b.className).toContain("btn--icon");
  });
});

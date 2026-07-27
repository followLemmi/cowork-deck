// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { icon, iconButton, installSprite, ICON_NAMES } from "../src/icons";

beforeEach(() => { document.body.innerHTML = ""; });

describe("installSprite", () => {
  it("defines every icon exactly once, however often it is called", () => {
    installSprite();
    installSprite();
    const symbols = document.querySelectorAll("svg symbol");
    expect(symbols).toHaveLength(ICON_NAMES.length);
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
    const b = iconButton("trash", "Удалить сценарий Ночной обзор");
    expect(b.getAttribute("aria-label")).toBe("Удалить сценарий Ночной обзор");
    expect(b.title).toBe("Удалить сценарий Ночной обзор");
  });

  // Tests used to find buttons by their glyph text, which an SVG has none of.
  it("exposes a stable hook that does not depend on glyph text", () => {
    expect(iconButton("x", "Закрыть").dataset.action).toBe("x");
  });

  it("is a real button with the shared icon-button class", () => {
    const b = iconButton("rotate", "Перезапустить");
    expect(b.tagName).toBe("BUTTON");
    expect(b.className).toContain("btn--icon");
  });
});

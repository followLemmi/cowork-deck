#!/usr/bin/env node
/** Measured contrast for the cases automated tooling gets wrong.
 *
 *  axe-core and Lighthouse report every one of the ancestor-`opacity` rows below
 *  as *passing*, because neither composites it: they read the computed `color`
 *  and the computed `background-color` and stop. An element at `opacity: 0.45`
 *  has the same computed colour as one at `opacity: 1`. That is why this file
 *  exists in the repository rather than a tool being named in a document — a
 *  number nobody can reproduce is a number nobody can check.
 *
 *  Plain Node ESM, no dependencies, nothing to install: `npm run contrast`.
 *  Reads `src/styles.css` and `src/terminal.ts` rather than restating their
 *  values, so a palette edit moves these numbers instead of silently disagreeing
 *  with them. Exits non-zero when a case misses its threshold.
 *
 *  Thresholds are WCAG 2.2 AA: 4.5:1 for text (1.4.3), 3.0:1 for user interface
 *  components and meaningful graphics (1.4.11). The 3.0:1 large-text allowance
 *  never applies here — it begins at 24px, and the app's largest step is 19px.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- colour ---------------------------------------------------------------

/** `--name: value` pairs from the first `:root` block. */
function readTokens(css) {
  const block = css.slice(css.indexOf(":root"), css.indexOf("}", css.indexOf(":root")));
  const tokens = new Map();
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens.set(m[1], m[2].trim());
  return tokens;
}

/** `#rgb`, `#rrggbb`, `rgba(r, g, b, a)`, or a `--token` naming one of those. */
function parseColor(value, tokens) {
  let v = String(value).trim();
  for (let i = 0; i < 8 && v.startsWith("--"); i++) {
    if (!tokens.has(v)) throw new Error(`unknown token ${v}`);
    v = tokens.get(v).trim();
  }
  const varRef = v.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (varRef) return parseColor(varRef[1], tokens);

  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  const rgba = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/);
  if (rgba) {
    return { r: +rgba[1], g: +rgba[2], b: +rgba[3], a: rgba[4] === undefined ? 1 : +rgba[4] };
  }
  throw new Error(`cannot parse colour: ${value}`);
}

/** Source-over: `top` (possibly translucent) painted on opaque `bottom`. */
function over(top, bottom) {
  const a = top.a;
  return {
    r: a * top.r + (1 - a) * bottom.r,
    g: a * top.g + (1 - a) * bottom.g,
    b: a * top.b + (1 - a) * bottom.b,
    a: 1,
  };
}

/** Paint a stack bottom-first. The bottom layer must be opaque — a stack that
 *  starts translucent has no defined result without knowing what is behind it. */
function stack(layers, tokens) {
  const parsed = layers.map((l) => parseColor(l, tokens));
  if (parsed.length === 0) throw new Error("empty stack");
  if (parsed[0].a !== 1) throw new Error(`stack starts with a translucent layer: ${layers[0]}`);
  return parsed.reduce((acc, layer) => over(layer, acc));
}

/** CSS `filter: grayscale(amount)`, which interpolates towards luma in sRGB
 *  space — not in linear light. Needed for exactly one case: `:disabled` pairs
 *  `opacity` with `grayscale(0.4)`, and ignoring the filter overstates the
 *  ratio. Coefficients are the feColorMatrix ones the spec defines. */
function grayscale(c, amount) {
  const luma = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return {
    r: c.r + (luma - c.r) * amount,
    g: c.g + (luma - c.g) * amount,
    b: c.b + (luma - c.b) * amount,
    a: c.a,
  };
}

function luminance({ r, g, b }) {
  const ch = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function ratio(x, y) {
  const [hi, lo] = [luminance(x), luminance(y)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

const hex = ({ r, g, b }) =>
  "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

// --- the model ------------------------------------------------------------

/** Resolve one case to the two colours a person's eye actually receives.
 *
 *  `backdrop` is the stack *behind* the element; `group` is what the element and
 *  its ancestors paint on top of it, inside the `opacity` group. The distinction
 *  is the whole point: `opacity` on an ancestor renders its subtree to a buffer
 *  and composites the result over the backdrop, so both the text *and* any
 *  background inside the group are pulled towards the backdrop by `1 - opacity`.
 *  A row with no background of its own contributes nothing to the buffer, so its
 *  background comes out unchanged while its text fades — which is exactly how a
 *  dimmed row loses contrast that no computed style reports. */
function resolve(c, tokens) {
  const backdrop = stack(c.backdrop, tokens);
  const group = c.group ?? [];
  const opacity = c.opacity ?? 1;

  let fg = parseColor(c.fg, tokens);
  if (c.filter === "grayscale") fg = grayscale(fg, c.filterAmount);

  if (opacity === 1) return { fg: over(fg, backdrop), bg: stack([...c.backdrop, ...group], tokens) };

  if (group.length === 0) {
    // Nothing opaque inside the group: the background survives, the text fades.
    return { fg: over({ ...fg, a: fg.a * opacity }, backdrop), bg: backdrop };
  }
  const inside = stack(group, tokens); // asserts the group's own base is opaque
  return {
    fg: over({ ...fg, a: fg.a * opacity }, backdrop),
    bg: over({ ...inside, a: opacity }, backdrop),
  };
}

// --- the cases ------------------------------------------------------------

const css = readFileSync(join(root, "src/styles.css"), "utf8");
const tokens = readTokens(css);

// The terminal's palette is set from JS, not from a token, so it is read from
// there: xterm owns its own theme (see src/terminal.ts).
const termSrc = readFileSync(join(root, "src/terminal.ts"), "utf8");
const termColor = (name) => {
  const m = termSrc.match(new RegExp(`${name}:\\s*"(#[0-9a-fA-F]{3,6})"`));
  if (!m) throw new Error(`no ${name} in src/terminal.ts`);
  return m[1];
};

const TEXT = 4.5;   // 1.4.3
const UI = 3.0;     // 1.4.11
const EXEMPT = 0;   // measured and reported, but disabled controls are exempt

/** `--accent-weak` over the panel: the selected session row and the selected
 *  board filter, which is where a user is most likely to be looking. */
const ACTIVE_ROW = ["--bg-panel", "--accent-weak"];

const CASES = [
  {
    what: ".btn--icon at rest",
    where: "every icon control in the app, on a sidebar row",
    fg: "--fg-muted", backdrop: ["--bg-panel"], opacity: 0.45,
    threshold: UI, sc: "1.4.11",
  },
  {
    what: ".tk-row.done meta",
    where: "a closed row in the issue list",
    fg: "--fg-subtle", backdrop: ["--bg-panel"], opacity: 0.6,
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: ".tk-card.done meta",
    where: "a closed card on the board",
    fg: "--fg-subtle", backdrop: ["--bg-app"], group: ["--bg-panel"], opacity: 0.6,
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: "terminal brightBlack",
    where: "most of Claude Code's secondary output, on the focused tile",
    fg: termColor("brightBlack"), backdrop: [termColor("background")],
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: "terminal brightBlack, dimmed tile",
    where: "the same text on any tile that is not the active one",
    fg: termColor("brightBlack"), backdrop: ["--bg-app"], group: [termColor("background")], opacity: 0.82,
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: "--fg-subtle badge, dimmed tile",
    where: "a tile head's badges while another tile is active",
    fg: "--fg-subtle", backdrop: ["--bg-app"], group: ["--bg-panel"], opacity: 0.82,
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: ".state-error on panel",
    where: "a session row at rest",
    fg: "--st-error", backdrop: ["--bg-panel"], group: ["rgba(224, 108, 117, 0.16)"],
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: ".state-error on raised",
    where: "a hovered session row",
    fg: "--st-error", backdrop: ["--bg-raised"], group: ["rgba(224, 108, 117, 0.16)"],
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: ".state-error on active row",
    where: "the selected session row — where the eye already is",
    fg: "--st-error", backdrop: ACTIVE_ROW, group: ["rgba(224, 108, 117, 0.16)"],
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: ".state-ended on active row",
    where: "the selected session row",
    fg: "--st-ended", backdrop: ACTIVE_ROW, group: ["rgba(86, 182, 194, 0.14)"],
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: ".state-idle on panel",
    where: "the most common state label of all",
    fg: "--fg-muted", backdrop: ["--bg-panel"], group: ["rgba(107, 114, 125, 0.14)"],
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: "button:disabled",
    where: "opacity 0.5 and grayscale(0.4) together",
    fg: "--fg-muted", backdrop: ["--bg-panel"], opacity: 0.5,
    filter: "grayscale", filterAmount: 0.4,
    threshold: EXEMPT, sc: "exempt (1.4.3 excludes inactive controls)",
  },
  {
    what: ".pr-actions button:disabled",
    where: "opacity 0.5 on the raised pull request row",
    fg: "--fg-muted", backdrop: ["--bg-raised"], opacity: 0.5,
    filter: "grayscale", filterAmount: 0.4,
    threshold: EXEMPT, sc: "exempt",
  },
  // Borders are a real 1.4.11 failure and deliberately not this phase's work:
  // raising them is a decision about how the whole app looks. Measured so the
  // table is not quietly incomplete.
  {
    what: "--border as a boundary",
    where: "out of scope — a palette decision, its own card",
    fg: "--border", backdrop: ["--bg-panel"],
    threshold: EXEMPT, sc: "1.4.11 (out of scope)",
  },
  {
    what: "--border-strong as a boundary",
    where: "out of scope — same",
    fg: "--border-strong", backdrop: ["--bg-panel"],
    threshold: EXEMPT, sc: "1.4.11 (out of scope)",
  },
  {
    what: "--bg-app input fill on a dialog",
    where: "out of scope — focus-and-hover, not a brighter resting border",
    fg: "--bg-app", backdrop: ["--bg-panel"],
    threshold: EXEMPT, sc: "1.4.11 (out of scope)",
  },
];

// --- self-check -----------------------------------------------------------

/** The maths, against values that are not this app's. If these drift, every
 *  number below is wrong and the table is worse than no table. */
function selfCheck() {
  const black = { r: 0, g: 0, b: 0, a: 1 };
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const checks = [
    ["white on black is 21:1", ratio(white, black), 21, 0.01],
    ["#767676 on white is the 4.5 boundary", ratio({ r: 118, g: 118, b: 118, a: 1 }, white), 4.54, 0.01],
    ["#595959 on white", ratio({ r: 89, g: 89, b: 89, a: 1 }, white), 7.0, 0.05],
    ["a colour against itself is 1:1", ratio(white, white), 1, 0.001],
    // 50% black over white is #808080 by definition of source-over.
    ["source-over halves correctly", over({ r: 0, g: 0, b: 0, a: 0.5 }, white).r, 127.5, 0.001],
    ["grayscale(1) flattens to luma", grayscale({ r: 255, g: 0, b: 0, a: 1 }, 1).g, 0.2126 * 255, 0.001],
    ["grayscale(0) changes nothing", grayscale({ r: 255, g: 0, b: 0, a: 1 }, 0).g, 0, 0.001],
  ];
  const bad = checks.filter(([, got, want, tol]) => Math.abs(got - want) > tol);
  for (const [name, got, want] of bad) {
    console.error(`self-check FAILED: ${name} — got ${got}, want ${want}`);
  }
  return bad.length === 0;
}

// --- report ---------------------------------------------------------------

function main() {
  if (!selfCheck()) {
    console.error("\nThe contrast maths is wrong. Fix it before trusting anything below.");
    process.exit(2);
  }

  const rows = CASES.map((c) => {
    const { fg, bg } = resolve(c, tokens);
    const r = ratio(fg, bg);
    return { c, r, fg, bg, fails: c.threshold > 0 && r < c.threshold };
  });

  const w = (key, min) => Math.max(min, ...rows.map((x) => String(key(x)).length));
  const wWhat = w((x) => x.c.what, 4);
  const wSc = w((x) => x.c.sc, 2);

  console.log(`\nComposited contrast — ${rows.length} cases, from src/styles.css and src/terminal.ts\n`);
  console.log(
    "  " + "case".padEnd(wWhat) + "  ratio   need   " + "SC".padEnd(wSc) + "  effective fg / bg",
  );
  console.log("  " + "-".repeat(wWhat + 20 + wSc + 20));
  for (const { c, r, fg, bg, fails } of rows) {
    const need = c.threshold > 0 ? c.threshold.toFixed(1) : "  — ";
    console.log(
      "  " + c.what.padEnd(wWhat) +
      "  " + r.toFixed(2).padStart(5) +
      "  " + need.padStart(5) +
      "  " + c.sc.padEnd(wSc) +
      "  " + hex(fg) + " on " + hex(bg) +
      (fails ? "   <<< FAILS" : ""),
    );
    console.log("  " + " ".repeat(wWhat) + "  " + c.where);
  }

  const failed = rows.filter((x) => x.fails);
  console.log("");
  if (failed.length === 0) {
    console.log(`  every case with a threshold clears it (${rows.length - failed.length} measured).`);
    return 0;
  }
  console.log(`  ${failed.length} case${failed.length === 1 ? "" : "s"} below threshold:`);
  for (const { c, r } of failed) console.log(`    ${c.what} — ${r.toFixed(2)} against ${c.threshold}`);
  return 1;
}

process.exit(main());

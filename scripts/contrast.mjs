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
 *  components and meaningful graphics (1.4.11). The 3.0:1 large-text allowance still
 *  never applies: the largest step anything currently renders at is `--fs-xl` at
 *  22px, and the allowance begins at 24px. There is deliberately no step above it: a
 *  30px token was declared during the redesign and removed again because nothing
 *  rendered at it. Whatever first does needs a case here, not an assumption that the
 *  3.0 allowance applies.
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

/** The declaration block for one *exact* selector — `.btn--icon` must not match
 *  `.btn--icon:hover`. Returns null when the rule is absent. */
function ruleBody(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`(?:^|[\\n};])\\s*${esc}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : null;
}

/** Read a property out of a rule, so this file measures the stylesheet's values
 *  rather than a copy of them that can quietly fall behind. Throws when the rule
 *  or the property has gone — a case pointing at something that no longer exists
 *  must fail loudly, not report a stale number. */
function decl(css, selector, property) {
  const body = ruleBody(css, selector);
  if (body === null) throw new Error(`no rule for \`${selector}\` — has it been renamed or deleted?`);
  const m = body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`));
  if (!m) throw new Error(`\`${selector}\` no longer declares \`${property}\``);
  return m[1].trim();
}

/** Assert a rule is gone, for the two this phase deleted. A rule that comes back
 *  brings its failure back with it, and silence is how that happens. */
function assertNoRule(css, selector, why) {
  if (ruleBody(css, selector) !== null) {
    throw new Error(`\`${selector}\` is back in src/styles.css — ${why}`);
  }
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

// The diff drawer's two tints. Read from `:root` like every other token — but the
// drawer's cases must be measurable before the stylesheet catches up, so these
// literals stand in when the token is absent. A fallback that kept quiet would be
// worse than no case at all: the table would report a number for a colour the
// stylesheet does not contain. It says so instead, once, above the table.
const PENDING = new Map([
  ["--diff-add-weak", "rgba(152, 195, 121, 0.13)"],
  ["--diff-del-weak", "rgba(231, 143, 150, 0.13)"],
]);
const fellBack = [];
for (const [name, literal] of PENDING) {
  if (tokens.has(name)) continue;
  tokens.set(name, literal);
  fellBack.push(`${name}: ${literal}`);
}

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

/** `--sel` over the panel: the selected session row and the selected
 *  board filter, which is where a user is most likely to be looking. */
const ACTIVE_ROW = ["--bg-island", "--sel"];

/** The two diff bands: a tint at 0.13 painted straight onto the list's own ground.
 *  The tint sits *under* code, so every point of alpha is contrast taken off `--fg`
 *  — which is why the cases below are worth keeping rather than assuming. */
const ADDED_BAND = ["--bg-void", "--diff-add-weak"];
const REMOVED_BAND = ["--bg-void", "--diff-del-weak"];

// Values read out of the rules they belong to, so this table cannot drift from
// the stylesheet it describes.
/** `.btn--icon`'s resting colour. This used to be its `opacity`, and the change is
 *  the point: the rule no longer has one. Muting a control with ancestor opacity is
 *  what put every icon button in the app at 2.67:1 while sitting still, and it is
 *  invisible to axe-core and Lighthouse because neither composites it. A colour is
 *  measurable by anything, including them. `decl` throws if the property goes, so
 *  putting `opacity` back cannot happen quietly. */
const ICON_REST_COLOR = decl(css, ".btn--icon", "color");
const ICON_ROW_HOVER = decl(css, ".btn--icon:hover", "color");
const DISABLED = Number(decl(css, "button:disabled, .sk-run:disabled", "opacity"));
const GRAY = Number(decl(css, "button:disabled, .sk-run:disabled", "filter").match(/grayscale\(([\d.]+)\)/)[1]);
const ERROR_FILL = decl(css, ".state-error", "background");
const ENDED_FILL = decl(css, ".state-ended", "background");
const IDLE_FILL = decl(css, ".state-idle", "background");
const WORKING_FILL = decl(css, ".state-working", "background");
const WAITING_FILL = decl(css, ".state-waitingInput", "background");
const DONE_FILL = decl(css, ".state-done", "background");

// Two rules this phase deleted, asserted absent rather than measured. Both dimmed
// content to restate something the layout already said, and both took real
// contrast to do it — 2.25:1 on a dimmed tile's terminal text, 2.66:1 on a closed
// row's meta. If either returns, so does its failure.
assertNoRule(css, "#deck.has-active .tile:not(.is-active)",
  "it dimmed every non-active tile to 2.25:1 to restate an active border");
assertNoRule(css, ".tk-row.done", "its opacity took a closed row's meta to 2.66:1");
assertNoRule(css, ".tk-card.done", "its opacity took a closed card's meta to 2.64:1");

const CASES = [
  {
    what: ".btn--icon at rest",
    where: "every icon control in the app, sitting still on a sidebar island",
    fg: ICON_REST_COLOR, backdrop: ["--bg-island"],
    threshold: UI, sc: "1.4.11",
  },
  {
    what: ".btn--icon at rest, on a hovered row",
    where: "the same control once the ground under it has moved — hover raises the ground, not the ink",
    fg: ICON_REST_COLOR, backdrop: ["--bg-hover"],
    threshold: UI, sc: "1.4.11",
  },
  {
    what: ".btn--icon on its own hover",
    where: "the brightest of the three steps, on the ground its own hover paints",
    fg: ICON_ROW_HOVER, backdrop: ["--bg-hover"],
    threshold: UI, sc: "1.4.11",
  },
  {
    what: ".btn--icon at rest, on a selected row",
    where: "the worst ground it can land on: `--sel` lightens what the glyph is read against",
    fg: ICON_REST_COLOR, backdrop: ACTIVE_ROW,
    threshold: UI, sc: "1.4.11",
  },
  {
    what: "closed row meta",
    where: "a closed row in the issue list, no longer dimmed",
    fg: "--fg-dim", backdrop: ["--bg-island"],
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: "closed card meta",
    where: "a closed card on the board, no longer dimmed",
    fg: "--fg-dim", backdrop: ["--bg-void"], group: ["--bg-island"],
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: "terminal brightBlack",
    where: "most of Claude Code's secondary output — hints, timestamps, diff context",
    fg: termColor("brightBlack"), backdrop: [termColor("background")],
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: "--fg-dim badge on a tile head",
    where: "no longer dimmed on the tiles that are not active",
    fg: "--fg-dim", backdrop: ["--bg-island"],
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: ".state-error on panel",
    where: "a session row at rest",
    fg: "--st-error", backdrop: ["--bg-island"], group: [ERROR_FILL],
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: ".state-error on raised",
    where: "a hovered session row",
    fg: "--st-error", backdrop: ["--bg-inset"], group: [ERROR_FILL],
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: ".state-error on active row",
    where: "the selected session row — where the eye already is, and the worst case",
    fg: "--st-error", backdrop: ACTIVE_ROW, group: [ERROR_FILL],
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: ".state-ended on active row",
    where: "the selected session row",
    fg: "--st-ended", backdrop: ACTIVE_ROW, group: [ENDED_FILL],
    threshold: TEXT, sc: "1.4.3",
  },
  // The whole chip set against its worst backdrop, not only the two the audit
  // happened to name. They differ by hue and by alpha, so one passing says
  // nothing about the others — and `.state-error` was found here, at 3.34.
  {
    what: ".state-idle on active row",
    where: "the most common state label of all",
    fg: "--fg-mid", backdrop: ACTIVE_ROW, group: [IDLE_FILL],
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: ".state-working on active row",
    where: "a running session, selected",
    fg: "--st-working", backdrop: ACTIVE_ROW, group: [WORKING_FILL],
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: ".state-waitingInput on active row",
    where: "the state a person is most likely to be looking for",
    fg: "--st-waiting", backdrop: ACTIVE_ROW, group: [WAITING_FILL],
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: ".state-done on active row",
    where: "finished work, selected",
    fg: "--st-working", backdrop: ACTIVE_ROW, group: [DONE_FILL],
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: "button:disabled",
    where: "opacity and grayscale together — exempt, raised anyway",
    fg: "--fg-mid", backdrop: ["--bg-island"], opacity: DISABLED,
    filter: "grayscale", filterAmount: GRAY,
    threshold: EXEMPT, sc: "exempt (1.4.3 excludes inactive controls)",
  },
  {
    what: "button:disabled on raised",
    where: "the same rule on a pull request row",
    fg: "--fg-mid", backdrop: ["--bg-inset"], opacity: DISABLED,
    filter: "grayscale", filterAmount: GRAY,
    threshold: EXEMPT, sc: "exempt",
  },
  // Borders are a real 1.4.11 failure and deliberately not this phase's work:
  // raising them is a decision about how the whole app looks. Measured so the
  // table is not quietly incomplete.
  {
    what: "--line as a boundary",
    where: "out of scope — a palette decision, its own card",
    fg: "--line", backdrop: ["--bg-island"],
    threshold: EXEMPT, sc: "1.4.11 (out of scope)",
  },
  {
    what: "--line-strong as a boundary",
    where: "out of scope — same",
    fg: "--line-strong", backdrop: ["--bg-island"],
    threshold: EXEMPT, sc: "1.4.11 (out of scope)",
  },
  {
    what: "--bg-void input fill on a dialog",
    where: "out of scope — focus-and-hover, not a brighter resting border",
    fg: "--bg-void", backdrop: ["--bg-island"],
    threshold: EXEMPT, sc: "1.4.11 (out of scope)",
  },

  // The card dialog's damaged/conflict banner: a new surface, and the first one in the
  // app to put body text on a tinted error ground rather than on a chip.
  {
    what: "damaged-card banner text",
    where: "the reasons a card cannot be written, on `--bg-error-soft` over the dialog",
    fg: "--fg", backdrop: ["--bg-island"], group: [decl(css, ".tk-c-broken", "background")],
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: "card facts value",
    where: "the facts list's own inset ground inside the dialog",
    fg: "--fg-mid", backdrop: ["--bg-island"], group: ["--bg-void"],
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: "card facts label",
    where: "the quieter column beside it",
    fg: "--fg-dim", backdrop: ["--bg-island"], group: ["--bg-void"],
    threshold: TEXT, sc: "1.4.3",
  },

  // --- the pull request diff drawer ---------------------------------------
  // Three grounds, not one: context sits on `--bg-void`, changed lines on a tinted
  // band, hunk headings on `--bg-inset`. A colour cleared on one of them says
  // nothing about the other two, and the drawer puts all three on screen at once.
  {
    what: "diff context text",
    where: "the unchanged lines, most of any diff",
    fg: "--fg-mid", backdrop: ["--bg-void"],
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: "diff added text",
    where: "code on the added band — brighter than context, which is the third channel",
    fg: "--fg", backdrop: ADDED_BAND,
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: "diff removed text",
    where: "code on the removed band",
    fg: "--fg", backdrop: REMOVED_BAND,
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: "+ marker",
    where: "a real text node in its own column — the only channel that survives forced colours",
    fg: "--st-working", backdrop: ADDED_BAND,
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: "- marker",
    where: "the same, on the removed band",
    fg: "--st-error", backdrop: REMOVED_BAND,
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: "line numbers, untinted gutter",
    where: "the gutter's own ground, which stays opaque so `position: sticky` works",
    fg: "--fg-dim", backdrop: ["--bg-void"],
    threshold: TEXT, sc: "1.4.3",
  },
  // These two were REJECTED cases until the palette moved: at the old `--fg-dim`
  // they measured 4.16 and 4.29, and that pair was the stated reason the band starts
  // at the marker column instead of at the frame. The raise to 5.05 on an island took
  // them to 5.25 and 5.51, so the reason expired and this script said so rather than
  // letting a stale justification stand.
  //
  // The decision did not change, because it never rested on this alone: the two
  // number cells are `position: sticky`, a sticky cell needs an opaque base, and a
  // translucent gutter shows the scrolling code through itself. That argument is
  // independent of any ratio. What changed is that the band is now survivable if
  // someone ever does move it — so these are asserted, as the margin, rather than
  // documented as a failure.
  {
    what: "--fg-dim on the added band",
    where: "the margin if the tint ever reaches the gutter — no longer the reason it does not",
    fg: "--fg-dim", backdrop: ADDED_BAND,
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: "--fg-dim on the removed band",
    where: "the same, and the better of the pair now",
    fg: "--fg-dim", backdrop: REMOVED_BAND,
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: "hunk heading",
    where: "the parsed `@@` line, on the raised band that segments the file",
    fg: "--fg-mid", backdrop: ["--bg-inset"],
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: "drawer header path",
    where: "the file path at the top of the drawer",
    fg: "--fg", backdrop: ["--bg-island"],
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: "drawer header meta",
    where: "the counts beside it — file 3 of 62, 24 added, 7 removed",
    fg: "--fg-dim", backdrop: ["--bg-island"],
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: "the open file row",
    where: "the row whose diff the drawer is showing — `--sel` over the row's own ground",
    fg: "--fg-mid", backdrop: ["--bg-inset", "--sel"],
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: "resize grip at rest",
    where: "a control, not text: it must be findable before it is used",
    fg: "--fg-dim", backdrop: ["--bg-island"],
    threshold: UI, sc: "1.4.11",
  },
  {
    what: "resize grip on hover/focus",
    where: "the focused state of the same control",
    fg: "--accent", backdrop: ["--bg-island"],
    threshold: UI, sc: "1.4.11",
  },

  // Three colours the drawer rejected, kept as cases rather than as a comment, and
  // marked `rejected` so they document the decision without failing the run. Each
  // one is a design constraint that reads as arbitrary the moment its number is
  // gone — and the number is the only part that a palette edit can invalidate. A
  // rejected case that starts *passing* stops the run too: the reason it was
  // rejected has expired and the decision above it is owed a second look. That is
  // not hypothetical — it is exactly what the Slate & Ember palette did to the two
  // diff-band rows, which have moved up into the asserted set.
  {
    what: "--fg-dim on the open file row", rejected: true,
    where: "rejected — why the whole file list is `--fg-mid`, selected row included",
    fg: "--fg-dim", backdrop: ["--bg-inset", "--sel"],
    threshold: TEXT, sc: "1.4.3",
  },
  {
    what: "--line-strong as the drawer seam", rejected: true,
    where: "rejected — no brighter border than the rest of the app has; the seam is not a control",
    fg: "--line-strong", backdrop: ["--bg-void"],
    threshold: UI, sc: "1.4.11",
  },
  {
    what: "added band against removed band", rejected: true,
    where: "rejected — tint alone cannot tell the two apart, which is why the marker is a character",
    fg: "--diff-add-weak", backdrop: ["--bg-void"], group: ["--diff-del-weak"],
    threshold: UI, sc: "1.4.11",
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
    const below = c.threshold > 0 && r < c.threshold;
    // A rejected case is expected to be below its threshold, so being below it is
    // not news and clearing it is.
    return { c, r, fg, bg, fails: below && !c.rejected, revived: c.rejected && !below };
  });

  const w = (key, min) => Math.max(min, ...rows.map((x) => String(key(x)).length));
  const wWhat = w((x) => x.c.what, 4);
  const wSc = w((x) => x.c.sc, 2);

  console.log(`\nComposited contrast — ${rows.length} cases, from src/styles.css and src/terminal.ts\n`);
  for (const t of fellBack) {
    console.log(`  note: ${t} is not in :root yet — measured against the literal above.`);
  }
  if (fellBack.length) console.log("");
  console.log(
    "  " + "case".padEnd(wWhat) + "  ratio   need   " + "SC".padEnd(wSc) + "  effective fg / bg",
  );
  console.log("  " + "-".repeat(wWhat + 20 + wSc + 20));
  for (const { c, r, fg, bg, fails, revived } of rows) {
    const need = c.threshold > 0 ? c.threshold.toFixed(1) : "  — ";
    const mark = fails ? "   <<< FAILS" : revived ? "   <<< NOW PASSES" : c.rejected ? "   (rejected)" : "";
    console.log(
      "  " + c.what.padEnd(wWhat) +
      "  " + r.toFixed(2).padStart(5) +
      "  " + need.padStart(5) +
      "  " + c.sc.padEnd(wSc) +
      "  " + hex(fg) + " on " + hex(bg) +
      mark,
    );
    console.log("  " + " ".repeat(wWhat) + "  " + c.where);
  }

  const failed = rows.filter((x) => x.fails);
  const revived = rows.filter((x) => x.revived);
  const rejected = rows.filter((x) => x.c.rejected);
  console.log("");
  if (failed.length === 0 && revived.length === 0) {
    const held = rows.length - rejected.length;
    console.log(`  every case with a threshold clears it (${held} measured).`);
    console.log(`  ${rejected.length} rejected case${rejected.length === 1 ? " stays" : "s stay"} below threshold, as documented.`);
    return 0;
  }
  if (failed.length) {
    console.log(`  ${failed.length} case${failed.length === 1 ? "" : "s"} below threshold:`);
    for (const { c, r } of failed) console.log(`    ${c.what} — ${r.toFixed(2)} against ${c.threshold}`);
  }
  for (const { c, r } of revived) {
    console.log(`  \`${c.what}\` now clears ${c.threshold} at ${r.toFixed(2)} — it was rejected for failing it.`);
    console.log(`    ${c.where}`);
    console.log("    That reason has expired. Re-decide it, then update or drop this case.");
  }
  return 1;
}

process.exit(main());

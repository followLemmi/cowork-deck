// The text-size preference.
//
// A multiplier rather than a pixel size, because two bases have to move together:
// the chrome's is `:root { font-size: 13px }` in styles.css, and xterm's own is
// 14px set from JS, since xterm owns its theme and reads no CSS token. One number
// scales both, where two pixel values would drift apart the moment either changed.
//
// This exists because the 13px base chosen in Phase 1 of the typography plan is a
// judgement, not a measurement — the whole point of putting the scale in `rem` was
// that the judgement could later be handed to the person using the app. It is also
// the only way to resize text here at all: this is a Tauri window, so there is no
// browser zoom to fall back on.

/** The base `styles.css` declares on `:root`. Must agree with it — a scale is a
 *  multiplier on this, so a disagreement makes every reported pixel size a lie. */
export const BASE_PX = 13;

/** xterm's own, set in `TerminalPanel`'s constructor. Deliberately larger than the
 *  chrome: the terminal is the content, the chrome is the frame. */
export const TERMINAL_BASE_PX = 14;

/** Coarse on purpose. A slider invites a person to hunt for a value; six steps
 *  make the choice a decision rather than a search, and every one of them was
 *  checked against the layout rather than being offered on the assumption that
 *  `rem` handles everything.
 *
 *  The ceiling is 1.45 and not 2.0, which is what SC 1.4.4 would ask for, and the
 *  honest reason is that a few boxes are still measured in pixels — the sidebar's
 *  `clamp()` is `rem` now because this control needs it to be, but the modal caps
 *  and the deck's grid minimums are not. Claiming 200% would be claiming something
 *  unmeasured. Raising the ceiling is the geometry sweep's job, not this file's. */
export const SCALE_STEPS = [0.85, 1, 1.15, 1.3, 1.45] as const;

/** **Not 1.** The 13px base is the size the app had when the owner called its type
 *  unpleasant, so shipping 1 as the default would have answered that complaint with
 *  a preference the complainant has to go and find. 1.15 puts the chrome at 14.95px
 *  and the terminal at 16px, and 1 is still one click away for anyone who wants the
 *  old density back — which is the whole reason the raise went into the scale rather
 *  than into `:root { font-size }`.
 *
 *  Must stay a member of `SCALE_STEPS`: `clampScale` returns it for a non-finite
 *  input, and an off-step value there gives `nextScale`/`prevScale` no index to move
 *  from. There is a test on exactly that. */
export const DEFAULT_SCALE = 1.15;

/** The scale in force. Module state, deliberately: `TerminalPanel`'s constructor
 *  needs the current value, and `Deck` builds panels from four places — threading
 *  it through each would put the same number in four signatures and leave a new
 *  call site free to forget it. Everything else in this file is pure and takes its
 *  input as an argument; only this pair touches the cache. */
let current: number = DEFAULT_SCALE;

export function currentScale(): number {
  return current;
}

/** Snap to the nearest step rather than clamping to the ends.
 *
 *  A value between steps has to land *on* one, or `nextScale`/`prevScale` have no
 *  index to move from and the buttons do nothing. That is not hypothetical: a
 *  hand-edited `ui_state.json`, a file written by a build whose step list has since
 *  changed, or a `0` from a JSON field that was never set all arrive here. */
export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return DEFAULT_SCALE;
  let best: number = SCALE_STEPS[0];
  for (const step of SCALE_STEPS) {
    if (Math.abs(step - scale) < Math.abs(best - scale)) best = step;
  }
  return best;
}

/** The next step up, or the current one when already at the top — saturating
 *  rather than wrapping, because a "larger" command that suddenly makes everything
 *  small reads as a bug. */
export function nextScale(scale: number): number {
  const i = SCALE_STEPS.indexOf(clampScale(scale) as (typeof SCALE_STEPS)[number]);
  return SCALE_STEPS[Math.min(i + 1, SCALE_STEPS.length - 1)];
}

export function prevScale(scale: number): number {
  const i = SCALE_STEPS.indexOf(clampScale(scale) as (typeof SCALE_STEPS)[number]);
  return SCALE_STEPS[Math.max(i - 1, 0)];
}

/** Root font size in px for a scale, rounded to two decimals.
 *
 *  Rounded because `13 * 1.15` is `14.949999999999999` in binary floating point,
 *  and that string ends up in an inline style where anyone inspecting the element
 *  has to read it. */
export function rootFontPx(scale: number): number {
  return Math.round(BASE_PX * clampScale(scale) * 100) / 100;
}

/** xterm's font size for a scale, **rounded to a whole pixel**.
 *
 *  The rounding is not cosmetic. xterm lays glyphs out on a character grid it
 *  measures from the font size, so a fractional size gives fractional cell
 *  dimensions and every glyph lands off the device pixel grid — the whole terminal
 *  goes soft. `14 * 1.15` is 16.1, which is exactly the case that would do it. */
export function terminalFontPx(scale: number): number {
  return Math.round(TERMINAL_BASE_PX * clampScale(scale));
}

/** What to show a person choosing. The percentage is the number they are picking;
 *  the pixels are what it means, and the plan's own complaint was about pixels. */
export function scaleLabel(scale: number): string {
  const s = clampScale(scale);
  const suffix = s === DEFAULT_SCALE ? " · default" : "";
  return `${Math.round(s * 100)}% · ${rootFontPx(s)}px${suffix}`;
}

/** Write the scale onto the document root, where every `rem` in the stylesheet
 *  resolves against it. Inline, so it outranks `:root { font-size }`. */
export function applyScale(scale: number, root: HTMLElement): void {
  current = clampScale(scale);
  root.style.fontSize = `${rootFontPx(current)}px`;
}

/** The event name terminals listen for. */
export const UI_SCALE_EVENT = "ui-scale";

/** Tell every live terminal its new font size.
 *
 *  A `window` event rather than a fan-out through `Deck`, and the reason is the
 *  test suite rather than taste: five test files hand-roll a `TerminalPanel` mock
 *  with a fixed list of methods, and every one of them would throw on a new method
 *  appearing in `Deck`'s call path. A listener costs one line in the panel and
 *  leaves all five untouched. It is also the shape the app already uses for
 *  `pill://count`.
 *
 *  The payload is pixels, not the scale: it is what xterm's option takes, so the
 *  panel needs to know nothing about scales. */
export function broadcastScale(scale: number, target: EventTarget = window): void {
  target.dispatchEvent(
    new CustomEvent<number>(UI_SCALE_EVENT, { detail: terminalFontPx(scale) }),
  );
}

// Icon set as one inline SVG sprite.
//
// Why a sprite and not the bundled Nerd Font, which does contain icon glyphs:
// Nerd Font is a merge of Font Awesome, Material, Octicons, Devicons and
// Codicons, each with its own grid, stroke weight and proportions. Picking
// eleven glyphs out of that reproduces exactly the mismatch this replaces,
// only in monochrome. It also forces every glyph to one advance width, which
// makes optical sizes drift, and `` in the source is unreadable and
// ungreppable.
//
// Why a sprite and not inline SVG strings: the session list is rebuilt through
// innerHTML on every poll, and a deck can hold a dozen tiles with four icons
// each. The sprite declares each shape once; an instance is two elements.
//
// Handwriting comes from the app's own icon (src-tauri/icons/icon-source.svg):
// round caps and joins, outline rather than fill, chevron as the recurring
// motif. Authored on a 16-unit grid with a 12-unit live area and 1.5 stroke,
// which matches the weight of 13px text at --fw-medium beside it.

const NS = "http://www.w3.org/2000/svg";

/** Geometry per icon: everything is stroked with currentColor unless it opts
 *  into a fill. Only one arrow shape exists — direction comes from a CSS
 *  rotation, so every chevron in the app opens at the same angle. */
const PATHS: Record<string, string> = {
  chevron: '<polyline points="6,4 10,8 6,12"/>',
  x: '<path d="M4.5 4.5 L11.5 11.5"/><path d="M11.5 4.5 L4.5 11.5"/>',
  trash: '<path d="M3.5 4.5 h9"/><path d="M6.25 4.5 V3 h3.5 v1.5"/>'
    + '<path d="M5 4.5 l.5 8.5 h5 l.5-8.5"/>',
  pencil: '<path d="M10.4 3.1 l2.5 2.5 -8 8 -3.2 .7 .7-3.2 z"/><path d="M9.2 4.3 l2.5 2.5"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 4.8 V8 l2.2 1.6"/>',
  // Same circle as `clock`, with a play triangle where the hands were: "the
  // same thing, but right now". Deliberately not a skip-forward glyph — a
  // manual run does not consume the upcoming scheduled one, and skip-forward
  // would say the opposite.
  "clock-play": '<circle cx="8" cy="8" r="5.5"/>'
    + '<path d="M6.5 5.4 l4 2.6 -4 2.6 z" fill="currentColor" stroke="none"/>',
  rotate: '<path d="M13.5 8 a5.5 5.5 0 1 1-1.9-4.2"/><path d="M13.5 2.8 V5.4 h-2.6"/>',
  eraser: '<path d="M2.8 11 l5.7-5.7 4 4 -2.3 2.3 H4.6 z"/><path d="M2.5 13.5 h11"/>',
  "git-branch": '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/>'
    + '<circle cx="11.5" cy="3.5" r="1.5"/><path d="M4.5 5 v6"/>'
    + '<path d="M11.5 5 v1.4 a2.6 2.6 0 0 1-2.6 2.6 H7.1 a2.6 2.6 0 0 0-2.6 2.6"/>',
  play: '<path d="M5.8 3.6 l7 4.4 -7 4.4 z" fill="currentColor" stroke="none"/>',
  plus: '<path d="M8 3.5 V12.5"/><path d="M3.5 8 H12.5"/>',

  // --- Scenario icons -----------------------------------------------------
  // Offered in the scenario form instead of free-text emoji. Same grid and
  // stroke as the service set, so a user's choice cannot reintroduce the
  // mismatch this whole set exists to remove.
  rocket: '<path d="M8 2.5 c2.4 1.8 3.4 4.2 3.2 7.2 l-3.2 2.3 -3.2-2.3 c-.2-3 .8-5.4 3.2-7.2 z"/>'
    + '<circle cx="8" cy="6.6" r="1.2"/><path d="M5.6 11.2 L4 13.5 l2.6-.7"/>'
    + '<path d="M10.4 11.2 L12 13.5 l-2.6-.7"/>',
  // A beetle needs body, head and six legs, and at 16px that is a smudge that
  // reads as a gear whichever way it is drawn. "Something is wrong" is the
  // meaning that was wanted, and a warning triangle says it unambiguously.
  alert: '<path d="M8 2.8 L14 13 H2 z"/><path d="M8 6.4 v3.1"/>'
    + '<circle cx="8" cy="11.4" r="0.75" fill="currentColor" stroke="none"/>',
  search: '<circle cx="7" cy="7" r="4"/><path d="M10 10 L13.5 13.5"/>',
  check: '<polyline points="3.5,8.5 6.5,11.5 12.5,4.5"/>',
  flask: '<path d="M6.5 2.5 v4 L3.2 12 a1 1 0 0 0 .9 1.5 h7.8 a1 1 0 0 0 .9-1.5 L9.5 6.5 v-4"/>'
    + '<path d="M5.8 2.5 h4.4"/><path d="M4.8 9.5 h6.4"/>',
  book: '<path d="M3 3.5 h4 a2 2 0 0 1 2 2 v8 a1.6 1.6 0 0 0-1.6-1.2 H3 z"/>'
    + '<path d="M13 3.5 H9 a2 2 0 0 0-2 2 v8 a1.6 1.6 0 0 1 1.6-1.2 H13 z"/>',
  // A broom is a handle plus a fan of bristles; at this size the fan reads as
  // a roof and the whole thing as a building. A terminal window is both
  // legible and closer to what these scenarios actually do.
  terminal: '<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/>'
    + '<polyline points="5,7 6.9,9 5,11"/><path d="M8.6 11 H11"/>',
  chart: '<path d="M2.5 13.5 H13.5"/><path d="M4.5 13.5 V9"/><path d="M8 13.5 V4.5"/>'
    + '<path d="M11.5 13.5 V7"/>',
  shield: '<path d="M8 2.5 l4.5 1.8 v3.6 c0 2.6-1.8 4.6-4.5 5.6 -2.7-1-4.5-3-4.5-5.6 V4.3 z"/>',
  wrench: '<path d="M10.8 2.8 a3.6 3.6 0 0 0-4.6 4.6 L2.8 10.8 a1.4 1.4 0 0 0 2 2 l3.4-3.4 '
    + 'a3.6 3.6 0 0 0 4.6-4.6 L11 6.6 9.4 5 z"/>',
  sparkle: '<path d="M8 2.5 l1.3 3.6 3.6 1.3 -3.6 1.3 -1.3 3.6 -1.3-3.6 -3.6-1.3 3.6-1.3 z"/>'
    + '<path d="M12.6 11 l.5 1.4 1.4.5 -1.4.5 -.5 1.4 -.5-1.4 -1.4-.5 1.4-.5 z"/>',
};

/** Icons offered as a scenario's mark. `play` is the default and comes from
 *  the service set. */
export const SCENARIO_ICONS = [
  "play", "rocket", "alert", "search", "check", "flask",
  "book", "terminal", "chart", "shield", "wrench", "sparkle",
] as const;

export const ICON_NAMES = Object.keys(PATHS);
export type IconName = keyof typeof PATHS & string;

const SPRITE_ID = "cowork-icon-sprite";

/** Put the sprite in the document once. Idempotent so a second call — from a
 *  test, or a future second window — cannot double the symbols. */
export function installSprite(root: ParentNode = document.body): void {
  if ((root as Element & { querySelector: typeof document.querySelector })
    .querySelector?.(`#${SPRITE_ID}`)) return;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("id", SPRITE_ID);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden");
  svg.innerHTML = ICON_NAMES.map((name) =>
    `<symbol id="i-${name}" viewBox="0 0 16 16">${PATHS[name]}</symbol>`).join("");
  root.appendChild(svg);
}

/** One icon instance. Decorative by definition — the accessible name belongs
 *  to the control around it, otherwise it would be announced twice. */
export function icon(name: IconName, size = 16): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

/** An icon-only button whose accessible name cannot be forgotten, because the
 *  label is a required parameter. `data-action` gives tests a hook that does
 *  not depend on glyph text — the old ones matched on textContent === "✕".
 *
 *  The label should name the object too ("Delete scenario Nightly review"), or
 *  five rows produce five buttons all called "Delete". */
export function iconButton(
  name: IconName,
  label: string,
  cls = "",
  size = 16,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `btn--icon ${cls}`.trim();
  b.dataset.action = name;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.append(icon(name, size));
  return b;
}

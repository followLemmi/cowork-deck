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
};

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
 *  The label should name the object too ("Удалить сценарий Ночной обзор"), or
 *  five rows produce five buttons all called "Удалить". */
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

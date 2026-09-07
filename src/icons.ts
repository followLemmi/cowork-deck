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

import markSource from "../src-tauri/icons/icon-source.svg?raw";

const NS = "http://www.w3.org/2000/svg";

/** Geometry per icon: everything is stroked with currentColor unless it opts
 *  into a fill. Only one arrow shape exists — direction comes from a CSS
 *  rotation, so every chevron in the app opens at the same angle. */
const PATHS: Record<string, string> = {
  chevron: '<polyline points="6,4 10,8 6,12"/>',
  x: '<path d="M4.5 4.5 L11.5 11.5"/><path d="M11.5 4.5 L4.5 11.5"/>',
  // The same window, with the arrow coming back in. Deliberately the mirror of
  // `detach` rather than a different idea: the two are one gesture in two
  // directions, and a person who has learned one has learned the other.
  attach: '<path d="M8.2 3.5 H4 a1.5 1.5 0 0 0-1.5 1.5 v7 a1.5 1.5 0 0 0 1.5 1.5 h7 '
    + 'a1.5 1.5 0 0 0 1.5-1.5 V7.8"/>'
    + '<path d="M8.4 7.6 H12.1 V3.9"/><path d="M13.5 2.5 L8.4 7.6"/>',
  // A window with one corner open and an arrow leaving through it: the shape
  // every desktop uses for "this opens somewhere else". The box is deliberately
  // the same rounded rectangle as `terminal` — what is being pulled out is a
  // window of this app, not a link to elsewhere.
  detach: '<path d="M8.2 3.5 H4 a1.5 1.5 0 0 0-1.5 1.5 v7 a1.5 1.5 0 0 0 1.5 1.5 h7 '
    + 'a1.5 1.5 0 0 0 1.5-1.5 V7.8"/>'
    + '<path d="M9.8 2.5 H13.5 V6.2"/><path d="M13.5 2.5 L8.4 7.6"/>',
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
  // Settings. Two rails and two knobs rather than a gear: at 16px a gear's teeth
  // collapse into a circle, and the same shape already has to read at 12px in the
  // tile heads.
  sliders: '<path d="M2.5 5.2 H13.5"/><path d="M2.5 10.8 H13.5"/>'
    + '<circle cx="6" cy="5.2" r="1.8"/><circle cx="10.4" cy="10.8" r="1.8"/>',

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
  // A project folder, for the empty deck: with no workspace there is nowhere for a
  // session to run, and that screen says so with the same outline hand as the rest.
  folder: '<path d="M2.5 5.2 a1.2 1.2 0 0 1 1.2-1.2 h2.5 l1.5 1.7 H12.3 a1.2 1.2 0 0 1 1.2 1.2 '
    + 'v4.9 a1.2 1.2 0 0 1-1.2 1.2 H3.7 a1.2 1.2 0 0 1-1.2-1.2 z"/>',
  shield: '<path d="M8 2.5 l4.5 1.8 v3.6 c0 2.6-1.8 4.6-4.5 5.6 -2.7-1-4.5-3-4.5-5.6 V4.3 z"/>',
  wrench: '<path d="M10.8 2.8 a3.6 3.6 0 0 0-4.6 4.6 L2.8 10.8 a1.4 1.4 0 0 0 2 2 l3.4-3.4 '
    + 'a3.6 3.6 0 0 0 4.6-4.6 L11 6.6 9.4 5 z"/>',
  sparkle: '<path d="M8 2.5 l1.3 3.6 3.6 1.3 -3.6 1.3 -1.3 3.6 -1.3-3.6 -3.6-1.3 3.6-1.3 z"/>'
    + '<path d="M12.6 11 l.5 1.4 1.4.5 -1.4.5 -.5 1.4 -.5-1.4 -1.4-.5 1.4-.5 z"/>',

  // --- The rail's five, and the panel's two -------------------------------
  // Authored on the same terms as everything above: 16-unit grid, ~12-unit live
  // area, 1.5 stroke, round caps, outline rather than fill. A rail of five icons
  // has to be legible at 17px with no label beside it, which is why none of these
  // is a scene: `list` is three rows with their bullets, `git-merge` is the side
  // line REJOINING the trunk (which is the whole difference from `git-branch`,
  // where it leaves), `bolt` is a scenario firing, and `columns` is the panel
  // taking the width.
  list: '<path d="M5.6 4.5 H13.5"/><path d="M5.6 8 H13.5"/><path d="M5.6 11.5 H13.5"/>'
    + '<circle cx="3" cy="4.5" r="0.9" fill="currentColor" stroke="none"/>'
    + '<circle cx="3" cy="8" r="0.9" fill="currentColor" stroke="none"/>'
    + '<circle cx="3" cy="11.5" r="0.9" fill="currentColor" stroke="none"/>',
  "git-merge": '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/>'
    + '<circle cx="11.5" cy="8" r="1.5"/><path d="M4.5 5 v6"/>'
    + '<path d="M10 8 H8.5 A4 4 0 0 1 4.5 5"/>',
  bolt: '<path d="M9 2 L4.4 9 H7.4 L6.6 14 L11.6 7 H8.4 z"/>',
  columns: '<rect x="2.5" y="3.5" width="3.2" height="9" rx="1"/>'
    + '<rect x="6.4" y="3.5" width="3.2" height="9" rx="1"/>'
    + '<rect x="10.3" y="3.5" width="3.2" height="9" rx="1"/>',

};

/** Icons offered as a scenario's mark. `play` is the default and comes from
 *  the service set. */
export const SCENARIO_ICONS = [
  "play", "rocket", "alert", "search", "check", "flask",
  "book", "terminal", "chart", "shield", "wrench", "sparkle",
] as const;

/* --- The AIs' own marks --------------------------------------------------
   The three logos, as their owners draw them, and NOT in this app's hand — which
   is the opposite of the rule everywhere above and is deliberate.

   `PATHS` is a house style: one grid, one stroke weight, one set of caps, so
   eleven icons read as one family. A logo has no business in that family. Its
   job is not to belong, it is to be RECOGNISED — a person finds Claude's dial by
   knowing the Claude mark, and a mark redrawn at 1.5px stroke on a 16-unit grid
   is a mark they have to learn a second time. So these come in whole, filled,
   on their own 24-unit grid.

   Traced from Simple Icons (simple-icons.org), whose icon files are CC0. That
   waives Simple Icons' own copyright and says nothing about the marks: each is
   its owner's trademark, used here to identify that owner's product and nothing
   else, which is what a limits dial is for. Vendored rather than depended on —
   three path strings do not earn a package, and a logo that changed under us on
   an `npm update` is worse than one we have to notice and update by hand.

   One path each, `fill-rule: evenodd` where a mark has a hole. They are drawn by
   `brandIcon`, not by `icon`: `.icon` sets `fill: none; stroke: currentColor`,
   which would render every one of these as nothing at all. */
const BRAND_PATHS: Record<string, string> = {
  /** Claude. `claude` in Simple Icons. */
  claude: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  /** OpenAI. `openai` in Simple Icons. */
  codex: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
  /** Google Gemini. `googlegemini` in Simple Icons. */
  gemini: "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
};

export const BRAND_NAMES = Object.keys(BRAND_PATHS);
export type BrandName = keyof typeof BRAND_PATHS & string;

/** Whether there is a logo for this provider. The registry is provider-agnostic
 *  (#308), so one can arrive that this file has never heard of — and it gets a
 *  house icon rather than a hole. */
export function hasBrand(name: string): name is BrandName {
  return name in BRAND_PATHS;
}

/** One logo instance. Decorative by definition — the accessible name belongs to
 *  the control around it, otherwise it would be announced twice. */
export function brandIcon(name: BrandName, size = 20): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "brand");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(NS, "use");
  use.setAttribute("href", `#b-${name}`);
  svg.append(use);
  return svg;
}

export const ICON_NAMES = Object.keys(PATHS);
export type IconName = keyof typeof PATHS & string;

/** The application's own icon, as the mark in the window's corner.
 *
 *  Read from the file the bundle icons are generated from rather than redrawn here: the
 *  corner of the window and the icon in the dock are the same product, and two copies of
 *  a mark drift. `?raw` because that is how this project reads a file it must not
 *  duplicate — `node:fs` does not typecheck under the narrowed `types`.
 *
 *  It is the icon **unchanged**, which is the point, and that has one consequence worth
 *  stating: its cursor block is `#61afef`, the accent from before the Slate & Ember pass.
 *  Hue belongs to state everywhere inside this window except here, where it is not a
 *  state but a logo. If that trade stops being worth it, the answer is to redraw
 *  `icon-source.svg` — not to draw something else in this corner.
 *
 *  What it cannot carry at 22px: the four tiles. Their lit/unlit fills are 16 % and 4.5 %
 *  alpha, which is a tint at 1024 px and nothing at 22. What survives, and what makes it
 *  recognisable, is the plate, the prompt chevron and that cursor. */

export function appMark(size = 22): SVGSVGElement {
  const doc = new DOMParser().parseFromString(markSource, "image/svg+xml");
  const svg = doc.documentElement as unknown as SVGSVGElement;
  svg.setAttribute("class", "mark-icon");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  // Decorative: the wordmark beside it is the accessible name of the app, and below
  // 960px `.mark-text` is hidden — so the label lives on `#mark` itself, not here.
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

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
  // Two viewBoxes in one sprite, which is the whole reason a symbol carries its
  // own: the house icons are drawn on 16 units and the logos on their owners' 24.
  svg.innerHTML = [
    ...ICON_NAMES.map((name) =>
      `<symbol id="i-${name}" viewBox="0 0 16 16">${PATHS[name]}</symbol>`),
    ...BRAND_NAMES.map((name) =>
      `<symbol id="b-${name}" viewBox="0 0 24 24"><path d="${BRAND_PATHS[name]}"/></symbol>`),
  ].join("");
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

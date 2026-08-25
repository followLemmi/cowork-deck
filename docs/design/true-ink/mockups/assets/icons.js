/* cowork-deck icon sprite — the mockups' copy of src/icons.ts.
 *
 * The first block is the app's existing geometry, verbatim, so a mockup cannot
 * quietly redraw an icon the product already ships. The second block is what the
 * new shell needs and the app does not have yet, authored on the same terms:
 * 16-unit grid, ~12-unit live area, 1.5 stroke, round caps and joins, outline
 * rather than fill, chevron as the recurring motif.
 *
 * No GitHub octocat: it is a trademark, and `user` + `git-branch` say "an account
 * and its branches" without borrowing one.
 */
const PATHS = {
  // --- Shipped in src/icons.ts -------------------------------------------
  chevron: '<polyline points="6,4 10,8 6,12"/>',
  x: '<path d="M4.5 4.5 L11.5 11.5"/><path d="M11.5 4.5 L4.5 11.5"/>',
  trash: '<path d="M3.5 4.5 h9"/><path d="M6.25 4.5 V3 h3.5 v1.5"/>'
    + '<path d="M5 4.5 l.5 8.5 h5 l.5-8.5"/>',
  pencil: '<path d="M10.4 3.1 l2.5 2.5 -8 8 -3.2 .7 .7-3.2 z"/><path d="M9.2 4.3 l2.5 2.5"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 4.8 V8 l2.2 1.6"/>',
  "clock-play": '<circle cx="8" cy="8" r="5.5"/>'
    + '<path d="M6.5 5.4 l4 2.6 -4 2.6 z" fill="currentColor" stroke="none"/>',
  rotate: '<path d="M13.5 8 a5.5 5.5 0 1 1-1.9-4.2"/><path d="M13.5 2.8 V5.4 h-2.6"/>',
  eraser: '<path d="M2.8 11 l5.7-5.7 4 4 -2.3 2.3 H4.6 z"/><path d="M2.5 13.5 h11"/>',
  "git-branch": '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/>'
    + '<circle cx="11.5" cy="3.5" r="1.5"/><path d="M4.5 5 v6"/>'
    + '<path d="M11.5 5 v1.4 a2.6 2.6 0 0 1-2.6 2.6 H7.1 a2.6 2.6 0 0 0-2.6 2.6"/>',
  play: '<path d="M5.8 3.6 l7 4.4 -7 4.4 z" fill="currentColor" stroke="none"/>',
  plus: '<path d="M8 3.5 V12.5"/><path d="M3.5 8 H12.5"/>',
  rocket: '<path d="M8 2.5 c2.4 1.8 3.4 4.2 3.2 7.2 l-3.2 2.3 -3.2-2.3 c-.2-3 .8-5.4 3.2-7.2 z"/>'
    + '<circle cx="8" cy="6.6" r="1.2"/><path d="M5.6 11.2 L4 13.5 l2.6-.7"/>'
    + '<path d="M10.4 11.2 L12 13.5 l-2.6-.7"/>',
  alert: '<path d="M8 2.8 L14 13 H2 z"/><path d="M8 6.4 v3.1"/>'
    + '<circle cx="8" cy="11.4" r="0.75" fill="currentColor" stroke="none"/>',
  search: '<circle cx="7" cy="7" r="4"/><path d="M10 10 L13.5 13.5"/>',
  check: '<polyline points="3.5,8.5 6.5,11.5 12.5,4.5"/>',
  flask: '<path d="M6.5 2.5 v4 L3.2 12 a1 1 0 0 0 .9 1.5 h7.8 a1 1 0 0 0 .9-1.5 L9.5 6.5 v-4"/>'
    + '<path d="M5.8 2.5 h4.4"/><path d="M4.8 9.5 h6.4"/>',
  book: '<path d="M3 3.5 h4 a2 2 0 0 1 2 2 v8 a1.6 1.6 0 0 0-1.6-1.2 H3 z"/>'
    + '<path d="M13 3.5 H9 a2 2 0 0 0-2 2 v8 a1.6 1.6 0 0 1 1.6-1.2 H13 z"/>',
  terminal: '<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/>'
    + '<polyline points="5,7 6.9,9 5,11"/><path d="M8.6 11 H11"/>',
  chart: '<path d="M2.5 13.5 H13.5"/><path d="M4.5 13.5 V9"/><path d="M8 13.5 V4.5"/>'
    + '<path d="M11.5 13.5 V7"/>',
  shield: '<path d="M8 2.5 l4.5 1.8 v3.6 c0 2.6-1.8 4.6-4.5 5.6 -2.7-1-4.5-3-4.5-5.6 V4.3 z"/>',
  wrench: '<path d="M10.8 2.8 a3.6 3.6 0 0 0-4.6 4.6 L2.8 10.8 a1.4 1.4 0 0 0 2 2 l3.4-3.4 '
    + 'a3.6 3.6 0 0 0 4.6-4.6 L11 6.6 9.4 5 z"/>',
  sparkle: '<path d="M8 2.5 l1.3 3.6 3.6 1.3 -3.6 1.3 -1.3 3.6 -1.3-3.6 -3.6-1.3 3.6-1.3 z"/>'
    + '<path d="M12.6 11 l.5 1.4 1.4.5 -1.4.5 -.5 1.4 -.5-1.4 -1.4-.5 1.4-.5 z"/>',

  // --- New, for the redesigned shell -------------------------------------
  // The wordmark: two stacked tiles, which is what a deck is.
  columns: '<rect x="2.5" y="3.5" width="3.2" height="9" rx="1"/>'
    + '<rect x="6.4" y="3.5" width="3.2" height="9" rx="1"/>'
    + '<rect x="10.3" y="3.5" width="3.2" height="9" rx="1"/>',
  list: '<path d="M5.6 4.5 H13.5"/><path d="M5.6 8 H13.5"/><path d="M5.6 11.5 H13.5"/>'
    + '<circle cx="3" cy="4.5" r="0.9" fill="currentColor" stroke="none"/>'
    + '<circle cx="3" cy="8" r="0.9" fill="currentColor" stroke="none"/>'
    + '<circle cx="3" cy="11.5" r="0.9" fill="currentColor" stroke="none"/>',
  // A merge, distinct from `git-branch`: the side line rejoins the trunk.
  "git-merge": '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/>'
    + '<circle cx="11.5" cy="8" r="1.5"/><path d="M4.5 5 v6"/>'
    + '<path d="M10 8 H8.5 A4 4 0 0 1 4.5 5"/>',
  external: '<path d="M12.5 9.6 v2.9 a1 1 0 0 1-1 1 H4.5 a1 1 0 0 1-1-1 v-7 a1 1 0 0 1 1-1 h2.9"/>'
    + '<polyline points="10,2.5 13.5,2.5 13.5,6"/><path d="M13.5 2.5 L8.6 7.4"/>',
  // A line that runs out of room and turns back: the diff drawer's wrap toggle.
  wrap: '<path d="M2.5 4.5 H13.5"/><path d="M2.5 8 H10.6 a2.45 2.45 0 0 1 0 4.9 H8.2"/>'
    + '<polyline points="9.6,11.3 8,12.9 9.6,14.4"/>',
  broadcast: '<circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none"/>'
    + '<path d="M5 11 a4.3 4.3 0 0 1 0-6"/><path d="M11 5 a4.3 4.3 0 0 1 0 6"/>'
    + '<path d="M3 13 a7.1 7.1 0 0 1 0-10"/><path d="M13 3 a7.1 7.1 0 0 1 0 10"/>',
  bell: '<path d="M4.6 11 V7.6 a3.4 3.4 0 0 1 6.8 0 V11 l1.1 1.6 H3.5 z"/>'
    + '<path d="M6.6 12.6 a1.5 1.5 0 0 0 2.8 0"/>',
  // Four corners opening outwards: zoom a tile to near-full.
  expand: '<polyline points="6,2.8 2.8,2.8 2.8,6"/><polyline points="10,2.8 13.2,2.8 13.2,6"/>'
    + '<polyline points="10,13.2 13.2,13.2 13.2,10"/><polyline points="6,13.2 2.8,13.2 2.8,10"/>',
  collapse: '<polyline points="2.8,6 6,6 6,2.8"/><polyline points="13.2,6 10,6 10,2.8"/>'
    + '<polyline points="13.2,10 10,10 10,13.2"/><polyline points="2.8,10 6,10 6,13.2"/>',
  folder: '<path d="M2.5 5.2 a1.2 1.2 0 0 1 1.2-1.2 h2.5 l1.5 1.7 H12.3 a1.2 1.2 0 0 1 1.2 1.2 '
    + 'v4.9 a1.2 1.2 0 0 1-1.2 1.2 H3.7 a1.2 1.2 0 0 1-1.2-1.2 z"/>',
  filter: '<path d="M2.8 3.5 H13.2 L9.2 8.4 V12.9 L6.8 11.5 V8.4 z"/>',
  // Two rails and two knobs: settings, and legible at 16px where a gear is not.
  sliders: '<path d="M2.5 5.2 H13.5"/><path d="M2.5 10.8 H13.5"/>'
    + '<circle cx="6" cy="5.2" r="1.8"/><circle cx="10.4" cy="10.8" r="1.8"/>',
  user: '<circle cx="8" cy="5.9" r="2.6"/><path d="M3.2 13.5 a4.8 4.8 0 0 1 9.6 0"/>',
  clear: '<path d="M2.5 8 H13.5"/><polyline points="6.5,4.5 3,8 6.5,11.5"/>',

  // --- Added for the "Slate & Ember II" pass ------------------------------
  // The appearance switch. Two glyphs rather than one that morphs: the control
  // shows the theme it will GIVE you, and a half-filled circle says neither.
  sun: '<circle cx="8" cy="8" r="3.1"/><path d="M8 1.8 V3"/><path d="M8 13 v1.2"/>'
    + '<path d="M1.8 8 H3"/><path d="M13 8 h1.2"/><path d="M3.6 3.6 l.9.9"/>'
    + '<path d="M11.5 11.5 l.9.9"/><path d="M12.4 3.6 l-.9.9"/><path d="M4.5 11.5 l-.9.9"/>',
  moon: '<path d="M13 9.6 A5.6 5.6 0 0 1 6.4 3 a5.6 5.6 0 1 0 6.6 6.6 z"/>',
  // Six dots: the one place in the app where a thing can be picked up and moved.
  grip: '<circle cx="6" cy="4" r="1" fill="currentColor" stroke="none"/>'
    + '<circle cx="10" cy="4" r="1" fill="currentColor" stroke="none"/>'
    + '<circle cx="6" cy="8" r="1" fill="currentColor" stroke="none"/>'
    + '<circle cx="10" cy="8" r="1" fill="currentColor" stroke="none"/>'
    + '<circle cx="6" cy="12" r="1" fill="currentColor" stroke="none"/>'
    + '<circle cx="10" cy="12" r="1" fill="currentColor" stroke="none"/>',
  // What a run left behind: the final assistant message.
  quote: '<path d="M2.8 4.2 h10.4 a1 1 0 0 1 1 1 v5 a1 1 0 0 1-1 1 H6.4 L3.4 13.6 V11.2'
    + ' h-.6 a1 1 0 0 1-1-1 v-5 a1 1 0 0 1 1-1 z"/>',
  // A schedule that fired without anybody asking it to.
  bolt: '<path d="M9 2 L4.4 9 H7.4 L6.6 14 L11.6 7 H8.4 z"/>',
};

const NS = "http://www.w3.org/2000/svg";
const SPRITE_ID = "cowork-icon-sprite";

/** Put the sprite in the document once. Idempotent, like the app's. */
function installSprite(root) {
  root = root || document.body;
  if (root.querySelector && root.querySelector("#" + SPRITE_ID)) return;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("id", SPRITE_ID);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden");
  svg.innerHTML = Object.keys(PATHS)
    .map((n) => `<symbol id="i-${n}" viewBox="0 0 16 16">${PATHS[n]}</symbol>`)
    .join("");
  root.appendChild(svg);
}

/* Icons are decorative by definition: the accessible name belongs to the control
 * around them, or a button announces its label twice. Every instance carries the
 * shared stroke settings, so an icon takes the colour of whatever holds it. */
function iconMarkup(name, cls) {
  return `<svg class="ic ${cls || ""}" aria-hidden="true" width="16" height="16"><use href="#i-${name}"/></svg>`;
}

/* The application's own icon, as the mark in the window's corner — the file
 * `src-tauri/icons/icon-source.svg` is generated from, copied here because a mockup has
 * no build step to read it with. It is the icon UNCHANGED, including the `#61afef` cursor
 * that predates this palette: in that corner it is a logo, not a state.
 * Hydrated separately from `[data-ic]` because the sprite's shared rule forces
 * `fill: none; stroke: currentColor`, which would erase every fill in it. */
const APP_MARK = '<rect x="72" y="72" width="880" height="880" rx="200" fill="#1d1f21"/> <rect x="72.5" y="72.5" width="879" height="879" rx="199.5" fill="none" stroke="rgba(255,255,255,.09)" stroke-width="3"/><g> <rect x="176" y="176" width="308" height="308" rx="44" fill="rgba(97,175,239,.16)"/> <rect x="540" y="176" width="308" height="308" rx="44" fill="rgba(255,255,255,.045)"/> <rect x="176" y="540" width="308" height="308" rx="44" fill="rgba(255,255,255,.045)"/> <rect x="540" y="540" width="308" height="308" rx="44" fill="rgba(255,255,255,.045)"/> </g><polyline points="398,392 556,512 398,632" fill="none" stroke="#e6e6e6" stroke-width="70" stroke-linecap="round" stroke-linejoin="round"/> <rect x="590" y="470" width="150" height="84" rx="20" fill="#61afef"/>';

function hydrateAppMark(root) {
  (root || document).querySelectorAll("[data-app-mark]").forEach((el) => {
    el.innerHTML = '<svg class="mark-icon" viewBox="0 0 1024 1024" width="22" height="22"'
      + ' aria-hidden="true">' + APP_MARK + '</svg>';
  });
}

/** Expand `<i data-ic="play"></i>` placeholders so the markup stays readable. */
function hydrateIcons(root) {
  (root || document).querySelectorAll("[data-ic]").forEach((el) => {
    el.outerHTML = iconMarkup(el.dataset.ic, el.className);
  });
}

/* Reachable from outside, because markup built after boot carries the same
 * `[data-ic]` placeholders and nothing else can expand them. `<use href>` resolves
 * its target once and does not re-resolve, which is why the sprite has to already
 * be in the document — it is, by the time anything can call this. */
window.hydrateDeckIcons = hydrateIcons;

/* Installed synchronously, not on DOMContentLoaded, and that is a correctness fix
 * rather than a speed one: `<use href="#i-x">` resolves its target once and does
 * NOT re-resolve when a matching id is added to the document later. Any icon an
 * inline script drew before the sprite landed would stay permanently blank. This
 * file is loaded at the end of <body>, so the DOM is already there. */
if (document.body) {
  installSprite();
  hydrateIcons();
  hydrateAppMark();
} else {
  document.addEventListener("DOMContentLoaded", () => { installSprite(); hydrateIcons(); hydrateAppMark(); });
}

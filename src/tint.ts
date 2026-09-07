/** The workspace tint: one colour carried down a whole group.
 *
 *  A workspace's colour is chosen in the workspace form and then spends its whole
 *  life as one 8px dot. This turns it into GROUND — a band under the workspace row
 *  and its sessions, at full strength on the row and gone by the last session — so
 *  that a tree of a dozen sessions across four workspaces reads as four objects
 *  instead of one undifferentiated column. `src/styles.css` paints it; this file
 *  decides how strong it is, which is the part that has to be arithmetic.
 *
 *  IT MUST NOT COMPETE WITH THE STATE RAIL. Hue in this app belongs to what a
 *  session is DOING — working, waiting, stopped — which is why the accent is
 *  deliberately near-achromatic (see the note over `--accent`). A tint strong
 *  enough to read as "colour" would put a second hue channel behind the one
 *  channel that means something. So the band is ground rather than fill, and
 *  `TINT_LUMA` is the whole of its strength: it lands *under* both row grounds
 *  already in play — `--sel` at roughly +16 and `--bg-hover` at +17 on the
 *  sidebar island — rather than beside them.
 *
 *  THE SIX SWATCHES MUST WEIGH THE SAME. The palette is green, amber, red, chalk,
 *  stone and slate (`src/forms.ts`), and three of those are a near-white to a
 *  mid-grey. At one fixed alpha chalk lifts the ground 1.6× as far as slate does,
 *  which is one workspace glaring and another invisible. So the alpha is SOLVED
 *  per colour rather than fixed — `workspaceTint` below — and the six bands come
 *  out within a few percent of each other. `npm run contrast` measures all six
 *  against the island they sit on and prints the six numbers side by side.
 *
 *  What that costs, and it is worth knowing before the palette is next touched:
 *  chalk, stone and slate differ from each other in LIGHTNESS and in nothing else,
 *  so normalising lightness makes their three bands identical. Three of the six
 *  workspaces therefore get the same neutral band. That is a property of the
 *  palette, not of this file — at a fixed alpha those three are within 1.6× of one
 *  another and still not tellable apart — and it is why the colour dot stays on
 *  the row: the dot is where the choice is legible at full saturation, and the
 *  band is wayfinding rather than a reading of which of six was picked.
 */

/** Rec. 709 luma, on the GAMMA-ENCODED bytes rather than on linear light, because
 *  that is the space CSS composites `rgba()` in: the byte a translucent layer
 *  lands on is `a·C + (1−a)·BG`, encoded throughout. Relative luminance — the
 *  linear-light measure `scripts/contrast.mjs` uses for WCAG ratios — is the right
 *  answer to a different question and the wrong one here. */
const LUMA = { r: 0.2126, g: 0.7152, b: 0.0722 };

/** How much luma of its OWN colour the band contributes, out of 255 — `a·luma(C)`,
 *  which is the quantity the solve below fixes. It is a shade more than the band
 *  lifts the ground by, because the alpha it buys also takes that share of the
 *  ground away again: on the sidebar island the six land at +8.5 to +9.1 rather
 *  than at +10. That gap is the ground term the solve drops on purpose, and it is
 *  small and even enough to be a rounding rather than a caveat.
 *
 *  Ten, and the number is a budget rather than a taste. The island is #161719,
 *  luma ~22.9; a hovered row lands at 40 and a selected one at ~38.5, so the two
 *  grounds that MEAN something are both about +16 off it. At +9 the band sits
 *  between the island and those two, just past the middle: clearly a band, never
 *  mistakable for a row that is selected or under the pointer. It is the PEAK
 *  rather than the average — full strength on the workspace row, fading to nothing
 *  by the last session — which is why it is not smaller.
 *
 *  It stops there for two reasons and both are measured. Every point of it is
 *  contrast taken off every caption, badge and state label sitting on the band;
 *  `npm run contrast` reports what is left, and `.state-error` on a selected row
 *  inside a tinted group is the floor. And a band much past this reads as
 *  `--bg-inset` at 40 — the ground a control sunk into an island paints — which
 *  would make a whole group look permanently hovered.
 *
 *  What it does NOT have to pay for any more is the hover step: `--bg-hover-soft`
 *  restates hover translucent inside a group, so a hovered row steps the same
 *  distance whether or not there is a band under it. That was the cost of the
 *  first version of this number, and it is a stylesheet's problem rather than an
 *  arithmetic one. */
export const TINT_LUMA = 10;

/** The alpha ceiling, for a colour dark enough that no sane alpha lifts anything.
 *  Nothing in the app's own palette comes near it — the six land between 0.041 and
 *  0.065 — but a workspace's colour is a free-form string on the record
 *  (`Workspace.color`), so the solve has to have a floor to stand on. */
const MAX_ALPHA = 0.25;

/** What `.ws-group` needs, as the two custom properties it carries. Split rather
 *  than handed over as one `rgba()` string because the stylesheet composes them:
 *  the channels go into `rgb(… / …)` and the alpha is the half a rule can scale or
 *  a group can be missing. */
export interface WorkspaceTint {
  /** Space-separated channels, for `rgb(var(--ws-tint) / …)`. */
  rgb: string;
  /** 0–`MAX_ALPHA`, solved so this band weighs what every other band weighs. */
  alpha: number;
}

/** `#rgb` or `#rrggbb`, which is what the workspace form writes. Anything else is
 *  a colour this cannot reason about, and a tint guessed from an unparsed string
 *  would be worse than no tint at all. */
function parseHex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** The band for one workspace colour, or `null` when the colour cannot be read —
 *  in which case the group renders untinted, which is what it did before this.
 *
 *  The solve is one line and this is the whole of it: a layer at alpha `a` lifts
 *  the encoded luma of what is under it by `a·(luma(C) − luma(BG))`, so exactly
 *  equal bands would be `a = LIFT / (luma(C) − luma(BG))`. What this solves is
 *  `a·luma(C) = TINT_LUMA`, with the ground term dropped. Keeping it would tie
 *  this file to whichever surface the tree happens to be rendered on — and the
 *  sidebar's island has moved once already — while buying almost nothing: across
 *  the six swatches, ignoring a ground of luma ~23 spreads the bands by 6%, which
 *  is under a tenth of the step between the tint and the selection it has to stay
 *  beneath. `tests/tint.test.ts` measures that spread rather than assuming it. */
export function workspaceTint(color: string): WorkspaceTint | null {
  const rgb = parseHex(color);
  if (!rgb) return null;
  const [r, g, b] = rgb;
  const luma = LUMA.r * r + LUMA.g * g + LUMA.b * b;
  if (luma <= 0) return null;
  const alpha = Math.min(MAX_ALPHA, TINT_LUMA / luma);
  return { rgb: `${r} ${g} ${b}`, alpha: Math.round(alpha * 1e4) / 1e4 };
}

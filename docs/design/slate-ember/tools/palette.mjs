// Slate & Ember — the palette, resolved and measured.
//
// Why a script rather than a table of hex values typed by hand: cowork-deck's own
// `scripts/contrast.mjs` can only parse `#rgb`, `#rrggbb` and `rgba()`, so the port
// needs resolved values — and a value nobody can re-derive is a value nobody can
// change. Every number in DESIGN.md comes out of here.
//
//   node tools/palette.mjs           # the table
//   node tools/palette.mjs --css     # the :root block
//
// The tokens are authored in OKLch because that is where "one step lighter" is a
// single number; sRGB hex is the output, not the source.

const OK = (L, C, H) => ({ L, C, H });

// --- Tokens ---------------------------------------------------------------
// Grounds carry a WARM cast (hue ~70) on purpose. Every default dark theme —
// One Dark included, and every AI-generated one — casts blue-violet; a warm
// graphite is the cheapest way for this app to stop looking like a template.
const TOKENS = {
  // The ladder is spaced by what has to be *distinguishable*, not by even steps.
  // `bg-inset` sits 0.065 above `bg-island` because a field is recognised by its
  // fill (see REJECTED) — at the 0.04 this started with, the step measured 1.12 and
  // the claim was false.
  "bg-void":     OK(0.160, 0.006, 70),  // the chrome's ground: top bar, sidebar, behind islands
  "bg-chrome":   OK(0.195, 0.006, 70),  // top bar / sidebar surface
  "bg-island":   OK(0.235, 0.007, 70),  // the raised content surface
  "bg-inset":    OK(0.300, 0.008, 70),  // fields and controls sunk into an island
  "bg-terminal": OK(0.178, 0.005, 70),  // terminal body — below the island it sits in

  // Hover moves the GROUND, never the ink — the one rule the old stylesheet's
  // `opacity: 0.7` icon buttons broke, at a measured 2.67:1. Each is +0.065 on L
  // from the surface it covers, inside the 0.06–0.12 band that reads as a change
  // without reading as a different component.
  "bg-hover":    OK(0.300, 0.008, 70),  // a row on an island (== bg-inset by design)
  "bg-hover-2":  OK(0.365, 0.008, 70),  // a control already sitting on bg-inset

  "line":        OK(0.335, 0.008, 70),  // the hairline
  "line-strong": OK(0.435, 0.010, 70),  // a field's edge, a seam that must be seen

  "fg":          OK(0.945, 0.006, 80),  // ink
  "fg-mid":      OK(0.780, 0.008, 80),  // secondary text, paths, meta that must read
  // 0.675 and not the 0.64 this started at: with `bg-inset` raised to carry the fill
  // step above, `fg-dim` measured 4.05 on it — a placeholder under AA inside every
  // field in the app. Raising the quietest step is also the direct answer to "мелкие
  // шрифты, невнятно": the old `--fg-subtle` carried nine meanings at 3.44.
  "fg-dim":      OK(0.675, 0.010, 80),  // captions, gutters, the quietest legible step

  // The accent is deliberately near-achromatic. In an app whose whole job is
  // telling you the state of N concurrent sessions, hue is a scarce resource and
  // it belongs to state. Selection, focus and the primary action get LIGHT.
  "accent":      OK(0.925, 0.025, 225),
  // A solid light button inverts nothing on hover; it steps its own fill DOWN, and
  // the dark ink on it stays put. Both halves in one rule, per the states contract.
  "accent-press": OK(0.860, 0.028, 225),

  // Hue, therefore, means exactly one thing: what a session is doing.
  "st-working":  OK(0.800, 0.150, 145),
  "st-waiting":  OK(0.845, 0.150, 92),
  "st-error":    OK(0.740, 0.150, 25),
  // `ended` deliberately has NO hue. The old palette spent a cyan on it; ended is
  // the absence of a signal, not a signal, and a fifth hue on the screen made the
  // four that matter harder to separate.
  //
  // It is `fg-mid`, not `fg-dim`, and that correction came out of the port rather
  // than out of this file — which is the reason it now has a token and a pair at
  // all. A state chip paints its own translucent fill, so it lightens the ground it
  // is read on; at `fg-dim` the ended chip on a selected row measured 3.62. A
  // caption can be raised one step by a rule, but a chip's colour IS the chip.
  "st-ended":    OK(0.780, 0.008, 80),
};

// --- OKLch -> sRGB --------------------------------------------------------
function oklchToLinear({ L, C, H }) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}
const encode = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

function hex(tok) {
  const [r, g, b] = oklchToLinear(tok).map((c) => clamp01(encode(clamp01(c))));
  const h2 = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${h2(r)}${h2(g)}${h2(b)}`;
}

// --- WCAG ----------------------------------------------------------------
const srgb = (h) => {
  const n = h.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
};
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (h) => {
  const [r, g, b] = srgb(h).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** A translucent fg over an opaque ground, composited before it is measured —
 *  the whole reason the old `--st-error` failed on the selected row. */
const over = (fg, bg, alpha) => {
  const [f, b] = [srgb(fg), srgb(bg)];
  const c = f.map((v, i) => v * alpha + b[i] * (1 - alpha));
  const h2 = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${h2(c[0])}${h2(c[1])}${h2(c[2])}`;
};

const H = Object.fromEntries(Object.entries(TOKENS).map(([k, v]) => [k, hex(v)]));

// The composites a token is actually read on. `--sel` is the selected-row ground;
// the diff bands sit on the terminal ground, not on the island.
//
// 0.10 and not the 0.14 the old `--accent-weak` used, and the reason is the reason
// that token's own comment gives for the state chips: a translucent fill drags the
// ground towards the fill's colour, and this accent is nearly white — so every point
// of alpha here is contrast taken off every caption sitting on a selected row. At
// 0.14 `fg-dim` measured 3.44 on it. 0.10 plus the one-step rule below is what makes
// a selected row readable rather than merely visible.
const SEL_ALPHA = 0.10;
H["sel"] = over(H.accent, H["bg-island"], SEL_ALPHA);
H["sel-chrome"] = over(H.accent, H["bg-chrome"], SEL_ALPHA);
// The selected ground, hovered. It exists because of a control that had no hover
// state at all: `.filter[aria-pressed="true"]` and `.filter:hover` carry the same
// specificity, so the pressed rule — written later — simply won this cascade, and
// pressing an active label chip is the ONLY way to clear that filter. A live
// control with no hover feedback reads as a label.
//
// 0.18 is the alpha that lands the step inside the 0.06–0.12 OKLab-L band the rest
// of the hover set uses: +0.071 over `--bg-void`, +0.064 over `--bg-island`. Both
// grounds are measured because a filter bar sits on the SCREEN (void) on the board
// and on an island in the specimen sheet, and `--sel` is translucent — it takes
// whatever is behind it.
const SEL_HOVER_ALPHA = 0.18;
H["sel-void"] = over(H.accent, H["bg-void"], SEL_ALPHA);
H["sel-hover"] = over(H.accent, H["bg-island"], SEL_HOVER_ALPHA);
H["sel-hover-void"] = over(H.accent, H["bg-void"], SEL_HOVER_ALPHA);
H["diff-add"] = over(H["st-working"], H["bg-terminal"], 0.13);
H["diff-del"] = over(H["st-error"], H["bg-terminal"], 0.13);
H["chip-working"] = over(H["st-working"], H["bg-island"], 0.14);
H["chip-waiting"] = over(H["st-waiting"], H["bg-island"], 0.16);
H["chip-error"] = over(H["st-error"], H["bg-island"], 0.06);
// The chips as they are actually read: on a SELECTED row, which is the worst ground
// and the one the eye is already on. Measuring them only on a resting island is how
// the ended chip shipped at 3.62 and the error chip at 4.31.
// The banner ground, which is twice the chip's alpha on purpose: a chip's text shares its
// fill's hue, so alpha there is contrast spent, while a banner carries `--fg`.
H["error-soft"] = over(H["st-error"], H["bg-island"], 0.12);
H["chip-error-sel"] = over(H["st-error"], H["sel"], 0.06);
H["chip-ended-sel"] = over(H["st-ended"], H["sel"], 0.10);
H["chip-working-sel"] = over(H["st-working"], H["sel"], 0.14);
H["chip-waiting-sel"] = over(H["st-waiting"], H["sel"], 0.16);

// --- The pairs that have to hold -----------------------------------------
// Threshold 4.5 for text, 3.0 for icons/borders/large text. A pair listed here is
// a pair the design asserts; anything not listed is not claimed.
const PAIRS = [
  ["fg", "bg-void", 4.5], ["fg", "bg-chrome", 4.5], ["fg", "bg-island", 4.5],
  ["fg", "bg-inset", 4.5], ["fg", "bg-terminal", 4.5], ["fg", "sel", 4.5],
  ["fg-mid", "bg-void", 4.5], ["fg-mid", "bg-chrome", 4.5], ["fg-mid", "bg-island", 4.5],
  ["fg-mid", "bg-inset", 4.5], ["fg-mid", "bg-terminal", 4.5], ["fg-mid", "sel", 4.5],
  ["fg-dim", "bg-void", 4.5], ["fg-dim", "bg-chrome", 4.5], ["fg-dim", "bg-island", 4.5],
  ["fg-dim", "bg-inset", 4.5], ["fg-dim", "bg-terminal", 4.5],
  // A selected row raises its captions one step — see REJECTED below.
  ["fg-mid", "sel-chrome", 4.5],
  ["accent", "bg-void", 4.5], ["accent", "bg-island", 4.5], ["accent", "bg-chrome", 4.5],
  // The primary button: dark ink on the light accent fill.
  ["bg-void", "accent", 4.5],
  ["st-working", "bg-island", 4.5], ["st-working", "chip-working", 4.5],
  ["st-working", "bg-terminal", 4.5], ["st-working", "diff-add", 4.5],
  ["st-waiting", "bg-island", 4.5], ["st-waiting", "chip-waiting", 4.5],
  ["st-waiting", "bg-terminal", 4.5], ["st-waiting", "sel", 4.5],
  ["st-error", "bg-island", 4.5], ["st-error", "chip-error", 4.5],
  // Every chip on the selected row. `--st-error`'s fill had to come down to 0.06 to
  // clear this one: the fill's hue is the text's hue, so alpha is contrast spent.
  ["st-error", "chip-error-sel", 4.5], ["st-ended", "chip-ended-sel", 4.5],
  ["st-working", "chip-working-sel", 4.5], ["st-waiting", "chip-waiting-sel", 4.5],
  ["st-ended", "bg-island", 4.5],
  ["st-error", "bg-terminal", 4.5], ["st-error", "diff-del", 4.5], ["st-error", "sel", 4.5],
  // Changed code is brighter than context, and it is read ON the band.
  ["fg", "diff-add", 4.5], ["fg", "diff-del", 4.5],
  // The line-number gutter. It keeps the untinted terminal ground because a sticky
  // cell needs an opaque base — a translucent gutter shows the scrolling code through
  // itself — but it is asserted on the bands too, as the margin for the day someone
  // moves the tint. The current stylesheet could not make this claim: at its
  // `--fg-subtle` the same two pairs measured 4.16 and 4.29.
  ["fg-dim", "bg-terminal", 4.5],
  ["fg-dim", "diff-add", 4.5], ["fg-dim", "diff-del", 4.5],
  // Non-text. A field is recognised by its FILL, so that step is the assertion; the
  // rail and the focus ring are components and owe 3.0.
  ["bg-inset", "bg-island", 1.2], ["bg-hover-2", "bg-inset", 1.2],
  ["fg-mid", "bg-hover-2", 4.5], ["bg-void", "accent-press", 4.5],
  ["line", "bg-island", 1.15], ["line", "bg-void", 1.15],
  // A pressed filter, hovered. The label is `--fg` on both grounds; the step itself
  // is asserted against the resting selected ground, because a hover nobody can see
  // is the defect this token was added to fix.
  ["fg", "sel-hover", 4.5], ["fg", "sel-hover-void", 4.5],
  ["sel-hover", "sel", 1.15], ["sel-hover-void", "sel-void", 1.15],
  // The broken-card banner in the task dialog: body text, and the icon-free kind, so the
  // text threshold is the whole of it.
  ["fg", "error-soft", 4.5], ["st-error", "error-soft", 4.5],
  ["st-working", "bg-void", 3.0], ["st-waiting", "bg-void", 3.0], ["st-error", "bg-void", 3.0],
  ["fg-dim", "bg-void", 3.0],
  ["accent", "bg-island", 3.0],
];

// --- Knowingly not met ----------------------------------------------------
// A design that lists only its passes is a design that has not been checked. Each
// entry names the pair, its measured ratio, and why the answer is a rule elsewhere
// rather than a different colour.
// The prose carries no ratios: they are measured and printed beside it, so a token
// change cannot leave a stale number behind in a justification. The `also` column
// names the pair that carries the requirement instead.
const REJECTED = [
  ["fg-dim", "sel", "fg-mid on sel",
    "The dimmest ink on a selected row's lightened ground. The answer is a rule rather " +
    "than a token: `.is-selected` raises its captions one step to `fg-mid`. Lowering " +
    "the selection alpha far enough to rescue `fg-dim` would make selection invisible."],
  ["line-strong", "bg-inset", "bg-inset on bg-island",
    "A field's border against the field's own fill, which is not the pair that decides " +
    "anything. On a dark theme a border at 3.0 against its surroundings is near-white " +
    "and reads as broken, so SC 1.4.11 is carried by the fill step plus the 2px focus " +
    "ring. Carried over from the current stylesheet, which documents the same deviation."],
];

if (process.argv.includes("--css")) {
  const out = Object.entries(TOKENS)
    .map(([k, v]) => `  --${k}: ${hex(v)}; /* oklch(${v.L} ${v.C} ${v.H}) */`)
    .join("\n");
  console.log(`:root {\n${out}\n}`);
} else {
  console.log("TOKEN                RESOLVED");
  for (const [k, v] of Object.entries(TOKENS)) {
    console.log(`  ${k.padEnd(18)} ${hex(v)}  oklch(${v.L} ${v.C} ${v.H})`);
  }
  console.log("\nCOMPOSITES");
  for (const k of ["sel", "sel-chrome", "chip-working", "chip-waiting", "chip-error", "diff-add", "diff-del"]) {
    console.log(`  ${k.padEnd(18)} ${H[k]}`);
  }
  console.log("\nPAIR                                    RATIO  MIN   ");
  let failed = 0;
  for (const [fg, bg, min] of PAIRS) {
    const r = ratio(H[fg], H[bg]);
    const ok = r >= min;
    if (!ok) failed++;
    console.log(
      `  ${(fg + " on " + bg).padEnd(36)} ${r.toFixed(2).padStart(6)}  ${min.toFixed(1)}  ${ok ? "ok" : "FAIL"}`,
    );
  }
  console.log("\nKNOWINGLY NOT MET");
  for (const [fg, bg, instead, why] of REJECTED) {
    const [iFg, iBg] = instead.split(" on ");
    console.log(
      `  ${fg} on ${bg} — ${ratio(H[fg], H[bg]).toFixed(2)}`
      + `  (carried by ${instead} at ${ratio(H[iFg], H[iBg]).toFixed(2)})`
      + `\n    ${why.replace(/(.{84})\s/g, "$1\n    ")}`,
    );
  }
  console.log(`\n${PAIRS.length - failed}/${PAIRS.length} asserted pairs pass, ${REJECTED.length} documented deviations.`);
  if (failed) process.exitCode = 1;
}

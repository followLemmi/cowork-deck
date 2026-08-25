/* The palette directions for cowork-deck, authored in OKLch and resolved to sRGB.
 *
 *     node docs/design/true-ink/tools/palette.mjs           every direction, as a table
 *     node docs/design/true-ink/tools/palette.mjs --app     the app's :root block
 *     node docs/design/true-ink/tools/palette.mjs --base    the mockups' three blocks
 *     node docs/design/true-ink/tools/palette.mjs --css     the candidate [data-palette] blocks
 *     node docs/design/true-ink/tools/palette.mjs graphite  one direction
 *
 * `--app` is the mode this repository uses: it prints the block that stands in
 * `src/styles.css`, under the APP's token names, which are not all the mockups'
 * names. Where the two disagree the mapping is in the emitter below and in this
 * pass's README, in one place each — a name translated by hand twice is a name
 * that will be translated differently the second time.
 *
 * Why OKLch and not hex: a surface ladder has to be spaced by PERCEIVED
 * lightness or the steps are uneven in a way nobody can name — and "one step
 * lighter, same hue" is a sentence you can only write in a perceptual space.
 * The output is hex and rgba() because `contrast.mjs` parses those two forms and
 * nothing else, and a colour that script cannot read is a colour nobody can
 * check.
 *
 * Four rules hold across every direction, carried over from the shipped system:
 *   · HUE BELONGS TO STATE. green / amber / red mean working / needs-you /
 *     broken; `ended` is hueless. No direction may spend those three hues on
 *     anything else, which is why no direction's ground sits near 145, 92 or 25.
 *   · The accent is the app's ONE colour, and it is used for selection, focus
 *     and the primary action — never for decoration.
 *   · The primary button is an INVERTED fill, so the accent must carry the
 *     opposite ink at 4.5:1 in both themes.
 *   · The terminal ground belongs to the app (it is our surface); the ANSI
 *     colours inside it belong to `claude` and are not ours to relight.
 *
 * `ember` is here as the incumbent, for comparison only — its shipped values are
 * the hand-tuned ones in `deck-ui.css`, and this file reproduces them to within
 * one unit per channel. It is deliberately NOT emitted into the generated CSS:
 * two sources for one palette is how a design system starts disagreeing with
 * itself.
 */

/* ---------- OKLch → sRGB -------------------------------------------------- */
const cbrt = (x) => Math.cbrt(x);
function oklch(L, C, H) {
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lin = [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  return lin.map((v) => {
    const g = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.abs(v) ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(g * 255)));
  });
}
const hex = (L, C, H) => "#" + oklch(L, C, H).map((v) => v.toString(16).padStart(2, "0")).join("");
const rgba = (L, C, H, a) => `rgba(${oklch(L, C, H).join(", ")}, ${a})`;

/* ---------- The directions ----------------------------------------------- */
/* `g` is the ground ladder, `i` the ink ladder, both as OKLch L values. Chroma
   and hue are per-direction and per-role, because a ground carrying a cast and
   ink carrying the same cast at the same chroma reads as a colour wash. */
const DIRECTIONS = [
  {
    id: "ember", ru: "Уголь", en: "Slate & Ember",
    note: "Действующая. Тёплый графит (hue 70) — самый дешёвый способ не выглядеть как дефолтная тёмная тема, но тёплое серое многие читают как коричневое.",
    hue: 70, cG: 0.007, hueI: 80, cI: 0.008,
    dark: { void: 0.160, chrome: 0.195, island: 0.235, inset: 0.300, hover2: 0.365, code: 0.172, term: 0.178, line: 0.335, lineS: 0.435, fg: 0.945, mid: 0.780, dim: 0.675 },
    light: { void: 0.930, chrome: 0.905, island: 0.995, inset: 0.950, hover: 0.955, hover2: 0.912, code: 0.972, line: 0.870, lineS: 0.740, fg: 0.215, mid: 0.395, dim: 0.470 },
    accent: { dark: [0.925, 0.025, 225], darkPress: [0.860, 0.028, 225], light: [0.330, 0.045, 225], lightPress: [0.265, 0.048, 225] },
  },
  {
    id: "graphite", ru: "Графит", en: "Graphite",
    note: "Нейтральный холодный графит, почти без хромы. Хром исчезает: единственное цветное на экране — вывод программы и состояние сессии. Ответ в духе Zed и Xcode.",
    hue: 265, cG: 0.004, hueI: 265, cI: 0.005,
    dark: { void: 0.170, chrome: 0.205, island: 0.245, inset: 0.310, hover2: 0.375, code: 0.182, term: 0.188, line: 0.342, lineS: 0.442, fg: 0.950, mid: 0.785, dim: 0.690 },
    light: { void: 0.932, chrome: 0.907, island: 0.997, inset: 0.952, hover: 0.957, hover2: 0.914, code: 0.974, line: 0.872, lineS: 0.742, fg: 0.215, mid: 0.395, dim: 0.470 },
    accent: { dark: [0.935, 0.012, 250], darkPress: [0.870, 0.014, 250], light: [0.320, 0.020, 250], lightPress: [0.255, 0.022, 250] },
  },
  {
    id: "ink", ru: "Тушь", en: "True Ink",
    note: "Почти чёрная сцена, высота делается исключительно светлотой. На деке из терминалов это даёт самую сильную разницу между «сценой» и «содержимым»: плитки читаются как объекты, лежащие на пустоте.",
    hue: 265, cG: 0.003, hueI: 265, cI: 0.004,
    /* A drop shadow on a near-black ground is a declaration that does nothing:
       --bg-void resolves to #040405, so there are four units of room below it and
       no amount of black can use them. This direction therefore spends its
       elevation where the room actually is — the lightness step between void and
       island is 0.097, twice what the other four use — and pays for the edge with
       a brighter lit hairline instead of a shadow it cannot cast. The large cast
       shadow survives only on --sh-2, where the thing underneath it is the
       scrim rather than the void. */
    elev: {
      edge: "inset 0 1px 0 rgba(255, 255, 255, 0.075)",
      sh1: "0 1px 2px rgba(0, 0, 0, 0.55)",
      sh2: "0 1px 3px rgba(0, 0, 0, 0.6), 0 26px 64px -20px rgba(0, 0, 0, 0.95)",
      scrimA: 0.74,
    },
    dark: { void: 0.108, chrome: 0.152, island: 0.205, inset: 0.278, hover2: 0.345, code: 0.138, term: 0.145, line: 0.300, lineS: 0.412, fg: 0.975, mid: 0.790, dim: 0.692 },
    light: { void: 0.940, chrome: 0.912, island: 1.000, inset: 0.958, hover: 0.962, hover2: 0.920, code: 0.978, line: 0.876, lineS: 0.744, fg: 0.190, mid: 0.390, dim: 0.470 },
    accent: { dark: [0.975, 0.003, 265], darkPress: [0.900, 0.004, 265], light: [0.240, 0.006, 265], lightPress: [0.180, 0.006, 265] },
  },
  {
    id: "steel", ru: "Сталь", en: "Blue Steel",
    note: "Холодный синеватый графит с настоящим синим акцентом. У приложения появляется свой цвет — и это не цвет состояния, потому что синий не занят ни одним из четырёх сигналов.",
    hue: 255, cG: 0.014, hueI: 255, cI: 0.012,
    dark: { void: 0.170, chrome: 0.206, island: 0.248, inset: 0.315, hover2: 0.380, code: 0.184, term: 0.190, line: 0.346, lineS: 0.446, fg: 0.948, mid: 0.784, dim: 0.690 },
    light: { void: 0.930, chrome: 0.905, island: 0.996, inset: 0.951, hover: 0.956, hover2: 0.913, code: 0.973, line: 0.870, lineS: 0.740, fg: 0.215, mid: 0.392, dim: 0.468 },
    accent: { dark: [0.840, 0.085, 250], darkPress: [0.775, 0.090, 250], light: [0.400, 0.115, 253], lightPress: [0.335, 0.115, 253] },
  },
  {
    id: "petrol", ru: "Глубина", en: "Deep Petrol",
    note: "Тёмное, которое действительно читается как цвет, а не как «не белое». Ближе к прибору, чем к редактору, и ни один дефолт этим не занят — поэтому меньше всего похоже на сгенерированную тему.",
    hue: 208, cG: 0.016, hueI: 205, cI: 0.013,
    dark: { void: 0.178, chrome: 0.210, island: 0.250, inset: 0.315, hover2: 0.380, code: 0.190, term: 0.196, line: 0.345, lineS: 0.445, fg: 0.946, mid: 0.782, dim: 0.690 },
    light: { void: 0.928, chrome: 0.902, island: 0.995, inset: 0.949, hover: 0.954, hover2: 0.910, code: 0.971, line: 0.868, lineS: 0.738, fg: 0.212, mid: 0.390, dim: 0.466 },
    accent: { dark: [0.930, 0.032, 200], darkPress: [0.865, 0.035, 200], light: [0.320, 0.058, 205], lightPress: [0.255, 0.060, 205] },
  },
];

/* State, one specification for every direction. The three hues are anchors, not
   preferences: they are what green / amber / red mean here, and a direction that
   moved them would be a different signal system wearing the same words. */
const ST = {
  dark: { working: [0.800, 0.150, 145], waiting: [0.845, 0.150, 92], error: [0.740, 0.150, 25] },
  /* Light-mode state is darker AND less chromatic than its dark counterpart. At
     the chroma the dark set uses, L 0.45 leaves the gamut and clips to something
     close to a primary — a green that reads as "web link green" rather than as
     the same signal seen on paper. */
  light: { working: [0.442, 0.100, 150], waiting: [0.448, 0.090, 85], error: [0.426, 0.128, 27] },
};
/* The error chip's fill is the one alpha in the system that is a contrast budget
   rather than a taste: its ground is the same hue as its text, so every point
   spent there is taken directly off the pair being measured. 0.06 is what the
   selected-row composite will carry across all five directions; the banner, which
   holds --fg rather than --st-error, can afford twice as much. */
const ALPHA = { working: 0.14, waiting: 0.16, error: 0.06, ended: 0.10, diff: 0.13, soft: 0.12 };

/* A ground's chroma has nowhere to go as L approaches 1: at L 0.995 even 0.02 of
   chroma leaves the sRGB gamut and clips to a channel maximum, which is how a
   "faint teal" light theme ends up with a cyan-white island. So chroma is capped
   by the headroom that is actually left — and in light mode halved first, because
   a cast that reads as a whisper on a dark ground reads as a wash on a pale one.
   This is the rule the hand-authored light theme was following by eye. */
function taper(c, L, mode) {
  const base = mode === "light" ? c * 0.5 : c;
  return Math.min(base, (1 - L) * 0.35);
}
function tokens(d, mode) {
  const s = d[mode], st = ST[mode];
  const G = (L, c = d.cG) => hex(L, taper(c, L, mode), d.hue);
  const I = (L, c = d.cI) => hex(L, taper(c, L, mode), d.hueI);
  const acc = mode === "dark" ? d.accent.dark : d.accent.light;
  const accP = mode === "dark" ? d.accent.darkPress : d.accent.lightPress;
  const accInk = mode === "dark" ? s.void : s.island;
  /* The selection tint is specified by the LIFT it has to produce, not by a
     fixed alpha: 10% of a near-white accent raises the ground far more than 10%
     of a pale cyan one, and that lift is paid for by every chip sitting on a
     selected row — the error chip carries text of its own hue, so there every
     point of alpha is contrast spent. A brighter accent therefore gets less. */
  const accL = acc[0];
  const a0 = mode === "dark" ? (accL >= 0.96 ? 0.070 : accL >= 0.90 ? 0.090 : 0.115) : 0.10;
  const selA = [a0, +(a0 * 1.8).toFixed(3)];
  const t = {
    "bg-void": G(s.void), "bg-chrome": G(s.chrome), "bg-island": G(s.island),
    "bg-inset": G(s.inset), "bg-hover": G(mode === "dark" ? s.inset : s.hover),
    "bg-hover-2": G(s.hover2), "bg-code": G(s.code),
    line: G(s.line, d.cG * 1.15), "line-strong": G(s.lineS, d.cG * 1.3),
    fg: I(s.fg, d.cI * 0.7), "fg-mid": I(s.mid), "fg-dim": I(s.dim, d.cI * 1.2),
    accent: hex(...acc), "accent-press": hex(...accP), "accent-ink": G(accInk),
    sel: rgba(...acc, selA[0]), "sel-hover": rgba(...acc, selA[1]),
    "st-working": hex(...st.working), "st-waiting": hex(...st.waiting),
    "st-error": hex(...st.error), "st-ended": I(s.mid),
    "chip-working": rgba(...st.working, ALPHA.working),
    "chip-waiting": rgba(...st.waiting, ALPHA.waiting),
    "chip-error": rgba(...st.error, ALPHA.error),
    "chip-ended": rgba(s.mid, d.cI, d.hueI, ALPHA.ended),
    "bg-error-soft": rgba(...st.error, ALPHA.soft),
    "diff-add": rgba(...st.working, ALPHA.diff),
    "diff-del": rgba(...st.error, ALPHA.diff),
  };
  /* Elevation is three things at once — a lit top edge, a contact shadow and a
     cast one — and on a light ground the shadow has to be a fraction of what it
     is on a dark one or every island looks stamped on. */
  if (mode === "dark") {
    const e = d.elev || {};
    t["edge-lit"] = e.edge || "inset 0 1px 0 rgba(255, 255, 255, 0.045)";
    t["sh-1"] = e.sh1 || "0 1px 2px rgba(0, 0, 0, 0.34), 0 10px 26px -18px rgba(0, 0, 0, 0.8)";
    t["sh-2"] = e.sh2 || "0 2px 8px rgba(0, 0, 0, 0.42), 0 28px 64px -22px rgba(0, 0, 0, 0.88)";
    t.scrim = rgba(s.void * 0.5, d.cG, d.hue, e.scrimA || 0.58);
    t.glass = rgba(s.chrome, d.cG, d.hue, 0.72);
  } else {
    /* A lit top edge is meaningless on a near-white surface: 90% white inset on
       an island that resolves to #ffffff is a declaration that does nothing, and
       that is the same criticism this palette makes of a drop shadow on black.
       So in light mode the edge is carried by the hairline and the contact
       shadow, and the token becomes an explicit no-op rather than a lie. It has
       to stay a VALID shadow value, because every component composes it into a
       comma list — `none` there would discard the whole list. */
    t["edge-lit"] = "inset 0 0 0 0 transparent";
    t["sh-1"] = "0 1px 2px rgba(20, 20, 24, 0.07), 0 10px 26px -18px rgba(20, 20, 24, 0.28)";
    t["sh-2"] = "0 2px 8px rgba(20, 20, 24, 0.10), 0 28px 64px -24px rgba(20, 20, 24, 0.34)";
    t.scrim = rgba(0.45, d.cG, d.hue, 0.34);
    t.glass = rgba(s.chrome + 0.03, d.cG, d.hue, 0.76);
  }
  return t;
}

/* The terminal follows the DIRECTION but not the theme: its ground is our
   surface, and it stays dark under a light chrome the way Xcode's editor does. */
function termTokens(d) {
  const s = d.dark;
  return {
    "term-bg": hex(s.term, d.cG, d.hue),
    "term-fg": hex(s.fg, d.cI * 0.7, d.hueI),
    "term-mid": hex(s.mid, d.cI, d.hueI),
    "term-dim": hex(s.dim, d.cI * 1.2, d.hueI),
    "term-ok": hex(...ST.dark.working),
    "term-warn": hex(...ST.dark.waiting),
    "term-err": hex(...ST.dark.error),
  };
}

/* ---------- Output -------------------------------------------------------
   BASE is the direction that ships. It is written into `deck-ui.css` by
   `--base` and deliberately NOT emitted into the candidate file: two sources for
   one palette is how a design system starts disagreeing with itself. Every other
   direction stays a candidate, so the choice remains reversible and auditable. */
const BASE = "ink";
const args = process.argv.slice(2);
const wantCss = args.includes("--css");
const wantBase = args.includes("--base");
const wantApp = args.includes("--app");
const only = args.filter((a) => !a.startsWith("--"))[0];
const list = DIRECTIONS.filter((d) => !only || d.id === only);

/* The app's names for the same values. Four differ, and each difference is the
   app's word rather than the mockups':

     --bg-terminal      a terminal body AND the diff's ground are one surface in
                        the app; the mockups split them into --term-bg and
                        --bg-code, which resolve one unit of lightness apart
     --diff-add-weak    the mockups' --diff-add / --diff-del, named for being
     --diff-del-weak    weak tints under code rather than the two hues themselves
     --sh-island        the mockups' --edge-lit and --sh-1 composed: a lit top
                        hairline plus a contact shadow, which is what a raised
                        surface is on this ground
     --sh-float         the mockups' --sh-2

   `--st-*` and the chip fills are absent for a reason: the state hues did not
   move between the two passes, so re-emitting them here would invite an edit
   that says they did. They are asserted by `npm run contrast` where they stand. */
function appTokens(d) {
  const k = tokens(d, "dark"), t = termTokens(d);
  const out = {};
  for (const name of ["bg-void", "bg-chrome", "bg-island", "bg-inset"]) out[name] = k[name];
  out["bg-terminal"] = t["term-bg"];
  for (const name of ["bg-hover", "bg-hover-2", "line", "line-strong", "fg", "fg-mid", "fg-dim",
                      "accent", "accent-press", "accent-ink", "sel", "sel-hover", "st-ended"]) out[name] = k[name];
  out["diff-add-weak"] = k["diff-add"];
  out["diff-del-weak"] = k["diff-del"];
  out["sh-island"] = `${k["edge-lit"]}, ${k["sh-1"]}`;
  out["sh-float"] = k["sh-2"];
  return out;
}

if (wantApp) {
  const d = DIRECTIONS.find((x) => x.id === BASE);
  console.log(`/* ${d.en} — generated by \`node docs/design/true-ink/tools/palette.mjs --app\` */`);
  for (const [name, v] of Object.entries(appTokens(d))) console.log(`  --${name}: ${v};`);
  const t = termTokens(d);
  console.log(`/* src/terminal.ts — the FRAME colours, which are the app's:`);
  console.log(`     background ${t["term-bg"]}  foreground ${t["term-fg"]}  cursor ${t["term-fg"]}`);
  console.log(`     cursorAccent ${t["term-bg"]}  black ${t["term-bg"]}  brightBlack ${t["term-dim"]} */`);
} else if (wantBase) {
  /* The three token blocks `deck-ui.css` holds, ready to splice: the dark set,
     the light set, and the terminal set that belongs to neither theme. */
  const d = DIRECTIONS.find((x) => x.id === BASE);
  const dark = tokens(d, "dark"), light = tokens(d, "light"), term = termTokens(d);
  const emit = (o, indent = "  ") => Object.entries(o).map(([k, v]) => `${indent}--${k}: ${v};`).join("\n");
  console.log("@@DARK@@");
  console.log(emit(dark));
  console.log("@@LIGHT@@");
  console.log(emit(light));
  console.log("@@TERM@@");
  console.log(emit(term));
} else if (wantCss) {
  const out = [];
  out.push("/* GENERATED by `node assets/palette.mjs --css`. Do not hand-edit:");
  out.push("   the OKLch source is in that file, and a hex changed here would be a");
  out.push("   claim nothing re-derives. Every value below is measured by");
  out.push("   `node assets/contrast.mjs`, which reads this file. */");
  out.push("");
  for (const d of list) {
    if (d.id === BASE) continue; // the base palette lives in deck-ui.css
    out.push(`/* =====================================================================`);
    out.push(`   ${d.ru} · ${d.en}`);
    out.push(`   ${d.note}`);
    out.push(`   ===================================================================== */`);
    const dark = tokens(d, "dark"), light = tokens(d, "light"), term = termTokens(d);
    out.push(`[data-palette="${d.id}"] {`);
    out.push("  color-scheme: dark;");
    for (const [k, v] of Object.entries(dark)) out.push(`  --${k}: ${v};`);
    for (const [k, v] of Object.entries(term)) out.push(`  --${k}: ${v};`);
    out.push("}");
    out.push(`[data-theme="light"] [data-palette="${d.id}"],`);
    out.push(`[data-theme="light"][data-palette="${d.id}"] {`);
    out.push("  color-scheme: light;");
    for (const [k, v] of Object.entries(light)) out.push(`  --${k}: ${v};`);
    out.push("}");
    out.push("");
  }
  console.log(out.join("\n"));
} else {
  for (const d of list) {
    console.log(`\n\x1b[1m${d.ru} — ${d.en}\x1b[0m  [${d.id}]`);
    const dark = tokens(d, "dark"), light = tokens(d, "light");
    const keys = ["bg-void", "bg-chrome", "bg-island", "bg-inset", "bg-code", "line", "line-strong", "fg", "fg-mid", "fg-dim", "accent", "accent-ink", "st-working", "st-waiting", "st-error"];
    for (const k of keys) console.log(`  ${k.padEnd(13)} dark ${dark[k].padEnd(9)} light ${light[k]}`);
    const t = termTokens(d);
    console.log(`  ${"term-bg".padEnd(13)} ${t["term-bg"]}`);
  }
}

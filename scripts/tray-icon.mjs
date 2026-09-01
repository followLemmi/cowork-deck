/** Draw the status-area icons.
 *
 *  Two PNGs, from the shapes in `src-tauri/icons/tray-source.svg` and the colour
 *  token in `src/styles.css`:
 *
 *  - `tray-mac.png` — 36x36, black on transparent. macOS scales a status item's
 *    image to 18 points tall (`tray-icon`'s `set_icon_for_ns_status_item`), so 36
 *    pixels is exactly 2x and nothing is resampled on a Retina display. It is
 *    installed as a template image, which means macOS reads the ALPHA CHANNEL
 *    ONLY and tints the result — for a light menu bar, a dark one, and the
 *    inverted state while the menu is open. That is why the colour written here
 *    is plain black: it is never displayed.
 *  - `badge-win.png` — 16x16, the Windows taskbar overlay icon. Colour, not a
 *    template: Windows composites it over the app's own button and tints
 *    nothing.
 *
 *  Written by hand rather than by a rasteriser, because there isn't one. Neither
 *  `rsvg-convert` nor ImageMagick nor `cairosvg` is a dependency of this project
 *  or present on a stock macOS, and adding an SVG toolchain to draw two glyphs
 *  would be the larger commitment. Both shapes have an exact signed distance
 *  function, so coverage is computed rather than sampled and the edges are right
 *  at any size.
 *
 *  `node scripts/tray-icon.mjs`. The output is committed — CI does not run this,
 *  and a build must not depend on it.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ICONS = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");

/* --- Shapes, as distance functions ---------------------------------------- */

/** A rounded rectangle, by the usual box SDF: the distance to the shrunken box
 *  less the corner radius. */
const roundedRect = (x, y, w, h, r) => (px, py) => {
  const cx = x + w / 2, cy = y + h / 2;
  const qx = Math.abs(px - cx) - (w / 2 - r);
  const qy = Math.abs(py - cy) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

/** A disc. */
const disc = (cx, cy, r) => (px, py) => Math.hypot(px - cx, py - cy) - r;

/** The outline of a shape rather than its body: everything within `width / 2` of
 *  its edge, inside and out. `Math.abs` on a signed distance is the whole trick,
 *  and it is the reason these are distance functions and not paths — the outline
 *  of a rounded rectangle has no closed form as a path, and has an exact one as
 *  this. */
const ring = (sdf, width) => (px, py) => Math.abs(sdf(px, py)) - width / 2;

/** Coverage of a shape at one pixel.
 *
 *  `0.5 - d` at the pixel's centre is the fraction of a one-pixel square the
 *  shape covers wherever its edge is locally straight, which it is everywhere at
 *  this scale. Exact where supersampling would only be close, for one distance
 *  evaluation. */
const coverage = (sdf, px, py) => Math.max(0, Math.min(1, 0.5 - sdf(px + 0.5, py + 0.5)));

/* --- PNG ------------------------------------------------------------------ */

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** An 8-bit RGBA PNG, not interlaced, one filter byte per row and that filter is
 *  None: these are 36 and 16 pixels wide, so a predictor would save bytes nobody
 *  is counting while making the output harder to reason about. */
function png(width, height, rgba) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const at = y * (1 + width * 4);
    raw[at] = 0;
    rgba.copy(raw, at + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Paint one colour through the union of `shapes`, over transparency. Straight
 *  alpha, not premultiplied: that is what PNG carries and what
 *  `Image::from_bytes` hands on to the platform. */
function paint(size, shapes, [r, g, b]) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0;
      for (const s of shapes) a = Math.max(a, coverage(s, x, y));
      const at = (y * size + x) * 4;
      rgba[at] = r;
      rgba[at + 1] = g;
      rgba[at + 2] = b;
      rgba[at + 3] = Math.round(a * 255);
    }
  }
  return rgba;
}

/** Composite `over` onto `base`, straight alpha, source-over. */
function overlay(base, over) {
  for (let i = 0; i < base.length; i += 4) {
    const sa = over[i + 3] / 255;
    if (sa === 0) continue;
    const da = base[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    for (let c = 0; c < 3; c++) {
      base[i + c] = Math.round((over[i + c] * sa + base[i + c] * da * (1 - sa)) / oa);
    }
    base[i + 3] = Math.round(oa * 255);
  }
  return base;
}

/* --- The two icons -------------------------------------------------------- */

/* Four tiles, one lit — the mark of `icons/icon-source.svg`, and the half of it
   that is the app rather than the terminal inside it.
   The first draft was the chevron and the cursor block, on the theory that four
   squares would be noise at menu-bar size. Looked at in a real menu bar that was
   wrong twice over: 36 pixels is room for four 14-pixel tiles with a 3-pixel
   gutter, which reads perfectly well — and the chevron alone said "a terminal",
   which every other icon up there could also say. The tiles are the thing this
   app is, and they are what the person looking for it recognises.
   A template image has exactly one contrast to spend, and it goes where the app
   icon spends its accent: the top-left tile is solid and the other three are
   outlines. Not a state signal — the icon never changes, see ADR-0011 — it is
   what makes four squares read as a deck with something in it rather than as a
   window-tiling utility. */
const TILE = 14, GAP = 3, EDGE = 2.5, RADIUS = 3.5, STROKE = 2;
const tile = (col, row) => [EDGE + col * (TILE + GAP), EDGE + row * (TILE + GAP), TILE, TILE, RADIUS];

writeFileSync(
  join(ICONS, "tray-mac.png"),
  png(36, 36, paint(36, [
    roundedRect(...tile(0, 0)),
    ring(roundedRect(...tile(1, 0)), STROKE),
    ring(roundedRect(...tile(0, 1)), STROKE),
    ring(roundedRect(...tile(1, 1)), STROKE),
  ], [0, 0, 0])),
);

/* A dot, and deliberately only a dot. Windows' overlay icon is 16x16 over the
   taskbar button, which is no room for a count — so the badge there degrades to
   a state, as #393 requires, and the state it says is "something is waiting for
   you". `--st-waiting` (#efc845) is the token the deck already paints that with;
   a ring of the app icon's own ground keeps it legible over a light taskbar
   button. */
writeFileSync(
  join(ICONS, "badge-win.png"),
  png(16, 16, overlay(
    paint(16, [disc(8, 8, 7.5)], [0x1d, 0x1f, 0x21]),
    paint(16, [disc(8, 8, 6)], [0xef, 0xc8, 0x45]),
  )),
);

console.log("wrote src-tauri/icons/tray-mac.png and src-tauri/icons/badge-win.png");

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

/** Distance from `p` to the segment `a`-`b`. */
function toSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  const dx = wx - t * vx, dy = wy - t * vy;
  return Math.hypot(dx, dy);
}

/** A stroked polyline with round caps and joins: the union of one capsule per
 *  segment. Round joins are what make the union correct — a mitre would need the
 *  corner drawn as a third shape. */
const capsules = (points, radius) => (px, py) => {
  let d = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    d = Math.min(d, toSegment(px, py, ax, ay, bx, by) - radius);
  }
  return d;
};

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

/* The mark of `icons/icon-source.svg`, mapped from its 1024 grid onto 36 with a
   4px margin top and bottom. The numbers are the source's own: the chevron
   398,392 → 556,512 → 398,632 at stroke 70, and the cursor block at 590,470,
   150x84, radius 20. Its 2x2 tiles are dropped — four 308-unit squares become
   four 2px squares here, which is noise rather than a mark. `tray-source.svg`
   carries the results of this arithmetic so the shapes can be looked at; this is
   where it is done. */
const S = 28 / 310;
const OX = 0.97, OY = 4;
const at = (x, y) => [(x - 363) * S + OX, (y - 357) * S + OY];

writeFileSync(
  join(ICONS, "tray-mac.png"),
  png(36, 36, paint(36, [
    capsules([at(398, 392), at(556, 512), at(398, 632)], 35 * S),
    roundedRect(...at(590, 470), 150 * S, 84 * S, 20 * S),
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

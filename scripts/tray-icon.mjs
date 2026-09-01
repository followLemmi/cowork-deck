/** Draw the status-area icons.
 *
 *  Two PNGs:
 *
 *  - `tray-mac.png` — 36x36, **the app's own icon at status-area size, in
 *    colour**. macOS scales a status item's image to 18 points tall
 *    (`tray-icon`'s `set_icon_for_ns_status_item`), so 36 pixels is exactly 2x
 *    and nothing is resampled on a Retina display. Used on every platform: a
 *    Windows notification area and a Linux panel want colour too, and this is a
 *    better source for them than the 512px app icon scaled down by the system.
 *  - `badge-win.png` — 16x16, the Windows taskbar overlay icon.
 *
 *  ## Why this is not a template image
 *
 *  It was one — black on transparent, tinted by macOS for a light menu bar, a
 *  dark one, and the inverted state while the panel is open. That is Apple's own
 *  guidance for a status item, and it was the wrong call here for two reasons,
 *  both reported from a real menu bar rather than argued from the guidance:
 *
 *  1. A template image is one hue by construction, so against a light menu bar
 *    it is a black smudge — which is what it looked like.
 *  2. A monochrome mark cannot be the app's icon. The icon is a dark rounded
 *    frame, four black tiles, a white chevron and a **blue** cursor block; take
 *    the colour away and you have four squares, which is a different mark. The
 *    person scanning a menu bar for this app is looking for the thing on their
 *    dock, and it has to be that thing.
 *
 *  So: colour, and the same composition as `icons/icon.png`. What that gives up
 *  is the automatic light/dark adaptation, and the ground carries a lit hairline
 *  to make up for it — see `EDGE_ALPHA` below. Recorded in ADR-0011 decision 5.
 *
 *  ## Where the numbers come from
 *
 *  Measured off the shipped `icons/icon.png` at 512, not copied from
 *  `icons/icon-source.svg`. The GEOMETRY in that SVG is exact, to the pixel; its
 *  COLOURS are stale. It is an earlier candidate — its own comment says "four
 *  tiles, one live" — with a #1d1f21 ground, tiles LIGHTER than the ground, and
 *  the top-left one tinted with the accent. The shipped icon has a #27292C
 *  ground, black tiles, and none of them lit. The icon a person recognises is
 *  the shipped one, so that is what this reproduces.
 *
 *  ## Why by hand
 *
 *  There is no SVG rasteriser in this project's toolchain and none on a stock
 *  macOS — no `rsvg-convert`, no ImageMagick, no `cairosvg`. Every shape here has
 *  an exact signed distance function, so coverage is computed rather than sampled
 *  and the edges are right at a size where a 14x downscale of the 512px icon is
 *  a grey smear.
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

/* --- Painting ------------------------------------------------------------- */

const hex = (s) => [
  parseInt(s.slice(1, 3), 16),
  parseInt(s.slice(3, 5), 16),
  parseInt(s.slice(5, 7), 16),
];

/** A blank RGBA buffer. */
const canvas = (size) => Buffer.alloc(size * size * 4);

/** Paint one layer over what is already there.
 *
 *  Straight alpha, source-over — that is what PNG carries and what
 *  `Image::from_bytes` hands on to the platform. `alpha` scales the layer's own
 *  coverage, and `clip` restricts it to another shape's inside, which is how the
 *  ground's lit hairline stays inside the frame instead of haloing it.
 */
function paint(buf, size, sdf, colour, { alpha = 1, clip = null } = {}) {
  const [r, g, b] = hex(colour);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = coverage(sdf, x, y) * alpha;
      if (clip) a *= coverage(clip, x, y);
      if (a <= 0) continue;
      const at = (y * size + x) * 4;
      const da = buf[at + 3] / 255;
      const oa = a + da * (1 - a);
      buf[at] = Math.round((r * a + buf[at] * da * (1 - a)) / oa);
      buf[at + 1] = Math.round((g * a + buf[at + 1] * da * (1 - a)) / oa);
      buf[at + 2] = Math.round((b * a + buf[at + 2] * da * (1 - a)) / oa);
      buf[at + 3] = Math.round(oa * 255);
    }
  }
  return buf;
}

/* --- The status-area icon ------------------------------------------------- */

/** The shipped icon's own colours, sampled from `icons/icon.png` at 512. */
const GROUND = "#27292c";
const TILE = "#000000";
const CHEVRON = "#ebebeb";
const CURSOR = "#72bef2";

/** A lit hairline along the inside of the ground's edge, and the one thing here
 *  that is not in the app icon at full size.
 *
 *  The icon has one — `rgba(255,255,255,.09)` at three units of 1024 — and at
 *  this size that is a tenth of a pixel, which is nothing. It is thickened and
 *  brightened instead, because a #27292C square against a dark menu bar has no
 *  edge at all: without this the mark is a chevron and a blue dash floating in
 *  the bar with no frame around them. Giving up the template image gave up
 *  automatic adaptation, and this is what pays for it.
 */
const EDGE_INK = "#ffffff";
const EDGE_ALPHA = 0.22;
const EDGE_WIDTH = 1.0;

/** From the shipped icon's 512 grid onto 36. Every number below is measured, not
 *  guessed: the ground is 36..475 at radius 100, a tile is 154 across at radius
 *  18 with its neighbour 182 further on, the chevron is stroked 35 wide, and the
 *  cursor block is 75 by 42. */
const S = 36 / 512;
const at = (v) => v * S;

const SIZE = 36;
const ground = roundedRect(at(36), at(36), at(440), at(440), at(100));
const tile = (col, row) =>
  roundedRect(at(88 + col * 182), at(88 + row * 182), at(154), at(154), at(18));

const icon = canvas(SIZE);
paint(icon, SIZE, ground, GROUND);
// Clipped to the ground, so a tile's corner cannot bleed past the frame's.
for (const col of [0, 1]) {
  for (const row of [0, 1]) paint(icon, SIZE, tile(col, row), TILE, { clip: ground });
}
// The ring straddles the edge; clipping it to the ground keeps its inner half,
// or the icon grows a halo half a pixel wider than the frame it traces.
paint(icon, SIZE, ring(ground, EDGE_WIDTH), EDGE_INK, { alpha: EDGE_ALPHA, clip: ground });
// The chevron's centreline, which is what `capsules` takes — its round caps
// carry the ends out to the mark's real bounds. The icon's own polyline is
// 398,392 → 556,512 → 398,632 on a 1024 grid at stroke-width 70; halved onto
// this one that is 199,196 → 278,256 → 199,316 at RADIUS 17.5. Half of half:
// the stroke is a width and a capsule takes a radius, and using 35 here made a
// `>` into a blob that swallowed the tiles behind it.
paint(
  icon,
  SIZE,
  capsules([[at(199), at(196)], [at(278), at(256)], [at(199), at(316)]], at(17.5)),
  CHEVRON,
);
paint(icon, SIZE, roundedRect(at(295), at(235), at(75), at(42), at(10)), CURSOR);
writeFileSync(join(ICONS, "tray-mac.png"), png(SIZE, SIZE, icon));

/* --- The Windows taskbar overlay ------------------------------------------ */

/* A dot, and deliberately only a dot. Windows' overlay icon is 16x16 over the
   taskbar button, which is no room for a count — so the badge there degrades to
   a state, as #393 requires, and the state it says is "something is waiting for
   you". `--st-waiting` (#efc845) is the token the deck already paints that with;
   a ring of the icon's own ground keeps it legible over a light taskbar button. */
const badge = canvas(16);
paint(badge, 16, disc(8, 8, 7.5), GROUND);
paint(badge, 16, disc(8, 8, 6), "#efc845");
writeFileSync(join(ICONS, "badge-win.png"), png(16, 16, badge));

console.log("wrote src-tauri/icons/tray-mac.png and src-tauri/icons/badge-win.png");

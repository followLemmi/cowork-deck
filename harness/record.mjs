/* Record the README's demo GIF against the harness.
 *
 *   npm run dev              # in one terminal, serves /harness/
 *   node harness/record.mjs [out.webm]
 *
 * Drives the real UI through one continuous take — the deck, a live state
 * change, zoom and juggle, the board on GitHub issues, the pull-request diff —
 * and writes a .webm plus the trim offset for the moment the take actually
 * starts. Conversion to GIF is ffmpeg's job, not this script's.
 *
 * Everything on screen comes from harness/fixtures.ts and is invented; see the
 * note at the top of that file.
 */

import { existsSync, globSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const chromium = await (async () => {
  const candidates = [
    ...(process.env.PLAYWRIGHT ? [process.env.PLAYWRIGHT] : []),
    "playwright",
    ...globSync(join(homedir(), ".npm/_npx/*/node_modules/playwright/index.mjs")),
  ];
  for (const c of candidates) {
    try { return (await import(c)).chromium; } catch { /* try the next one */ }
  }
  throw new Error("Playwright not found. `npx playwright@latest --version` once, or set PLAYWRIGHT.");
})();

const CHROME = process.env.CHROME
  ?? ["/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));

const BASE = process.env.HARNESS_URL ?? "http://127.0.0.1:1420";
const OUT = resolve(process.argv[2] ?? join(import.meta.dirname, "../docs/images/demo.webm"));
const VIEW = { width: 1600, height: 900 };

/* --- A visible pointer ----------------------------------------------------
 * Playwright's video has no cursor, and a demo where things happen with no
 * visible cause reads as a slideshow. A dot that follows the mouse and pulses
 * on press is enough to carry the eye. */
const CURSOR = () => {
  const mount = () => {
    const c = document.createElement("div");
    c.style.cssText = [
      "position:fixed", "left:0", "top:0", "width:18px", "height:18px",
      "border-radius:50%", "background:rgba(255,255,255,.30)",
      "border:2px solid rgba(255,255,255,.85)", "box-shadow:0 1px 6px rgba(0,0,0,.55)",
      "pointer-events:none", "z-index:2147483647", "transform:translate(-50%,-50%)",
      "transition:width .1s,height .1s", "will-change:left,top",
    ].join(";");
    document.body.append(c);
    addEventListener("mousemove", (e) => {
      c.style.left = `${e.clientX}px`; c.style.top = `${e.clientY}px`;
    }, true);
    addEventListener("mousedown", () => { c.style.width = "28px"; c.style.height = "28px"; }, true);
    addEventListener("mouseup", () => { c.style.width = "18px"; c.style.height = "18px"; }, true);
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", mount);
  else mount();
};

/* --- Driving --------------------------------------------------------------- */

let page;
let cursor = { x: 60, y: 60 };
const pause = (ms) => page.waitForTimeout(ms);

/** Move the pointer to a locator in real time — one step per ~12 ms with an
 *  ease-in-out, so the video shows travel rather than teleportation. */
async function glide(locator, { dx = 0, dy = 0 } = {}) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`no box for ${locator}`);
  const to = { x: box.x + box.width / 2 + dx, y: box.y + box.height / 2 + dy };
  const dist = Math.hypot(to.x - cursor.x, to.y - cursor.y);
  const steps = Math.max(10, Math.min(34, Math.round(dist / 26)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t * t * (3 - 2 * t);
    await page.mouse.move(cursor.x + (to.x - cursor.x) * e, cursor.y + (to.y - cursor.y) * e);
    await pause(12);
  }
  cursor = to;
}

async function click(locator, opts) {
  await glide(locator, opts);
  await page.mouse.down(); await pause(90); await page.mouse.up();
}

async function dblclick(locator, opts) {
  await glide(locator, opts);
  await page.mouse.dblclick(cursor.x, cursor.y);
}

const pickWorkspace = (name) => page.locator(".ws-row", { hasText: name }).first();
const tab = (name) => page.locator("#viewbar button", { hasText: name });

/** Boot the deck exactly the way shoot.mjs does: tiles, states, badges. */
async function deckReady() {
  await page.goto(`${BASE}/harness/`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll(".tile").length === 5);
  await page.waitForSelector('.tile[data-state="working"]');
  await page.waitForFunction(
    () => document.querySelectorAll(".tile-git:not(.hidden)").length === 5
      && document.querySelectorAll(".tile-tokens:not(.hidden)").length === 5,
    null, { timeout: 20_000 },
  );
}

/* --- The take -------------------------------------------------------------- */

mkdirSync(dirname(OUT), { recursive: true });
const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const context = await browser.newContext({
  viewport: VIEW,
  recordVideo: { dir: dirname(OUT), size: VIEW },
});
await context.addInitScript(CURSOR);
page = await context.newPage();

const videoStart = Date.now();
await deckReady();
await page.mouse.move(cursor.x, cursor.y);
const takeStart = Date.now();

/* 1 — the deck: five sessions, four states, badges live. */
await pause(1800);

/* 2 — the working session finishes its turn: green rail to done, live. */
await glide(page.locator(".tile").first());
await page.mouse.down(); await pause(90); await page.mouse.up();
await pause(900);
await page.evaluate((s) => window.__harness.emit("session://state", { session: s, state: "done" }),
  "s-work-01");
await pause(1600);

/* 3 — zoom one tile near-full, juggle focus from the filmstrip, come back. */
await dblclick(page.locator(".tile").first().locator(".tile-name"));
await page.waitForSelector(".deck-strip .tile.minimized");
await pause(1400);
await click(page.locator(".deck-strip .tile.minimized").nth(1));
await pause(1500);
await dblclick(page.locator(".tile:not(.minimized) .tile-name").first());
await pause(900);

/* 4 — the board reading the repository's issues. */
await click(pickWorkspace("harbor"));
await pause(500);
await click(tab("Board"));
await page.waitForSelector(".tk-rows .tk-row");
await pause(1500);
await click(page.locator(".tk-row").filter({ hasText: "#150" }).first());
await page.waitForSelector(".modal-box .tk-c-read");
await pause(2000);
await page.keyboard.press("Escape");
await pause(600);

/* 5 — the pull requests and a diff. */
await click(tab("Pull requests"));
await page.waitForSelector(".pr-row");
await pause(1000);
await click(page.locator('[data-fk="toggle-157"]'));
await page.waitForSelector(".pr-detail-file");
await pause(800);
await click(page.locator(".pr-detail-file").first());
await page.waitForSelector(".dv-line");
await pause(2200);

/* 6 — end where it began: the deck. */
await click(tab("Terminals"));
await pause(400);
await click(pickWorkspace("relay"));
await pause(1800);

const takeEnd = Date.now();
const video = page.video();
await page.close();
await context.close();
await browser.close();

const path = await video.path();
renameSync(path, OUT);
const trim = ((takeStart - videoStart) / 1000).toFixed(2);
const len = ((takeEnd - takeStart) / 1000).toFixed(1);
console.log(`${OUT}\ntake: ${len}s, trim the first ${trim}s (ffmpeg -ss ${trim})`);

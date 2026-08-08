/* Take the README's screenshots against the harness.
 *
 *   npm run dev            # in one terminal, serves /harness/
 *   node harness/shoot.mjs [name…]
 *
 * Each shot drives the real UI — clicking the real tabs, opening the real
 * dialog — and writes `docs/images/<name>.png` at 2× with the window's own
 * rounded corners. See `docs/images/README.md` for what each one has to show.
 */

import { execFileSync } from "node:child_process";
import { existsSync, globSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/* Playwright is not a dependency of this project — it is a tool for taking the
 * shots, not for building or testing the app, and a browser driver in
 * `devDependencies` would be paid for by everyone who clones. Found wherever it
 * already is, or named with PLAYWRIGHT=/path/to/playwright/index.mjs. */
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

/* Playwright's own Chromium if it was downloaded, otherwise whatever Chrome is
 * installed — the shots are of the app's own DOM, so the engine only has to be
 * a current Chromium. */
const CHROME = process.env.CHROME
  ?? ["/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));

const BASE = process.env.HARNESS_URL ?? "http://127.0.0.1:1420";
const OUT = resolve(import.meta.dirname, "../docs/images");
/* Shot at 2× of 1440 × 900 and resampled down to `FINAL` — the deck's columns are
 * `minmax(clamp(20rem, 42vw, 35rem), 1fr)`, so a narrower window puts the
 * tiles in one column and the hero shot stops being a deck. Supersampling from
 * 2880 keeps the 13px type crisp at the width GitHub actually lays out. */
const VIEW = { width: 1680, height: 900 };
const SCALE = 2;
const FINAL = 2000;
/* Matches the window rounding the platforms draw, at the final width. */
const RADIUS = 16;

const tmp = mkdtempSync(join(tmpdir(), "cowork-shots-"));

/** Round the corners and put a hairline edge on them, so the shot reads as a
 *  window rather than as a rectangle of pixels. */
function frame(file) {
  const mask = join(tmp, "mask.png");
  execFileSync("magick", [file, "-filter", "Lanczos", "-resize", `${FINAL}x`, file]);
  const info = execFileSync("magick", ["identify", "-format", "%w %h", file]).toString().split(" ");
  const w = Number(info[0]), h = Number(info[1]);
  execFileSync("magick", [
    "-size", `${w}x${h}`, "xc:black", "-fill", "white",
    "-draw", `roundrectangle 0,0,${w - 1},${h - 1},${RADIUS},${RADIUS}`, mask,
  ]);
  execFileSync("magick", [
    file, mask, "-alpha", "Off", "-compose", "CopyOpacity", "-composite",
    "-fill", "none", "-stroke", "#3a3733", "-strokewidth", "2",
    "-draw", `roundrectangle 1,1,${w - 2},${h - 2},${RADIUS},${RADIUS}`,
    file,
  ]);
}

/** Under GitHub's ~1000px column a 2× shot is resampled anyway; what matters is
 *  the file staying small enough to load. 256 colours is invisible on a flat
 *  dark UI and roughly halves it. */
function shrink(file) {
  execFileSync("magick", [file, "-colors", "256", "-define", "png:compression-level=9", file]);
  return Number(execFileSync("stat", ["-c", "%s", file]).toString().trim());
}

const settle = (page, ms = 400) => page.waitForTimeout(ms);

/** Boot the deck with its five sessions restored and their scrollback in. */
async function deckReady(page) {
  await page.goto(`${BASE}/harness/`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll(".tile").length === 5);
  await page.waitForSelector('.tile[data-state="working"]');
  // The deck's git and token badges are filled by a five-second poll, and the
  // first tick runs when the FIRST tile exists — so the other four carry
  // nothing until the second one. Both are things the README's shots are for.
  await page.waitForFunction(
    () => document.querySelectorAll(".tile-git:not(.hidden)").length === 5
      && document.querySelectorAll(".tile-tokens:not(.hidden)").length === 5,
    null, { timeout: 20_000 },
  );
  await settle(page, 600);
}

const pickWorkspace = (page, name) => page.locator(".ws-row", { hasText: name }).first().click();
const tab = (page, name) => page.locator("#viewbar button", { hasText: name }).click();

const SHOTS = {
  async deck(page) {
    await deckReady(page);
    // The working session takes the keyboard: the accent border and the caret
    // are what the hero shot is for.
    await page.locator(".tile").first().dispatchEvent("mousedown");
    await settle(page);
  },

  async zoom(page) {
    await deckReady(page);
    await page.locator(".tile").first().locator(".tile-name").dblclick();
    await page.waitForSelector(".deck-strip .tile.minimized");
    await settle(page, 800);
  },

  async board(page) {
    await deckReady(page);
    await tab(page, "Board");
    await page.waitForSelector(".tk-cols .tk-card");
    await settle(page);
  },

  async issues(page) {
    await deckReady(page);
    await pickWorkspace(page, "harbor");
    await tab(page, "Board");
    await page.waitForSelector(".tk-rows .tk-row");
    await page.locator(".tk-f-kind", { hasText: "bug" }).first().click();
    await settle(page);
  },

  async "issue-dialog"(page) {
    await deckReady(page);
    await pickWorkspace(page, "harbor");
    await tab(page, "Board");
    await page.waitForSelector(".tk-rows .tk-row");
    await page.locator(".tk-row").filter({ hasText: "#150" }).first().click();
    await page.waitForSelector(".modal-box .tk-c-read");
    await settle(page);
  },

  async "pull-requests"(page) {
    await deckReady(page);
    await pickWorkspace(page, "harbor");
    await tab(page, "Pull requests");
    await page.waitForSelector(".pr-row");
    // By number, not by position: the list is ordered by what needs attention,
    // so "the first row" is whichever one is failing today.
    await page.locator('[data-fk="toggle-157"]').click();
    await page.waitForSelector(".pr-detail-file");
    await page.locator(".pr-detail-file").first().click();
    await page.waitForSelector(".dv-line");
    await settle(page);
  },
};

/** The pill is a window of its own, so it is shot on its own: no page around
 *  it, cropped to the element, on transparency. */
async function shootPill(browser) {
  const page = await browser.newPage({
    viewport: { width: 420, height: 120 }, deviceScaleFactor: SCALE,
  });
  await page.goto(`${BASE}/harness/pill.html`, { waitUntil: "load" });
  await page.waitForFunction(() => (document.getElementById("pill-text")?.textContent ?? "") !== "");
  await page.waitForTimeout(400);
  const file = join(OUT, "pill.png");
  await page.locator("#pill").screenshot({ path: file, omitBackground: true });
  await page.close();
  const size = shrink(file);
  console.log(`pill.png            ${(size / 1024).toFixed(0)} kB`);
}

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : [...Object.keys(SHOTS), "pill"];

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
for (const name of names) {
  if (name === "pill") { await shootPill(browser); continue; }
  const shot = SHOTS[name];
  if (!shot) { console.error(`no such shot: ${name}`); process.exitCode = 1; continue; }
  const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: SCALE });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("response", (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  await shot(page);
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  await page.close();
  frame(file);
  const size = shrink(file);
  console.log(`${(name + ".png").padEnd(20)}${(size / 1024).toFixed(0)} kB`
    + (errors.length ? `  ⚠ ${errors.length} console error(s): ${errors[0]}` : ""));
}
await browser.close();
rmSync(tmp, { recursive: true, force: true });

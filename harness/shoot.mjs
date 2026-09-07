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
import { existsSync, globSync, mkdtempSync, rmSync, statSync } from "node:fs";
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
const FINAL_NO_MAGICK = 1600;
/* Matches the window rounding the platforms draw, at the final width. */
const RADIUS = 16;
/* The hairline round the shot. `--line-strong` of True Ink; it was `#3a3733`,
   which is Slate & Ember's warm edge and reads brown against this palette. */
const EDGE = "#4a4b4d";

const tmp = mkdtempSync(join(tmpdir(), "cowork-shots-"));

/** Whether ImageMagick is on this machine. It is the better tool and stays the
 *  path when it is there — but it is not on every machine that has the app, and
 *  a re-shoot that cannot happen is a README that goes stale. See `roundInPage`
 *  for what stands in. */
const HAS_MAGICK = (() => {
  try { execFileSync("magick", ["-version"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

/** Round the corners and put a hairline edge on them, so the shot reads as a
 *  window rather than as a rectangle of pixels. */
function frame(file) {
  if (!HAS_MAGICK) { resizeWithSips(file); return; }
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
    "-fill", "none", "-stroke", EDGE, "-strokewidth", "2",
    "-draw", `roundrectangle 1,1,${w - 2},${h - 2},${RADIUS},${RADIUS}`,
    file,
  ]);
}

/** The downscale, on a machine with no ImageMagick. `sips` ships with macOS and
 *  resamples well enough at this ratio; the corners are cut in the page instead
 *  — see `roundInPage` — because that is the one part of the framing a resizer
 *  cannot do. */
function resizeWithSips(file) {
  /* Narrower than the ImageMagick path's `FINAL`, and the reason is the step
     that is missing rather than taste: without `magick` there is no way to
     quantize to 256 colours here, and a 2000px shot of this UI lands around
     580 kB against the ~400 kB `docs/images/README.md` asks for. 1600 still
     supersamples GitHub's ~1000px column and brings the file back under it. */
  execFileSync("sips", ["--resampleWidth", String(FINAL_NO_MAGICK), file, "--out", file], { stdio: "ignore" });
}

/** Under GitHub's ~1000px column a 2× shot is resampled anyway; what matters is
 *  the file staying small enough to load. 256 colours is invisible on a flat
 *  dark UI and roughly halves it — and is the one step with no `sips` equivalent,
 *  so without ImageMagick the files are simply larger. */
function shrink(file) {
  if (HAS_MAGICK) {
    execFileSync("magick", [file, "-colors", "256", "-define", "png:compression-level=9", file]);
  }
  return statSync(file).size;
}

/** The window's own corners, cut by the page rather than by a mask afterwards.
 *
 *  `overflow: hidden` on the root with a radius clips every descendant, and the
 *  screenshot is taken with `omitBackground` so what falls outside the curve is
 *  transparent rather than black. The 2px inset ring is the same hairline the
 *  ImageMagick path strokes on, in the palette's own colour rather than in the
 *  literal the warm palette left behind. */
async function roundInPage(page) {
  await page.addStyleTag({ content: `
    html {
      border-radius: ${RADIUS * SCALE / 2}px; overflow: hidden;
      box-shadow: inset 0 0 0 2px ${EDGE};
      background: transparent;
    }
  ` });
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
/* The way into a workspace's own two pages, and it is no longer a tab bar over
   the whole window: the board and the pull requests belong to one repository, so
   they are reached from that repository's row — the `board · PRs · journal` chip
   — and switch between themselves on the panel's own tabs. */
const openWorkspacePanel = (page) => page.locator(".ws-scope").first().click();
/* A kanban is the one page in this panel that wants more than a column, and the
   panel is resizable by its grip — so the shot takes the width a person would
   drag it to rather than showing four columns clipped at two. Written as the
   property the drag writes, not as a class: `is-wide` is the diff's state and
   means something else. */
const widenWorkspacePanel = (page, px = 760) =>
  page.evaluate((w) => {
    /* Both, because the panel reads one or the other: `--wsp-wide-w` while a
       diff has widened it, `--wsp-w` otherwise. Writing only the second is a
       silent no-op on the one page that is always in the first state. */
    const el = document.querySelector("#wspanel");
    el.style.setProperty("--wsp-w", `${w}px`);
    el.style.setProperty("--wsp-wide-w", `${w}px`);
  }, px);
const wspTab = async (page, name) => {
  await openWorkspacePanel(page);
  await page.locator(".wsp-tab", { hasText: name }).first().click();
};

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
    await wspTab(page, "Board");
    await page.waitForSelector(".tk-cols .tk-card");
    await widenWorkspacePanel(page);
    await settle(page);
  },

  async issues(page) {
    await deckReady(page);
    await pickWorkspace(page, "harbor");
    await wspTab(page, "Board");
    await page.waitForSelector(".tk-rows .tk-row");
    await page.locator(".tk-f-kind", { hasText: "bug" }).first().click();
    await widenWorkspacePanel(page);
    await settle(page);
  },

  async "issue-dialog"(page) {
    await deckReady(page);
    await pickWorkspace(page, "harbor");
    await wspTab(page, "Board");
    await page.waitForSelector(".tk-rows .tk-row");
    await page.locator(".tk-row").filter({ hasText: "#150" }).first().click();
    await page.waitForSelector(".modal-box .tk-c-read");
    await settle(page);
  },

  async "pull-requests"(page) {
    await deckReady(page);
    await pickWorkspace(page, "harbor");
    await wspTab(page, "Pull requests");
    await page.waitForSelector(".pr-row");
    // By number, not by position: the list is ordered by what needs attention,
    // so "the first row" is whichever one is failing today.
    await page.locator('[data-fk="toggle-157"]').click();
    await page.waitForSelector(".pr-detail-file");
    await page.locator(".pr-detail-file").first().click();
    await page.waitForSelector(".dv-line");
    /* Wider than the board's, because a diff is the one page the panel's own
       widen control exists for: two columns of code and a gutter do not fit in a
       column sized for a list of names. */
    await widenWorkspacePanel(page, 1040);
    await settle(page);
  },
};

/** A workspace pulled into a window of its own.
 *
 *  Its own page rather than a state of the deck's, because it is a different
 *  window: the same app under a different role, with the singletons suppressed
 *  and the sidebar showing one workspace. The framing and rounding pipeline is
 *  the deck's, unchanged — only the URL and the readiness check differ.
 *
 *  Shot at all because a screen the harness cannot mount is a screen nobody
 *  reviews: everything else about this window would be checked by reading the
 *  diff and hoping. */
async function shootWorkspaceWindow(browser) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 }, deviceScaleFactor: SCALE,
  });
  await page.goto(`${BASE}/harness/workspace.html`, { waitUntil: "load" });
  await page.waitForSelector("#sidebar .ws-row");
  await settle(page, 600);
  const file = join(OUT, "workspace-window.png");
  if (!HAS_MAGICK) await roundInPage(page);
  await page.screenshot({ path: file, omitBackground: !HAS_MAGICK });
  await page.close();
  const size = shrink(file);
  console.log(`workspace-window.png ${(size / 1024).toFixed(0)} kB`);
}

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : [...Object.keys(SHOTS), "workspace-window"];

/* WebGL off, on purpose, and the shots are the reason.
 *
 * xterm draws through a WebGL canvas when it can, and a screenshot of one comes
 * back wrong in headless Chromium: the capture takes the backing store, which at
 * `deviceScaleFactor: 2` is twice the canvas's CSS box, so every glyph in the
 * terminals lands at double size beside chrome that is correctly sized. With no
 * WebGL2 context to take, `TerminalPanel.attachGpu` falls to the DOM renderer —
 * a path the app supports and states it supports, and one that screenshots as
 * what it is, real DOM text.
 *
 * This is a property of the SHOT, not of the app: nothing else runs with the
 * flag, and the terminals in a real window keep their GPU renderer. */
const browser = await chromium.launch({
  ...(CHROME ? { executablePath: CHROME } : {}),
  args: ["--disable-webgl", "--disable-webgl2"],
});
for (const name of names) {
  if (name === "workspace-window") { await shootWorkspaceWindow(browser); continue; }
  const shot = SHOTS[name];
  if (!shot) { console.error(`no such shot: ${name}`); process.exitCode = 1; continue; }
  const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: SCALE });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("response", (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  await shot(page);
  const file = join(OUT, `${name}.png`);
  if (!HAS_MAGICK) await roundInPage(page);
  await page.screenshot({ path: file, omitBackground: !HAS_MAGICK });
  await page.close();
  frame(file);
  const size = shrink(file);
  console.log(`${(name + ".png").padEnd(20)}${(size / 1024).toFixed(0)} kB`
    + (errors.length ? `  ⚠ ${errors.length} console error(s): ${errors[0]}` : ""));
}
await browser.close();
rmSync(tmp, { recursive: true, force: true });

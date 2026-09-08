// Checks that every Tauri package present on both sides — the npm package and
// the Rust crate that implements it — is on the same major.minor release.
//
//   npm run tauri:versions
//
// Written after the v0.6.0 release build failed on all three platforms in the
// first step of `tauri build`, before any bundling (#523):
//
//   Found version mismatched Tauri packages. Make sure the NPM package and Rust
//   crate versions are on the same major/minor releases:
//   tauri-plugin-notification (v2.3.3) : @tauri-apps/plugin-notification (v2.4.0)
//   tauri-plugin-updater (v2.10.1) : @tauri-apps/plugin-updater (v2.11.0)
//
// A dependency bump had moved package-lock.json to 2.4.0 and 2.11.0 and left
// Cargo.lock on 2.3.3 and 2.10.1. Nothing objected, and nothing was going to:
// both specs (`"2"` / `"^2"`, `"2.10.1"` / `"^2.10.1"`) already allowed the
// newer version, so each resolver was correct about its own lockfile and
// neither one reads the other's. Two ecosystems drifting apart is a fault only
// a comparison across both files can see, and until this script existed the
// only such comparison in the project ran inside `tauri build` — which CI
// deliberately does not run, so the answer arrived as a failed release.
//
// **Why the lockfiles and not `npx tauri info`.** That command prints these two
// files back with 🦀 and ⱼₛ markers for a human to eyeball; parsing it would
// spend a CLI spawn to reach the data already sitting on disk and couple a gate
// to a display format nobody promised to keep. Reading the locks costs
// milliseconds, needs no `node_modules`, and can name the file to edit.
//
// Two things this deliberately does NOT fail on:
//
//   * **A patch difference.** 2.11.5 against 2.11.1 is fine and routine — the
//     rule Tauri enforces is major.minor, and tightening it here would fail on
//     bumps that build perfectly.
//   * **A package with only one side.** `tauri-plugin-fs` and
//     `tauri-plugin-window-state` are used from Rust alone; they have npm
//     counterparts upstream that this project does not install, and pairing is
//     what makes a version comparison mean anything. They are listed on success
//     so an unpaired package is visible rather than silently skipped.
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const NPM_LOCK = "package-lock.json";
const CARGO_LOCK = "src-tauri/Cargo.lock";

// The npm name is not the crate name, and the exception is the first entry:
// the API package is implemented by the `tauri` crate itself, which is the pair
// most likely to drift and the one nothing else would catch.
function crateFor(npmName) {
  if (npmName === "@tauri-apps/api") return "tauri";
  const plugin = /^@tauri-apps\/plugin-([a-z0-9-]+)$/.exec(npmName);
  if (plugin) return `tauri-plugin-${plugin[1]}`;
  // `@tauri-apps/cli` and its per-platform binaries have no crate in this
  // dependency graph — the CLI is a build tool, not a runtime pair.
  return null;
}

// Top-level installs only. A nested copy under another package's node_modules
// is not what the app imports, and not what Tauri's own check reads.
const npmLock = JSON.parse(readFileSync(join(root, NPM_LOCK), "utf8"));
const npmVersions = new Map();
for (const [path, entry] of Object.entries(npmLock.packages ?? {})) {
  const m = /^node_modules\/(@tauri-apps\/[^/]+)$/.exec(path);
  if (m && entry.version) npmVersions.set(m[1], entry.version);
}

// Cargo.lock is TOML, but the only shape that matters here is the one cargo
// itself writes: `[[package]]` followed by name and version, in that order.
// Parsing those three lines needs no dependency.
const cargoLock = readFileSync(join(root, CARGO_LOCK), "utf8");
const crateVersions = new Map();
for (const [, name, version] of cargoLock.matchAll(
  /\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/g,
)) {
  if (!crateVersions.has(name)) crateVersions.set(name, new Set());
  crateVersions.get(name).add(version);
}

const minor = (v) => v.replace(/[-+].*$/, "").split(".").slice(0, 2).join(".");

const faults = [];
const pairs = [];
const unpaired = [];

for (const [npmName, npmVersion] of [...npmVersions].sort()) {
  const crate = crateFor(npmName);
  if (!crate) continue;
  const found = crateVersions.get(crate);
  if (!found) {
    unpaired.push(`${npmName} v${npmVersion} (no ${crate} in ${CARGO_LOCK})`);
    continue;
  }
  // Two versions of one Tauri crate in a single lockfile would make "the" crate
  // version ambiguous, and the pair meaningless — report it rather than pick.
  if (found.size > 1) {
    faults.push(
      `${crate} resolves to ${[...found].join(" and ")} in ${CARGO_LOCK}; ` +
        `${npmName} is v${npmVersion} and cannot be paired with both`,
    );
    continue;
  }
  const [crateVersion] = found;
  pairs.push(`${crate} v${crateVersion} : ${npmName} v${npmVersion}`);
  if (minor(crateVersion) !== minor(npmVersion)) {
    faults.push(
      `${crate} (v${crateVersion}) : ${npmName} (v${npmVersion}) — ` +
        `${minor(crateVersion)} against ${minor(npmVersion)}`,
    );
  }
}

// A crate with no npm side is fine; the reverse is worth naming, because the
// mapping above is where a package Tauri does pair would go missing.
for (const crate of [...crateVersions.keys()].sort()) {
  if (!/^tauri(-plugin-[a-z0-9-]+)?$/.test(crate)) continue;
  const paired = pairs.some((line) => line.startsWith(`${crate} v`));
  if (!paired) unpaired.push(`${crate} v${[...crateVersions.get(crate)].join("/")} (Rust only)`);
}

if (faults.length) {
  console.error(
    "Version mismatched Tauri packages. The npm package and the Rust crate\n" +
      "must be on the same major/minor release, or `tauri build` refuses to\n" +
      "start — which is a failed release, not a failed pull request:\n",
  );
  for (const fault of faults) console.error(`  ${fault}`);
  console.error(
    `\n${faults.length} mismatch${faults.length === 1 ? "" : "es"}. ` +
      `Move the lagging side: \`cargo update -p <crate>\` in src-tauri, or\n` +
      `\`npm install <package>@<version>\` — whichever lockfile is behind.`,
  );
  process.exit(1);
}

console.log(`${pairs.length} Tauri packages paired across both lockfiles, every one on a matching major.minor:\n`);
for (const pair of pairs) console.log(`  ${pair}`);
if (unpaired.length) {
  console.log(`\nUnpaired, and not compared:\n`);
  for (const one of unpaired) console.log(`  ${one}`);
}

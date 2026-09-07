// Checks the ADR directory for the three ways its numbering has actually broken.
//
//   npm run adr:check
//
// Written after the audit of 2 September 2026 found `dev` shipping two ADR-0010s
// and two ADR-0011s at once, plus a file renumbered to 0012 whose own heading
// still said 0011 (#451). Each of those is invisible in a diff and obvious in a
// listing, which is exactly the shape a script is good at:
//
//   1. **A duplicate number.** Two records claiming 0011 make every reference to
//      "ADR-0011" ambiguous — and there were four such references in the code,
//      pointing at two different decisions.
//   2. **A heading that disagrees with its filename.** The renumber is a `git mv`
//      and an edit, and the edit is the half that gets forgotten.
//   3. **A dead link.** A renumber moves the file; the links to it do not follow.
//      Only links into `docs/adr/` are checked, because those are the ones a
//      renumber breaks.
//
// Deliberately NOT checked: that numbers are contiguous. 0014 and 0015 exist
// because 0010 and 0011 were taken, and a gap is the honest record of that.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const adrDir = join(root, "docs", "adr");

const faults = [];

const NAME = /^(\d{4})-[a-z0-9-]+\.md$/;
const files = readdirSync(adrDir).filter((f) => f.endsWith(".md")).sort();

const byNumber = new Map();
for (const file of files) {
  const m = NAME.exec(file);
  if (!m) {
    faults.push(`${file}: not NNNN-lower-case-slug.md`);
    continue;
  }
  const number = m[1];
  (byNumber.get(number) ?? byNumber.set(number, []).get(number)).push(file);

  // The heading is the record's own claim about its number, and it is the one a
  // reader of the rendered file sees. First `# ` line only: later ones are
  // section headings inside the record.
  const text = readFileSync(join(adrDir, file), "utf8");
  const heading = text.split("\n").find((l) => l.startsWith("# "));
  if (!heading) {
    faults.push(`${file}: no '# ' heading`);
  } else {
    const claimed = /^# ADR-(\d{4})\b/.exec(heading);
    if (!claimed) faults.push(`${file}: heading does not start '# ADR-NNNN — '`);
    else if (claimed[1] !== number) {
      faults.push(`${file}: heading says ADR-${claimed[1]}, filename says ${number}`);
    }
  }
}

for (const [number, owners] of byNumber) {
  if (owners.length > 1) {
    faults.push(`ADR-${number} is claimed by ${owners.length} records: ${owners.join(", ")}`);
  }
}

// Every markdown link into docs/adr/ from anywhere that is tracked prose. Walked
// rather than globbed so this needs no dependency; node_modules and the build
// outputs are the only directories large enough to matter.
const SKIP = new Set(["node_modules", "target", "dist", ".git", ".gitnexus", "harness"]);
const LINK = /]\(([^)\s]*docs\/adr\/[^)\s#]+)/g;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (entry.endsWith(".md")) checkLinks(path);
  }
}

function checkLinks(path) {
  const text = readFileSync(path, "utf8");
  for (const [, href] of text.matchAll(LINK)) {
    const target = href.startsWith("docs/adr/")
      ? join(root, href)
      : resolve(dirname(path), href);
    if (!existsSync(target)) {
      faults.push(`${relative(root, path)}: dead ADR link ${href}`);
    }
  }
}

// Relative links inside docs/adr/ are the common case, and the ones a renumber
// breaks first, so the walk starts at the repository root and reaches them too.
walk(root);

if (faults.length) {
  console.error("ADR numbering faults:\n");
  for (const fault of faults) console.error(`  ${fault}`);
  console.error(`\n${faults.length} fault${faults.length === 1 ? "" : "s"}.`);
  process.exit(1);
}

console.log(`${files.length} ADRs, every number unique and every heading agreeing with its file.`);

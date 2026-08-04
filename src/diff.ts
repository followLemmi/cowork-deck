/** Pure logic for the pull-request diff drawer: no DOM, no fetch, no timers.
 *
 *  Everything here is a fold over what `gh_pr::parse_pr_files` already decided.
 *  Rust splits the patch into hunks and applies the line cap before serialisation;
 *  TypeScript turns marker characters into classes and running line numbers. That
 *  split is deliberate and measured: one JSON object per diff line —
 *  `{kind, oldNo, newNo, text}` — roughly doubles the payload against the raw text
 *  it describes, and PR #151 carries 19,854 of them.
 *
 *  Nothing here may need layout. jsdom returns zeros from `getBoundingClientRect`
 *  and has no `IntersectionObserver`, so a function that measures is a function
 *  that cannot be tested; it belongs in the view and on the manual checklist.
 */

// ---------------------------------------------------------------------------
// The wire shape
// ---------------------------------------------------------------------------

/** Why a file arrived with no lines to show. Mirrors `gh_pr::Omission`, tagged on
 *  `kind` and serialised camelCase.
 *
 *  Four states counting the absent one, and they are not interchangeable —
 *  each earns a different sentence and a different escape hatch:
 *
 *  - `null` with hunks — an ordinary file.
 *  - `null` with no hunks — a rename. The row names two paths and nothing is
 *    withheld.
 *  - `tooLargeUpstream` — counts kept, no patch. Re-fetching cannot help;
 *    measured on #151's 5290-change plan, which has no patch even on a page of one.
 *  - `unreported` — counts **zeroed**, no patch. Could be a binary file, a
 *    mode-only change, or the response hitting a budget; one response cannot tell
 *    them apart, and a narrower page resolves it — measured, where the same file
 *    read 0/0/0 on a page of 62 and 163/3 with a patch on a page of three.
 *  - `tooLargeLocal` — over our own cap. The bytes arrived and were dropped in
 *    Rust, so the count is exact and the refusal is ours. */
export type Omission =
  | { kind: "tooLargeUpstream" }
  | { kind: "unreported" }
  | { kind: "tooLargeLocal"; lines: number };

/** One hunk of one file's patch. Mirrors `gh_pr::Hunk`.
 *
 *  `header` is the `@@` line verbatim, kept for its trailing section context —
 *  `@@ -89,6 +91,9 @@ fn main() {` — which git writes and nothing else does.
 *  It is material for a heading, never a row to print. `oldStart`/`newStart` are
 *  parsed in Rust; the single-number form `@@ -1 +1 @@` is real and is already
 *  handled there, so nothing here re-parses a header. */
export interface Hunk {
  header: string;
  oldStart: number;
  newStart: number;
  /** Patch lines as written, leading `+`, `-`, ` ` or `\` kept. */
  lines: string[];
}

/** One changed file, as far as GitHub will describe it. Mirrors `gh_pr::DiffFile`.
 *
 *  **The identity of a file is its index in `PrDiff.files`, never `path`.** Two of
 *  549 measured responses name the same `filename` twice, as a `removed` + `added`
 *  pair — a file replaced by a symlink. Anything keyed by path silently merges
 *  those two rows into one, which is why `filesToAutoOpen` returns indices. */
export interface DiffFile {
  path: string;
  /** Set only on a rename or a copy, where the row names two paths. */
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  /** The permalink at this head — the escape hatch for everything the drawer
   *  cannot draw, so it is carried even when `hunks` is full. */
  blobUrl: string;
  hunks: Hunk[];
  omitted: Omission | null;
}

export interface PrDiff {
  /** The commit this diff actually describes — read by the backend out of the
   *  rows' `blob_url`, not taken from whatever the caller asked for.
   *
   *  This closes a hole worth naming, because the natural design has it. The
   *  files endpoint is addressed by pull request *number*, so it serves whatever
   *  HEAD is when it runs, and a slot keyed on the head believed at request time
   *  can hold a diff labelled with a commit that is not the one in it. Keying on
   *  this instead means the label is what arrived.
   *
   *  Empty when the response had no rows to read it from — a pull request that
   *  changes nothing, where there is also nothing to go stale. */
  headRefOid: string;
  files: DiffFile[];
  /** How many files the pull request touches, kept beside `files` rather than
   *  derived from its length: `files` is a capped page. */
  totalFiles: number;
}

// ---------------------------------------------------------------------------
// Marker characters and running line numbers
// ---------------------------------------------------------------------------

/** `meta` is the `\ No newline at end of file` line. It is part of the patch and
 *  is not a line of either file: it advances neither counter and belongs under
 *  the line above it. */
export type DiffLineKind = "add" | "del" | "ctx" | "meta";

/** One drawable row. `old`/`new` are null where that side has no such line — a
 *  `+` line exists only in the new file, and one column cannot answer "what line
 *  is this now" for a removed one, which is why there are two. */
export interface DiffLine {
  kind: DiffLineKind;
  old: number | null;
  new: number | null;
  /** The patch line with its marker character removed. Legitimately `""`: a
   *  blank context line arrives as a single space and slicing leaves nothing.
   *  0 of 7985 measured patch lines were the empty string before the slice. */
  text: string;
}

const MARKERS: Record<DiffLineKind, string> = {
  add: "+", del: "-", ctx: " ", meta: "\\",
};

/** The marker to draw in its own column, the exact inverse of the slice
 *  `classifyHunk` performs.
 *
 *  Relocated rather than duplicated, and a real text node rather than
 *  `::before`: the two tint bands measure 1.30 against each other where WCAG
 *  1.4.11 asks 3.0, so the literal character is doing the work colour cannot —
 *  and it is the only differentiator that survives Windows high contrast, where
 *  every tint collapses to a system colour. Keeping it as text is also what lets
 *  a copied selection reassemble into a valid patch. */
export function lineMarker(kind: DiffLineKind): string {
  return MARKERS[kind];
}

/** Turn one hunk's raw patch lines into drawable rows with running line numbers.
 *
 *  **This is where every off-by-one lives.** The counters start at the header's
 *  `oldStart`/`newStart` — parsed in Rust — and each line moves exactly the sides
 *  it exists on: `+` the new one, `-` the old one, context both, and the
 *  no-newline marker neither.
 *
 *  Two shapes worth naming because they look like edge cases and are not:
 *  `@@ -0,0 +1,26 @@` is a file added whole, where 0 is a real answer and `old`
 *  is null on every row; and `\ No newline at end of file` can appear **twice**
 *  in one patch — 22 of 7985 measured — once per side. Neither needs a branch
 *  beyond the ones below, which is the point of asserting them in tests.
 *
 *  An unrecognised first character is read as context. It cannot arrive from
 *  GitHub's two-way `patch` (only ` `, `+`, `-` and `\` do), and treating it as
 *  content would push the whole row out of the grid; the cost, recorded rather
 *  than hidden, is that `lineMarker` then renders a space where the patch had
 *  something else. */
export function classifyHunk(hunk: Hunk): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  for (const raw of hunk.lines) {
    // `charAt` and not `[0]`: an empty line yields `""` rather than `undefined`,
    // and falls through to context below with an empty text. Measured never to
    // happen, tolerated because the alternative is a crash on one odd patch.
    const text = raw.slice(1);
    switch (raw.charAt(0)) {
      case "+":
        out.push({ kind: "add", old: null, new: newNo++, text });
        break;
      case "-":
        out.push({ kind: "del", old: oldNo++, new: null, text });
        break;
      case "\\":
        out.push({ kind: "meta", old: null, new: null, text });
        break;
      default:
        out.push({ kind: "ctx", old: oldNo++, new: newNo++, text });
    }
  }
  return out;
}

/** A hunk's heading as a sentence — "Hunk 2 of 5, lines 91 to 99".
 *
 *  Never the raw `@@ -89,6 +91,9 @@`: read aloud it is noise, and this is what
 *  makes a screen reader's heading key the way through a long diff. The range is
 *  a fold rather than a field because the header's counts were deliberately
 *  dropped in Rust — `lines` is the truth about how many rows there are, and a
 *  stored count that disagrees with its own body is a count that lies.
 *
 *  `index` is zero-based, so a caller can pass the position it is already
 *  iterating with. */
export function hunkHeading(hunk: Hunk, index: number, total: number): string {
  const at = `Hunk ${index + 1} of ${total}`;
  let last: number | null = null;
  let removed = 0;
  for (const line of classifyHunk(hunk)) {
    if (line.new !== null) last = line.new;
    if (line.kind === "del") removed += 1;
  }
  if (last !== null) return `${at}, lines ${hunk.newStart} to ${last}`;
  // Nothing survives on the new side, so there is no range to name — a hunk that
  // only deletes, up to and including a file deleted whole, where `newStart` is 0
  // and "after line 0" would be a position no file has.
  const where = hunk.newStart === 0
    ? "from the start of the file"
    : `after line ${hunk.newStart}`;
  return `${at}, ${removed} line${removed === 1 ? "" : "s"} removed ${where}`;
}

// ---------------------------------------------------------------------------
// What opens on arrival
// ---------------------------------------------------------------------------

/** How many lines the drawer spends opening files before it stops.
 *
 *  ~500 is chosen against the measured render cost: the median file is 149 rows
 *  at 18 ms and all 62 of #151 at once is 246 ms, so this buys a two-file pull
 *  request that opens fully and a 62-file one that opens as an index. */
export const AUTO_OPEN_LINE_BUDGET = 500;

/** How many rows of code a file would draw. Hunk bodies only, never `@@` headers:
 *  a header becomes one heading in the view, so counting it would make a file of
 *  many small hunks cost more than a file of one big one for no reason a reader
 *  could see. Mirrors `gh_pr::cap_file`, which measures the same thing. */
export function fileLineCount(file: DiffFile): number {
  let n = 0;
  for (const h of file.hunks) n += h.lines.length;
  return n;
}

/** Which files open expanded on arrival, **by index**.
 *
 *  Indices and not paths, because a path is not an identity here: 2 of 549 real
 *  responses name the same `filename` twice as a `removed` + `added` pair, and a
 *  `Set<string>` would open or close both together.
 *
 *  Files are taken in order and the walk **stops** at the first that does not
 *  fit, rather than skipping it to fit a smaller one later: the list is the pull
 *  request's own order, and opening files 1, 2 and 7 reads as arbitrary where a
 *  prefix reads as "this is where it got long".
 *
 *  The first file opens whatever it costs. A single-file pull request of 800
 *  lines is the case the drawer exists for, and opening it as a one-row index
 *  would make the reader click the only thing on screen.
 *
 *  A file with nothing to draw still costs one line, because it still draws the
 *  sentence saying why — see `fileNote`. */
export function filesToAutoOpen(files: DiffFile[], lineBudget: number): Set<number> {
  const open = new Set<number>();
  // A caller that has budgeted nothing has asked for an index, and the
  // first-file rule below must not overrule that.
  if (lineBudget <= 0) return open;
  let spent = 0;
  for (let i = 0; i < files.length; i++) {
    const cost = Math.max(1, fileLineCount(files[i]));
    if (i > 0 && spent + cost > lineBudget) break;
    open.add(i);
    spent += cost;
  }
  return open;
}

// ---------------------------------------------------------------------------
// What the drawer says about a file it cannot draw
// ---------------------------------------------------------------------------

/** Why there is nothing to show, or null when there is a diff and the rows speak
 *  for themselves.
 *
 *  Facts only, no affordances: which buttons to offer is `canRefetch` plus
 *  `blobUrl`, and baking "Open on GitHub" into the sentence would put a button's
 *  name in a paragraph a screen reader reads before reaching the button.
 *
 *  A rename that also changed content returns null — there are rows to draw — and
 *  the two paths belong in the file's header, which shows them whenever
 *  `previousPath` is set regardless of what this returns. */
export function fileNote(file: DiffFile): string | null {
  const o = file.omitted;
  if (o === null) {
    if (file.hunks.length > 0) return null;
    if (file.previousPath !== null) {
      const verb = file.status === "copied" ? "Copied" : "Renamed";
      return `${verb} from ${file.previousPath}. The contents did not change.`;
    }
    // Unreachable through `parse_pr_files`, which reads an empty file with no
    // previous name as `unreported` rather than as unchanged — that correction is
    // the whole reason `Unreported` exists. Answered anyway, because a sentence
    // costs less than the view falling through to a blank panel.
    return "Nothing changed in this file.";
  }
  switch (o.kind) {
    case "tooLargeUpstream":
      return `GitHub sent no diff for this file: +${file.additions} −${file.deletions}`
        + " is more than it will return.";
    case "unreported":
      return "GitHub sent neither a diff nor line counts for this file,"
        + " so what changed here is not known.";
    case "tooLargeLocal":
      return `${o.lines} lines of diff — more than this app draws in one file.`;
  }
}

/** Whether asking GitHub again could produce the text.
 *
 *  Measured in both directions on #151, and the reason the states are a type
 *  rather than a flag: the 5290-change plan has no patch even fetched on a page
 *  of one, so `tooLargeUpstream` is a refusal and a "show anyway" button for it
 *  could only fail. `unreported` came back with 163 additions, 3 deletions and a
 *  patch on a page of three. `tooLargeLocal` is ours — the bytes reached Rust and
 *  were dropped before serialisation — so the same narrower fetch supplies it,
 *  which is the argument for building one mechanism and not two. */
export function canRefetch(omitted: Omission | null): boolean {
  return omitted !== null && omitted.kind !== "tooLargeUpstream";
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

/** What the drawer holds for one pull request. Absent from the caller's map means
 *  "never asked", which is not the same as any of these three. */
export type DiffSlot =
  | { state: "loading"; headRefOid: string }
  | { state: "ok"; headRefOid: string; diff: PrDiff }
  | { state: "failed"; headRefOid: string; message: string };

/** The two fields the staleness decision turns on. A whole `DiffSlot` is
 *  assignable, and a test does not have to build a `PrDiff` to ask about
 *  staleness. */
export interface DiffCacheState {
  state: DiffSlot["state"];
  headRefOid: string;
}

/** Why the question is being asked. The three are not interchangeable — the
 *  answer to "the head moved" depends entirely on whether somebody is reading. */
export type DiffCacheReason =
  /** The drawer is being opened on this pull request. Nothing of it is on screen
   *  yet, so there is nothing to protect. */
  | "open"
  /** A list poll landed while the drawer is open, possibly carrying a new head. */
  | "poll"
  /** The reader pressed Reload on the staleness bar. */
  | "reload";

export type DiffCacheDecision =
  /** Ask for the diff at this commit. */
  | { action: "fetch"; headRefOid: string }
  /** What is held is what should be shown. */
  | { action: "keep" }
  /** The head has moved and the reader is in the middle of the old diff. Show a
   *  bar; `headRefOid` is what Reload will fetch. */
  | { action: "offer-reload"; headRefOid: string };

/** Whether to fetch, keep, or tell the reader the branch moved.
 *
 *  **Keyed on `headRefOid`, not `updatedAt`.** A diff is a function of the head
 *  commit and of nothing else; `updatedAt` moves when somebody adds a label, and
 *  keying on it would throw away 2000 rows and a scroll position to redraw the
 *  identical diff.
 *
 *  **This deliberately diverges from `PrView.fetchIfStale` in `src/pr-view.ts`.**
 *  That one re-fetches the moment a poll brings a newer `updatedAt` and swaps the
 *  panel under whoever is reading it, which is right there: the panel is a
 *  diffstat and a description, small enough that a redraw costs nothing and stale
 *  numbers beside a row saying "just now" are worse than a flicker. It is wrong
 *  here. Swapping 2000 lines under a reader who has scrolled into them loses their
 *  place in a document that can be 63,000px tall, and a diff that quietly becomes
 *  a different diff is a review of code nobody looked at. So a moved head while
 *  the drawer is showing content returns `offer-reload` and never `fetch`.
 *
 *  Pure: it decides, it does not fetch. The caller keys the response it receives
 *  by the `headRefOid` it asked for and drops any answer that is no longer the
 *  one being waited on — see the different-commit case below, which starts a
 *  second request while a first is still out. */
export function diffCacheNext(
  have: DiffCacheState | null,
  headRefOid: string,
  reason: DiffCacheReason,
): DiffCacheDecision {
  // The in-flight guard outranks everything, `reload` included: two requests for
  // one commit race each other's answer, and pressing Reload twice must cost one
  // fetch.
  if (have !== null && have.state === "loading" && have.headRefOid === headRefOid) {
    return { action: "keep" };
  }
  if (have === null) return { action: "fetch", headRefOid };

  if (have.headRefOid !== headRefOid) {
    // The one case where the reader's place is worth more than freshness: they
    // are looking at a diff of the previous commit and they scrolled to get
    // there. Only `ok` qualifies — a spinner and an error message are not content
    // to be protected, and replacing either with a fresh attempt is an
    // improvement rather than a swap.
    if (reason === "poll" && have.state === "ok") {
      return { action: "offer-reload", headRefOid };
    }
    return { action: "fetch", headRefOid };
  }

  // Same commit, so the answer cannot have changed — with two exceptions.
  // An explicit request is never answered with "keep":
  if (reason === "reload") return { action: "fetch", headRefOid };
  // And reopening the drawer on a failure is a deliberate retry. A poll is not:
  // it repeats every 15 s, and retrying a broken `gh` that often is a loop, not a
  // recovery.
  if (have.state === "failed" && reason === "open") return { action: "fetch", headRefOid };
  return { action: "keep" };
}

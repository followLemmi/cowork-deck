import { describe, it, expect } from "vitest";
import {
  canRefetch, classifyHunk, diffCacheNext, fileNote, hunkHeading, lineMarker,
  type DiffLine,
} from "../src/diff";
import type { DiffFile, Hunk, Omission } from "../src/ipc";

const hunk = (over: Partial<Hunk> = {}): Hunk => ({
  header: "@@ -1,1 +1,1 @@", oldStart: 1, newStart: 1, lines: [], ...over,
});

const file = (over: Partial<DiffFile> = {}): DiffFile => ({
  path: "src/a.ts", previousPath: null, status: "modified",
  additions: 1, deletions: 0, blobUrl: "https://github.com/o/r/blob/oid/src/a.ts",
  hunks: [], omitted: null, ...over,
});

/** The three fields a numbering assertion is about, so a failure reads as a
 *  table rather than as four object diffs. */
const numbering = (lines: DiffLine[]) => lines.map((l) => [l.kind, l.old, l.new] as const);

describe("classifyHunk", () => {
  // The canonical case, asserted whole: a `-` run followed by a `+` run is where
  // a shared counter would silently misalign the two columns.
  it("advances the old side on a removal, the new side on an addition, both on context", () => {
    const h = hunk({
      header: "@@ -10,4 +20,5 @@", oldStart: 10, newStart: 20,
      lines: [" keep", "-gone", "-also gone", "+fresh", "+also fresh", "+third", " keep too"],
    });
    expect(classifyHunk(h)).toEqual<DiffLine[]>([
      { kind: "ctx", old: 10, new: 20, text: "keep" },
      { kind: "del", old: 11, new: null, text: "gone" },
      { kind: "del", old: 12, new: null, text: "also gone" },
      { kind: "add", old: null, new: 21, text: "fresh" },
      { kind: "add", old: null, new: 22, text: "also fresh" },
      { kind: "add", old: null, new: 23, text: "third" },
      { kind: "ctx", old: 13, new: 24, text: "keep too" },
    ]);
  });

  it("starts from the header's own numbers rather than from one", () => {
    const h = hunk({ oldStart: 89, newStart: 91, lines: [" a", " b"] });
    expect(numbering(classifyHunk(h))).toEqual([["ctx", 89, 91], ["ctx", 90, 92]]);
  });

  // `@@ -1 +1 @@` — git omits the count when a range covers one line. The header
  // is parsed in Rust, so all this asserts is that a one-line range folds like
  // any other; it is here because the shape looks special and is not.
  it("folds a single-line range like any other", () => {
    const h = hunk({ header: "@@ -1 +1 @@", oldStart: 1, newStart: 1, lines: ["-old", "+new"] });
    expect(numbering(classifyHunk(h))).toEqual([["del", 1, null], ["add", null, 1]]);
  });

  // A file added whole arrives as `@@ -0,0 +1,26 @@`. 0 is a real answer, and the
  // old counter must never be printed for any of its rows.
  it("leaves the old side null for every row of a file added whole", () => {
    const h = hunk({
      header: "@@ -0,0 +1,3 @@", oldStart: 0, newStart: 1,
      lines: ["+one", "+two", "+three"],
    });
    expect(numbering(classifyHunk(h))).toEqual([
      ["add", null, 1], ["add", null, 2], ["add", null, 3],
    ]);
  });

  it("leaves the new side null for every row of a file deleted whole", () => {
    const h = hunk({
      header: "@@ -1,3 +0,0 @@", oldStart: 1, newStart: 0,
      lines: ["-one", "-two", "-three"],
    });
    expect(numbering(classifyHunk(h))).toEqual([
      ["del", 1, null], ["del", 2, null], ["del", 3, null],
    ]);
  });

  // The marker is one character and the rest is content, so a blank line in the
  // file is a lone space in the patch and an empty string after the slice. That
  // is legal and must not be read as a missing line.
  it("reads a lone space as a blank context line, not as nothing", () => {
    expect(classifyHunk(hunk({ lines: [" "] }))).toEqual<DiffLine[]>([
      { kind: "ctx", old: 1, new: 1, text: "" },
    ]);
    expect(classifyHunk(hunk({ lines: ["+"] }))).toEqual<DiffLine[]>([
      { kind: "add", old: null, new: 1, text: "" },
    ]);
  });

  it("keeps leading whitespace inside the content", () => {
    const [line] = classifyHunk(hunk({ lines: ["+    indented();"] }));
    expect(line.text).toBe("    indented();");
  });

  // A removed line of a unified diff embedded in a fixture starts with `-`, and
  // only the first character is the marker.
  it("slices exactly one character, however the content starts", () => {
    expect(classifyHunk(hunk({ lines: ["--- a/x"] }))[0])
      .toEqual({ kind: "del", old: 1, new: null, text: "-- a/x" });
    expect(classifyHunk(hunk({ lines: ["+++ b/x"] }))[0])
      .toEqual({ kind: "add", old: null, new: 1, text: "++ b/x" });
  });

  // The CR is content: strip it and the `+` line no longer matches the file it
  // came from, and the copied selection the marker column exists to protect
  // stops being a valid patch. Rust already refuses to use `str::lines()` for
  // exactly this; the slice here must not undo it.
  it("treats a carriage return as content", () => {
    expect(classifyHunk(hunk({ lines: ["+new\r"] }))[0].text).toBe("new\r");
  });

  // `\ No newline at end of file` is a line of the patch and of neither file.
  it("advances no counter across the no-newline marker", () => {
    const h = hunk({
      oldStart: 1, newStart: 1,
      lines: [" a", "-b", "\\ No newline at end of file", "+c", " d"],
    });
    expect(numbering(classifyHunk(h))).toEqual([
      ["ctx", 1, 1],
      ["del", 2, null],
      ["meta", null, null],
      ["add", null, 2],
      ["ctx", 3, 3],
    ]);
  });

  it("keeps the marker line's own text, so a copied selection stays a patch", () => {
    const [, line] = classifyHunk(hunk({ lines: ["-b", "\\ No newline at end of file"] }));
    expect(line.text).toBe(" No newline at end of file");
    expect(lineMarker(line.kind) + line.text).toBe("\\ No newline at end of file");
  });

  // 22 of 7985 real patches carry two, once per side, when neither the old nor
  // the new file ends in a newline. An earlier measurement claimed one was the
  // maximum; nothing here branches on the count, and this is the case that keeps
  // it that way.
  it("survives two no-newline markers in one hunk", () => {
    const h = hunk({
      oldStart: 5, newStart: 5,
      lines: ["-old last", "\\ No newline at end of file", "+new last", "\\ No newline at end of file"],
    });
    expect(numbering(classifyHunk(h))).toEqual([
      ["del", 5, null], ["meta", null, null], ["add", null, 5], ["meta", null, null],
    ]);
  });

  it("returns nothing for a hunk with no body", () => {
    expect(classifyHunk(hunk({ lines: [] }))).toEqual([]);
  });

  // Neither can arrive from GitHub's two-way patch. Recorded rather than
  // asserted as desirable: the row stays in the grid, which is the only outcome
  // that does not corrupt every line after it.
  it("reads an unknown marker, and an empty line, as context", () => {
    expect(numbering(classifyHunk(hunk({ lines: ["?huh", ""] }))))
      .toEqual([["ctx", 1, 1], ["ctx", 2, 2]]);
  });

  it("gives every kind back the character it was sliced from", () => {
    expect(lineMarker("add")).toBe("+");
    expect(lineMarker("del")).toBe("-");
    expect(lineMarker("ctx")).toBe(" ");
    expect(lineMarker("meta")).toBe("\\");
  });

  // 2000 rows is the local cap, so this is the largest fold the drawer can ask
  // for. It is here to catch a quadratic, not to time anything.
  it("numbers a capped-size hunk consistently end to end", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => (i % 3 === 0 ? `+a${i}` : ` c${i}`));
    const out = classifyHunk(hunk({ oldStart: 1, newStart: 1, lines }));
    const adds = out.filter((l) => l.kind === "add").length;
    expect(out.length).toBe(2000);
    expect(out[out.length - 1].new).toBe(2000);
    expect(out[out.length - 1].old).toBe(2000 - adds);
  });
});

describe("hunkHeading", () => {
  it("names the new file's range, one-based against a zero-based index", () => {
    const h = hunk({ oldStart: 89, newStart: 91, lines: [" a", "+b", " c"] });
    expect(hunkHeading(h, 1, 5)).toBe("Hunk 2 of 5, lines 91 to 93");
  });

  it("names the whole range of a file added whole", () => {
    const h = hunk({
      oldStart: 0, newStart: 1, lines: Array.from({ length: 26 }, (_, i) => `+l${i}`),
    });
    expect(hunkHeading(h, 0, 1)).toBe("Hunk 1 of 1, lines 1 to 26");
  });

  // A hunk that only deletes has no range on the new side to name, so the
  // sentence has to say where the removal landed instead.
  it("says where a pure deletion landed, having no new range to name", () => {
    const h = hunk({ oldStart: 5, newStart: 4, lines: ["-a", "-b", "-c"] });
    expect(hunkHeading(h, 0, 1)).toBe("Hunk 1 of 1, 3 lines removed after line 4");
  });

  it("does not say 'after line 0' for a file deleted whole", () => {
    const h = hunk({ oldStart: 1, newStart: 0, lines: ["-a"] });
    expect(hunkHeading(h, 0, 1)).toBe("Hunk 1 of 1, 1 line removed from the start of the file");
  });

  // The marker is on neither side, so it must not extend the range past the last
  // real line.
  it("is not extended by a trailing no-newline marker", () => {
    const h = hunk({
      oldStart: 1, newStart: 1, lines: [" a", "+b", "\\ No newline at end of file"],
    });
    expect(hunkHeading(h, 0, 1)).toBe("Hunk 1 of 1, lines 1 to 2");
  });
});

describe("fileNote", () => {
  it("says nothing about a file that has a diff", () => {
    expect(fileNote(file({ hunks: [hunk({ lines: ["+a"] })] }))).toBeNull();
  });

  // The four states have to reach the reader as four sentences. Collapsing any
  // two of them offers the wrong escape hatch — and in the `unreported` case
  // would have the drawer say "nothing changed" about 166 changed lines.
  it("gives each of the four states a sentence of its own", () => {
    const notes = [
      fileNote(file({ previousPath: "old/a.ts", status: "renamed" })),
      fileNote(file({ omitted: { kind: "tooLargeUpstream" }, additions: 5290, deletions: 0 })),
      fileNote(file({ omitted: { kind: "unreported" }, additions: 0, deletions: 0 })),
      fileNote(file({ omitted: { kind: "tooLargeLocal", lines: 2506 } })),
    ];
    expect(notes.every((n) => n !== null && n.length > 0)).toBe(true);
    expect(new Set(notes).size).toBe(4);
  });

  // A rename is the one empty state that explains itself: the row names two
  // paths, which is the whole of what happened to the file.
  it("names both paths for a rename and does not call it an omission", () => {
    const note = fileNote(file({ path: "b.txt", previousPath: "a.txt", status: "renamed" }));
    expect(note).toBe("Renamed from a.txt. The contents did not change.");
  });

  it("calls a copy a copy", () => {
    const note = fileNote(file({ path: "b.txt", previousPath: "a.txt", status: "copied" }));
    expect(note).toBe("Copied from a.txt. The contents did not change.");
  });

  // A rename that also changed content has rows to draw, and its two paths
  // belong in the file's header rather than in a note that would sit above a
  // diff contradicting it.
  it("says nothing extra about a rename that also changed content", () => {
    const f = file({ previousPath: "a.txt", status: "renamed", hunks: [hunk({ lines: ["+x"] })] });
    expect(fileNote(f)).toBeNull();
  });

  it("names the counts GitHub kept when it withheld the patch", () => {
    const note = fileNote(file({
      omitted: { kind: "tooLargeUpstream" }, additions: 5290, deletions: 0,
    }));
    expect(note).toContain("5290");
    expect(note).toContain("GitHub");
  });

  // The counts are zeroed here, so the sentence must not quote them: "+0 −0" is
  // the lie the state exists to refuse to repeat.
  it("quotes no counts for a file whose counts were zeroed", () => {
    const note = fileNote(file({ omitted: { kind: "unreported" }, additions: 0, deletions: 0 }));
    expect(note).not.toContain("0");
    expect(note).toContain("not known");
  });

  it("names the exact size of a file over our own cap", () => {
    expect(fileNote(file({ omitted: { kind: "tooLargeLocal", lines: 2506 } })))
      .toContain("2506");
  });

  // `parse_pr_files` cannot produce this — an empty file with no previous name is
  // `unreported` there. The view must still have something to draw if it ever does.
  it("answers rather than falling through for the state Rust cannot produce", () => {
    expect(fileNote(file({ omitted: null, hunks: [], previousPath: null }))).toBe(
      "Nothing changed in this file.",
    );
  });
});

describe("canRefetch", () => {
  // Measured on #151 in both directions: the 5290-change plan has no patch even
  // on a page of one, and the zeroed file came back with 163/3 and a patch on a
  // page of three.
  it("refuses only the state a narrower page cannot fix", () => {
    expect(canRefetch({ kind: "tooLargeUpstream" })).toBe(false);
    expect(canRefetch({ kind: "unreported" })).toBe(true);
    expect(canRefetch({ kind: "tooLargeLocal", lines: 2506 })).toBe(true);
  });

  it("offers nothing to re-fetch for a file that is not withheld", () => {
    expect(canRefetch(null)).toBe(false);
  });

  // The two that a narrower fetch resolves are resolved by the *same* fetch,
  // which is the argument for one mechanism rather than an `uncapped_path`
  // exemption serving only one of them.
  it("names one mechanism for both resolvable states", () => {
    const resolvable: Omission[] = [{ kind: "unreported" }, { kind: "tooLargeLocal", lines: 3000 }];
    expect(resolvable.every(canRefetch)).toBe(true);
  });
});

describe("diffCacheNext", () => {
  const OLD = "aaaa1111";
  const NEW = "bbbb2222";

  it("fetches when nothing has ever been asked for", () => {
    expect(diffCacheNext(null, OLD, "open")).toEqual({ action: "fetch", headRefOid: OLD });
  });

  it("keeps what it holds while the head has not moved", () => {
    expect(diffCacheNext({ state: "ok", headRefOid: OLD }, OLD, "open")).toEqual({ action: "keep" });
    expect(diffCacheNext({ state: "ok", headRefOid: OLD }, OLD, "poll")).toEqual({ action: "keep" });
  });

  // The whole point of keying on the commit. `updatedAt` moves when somebody adds
  // a label, and there is deliberately no way to pass one in here: a diff is a
  // function of the head commit and of nothing else.
  it("fetches on a moved head when the drawer is being opened", () => {
    expect(diffCacheNext({ state: "ok", headRefOid: OLD }, NEW, "open"))
      .toEqual({ action: "fetch", headRefOid: NEW });
  });

  // The divergence from `PrView.fetchIfStale`, which swaps its panel the moment a
  // poll brings a newer stamp. Right for a diffstat, wrong for 2000 rows somebody
  // has scrolled into.
  it("never swaps the diff under a reader — it offers a reload instead", () => {
    expect(diffCacheNext({ state: "ok", headRefOid: OLD }, NEW, "poll"))
      .toEqual({ action: "offer-reload", headRefOid: NEW });
  });

  it("offers the reload against the new commit, not the one on screen", () => {
    const d = diffCacheNext({ state: "ok", headRefOid: OLD }, NEW, "poll");
    expect(d).toEqual({ action: "offer-reload", headRefOid: NEW });
    if (d.action !== "keep") expect(d.headRefOid).not.toBe(OLD);
  });

  it("fetches the new commit once the reader has pressed Reload", () => {
    expect(diffCacheNext({ state: "ok", headRefOid: OLD }, NEW, "reload"))
      .toEqual({ action: "fetch", headRefOid: NEW });
  });

  // An explicit request is never answered with "keep", even against the same
  // commit — that is what a refresh control means.
  it("re-fetches the same commit when explicitly asked to", () => {
    expect(diffCacheNext({ state: "ok", headRefOid: OLD }, OLD, "reload"))
      .toEqual({ action: "fetch", headRefOid: OLD });
  });

  // Two requests for one commit race each other's answer, and a Reload pressed
  // twice must cost one fetch.
  it("never starts a second request for a commit already in flight", () => {
    for (const reason of ["open", "poll", "reload"] as const) {
      expect(diffCacheNext({ state: "loading", headRefOid: OLD }, OLD, reason))
        .toEqual({ action: "keep" });
    }
  });

  // A spinner is not content to protect, so a head that moves mid-request is
  // followed rather than offered.
  it("follows a head that moves while a request is still out", () => {
    expect(diffCacheNext({ state: "loading", headRefOid: OLD }, NEW, "poll"))
      .toEqual({ action: "fetch", headRefOid: NEW });
  });

  // A poll repeats every 15 s while the window has focus. Retrying a broken `gh`
  // that often is a loop, not a recovery.
  it("does not retry a failure on the poll", () => {
    expect(diffCacheNext({ state: "failed", headRefOid: OLD }, OLD, "poll"))
      .toEqual({ action: "keep" });
  });

  it("retries a failure when the drawer is reopened or Reload is pressed", () => {
    expect(diffCacheNext({ state: "failed", headRefOid: OLD }, OLD, "open"))
      .toEqual({ action: "fetch", headRefOid: OLD });
    expect(diffCacheNext({ state: "failed", headRefOid: OLD }, OLD, "reload"))
      .toEqual({ action: "fetch", headRefOid: OLD });
  });

  // An error message is not a diff somebody is reading, so a new commit replaces
  // it rather than queueing behind a bar.
  it("fetches a new commit over a failure without offering a reload", () => {
    expect(diffCacheNext({ state: "failed", headRefOid: OLD }, NEW, "poll"))
      .toEqual({ action: "fetch", headRefOid: NEW });
  });

  // Only `ok` earns the bar, and only on a poll. Stated on its own so the rule
  // cannot drift into "any stale slot offers a reload".
  it("offers a reload from exactly one state and one reason", () => {
    const states = ["loading", "ok", "failed"] as const;
    const reasons = ["open", "poll", "reload"] as const;
    const offered: string[] = [];
    for (const state of states) {
      for (const reason of reasons) {
        if (diffCacheNext({ state, headRefOid: OLD }, NEW, reason).action === "offer-reload") {
          offered.push(`${state}/${reason}`);
        }
      }
    }
    expect(offered).toEqual(["ok/poll"]);
  });
});

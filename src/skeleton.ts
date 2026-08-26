// What the two GitHub lists draw while a first read is in flight.
//
// One module for both, and that is the change: the board and the pull requests
// each built their own row of grey slabs, and the stylesheet then declared every
// rule twice — `.tk-skeleton-row, .pr-skeleton-row` down the file. The class
// names stay what they were, because three test files address them and a rename
// buys nothing the eye can see; what is shared is now written once.
//
// The shape is the point. Six identical 44px slabs said "something is coming"
// and nothing else, and then the list arrived at 120px a row and the page jumped.
// A placeholder that carries the shape of the row it stands in for — a number, a
// title, a line of body, a couple of chips — says WHICH list is coming, and lands
// close enough in height that the arrival is a fill rather than a shove.

/** Which of the two lists this is standing in for. `tk` is the board's issue
 *  list, `pr` the pull requests: the same skeleton, one line shorter, because a
 *  pull request row carries no excerpt. */
export type SkeletonKind = "tk" | "pr";

/** Deterministic widths, not random ones. A ragged edge is what makes a stack of
 *  bars read as text rather than as a table, and a fixed cycle gives every render
 *  the same ragged edge — a placeholder that reshuffles itself between two paints
 *  is a placeholder that flickers. */
const TITLE_WIDTHS = ["64%", "46%", "72%", "55%", "68%", "50%"];
const TEXT_WIDTHS = ["88%", "72%", "94%", "66%", "80%", "76%"];
const CHIP_WIDTHS = [
  ["3.5rem", "2.5rem"], ["2.5rem", "4rem"], ["4rem", "3rem"],
  ["3rem", "3.5rem"], ["2.5rem", "3rem"], ["3.5rem", "2.5rem"],
];

function bar(cls: string, width?: string): HTMLElement {
  const b = document.createElement("span");
  b.className = `skel-bar ${cls}`;
  if (width) b.style.width = width;
  return b;
}

function row(kind: SkeletonKind, i: number): HTMLElement {
  const r = document.createElement("div");
  r.className = `${kind}-skeleton-row skel-row`;
  /* The index, for CSS to stagger from. One custom property rather than a rule
     per child: the old file delayed `:nth-child(2)` and `:nth-child(3)` and
     stopped there, so rows four, five and six pulsed in lockstep with the first
     — the wave died a third of the way down the list. */
  r.style.setProperty("--i", String(i));

  const lines = document.createElement("div");
  lines.className = "skel-lines";

  if (kind === "tk") {
    // The issue number has a column of its own in `.tk-row`, so it has one here.
    r.append(bar("skel-num"));
    lines.append(bar("skel-title", TITLE_WIDTHS[i % TITLE_WIDTHS.length]));
    lines.append(bar("skel-text", TEXT_WIDTHS[i % TEXT_WIDTHS.length]));
  } else {
    // A pull request row opens with `#128` on the title's own line.
    const head = document.createElement("div");
    head.className = "skel-head";
    head.append(bar("skel-num"), bar("skel-title", TITLE_WIDTHS[i % TITLE_WIDTHS.length]));
    lines.append(head);
  }

  const meta = document.createElement("div");
  meta.className = "skel-meta";
  const [a, b] = CHIP_WIDTHS[i % CHIP_WIDTHS.length];
  meta.append(bar("skel-chip", a), bar("skel-chip", b), bar("skel-when"));
  lines.append(meta);

  /* A pull request row carries a third band the issue row does not: the buttons
     under it. Without it the placeholder is two thirds of the height of the thing
     it stands in for, which is the shove this shape exists to avoid. */
  if (kind === "pr") {
    const acts = document.createElement("div");
    acts.className = "skel-acts";
    acts.append(bar("skel-btn", "2.5rem"), bar("skel-btn", "4rem"), bar("skel-btn", "3.5rem"));
    lines.append(acts);
  }

  r.append(lines);
  return r;
}

/** The whole placeholder: one live sentence, and the rows behind it.
 *
 *  `aria-hidden` on the rows, with the sentence left readable: to a screen reader
 *  six shapes of nothing are six pieces of nothing, and "Loading…" is the whole of
 *  what they say to anybody else either. */
export function skeleton(kind: SkeletonKind, count: number): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = `${kind}-skeleton`;
  const text = document.createElement("p");
  text.className = `${kind}-skeleton-text`;
  text.textContent = "Loading…";
  wrap.append(text);
  const rows = document.createElement("div");
  rows.className = `${kind}-skeleton-rows`;
  rows.setAttribute("aria-hidden", "true");
  for (let i = 0; i < count; i++) rows.append(row(kind, i));
  wrap.append(rows);
  return wrap;
}

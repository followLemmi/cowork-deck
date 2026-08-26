/** The tools that belong to ONE session, inside its tile, and only when it is zoomed.
 *
 *  Why they are not in the app's panel: a session launched on an issue runs in a
 *  worktree of its own. "Which files are here" and "what have I changed" are
 *  per-session questions, and the panel on the left cannot answer them — it does
 *  not know which of a dozen sessions is being asked about. So the answer lives
 *  inside the tile's frame, on the opposite edge from the app panel, and states
 *  its scope in its own header. Containment and distance do the telling; a label
 *  alone would not.
 *
 *  Why only in zoom: at deck size a tile is 400px wide and the terminal is the
 *  whole point of it. There is no room to take, and nothing to take it for.
 *
 *  THE 80-COLUMN FLOOR is the rule this file exists to keep. `fit()` follows
 *  whatever box the terminal sits in, so a panel that narrows the terminal
 *  re-wraps the agent's output — and this app has already shipped that bug once,
 *  when the filmstrip resized a PTY to roughly 22 columns by 3 rows. Above the
 *  floor the panel takes its room from the terminal; below it, the panel floats
 *  over the terminal instead. Floating costs some output being covered. Squeezing
 *  costs the transcript.
 */
import { icon, iconButton, type IconName } from "./icons";
import { wireResizer } from "./resize";
import { gitChanges, revealPath, worktreeFiles, type GitChange } from "./ipc";

/** What the panel needs to know about the session it belongs to. */
export interface TileToolsHost {
  /** The folder this session runs in — the panel's whole scope, and what it says
   *  in its header so the two panel systems can never be confused. */
  cwd: string;
  /** What the terminal is showing right now, for the floor below. */
  cols(): number;
  /** Where the terminal's box is, for the same reason. */
  termWidth(): number;
  /** What launched this session. Three real answers and no fourth: a scenario, a
   *  card or an issue, or a person. */
  source(): { kind: string; detail: string | null; prompt: string | null };
  /** Remember how wide this panel was dragged. One width for the app, not one per
   *  tile: a person sizing this panel is sizing the tool, and every session's
   *  tools are the same tool. */
  onWidth(px: number): void;
}

/** One tool: a glyph on the strip, a name in the header, and a scope line that
 *  says what this particular reading is OF. */
interface Tool {
  id: "files" | "changes" | "source";
  icon: IconName;
  name: string;
}

const TOOLS: Tool[] = [
  { id: "files", icon: "folder", name: "Files" },
  { id: "changes", icon: "git-branch", name: "Changes" },
  { id: "source", icon: "list", name: "Source" },
];

/** How wide the panel asks to be, in px at the 16px base. Matched by
 *  `.tile-panel`'s own width in the stylesheet; a mismatch would make the floor
 *  measure a box that is not the one the panel takes. */
const PANEL_PX = 304;

/** Whether opening a panel of `panelPx` would take the terminal under 80
 *  columns.
 *
 *  Measured from what the terminal is showing rather than from a font metric:
 *  `width / cols` is the cell width including whatever letter-spacing and
 *  scrollbar the box actually has, and it needs no agreement with the stylesheet.
 *  A terminal that has not laid out yet (`cols` of 0) cannot be measured, and the
 *  answer then is "float": covering output is recoverable, re-wrapping a
 *  transcript is not.
 */
export function wouldSqueeze(termWidth: number, cols: number, panelPx = PANEL_PX): boolean {
  if (cols <= 0 || termWidth <= 0) return true;
  const cell = termWidth / cols;
  return (termWidth - panelPx) / cell < 80;
}

/** A folder in the file tree, or a file. Built from paths because that is what
 *  `git ls-files` returns, and because the alternative — walking directories —
 *  would need this code to know which of them are worth showing. */
export interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  children: TreeNode[];
}

/** Paths to a tree, folders before files and each level in name order.
 *
 *  Sorting is here rather than left to git: `ls-files` sorts by full path, which
 *  interleaves a directory's own files with the directories beside it once the
 *  names share a prefix. A tree that is nearly sorted reads worse than one that is
 *  not sorted at all, because the eye stops trusting it.
 */
export function fileTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", dir: true, children: [] };
  for (const p of paths) {
    const parts = p.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      let next = node.children.find((c) => c.name === part && c.dir === !isFile);
      if (!next) {
        next = { name: part, path: parts.slice(0, i + 1).join("/"), dir: !isFile, children: [] };
        node.children.push(next);
      }
      node = next;
    });
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

export class TileTools {
  /** The strip of glyphs, on the tile's right edge. */
  readonly rail = document.createElement("div");
  /** The panel the strip opens, between the terminal and the strip. */
  readonly panel = document.createElement("div");
  private body = document.createElement("div");
  private nameEl = document.createElement("span");
  private scopeEl = document.createElement("span");
  private buttons = new Map<Tool["id"], HTMLButtonElement>();
  private open: Tool["id"] | null = null;
  /** Which folders the file tree has been opened at. Kept across re-reads, so a
   *  refresh does not fold everything a person just opened. */
  private expanded = new Set<string>();

  constructor(private host: TileToolsHost) {
    this.rail.className = "tile-tools";
    this.panel.className = "tile-panel is-shut";

    const head = document.createElement("div");
    head.className = "tool-head";
    const titles = document.createElement("div");
    titles.className = "tool-titles";
    this.nameEl.className = "tool-name";
    /* Always the folder, and always present: with two panel systems on screen,
       "whose files are these" is the question that breaks the idea. */
    this.scopeEl.className = "tool-scope";
    titles.append(this.nameEl, this.scopeEl);
    const shut = iconButton("x", "Close this tool", "tool-shut");
    shut.onclick = () => this.close();
    head.append(titles, shut);
    this.body.className = "tool-body";
    /* The panel's own edge, draggable. Its floor is the 80-column rule and not a
       number: dragging it wider is allowed right up to the point where the
       terminal would drop under 80 columns, and past that the panel floats instead
       — which `refit` decides on every frame. */
    const grip = document.createElement("div");
    grip.className = "tool-grip";
    wireResizer({
      grip,
      grow: "left",
      label: "Tool panel width",
      min: 240,
      max: () => Math.max(240, Math.round(this.host.termWidth() * 0.8)),
      read: () => this.widthPx(),
      write: (px) => {
        this.panel.style.setProperty("--tool-w", `${px}px`);
        this.refit();
      },
      commit: (px) => this.host.onWidth(Math.round(px)),
    });
    this.panel.append(grip, head, this.body);

    for (const t of TOOLS) {
      const b = iconButton(t.icon, t.name, "tool-btn");
      b.setAttribute("aria-pressed", "false");
      b.onclick = () => (this.open === t.id ? this.close() : void this.show(t));
      this.buttons.set(t.id, b);
      this.rail.append(b);
    }
  }

  /** The panel exists only while the tile is zoomed. Leaving zoom shuts it rather
   *  than remembering it: a tile that comes back zoomed with a panel already
   *  taking a third of its width is a tile whose terminal silently re-wrapped. */
  setZoomed(on: boolean) {
    if (!on) this.close();
  }

  /** Re-check the column floor without re-reading anything.
   *
   *  Called when something else moved the terminal's box — the app panel's grip,
   *  the drawer, a window resize. The floor is not a one-time decision: a panel
   *  that squeezed politely at 1680px is a panel that re-wraps a transcript at
   *  1100px, and nothing about the open tool changed in between. */
  refit() {
    if (this.open === null) return;
    this.panel.classList.toggle(
      "is-floating",
      wouldSqueeze(this.host.termWidth(), this.host.cols(), this.widthPx()),
    );
  }

  /** How wide the panel is asking to be right now: the person's width if they have
   *  dragged one, and the stylesheet's otherwise. Read from the box rather than
   *  from the stored number, because the stored number is not the whole story —
   *  `min()` in the rule can be the thing that wins. */
  private widthPx(): number {
    const w = this.panel.getBoundingClientRect().width;
    return w > 0 ? w : PANEL_PX;
  }

  /** Re-read whatever is open. Called when the tile's own state changes: a session
   *  that just finished a turn has usually just changed files. */
  refresh() {
    const t = TOOLS.find((x) => x.id === this.open);
    if (t) void this.show(t);
  }

  /** The folder, short enough for a 19rem column and still identifying.
   *
   *  The last two segments, because that is where a worktree's name is: three
   *  sessions on three branches of one project differ in the last segment and
   *  nowhere else, so an ellipsis at the END would keep the part that is the same
   *  for all of them. The whole path is in the tooltip. */
  private setScope(cwd: string, keep = 2) {
    const parts = cwd.split("/").filter(Boolean);
    this.scopeEl.textContent = parts.length > keep ? `…/${parts.slice(-keep).join("/")}` : cwd;
    this.scopeEl.title = cwd;
  }

  private close() {
    this.open = null;
    this.panel.classList.add("is-shut");
    this.panel.classList.remove("is-floating");
    for (const b of this.buttons.values()) b.setAttribute("aria-pressed", "false");
  }

  private async show(t: Tool) {
    this.open = t.id;
    for (const [id, b] of this.buttons) b.setAttribute("aria-pressed", String(id === t.id));
    this.nameEl.textContent = t.name;
    this.setScope(this.host.cwd);
    this.panel.classList.remove("is-shut");
    /* The floor, checked on the way in and again when the tile is resized by
       anything else. `is-floating` is what the stylesheet reads. */
    this.panel.classList.toggle(
      "is-floating",
      wouldSqueeze(this.host.termWidth(), this.host.cols(), this.widthPx()),
    );
    if (t.id === "source") { this.drawSource(); return; }
    /* A read of a checkout is a process. Saying so beats an empty panel that
       looks like an answer — and it is one line, not a skeleton, because a file
       list has no shape to promise before it arrives. */
    this.body.replaceChildren(note("Reading the checkout…"));
    if (t.id === "files") await this.drawFiles();
    else await this.drawChanges();
  }

  private async drawFiles() {
    let paths: string[] = [];
    try {
      paths = await worktreeFiles(this.host.cwd);
    } catch (e) {
      this.body.replaceChildren(note(`Could not read this folder: ${String(e)}`));
      return;
    }
    if (this.open !== "files") return; // another tool won the race
    if (paths.length === 0) {
      this.body.replaceChildren(note(
        "Nothing here that git tracks or would track. An empty checkout, or a folder "
        + "that is not a repository at all.",
      ));
      return;
    }
    const tree = document.createElement("div");
    tree.className = "tool-tree";
    const draw = (nodes: TreeNode[], depth: number, into: HTMLElement) => {
      for (const n of nodes) {
        const row = document.createElement("button");
        row.className = "tree-row";
        row.style.setProperty("--depth", String(depth));
        if (n.dir) {
          const isOpen = this.expanded.has(n.path);
          row.setAttribute("aria-expanded", String(isOpen));
          const caret = icon("chevron", 12);
          caret.classList.add("tree-caret");
          if (isOpen) caret.classList.add("icon--down");
          row.append(caret, icon("folder", 13));
        } else {
          const pad = document.createElement("span");
          pad.className = "tree-pad";
          row.append(pad, icon("book", 13));
        }
        const label = document.createElement("span");
        label.className = "tree-name";
        label.textContent = n.name;
        row.append(label);
        row.title = n.path;
        row.onclick = n.dir
          ? () => {
            if (this.expanded.has(n.path)) this.expanded.delete(n.path);
            else this.expanded.add(n.path);
            void this.drawFiles();
          }
          /* Reveal, never open: this app does not decide which program a file
             belongs to. The same choice `revealPath` documents for a transcript. */
          : () => { void revealPath(`${this.host.cwd}/${n.path}`).catch(() => {}); };
        into.append(row);
        if (n.dir && this.expanded.has(n.path)) draw(n.children, depth + 1, into);
      }
    };
    draw(fileTree(paths), 0, tree);
    this.body.replaceChildren(tree);
  }

  private async drawChanges() {
    let changes;
    try {
      changes = await gitChanges(this.host.cwd);
    } catch (e) {
      this.body.replaceChildren(note(`Could not read this checkout: ${String(e)}`));
      return;
    }
    if (this.open !== "changes") return;
    /* The branch belongs in the scope line, next to the folder: "what has changed"
       is only answerable against a branch, and this panel's whole job is saying
       which checkout it is talking about. */
    /* The branch belongs in the scope line beside the folder: "what has changed" is
       only answerable against a branch. It costs the folder a segment — one is
       enough once the branch is beside it, and both clipped would say neither. */
    if (changes.branch) {
      this.setScope(this.host.cwd, 1);
      this.scopeEl.textContent += ` · ${changes.branch}`;
      this.scopeEl.title = `${this.host.cwd} · ${changes.branch}`;
    }
    if (changes.files.length === 0) {
      this.body.replaceChildren(note(
        changes.branch
          ? `Nothing changed on ${changes.branch}.`
          : "Not a git checkout, so there is nothing to compare.",
      ));
      return;
    }
    const list = document.createElement("div");
    list.className = "tool-changes";
    for (const c of changes.files) list.append(changeRow(c, this.host.cwd));
    this.body.replaceChildren(list, summary(changes.files));
  }

  private drawSource() {
    const s = this.host.source();
    const wrap = document.createElement("div");
    wrap.className = "tool-source";
    const kind = document.createElement("p");
    kind.className = "tool-source-kind";
    kind.textContent = s.detail ? `${s.kind} · ${s.detail}` : s.kind;
    wrap.append(kind);
    if (s.prompt) {
      const pre = document.createElement("pre");
      pre.className = "tool-source-prompt";
      /* The prompt as it was sent, wrapped and not truncated: it is the one thing
         about a session that cannot be reconstructed from anything else on screen. */
      pre.textContent = s.prompt;
      wrap.append(pre);
    } else {
      wrap.append(note("No prompt: this session was opened empty and typed into."));
    }
    this.body.replaceChildren(wrap);
  }
}

function note(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "tool-note";
  p.textContent = text;
  return p;
}

function changeRow(c: GitChange, cwd: string): HTMLElement {
  const row = document.createElement("button");
  row.className = "chg-row";
  const mark = document.createElement("span");
  mark.className = `chg-mark chg-mark--${c.mark.toLowerCase().replace(/[^a-z]/, "q")}`;
  mark.textContent = c.mark;
  /* The letter is git's, and the tooltip is what it means — for the reader who has
     not spent a decade reading porcelain. */
  mark.title = MARKS[c.mark] ?? "changed";
  const path = document.createElement("span");
  path.className = "chg-path";
  path.textContent = c.path;
  row.append(mark, path);
  /* Only the side that happened. A new file reads `+141`, not `+141 −0`: a zero
     beside a number is a column, and this is a row of three files. */
  if (c.added > 0) {
    const plus = document.createElement("span");
    plus.className = "chg-plus"; plus.textContent = `+${c.added}`;
    row.append(plus);
  }
  if (c.removed > 0) {
    const minus = document.createElement("span");
    minus.className = "chg-minus"; minus.textContent = `−${c.removed}`;
    row.append(minus);
  }
  row.title = c.path;
  row.onclick = () => { void revealPath(`${cwd}/${c.path}`).catch(() => {}); };
  return row;
}

const MARKS: Record<string, string> = {
  M: "modified", A: "added", D: "deleted", R: "renamed",
  C: "copied", U: "conflicted", "?": "untracked, and not ignored",
};

function summary(files: GitChange[]): HTMLElement {
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const untracked = files.filter((f) => f.mark === "?").length;
  const p = note(
    `${files.length} file${files.length === 1 ? "" : "s"} · +${added} −${removed}`
    /* Said out loud, because the two numbers above do not include them and a total
       that quietly omits part of its list is worse than no total. */
    + (untracked > 0 ? ` · ${untracked} untracked, not counted` : ""),
  );
  p.classList.add("tool-total");
  return p;
}

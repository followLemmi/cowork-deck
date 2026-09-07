// The panel that answers what a session actually did.
//
// A tile already says what a session costs — `ctx 83.7k`, with the spend behind
// its tooltip. It says nothing about what the session did, and the only way to
// learn that one of twelve tiles has run 334 `Bash` calls and nothing else, or
// that a subagent nobody asked about did most of the work, is to scroll a
// terminal back by hand.
//
// The numbers come from the agent's own log, never from the hooks the deck
// installs. Which means they are retrospective — they cover the whole
// conversation, including the part that happened before this window was open —
// and they stop being fresh the moment the log does. See `docs/adr/`.

import { openDialog } from "./dialog-shell";
import { icon } from "./icons";
import { formatContext, tokenTooltip } from "./observability";
import type {
  ActivityRoll,
  AgentTally,
  SessionTokens,
  ToolCategory,
  ToolTally,
  Unavailable,
} from "./ipc";

/** What the head calls each CLI. A name a person would recognise, not the enum. */
const CLI_LABEL: Record<string, string> = {
  claude: "Claude Code",
  copilot: "Copilot CLI",
  opencode: "opencode",
  codex: "Codex CLI",
};

/** The chip beside a native name. Short, because the name is what a row is for. */
const CATEGORY_LABEL: Record<ToolCategory, string> = {
  run: "run",
  read: "read",
  edit: "edit",
  search: "search",
  web: "web",
  mcp: "mcp",
  delegate: "delegate",
  task: "task",
  ask: "ask",
  other: "other",
};

/** The three-and-a-bit empty states, each its own sentence.
 *
 *  Never zeroes. `SessionSnapshot` hides the token badge rather than drawing
 *  four of them for exactly this reason: a panel of zeroes is indistinguishable
 *  from a session that did nothing. */
export function unavailableSentence(why: Unavailable, cli: string): string {
  switch (why) {
    case "notAnAgent":
      return "This tile runs a command, not an agent — there is no conversation to read.";
    case "noReader":
      return `No reader for ${CLI_LABEL[cli] ?? cli} yet, so its log has not been read.`;
    case "unreadable":
      return "This session's log could not be opened. It may have been deleted since.";
    case "noLog":
    default:
      return "No log for this session yet.";
  }
}

/** A roll a caller can build without asking the backend. The frontend is where a
 *  tile's kind is known, and a `command` tile is not an agent session — asking
 *  the backend to look for a transcript that will never exist, so it can answer
 *  "no log", would be the wrong sentence arrived at expensively. */
export function localRoll(why: Unavailable): ActivityRoll {
  return {
    cli: "claude",
    agents: [],
    tools: [],
    calls: 0,
    capabilities: { outcomes: false, agents: false },
    readAt: Math.floor(Date.now() / 1000),
    unavailable: why,
    truncated: null,
  };
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** `3 errors`, `1 refused` — and nothing at all when there is neither.
 *
 *  The rule `tokenTooltip` already follows for its subagent line: a figure is
 *  worth stating only when there is one. A row reading `12 · 0 errors · 0
 *  refused` says the same thing as `12` at three times the width. */
export function outcomeSuffix(t: { errors: number; denials: number }): string {
  const parts: string[] = [];
  if (t.errors > 0) parts.push(`${t.errors} ${t.errors === 1 ? "error" : "errors"}`);
  if (t.denials > 0) parts.push(`${t.denials} refused`);
  return parts.join(" · ");
}

/** Every MCP server in a roll, with what was called through it. Rendered only
 *  when there are MCP calls at all: over one project's transcripts 13 of 26
 *  distinct tool names were MCP across just two servers, and without this the
 *  tool list is a wall of `mcp__claude-in-chrome__*`. */
export function byServer(tools: ToolTally[]): { server: string; calls: number; tools: number }[] {
  const seen = new Map<string, { server: string; calls: number; tools: number }>();
  for (const t of tools) {
    if (t.category !== "mcp" || !t.server) continue;
    const row = seen.get(t.server) ?? { server: t.server, calls: 0, tools: 0 };
    row.calls += t.calls;
    row.tools += 1;
    seen.set(t.server, row);
  }
  return [...seen.values()].sort((a, b) => b.calls - a.calls || a.server.localeCompare(b.server));
}

/** The name a subagent row reads. `agentType — description` where the metadata
 *  gave both, and the file stem where it gave neither — a subagent whose
 *  metadata was missing keeps its calls and loses only its name. */
export function agentLabel(a: AgentTally): string {
  if (a.kind === "main") return "main chain";
  const parts = [a.agentType, a.description].filter((s): s is string => !!s);
  return parts.length > 0 ? parts.join(" — ") : a.id;
}

/** One `name · chip · bar · count` row. `max` scales the bar; a roll whose
 *  largest row is 1 still draws a full bar for it rather than a sliver. */
function toolRow(t: ToolTally, max: number, outcomes: boolean): HTMLElement {
  const row = el("div", "act-row");
  row.dataset.tool = t.native;
  const name = el("span", "act-row-name", t.native);
  name.title = t.native;
  const chip = el("span", `act-chip act-chip--${t.category}`, CATEGORY_LABEL[t.category]);
  const track = el("span", "act-bar");
  const fill = el("span", "act-bar-fill");
  fill.style.width = `${max > 0 ? Math.max(2, Math.round((t.calls / max) * 100)) : 0}%`;
  track.append(fill);
  const count = el("span", "act-row-count", String(t.calls));
  row.append(name, chip, track, count);
  // Driven by the reader's declared capability, not by the data: a reader that
  // cannot tell a failure from a success would otherwise report zero of each,
  // which reads as "nothing failed".
  if (outcomes) {
    const suffix = outcomeSuffix(t);
    if (suffix) row.append(el("span", "act-row-outcome", suffix));
  }
  return row;
}

function section(title: string, className: string): HTMLElement {
  const s = el("section", `act-section ${className}`);
  s.append(el("h3", "act-section-title", title));
  return s;
}

/** The head: what this session is, and the figures worth reading at a glance.
 *
 *  The token figures are `observability.ts` verbatim. `formatContext` and
 *  `tokenTooltip` already phrase those numbers on the badge, and a second
 *  phrasing of one measurement in a second place is a disagreement waiting to
 *  happen. */
function head(name: string, roll: ActivityRoll, tokens: SessionTokens | null): HTMLElement {
  const h = el("header", "act-head");
  const title = el("h2", "act-title", name);
  title.id = "act-title";
  h.append(title);

  const facts = el("div", "act-facts");
  facts.append(el("span", "act-fact act-fact--cli", CLI_LABEL[roll.cli] ?? roll.cli));
  if (!roll.unavailable) {
    const distinct = roll.tools.length;
    facts.append(
      el("span", "act-fact", `${roll.calls} ${roll.calls === 1 ? "call" : "calls"}`),
      el("span", "act-fact", `${distinct} ${distinct === 1 ? "tool" : "tools"}`),
    );
    if (roll.capabilities.outcomes) {
      const totals = roll.tools.reduce(
        (a, t) => ({ errors: a.errors + t.errors, denials: a.denials + t.denials }),
        { errors: 0, denials: 0 },
      );
      const suffix = outcomeSuffix(totals);
      if (suffix) facts.append(el("span", "act-fact act-fact--bad", suffix));
    }
  }
  if (tokens) {
    const ctx = el("span", "act-fact act-fact--ctx", formatContext(tokens.context));
    ctx.title = tokenTooltip(tokens);
    facts.append(ctx);
  }
  h.append(facts);
  return h;
}

/** Fill `body` with what this roll says. Separate from opening the dialog so
 *  the tick can repaint an open panel without rebuilding the shell around it. */
export function renderRoll(
  body: HTMLElement,
  name: string,
  roll: ActivityRoll,
  tokens: SessionTokens | null,
): void {
  body.replaceChildren();
  body.append(head(name, roll, tokens));

  if (roll.unavailable) {
    const empty = el("p", "act-empty act-empty--unavailable", unavailableSentence(roll.unavailable, roll.cli));
    empty.dataset.state = roll.unavailable;
    body.append(empty);
    return;
  }

  if (roll.calls === 0) {
    // The log is here and this session has made no calls. A different sentence
    // from "there is no log", and the honest reading for a session that has only
    // been talked to.
    const empty = el("p", "act-empty act-empty--quiet", "No tool calls yet.");
    empty.dataset.state = "noCalls";
    body.append(empty);
    return;
  }

  if (roll.truncated !== null) {
    body.append(
      el(
        "p",
        "act-note",
        `Stopped after ${roll.truncated} files — this log is a tree and the read is bounded, so the counts below are a floor.`,
      ),
    );
  }

  const max = roll.tools.reduce((m, t) => Math.max(m, t.calls), 0);

  const tools = section("By tool", "act-section--tools");
  const list = el("div", "act-list");
  for (const t of roll.tools) list.append(toolRow(t, max, roll.capabilities.outcomes));
  tools.append(list);
  body.append(tools);

  // Omitted rather than drawn as a one-row tree for a CLI whose log does not
  // attribute delegated work — the capability, again, rather than the data.
  if (roll.capabilities.agents) {
    const agents = section("By agent", "act-section--agents");
    const list = el("div", "act-list");
    for (const a of roll.agents) {
      const row = el("div", "act-agent");
      row.dataset.agent = a.id;
      row.style.setProperty("--act-depth", String(a.depth));
      const label = el("span", "act-agent-name", agentLabel(a));
      label.title = agentLabel(a);
      const count = el("span", "act-row-count", `${a.calls}`);
      // This is the section that answers the question the terminal cannot: a
      // session whose work was mostly delegated looks idle in its own scrollback.
      const top = a.tools
        .slice(0, 3)
        .map((t) => `${t.native} ${t.calls}`)
        .join(" · ");
      row.append(label, count);
      if (top) row.append(el("span", "act-agent-top", top));
      list.append(row);
    }
    agents.append(list);
    body.append(agents);
  }

  const servers = byServer(roll.tools);
  if (servers.length > 0) {
    const mcp = section("By MCP server", "act-section--mcp");
    const list = el("div", "act-list");
    for (const s of servers) {
      const row = el("div", "act-server");
      row.dataset.server = s.server;
      row.append(
        el("span", "act-row-name", s.server),
        el("span", "act-row-count", String(s.calls)),
        el("span", "act-agent-top", `${s.tools} ${s.tools === 1 ? "tool" : "tools"}`),
      );
      list.append(row);
    }
    mcp.append(list);
    body.append(mcp);
  }
}

export interface ActivityPanelOptions {
  session: string;
  name: string;
  /** The roll to draw first, so the panel is never blank while a read is in
   *  flight. A `command` tile passes `localRoll("notAnAgent")` and no reader. */
  initial: ActivityRoll;
  /** Ask for a fresh roll. Absent for a tile whose answer cannot change. */
  read?: () => Promise<ActivityRoll | null>;
  /** The token figures, phrased by `observability.ts` and shown verbatim. */
  tokens?: () => SessionTokens | null;
}

export interface ActivityPanel {
  /** Repaint from a fresh read. The tick calls this, and only while the panel
   *  is on screen — closing it is what stops the extra reads, which is the whole
   *  cost argument for not putting this on the poll. */
  refresh: () => Promise<void>;
  close: () => void;
  /** For the caller's own bookkeeping and for tests. */
  body: HTMLElement;
}

/** Open the panel for one session.
 *
 *  A modal through `openDialog`, not a popover and not a third drawer. A popover
 *  anchored inside a tile is unreadable at the tile sizes a grid of twelve
 *  produces, which is the layout this app is for; `drawer.ts` is the terminal
 *  drawer and `.pr-drawer` belongs to the pull-request screen, so a third global
 *  drawer for per-tile content is a surface to maintain for no gain; and
 *  `dialog-shell` already carries Escape, the focus trap, the backdrop and the
 *  stacking guard that stops one Enter accepting every open dialog. */
export function openActivityPanel(opts: ActivityPanelOptions): ActivityPanel {
  let closed = false;
  const { box, close: closeDialog } = openDialog({
    onCancel: () => close(),
    // Enter is the same as Escape here: the panel reports and decides nothing,
    // so there is no accept to distinguish.
    onAccept: () => close(),
    labelledBy: "act-title",
  });
  box.classList.add("act-box");

  const body = el("div", "act-body");
  const foot = el("div", "act-foot");
  const done = document.createElement("button");
  done.className = "modal-ok";
  done.textContent = "Close";
  done.onclick = () => close();
  foot.append(done);
  box.append(body, foot);

  const close = () => {
    if (closed) return;
    closed = true;
    closeDialog();
  };

  const draw = (roll: ActivityRoll) => {
    // A scroll position survives a repaint: the panel is re-read on the tick,
    // and a list that jumped back to the top every five seconds would be
    // unusable on the session with 21 distinct tools this was measured against.
    const top = body.scrollTop;
    renderRoll(body, opts.name, roll, opts.tokens?.() ?? null);
    body.scrollTop = top;
  };

  draw(opts.initial);
  done.focus();

  const refresh = async () => {
    if (closed || !opts.read) return;
    try {
      const roll = await opts.read();
      if (closed || !roll) return;
      draw(roll);
    } catch (e) {
      // A failed read leaves what is already on screen. The numbers being one
      // tick stale is a better answer than the panel emptying itself.
      console.debug("session activity read failed", e);
    }
  };
  void refresh();

  return { refresh, close, body };
}

/** The button that opens it, carrying the session's call count.
 *
 *  Always in the DOM — so it is in the tab order and reachable by touch — and
 *  hidden by the stylesheet until the tile is hovered, active or holds focus,
 *  which is the rule `tile-rename` documents. The head is already crowded, so
 *  this earns its width the same way its neighbours do and no other way. */
export function activityButton(): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "tile-close tile-activity";
  b.type = "button";
  b.append(icon("chart", 14));
  const count = el("span", "tile-activity-count");
  b.append(count);
  setActivityCount(b, null);
  return b;
}

/** Put a call count on the button, or take it off.
 *
 *  `null` is the reading being unavailable and hides the number; `0` is a
 *  session that has made no calls and shows one. The button stays either way —
 *  the panel has a sentence for every case, and a control that comes and goes
 *  is a control nobody learns. */
export function setActivityCount(btn: HTMLElement, calls: number | null): void {
  const count = btn.querySelector<HTMLElement>(".tile-activity-count");
  if (!count) return;
  if (calls === null) {
    count.textContent = "";
    count.classList.add("hidden");
    btn.setAttribute("aria-label", "Session activity");
    btn.title = "Session activity";
    return;
  }
  count.textContent = String(calls);
  count.classList.remove("hidden");
  const label = `Session activity — ${calls} tool ${calls === 1 ? "call" : "calls"}`;
  btn.setAttribute("aria-label", label);
  btn.title = label;
}

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { startSession, startCommandSession, writeSession, resizeSession, type ScenarioLaunch, type SessionAuth } from "./ipc";
import { matchHotkey, isMacPlatform } from "./commands";
import { terminalKeyBytes } from "./terminal-keys";
import { currentScale, terminalFontPx, UI_SCALE_EVENT } from "./ui-scale";

/** How long a size has to stand still before the PTY is told about it.
 *
 *  A resize is not a repaint. It is an ioctl, a `SIGWINCH`, and a full-screen redraw
 *  by whatever is running in the terminal — `claude` answers one by drawing its whole
 *  interface again, and that output comes back to be parsed and painted. Measured on
 *  a drag of the terminal drawer's grip: 81 `pointermove` events produced 150
 *  `resize_session` calls, so the agent was asked to repaint itself a hundred and
 *  fifty times for one gesture, and the app to paint every answer.
 *
 *  100 ms is short enough to feel immediate on a discrete resize — a window snap, a
 *  zoom — and long enough that a drag of any human speed lands one resize at its end.
 *  xterm's own geometry is not held back by it: the terminal follows the pointer, and
 *  it is only the child process that waits. */
const PTY_RESIZE_QUIET_MS = 100;

export class TerminalPanel {
  private term: Terminal;
  private fitAddon: FitAddon;
  private searchAddon: SearchAddon;
  private lastSearch = "";
  private ro: ResizeObserver | null = null;
  private rafId: number | null = null;
  /** The size the PTY has not been told about yet, and the timer that will tell it. */
  private pendingSize: { cols: number; rows: number } | null = null;
  private sizeTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last size the backend was given, so a fit that changes nothing costs
   *  nothing. `applyLayout`, a workspace switch and the post-animation refit all
   *  call `fit()` on tiles whose box did not move, and each of those used to be an
   *  IPC round trip and a redraw. */
  private sentSize: { cols: number; rows: number } | null = null;
  /** Bound once so `dispose` can remove the same reference it added. */
  private onScaleEvent = (e: Event) => {
    this.setFontSize((e as CustomEvent<number>).detail);
  };
  constructor(
    private session: string,
    private mount: HTMLElement,
    /** A one-shot command tile rather than a claude session. It keeps `F2`.
     *
     *  bash/readline, claude, vim and less bind nothing to F2, but it is a
     *  primary key in `mc` (the user menu), `htop` (Setup) and `nano` (help) —
     *  and a command tile is exactly where a full-screen TUI runs. `matchHotkey`
     *  cannot know which tile it is answering for, so the panel carries the one
     *  flag. Such a tile is renamed with the pencil or from the palette. */
    private readonly keepsRenameKey = false,
  ) {
    this.term = new Terminal({
      fontFamily: '"CaskaydiaCove Nerd Font Mono", "Cascadia Code", ui-monospace, monospace',
      // Not a literal 14: a panel built while a larger scale is in force has to be
      // born at that size. The broadcast only reaches terminals that already exist,
      // so a session opened after the preference was changed would otherwise come
      // up at the default and stay there until the next change.
      fontSize: terminalFontPx(currentScale()),
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 5000,
      allowProposedApi: true,
      // xterm owns its theme and reads no CSS token, so the chrome's palette has to
      // be copied in by hand here. Two groups, and the split is the point:
      //
      // The FRAME colours — background, foreground, cursor, black — are the app's and
      // must track `styles.css`. `background` in particular: the tile body is painted
      // `--bg-terminal` and xterm paints inside it, so a mismatch draws a visible
      // frame of one colour around a terminal of another. These are the Slate & Ember
      // values.
      //
      // The six ANSI hues are the CONTENT's, not the chrome's. They are what Claude
      // Code's own output asks for, and they stay One Dark deliberately: a person
      // reading `red` in a stack trace is reading the program's colour, not this
      // app's, and re-tinting them to match the chrome would make familiar output
      // look wrong for no gain. That they no longer equal `--st-working` and friends
      // is correct — terminal ANSI is a different namespace from session state.
      theme: {
        background: "#13110f", foreground: "#efece8", cursor: "#d5eaf3",
        cursorAccent: "#13110f", selectionBackground: "rgba(213,234,243,0.26)",
        black: "#13110f", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
        blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#dcdfe4",
        // #5c6370 measured 2.73:1 on the old background — and this is the colour
        // Claude Code uses for most of its secondary output: hints, timestamps,
        // "esc to interrupt", diff context. It is the worst-placed failure in the
        // app, on the surface the person actually reads, and already at 14px,
        // which is the proof that size is not the lever.
        // Now `--fg-dim`'s warm neutral rather than the cool #8a919e: this is the
        // terminal's equivalent of that token's job, and on the darker ground it
        // measures better than the 5.09 the cool grey managed.
        // Measured by `npm run contrast`, which reads this line.
        brightBlack: "#9a9690", brightRed: "#e06c75", brightGreen: "#98c379",
        brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd",
        brightCyan: "#56b6c2", brightWhite: "#ffffff",
      },
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.searchAddon = new SearchAddon();
    this.term.loadAddon(this.searchAddon);
    // Align xterm's character-width table with Claude Code's (modern Unicode via
    // string-width). Without this xterm uses its built-in Unicode 6 widths, which
    // disagree with Claude on ambiguous/wide glyphs (emoji, CJK, powerline/Nerd
    // Font symbols) — shifting every cell after such a glyph on a line and breaking
    // box-drawing/input-box alignment. Requires allowProposedApi: true (set above).
    this.term.loadAddon(new Unicode11Addon());
    // `unicode` is a proposed API (present when allowProposedApi is true); guard so
    // the mocked terminal in unit tests, which lacks it, doesn't throw.
    if (this.term.unicode) this.term.unicode.activeVersion = "11";
    this.term.open(mount);
    // Intercept ONLY recognised app hotkeys and the handful of combinations the
    // legacy terminal encoding cannot express; everything else (Ctrl+C/D/L and
    // ordinary typing included) goes to the terminal.
    //
    // The order is the contract: an app hotkey wins, and `terminalKeyBytes` only
    // ever sees what no command claimed. See its doc comment.
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const id = matchHotkey(e, isMacPlatform());
      if (id) {
        if (id === "rename-active" && this.keepsRenameKey) return true;
        return false;
      }
      // The table below is not ours while an IME is composing, because it claims
      // `Enter` and `Enter` is what a candidate window commits on. Returning
      // false would skip xterm's composition helper — this handler runs before
      // it — so the commit would be eaten and `ESC`+`CR` written in its place.
      // `keyCode === 229` is the older spelling of the same fact.
      //
      // This sits *below* `matchHotkey` on purpose, and moving it above is a
      // regression, not a tidy-up. `F2` and `F6` are bare keys that xterm knows
      // how to encode (`\x1bOQ` and `\x1b[17~`), so passing one through mid-
      // composition makes xterm send that sequence to claude and then call
      // `cancel(ev, true)` — `preventDefault` plus `stopPropagation`, which stops
      // the event ever reaching the window listener that dispatches the command.
      // The rename or the region move is lost and a stray escape lands in the
      // prompt. Modifier hotkeys survive it only because xterm leaves
      // `result.key` undefined for them and bails before `cancel`.
      if (e.isComposing || e.keyCode === 229) return true;
      const bytes = terminalKeyBytes(e);
      if (bytes === null) return true;
      // `input`, not `write`: these are input for the process, not output to
      // paint. Not `writeSession` directly either — `input` is what xterm calls
      // for an ordinary keystroke, so the byte reaches the pty through the
      // `onData` wiring below *and* carries the two side effects every other
      // key gets: the viewport snaps back from the scrollback to the prompt,
      // and a stale selection is cleared.
      //
      // Returning false stops xterm sending its own `\r` on top;
      // `preventDefault` stops the browser leaving a stray newline in xterm's
      // hidden textarea, which returning false alone does not do.
      e.preventDefault();
      this.term.input(bytes);
      return false;
    });
    this.fitAddon.fit();
    if ((document as any).fonts?.ready) {
      (document as any).fonts.ready.then(() => this.fit());
    }
    this.ro = new ResizeObserver(() => {
      if (this.rafId !== null) return;
      this.rafId = requestAnimationFrame(() => { this.rafId = null; this.fit(); });
    });
    this.ro.observe(mount);
    this.term.onData((d) => { void writeSession(this.session, d); });
    this.term.onResize(({ cols, rows }) => this.queueResize(cols, rows));
    window.addEventListener(UI_SCALE_EVENT, this.onScaleEvent);
  }
  /** Returns the outcome of the GitHub account binding: the caller decides
   *  whether to hang a badge on the tile. The environment is fixed here, at the
   *  birth of the process. */
  async start(
    cwd: string, workspaceId: string | null, initialPrompt: string | null,
    taskId: string | null = null, resume = false,
    /** Set when this launch came from a scenario — the backend opens a run
     *  journal record for it. Absent for a card, an issue, a pull request or a
     *  bare "+ session". */
    scenario: ScenarioLaunch | null = null,
  ): Promise<SessionAuth> {
    const { cols, rows } = this.term;
    // The process is born at this size, so it counts as sent: a fit between the
    // constructor and here — `document.fonts.ready` fires in that window — would
    // otherwise land a resize telling the backend what it was just told.
    this.sentSize = { cols, rows };
    return await startSession(
      this.session, cwd, workspaceId, initialPrompt, taskId, cols, rows, resume, scenario,
    );
  }
  /** A one-off run of a user command. Not an agent session: no state hooks and
   *  no account binding — the environment is inherited as it is. */
  async startCommand(cwd: string, command: string): Promise<void> {
    const { cols, rows } = this.term;
    this.sentSize = { cols, rows };            // born at this size — see `start`
    await startCommandSession(this.session, cwd, command, cols, rows);
  }
  /** Agent output arrives as bytes and is written as bytes, so xterm's own UTF-8
   *  decoder can carry a sequence split across two pty reads (see
   *  `decodeB64Bytes`). Strings are still accepted for the app's own status
   *  lines — `[restarting session...]` and the launch failures — which are
   *  written by `sessions.ts` and never cross a chunk boundary. */
  write(data: string | Uint8Array) { this.term.write(data); }
  focus() { this.term.focus(); }
  search(term: string) { if (term) { this.lastSearch = term; this.searchAddon.findNext(term); } }
  searchPrev(term?: string) { const t = term || this.lastSearch; if (t) { this.lastSearch = t; this.searchAddon.findPrevious(t); } }
  findNext() { if (this.lastSearch) this.searchAddon.findNext(this.lastSearch); }
  findPrevious() { if (this.lastSearch) this.searchAddon.findPrevious(this.lastSearch); }
  clear() { this.term.clear(); }
  /** Resize the terminal's own type.
   *
   *  **The refit is the load-bearing half.** Changing the font size changes how many
   *  columns and rows fit, and it is `fit()` that recomputes them — which fires the
   *  `onResize` handler wired in the constructor, which pushes `resizeSession` to the
   *  PTY. Set the option without refitting and every PTY keeps the dimensions it had:
   *  nothing looks wrong until the agent draws a box or wraps a line, and then it
   *  wraps against a width the terminal no longer has. */
  setFontSize(px: number) {
    if (this.term.options.fontSize === px) return;
    this.term.options.fontSize = px;
    this.fit();
  }
  fit() {
    if (this.mount.clientWidth === 0 || this.mount.clientHeight === 0) return;
    try {
      this.fitAddon.fit();
    } catch (e) {
      console.debug("terminal fit skipped", e);
    }
  }

  /** Hold a new size for `PTY_RESIZE_QUIET_MS` and then send it, dropping every
   *  size the gesture passed through on the way.
   *
   *  Trailing edge, and that is the load-bearing half: the size that reaches the
   *  child has to be the one the gesture *ended* on. Send the leading edge instead
   *  and the terminal is left drawing at one width while the process wraps at
   *  another — the failure `setFontSize`'s comment above describes, arrived at from
   *  the other direction. */
  private queueResize(cols: number, rows: number) {
    this.pendingSize = { cols, rows };
    if (this.sizeTimer !== null) return;
    this.sizeTimer = setTimeout(() => {
      this.sizeTimer = null;
      const next = this.pendingSize;
      this.pendingSize = null;
      if (next === null) return;
      if (this.sentSize?.cols === next.cols && this.sentSize.rows === next.rows) return;
      this.sentSize = next;
      // `catch` rather than a bare `void`: a session can end while a size is being
      // held, and the backend then answers a resize for a session it no longer has.
      // That is not a failure worth a console error, but it is an unhandled
      // rejection if nobody takes it.
      resizeSession(this.session, next.cols, next.rows)
        .catch((e) => console.debug("terminal resize skipped", e));
    }, PTY_RESIZE_QUIET_MS);
  }
  dispose() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    // Dropped rather than flushed. A panel is disposed when its session closes, and
    // the size of a PTY that is going away is not worth an ioctl — nor worth the
    // timer outliving the panel to send one.
    if (this.sizeTimer !== null) clearTimeout(this.sizeTimer);
    this.sizeTimer = null;
    this.pendingSize = null;
    this.ro?.disconnect();
    this.ro = null;
    // A listener on `window` outlives the panel unless it is taken off: a closed
    // session would keep a disposed terminal alive and touch it on the next scale
    // change.
    window.removeEventListener(UI_SCALE_EVENT, this.onScaleEvent);
    this.term.dispose();
  }
}

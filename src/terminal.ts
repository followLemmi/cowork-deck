import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import {
  startSession, startCommandSession, startShellSession, writeSession, resizeSession,
  prepareWorkspace, type ScenarioLaunch, type SessionAuth, type ShellStart,
} from "./ipc";
import { matchHotkey, isMacPlatform } from "./commands";
import { terminalKeyBytes } from "./terminal-keys";
import { currentScale, terminalFontPx, UI_SCALE_EVENT } from "./ui-scale";

export class TerminalPanel {
  private term: Terminal;
  private fitAddon: FitAddon;
  private searchAddon: SearchAddon;
  private lastSearch = "";
  private ro: ResizeObserver | null = null;
  private rafId: number | null = null;
  /** Keystrokes typed before the process exists, in the order they were typed.
   *
   *  `onData` is wired in the constructor and the terminal takes focus straight
   *  away, but the spawn is a round trip — and `write_session` for a session
   *  that does not exist yet succeeds and discards the bytes. So the first
   *  keystrokes into a fresh tile used to vanish. Held here instead and flushed
   *  the moment the process is there, which is also what lets the launch resolve
   *  the account binding off the main thread without costing input. */
  private pending: string[] = [];
  private started = false;
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
    this.term.onData((d) => { this.send(d); });
    this.term.onResize(({ cols, rows }) => { void resizeSession(this.session, cols, rows); });
    window.addEventListener(UI_SCALE_EVENT, this.onScaleEvent);
  }
  /** Everything typed before the process existed, in order, and then nothing
   *  more — from here on `send` writes straight through. */
  private markStarted() {
    this.started = true;
    const held = this.pending;
    this.pending = [];
    for (const d of held) void writeSession(this.session, d);
  }
  private send(data: string) {
    if (!this.started) { this.pending.push(data); return; }
    void writeSession(this.session, data);
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
    /** Replacing a process still live under this id: the restart button. */
    replace = false,
  ): Promise<SessionAuth> {
    // A restart reuses this panel, and until its new process exists the tile is
    // in exactly the state the buffer is for.
    this.started = false;
    // First, and awaited: resolving the account binding shells out to `gh` and
    // may run the login shell, and `start_session` runs on the thread that
    // paints the window. Doing it here leaves that command reading a cache
    // instead of freezing the app for up to ten seconds on every launch. A
    // failure is not fatal — the launch below resolves it the slow way.
    if (workspaceId) {
      try {
        await prepareWorkspace(workspaceId);
      } catch (e) {
        console.debug("prepareWorkspace failed", e);
      }
    }
    const { cols, rows } = this.term;
    try {
      return await startSession(
        this.session, cwd, workspaceId, initialPrompt, taskId, cols, rows, resume, scenario,
        replace,
      );
    } finally {
      // In `finally` because a launch that failed still has to release what was
      // typed at it: those keystrokes belong to whatever the person does next,
      // and holding them forever would make the tile silently swallow input.
      this.markStarted();
    }
  }
  /** An interactive shell: the person's own `$SHELL`, carrying the workspace's
   *  account binding.
   *
   *  Between `start` and `startCommand`, and closer to the first: it takes the
   *  same pre-resolved environment, for the same reason. Unlike either, nothing
   *  about it is the app's — no prompt, no command, no hooks. What comes back is
   *  what the drawer's banner line is written from. */
  async startShell(cwd: string, workspaceId: string | null): Promise<ShellStart> {
    this.started = false;
    if (workspaceId) {
      try {
        await prepareWorkspace(workspaceId);
      } catch (e) {
        console.debug("prepareWorkspace failed", e);
      }
    }
    const { cols, rows } = this.term;
    try {
      return await startShellSession(this.session, cwd, workspaceId, cols, rows);
    } finally {
      this.markStarted();
    }
  }
  /** A one-off run of a user command. Not an agent session: no state hooks and
   *  no account binding — the environment is inherited as it is. */
  async startCommand(cwd: string, command: string): Promise<void> {
    const { cols, rows } = this.term;
    try {
      await startCommandSession(this.session, cwd, command, cols, rows);
    } finally {
      this.markStarted();
    }
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
  dispose() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.ro?.disconnect();
    this.ro = null;
    // A listener on `window` outlives the panel unless it is taken off: a closed
    // session would keep a disposed terminal alive and touch it on the next scale
    // change.
    window.removeEventListener(UI_SCALE_EVENT, this.onScaleEvent);
    this.term.dispose();
  }
}

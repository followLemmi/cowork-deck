import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { startSession, startCommandSession, writeSession, resizeSession, type SessionAuth } from "./ipc";
import { matchHotkey, isMacPlatform } from "./commands";
import { currentScale, terminalFontPx, UI_SCALE_EVENT } from "./ui-scale";

export class TerminalPanel {
  private term: Terminal;
  private fitAddon: FitAddon;
  private searchAddon: SearchAddon;
  private lastSearch = "";
  private ro: ResizeObserver | null = null;
  private rafId: number | null = null;
  /** Bound once so `dispose` can remove the same reference it added. */
  private onScaleEvent = (e: Event) => {
    this.setFontSize((e as CustomEvent<number>).detail);
  };
  constructor(private session: string, private mount: HTMLElement) {
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
      theme: {
        background: "#1d1f21", foreground: "#e6e6e6", cursor: "#61afef",
        cursorAccent: "#1d1f21", selectionBackground: "rgba(97,175,239,0.28)",
        black: "#1d1f21", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
        blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#dcdfe4",
        // #5c6370 measured 2.73:1 on this background — and this is the colour
        // Claude Code uses for most of its secondary output: hints, timestamps,
        // "esc to interrupt", diff context. It is the worst-placed failure in the
        // app, on the surface the person actually reads, and already at 14px,
        // which is the proof that size is not the lever. #8a919e is 5.09.
        // Measured by `npm run contrast`, which reads this line.
        brightBlack: "#8a919e", brightRed: "#e06c75", brightGreen: "#98c379",
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
    // Intercept ONLY recognised app hotkeys; everything else (Ctrl+C/D/L and
    // ordinary typing included) goes to the terminal.
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && matchHotkey(e, isMacPlatform())) return false;
      return true;
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
    this.term.onResize(({ cols, rows }) => { void resizeSession(this.session, cols, rows); });
    window.addEventListener(UI_SCALE_EVENT, this.onScaleEvent);
  }
  /** Возвращает исход привязки GitHub-аккаунта: вызывающий решает, вешать ли
   *  бейдж на тайл. Окружение фиксируется здесь, при рождении процесса. */
  async start(
    cwd: string, workspaceId: string | null, initialPrompt: string | null,
    taskId: string | null = null, resume = false,
  ): Promise<SessionAuth> {
    const { cols, rows } = this.term;
    return await startSession(
      this.session, cwd, workspaceId, initialPrompt, taskId, cols, rows, resume,
    );
  }
  /** Разовый запуск пользовательской команды. Не сессия агента: ни хуков
   *  состояния, ни привязки к аккаунту — окружение наследуется как есть. */
  async startCommand(cwd: string, command: string): Promise<void> {
    const { cols, rows } = this.term;
    await startCommandSession(this.session, cwd, command, cols, rows);
  }
  write(text: string) { this.term.write(text); }
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

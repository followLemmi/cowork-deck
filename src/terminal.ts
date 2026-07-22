import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { startSession, writeSession, resizeSession } from "./ipc";

export class TerminalPanel {
  private term: Terminal;
  private fitAddon: FitAddon;
  private ro: ResizeObserver | null = null;
  constructor(private session: string, mount: HTMLElement) {
    this.term = new Terminal({
      fontFamily: '"CaskaydiaCove Nerd Font Mono", "Cascadia Code", ui-monospace, monospace',
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: "#1d1f21", foreground: "#e6e6e6", cursor: "#e6e6e6",
        cursorAccent: "#1d1f21", selectionBackground: "#3a3d41",
        black: "#1d1f21", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
        blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#dcdfe4",
        brightBlack: "#5c6370", brightRed: "#e06c75", brightGreen: "#98c379",
        brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd",
        brightCyan: "#56b6c2", brightWhite: "#ffffff",
      },
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(mount);
    this.fitAddon.fit();
    if ((document as any).fonts?.ready) {
      (document as any).fonts.ready.then(() => this.fit());
    }
    let scheduled = false;
    this.ro = new ResizeObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; this.fit(); });
    });
    this.ro.observe(mount);
    this.term.onData((d) => { void writeSession(this.session, d); });
    this.term.onResize(({ cols, rows }) => { void resizeSession(this.session, cols, rows); });
  }
  async start(cwd: string, initialPrompt: string | null) {
    const { cols, rows } = this.term;
    await startSession(this.session, cwd, initialPrompt, cols, rows);
  }
  write(text: string) { this.term.write(text); }
  fit() {
    try {
      const el = this.term.element as HTMLElement | undefined;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      this.fitAddon.fit();
    } catch {
      /* container not measurable yet */
    }
  }
  dispose() {
    this.ro?.disconnect();
    this.ro = null;
    this.term.dispose();
  }
}

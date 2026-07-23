import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { startSession, writeSession, resizeSession } from "./ipc";

export class TerminalPanel {
  private term: Terminal;
  private fitAddon: FitAddon;
  private ro: ResizeObserver | null = null;
  private rafId: number | null = null;
  constructor(private session: string, private mount: HTMLElement) {
    this.term = new Terminal({
      fontFamily: '"CaskaydiaCove Nerd Font Mono", "Cascadia Code", ui-monospace, monospace',
      fontSize: 14,
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
    this.ro = new ResizeObserver(() => {
      if (this.rafId !== null) return;
      this.rafId = requestAnimationFrame(() => { this.rafId = null; this.fit(); });
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
    this.term.dispose();
  }
}

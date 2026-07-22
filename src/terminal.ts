import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { startSession, writeSession, resizeSession } from "./ipc";

export class TerminalPanel {
  private term: Terminal;
  private fitAddon: FitAddon;
  constructor(private session: string, mount: HTMLElement) {
    this.term = new Terminal({ fontSize: 13, cursorBlink: true, scrollback: 5000 });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(mount);
    this.fitAddon.fit();
    this.term.onData((d) => { void writeSession(this.session, d); });
    this.term.onResize(({ cols, rows }) => { void resizeSession(this.session, cols, rows); });
  }
  async start(cwd: string, initialPrompt: string | null) {
    const { cols, rows } = this.term;
    await startSession(this.session, cwd, initialPrompt, cols, rows);
  }
  write(text: string) { this.term.write(text); }
  fit() { this.fitAddon.fit(); }
  dispose() { this.term.dispose(); }
}

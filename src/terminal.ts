import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { Channel } from "@tauri-apps/api/core";
import {
  startSession, startCommandSession, startShellSession, writeSession, resizeSession, claimSession,
  prepareWorkspace, type OutputSink, type ScenarioLaunch, type SessionAuth, type ShellStart,
} from "./ipc";
import { sessionRefusal, SESSION_GONE, SESSION_NOT_OWNER } from "./session-refusal";
import { matchHotkey, isMacPlatform } from "./commands";
import { terminalKeyBytes } from "./terminal-keys";
import { isInterruptKey, showsInterruptHint } from "./interrupt";
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

/** How often the screen is re-read while waiting for an interrupt to land, and
 *  how many times before the wait is given up.
 *
 *  100 ms is a poll a person cannot perceive. Thirty of them is three seconds,
 *  and the budget is deliberately generous rather than tight, because the two
 *  ways of being wrong cost wildly different things:
 *
 *  - **Too short and a real interrupt is missed silently.** An `Escape` between
 *    two tool calls takes a frame, but one that lands inside a `Bash` running
 *    for a minute has to unwind that call first, and how long that takes is not
 *    something this file can know. A miss leaves the session exactly as stuck as
 *    #333 describes, and looks identical to the bug being unfixed.
 *  - **Too long costs almost nothing.** The only consequence of an open wait is
 *    that it may still be watching when the turn ends for some other reason —
 *    and then it reports `done`, which is what `Stop` reports for that same
 *    ending. `interruptedTurn` can only ever move a tile from busy to free, so a
 *    late reading agrees with the hooks instead of fighting them.
 *
 *  Giving up is the ordinary outcome for an `Escape` Claude Code spent on
 *  something else, not a failure: nothing is reported and the hooks stay in
 *  charge, which is where the session started.
 *
 *  Reading the screen is a walk of `rows` lines of the buffer xterm is already
 *  holding, and only ever while a wait is open — at most one wait per `Escape`,
 *  and none at all on a terminal nobody is listening to. */
const INTERRUPT_POLL_MS = 100;
const INTERRUPT_POLL_TRIES = 30;

/** How many terminals may hold a WebGL context at the same time.
 *
 *  **A cap is not optional, and going over it is worse than staying on the DOM
 *  renderer.** WebKit keeps a process-wide ceiling on live WebGL contexts — around
 *  sixteen — and does not refuse the seventeenth: it force-loses the oldest one
 *  instead. A deck can hold far more tiles than that, so an uncapped
 *  one-context-per-panel policy would silently knock out the terminal the person
 *  is looking at in order to give a context to one scrolled out of sight.
 *
 *  Eight leaves room for the rest of the page and for the transient contexts a
 *  renderer swap creates while the old one is still being torn down. Panels past
 *  the cap simply run on the DOM renderer, which is correct — only slower. */
export const MAX_GPU_CONTEXTS = 8;

/** The one piece of `@xterm/xterm`'s inside that this file names.
 *
 *  `Terminal` is the public facade; `_core` is the browser terminal behind it —
 *  the same door `FitAddon` goes through — and `viewport` is the object that owns
 *  the DOM scrollbar. `resyncViewport` explains why it is reached for; this type
 *  is what keeps the reach honest, in that every hop is optional and the call is
 *  guarded rather than asserted. */
interface ViewportAccess {
  _core?: { viewport?: { syncScrollArea?: () => void } };
}

export class TerminalPanel {
  /** Panels currently holding a context, and panels on screen that want one and
   *  are waiting for a slot. Insertion-ordered, so a freed slot goes to whoever
   *  has been waiting longest. Static rather than module-level so the two
   *  functions that own the cap can reach `attachGpu`/`detachGpu` without a cast:
   *  a static method may touch private instance members of its own class. */
  private static gpuHolders = new Set<TerminalPanel>();
  private static gpuWaiting = new Set<TerminalPanel>();

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
  /** The WebGL renderer, while this panel holds a context. `null` means the panel
   *  is on xterm's DOM renderer — either because it is off screen, because the cap
   *  is full, or because WebGL is unavailable or was lost. */
  private gpu: WebglAddon | null = null;
  /** Watches whether the mount is actually on screen. A minimized tile is
   *  `display: none` (see `.deck-strip .tile.minimized .tile-body` in
   *  `styles.css`), which reads as not intersecting — so this covers both
   *  minimizing and scrolling out of view with one mechanism. */
  private io: IntersectionObserver | null = null;
  /** What a hand-off copies. Only ever read from the window that is giving a
   *  session up, and only while it is still alive — which is why there is no ring
   *  buffer in Rust for this. See `serialize`. */
  private serializeAddon = new SerializeAddon();
  private onScreen = false;
  /** Bound once so `dispose` can remove the same reference it added. */
  private onScaleEvent = (e: Event) => {
    this.setFontSize((e as CustomEvent<number>).detail);
  };
  /** The wait for an interrupt to land, while one is open. See `awaitInterrupt`. */
  private interruptTimer: ReturnType<typeof setInterval> | null = null;
  /** Told when a turn on this terminal ended because the person interrupted it —
   *  the end of turn Claude Code's `Stop` hook does not report (#333).
   *
   *  A field rather than a constructor argument because only one of the three
   *  places that build a panel has anything to say here: the deck, which owns
   *  the tile whose state this corrects. A drawer terminal is a shell, and a
   *  shell prints no hint, so leaving this null there costs nothing and claims
   *  nothing. */
  onInterrupt: ((session: string) => void) | null = null;
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
    /** Born without resize authority, for a panel that is about to take over a
     *  session another window is still rendering.
     *
     *  The constructor asserts that authority whether a caller wants it or not:
     *  `document.fonts.ready.then(fit)` and the `ResizeObserver` both land after
     *  it returns and reach the `onResize` handler, so a panel built for a
     *  hand-off would tell the PTY its geometry before it owned the session —
     *  and the child would take a SIGWINCH for a window that is not yet showing
     *  it. The synchronous `fitAddon.fit()` in the constructor is safe either
     *  way; it runs before that handler exists.
     *
     *  Input is held rather than dropped: `started` stays false, so what is typed
     *  into a panel mid-hand-off is buffered by `send` and delivered by
     *  `activate`, exactly as it is for a session that has not spawned yet.
     *
     *  `activate()` is what ends it, and nothing else does. */
    private suppressResize = false,
  ) {
    this.term = new Terminal({
      fontFamily: '"CaskaydiaCove Nerd Font Mono", "Cascadia Code", ui-monospace, monospace',
      // Not a literal 14: a panel built while a larger scale is in force has to be
      // born at that size. The broadcast only reaches terminals that already exist,
      // so a session opened after the preference was changed would otherwise come
      // up at the default and stay there until the next change.
      fontSize: terminalFontPx(currentScale()),
      lineHeight: 1.2,
      // Off at birth, and turned on only while this panel holds a WebGL context.
      // See `attachGpu` — under the DOM renderer a blinking cursor is a strobing
      // cursor, and the blink is not worth that.
      cursorBlink: false,
      cursorStyle: "block",
      scrollback: 5000,
      allowProposedApi: true,
      // xterm owns its theme and reads no CSS token, so the chrome's palette has to
      // be copied in by hand here. Two groups, and the split is the point:
      //
      // The FRAME colours — background, foreground, cursor, black — are the app's and
      // must track `styles.css`. `background` in particular: the tile body is painted
      // `--bg-terminal` and xterm paints inside it, so a mismatch draws a visible
      // frame of one colour around a terminal of another. These are the True Ink
      // values, from `docs/design/true-ink/tools/palette.mjs --app`.
      //
      // `background` is the ISLAND's value in this theme, and that is deliberate: a
      // tile is one surface, head and body, and a step between a title and the thing
      // it titles is a seam you can see. It shipped at #090a0b, which read as a hole
      // cut in a grey card, then at a value 0.025 short of the island, which read as
      // exactly that seam. The diff's ground did not follow it — see `--bg-code`,
      // which is a surface that is read rather than watched. Moved in the GENERATOR,
      // not here: `term` for the `ink` direction carries the whole reason, and this
      // line is emitted from it.
      //
      // The six ANSI hues are the CONTENT's, not the chrome's. They are what Claude
      // Code's own output asks for, and they stay One Dark deliberately: a person
      // reading `red` in a stack trace is reading the program's colour, not this
      // app's, and re-tinting them to match the chrome would make familiar output
      // look wrong for no gain. That they no longer equal `--st-working` and friends
      // is correct — terminal ANSI is a different namespace from session state.
      theme: {
        // The caret is the FOREGROUND, not the accent. It stopped being a choice
        // when the accent became light itself: an accent-coloured caret and an
        // ink-coloured one are now the same colour, and of the two names only one
        // is true of a terminal cursor.
        background: "#161719", foreground: "#f6f7f9", cursor: "#f6f7f9",
        cursorAccent: "#161719", selectionBackground: "rgba(246,247,249,0.26)",
        black: "#161719", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
        blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#dcdfe4",
        // #5c6370 measured 2.73:1 on the old background — and this is the colour
        // Claude Code uses for most of its secondary output: hints, timestamps,
        // "esc to interrupt", diff context. It is the worst-placed failure in the
        // app, on the surface the person actually reads, and already at 14px,
        // which is the proof that size is not the lever.
        // `--fg-dim`, whatever palette that token currently resolves to: this is
        // the terminal's equivalent of its job, and it moves with it. On True Ink's
        // darker ground it measures higher again than it did on the warm one.
        // Measured by `npm run contrast`, which reads this line.
        brightBlack: "#9a9c9f", brightRed: "#e06c75", brightGreen: "#98c379",
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
      // Before the table below and after `matchHotkey`, which is the only order
      // that can be right: an `Escape` the app has claimed never reaches the
      // process, so there is no interrupt to wait for, and `terminalKeyBytes`
      // has nothing to say about `Escape` either way. This watches; it does not
      // consume — the keystroke goes on to xterm and to the pty exactly as it
      // did, and the wait resolves out of the frames that come back.
      if (isInterruptKey(e)) this.awaitInterrupt();
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
    this.term.loadAddon(this.serializeAddon);
    this.fitAddon.fit();
    if ((document as any).fonts?.ready) {
      (document as any).fonts.ready.then(() => this.fit());
    }
    this.ro = new ResizeObserver(() => {
      if (this.rafId !== null) return;
      this.rafId = requestAnimationFrame(() => { this.rafId = null; this.fit(); });
    });
    this.ro.observe(mount);
    this.watchVisibility();
    this.term.onData((d) => { this.send(d); });
    this.term.onResize(({ cols, rows }) => this.queueResize(cols, rows));
    window.addEventListener(UI_SCALE_EVENT, this.onScaleEvent);
  }

  /** Everything typed before the process existed, in order, and then nothing
   *  more — from here on `send` writes straight through. */
  private markStarted() {
    this.started = true;
    const held = this.pending;
    this.pending = [];
    for (const d of held) this.writeToPty(d);
  }
  private send(data: string) {
    if (!this.started) { this.pending.push(data); return; }
    this.writeToPty(data);
  }

  /** One write to the PTY, and what to do when the backend refuses it.
   *
   *  `catch` rather than a bare `void`, for the reason the resize below already
   *  had one: a write can now be refused, and an unhandled rejection is what a
   *  bare `void` makes of that. The two refusals are not the same thing —
   *  `no-session` is a keystroke landing just after a close, which is ordinary;
   *  `not-owner` means another window is rendering this session and this panel is
   *  stale. Acting on the second — giving up the panel — belongs with the hand-off
   *  that can produce it (#241). Until that exists there is no window to be stale
   *  *for*, so it is recorded and not acted on: disposing a panel here today could
   *  only ever be a reaction to a bug, and it would make a tile vanish. */
  private writeToPty(data: string) {
    writeSession(this.session, data).catch((e) => {
      const refusal = sessionRefusal(e);
      if (refusal === SESSION_GONE) return;
      if (refusal === SESSION_NOT_OWNER) {
        console.debug("write refused: this window no longer owns", this.session);
        return;
      }
      console.debug("terminal write failed", e);
    });
  }

  /** A fresh output channel for one spawn.
   *
   *  **A channel cannot be reused across two processes, and reusing it fails
   *  silently.** Tauri's `Channel` sends `{ end: true }` when its Rust half is
   *  dropped — which happens the moment a session's reader threads finish — and the
   *  JS half answers that by calling `unregisterCallback` on its own id. The object
   *  survives and still serialises to the same `__CHANNEL__:id`, so handing it to a
   *  second spawn looks fine and invokes fine; the backend's writes then land in
   *  `runCallback` with an id no longer in the registry, which logs a console
   *  warning and drops the bytes. The restart button would open a terminal that
   *  never printed anything.
   *
   *  So one channel per spawn. The old one is left to the tail of the process that
   *  owned it — bytes still in flight when it was killed reach the same terminal,
   *  which is what the previous broadcast event did too.
   *
   *  **Bytes stay bytes all the way to `Terminal.write`.** Only xterm's own decoder
   *  holds a partial UTF-8 sequence across a chunk boundary; decode any earlier and
   *  a glyph split by one becomes `U+FFFD` on both sides — one 3-byte glyph turns
   *  into two or three cells and every column after it on that line is off by that
   *  much. With the agent's whole TUI drawn out of `─ │ ⏺ ✻ ⎿`, that is a frame
   *  that visibly stops lining up. */
  private openSink(): OutputSink {
    const sink = new Channel<ArrayBuffer>();
    sink.onmessage = (buf) => this.paint(new Uint8Array(buf));
    return sink;
  }

  /** Output that arrived while the panel was holding it, in arrival order.
   *  `null` means nothing is being held and bytes go straight to the screen. */
  private heldOutput: Uint8Array[] | null = null;

  /** Hold this panel's pty output until `releaseOutput`.
   *
   *  The drawer writes one banner line naming what a shell carries, and it can
   *  only write it once the spawn has come back with the account and the
   *  identity — by which time a fast shell has already printed its prompt. Held
   *  here rather than in the caller because the channel opened at spawn paints
   *  straight into this terminal: there is no longer anything between the two to
   *  intercept. */
  holdOutput() { this.heldOutput = []; }

  /** Let go of what was held, in order, and write straight through from now on. */
  releaseOutput() {
    const held = this.heldOutput;
    this.heldOutput = null;
    if (held) for (const bytes of held) this.term.write(bytes);
  }

  private paint(bytes: Uint8Array) {
    if (this.heldOutput) this.heldOutput.push(bytes);
    else this.term.write(bytes);
  }

  /** The terminal's visible screen, one string per row.
   *
   *  `baseY`, not `viewportY`: the question is what the program is drawing, and
   *  a person who has scrolled up to read something is not thereby less
   *  interrupted. `viewportY` would answer for whatever they scrolled to.
   *
   *  Empty when there is no buffer to read — the mocked terminal a unit test
   *  builds, and any xterm that has yet to open — which reads as "no hint", so
   *  the wait below simply never starts. */
  private screenLines(): string[] {
    const buf = this.term.buffer?.active;
    if (!buf) return [];
    const lines: string[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      const line = buf.getLine(buf.baseY + y);
      if (!line) continue;
      // A row xterm wrapped is the tail of the one above it rather than a line
      // of its own, and a hint split across the two would match neither half.
      // Joined UNTRIMMED — `translateToString(false)` — because a wrap can fall
      // on the space between two of the words, and trimming it away would join
      // them into one that matches nothing.
      const text = line.translateToString(false);
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return lines;
  }

  /** Wait for an `Escape` just passed through to end the turn, and say so.
   *
   *  The keystroke has not been consumed and is on its way to the pty; what this
   *  decides is whether it *was* an interrupt, which only the frames coming back
   *  can say. Claude Code's own hint is the evidence at both ends — up when the
   *  key was pressed, gone once the turn is over — and `interrupt.ts` carries
   *  why that pair is the signal rather than the keystroke alone.
   *
   *  Three ways out, and only one of them reports:
   *
   *  - the hint is not up when the key is pressed: there is no turn, and this
   *    `Escape` is the person clearing a prompt or leaving a menu. Nothing
   *    starts.
   *  - the hint goes: the turn is over. `onInterrupt` is called once, and the
   *    tile stops reading as busy for the scheduler, the card and the pill.
   *  - the hint is still up after `INTERRUPT_POLL_TRIES`: Claude Code spent the
   *    key on something else. The wait ends and nothing is reported, which
   *    leaves the hooks in charge exactly as they were.
   *
   *  A second `Escape` while a wait is open is not a second wait: the first one
   *  is already watching the same screen for the same thing. */
  private awaitInterrupt() {
    if (!this.onInterrupt || this.interruptTimer !== null) return;
    if (!showsInterruptHint(this.screenLines())) return;
    let left = INTERRUPT_POLL_TRIES;
    this.interruptTimer = setInterval(() => {
      const busy = showsInterruptHint(this.screenLines());
      if (busy && --left > 0) return;
      this.stopAwaitingInterrupt();
      if (!busy) this.onInterrupt?.(this.session);
    }, INTERRUPT_POLL_MS);
  }

  private stopAwaitingInterrupt() {
    if (this.interruptTimer !== null) clearInterval(this.interruptTimer);
    this.interruptTimer = null;
  }

  /** Ask for a WebGL context when the panel comes on screen and give it back when
   *  it leaves, so the contexts the cap allows go to the terminals someone is
   *  actually looking at — and put the scrollbar back in step on the way in.
   *
   *  Both halves hang off the same transition because the app reaches it five
   *  ways and none of them is a resize: a workspace switch (`.tile.ws-hidden`),
   *  a minimized tile under zoom (`.deck-strip .tile.minimized .tile-body`), the
   *  drawer closing (`.term-drawer[hidden]`), a drawer tab going inactive, and a
   *  tile scrolled out of the strip. Hanging the resync off any one of those
   *  call sites would have left the other four broken.
   *
   *  `IntersectionObserver` is absent in jsdom, so this degrades to "never on
   *  screen" under test — which is the safe direction: the panel stays on the DOM
   *  renderer and nothing tries to make a WebGL context in a unit test. */
  private watchVisibility() {
    if (typeof IntersectionObserver === "undefined") return;
    this.io = new IntersectionObserver((entries) => {
      // One element is observed, so a batch of several records is that element's
      // own history in time order and the last record is where it stands now.
      // `entries.some` answers a different question — "on screen at any point in
      // this batch" — and a batch of [shown, hidden] is the worst case for the
      // resync below: it would run against a tile that is hidden again, measure a
      // box of zero height and write the short scroll area straight back. Worse,
      // `onScreen` would latch true, so no later return counts as a transition and
      // nothing resyncs ever again.
      const latest = entries[entries.length - 1];
      if (!latest) return;
      const onScreen = latest.isIntersecting;
      if (onScreen === this.onScreen) return;
      this.onScreen = onScreen;
      if (!onScreen) { TerminalPanel.releaseGpu(this); return; }
      TerminalPanel.grantGpu(this);
      this.resyncViewport();
    });
    this.io.observe(this.mount);
  }

  /** Rebuild xterm's DOM scroll area against the box the panel actually occupies
   *  now, because while the tile was hidden it was rebuilt against a box of zero
   *  height (#340).
   *
   *  A hidden tile keeps receiving output, so xterm keeps calling
   *  `Viewport.syncScrollArea` → `_innerRefresh`, and `_innerRefresh` measures the
   *  element it is drawing for:
   *
   *      this._lastRecordedViewportHeight = this._viewportElement.offsetHeight;
   *      const e = round(rowHeight * bufferLength)
   *              + (this._lastRecordedViewportHeight - canvas.height);
   *      this._scrollArea.style.height = e + "px";
   *      this._viewportElement.scrollTop = buffer.ydisp * rowHeight;
   *
   *  Under `display: none` that height is 0, so the scroll area comes out one
   *  viewport short and the `scrollTop` written into it is clamped. `ydisp` is
   *  never touched, which is why the tile still *looks* right when it comes back —
   *  the rendered rows and the scrollbar have simply come apart, and the first
   *  wheel tick maps the stale `scrollTop` onto a `ydisp` thousands of lines up.
   *
   *  Nothing in xterm puts them back: `syncScrollArea` runs on a buffer-length
   *  change, on `onDimensionsChange` and on a scroll event, and a return to a
   *  layout of the same shape produces none of the three. `fit()` is not the fix
   *  either — `FitAddon.fit` returns without resizing when the grid is unchanged,
   *  and an unchanged grid is exactly this case.
   *
   *  **Why the private call, and not one of the public pokes.** `syncScrollArea`
   *  is self-guarding: it refreshes only when the recorded viewport height, the
   *  recorded scroll offset or the cell height disagree with what is on screen, so
   *  on the common return — a tile that was hidden but idle — this costs a
   *  comparison and nothing else. The public routes to the same code all have a
   *  price: `scrollToBottom()` only resyncs when it actually moves the viewport,
   *  and a viewport already at the bottom is the common case; a `rows` round-trip
   *  reflows the buffer twice and was measured moving `ydisp` by a line; a
   *  `scrollback` round-trip resizes both buffers twice to reach a one-line
   *  method. Reaching for the method itself is the smaller dependency.
   *
   *  It is still a dependency on `@xterm/xterm` internals, so it is guarded here
   *  and pinned by a test — see "xterm's private viewport" in
   *  `tests/terminal-viewport-resync.test.ts`, which fails on the version bump
   *  that moves it rather than leaving the scrollbar quietly broken again. */
  private resyncViewport() {
    const viewport = (this.term as unknown as ViewportAccess)._core?.viewport;
    if (typeof viewport?.syncScrollArea !== "function") {
      console.debug("terminal viewport resync unavailable");
      return;
    }
    viewport.syncScrollArea();
  }

  /** Swap this panel onto the WebGL renderer. Called only through `requestGpu`,
   *  which owns the cap.
   *
   *  **This is also the cursor-blink fix, and that is not a coincidence.** The DOM
   *  renderer implements blinking as a CSS animation on the cursor's `<span>`
   *  (`DomRenderer.ts`, `animation: blink_block_… 1s step-end infinite`), while
   *  `DomRenderer.renderRows` rebuilds every span of a dirty row with
   *  `replaceChildren`. A fresh element restarts its animation at 0%, so under a
   *  TUI that repaints its input line continuously — a spinner, a token count, an
   *  "esc to interrupt" timer — the animation is restarted before it ever completes
   *  a cycle and the cursor strobes at the repaint rate instead of blinking once a
   *  second. The WebGL renderer drives the same blink from a 600ms timer in
   *  `CursorBlinkStateManager`, which no repaint touches. So blinking is turned on
   *  here and off in `detachGpu`: a cursor that does not blink is a small loss, a
   *  cursor that strobes is the complaint.
   *
   *  Returns whether a context was actually taken, so the cap is only spent on a
   *  panel that got one. */
  private attachGpu(): boolean {
    if (this.gpu) return true;
    try {
      const gpu = new WebglAddon();
      // A context can be lost for reasons that have nothing to do with this panel:
      // a GPU reset, waking from sleep, another page exhausting the pool. Hand the
      // slot back and fall to the DOM renderer rather than drawing nothing. The
      // panel becomes eligible again the next time it goes off screen and returns,
      // which is deliberate — retrying on the spot would spin against whatever
      // pressure caused the loss.
      gpu.onContextLoss(() => { TerminalPanel.releaseGpu(this); });
      this.term.loadAddon(gpu);
      this.gpu = gpu;
      this.term.options.cursorBlink = true;
      return true;
    } catch {
      // No WebGL2 in this webview, or the context could not be created. The DOM
      // renderer is still there and still correct.
      return false;
    }
  }

  /** Give the context back and return to the DOM renderer. Disposing the addon is
   *  what reverts xterm to it — there is no explicit "use the DOM renderer" call. */
  private detachGpu() {
    if (!this.gpu) return;
    this.term.options.cursorBlink = false;
    try {
      this.gpu.dispose();
    } catch (e) {
      console.debug("terminal gpu dispose failed", e);
    }
    this.gpu = null;
  }

  /** Everything on this terminal's screen and in its scrollback, as the bytes
   *  that would redraw it.
   *
   *  Read from the window **giving a session up**, while it is still alive. The
   *  first design put a ring buffer per session in Rust and a `session_tail`
   *  command beside it; this replaced it, and the reasoning is worth keeping. A
   *  Rust buffer only helps when the source is already gone, which is not this
   *  case — during a hand-off the source window is right there. It would also
   *  cost resident memory per session for something read at most once in a
   *  session's life. And the app already discards scrollback on every restart,
   *  so an empty screen with a live conversation is a state people live with;
   *  this is strictly better than that, not a regression from perfect. */
  serialize(): string {
    return this.serializeAddon.serialize();
  }

  /** Take over a session that is already running, without starting anything.
   *
   *  The third path, and it exists because the other two cannot be reused.
   *  `start(..., resume: true)` runs `claude --resume` against a PTY that is
   *  still alive — a second agent on one conversation, which is the defect the
   *  whole epic begins with. This spawns nothing: it points the PTY's output at
   *  this window and records the ownership, and the process never notices.
   *
   *  Listeners first, claim second. The output channel is created here and handed
   *  to Rust inside the claim, so there is no window in which output has been
   *  redirected to a panel that is not reading yet. */
  async attach(): Promise<void> {
    const { cols, rows } = this.term;
    // Counts as sent: `activate` decides what the first authoritative size is,
    // and this is what the PTY currently believes.
    this.sentSize = { cols, rows };
    await claimSession(this.session, this.openSink());
  }

  /** Put back what the person was looking at, then make the process redraw.
   *
   *  **A replay is not a live frame and must not pretend to be one.** Claude Code
   *  is Ink: it repaints with cursor moves relative to the current width, so
   *  content restored into a terminal of different `cols` — precisely the case
   *  when the other monitor is a different size — stitches itself into garbage.
   *  So the replay is the *history*, and the current frame is asked for again.
   *
   *  The asking is a resize to `rows - 1` and back. SIGWINCH is the only way to
   *  get a true current frame out of a running TUI. Not `Ctrl+L`: that reaches
   *  Claude Code as input, and typing into somebody's session on their behalf is
   *  not a repaint.
   *
   *  One thing the repaint does not cover: modes set once at startup and never
   *  re-sent. Bracketed paste (`?2004h`) is the one that matters — without it a
   *  paste into a reattached terminal regresses permanently, and silently. The
   *  alternate screen and application cursor keys are re-emitted by Ink on every
   *  redraw, so they correct themselves. */
  replay(scrollback: string) {
    if (scrollback) this.term.write(scrollback);
    // Re-asserted here because nothing else will re-assert it: unlike the modes
    // Ink rewrites on each frame, this one is sent once at startup and the new
    // terminal never saw it.
    this.term.write("\u001b[?2004h");
  }

  /** Hand this panel its authority: the size it settled on goes to the PTY, and
   *  the process is made to draw the frame it is actually showing.
   *
   *  Ends the suppression `suppressResize` describes, and releases whatever was
   *  typed while the hand-off was in flight. */
  activate() {
    this.suppressResize = false;
    const { cols, rows } = this.term;
    // The first authoritative resize, sent directly rather than queued: the
    // debounce exists to collapse a drag, and this is not one.
    this.sentSize = { cols, rows };
    resizeSession(this.session, cols, rows)
      .then(() => this.forceRepaint(cols, rows))
      .catch((e) => console.debug("hand-off resize failed", sessionRefusal(e) ?? e));
    this.markStarted();
  }

  /** One SIGWINCH the process cannot ignore, and then the real size back.
   *
   *  A resize to the size it already has is not a change, so it produces no
   *  signal and no repaint — hence the detour through `rows - 1`. Short enough
   *  that nothing renders at the wrong height; a TUI redraws on the second one. */
  private forceRepaint(cols: number, rows: number) {
    if (rows <= 1) return;
    resizeSession(this.session, cols, rows - 1)
      .then(() => resizeSession(this.session, cols, rows))
      .catch((e) => console.debug("repaint nudge failed", sessionRefusal(e) ?? e));
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
    // The process is born at this size, so it counts as sent: a fit between the
    // constructor and here — `document.fonts.ready` fires in that window — would
    // otherwise land a resize telling the backend what it was just told.
    this.sentSize = { cols, rows };
    try {
      return await startSession(
        this.session, cwd, workspaceId, initialPrompt, taskId, cols, rows, resume,
        this.openSink(), scenario, replace,
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
    this.sentSize = { cols, rows };            // born at this size — see `start`
    try {
      return await startShellSession(this.session, cwd, workspaceId, cols, rows, this.openSink());
    } finally {
      this.markStarted();
    }
  }
  /** A one-off run of a user command. Not an agent session: no state hooks and
   *  no account binding — the environment is inherited as it is. */
  async startCommand(cwd: string, command: string): Promise<void> {
    const { cols, rows } = this.term;
    this.sentSize = { cols, rows };            // born at this size — see `start`
    try {
      await startCommandSession(this.session, cwd, command, cols, rows, this.openSink());
    } finally {
      this.markStarted();
    }
  }
  /** Agent output arrives as bytes on the session's channel and is written as
   *  bytes, so xterm's own UTF-8 decoder can carry a sequence split across two
   *  batches (see `openSink`). Strings are still accepted for the app's own status
   *  lines —
   *  `[restarting session...]` and the launch failures — which are written by
   *  `sessions.ts` and never cross a chunk boundary. */
  /** How many columns the terminal is showing.
   *
   *  Read by the tool panel beside it, which may not squeeze this box under 80:
   *  `fit()` follows whatever box the terminal sits in, so a panel that narrows it
   *  re-wraps the agent's output — and this app has already shipped that bug once,
   *  when the filmstrip resized a PTY to about 22 columns by 3 rows. */
  get cols(): number { return this.term.cols; }

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
    // A panel built for a hand-off has no authority over the PTY yet. Geometry
    // still settles — the fit happened, xterm knows its grid — but nothing is
    // told about it until `activate`, which sends the settled size once.
    if (this.suppressResize) return;
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
        .catch((e) => console.debug("terminal resize skipped", sessionRefusal(e) ?? e));
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
    // Same reasoning, and one more: a timer left running holds this panel and
    // its disposed terminal alive, and would read `buffer` off it every 100 ms.
    this.stopAwaitingInterrupt();
    this.ro?.disconnect();
    this.ro = null;
    this.io?.disconnect();
    this.io = null;
    // Hand the context back before the terminal goes, or the slot is leaked and
    // every closed tile permanently shrinks the budget for the ones still open.
    TerminalPanel.releaseGpu(this);
    // A listener on `window` outlives the panel unless it is taken off: a closed
    // session would keep a disposed terminal alive and touch it on the next scale
    // change.
    window.removeEventListener(UI_SCALE_EVENT, this.onScaleEvent);
    this.term.dispose();
  }

  /** Give `panel` a WebGL context if the cap allows, otherwise put it in the
   *  queue. A panel that cannot make one — no WebGL2 in this webview — does not
   *  consume a slot. */
  private static grantGpu(panel: TerminalPanel) {
    if (TerminalPanel.gpuHolders.has(panel)) return;
    TerminalPanel.gpuWaiting.delete(panel);
    if (TerminalPanel.gpuHolders.size >= MAX_GPU_CONTEXTS) {
      TerminalPanel.gpuWaiting.add(panel);
      return;
    }
    // Claim the slot before attaching, so nothing re-entrant can hand the same one
    // out twice, and release it again if the attach fails.
    TerminalPanel.gpuHolders.add(panel);
    if (!panel.attachGpu()) TerminalPanel.gpuHolders.delete(panel);
  }

  /** Take `panel`'s context back and pass the freed slot on. */
  private static releaseGpu(panel: TerminalPanel) {
    TerminalPanel.gpuWaiting.delete(panel);
    if (!TerminalPanel.gpuHolders.delete(panel)) return;
    panel.detachGpu();
    // Iterate over a snapshot: a successful grant mutates the queue. A waiter whose
    // attach fails leaves the slot free, so keep offering it until someone takes it
    // or the queue runs out.
    for (const next of [...TerminalPanel.gpuWaiting]) {
      TerminalPanel.grantGpu(next);
      if (TerminalPanel.gpuHolders.size >= MAX_GPU_CONTEXTS) break;
    }
  }
}

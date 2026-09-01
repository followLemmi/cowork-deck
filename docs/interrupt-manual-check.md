# A turn ended by Escape — manual check

Not coverable by the automated tests. The unit tests drive a fake screen and a
fake keystroke; what they cannot check is that the string this hangs on is the
string the installed Claude Code actually prints, and that the `Escape` reaches
it at all. That needs a running app and a real `claude`, so it is a human's to
run. Record the result in the pull request description.

`npm run dev`, a real workspace, a real session. The deck's state chip and the
tile's rail are what to watch: **working** while the turn runs, **done** once it
is over. ADR-0011 carries why the deck reads the terminal's screen for this.

## The fix itself

- [ ] Send a prompt that will run for a while ("read every file under src/ and summarise each"). The chip reads **working**.
- [ ] Press `Escape`. Claude Code says it was interrupted and gives the prompt back — and within about a second the chip reads **done** and the rail changes colour.
- [ ] Type a new prompt and send it. **working** again, and `Stop` still ends it as **done** on its own.
- [ ] Interrupt a turn that is inside a long tool call — a `Bash` running `sleep 30` — rather than between two. Same result: **done**.
- [ ] Interrupt, then interrupt again at the free prompt. Nothing changes and nothing throws; the chip stays **done**.
- [ ] Do it in a tile in the deck grid **and** in a zoomed tile. Both report. (If `Escape` unzooms instead of reaching the program, that is #269, not this.)
- [ ] Narrow the tile — a four-column deck, or drag the panel out — so Claude Code's status line is as short as it gets, and interrupt there. Still **done**.

## What must NOT happen

- [ ] `Escape` at a free prompt with half a message typed: it clears the line, and the chip does not move off **idle** or **done**.
- [ ] `Escape` dismissing the `/` completion menu **while a turn is running**: the menu closes, the turn keeps going, and the chip stays **working**.
- [ ] `Escape` at an open permission prompt: the tile does not read **done** while the prompt is still on screen.
- [ ] Kill a session mid-turn (`Ctrl+C` twice, or close the process from outside) so the last frame still shows `esc to interrupt`. Press `Escape` at that dead terminal — the chip stays **ended** and does not come back to life.
- [ ] Open a shell tile from the drawer, run something that prints the words `esc to interrupt`, press `Escape` — nothing about any tile's state moves.

## What it was for

The colour is the symptom; these three are the reason (#333).

- [ ] Interrupt a session that a **scheduled scenario** fires into, then wait for its next fire. It fires. Before this, an interrupted session blocked that scenario for the rest of its life.
- [ ] Interrupt a session launched from a **tracker card**. The card's "in progress" chip clears rather than sticking.
- [ ] Interrupt the only busy session with the **pill** visible. The waiting count and the pill agree with the deck.
- [ ] Tear the workspace out into its own window and interrupt there. The main window's proxy row for that session reads **done** too.

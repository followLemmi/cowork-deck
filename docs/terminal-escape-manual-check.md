# Escape, zoom and the terminal — manual check

`Escape` belongs to whatever has the keyboard. With focus in a terminal the byte
is the program's and the deck stays as it is; anywhere else it means "leave
zoom". Neither half is reachable by an automated test: jsdom has no pty, and the
one thing that made the rule false — a DOM move blurring the terminal — needs a
real browser to be believed. So it is a human's, against a running app and a
real `claude`. Work through the list and record the result in the pull request
description.

Two sessions open throughout: zooming the only tile there is has nothing to
minimize and is a no-op by design.

## The keyboard survives the layout

- [ ] Click into a tile's terminal, type a few characters, then zoom it with `Cmd+Enter` (`Ctrl+Shift+Enter`). Keep typing without touching the mouse — the characters land in the zoomed session. This is the bug behind everything below (#269): the zoom used to move the tile in the DOM, which blurred the terminal and left the keyboard on the page.
- [ ] Double-click the tile header to zoom instead. Type — same answer.
- [ ] While zoomed and typing, launch another session from the palette. The deck leaves zoom and the keyboard moves into the new tile — both deliberate: `spawnTile` drops the zoom and ends in `focusTile`. What must not happen is the keyboard landing on *nothing*, so type immediately without touching the mouse and check the characters reach the new session.
- [ ] The launch that keeps the keyboard is the background one, and it is the case this fix is for: with a zoomed tile being typed into, let a scheduled scenario fire, or hand tiles over from another window. The deck stays zoomed and the characters keep landing in the tile you were already in — that path never calls `focusTile`, so the restore in `applyLayout` is the only thing holding them there.
- [ ] Leave zoom with `Cmd+Enter` and type once more. Still the same terminal, and the scrollback carries no stray `^[` from any of it.

## Escape reaches the program

- [ ] `vim` in the zoomed tile: `i`, type, `Escape` — normal mode, and the deck is **still zoomed**.
- [ ] `less` on a long file, then `Escape` — the pager keeps it. `q` still quits.
- [ ] `htop`, then `Escape` — htop exits, the deck stays zoomed.
- [ ] `fzf` over anything, then `Escape` — the picker closes and nothing else moves.
- [ ] A real claude session, zoomed: send a prompt and press `Escape` mid-answer — the turn is interrupted ("esc to interrupt" is what it says) and the deck does not unzoom. Press it twice quickly — claude's own double-`Escape` behaviour, and still no unzoom.
- [ ] The same in the terminal drawer (`Cmd+J` / `Ctrl+Shift+J`) with a tile zoomed behind it — Escape belongs to the drawer's shell, and the zoom is untouched.

## And the way out is still there

- [ ] Zoomed, with the keyboard in the terminal: `Cmd+Enter` leaves zoom. That is the way out without the mouse, and the palette carries it by name — open the palette and check exactly one row matches `zoom`, reading `Zoom active session, or leave zoom`, with the key beside it.
- [ ] Zoomed, press `F6` to leave the terminal region, then `Escape` — the deck leaves zoom, because the keyboard was no longer the program's.
- [ ] Click a session row in the panel: that focuses the tile's terminal (`focusTile` → `panel.focus()`), so the `Escape` after it belongs to the program and the deck stays **zoomed**. This changed with this fix and is the rule working, not a regression. `F6` first, then `Escape`, leaves zoom.
- [ ] Open a note over a zoomed tile (memory page), then click into the reader and press `Escape` — the note closes, because the reader is the thing on top, and the zoom is exactly as it was left. `Escape` again goes to the program rather than to the zoom.
- [ ] The click is load-bearing, so check what happens without it: `NoteReader.open` only clears `hidden` and never takes the keyboard, so with the caret still in the terminal `Escape` is the program's and the note stays open. Pre-existing rather than introduced here — record it if it bites, it is a reader-focus question and not an `Escape` one.
- [ ] `Cmd+F` in a zoomed tile, type in the search box, `Escape` — the search bar closes, the keyboard returns to the terminal, and the tile does **not** leave zoom.

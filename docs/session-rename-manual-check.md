# Session names and rename — manual check

None of this is covered by automated tests. It needs a running app, a real
`claude` and a screen reader, so it is a human's to run. Work through the list
and record the result in the pull request description.

Run against the harness where the step says so — `npm run dev`, then
`/harness/`. Its fifth tile is named `session · relay` and its snapshot fixture
carries a transcript title, so the automatic path is visible without waiting on
a real conversation. Everything under "Against a real claude" needs the app
itself.

## The editor

- [ ] `F2` from inside a terminal opens the editor, with the caret in it and the name selected. Check the scrollback afterwards: no `^[[12~`, no stray characters.
- [ ] Type a name and press `Enter` — the header, its tooltip and the sidebar row all change, and the keyboard is back in the terminal.
- [ ] Wait six seconds, through a poll tick. The name is still the typed one, and focus has not moved.
- [ ] Press `F2` again, change the text, press `Escape` — the previous name is back, and the tile does **not** leave zoom.
- [ ] `F2`, clear the field, `Enter` — the automatic name returns. This is the only undo there is; if it does not work, nothing else does.
- [ ] `F2`, then `Cmd+Shift+N` (`Ctrl+Shift+N`) while the caret is in the field — no session is spawned. The same for `Cmd+W`: no tile closes.
- [ ] `F2` on one tile, then click another tile's name — the first commits rather than discarding what was typed.
- [ ] Double-click a word inside the open editor — the word is selected and the tile does not zoom.
- [ ] Paste a 200-character name — it truncates, and the git, token and state badges keep their place in the header.
- [ ] Two tiles, the same name typed into both — allowed, no warning, and each still focuses its own session.

## The pencil, the palette and the keyboard

- [ ] Hover a tile — the pencil appears. Move away — it fades. It stays on the tile that has the keyboard.
- [ ] `Tab` to the pencil from elsewhere in the header — it takes a focus ring while invisible-on-hover, and pressing it opens the editor.
- [ ] Open the palette — exactly one row matches `rename`, reading `Rename active session`, with `F2` beside it.
- [ ] Run it from the palette — the editor opens with the caret in it, not behind the closing palette.
- [ ] Close every tile, then run the palette entry — nothing happens, and nothing throws.
- [ ] Open a **command** tile (GitHub screen → install `gh`), run `htop` or `mc` in it, and press `F2` — the program's own F2 works and no editor opens. Rename that tile with the pencil instead.

## Against a real claude

- [ ] Start a plain session (no scenario, no card). It reads `session · <workspace>`. Send one prompt, wait for Claude Code to mint a title, and within five seconds the tile takes it.
- [ ] The same session an hour later: the name is still what the conversation **started** as. That is the documented behaviour, not a bug — copy anywhere that promises a live name is the defect.
- [ ] Rename the conversation inside Claude Code (`/rename` or its equivalent) — the tile follows within a tick.
- [ ] A session whose transcript has no title yet — the tile keeps the placeholder rather than showing an empty header.
- [ ] Prompt in Russian: the title arrives in Russian, unchanged — nothing uppercased, nothing transliterated, no `?` boxes.
- [ ] Launch from a tracker card (`☑ …`) and from a scheduled scenario. Both keep their names through several ticks, whatever the transcript says.
- [ ] **`/clear` inside a session.** Prompt on a new topic and wait a tick: the tile takes the *new* topic's name, and its token count starts climbing again from the new conversation. This is the one the deck used to get wrong — it read the transcript the session was launched on, which `/clear` abandons.
- [ ] `/clear` on a tile that carries a hand-typed name — the typed name still wins, and clearing the field afterwards reveals the *post*-`/clear` title, not the one before it.
- [ ] `/clear`, then ⟳ or a restart of the app — **known bug, #199**: the pre-`/clear` conversation comes back. Confirm it still behaves that way rather than something worse, and leave it to that issue.
- [ ] Rename a tile, quit the app, reopen it — the typed name is back. Rename another, clear it, quit and reopen — the automatic name is back.
- [ ] With six sessions open, watch the token badges over a minute. One IPC call a tick, not six (add a temporary log or watch the process), and the window stays responsive throughout.

## The screen reader

- [ ] With Orca (or VoiceOver) on, arrow to a renamed session row — it announces `<name> — <state>`.
- [ ] Tab to the pencil — it announces `Rename session`.
- [ ] Open the editor — it announces `Session name` and the current value. Nothing is announced twice, and nothing announces a live region: a rename is synchronous, and the field the person typed into is the confirmation.

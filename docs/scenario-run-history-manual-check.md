# Scenario run history — manual check

Most of the journal is covered by tests, but the parts that matter most are the
ones a test cannot reach: whether a record is written when the window is closed,
what a crash leaves behind, and whether the file manager opens. Those need a
running app, a real `claude`, and in one case a machine you are willing to kill
the app on. Work through the list and record the result in the pull request.

Run against the harness where a step says so — `npm run dev`, then `/harness/`.
Its fixtures carry one record of each close status, a chain, a `result: null` and
a `cleared: true`, on the same frozen clock as the rest of the app, so the screen
can be read without waiting for a real run. Everything else needs the app itself.

## The screen (harness)

- [ ] The four screens switch, and the scenario list, "+ session" and the session list are hidden on all three of the others.
- [ ] Switch workspace while the history is open — the list re-filters. `atlas` has no runs and says so, and does **not** blame a filter.
- [ ] The five states are separable at a glance, side by side, without reading the labels: the `did not launch` row's dashed border is what tells it from `error`.
- [ ] Turn the display to greyscale and look again. The labels carry it; nothing depends on hue alone.
- [ ] The `interrupted` row reads "No transcript was reported…", not an empty box.
- [ ] The chain is one bracketed group with "2 runs" under it, its earlier link drawn quieter.
- [ ] The row for `Tidy the changelog` — a scenario the fixture never defines — renders under its own name, and the scenario filter can still reach it.
- [ ] `Show more` appears only where a result is actually clamped. Change the text size (⚙, or `Cmd+K` → text size) and check again at 145% and at 90%: the button appears and disappears with the wrapping.
- [ ] Tab through the screen. Every control takes a visible ring; the two selects and the checkbox are reachable, and so is every refused button — they are `aria-disabled`, not `disabled`, so Tab reaches them. Press one: it says why it will not do anything, instead of doing it.
- [ ] Do that last step again with a screen reader on. The button announces its name *and* its reason, and the refusal is spoken when it is pressed.

## The journal, against a real claude

- [ ] Launch a scenario by hand. A `manual` record appears in the history within a moment, `running`, with the workspace's branch on it.
- [ ] Press ⏰ on a scheduled scenario — a `run now` record, told apart from a `scheduled` one by the row and by the filter.
- [ ] Let a schedule fire — a `scheduled` record. **Close the main window first** and let it fire with the app minimised; the record must still be there.
- [ ] Let the agent finish a turn and park at the prompt. The record stays `running` — `Done` does not close it — and the tile is still typeable.
- [ ] Close the tile. The record closes as `ended` and its result is the last thing the agent said.
- [ ] Type `/clear` mid-run, ask one more thing, then close the tile. **One** record, marked as cleared, whose result is the tail.
- [ ] Restart a tile with ⟳. A second record appears, chained, and the first is closed.
- [ ] Quit the app with a scenario running and start it again. The old record reads `interrupted`, and the restored tile has opened a new `resume` record chained to it.
- [ ] `kill -9` the app the same way. Same result — this is the case the whole `interrupted` status exists for.
- [ ] Delete the scenario, and then its workspace. Both records stay, under the name and icon they ran with.
- [ ] Turn `Record scenario runs` off, run a scenario, and come back: nothing new was written and nothing already written is gone.

## The three actions

- [ ] `Go to the session` appears wherever the tile is still open, and lands on it — switching workspace when the run belongs to another one. **Keyboard focus must be in the terminal when you arrive**: type immediately, without clicking, and the characters reach the agent.
- [ ] Let a run finish but leave its tile on the deck. The button is still there, and still lands on the terminal holding the full output.
- [ ] Close that tile and look again: the button is gone rather than leading nowhere.
- [ ] `Re-run…` opens the parameters form with the recorded values in the fields, selected. Cancel — nothing launches.
- [ ] Re-run from a row whose scenario is pinned to another workspace. The new tile is in the workspace you are looking at, visible under its header, and it is still there after switching away and back.
- [ ] Give a scenario a `{{constructor}}` placeholder and launch it: the field opens **empty**, not holding `function Object() { [native code] }`.
- [ ] Edit the scenario's prompt to drop one placeholder and add another, then re-run from an old record: the dropped one is gone and the new one is empty.
- [ ] Delete the scenario and re-run from its record: the button is disabled and says why. Nothing is recreated.
- [ ] The re-run appears as a new `manual` record and is **not** part of the old one's chain.
- [ ] `Reveal the transcript` opens the file manager with the file selected — Finder on macOS, Explorer on Windows, the containing folder on Linux. It must not open the `.jsonl` in an editor.
- [ ] **On Windows, with a space in the path** (a user name like `John Smith`, or a folder you rename for the test): Explorer opens on the file's own folder with the file selected — not on Documents with nothing selected, which is what `/select` quoted wrongly looks like.
- [ ] Reveal a dozen times, then look at the process list: no `<defunct>`/zombie children under the app, and no `xdg-open` chatter in its stdout.
- [ ] Delete the transcript by hand, then press it: an honest error rather than a silent nothing.
- [ ] `Delete this scenario's history` asks first, removes exactly that scenario's rows, and leaves every other scenario's alone.
- [ ] Run that scenario in **two** workspaces, then erase from one of them. The question names the workspace; the other workspace's rows are all still there afterwards.
- [ ] Start a run of that scenario and try to erase while it is going: refused, with the reason, and nothing is written. Let it finish — the record is there, complete — and the erase then works.
- [ ] Look for any way to edit or delete a single row. There must not be one.

## Retention and the file

- [ ] Find `runs.jsonl` in the app data directory. One JSON object per line, each with its own `v`.
- [ ] Append a line of nonsense to the end and restart: the journal still reads, with a warning on stderr, and the next launch appends after it without losing anything.
- [ ] Truncate the last line mid-write (drop its final characters, no newline) and restart. The same — and specifically, the **next** record written afterwards is still there.
- [ ] Run one scenario past 100 records (or hand-edit the file to that many) and restart: 100 remain, the oldest gone, and another scenario's records untouched.

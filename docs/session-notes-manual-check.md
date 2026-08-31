# Session notes — manual check

The write path (#35, Phase 2). Most of it *is* covered by automated tests — the
pipeline runs against a closure rather than an account, which is deliberate, so
that a suite nobody has to pay for can still assert what a note ends up looking
like. What no such test reaches is the one thing that matters: whether a **real**
`claude -p`, with the flags this build passes, on the CLI actually installed,
comes back with something that parses.

**This check spends money.** Every item marked 💸 is one model call on your own
Claude account. Whole list, once: single figures of cents.

Work through it and record the result in the pull request description.

## Before you start

- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` and `npx vitest run` are green.
- [ ] `claude --version` answers from a login shell, and the app can find it — a
      session launches normally.
- [ ] Note where your config directory is (**Settings → Files**). Everything below
      lands under it.

## The flags this build passes

The one thing only a live call can tell you, and the cheapest way to find out.
Run it before touching the app, so a rejected flag is a line of output rather
than a failed job:

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  memory::capture::tests::a_real_claude -- --ignored --nocapture
```

- [ ] 💸 It passes, printing the note it wrote and what the call cost.
- [ ] The printed note starts with `---` and contains a `## TL;DR`.
- [ ] The cost line is not empty — the CLI's envelope carried a usage figure.

If this fails on an argument rather than on content, the flag set in
`memory::capture::args` is wrong for the installed CLI and nothing below will
work. Fix that first.

> **Run once, 2026-08-31, Claude Code 2.1.251, macOS.** It failed the first time
> and the failure was worth the cent: `--output-format json` returns a JSON
> **array** of the whole stream, not a single envelope, so the result has to be
> found in it by `type`. Fixed, and the shape is now asserted by a unit test.
>
> The pass after that also showed where the money goes. `--restricted` leaves the
> file tools in place and every available tool's definition travels with the
> request: 11 894 input tokens for a two-turn transcript, against 756 once
> `--tools ""` was added. Output is dominated by thinking and varies by thousands
> of tokens between identical calls, so the per-capture total is not settled —
> that is #379, and it wants sampling rather than another single call.
>
> Everything below this line is **not yet run**: it needs somebody at the
> keyboard closing tiles and killing the app.

## The question at the close

- [ ] Start a session, give it a real piece of work, let it answer. Close the tile.
- [ ] The question appears **once**, and names the session.
- [ ] It says the transcript is sent to a model, that the call runs on **your own
      Claude account**, and that it spends from your plan or budget — above the
      buttons, not under them.
- [ ] The keyboard focus is on **No note**, not on the button that spends money.
- [ ] Enter still accepts.
- [ ] Answering either way closes the tile **immediately** — no waiting on a model.

## A note actually appears

- [ ] 💸 Answer "Write the note".
- [ ] Within a minute or so a file appears at
      `<config dir>/<workspace id>/Sessions/YYYY-MM/DD-topic.md`.
- [ ] It opens with `---`, a `date:` and a `workspace:`, then `# YYYY-MM-DD — …`,
      then `## TL;DR`.
- [ ] The TL;DR describes what the session actually did — not "the user asked
      about…".
- [ ] It is written in the language the session was conducted in.
- [ ] Stderr carries a line like `memory: captured … — N in, M out, $0.00…`.
- [ ] If the model returned facts, `<config dir>/<workspace id>/Facts.md` has them
      as `- YYYY-MM-DD [active] …` bullets.

### Two sessions, one day, one topic

- [ ] 💸 Do the same work twice in two sessions and close both with notes.
- [ ] The second note is `DD-topic-2.md`. **The first is unchanged** — open it and
      check it still describes the first session.

## Nothing worth writing

- [ ] Open a tile, close it without giving it anything. **No question is asked**
      (nothing has written a transcript yet).
- [ ] Give a tile one prompt, interrupt before it answers, close it. Nothing is
      written, and no model call happens — check stderr for the absence of a cost
      line.

## Answering no

- [ ] Do real work in a session, close it, answer **No note**.
- [ ] No file appears under `Sessions/`, and no cost line in stderr.
- [ ] The next close asks again — a plain "no" is not remembered.

## Remembering the answer

- [ ] Close a session, tick **Remember my answer**, answer either way.
- [ ] The next close does not ask, and behaves as answered.
- [ ] **Settings → Session notes** shows that position selected.
- [ ] Pick **Ask each time** there; the next close asks again.
- [ ] Restart the app: the position survives.

## Killing it mid-job — the guarantee

The one the queue exists for.

- [ ] 💸 Close a session with consent, and **immediately** kill the app hard
      (`kill -9`, Force Quit — not a normal quit).
- [ ] `<config dir>/wrapup.jsonl` holds a `queued` and a `started` line for the job.
- [ ] Start the app again. Stderr says a job was queued again after an unclean stop.
- [ ] 💸 The note appears, without you closing anything else.
- [ ] The queue's last line for that job is `done`, carrying a `notePath`.

### And the job that cannot work

- [ ] Break it on purpose: with a job queued, rename the transcript file it names,
      then start the app.
- [ ] The job fails rather than writing an empty note, and `wrapup.jsonl` says why.
- [ ] It is retried at most three times across restarts, then stays `failed`
      rather than being tried forever.

## Quitting with work open

- [ ] Set **Always write one**.
- [ ] With a live session doing something, quit. Confirm at the "still running"
      question.
- [ ] The app exits without waiting for a model.
- [ ] `wrapup.jsonl` has a queued job for that session.
- [ ] 💸 Start again: the note is written.

## Diary rooms

- [ ] **Settings → Session notes** lists two rooms on a fresh install, each with a
      sentence.
- [ ] Rewrite a description; it saves without an OK button. Reopen to confirm.
- [ ] Add a room with a name and no sentence — refused, and the message says which
      half is missing.
- [ ] Rename a room. `Diaries/<old>/` is **gone** and `Diaries/<new>/` holds the
      files that were under the old name.
- [ ] Rename one room onto another's name — refused, saying it would merge two
      diaries. Nothing moved.
- [ ] Put a file in a room, then remove the room. **The file is still there.** The
      room is gone from the list.
- [ ] 💸 With a room whose description plainly fits a mistake the session made,
      close it with a note: a line appears in `Diaries/<room>/YYYY-MM.md`,
      pipe-separated, dated.

## A session on another CLI

- [ ] Launch a Copilot, opencode or Codex session (any one). Do some work. Close it.
- [ ] **No question is asked** — and no note is written, silently or otherwise.
      This build cannot read those logs (#371, #372), and the point of the check
      is that the absence is deliberate rather than a session quietly losing its
      memory.

## The memory page

The rail's fourth button. Everything below it is a directory listing, so none of
it needs the model.

- [ ] The page lists this project's notes, the lessons and every other project's,
      each group counted — and a collapsed group still says how many it holds.
- [ ] With nothing captured yet, it says what fills it rather than showing an
      empty column.
- [ ] Choosing a note reads it **where the deck was**. The deck comes back from
      the control in the head and from Escape, with the tiles, the zoom and the
      layout exactly as they were.
- [ ] **Show the file** reveals the note in Finder or Explorer.

## Searching them yourself

Needs the model downloaded, which the block under **Settings → Session notes**
offers. The search is the field at the top of the memory page; the palette's
**Search your notes…** lands on it with the caret already there.

- [ ] With the model absent, the page says the 479 MB is needed and offers it,
      before you type anything — and the list of notes is still there, because
      browsing needs neither the model nor the sidecar.
- [ ] Download it. Progress counts up; quitting mid-download and starting again
      **resumes** rather than restarting from zero.
- [ ] With a note captured, search for something in it by meaning rather than by
      its words — "why did the build pick the wrong architecture", not the
      filename. It comes back.
- [ ] A result opens the note the same way a listed one does, and clearing the
      field gives the whole corpus back.
- [ ] A query matching nothing says "nothing matched" — and, with one lesson in a
      fresh diary room, says the notes are too short to index rather than that
      nothing matched.

## What has been captured

- [ ] **Memory: what has been captured…** in the palette lists the sessions
      closed with a note, newest first, with what each one cost.
- [ ] It says the retry spends money and that the queue is this machine's.
- [ ] A failed job has **Try again**; pressing it re-runs the summary.
- [ ] A job that succeeded with nothing worth writing reads as that, not as a
      failure.
- [ ] A long failure reason is trimmed in the row and whole on hover.

## Your sessions can search too

The half that makes the corpus worth filling. Needs the model downloaded.

- [ ] Start a session. Ask it: *"use your search_memory tool to find what this
      project has learned about packaging"*. It answers from a note rather than
      saying it has no such tool.
- [ ] `/mcp` inside that session lists **cowork-memory** as connected.
- [ ] Ask it to read a note by the path a result gave. It comes back.
- [ ] Ask it to read a note belonging to **another** workspace, by its exact
      path. It is refused — "belongs to another project".
- [ ] Restart the session (the ⟳ button). The tool is still there: memory reaches
      the `--resume` path as well as the first launch.
- [ ] With the model **not** downloaded, the tool still exists and answers with
      what is missing rather than with silence.

## What must not travel

- [ ] `<config dir>/wrapup.jsonl` is **not** tracked by the sync repository, if
      you have sync on. It names transcript paths on this machine.
- [ ] `Diaries/<room>/room.json` **is** tracked — the rooms travel with the
      lessons they route.
- [ ] `npm run sync:preview` agrees with both of the above.

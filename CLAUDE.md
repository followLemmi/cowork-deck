# cowork-deck

## Language

**All documentation, all tasks and all pull requests are written in English.**
So is everything else committed to this repository or filed in its GitHub
project. The only exceptions are the ones written down below; anything not on
that list is English, and the list does not grow by argument.

In full, that covers:

- **Documentation** — `README.md`, this file, and every document under `docs/`
  written or edited from 2026-07-27 onward, specs and plans included. The one
  carve-out is the pre-existing record described under "History stays as
  written" below.
- **Tasks** — GitHub issue titles and bodies, checklists, epics, and comments
  posted on them.
- **Pull requests** — titles, bodies, review comments, and replies.
- **Code** — identifiers, UI strings, log and error messages.
- **Comments and doc comments**, TypeScript and Rust alike.
- **Commit messages and branch names.**

Conversation with the user is **not** covered. Reply in whatever language the
user writes in — the rule governs artefacts that outlive the conversation, not
the conversation itself.

Writing something in another language and translating it afterwards is not the
intent: draft it in English in the first place.

### Two deliberate exceptions

Some Cyrillic in the source is a test fixture or an example, not interface text,
and must survive any future translation sweep:

- `src/placeholders.ts` and `tests/placeholders.test.ts` — the placeholder regex
  uses `\p{L}`, not `\w`, so a name like `{{ветка}}` is recognised. A prompt is
  written in whatever language its author thinks in, which the UI's language
  does not constrain.
- `src/commands.ts` and `tests/commands.test.ts` — hotkeys match on `e.code`,
  the physical key, because with a Cyrillic layout active `Cmd+K` arrives as
  `л`. An English interface does not imply a Latin keyboard layout.

Deleting either would regress a real feature. The comments explain why; keep
them intact.

### History stays as written

`docs/superpowers/plans/` and `docs/superpowers/specs/` dated before 2026-07-27
are in Russian. They record work already finished, and a translated record can
drift from what actually happened with no original left to check against. **Do
not translate them.** Anything added from 2026-07-27 onward is English.

# cowork-deck

## Language

**Everything written into this repository or its GitHub project is in English.**

That covers:

- Code — identifiers, UI strings, log and error messages.
- Comments and doc comments.
- Commit messages and branch names.
- Pull request titles and bodies.
- Issue titles and bodies, including checklists and epics.
- New documents under `docs/`, specs and plans included.
- `README.md` and this file.

Conversation with the user is **not** covered. Reply in whatever language the
user writes in — the rule is about artefacts that outlive the conversation, not
the conversation.

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

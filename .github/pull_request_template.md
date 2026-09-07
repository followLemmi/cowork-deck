<!--
Every pull request targets `dev`. A pull request against `main` is a mistake
unless it is the release — see "Branches and releases" in CLAUDE.md.

English throughout: title, body, review comments and replies.
-->

## What this changes

<!-- One paragraph. What is different after this lands, in the app or in the repo. -->

## Why

<!-- The issue this closes, or the reasoning if there is no issue. `Closes #NNN`. -->

## How it was checked

- [ ] `npm test`
- [ ] `npx tsc --noEmit`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`
- [ ] `npm run contrast` (any change to `src/styles.css`)
- [ ] Looked at in a real window, if it changes something on screen

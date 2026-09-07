# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo is **single-context**: one `CONTEXT.md` and one `docs/adr/` at the root.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-....md
│   └── 0002-....md
└── src/
```

`docs/adr/` is this repo's single home for Architecture Decision Records — any
ADR tooling writes there, not to `docs/architecture/`.

Should this repo ever grow into a multi-package workspace, switch to a root
`CONTEXT-MAP.md` pointing at one `CONTEXT.md` per context, with
`src/<context>/docs/adr/` for context-scoped decisions — and update this file to
say so.

## Language

ADRs and `CONTEXT.md` are documentation, so they are written in English, along
with every glossary term and decision record. See the "Language" section of
`CLAUDE.md`.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-00NN (event-sourced orders) — but worth reopening because…_

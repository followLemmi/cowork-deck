---
status: Accepted
date: 2026-08-09
deciders:
  - evgenykharetski
---

# ADR-0001 — Store credentials for providers that have no credential manager of their own

## Context

`src-tauri/src/gh.rs` opens with a design invariant: the app never stores a token
and never changes global `gh` state. A workspace's settings hold an account
*name*; the token is read out of `gh`'s keyring when a session starts and lives
only in the child process's memory. The README states the same thing to users.

That invariant holds because `gh` exists. GitHub access is borrowed from a
separate program that already owns a credential store, so the app can decline to
own one.

Connecting a social account has no such program behind it. Bluesky
authentication is an app password (and, later, an OAuth token set) issued to
whoever asks; there is no third-party CLI whose keyring we can read at session
start. Either the app holds a long-lived secret, or the feature does not exist.

Scheduled scenarios rule out the obvious escape. A credential the user types on
demand cannot serve a scenario that fires at 03:00, and unattended firing is the
point of the feature.

## Decision

The app stores credentials for providers that have no external credential
manager, and only for those. GitHub keeps working exactly as it does today.

- The primary store is the operating system's keychain (macOS Keychain, Windows
  Credential Manager, Linux Secret Service) through the `keyring` crate.
- A **declared** fallback writes a `0600` file in the app's config directory,
  for hosts where no Secret Service is running. The Accounts screen always shows
  which of the two holds a given account.
- `accounts.json` holds non-secret fields only — provider, handle, DID, policy,
  and a reference saying *where* the secret lives. Never the secret.

The fallback is visible on purpose. A silent downgrade to plaintext is worse
than no fallback at all, because the user cannot weigh a risk they were not told
about.

## Consequences

- The invariant is narrowed, not deleted. It now reads: *the app does not store
  what another credential manager can hold for it.* `gh.rs` and the README both
  need amending to say so, or the next reader will treat this ADR as a
  violation rather than a revision.
- Copying the app's config directory to another machine no longer carries the
  accounts with it. Deliberate — the secret is not in there.
- Revocation stays on the provider's side. The app can forget a credential; it
  cannot invalidate one. The Accounts screen should say so where it offers
  removal.
- One plaintext path exists and will be used by somebody. It is documented,
  labelled in the UI, and not the default.

## Alternatives considered

- **`tauri-plugin-stronghold`.** Stronger encryption than a keychain, but it
  unlocks with a password. A scenario firing unattended cannot supply one, which
  removes the feature this decision exists to enable.
- **File only, no keychain.** Simpler and uniform across platforms, but the app
  would keep a plaintext secret by default on two platforms that offer better.
- **Never store; prompt per use.** Kills scheduled scenarios.
- **Borrow from a third-party CLI, as with `gh`.** No such CLI exists for
  Bluesky. Manufacturing a dependency on one to preserve the letter of the old
  invariant would be worse than owning the problem.

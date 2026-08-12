---
status: Accepted
date: 2026-08-09
deciders:
  - evgenykharetski
---

# ADR-0002 — The app process uses the credentials; sessions reach it over the authenticated control channel

## Context

[ADR-0001](0001-store-credentials-for-providers-without-a-credential-manager.md)
settles that the app stores social credentials. This one settles which process
uses them, and over what.

The obvious shape follows `cowork_task`. Its header explains itself: it links the
same `tasks` module the app does, and it writes the file directly — no TCP, no
listener — "so filing a ticket works even when the app window is busy". A
`cowork_social` built the same way would read the keychain and call the API
itself.

Two things break that.

**Code signing.** macOS scopes keychain access by the requesting binary's
signature. This project has no paid Apple Developer account; the bundle is
neither signed with a stable identity nor notarized, and the README already
tells users to clear the quarantine flag by hand. A second binary reaching for
the same keychain item is, at best, a prompt on every access — which is exactly
what a scenario firing at 03:00 cannot answer.

**Blast radius.** A sidecar that holds the credential holds it in a process the
session invokes directly. Every leak surface it has becomes the session's.

So the credential stays in the app, and the session needs a way to ask the app
to act. **That channel is already being built.** Epic #178 turns the reporter's
one-way socket into a request/response channel (#180: "the listener learns to
answer", and the port reaches sessions as `COWORK_CONTROL_PORT`), and adds
`cowork_session` as a sidecar speaking it (#182). Its contract is still
unwritten — the spec (#179) is open.

One weakness is common to both features and is currently unaddressed. The
listener is unauthenticated, and its port travels in the hook command's argv, so
it is visible in `ps`. Today the worst a local process can do with it is colour
a tile wrongly. Once the channel can spawn sessions or publish posts, it is
worth an authentication step.

## Decision

Credentials are read and used **only by the app process**. The app owns the
network call, the idempotency ledger, the rate ceiling, the draft queue and the
approval UI.

Sessions reach it through `cowork_social`, a thin client carrying no credential,
speaking **the control channel of #178** — not a second endpoint of its own.
Social requests are additional message kinds in that contract.

The channel gains a **per-session token**, passed in the environment beside
`COWORK_CONTROL_PORT` and checked on every request. The token is not an account
credential: it authorizes *asking the app to act*, it is scoped to one session,
and it dies with the app. Putting that in the environment is acceptable where
putting an app password there is not.

Two obligations follow, and they are the substance of this decision:

- The spec in #179 must be written knowing it has **two** consumers. A contract
  derived from `spawn` alone will be spawn-shaped, and the second consumer will
  arrive to find a hole it has to widen.
- Authentication belongs in the channel, not in the social feature. It protects
  spawning as much as publishing.

## Consequences

- One keychain client and one ACL. Unattended runs stop depending on a second
  binary's signature.
- **This epic is blocked by #179 and #180.** That is a real schedule cost and
  the reason to say it out loud rather than route around it: a second loopback
  control channel would be cheaper this week and worse every week after.
- `cowork_task`'s "works when the window is busy" argument does not transfer,
  and should not be cited as if it did. The listener is async and independent of
  the frontend, and the scheduler runs inside the app — a scheduled scenario
  cannot fire while the app is down.
- Social features are unavailable to a session outside the app. Acceptable:
  sessions only exist inside it.
- Adding authentication touches #178's surface. The reporter's fire-and-forget
  state events must stay valid, which is already a constraint #180 carries;
  whether `cowork_report` is exempted or given the token is the spec's call.
- Checks that must not be skippable — idempotency, the rate ceiling, length and
  alt-text validation — live in Rust rather than in a prompt. A prompt states an
  intent; only code states a limit.

## Alternatives considered

- **A dedicated social endpoint, separate from the control channel.** This was
  the original proposal here, made before #178 was found. It buys isolation of a
  privileged operation — but the spawn channel is at least as privileged, so the
  isolation is imaginary while the duplication is real: two loopback listeners,
  two framings, two authentication stories, one of which would inevitably lag.
- **Credential in the session's environment, like `GH_TOKEN`.** The precedent
  exists, which is the strongest argument for it. Against: the value is
  reachable by `env`, and anything the agent echoes lands in the transcript the
  app itself reads back (`transcripts.rs`). Adding a second secret to a channel
  already known to leak widens a hole instead of holding it steady.
- **Sidecar reads the keychain itself.** The signing problem above; on macOS it
  breaks the unattended case specifically, which is the case that matters.
- **Unix domain socket with filesystem permissions.** Cleaner than a bearer
  token and worth raising in #179, since it would serve both features. Not
  pursued here because Windows diverges (named pipes) and the repo is buildable
  there even though no Windows bundle is published.

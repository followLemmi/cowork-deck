# Spike Results: `claude --settings` hooks fire and carry `session_id`

## Environment

```
$ claude --version
2.1.217 (Claude Code)
```

## Command run

```
bash docs/superpowers/spikes/hook-probe.sh
```

The script (`docs/superpowers/spikes/hook-probe.sh`) runs `claude -p` headlessly in a
scratch directory with an inline `--settings` JSON blob registering a `Stop` hook
that pipes its stdin payload to a temp file via `cat > $OUT`.

## Schema tested

**Nested form** (as documented, and as written in the task brief verbatim):

```json
{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"cat > $OUT"}]}]}}
```

## Result: nested form FIRED — no need to test the flat form

The nested schema fired successfully on every run (2/2 runs, exit code 0 both times).
The flat form (`"Stop":[{"command":"cat > $OUT"}]`) was **not** tested because the
nested form worked as documented — the brief only calls for testing flat as a fallback
if nested fails.

### Run 1 — exact captured JSON (verbatim, hook capture file contents)

```json
{"session_id":"9948221a-9fd2-4d50-ab02-0a8edcd1464e","transcript_path":"/home/evgeny-kharetski/.claude/projects/-tmp-tmp-rotHw9bJ1J/9948221a-9fd2-4d50-ab02-0a8edcd1464e.jsonl","cwd":"/tmp/tmp.rotHw9bJ1J","prompt_id":"911d3d36-f7be-4e42-b9b8-5e6a13f71689","permission_mode":"auto","effort":{"level":"high"},"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"Hi","background_tasks":[],"session_crons":[]}
```

`session_id` match: `"session_id":"9948221a-9fd2-4d50-ab02-0a8edcd1464e"`

### Run 2 — exact captured JSON (verbatim, hook capture file contents, independent re-run)

```json
{"session_id":"1729954e-11bf-42f0-82f1-85ae2722fe1f","transcript_path":"/home/evgeny-kharetski/.claude/projects/-tmp-tmp-FoPnGZzJSw/1729954e-11bf-42f0-82f1-85ae2722fe1f.jsonl","cwd":"/tmp/tmp.FoPnGZzJSw","prompt_id":"8bb20b8a-7150-4783-b54b-075d4f0eada8","permission_mode":"auto","effort":{"level":"high"},"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"Hi","background_tasks":[],"session_crons":[]}
```

`session_id` match: `"session_id":"1729954e-11bf-42f0-82f1-85ae2722fe1f"`

## Findings

- **Nested schema (`"Stop":[{"hooks":[{"type":"command","command":"..."}]}]`) fires.**
  Confirmed on 2/2 independent runs of the full probe script, exit code 0 both times.
- **Flat schema was not exercised** — the fallback branch of the spike was not needed
  since the documented nested form worked on the first try.
- **`session_id` is present** as the first key in the Stop-hook stdin payload, shaped
  as a standard UUID v4 string, e.g. `"9948221a-9fd2-4d50-ab02-0a8edcd1464e"`.
  It is stable per-session (matches the directory name under
  `~/.claude/projects/<sanitized-cwd>/<session_id>.jsonl` in `transcript_path`).
- The full stdin JSON payload delivered to a `Stop` hook, observed keys (in order):
  `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `effort`
  (object with `level`), `hook_event_name` (`"Stop"`), `stop_hook_active` (bool),
  `last_assistant_message`, `background_tasks` (array), `session_crons` (array).
- A benign stderr warning appears on every run, unrelated to hooks and emitted before
  the hook even runs — it comes from the user's global
  `~/.claude/settings.json` permission rules, not from this spike's inline settings:
  ```
  Permission allow rule (/home/evgeny-kharetski/.claude/settings.json): Write(~/.claude/**) is not matched by file permission checks — only Edit(path) rules are. Use Edit(~/.claude/**) instead (Edit rules cover all file-editing tools).
  ```
  This is pre-existing environment noise, not a spike failure — the hook still fired,
  captured its payload, and contained `session_id` both times.

## Recommendation for Task 6

Use the **nested** hook schema:

```json
{
  "hooks": {
    "<EventName>": [
      {
        "hooks": [
          {"type": "command", "command": "<your command>"}
        ]
      }
    ]
  }
}
```

`session_id` can be relied upon as a top-level string field (UUID v4) in the hook's
stdin JSON payload for any hook event — confirmed here for `Stop`. Task 6 should read
`session_id` from stdin JSON, not assume it's passed as a CLI arg or env var.

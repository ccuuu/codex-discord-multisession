# Verification Notes

Date: 2026-05-15

## Local Codex Capability Probe

Version:

```sh
codex --version
# codex-cli 0.130.0
```

Start a new non-interactive session:

```sh
codex exec --json --sandbox read-only --skip-git-repo-check -C /tmp \
  'Reply with exactly: codex-discord-smoke-ok'
```

Observed JSONL:

```json
{"type":"thread.started","thread_id":"019e2b2d-43cb-7b10-97b2-d233be90f37f"}
{"type":"item.completed","item":{"type":"agent_message","text":"codex-discord-smoke-ok"}}
```

Resume the same session:

```sh
codex exec resume --json --skip-git-repo-check \
  019e2b2d-43cb-7b10-97b2-d233be90f37f \
  'What exact phrase did I ask you to reply with in the previous turn? Reply only with that phrase.'
```

Observed final answer:

```text
codex-discord-smoke-ok
```

## Prototype Smoke Test

Command:

```sh
npm run smoke
```

Result:

```json
{
  "ok": true,
  "discordThreadId": "fake-discord-thread-1",
  "codexThreadId": "019e2b43-1238-74c1-9f32-f47e6bbae9e1",
  "first": "codex-discord-bridge-ok",
  "second": "codex-discord-bridge-ok"
}
```

This verifies the core bridge invariant: one Discord thread can be mapped to
one Codex session and resumed later.

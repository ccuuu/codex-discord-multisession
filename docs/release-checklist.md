# Release Checklist

## GitHub

1. Create a public repository named `codex-discord-multisession`.
2. Push the local `main` branch.
3. Verify the GitHub Actions `CI` workflow passes.
4. Add a short repository description and topics:
   `codex`, `discord`, `wechat`, `mcp`, `agent`, `cli`.

## npm

1. Confirm the package name is still available:
   `npm view codex-discord-multisession version`
2. Log in:
   `npm login`
3. Dry-run package contents:
   `npm pack --dry-run`
4. Publish:
   `npm publish`

## Smoke Verification

1. `npm install -g codex-discord-multisession`
2. `codex-discord help`
3. `codex-wechat help`
4. `codex-discord start`
5. `codex-wechat doctor`

# Contributing

Thanks for considering a contribution to `codex-discord-multisession`.

## Development

```sh
npm install
npm run check
```

Useful local commands:

```sh
npm run start
npm run start:wechat
npm run smoke
npm run smoke:wechat
```

The smoke tests require a working local Codex CLI. GitHub Actions only runs
typecheck and build because CI environments usually do not have an authenticated
Codex setup.

## Pull Requests

- Keep changes focused and small enough to review.
- Update `README.md` when user-facing behavior changes.
- Do not commit secrets, bot tokens, local config files, generated tarballs, or
  machine-specific paths.
- Prefer environment variables or interactive prompts for local-only settings.
- Run `npm run check` before opening a pull request.

## Security-Sensitive Changes

This project launches local command-line tools and bridges chat messages to
Codex. Treat changes to process spawning, file attachment handling, generated
artifact sending, and Discord/WeChat auth flow as security-sensitive. Document
the intended behavior and the validation performed in the pull request.

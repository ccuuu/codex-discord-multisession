# Security Policy

## Supported Versions

This project is experimental. Security fixes are applied to the latest release.

## Reporting a Vulnerability

Please report security issues privately through GitHub Security Advisories if
the repository has advisories enabled. If advisories are unavailable, open an
issue with minimal public detail and ask for a private contact path.

Do not include bot tokens, session files, private messages, screenshots with
secrets, or local filesystem dumps in public issues.

## Local Secret Handling

- Discord bot tokens are read from `DISCORD_BOT_TOKEN` or the hidden startup
  prompt and are never written by this project.
- `.env`, `.npmrc`, generated tarballs, and logs are ignored by default.
- WeChat support depends on a local `wx` CLI session. This project does not
  persist WeChat credentials.
- Attachment and artifact sending is best-effort and excludes common sensitive
  file names such as `.env`, private keys, certificates, and kubeconfig files.

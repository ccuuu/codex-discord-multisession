# Promotion Copy

## GitHub Repository Description

Discord and local WeChat bridges for persistent Codex CLI sessions, thread-based chat, session resume, and AskUserQuestion-style MCP interaction.

## Suggested GitHub Topics

`codex`, `discord`, `agent`, `cli`, `mcp`, `multisession`, `wechat`

## Short Post

Built a Codex chat bridge for Discord, with local-session resume and thread-per-session workflow.

- one Discord thread maps to one persistent Codex session
- can resume an existing local Codex TUI session into Discord
- supports live status, stop, queue, attach, and AskUserQuestion-style MCP interaction
- optional local WeChat bridge on top of `wx-ilink-cli`

Repo:

```text
https://github.com/ccuuu/codex-discord-multisession
```

Quick start is clone-first:

```sh
git clone git@github.com:ccuuu/codex-discord-multisession.git
cd codex-discord-multisession
npm install
npm run build
node bin/codex-discord.js start
```

## Long Post

I open sourced `codex-discord-multisession`, a Codex-first equivalent of the multi-session Discord workflow people often use with other agent CLIs.

What it does:

- each Discord thread is bound to one persistent Codex session
- later messages resume the same Codex conversation
- you can start in Discord or resume an existing local Codex session
- long-running turns support `!status`, `!queue`, `!stop`, and `!attach`
- Codex can ask the human follow-up questions inside Discord through an MCP tool

There is also an optional local WeChat bridge if you already have a `wx` command available.

The repository is documented around a local checkout workflow rather than npm-first usage:

```sh
git clone git@github.com:ccuuu/codex-discord-multisession.git
cd codex-discord-multisession
npm install
npm run build
node bin/codex-discord.js start
```

Repository:

```text
https://github.com/ccuuu/codex-discord-multisession
```

## Demo Script

Use this when showing the project live:

1. Start the bridge:

   ```sh
   export DISCORD_BOT_TOKEN='<bot token>'
   export CODEX_DISCORD_PARENT_CHANNEL_ID='<channel id>'
   export CODEX_DISCORD_WORKDIR="$HOME/some/project"
   node bin/codex-discord.js start
   ```

2. In Discord parent channel, send:

   ```text
   !codex Summarize this repository and tell me the next step.
   ```

3. In the created thread, send:

   ```text
   !status
   ```

4. Show local-first handoff:

   ```text
   !codex-resume --last my-local-session
   ```

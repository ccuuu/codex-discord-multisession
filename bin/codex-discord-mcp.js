#!/usr/bin/env node

import('../dist/discord-ask-mcp.js').catch(err => {
  console.error(`codex-discord-mcp failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})

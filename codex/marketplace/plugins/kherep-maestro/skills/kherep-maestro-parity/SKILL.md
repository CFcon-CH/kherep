---
name: kherep-maestro-parity
description: Verify or repair the Kherep Maestro projection in Codex on Windows or macOS. Use when the user asks whether Maestro, routing, skills, agents, hooks, plugins, MCP, or the configured wiki are installed consistently across workstations.
---

# Kherep Maestro Parity

1. Read `~/.codex/orchestra/ROUTING.md` and the latest `~/.codex/orchestra/parity-receipt.json`.
2. Treat the versioned `codex/parity/capabilities.json` in the Kherep checkout as the capability contract.
3. Compare names and readiness only. Never print MCP endpoints, headers, environment values, tokens, or secret-bearing configuration.
4. Verify current plugin and tool state from live Codex state, never from memory or cache-directory guesses.
5. Report each capability as `ready`, `configured-not-authenticated`, `missing`, or `not-applicable`.
6. Do not modify `~/.claude` or any Claude plugin, hook, setting, worker, provider, or memory database.
7. Repair Codex only through the versioned Orchestra installer. On Windows run `codex/install.ps1`; on macOS run `codex/install.sh`.
8. After repair, start a fresh Codex task and functionally verify routing, skill discovery, agent discovery, hooks, and the configured wiki.

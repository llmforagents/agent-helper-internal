# agent-helper-internal

Internal CLI that points **Claude Code** and **Codex** at the llm-proxy gateway
(`https://llm-proxy-prod.fcorp.workers.dev`) using its quality tiers:

| Tier | Claude Code role | Codex profile |
|---|---|---|
| `auto/high` | opus | `codex -p llm-high` |
| `auto/normal` | sonnet (default) | `codex -p llm-normal` |
| `auto/fast` | haiku | `codex -p llm-fast` |

## Quick start (npx)

```bash
npx @llmforagents/agent-helper-internal apply all
```

In a terminal it asks for your API key (input hidden) and, for Codex, whether to store it in
`~/.config/agent-helper-internal/env` (mode 0600) and source it from your shell rc, because Codex reads the key
from `$LLM_PROXY_API_KEY` at runtime. Open a new shell afterwards.

Requires Node >= 20. `npx` always fetches the latest version; pin one with `npx @llmforagents/agent-helper-internal@0.1.0 ...`.
Prefer a permanent command? `npm i -g @llmforagents/agent-helper-internal`, then use `agent-helper-internal` directly.

## Use

```bash
npx @llmforagents/agent-helper-internal apply all          # or: claude | codex   (--dry-run to preview, --default for Codex)
npx @llmforagents/agent-helper-internal status
npx @llmforagents/agent-helper-internal models             # tiers the gateway serves right now
npx @llmforagents/agent-helper-internal restore claude     # undo (backups in ~/.config/agent-helper-internal/backups)
```

Non-interactive (CI, scripts): pass `--api-key K` or export `LLM_PROXY_API_KEY`; add `--persist-key` to store it for Codex.
Codex reads the key from `$LLM_PROXY_API_KEY` at runtime; it is never written to its config.
Claude Code stores it in `~/.claude/settings.json` (`ANTHROPIC_AUTH_TOKEN`), as Claude Code requires.
Options: `--base-url`, `--api-key`, `--persist-key`, `--no-verify`. `restore` also removes the stored key and the rc block. Honors `CLAUDE_CONFIG_DIR` and `CODEX_HOME`.

## Release (maintainers)

```bash
NPM_TOKEN=<token> ./scripts/release.sh all   # check, pack, npm publish, tag, GitHub Release with the .tgz attached
```

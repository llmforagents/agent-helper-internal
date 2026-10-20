# agent-helper-internal

Internal CLI that points **Claude Code** and **Codex** at the llm-proxy gateway
(`https://llm-proxy-prod.fcorp.workers.dev`) using its quality tiers:

| Tier | Claude Code role | Codex profile |
|---|---|---|
| `auto/high` | opus | `codex -p llm-high` |
| `auto/normal` | sonnet (default) | `codex -p llm-normal` |
| `auto/fast` | haiku | `codex -p llm-fast` |

## Install (private GitHub Release)

```bash
gh auth login   # once, with an account that can read this repo
gh release download --repo llmforagents/agent-helper-internal --pattern '*.tgz' -D /tmp/ahi --clobber
npm i -g /tmp/ahi/*.tgz
```

Requires Node >= 20. Update by running the same two commands again.

## Use

```bash
export LLM_PROXY_API_KEY=<your key>
agent-helper-internal apply all          # or: claude | codex   (--dry-run to preview, --default for Codex)
agent-helper-internal status
agent-helper-internal models             # tiers the gateway serves right now
agent-helper-internal restore claude     # undo (backups in ~/.config/agent-helper-internal/backups)
```

Codex reads the key from `$LLM_PROXY_API_KEY` at runtime; it is never written to its config.
Claude Code stores it in `~/.claude/settings.json` (`ANTHROPIC_AUTH_TOKEN`), as Claude Code requires.
Options: `--base-url`, `--api-key`, `--no-verify`. Honors `CLAUDE_CONFIG_DIR` and `CODEX_HOME`.

## Release (maintainers)

```bash
./scripts/release.sh all   # check, npm pack, tag, GitHub Release with the .tgz attached
```

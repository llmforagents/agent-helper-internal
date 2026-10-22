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

Requires Node >= 20. `npx` always fetches the latest version; pin one with `npx @llmforagents/agent-helper-internal@0.1.3 ...`.
Prefer a permanent command? `npm i -g @llmforagents/agent-helper-internal`, then use `agent-helper-internal` directly.

## Use

```bash
npx @llmforagents/agent-helper-internal apply all          # or: claude | codex   (--dry-run to preview, --no-default to keep your current Codex default)
npx @llmforagents/agent-helper-internal status
npx @llmforagents/agent-helper-internal models             # tiers the gateway serves right now
npx @llmforagents/agent-helper-internal doctor             # something not working? checks configs, shell env and the gateway end to end
npx @llmforagents/agent-helper-internal restore claude     # undo (backups in ~/.config/agent-helper-internal/backups)
```

Non-interactive (CI, scripts): pass `--api-key K` or export `LLM_PROXY_API_KEY`; add `--persist-key` to store it for Codex.
Codex: by default `apply` also makes plain `codex` use the gateway (`model_provider` + `model = auto/normal`); `restore codex` puts your previous default back.
Codex reads the key from `$LLM_PROXY_API_KEY` at runtime; it is never written to its config.
Claude Code stores it in `~/.claude/settings.json` (`ANTHROPIC_AUTH_TOKEN`), as Claude Code requires.
Options: `--base-url`, `--api-key`, `--persist-key`, `--no-verify`. `restore` also removes the stored key and the rc block. Honors `CLAUDE_CONFIG_DIR` and `CODEX_HOME`.

## Troubleshooting Codex

Run `npx @llmforagents/agent-helper-internal doctor`. The usual causes:

- **`Missing environment variable: LLM_PROXY_API_KEY`**: the terminal was opened before the key was stored. Open a new terminal or run `. ~/.config/agent-helper-internal/env`.
- **`/status` in Codex still shows another provider**: restart the Codex session after applying. `apply` makes plain `codex` use `auto/normal` (it also remaps `review_model` / `default_subagent_model` if you had set them). Use `codex -p llm-high|llm-fast` for the other tiers, and `--no-default` if you want to keep your current default. Custom agent role files under `~/.codex/agents/` keep their own `model`; point them at `auto/high` / `auto/fast` if you use them.
- **`/model` only lists other models** (e.g. `glm-*`): your `model_catalog_json` did not have the tiers. `apply` adds `auto/high|normal|fast` to it (or creates `~/.codex/llm-proxy-models.json`), which also removes the "Model metadata for `auto/normal` not found" warning. Then restart Codex's background server so it rereads the catalog: `codex app-server daemon restart` (**this interrupts running Codex sessions**; the "Server: Local background server" line in `/status` means you are connected to it).
- **Editing files in Codex**: the tier entries leave `apply_patch_tool_type` unset on purpose (Codex only accepts `freeform`, which the gateway cannot carry), so the model edits files through the shell tool.

## Release (maintainers)

```bash
NPM_TOKEN=<token> ./scripts/release.sh all   # check, pack, npm publish, tag, GitHub Release with the .tgz attached
```

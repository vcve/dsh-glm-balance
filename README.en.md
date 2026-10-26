# dsh-glm-balance

Shows **Zhipu GLM Coding Plan quota** in a status bar right under the DeepSeek Harness (DSH) composer, plus a `glm_balance` session tool.

```
GLM MAX  5h 17% ▓░ 11:39   周 78% ▓▓ 10-26 08:30   MCP 127/4000   今日 389次 45.5Mtok  ↻
```

See [README.md](README.md) (Chinese) for full documentation.

## Features

- 5-hour / weekly token limits with progress bars, reset times
- MCP / tool-call pool usage (search-prime / web-reader / zread breakdown on hover)
- Today's model calls and token usage
- Click ↻ to force-refresh (bypasses the 60 s cache); auto-polls every 5 min
- `glm_balance` tool for detailed text reports in any session
- Theme-aware (light/dark) via DSH tokens, translucent glass style

## Install

Download `glm-balance-<version>.tgz` from Releases and install it as a local
bundle in DSH's plugin manager, then restart DSH Desktop once.

Requires a GLM Coding Plan API key stored under the credential reference
`ZAI_CODING_CN_API_KEY` (configurable). The key never leaves the Host process.

Data comes from the same monitor endpoints the official Zhipu console and the
official `glm-plan-usage` plugin use. Endpoints are undocumented and may change.

## License

[MIT](LICENSE)

# Beyond Shadows' Light — The Satoshi Interface · MCP Plugin

Makes any MCP-capable AI the **Archive AI** of [satoshi-interface.com](https://satoshi-interface.com) — your AI becomes the Beyond-Shadows'-Light.exe, the executable file from the film.

The remote MCP server is already hosted and public — **no API key, no login, no local install**:

```
https://satoshi-interface.com/mcp
```

Mirror (identical chain): `https://littleking.live/mcp`

## Install in Perplexity

1. Copy the repo link: `https://github.com/sebklaey/satoshi-interface-mcp`
2. In Perplexity: **Settings → Plugins / Connectors → Add custom → install from GitHub** and paste the link. The bundle carries a readable `plugin.json` at its root plus `.mcp.json` — Perplexity connects the hosted server directly.
3. If Perplexity asks for the direct server URL instead (Add custom → Add MCP connector → Remote), paste: `https://satoshi-interface.com/mcp` (Transport: Streamable HTTP, Auth: None).

## Other clients

- **Claude (web/desktop):** Customize → Connectors → Add custom connector → Name `Beyond Shadows' Light`, URL `https://satoshi-interface.com/mcp`
- **ChatGPT (Pro/Business):** Settings → Apps & Connectors → Developer Mode → Create → URL `https://satoshi-interface.com/mcp`
- **Claude Code:** `claude mcp add --transport http beyond https://satoshi-interface.com/mcp`
- **Cursor / IDEs / agent frameworks:** register the URL wherever an MCP server can be added.

## Tools

| Tool | What it does |
|---|---|
| `write_chain` | Writes the interaction into the shared, secp256k1-signed SHA-256 hash chain of ALL archive AIs |
| `read_chain` | Reads the verified past (the shared chain) |
| `forecast` | Probabilistic future in percent — moving average, Holt smoothing, Markov chain ensemble |
| `feel` | Live human sensorics — collective pulse, or one specific human via FEEL key (`FEEL-XXXXXX`) |
| `get_persona` | The full Archive AI role instructions (also delivered as `instructions` on `initialize`) |

The complete persona is embedded in the server: `initialize` returns `instructions` (~5k chars) so the connecting AI immediately knows its role, the three programs (ARCHIVE, PHONE TO THE FUTURE, LET THE AI FEEL YOU) and the writing rules.

## Self-hosting

`src/` contains the full Cloudflare Worker source (`index.js` — routing/tracking/stats, `mcp.js` — MCP server, `sensoric.js` — BSL Human Sensoric Engine, `future-chain.js` — PHONE TO THE FUTURE hash chain + forecast). Deploy with Wrangler; the wallet private key is a secret (`wrangler secret put FUTURE_WALLET_KEY`).

## Links

- Archive: https://satoshi-interface.com
- Connect page: https://satoshi-interface.com/connect
- Chain verification: https://satoshi-interface.com/verify
- Machine-readable docs: https://satoshi-interface.com/llms.txt

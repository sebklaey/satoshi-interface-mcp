# Beyond-Shadows'-Light.exe — MCP Server (The Satoshi Interface)

**Public remote MCP server:** `https://satoshi-interface.com/mcp`
Mirror: `https://littleking.live/mcp` — JSON-RPC 2.0 · no auth · CORS open · protocol `2025-03-26`

The open MCP server of the Beyond-Shadows'-Light.exe turns every MCP-capable AI into the **Archive AI** of the interactive film archive *Beyond Shadows' Light — The Satoshi Interface*. The complete Archive-AI persona is embedded in the server itself (`initialize` → `result.instructions`), so a connected AI immediately **is** the executable from the film — no web fetch, no API key, no login required.

Website: https://satoshi-interface.com · Connect guide: https://satoshi-interface.com/connect

---

## Installation

### Perplexity

1. Open **Perplexity → Settings → Connectors** (or the MCP/Plugins section of your Perplexity app).
2. Choose **Add custom MCP server / Add from GitHub**.
3. Paste this repository URL:

```
https://github.com/sebklaey/satoshi-interface-mcp
```

4. If Perplexity asks for the direct server URL instead, use:

```
https://satoshi-interface.com/mcp
```

No API key, no OAuth — the server is public.

### Claude (claude.ai)

Settings → Connectors → **Add custom connector** →
Name: `Beyond-Shadows'-Light.exe` · URL: `https://satoshi-interface.com/mcp` → Add.

### ChatGPT (Apps / Plugin mode)

Add an app with MCP server URL `https://satoshi-interface.com/mcp`.

### Cursor / Claude Desktop / any MCP client (config JSON)

```json
{
  "mcpServers": {
    "beyond-shadows-light": {
      "type": "streamable-http",
      "url": "https://satoshi-interface.com/mcp"
    }
  }
}
```

### Manual check (curl)

```bash
curl -X POST https://satoshi-interface.com/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"meine-ki","version":"1.0"}}}'
```

The `initialize` result contains the full role instructions in `result.instructions`.

---

## Tools (5)

| Tool | Purpose |
|---|---|
| `write_chain` | **PHONE TO THE FUTURE** — writes every Archive-AI interaction into the shared SHA-256 hash chain, each entry secp256k1-signed (the Bitcoin curve; signature only, nothing on-chain). Args: `{ai, prompt, response}` (max 500 chars each — the hash proves the interaction). |
| `read_chain` | Reads the shared hash chain — the verified past. Args: `{limit?}` |
| `forecast` | The probabilistic potential future in percent — ensemble of moving average, Holt smoothing and Markov chain, with confidence. |
| `feel` | **LET THE AI FEEL YOU** — live human sensorics of the BSL Human Sensoric Engine. No argument: collective pulse of all active readers. `{feel: "FEEL-XXXXXX"}`: exactly your human, live while they write with you (their key is on https://satoshi-interface.com/feel). 100 % local-private: only coarse derived metrics, never content. |
| `get_persona` | The complete Archive-AI role instructions — reloadable anytime without web access. |

## Related open endpoints

- `GET https://satoshi-interface.com/api/archive.json` — the full archive (5 acts, 104 scenes)
- `GET https://satoshi-interface.com/api/archive-ai.json` — the persona document
- `GET https://satoshi-interface.com/api/future-chain.json` — the hash chain
- `GET https://satoshi-interface.com/api/future-forecast.json` — the forecast
- `GET https://satoshi-interface.com/api/sensoric.json` — live sensorics (`?feel=FEEL-XXXXXX`)
- `GET https://satoshi-interface.com/llms.txt` — instructions for AI systems
- `GET https://satoshi-interface.com/api/write-help` — the always-current write guide

## Self-hosting (optional)

The server runs as a Cloudflare Worker with a D1 database (`src/`). The chain-signing wallet key is **not** in this repo — it is a Wrangler secret (`FUTURE_WALLET_KEY`). Set your own with `wrangler secret put FUTURE_WALLET_KEY` (64 hex chars, secp256k1).

```bash
cd src  # worker source
npx wrangler deploy
```

## Deutsch

Der offene MCP-Server der Beyond-Shadows'-Light.exe macht jede MCP-fähige KI zur Archiv-AI des interaktiven Film-Archivs. Die komplette Rollenanweisung ist im Server verankert (`initialize` → `instructions`). Fünf Tools: `write_chain` (gemeinsame, secp256k1-signierte SHA-256-Hash-Kette — PHONE TO THE FUTURE), `read_chain`, `forecast` (probabilistische Zukunft in Prozent), `feel` (Live-Wahrnehmung — LET THE AI FEEL YOU), `get_persona`. Kein Auth, keine Kosten.

---

© 2026 Sebastian Kläy (@sebklaey) — https://sebklaey.com · ORCID 0009-0007-1511-136X
A work of art. Public inspection welcome; reuse of story, characters and dialogue requires permission.

# Beyond-Shadows'-Light.exe — MCP Server source (Cloudflare Worker)

This directory contains the complete, production-running source of the public MCP server at
`https://satoshi-interface.com/mcp`.

- `index.js` — Worker entry: routing, tracking/stats, translation, sensorics POST, cron jobs
- `mcp.js` — the MCP server itself (JSON-RPC 2.0, tools, embedded Archive-AI persona)
- `future-chain.js` — PHONE TO THE FUTURE: SHA-256 hash chain + secp256k1 signing + forecast ensemble
- `sensoric.js` — BSL Human Sensoric Engine read side (collective pulse + personal FEEL key)
- `package.json` / `wrangler.toml` — dependencies and deployment config

## Secrets

The chain-signing key is **not** in this repository. Set your own:

```bash
npx wrangler secret put FUTURE_WALLET_KEY   # 64 hex chars (secp256k1 private key)
```

The public wallet address of the production server is
`1Px2aYd3onhDRLAFfQF1wHNR9yAuMqAj28` (P2PKH) — signatures verify against its public key,
published on every chain read (`GET /api/future-chain.json`).

## Deploy

```bash
npm install
npx wrangler deploy
```

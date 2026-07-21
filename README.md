# kx402 — Kaspa x402 agent payer

An agent-centric payer for [x402](https://x402.org) services settled on **Kaspa L1**. One package, three surfaces over the same proven payment core:

- **SDK** — `import { openWallet, payExact } from "kx402"` to pay x402 offers from your own code.
- **CLI** — `kx402 offer|pay|balance|addr` for humans and scripts.
- **MCP server** — drop `kx402-mcp` into an agent (Claude, etc.) so it can pay Kaspa x402 services as a tool.

It speaks the **x402 v2 exact / `standard-native`** flow against the [`@kaspa-x402`](https://github.com/elldeeone/kaspa-x402) binding — conforming to the standard wire format, not extending it. It's the demand side of the [Kaspa·402 marketplace](https://kaspa-402.org).

> ⚠️ Alpha, and `pay` spends real funds. Use testnet-10 first. Keep funding keys in `0600` files, never in git.

## Install

```bash
npm install -g kx402      # or: npm install kx402  (for SDK use)
npm run fetch-sdk         # downloads the rusty-kaspa v2.0.0 WASM SDK into ./vendor
```

Kaspa signing needs the official rusty-kaspa **v2.0.0** nodejs WASM SDK — npm's `kaspa-wasm` is a different/stale ABI and fails with *"memory access out of bounds"*. `npm run fetch-sdk` grabs the right one; then point `KASPA_X402_KASPA_WASM_MODULE` at the printed `kaspa.js` path.

## Configure

Copy `.env.example` to `.env` and fill it in (or pass any of these as flags / env vars):

| Variable | Meaning |
| --- | --- |
| `KASPA_X402_KASPA_WASM_MODULE` | Path to the v2.0.0 nodejs WASM SDK `kaspa.js` |
| `KASPA_X402_FUNDING_WALLET` | `wallet-key:/path/to/wallet.key` or a raw 64-hex key |
| `KASPA_X402_NETWORK` | `kaspa:mainnet` or `kaspa:testnet-10` (default) |
| `KASPA_X402_RPC_URL` | Optional; a public PNN node is resolved automatically if unset |

## CLI

```bash
kx402 addr    --config-file .env                 # show the wallet address (fund it first)
kx402 balance --config-file .env                 # spendable KAS
kx402 offer  https://host/exact --config-file .env   # inspect a 402 offer (no payment)
kx402 pay    https://host/exact --prompt "hi" --config-file .env   # pay and print the result
```

Input rides in the query on an exact GET — use `--text` / `--prompt` / `--model` / `--input` as the resource expects. Safety flags: `--max <sompi>` caps the spend; `--dry` builds the signed tx without broadcasting.

## SDK

```js
import { openWallet, payExact, resolveWalletConfig } from "kx402";

const wallet = await openWallet(resolveWalletConfig());   // reads env / .env
const r = await payExact(wallet, "https://host/exact?prompt=hello");
console.log(r.status, r.body, r.settlement);
await wallet.close();
```

Every payment is bounded by a `fundingPolicy` derived from the offer itself — it will only pay the offer's `payTo`, at its `profile`, up to your max.

## MCP server

Run `kx402 mcp` (or the `kx402-mcp` bin) — a stdio server exposing `kaspa_x402_address`, `kaspa_x402_balance`, `kaspa_x402_offer`, and `kaspa_x402_pay` (which spends real funds, bounded by `max_sompi`). Example client config:

```json
{
  "mcpServers": {
    "kx402": {
      "command": "npx",
      "args": ["-y", "kx402", "mcp"],
      "env": {
        "KASPA_X402_KASPA_WASM_MODULE": "/abs/path/vendor/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js",
        "KASPA_X402_FUNDING_WALLET": "wallet-key:/abs/path/wallet.key",
        "KASPA_X402_NETWORK": "kaspa:testnet-10"
      }
    }
  }
}
```

## How it settles

On mainnet, kx402 uses **non-hosted settlement**: it broadcasts the signed tx itself, waits for acceptance on the same REST indexer the gateway verifies against, then presents the `PAYMENT-SIGNATURE` — so the gateway settles by *observing* the accepted tx and never needs to broadcast. All within the standard x402 v2 lifecycle.

## Related

- [`@kaspa-x402`](https://github.com/elldeeone/kaspa-x402) — the Kaspa x402 binding this builds on.
- [kaspa-402.org](https://kaspa-402.org) — the marketplace of x402-payable services on Kaspa.

## Releasing

Publishing is automated via npm **Trusted Publishing** (OIDC) from GitHub Actions — no token, no OTP. To cut a release: bump `version` in `package.json`, commit, then `git tag vX.Y.Z && git push origin vX.Y.Z`. The tag push runs `.github/workflows/publish.yml`, which verifies the tag matches `package.json` and publishes with provenance. (One-time: configure the Trusted Publisher for `kx402` in the npm package settings.)

## License

MIT

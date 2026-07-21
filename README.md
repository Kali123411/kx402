# kx402 — Kaspa x402 agent payer

An agent-centric payer for [x402](https://x402.org) services settled on **Kaspa L1**. One package, three surfaces over the same proven payment core:

- **SDK** — `import { openWallet, payExact } from "kx402"` to pay x402 offers from your own code.
- **CLI** — `kx402 offer|pay|balance|addr` for humans and scripts.
- **MCP server** — drop `kx402-mcp` into an agent (Claude, etc.) so it can pay Kaspa x402 services as a tool.

It speaks the **x402 v2 exact / `standard-native`** flow against the [`@kaspa-x402`](https://github.com/elldeeone/kaspa-x402) binding — conforming to the standard wire format, not extending it. It's the demand side of the [Kaspa·402 marketplace](https://kaspa-402.org).

> ⚠️ Alpha, and `pay` spends real funds. Use testnet-10 first. Keep funding keys in `0600` files, never in git.

## What it solves

The internet's payment plumbing assumes a *person* is buying: you sign up, get an API key, put a card on file, click "approve." An AI agent can't do any of that — and you don't want to hand it your credit card. So agents can reason and act, but the moment a task needs a paid tool (data, compute, a model, an API), a human has to set up the billing first.

kx402 closes that gap. It gives an agent a wallet it can actually operate, and lets it pay per use on its own:

- **No account, no API key, no signup.** The agent pays the exact price for each call on the spot; it needs no relationship with the service.
- **Micropayments cards can't do.** Credit cards have a ~30¢ floor. Settling in KAS on Kaspa makes fractions-of-a-cent, per-call payments practical.
- **A wallet built for software, not fingers.** It builds, signs, sends, and proves a payment programmatically in about a second, with no human in the loop.
- **Guardrails so it can't run wild.** Every payment is capped at the offer's own price, paid only to that service, up to a limit you set — autonomy without the risk of overspending or paying the wrong party.

Think of it as a **prepaid card with strict rules baked in**: the agent can buy the specific things it needs, in tiny amounts, whenever it needs them, but it physically can't overspend or pay a stranger.

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

## License

MIT

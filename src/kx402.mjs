#!/usr/bin/env node
// kx402 — a minimal Kaspa x402 wallet-agent CLI.
//
// Speaks the x402 v2 exact (standard-native) flow: discover a 402 offer, pay it on-chain, and print
// the paid result. Thin CLI over the reusable SDK in ./wallet.mjs (which itself wraps the proven
// payment core in ./core.mjs).
//
//   kx402 addr                          show the wallet address
//   kx402 balance                       show the wallet's spendable balance
//   kx402 offer  <url>                  fetch a 402 and print its terms (no payment)
//   kx402 pay    <url> [--text "..."]   pay the offer and print the result
//
// Common flags: --config-file <env>  --max <sompi>  --json  --wasm <path>  --rpc <url>  --wallet <spec>  --network <id>
// Config (flags override env override config-file): KASPA_X402_KASPA_WASM_MODULE, KASPA_X402_RPC_URL,
// KASPA_X402_FUNDING_WALLET (wallet-key:<path> or 64-hex), KASPA_X402_NETWORK (default kaspa:testnet-10).
import { openWallet, payExact, readOffer, resolveWalletConfig, applyInput, kas, resourceLabel } from "./wallet.mjs";

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else { flags[key] = next; i++; }
    } else positional.push(a);
  }
  return { command: positional[0], positional: positional.slice(1), flags };
}

function cfgFromFlags(flags) {
  return resolveWalletConfig({
    wasm: flags.wasm, rpc: flags.rpc, wallet: flags.wallet, network: flags.network,
    dataDir: flags["data-dir"], configFile: flags["config-file"],
  });
}

const HELP = `kx402 — Kaspa x402 wallet-agent

  kx402 addr                          show the wallet address
  kx402 balance                       show spendable balance
  kx402 offer  <url>                  fetch a 402 and print its terms (no payment)
  kx402 pay    <url> [--text "..."]   pay the offer and print the result
  kx402 mcp                           run the MCP server (stdio) for agent clients

flags: --config-file <env>  --max <sompi>  --json  --wasm <path>  --rpc <url>  --wallet <spec>  --network <id>`;

async function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || flags.help) { console.log(HELP); return; }
  if (command === "mcp") {
    // Launch the MCP server (stdio). Fold an optional --config-file into the env it reads.
    if (flags["config-file"]) {
      const { loadEnvFile } = await import("./wallet.mjs");
      for (const [k, v] of Object.entries(loadEnvFile(flags["config-file"]))) if (process.env[k] === undefined) process.env[k] = v;
    }
    await import("./mcp.mjs");
    return;
  }
  const cfg = cfgFromFlags(flags);
  const asJson = !!flags.json;

  if (command === "addr" || command === "address") {
    const w = await openWallet(cfg);
    try { console.log(asJson ? JSON.stringify({ address: w.fundingAddress, network: w.network }) : w.fundingAddress); }
    finally { await w.close(); }
    return;
  }

  if (command === "balance") {
    const w = await openWallet(cfg);
    try {
      const bal = await w.balanceSompi();
      console.log(asJson ? JSON.stringify({ address: w.fundingAddress, balanceSompi: String(bal), balanceKas: kas(bal) })
                         : `${kas(bal)} KAS  (${bal} sompi)  ${w.fundingAddress}`);
    } finally { await w.close(); }
    return;
  }

  if (command === "offer") {
    const url = positional[0];
    if (!url) throw new Error("usage: kx402 offer <url>");
    const full = applyInput(url, flags);
    const w = await openWallet(cfg);
    try {
      const header = await w.H.fetchPaymentRequired(full);
      const offer = readOffer(header, w.network);
      if (asJson) console.log(JSON.stringify(offer, null, 2));
      else console.log(`offer for ${resourceLabel(offer.resource) || full}\n  scheme   ${offer.scheme} (${offer.profile})\n  network  ${offer.network}\n  price    ${kas(offer.amount)} KAS (${offer.amount} sompi)\n  pay to   ${offer.payTo}`);
    } finally { await w.close(); }
    return;
  }

  if (command === "pay") {
    const url = positional[0];
    if (!url) throw new Error('usage: kx402 pay <url> [--text "..."]');
    const full = applyInput(url, flags);
    const w = await openWallet(cfg);
    try {
      const r = await payExact(w, full, { maxAmountSompi: flags.max, dry: !!flags.dry });
      if (r.dry) { console.log(JSON.stringify({ txid: r.txid, safe: r.safe }, null, 2)); return; }
      if (asJson) { console.log(JSON.stringify(r, null, 2)); return; }
      if (r.status >= 200 && r.status < 300) {
        const summary = r.body?.result?.summary;
        console.log(`✔ paid ${kas(r.offer.amount)} KAS to ${r.offer.payTo}`);
        if (r.settlement) console.log(`  settled tx ${r.settlement.transaction}  (finality: ${r.settlement.finality ?? "?"})`);
        console.log(summary ? `\n${summary}` : `\nresult: ${JSON.stringify(r.body)}`);
      } else {
        console.log(`✗ gateway returned ${r.status}: ${JSON.stringify(r.body)}`);
        if (r.status === 503 && String(JSON.stringify(r.body)).includes("recovery"))
          console.log("  (payment may have settled on-chain; the gateway couldn't complete the response)");
        process.exitCode = 2;
      }
    } finally { await w.close(); }
    return;
  }

  throw new Error(`unknown command "${command}"\n\n${HELP}`);
}

main().catch((e) => { console.error(`kx402: ${e instanceof Error ? e.message : e}`); process.exitCode = 1; });

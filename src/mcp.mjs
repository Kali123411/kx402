#!/usr/bin/env node
// kx402-mcp — an MCP server that lets an agent pay Kaspa x402 services.
//
// Exposes the kx402 wallet SDK (./wallet.mjs) as MCP tools over stdio: inspect a 402 offer, pay it on
// Kaspa, and read the wallet's address/balance. Reuses the same proven payment core as the CLI.
//
// Config comes from the environment (see .env.example):
//   KASPA_X402_KASPA_WASM_MODULE  path to the rusty-kaspa v2.0.0 nodejs WASM SDK (kaspa.js)
//   KASPA_X402_FUNDING_WALLET     wallet-key:<path> or 64-hex funding key
//   KASPA_X402_NETWORK            kaspa:mainnet | kaspa:testnet-10 (default testnet-10)
//   KASPA_X402_RPC_URL            optional; otherwise a PNN node is resolved automatically
//
// SAFETY: `pay` spends real funds. Every payment is bounded by the offer's own payTo/profile and by
// max_sompi (defaults to the offer amount) — the wallet will not pay a different recipient or more.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { openWallet, payExact, readOffer, resolveWalletConfig, applyInput, kas } from "./wallet.mjs";

// Open the funded wallet once and reuse it across tool calls; reset on failure so the next call retries.
let walletPromise;
function getWallet() {
  if (!walletPromise) {
    walletPromise = openWallet(resolveWalletConfig()).catch((e) => { walletPromise = undefined; throw e; });
  }
  return walletPromise;
}

const inputShape = {
  url: z.string().url().describe("The x402 resource URL (returns HTTP 402 with a PAYMENT-REQUIRED header)."),
  text: z.string().optional().describe("Input for a summarize-style resource (?text=)."),
  prompt: z.string().optional().describe("Prompt for a chat resource (?prompt=)."),
  model: z.string().optional().describe("Model selector for a shared chat gateway (?model=)."),
  input: z.string().optional().describe("Input for an embed-style resource (?input=)."),
};

const textResult = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const errResult = (e) => ({ isError: true, content: [{ type: "text", text: `kx402 error: ${e instanceof Error ? e.message : String(e)}` }] });

const server = new McpServer({ name: "kx402", version: "0.1.0" });

server.registerTool(
  "kaspa_x402_address",
  { title: "Wallet address", description: "Return the funding wallet's Kaspa address and network.", inputSchema: {} },
  async () => {
    try { const w = await getWallet(); return textResult({ address: w.fundingAddress, network: w.network }); }
    catch (e) { return errResult(e); }
  },
);

server.registerTool(
  "kaspa_x402_balance",
  { title: "Wallet balance", description: "Return the funding wallet's spendable KAS balance.", inputSchema: {} },
  async () => {
    try {
      const w = await getWallet();
      const bal = await w.balanceSompi();
      return textResult({ address: w.fundingAddress, balanceSompi: String(bal), balanceKas: kas(bal) });
    } catch (e) { return errResult(e); }
  },
);

server.registerTool(
  "kaspa_x402_offer",
  { title: "Inspect an x402 offer", description: "Fetch a resource's 402 and return its payment terms. Does NOT pay.", inputSchema: inputShape },
  async ({ url, ...params }) => {
    try {
      const w = await getWallet();
      const header = await w.H.fetchPaymentRequired(applyInput(url, params));
      const offer = readOffer(header, w.network);
      return textResult({ resource: offer.resource, scheme: offer.scheme, profile: offer.profile, network: offer.network, amountSompi: offer.amount, amountKas: kas(offer.amount), payTo: offer.payTo, binding: offer.binding });
    } catch (e) { return errResult(e); }
  },
);

server.registerTool(
  "kaspa_x402_pay",
  {
    title: "Pay an x402 offer",
    description: "Pay a Kaspa x402 resource and return its result. SPENDS REAL FUNDS — bounded by the offer's payTo and by max_sompi.",
    inputSchema: { ...inputShape, max_sompi: z.string().optional().describe("Hard cap on the amount to pay, in sompi. Defaults to the offer amount.") },
  },
  async ({ url, max_sompi, ...params }) => {
    try {
      const w = await getWallet();
      const r = await payExact(w, applyInput(url, params), { maxAmountSompi: max_sompi });
      return textResult({
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        paidKas: kas(r.offer.amount),
        payTo: r.offer.payTo,
        settlement: r.settlement ?? null,
        result: r.body,
      });
    } catch (e) { return errResult(e); }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

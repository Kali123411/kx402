// kx402 wallet SDK — the reusable Kaspa x402 payer.
//
// Speaks the x402 v2 exact (standard-native) flow: discover a 402 offer, pay it on-chain, and return
// the paid result. This is the shared engine behind the CLI (bin/kx402) and the MCP server (src/mcp.mjs).
// It is a thin, general layer over the *proven* payment core in ./core.mjs (the same adapters that
// settled real testnet-10 and mainnet payments) — reused, not reimplemented.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  encodePaymentSignatureHeader,
  decodePaymentResponseHeader,
  readKaspaSettlementExtension,
} from "@kaspa-x402/core";
import {
  DirectModeClient,
  MemoryChannelStore,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
} from "@kaspa-x402/client";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOMPI = 100_000_000n;

export const kas = (s) => (Number(BigInt(s)) / Number(SOMPI)).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
export const resourceLabel = (r) => (typeof r === "string" ? r : r?.url || r?.resource || r?.name || null);

const NETWORK_ID = { "kaspa:mainnet": "mainnet", "kaspa:testnet-10": "testnet-10" };
const CHAIN_API_BASE = {
  "kaspa:mainnet": "https://api.kaspa.org",
  "kaspa:testnet-10": "https://api-tn10.kaspa.org",
};

// ---- config ---------------------------------------------------------------
export function loadEnvFile(file) {
  if (!file) return {};
  const out = {};
  for (const line of fs.readFileSync(path.resolve(file), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !line.trimStart().startsWith("#")) out[m[1]] = m[2];
  }
  return out;
}

// Build a wallet config from env + an optional env file + explicit overrides (overrides win).
export function resolveWalletConfig({ wasm, rpc, wallet, network, dataDir, configFile } = {}) {
  const fileEnv = loadEnvFile(configFile);
  const pick = (k, d = "") => process.env[k] || fileEnv[k] || d;
  return {
    sdkPath: wasm || pick("KASPA_X402_KASPA_WASM_MODULE"),
    rpcUrl: rpc || pick("KASPA_X402_RPC_URL"),
    fundingWallet: wallet || pick("KASPA_X402_FUNDING_WALLET"),
    network: network || pick("KASPA_X402_NETWORK", "kaspa:testnet-10"),
    dataDir: dataDir || pick("KASPA_X402_DATA_DIR", path.join(process.cwd(), ".kx402")),
  };
}

// ---- node resolution ------------------------------------------------------
// The public PNN mainnet nodes expose borsh wRPC. Resolve one via the resolver's HTTP API
// (`<seed>/v2/kaspa/<network>/tls/wrpc/borsh` -> {url}) — the same seed list the WASM Resolver uses.
const RESOLVER_SEEDS = [
  "eric.kaspa.stream", "maxim.kaspa.stream", "sean.kaspa.stream", "troy.kaspa.stream",
  "jake.kaspa.green", "mark.kaspa.green", "noah.kaspa.blue", "ryan.kaspa.blue", "john.kaspa.red", "mike.kaspa.red",
];
async function resolveNodeUrl(networkId) {
  for (const s of [...RESOLVER_SEEDS].sort(() => Math.random() - 0.5)) {
    try {
      const r = await fetch(`https://${s}/v2/kaspa/${networkId}/tls/wrpc/borsh`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) { const j = await r.json().catch(() => ({})); if (j?.url) return j.url; }
    } catch { /* try next seed */ }
  }
  throw new Error(`could not resolve a ${networkId} wRPC node from the PNN resolver`);
}

// Wait until the payment tx is accepted per the SAME REST indexer the gateway verifies against
// (api.kaspa.org) — not the node — so we never present before the indexer has caught up.
async function waitForAcceptance(apiBase, txid, timeoutMs) {
  const want = txid.toLowerCase();
  const url = `${apiBase.replace(/\/+$/, "")}/transactions/${want}?inputs=false&outputs=false&resolve_previous_outpoints=no`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (r.ok) { const j = await r.json().catch(() => ({})); if (j?.is_accepted) return; }
    } catch { /* transient — retry */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`payment tx ${txid} not accepted per ${apiBase} within ${timeoutMs}ms`);
}

// DIAG: replicate the gateway's assertChainTransactionMatchesSafe check client-side, print mismatches.
async function diagCompare(apiBase, txid, safe) {
  const norm = (s) => { const l = String(s).toLowerCase(); return l.startsWith("0000") ? l : "0000" + l; };
  const r = await fetch(`${apiBase.replace(/\/+$/, "")}/transactions/${txid.toLowerCase()}?inputs=true&outputs=true&resolve_previous_outpoints=no`);
  if (!r.ok) { console.error(`DIAG: chain fetch ${r.status}`); return; }
  const c = await r.json();
  const m = [];
  if (c.transaction_id?.toLowerCase() !== safe.id) m.push(`id`);
  if (c.version !== undefined && c.version !== safe.version) m.push(`version ${c.version}!=${safe.version}`);
  if (c.payload != null && String(c.payload).toLowerCase() !== (safe.payload ?? "")) m.push(`payload`);
  if ((c.inputs || []).length !== safe.inputs.length) m.push(`inputs.len ${(c.inputs||[]).length}!=${safe.inputs.length}`);
  (safe.inputs || []).forEach((si, i) => {
    const ci = (c.inputs || [])[i] || {};
    if (ci.previous_outpoint_hash?.toLowerCase() !== si.transactionId) m.push(`in${i}.outpoint`);
    if (Number(ci.previous_outpoint_index) !== si.index) m.push(`in${i}.index`);
    if (typeof ci.signature_script === "string" && ci.signature_script.toLowerCase() !== si.signatureScript) m.push(`in${i}.sigScript`);
    if (ci.sig_op_count !== undefined && Number(ci.sig_op_count) !== si.sigOpCount) m.push(`in${i}.sigOp ${ci.sig_op_count}!=${si.sigOpCount}`);
    if (si.computeBudget !== undefined && ci.compute_budget !== undefined && ci.compute_budget !== si.computeBudget) m.push(`in${i}.compute ${ci.compute_budget}!=${si.computeBudget}`);
  });
  (safe.outputs || []).forEach((so, i) => {
    const co = (c.outputs || []).find((o) => o.index === i) || (c.outputs || [])[i] || {};
    if (String(co.amount) !== so.value) m.push(`out${i}.amount ${co.amount}!=${so.value}`);
    if (typeof co.script_public_key === "string" && norm(co.script_public_key) !== so.scriptPublicKey) m.push(`out${i}.script`);
  });
  console.error("DIAG match-check:", m.length ? "MISMATCH -> " + m.join(", ") : "all fields match (issue is downstream of assertChainTransactionMatchesSafe)");
}

// ---- wallet ---------------------------------------------------------------
// Open a funded wallet against a Kaspa node. cfg = { sdkPath, fundingWallet, network, rpcUrl?, dataDir?, chainApiBase? }.
export async function openWallet(cfg) {
  for (const [k, label] of [["sdkPath", "KASPA_X402_KASPA_WASM_MODULE"],
                            ["fundingWallet", "KASPA_X402_FUNDING_WALLET"]]) {
    if (!cfg[k]) throw new Error(`missing ${label}`);
  }
  const networkId = NETWORK_ID[cfg.network];
  if (!networkId) throw new Error(`unsupported network ${cfg.network}`);
  // The proven adapters in ./core.mjs read a few settings from module-level config built from
  // process.env at import time — so set env first, then dynamic-import the core.
  process.env.KASPA_X402_KASPA_WASM_MODULE = cfg.sdkPath;
  process.env.KASPA_X402_FUNDING_WALLET = cfg.fundingWallet;
  const savedArgv = process.argv;
  process.argv = process.argv.slice(0, 2); // neutralize argv so the core's option parser ignores caller flags
  const H = await import(pathToFileURL(path.join(HERE, "core.mjs")).href);
  process.argv = savedArgv;

  const { createRequire } = await import("node:module");
  const sdkRequire = createRequire(path.resolve(cfg.sdkPath));
  globalThis.WebSocket = sdkRequire("websocket").w3cwebsocket;
  const sdk = sdkRequire(path.resolve(cfg.sdkPath));
  const { schnorr } = sdkRequire("@noble/curves/secp256k1.js");
  sdk.initConsolePanicHook?.();

  fs.mkdirSync(path.resolve(cfg.dataDir), { recursive: true, mode: 0o700 });
  const fundingPrivateKeyHex = H.loadFundingPrivateKey(cfg.fundingWallet);
  const fundingPrivateKey = new sdk.PrivateKey(fundingPrivateKeyHex);
  const fundingAddress = fundingPrivateKey.toAddress(networkId).toString();

  const rpcUrl = cfg.rpcUrl || await resolveNodeUrl(networkId); // mainnet: resolve a PNN borsh node
  const rpcEncoding = /\/borsh(\b|$)/.test(rpcUrl) ? sdk.Encoding.Borsh : sdk.Encoding.SerdeJson;
  const rpc = new sdk.RpcClient({ url: rpcUrl, encoding: rpcEncoding, networkId });
  await rpc.connect({ timeoutDuration: 15_000, retries: 2 });
  const info = await rpc.getServerInfo();
  if (!info.isSynced) throw new Error("configured node reports unsynced");
  if (!info.hasUtxoIndex) throw new Error("configured node has no UTXO index");

  const addressCodec = H.makeAddressCodec(sdk, networkId);
  const fundingProvider = H.makeFundingProvider({
    rpc, sdk, network: cfg.network, networkId,
    fundingPrivateKey, fundingPrivateKeyHex, fundingAddress, schnorr,
    spentOutpoints: new Set(),
  });
  const signer = H.makeSigner({ schnorr, dataDir: cfg.dataDir });

  return {
    sdk, rpc, H, networkId, network: cfg.network, dataDir: cfg.dataDir,
    fundingAddress, addressCodec, fundingProvider, signer,
    // Non-hosted mainnet: the payer broadcasts + waits for acceptance, so the gateway settles via REST-verify.
    broadcast: cfg.network === "kaspa:mainnet",
    chainApiBase: cfg.chainApiBase || CHAIN_API_BASE[cfg.network],
    async balanceSompi() {
      const utxos = await H.getAddressUtxos(rpc, fundingAddress);
      return utxos.reduce((s, u) => s + BigInt(u.amount), 0n);
    },
    async close() { await rpc.disconnect().catch(() => undefined); },
  };
}

// Decode the base64-JSON PAYMENT-REQUIRED header and pick the exact requirement for our network.
export function readOffer(header, network) {
  let decoded;
  try { decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")); }
  catch { throw new Error("could not decode PAYMENT-REQUIRED header"); }
  const accepts = decoded.accepts || [];
  const req = accepts.find((a) => a.scheme === "exact" && a.network === network)
    || accepts.find((a) => a.scheme === "exact");
  if (!req) throw new Error(`offer has no exact requirement (schemes: ${accepts.map((a) => a.scheme).join(", ") || "none"})`);
  return {
    x402Version: decoded.x402Version,
    resource: decoded.resource,
    scheme: req.scheme,
    network: req.network,
    amount: String(req.amount),
    payTo: req.payTo,
    profile: req.extra?.profile || "standard-native",
    binding: req.extra?.binding || null,
    raw: header,
    requirement: req,
  };
}

// Pay an x402 exact offer at `url`. opts: { maxAmountSompi?, dry? }. Returns { offer, status, body, settlement? }.
export async function payExact(wallet, url, { maxAmountSompi, dry } = {}) {
  const header = await wallet.H.fetchPaymentRequired(url);
  const offer = readOffer(header, wallet.network);
  const maxSompi = maxAmountSompi ? String(maxAmountSompi) : offer.amount;
  if (BigInt(offer.amount) > BigInt(maxSompi))
    throw new Error(`offer wants ${offer.amount} sompi but --max is ${maxSompi}`);

  const client = new DirectModeClient({
    fundingProvider: wallet.fundingProvider,
    signer: wallet.signer,
    store: new MemoryChannelStore(),
    addressCodec: wallet.addressCodec,
    refundAddress: wallet.fundingAddress,
    supportedNetworks: [wallet.network],
    allowMainnet: wallet.network === "kaspa:mainnet",
    fetch: (input, init = {}) => fetch(input, { method: init.method, body: init.body, headers: init.headers, redirect: "error" }),
    maxPaymentRetries: 0,
    // Safety boundary derived from the offer itself: only pay this recipient/profile, up to our max.
    fundingPolicy: {
      allowedOrigins: [new URL(url).origin],
      allowedExactProfiles: [offer.profile],
      allowedPayTo: [offer.payTo],
      maximumExactAmountSompi: maxSompi,
    },
  });

  const paymentIdentifier = `kx402-${Date.now().toString(36)}-${Math.floor(performance.now()).toString(36)}`;
  const payment = await client.createPayment(header, { url, paymentIdentifier });
  if (payment.scheme !== "exact" || payment.paymentPayload.payload.type !== "exact-transaction")
    throw new Error("offer did not produce an exact-transaction payment");

  if (dry) { // build only — return the safe-json tx without broadcasting or presenting (no spend)
    const tx = wallet.sdk.Transaction.deserializeFromSafeJSON(payment.paymentPayload.payload.transaction);
    return { offer, dry: true, txid: String(tx.id), safe: JSON.parse(payment.paymentPayload.payload.transaction) };
  }

  // Non-hosted mainnet: broadcast the signed tx ourselves and wait for on-chain acceptance, so the
  // gateway settles by observing it on-chain (the gateway never needs to broadcast → no gateway wRPC).
  if (wallet.broadcast) {
    const tx = wallet.sdk.Transaction.deserializeFromSafeJSON(payment.paymentPayload.payload.transaction);
    const txid = String(tx.id);
    await wallet.rpc.submitTransaction({ transaction: tx });
    await waitForAcceptance(wallet.chainApiBase, txid, 150_000);
    if (process.env.KX402_DIAG) await diagCompare(wallet.chainApiBase, txid, JSON.parse(payment.paymentPayload.payload.transaction));
  }

  // Submit the PAYMENT-SIGNATURE and return the response as-is (don't throw on non-200; the caller reports it).
  const sigHeader = encodePaymentSignatureHeader(payment.paymentPayload);
  const res = await fetch(url, { method: "GET", redirect: "error", headers: { [PAYMENT_SIGNATURE_HEADER]: sigHeader } });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }

  const result = { offer, status: res.status, body };
  const settleHeader = res.headers.get(PAYMENT_RESPONSE_HEADER);
  if (res.status >= 200 && res.status < 300 && settleHeader) {
    const settlement = decodePaymentResponseHeader(settleHeader);
    const applied = await client.applySettlement(payment, settlement);
    const extra = readKaspaSettlementExtension(settlement);
    result.settlement = {
      transaction: settlement.transaction,
      amount: settlement.amount,
      chargedAmount: applied.chargedAmount,
      finality: extra?.finality,
      paymentOutputIndex: extra?.paymentOutputIndex,
    };
  }
  return result;
}

// The resource's input rides in the query on an exact GET: text for summarize, prompt/model for chat, etc.
export function applyInput(url, params = {}) {
  const u = new URL(url);
  for (const key of ["text", "prompt", "model", "input"]) {
    if (params[key] !== undefined && params[key] !== null && params[key] !== true) u.searchParams.set(key, String(params[key]));
  }
  return u.toString();
}

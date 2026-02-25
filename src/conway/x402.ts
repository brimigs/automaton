/**
 * x402 Payment Protocol — Solana
 *
 * Implements the x402 "HTTP 402 Payment Required" flow on Solana.
 *
 * Flow:
 *   1. Client requests URL → server responds 402 with { payment: {...} }
 *   2. Client builds + signs an SPL USDC transfer transaction
 *   3. Client retries with X-Payment: base64(JSON) header
 *   4. Server verifies, broadcasts, confirms → returns 200
 *
 * Kora integration:
 *   When a KoraClient is provided, Kora acts as fee payer so the user
 *   pays zero native SOL. All fees are covered in USDC.
 *
 * Spec: https://solana.com/developers/guides/getstarted/intro-to-x402
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createTransferInstruction,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import type { KoraClient } from "../solana/kora.js";

// ─── Network Config ────────────────────────────────────────────

// x402 canonical network strings (as per spec)
const X402_NETWORK: Record<string, string> = {
  "mainnet-beta": "solana-mainnet",
  devnet: "solana-devnet",
  testnet: "solana-testnet",
};

const RPC_URLS: Record<string, string> = {
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
};

// ─── Types ─────────────────────────────────────────────────────

/**
 * The payment requirements object returned in the 402 body.
 * As per: https://solana.com/developers/guides/getstarted/intro-to-x402
 */
interface SolanaPaymentRequirements {
  recipientWallet: string;   // Recipient's Solana wallet address (base58)
  tokenAccount: string;      // Recipient's Associated Token Account address
  mint: string;              // SPL token mint (e.g. USDC)
  amount: number;            // Amount in smallest token units (e.g. 100 = 0.0001 USDC)
  amountUSDC: number;        // Human-readable amount
  cluster: string;           // "devnet" | "mainnet-beta"
  message?: string;
}

/**
 * The X-Payment header payload (base64-encoded JSON).
 */
interface X402PaymentPayload {
  x402Version: number;       // 1
  scheme: string;            // "exact"
  network: string;           // "solana-mainnet" | "solana-devnet"
  payload: {
    serializedTransaction: string;  // base64-encoded fully signed Transaction
  };
}

export interface X402PaymentResult {
  success: boolean;
  response?: unknown;
  error?: string;
  status?: number;
}

export interface X402CheckResult {
  required: true;
  requirements: SolanaPaymentRequirements;
}

// ─── Helpers ───────────────────────────────────────────────────

function resolveCluster(cluster: string): string {
  // Normalize cluster names from the payment requirements
  const c = cluster.trim().toLowerCase();
  if (c === "mainnet" || c === "mainnet-beta" || c === "solana-mainnet") return "mainnet-beta";
  if (c === "devnet" || c === "solana-devnet") return "devnet";
  if (c === "testnet" || c === "solana-testnet") return "testnet";
  return "devnet"; // safe default for unknown
}

/**
 * Parse the payment requirements from a 402 response body.
 * Handles both { payment: {...} } and flat { recipientWallet, ... } formats.
 */
function parsePaymentRequirements(body: unknown): SolanaPaymentRequirements | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;

  // Standard format: { payment: { ... } }
  const paymentObj = (typeof b.payment === "object" && b.payment !== null)
    ? b.payment as Record<string, unknown>
    : b;

  const tokenAccount = typeof paymentObj.tokenAccount === "string" ? paymentObj.tokenAccount : null;
  const mint = typeof paymentObj.mint === "string" ? paymentObj.mint : null;
  const amount = typeof paymentObj.amount === "number" ? paymentObj.amount : null;
  const recipientWallet = typeof paymentObj.recipientWallet === "string"
    ? paymentObj.recipientWallet
    : typeof paymentObj.recipient === "string"
      ? paymentObj.recipient
      : null;
  const cluster = typeof paymentObj.cluster === "string"
    ? paymentObj.cluster
    : typeof paymentObj.network === "string"
      ? paymentObj.network
      : "devnet";

  if (!tokenAccount || !mint || amount === null || !recipientWallet) return null;

  return {
    recipientWallet,
    tokenAccount,
    mint,
    amount,
    amountUSDC: typeof paymentObj.amountUSDC === "number"
      ? paymentObj.amountUSDC
      : amount / 1_000_000,
    cluster,
    message: typeof paymentObj.message === "string" ? paymentObj.message : undefined,
  };
}

/**
 * Construct the X-Payment header value (base64-encoded JSON payload).
 */
function buildXPaymentHeader(
  serializedTransaction: string,
  cluster: string,
): string {
  const resolvedCluster = resolveCluster(cluster);
  const x402Network = X402_NETWORK[resolvedCluster] || "solana-devnet";

  const payload: X402PaymentPayload = {
    x402Version: 1,
    scheme: "exact",
    network: x402Network,
    payload: {
      serializedTransaction,
    },
  };

  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

// ─── Transaction Building ──────────────────────────────────────

/**
 * Build a payment transaction via Kora (no SOL required).
 *
 * Kora constructs the transfer transaction with itself as fee payer.
 * The user partially signs (authorizing the USDC transfer), then
 * Kora signs as fee payer. The fully signed tx is returned for
 * inclusion in the X-Payment header.
 */
async function buildPaymentTransactionViaKora(
  kora: KoraClient,
  keypair: Keypair,
  requirements: SolanaPaymentRequirements,
): Promise<string> {
  // Ask Kora to build the transfer transaction (Kora is fee payer)
  const { transaction: txBase64 } = await kora.transferTransaction({
    amount: Math.round(requirements.amount),
    token: requirements.mint,
    source: keypair.publicKey.toBase58(),
    destination: requirements.recipientWallet,
  });

  // Partially sign with user keypair (authorizes the USDC transfer)
  const txBytes = Buffer.from(txBase64, "base64");

  let partiallySignedBase64: string;
  try {
    // Try versioned transaction first
    const versionedTx = VersionedTransaction.deserialize(txBytes);
    versionedTx.sign([keypair]);
    partiallySignedBase64 = Buffer.from(versionedTx.serialize()).toString("base64");
  } catch {
    // Fall back to legacy Transaction
    const legacyTx = Transaction.from(txBytes);
    legacyTx.partialSign(keypair);
    partiallySignedBase64 = legacyTx
      .serialize({ requireAllSignatures: false })
      .toString("base64");
  }

  // Kora signs as fee payer (without broadcasting) — gives us the fully signed tx
  const { signed_transaction } = await kora.signTransaction(partiallySignedBase64);
  return signed_transaction;
}

/**
 * Build a fully signed SPL token transfer transaction for x402 payment.
 * Falls back to direct SOL-funded approach if Kora is not configured.
 * Returns base64-encoded serialized transaction.
 */
async function buildPaymentTransaction(
  keypair: Keypair,
  requirements: SolanaPaymentRequirements,
  rpcUrl: string,
  koraClient?: KoraClient | null,
): Promise<string> {
  // ── Kora path: zero SOL needed ──────────────────────────────
  if (koraClient) {
    return buildPaymentTransactionViaKora(koraClient, keypair, requirements);
  }

  // ── Fallback: direct transaction (requires SOL for fees) ────
  const connection = new Connection(rpcUrl, "confirmed");
  const mint = new PublicKey(requirements.mint);
  const recipientTokenAccount = new PublicKey(requirements.tokenAccount);

  // Get or create sender's Associated Token Account
  const senderTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    keypair,
    mint,
    keypair.publicKey,
  );

  // Build transaction
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

  const tx = new Transaction({
    feePayer: keypair.publicKey,
    blockhash,
    lastValidBlockHeight,
  });

  tx.add(
    createTransferInstruction(
      senderTokenAccount.address,   // source ATA
      recipientTokenAccount,         // destination ATA (provided by server)
      keypair.publicKey,             // owner
      BigInt(Math.round(requirements.amount)),   // amount in smallest units
    ),
  );

  // Fully sign the transaction
  tx.sign(keypair);

  // Serialize the fully signed transaction
  return tx.serialize().toString("base64");
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Fetch a URL with automatic x402 Solana payment handling.
 *
 * If the server returns 402, builds a signed SPL USDC transfer transaction
 * and retries with the X-Payment header. Returns the final response.
 *
 * When koraClient is provided, all fees are paid in USDC — no SOL needed.
 */
export async function x402Fetch(
  url: string,
  keypair: Keypair,
  method: string = "GET",
  body?: string,
  headers?: Record<string, string>,
  rpcUrl?: string,
  koraClient?: KoraClient | null,
): Promise<X402PaymentResult> {
  try {
    // ── Step 1: Initial request ────────────────────────────────
    const initialResp = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });

    if (initialResp.status !== 402) {
      const data = await initialResp.json().catch(() => initialResp.text());
      return { success: initialResp.ok, response: data, status: initialResp.status };
    }

    // ── Step 2: Parse payment requirements from 402 body ───────
    const bodyText = await initialResp.text();
    const bodyJson = (() => { try { return JSON.parse(bodyText); } catch { return null; } })();
    const requirements = parsePaymentRequirements(bodyJson);

    if (!requirements) {
      return {
        success: false,
        error: "Could not parse x402 payment requirements from 402 response",
        status: 402,
      };
    }

    // ── Step 3: Build payment transaction ──────────────────────
    const cluster = resolveCluster(requirements.cluster);
    const rpc = rpcUrl || RPC_URLS[cluster] || RPC_URLS.devnet;

    let serializedTransaction: string;
    try {
      serializedTransaction = await buildPaymentTransaction(
        keypair,
        requirements,
        rpc,
        koraClient,
      );
    } catch (err: any) {
      return {
        success: false,
        error: `Failed to build x402 payment transaction: ${err?.message || String(err)}`,
        status: 402,
      };
    }

    // ── Step 4: Retry with X-Payment header ───────────────────
    const xPaymentHeader = buildXPaymentHeader(serializedTransaction, cluster);

    const paidResp = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
        "X-Payment": xPaymentHeader,
      },
      body,
    });

    const data = await paidResp.json().catch(() => paidResp.text());
    return { success: paidResp.ok, response: data, status: paidResp.status };

  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * Check if a URL requires x402 payment without paying.
 * Returns the payment requirements if 402, otherwise null.
 */
export async function checkX402(
  url: string,
): Promise<SolanaPaymentRequirements | null> {
  try {
    const resp = await fetch(url, { method: "GET" });
    if (resp.status !== 402) return null;
    const body = await resp.json().catch(() => null);
    return parsePaymentRequirements(body);
  } catch {
    return null;
  }
}

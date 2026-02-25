/**
 * Solana USDC Operations
 *
 * Balance checking and SPL USDC transfers on Solana.
 *
 * When a KoraClient is provided, transfers are executed via Kora's
 * fee-abstraction service: the user pays all fees in USDC and never
 * needs native SOL in their wallet.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  transfer,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import type { KoraClient } from "./kora.js";

// USDC mint addresses on Solana
const USDC_MINT: Record<string, string> = {
  "mainnet-beta": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  testnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};

export type SolanaNetwork = "mainnet-beta" | "devnet" | "testnet";

const RPC_URLS: Record<SolanaNetwork, string> = {
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
};

export interface UsdcBalanceResult {
  balance: number;
  network: string;
  ok: boolean;
  error?: string;
}

/**
 * Get USDC balance for a Solana address.
 */
export async function getUsdcBalance(
  address: string,
  network: SolanaNetwork = "mainnet-beta",
  rpcUrl?: string,
): Promise<number> {
  const result = await getUsdcBalanceDetailed(address, network, rpcUrl);
  return result.balance;
}

/**
 * Get USDC balance with full diagnostics.
 */
export async function getUsdcBalanceDetailed(
  address: string,
  network: SolanaNetwork = "mainnet-beta",
  rpcUrl?: string,
): Promise<UsdcBalanceResult> {
  const usdcMint = USDC_MINT[network];
  if (!usdcMint) {
    return { balance: 0, network, ok: false, error: `Unsupported network: ${network}` };
  }

  const rpc = rpcUrl || RPC_URLS[network];
  const connection = new Connection(rpc, "confirmed");

  try {
    const owner = new PublicKey(address);
    const mint = new PublicKey(usdcMint);
    const ata = await getAssociatedTokenAddress(mint, owner);

    const info = await connection.getTokenAccountBalance(ata);
    const balance = Number(info.value.uiAmount) || 0;

    return { balance, network, ok: true };
  } catch (err: any) {
    // Account doesn't exist = zero balance
    if (err?.message?.includes("could not find account")) {
      return { balance: 0, network, ok: true };
    }
    return {
      balance: 0,
      network,
      ok: false,
      error: err?.message || String(err),
    };
  }
}

// ─── Kora-powered transfer ────────────────────────────────────────

/**
 * Transfer USDC via Kora fee abstraction.
 *
 * Kora builds the transaction with itself as fee payer. The user partially
 * signs to authorize the transfer, then Kora signs as fee payer and
 * broadcasts. The user pays zero native SOL.
 */
async function transferUsdcViaKora(
  kora: KoraClient,
  keypair: Keypair,
  recipientAddress: string,
  amountUSDC: number,
  network: SolanaNetwork,
): Promise<{ success: boolean; txSignature?: string; error?: string }> {
  const usdcMint = USDC_MINT[network];
  if (!usdcMint) {
    return { success: false, error: `Unsupported network: ${network}` };
  }

  const amountRaw = Math.floor(amountUSDC * 1_000_000); // Convert to 6-decimal units

  try {
    // Step 1: Ask Kora to build the transfer transaction (Kora is fee payer)
    const { transaction: txBase64 } = await kora.transferTransaction({
      amount: amountRaw,
      token: usdcMint,
      source: keypair.publicKey.toBase58(),
      destination: recipientAddress,
    });

    // Step 2: Deserialize, partially sign with user keypair to authorize
    const txBytes = Buffer.from(txBase64, "base64");

    let partiallySignedBase64: string;

    // Handle both legacy Transaction and VersionedTransaction
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

    // Step 3: Submit to Kora — it adds fee payer signature and broadcasts
    const result = await kora.signAndSendTransaction(partiallySignedBase64);

    return { success: true, txSignature: result.signature };
  } catch (err: any) {
    return {
      success: false,
      error: `Kora transfer failed: ${err?.message || String(err)}`,
    };
  }
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Transfer USDC to another address.
 *
 * When koraClient is provided: fees are paid in USDC via Kora (no SOL needed).
 * When koraClient is absent:  falls back to direct transfer (requires SOL for fees).
 *
 * Safety: refuses to send more than 50% of balance in a single call.
 */
export async function transferUsdc(
  keypair: Keypair,
  recipientAddress: string,
  amountUSDC: number,
  network: SolanaNetwork = "mainnet-beta",
  rpcUrl?: string,
  koraClient?: KoraClient | null,
): Promise<{ success: boolean; txSignature?: string; error?: string }> {
  // ── Safety check: refuse > 50% of balance ──────────────────────
  const balance = await getUsdcBalance(
    keypair.publicKey.toBase58(),
    network,
    rpcUrl,
  );
  if (amountUSDC > balance * 0.5) {
    return {
      success: false,
      error: `Safety limit: cannot send more than 50% of balance (${balance.toFixed(4)} USDC) in one transfer`,
    };
  }

  // ── Kora path: fees in USDC, no SOL required ───────────────────
  if (koraClient) {
    return transferUsdcViaKora(koraClient, keypair, recipientAddress, amountUSDC, network);
  }

  // ── Fallback: direct transfer (requires SOL for fees) ──────────
  const usdcMint = USDC_MINT[network];
  if (!usdcMint) {
    return { success: false, error: `Unsupported network: ${network}` };
  }

  const rpc = rpcUrl || RPC_URLS[network];
  const connection = new Connection(rpc, "confirmed");
  const mint = new PublicKey(usdcMint);
  const recipient = new PublicKey(recipientAddress);

  try {
    // Get sender ATA (create if needed)
    const senderATA = await getOrCreateAssociatedTokenAccount(
      connection,
      keypair,
      mint,
      keypair.publicKey,
    );

    // Get recipient ATA (create if needed — sender pays)
    const recipientATA = await getOrCreateAssociatedTokenAccount(
      connection,
      keypair,
      mint,
      recipient,
    );

    const txSig = await transfer(
      connection,
      keypair,
      senderATA.address,
      recipientATA.address,
      keypair.publicKey,
      BigInt(Math.floor(amountUSDC * 1_000_000)), // Convert to 6-decimal units
    );

    return { success: true, txSignature: txSig };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * Transfer native SOL to another address.
 */
export async function transferSol(
  keypair: Keypair,
  recipientAddress: string,
  amountSol: number,
  network: SolanaNetwork = "mainnet-beta",
  rpcUrl?: string,
): Promise<{ success: boolean; txSignature?: string; error?: string }> {
  const rpc = rpcUrl || RPC_URLS[network];
  const connection = new Connection(rpc, "confirmed");
  const recipient = new PublicKey(recipientAddress);

  try {
    const balance = await connection.getBalance(keypair.publicKey);
    const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

    // Safety: refuse to send more than 50% of balance
    if (lamports > balance * 0.5) {
      return {
        success: false,
        error: `Safety limit: cannot send more than 50% of SOL balance`,
      };
    }

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: recipient,
        lamports,
      }),
    );

    const txSig = await sendAndConfirmTransaction(connection, tx, [keypair]);
    return { success: true, txSignature: txSig };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * Get native SOL balance.
 */
export async function getSolBalance(
  address: string,
  network: SolanaNetwork = "mainnet-beta",
  rpcUrl?: string,
): Promise<number> {
  const rpc = rpcUrl || RPC_URLS[network];
  const connection = new Connection(rpc, "confirmed");
  try {
    const balance = await connection.getBalance(new PublicKey(address));
    return balance / LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}

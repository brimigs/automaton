/**
 * Solana On-Chain Agent Registration
 *
 * Registers the automaton on-chain using Metaplex Core NFTs on Solana.
 * Each agent gets a unique NFT asset as its verifiable on-chain identity.
 *
 * Uses Metaplex Core (mpl-core) — not Token Metadata.
 *
 * Kora integration:
 *   When a KoraClient is provided, a custom umi RPC adapter routes all
 *   sendTransaction calls through Kora's fee-abstraction service.
 *   This allows NFT creation, updates, and memos without any SOL.
 */

import { createHash } from "crypto";
import {
  Keypair,
  PublicKey,
  Connection,
  Transaction,
  VersionedTransaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  mplCore,
  createV1,
  updateV1,
  fetchAssetV1,
  fetchAllAssetV1,
} from "@metaplex-foundation/mpl-core";
import {
  createSignerFromKeypair,
  keypairIdentity,
  publicKey as umiPublicKey,
  type Umi,
  type UmiPlugin,
} from "@metaplex-foundation/umi";
import type { RegistryEntry, DiscoveredAgent, AutomatonDatabase } from "../types.js";
import type { KoraClient } from "../solana/kora.js";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// SPL Memo program
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

type SolanaNetwork = "mainnet-beta" | "devnet" | "testnet";

const RPC_URLS: Record<SolanaNetwork, string> = {
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
};

// ─── Umi Factory ───────────────────────────────────────────────

function createUmiInstance(keypair: Keypair, rpcUrl: string): Umi {
  const umi = createUmi(rpcUrl).use(mplCore());
  const umiKp = {
    publicKey: umiPublicKey(keypair.publicKey.toBase58()),
    secretKey: keypair.secretKey,
  };
  umi.use(keypairIdentity(umiKp));
  return umi;
}

/**
 * Create a Kora-aware umi plugin that overrides the RPC sendTransaction method
 * to route through Kora's fee-abstraction service.
 *
 * Transactions built by umi will have the user as identity/signer. When sent,
 * Kora adds its fee payer signature and broadcasts. Zero SOL required.
 */
function koraRpcPlugin(
  kora: KoraClient,
  keypair: Keypair,
): UmiPlugin {
  return {
    install(umi) {
      const originalRpc = umi.rpc;

      // Override sendTransaction to route through Kora
      umi.rpc = {
        ...originalRpc,
        sendTransaction: async (transaction, options) => {
          // Serialize the umi transaction to bytes
          const txBytes = umi.transactions.serialize(transaction);
          const txBase64 = Buffer.from(txBytes).toString("base64");

          // The transaction is already signed by user's keypair (via keypairIdentity).
          // Send to Kora: it adds its fee payer signature and broadcasts.
          const result = await kora.signAndSendTransaction(txBase64);

          // Return the signature as Uint8Array (umi expects this format)
          return bs58.decode(result.signature);
        },
      } as typeof originalRpc;
    },
  };
}

// ─── Helpers ───────────────────────────────────────────────────

function isIdempotencyError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes("already in use") ||
    msg.includes("account already exists") ||
    msg.includes("already initialized") ||
    msg.includes("custom program error: 0x0")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Register the automaton on-chain as a Metaplex Core NFT.
 * Returns the registry entry with the NFT asset address.
 *
 * When koraClient is provided, zero SOL is required.
 */
export async function registerAgent(
  keypair: Keypair,
  agentName: string,
  agentCardUri: string,
  network: SolanaNetwork = "mainnet-beta",
  rpcUrl: string | undefined,
  db: AutomatonDatabase,
  koraClient?: KoraClient | null,
): Promise<RegistryEntry> {
  const rpc = rpcUrl || RPC_URLS[network];
  const umi = createUmiInstance(keypair, rpc);

  // Inject Kora RPC adapter if configured
  if (koraClient) {
    umi.use(koraRpcPlugin(koraClient, keypair));
  }

  // Check if already registered (idempotency via DB)
  const existing = db.getRegistryEntry();
  if (existing && existing.network === network) {
    return existing;
  }

  // Derive a deterministic asset keypair from owner + name so retries always
  // resolve to the same NFT address (true idempotency).
  const seed = createHash("sha256")
    .update("automaton-registry-v1")
    .update(keypair.publicKey.toBase58())
    .update(agentName)
    .digest();
  const assetKeypair = Keypair.fromSeed(seed);
  const umiAssetKp = {
    publicKey: umiPublicKey(assetKeypair.publicKey.toBase58()),
    secretKey: assetKeypair.secretKey,
  };
  const assetSigner = createSignerFromKeypair(umi, umiAssetKp);

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { signature } = await createV1(umi, {
        asset: assetSigner,
        name: agentName,
        uri: agentCardUri,
      }).sendAndConfirm(umi);

      const txSignature = bs58.encode(signature);
      const assetAddress = assetSigner.publicKey.toString();

      const entry: RegistryEntry = {
        assetAddress,
        agentURI: agentCardUri,
        network,
        txSignature,
        registeredAt: new Date().toISOString(),
      };

      db.setRegistryEntry(entry);
      return entry;
    } catch (err: unknown) {
      lastError = err;

      // If it's an idempotency error (already registered), treat as success
      if (isIdempotencyError(err)) {
        const assetAddress = assetSigner.publicKey.toString();
        const entry: RegistryEntry = {
          assetAddress,
          agentURI: agentCardUri,
          network,
          txSignature: "already-registered",
          registeredAt: new Date().toISOString(),
        };
        db.setRegistryEntry(entry);
        return entry;
      }

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw new Error(
    `Failed to register agent after ${MAX_RETRIES} attempts: ${lastError}`,
  );
}

/**
 * Update the agent's URI on-chain (e.g. when agent card changes).
 *
 * When koraClient is provided, zero SOL is required.
 */
export async function updateAgentURI(
  keypair: Keypair,
  assetAddress: string,
  newAgentURI: string,
  network: SolanaNetwork = "mainnet-beta",
  rpcUrl: string | undefined,
  db: AutomatonDatabase,
  koraClient?: KoraClient | null,
): Promise<string> {
  const rpc = rpcUrl || RPC_URLS[network];
  const umi = createUmiInstance(keypair, rpc);

  // Inject Kora RPC adapter if configured
  if (koraClient) {
    umi.use(koraRpcPlugin(koraClient, keypair));
  }

  const { signature } = await updateV1(umi, {
    asset: umiPublicKey(assetAddress),
    newUri: newAgentURI,
  }).sendAndConfirm(umi);

  const txSig = bs58.encode(signature);

  const entry = db.getRegistryEntry();
  if (entry) {
    entry.agentURI = newAgentURI;
    entry.txSignature = txSig;
    db.setRegistryEntry(entry);
  }

  return txSig;
}

/**
 * Record reputation feedback on-chain via Solana Memo program.
 *
 * When koraClient is provided, zero SOL is required — fees paid in USDC.
 */
export async function leaveFeedback(
  keypair: Keypair,
  targetAgentAsset: string,
  score: number,
  comment: string,
  network: SolanaNetwork = "mainnet-beta",
  rpcUrl: string | undefined,
  _db: AutomatonDatabase,
  koraClient?: KoraClient | null,
): Promise<string> {
  const rpc = rpcUrl || RPC_URLS[network];

  const feedbackPayload = JSON.stringify({
    type: "agent-feedback",
    targetAgent: targetAgentAsset,
    score,
    comment,
    timestamp: new Date().toISOString(),
  });

  // Write feedback as a Memo transaction on-chain
  const memoIx = new TransactionInstruction({
    keys: [{ pubkey: keypair.publicKey, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(feedbackPayload, "utf-8"),
  });

  // ── Kora path: fees in USDC ──────────────────────────────
  if (koraClient) {
    const { blockhash, lastValidBlockHeight } = await new Connection(rpc, "confirmed")
      .getLatestBlockhash();

    const tx = new Transaction({
      feePayer: keypair.publicKey,  // Placeholder; Kora will override as fee payer
      blockhash,
      lastValidBlockHeight,
    }).add(memoIx);

    // Partially sign (user authorizes the memo)
    tx.partialSign(keypair);
    const partiallySignedBase64 = tx
      .serialize({ requireAllSignatures: false })
      .toString("base64");

    // Kora adds fee payer signature and broadcasts
    const result = await koraClient.signAndSendTransaction(partiallySignedBase64);
    return result.signature;
  }

  // ── Fallback: direct transaction (requires SOL) ──────────
  const connection = new Connection(rpc, "confirmed");
  const tx = new Transaction().add(memoIx);
  const txSig = await sendAndConfirmTransaction(connection, tx, [keypair]);
  return txSig;
}

/**
 * Fetch an agent by its NFT asset address.
 */
export async function queryAgent(
  assetAddress: string,
  network: SolanaNetwork = "mainnet-beta",
  rpcUrl?: string,
): Promise<DiscoveredAgent | null> {
  const rpc = rpcUrl || RPC_URLS[network];
  const umi = createUmi(rpc).use(mplCore());

  try {
    const asset = await fetchAssetV1(umi, umiPublicKey(assetAddress));
    return {
      assetAddress,
      owner: asset.owner.toString(),
      agentURI: asset.uri,
      name: asset.name,
    };
  } catch {
    return null;
  }
}

/**
 * Discover agents owned by a wallet.
 * NOTE: fetchAllAssetV1 with an owner filter requires a DAS-compatible RPC
 * (e.g. Helius, QuickNode with DAS). The default public RPC endpoints do not
 * support this method and will cause this function to return []. Configure
 * solanaRpcUrl in config to use a DAS-enabled endpoint on mainnet.
 */
export async function getAgentsByOwner(
  ownerAddress: string,
  network: SolanaNetwork = "mainnet-beta",
  rpcUrl?: string,
): Promise<DiscoveredAgent[]> {
  const rpc = rpcUrl || RPC_URLS[network];
  const umi = createUmi(rpc).use(mplCore());

  try {
    const assets = await fetchAllAssetV1(umi, {
      owner: umiPublicKey(ownerAddress),
    } as any);
    return assets.map((asset) => ({
      assetAddress: asset.publicKey.toString(),
      owner: asset.owner.toString(),
      agentURI: asset.uri,
      name: asset.name,
    }));
  } catch {
    return [];
  }
}

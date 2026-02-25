/**
 * USDC + Kora Integration Tests
 *
 * Tests for transferUsdc with the Kora fee-abstraction client.
 * Mocks Solana web3.js and spl-token to avoid real network calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { KoraClient } from "../solana/kora.js";

// ─── Module mocks ─────────────────────────────────────────────────

// Mock @solana/web3.js - provide only what usdc.ts needs
vi.mock("@solana/web3.js", () => {
  const mockGetTokenAccountBalance = vi.fn().mockResolvedValue({
    value: { uiAmount: 10.0 },
  });
  const mockGetBalance = vi.fn().mockResolvedValue(1_000_000_000);

  const MockConnection = vi.fn().mockImplementation(() => ({
    getTokenAccountBalance: mockGetTokenAccountBalance,
    getBalance: mockGetBalance,
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: "testblockhash",
      lastValidBlockHeight: 100,
    }),
  }));

  class MockPublicKey {
    private _key: string;
    constructor(key: string | Uint8Array) {
      this._key = typeof key === "string" ? key : Buffer.from(key).toString("hex");
    }
    toBase58() { return this._key; }
    toString() { return this._key; }
  }

  class MockTransaction {
    instructions: unknown[] = [];
    partialSign(..._signers: unknown[]) {}
    sign(..._signers: unknown[]) {}
    serialize(_opts?: unknown) { return Buffer.from("serializedTx"); }
    add(ix: unknown) { this.instructions.push(ix); return this; }

    static from(_bytes: Buffer | Uint8Array) {
      return new MockTransaction();
    }
  }

  return {
    Connection: MockConnection,
    PublicKey: MockPublicKey,
    Transaction: MockTransaction,
    SystemProgram: {
      transfer: vi.fn().mockReturnValue({ programId: "system", keys: [], data: Buffer.alloc(0) }),
    },
    VersionedTransaction: {
      deserialize: vi.fn().mockImplementation(() => {
        throw new Error("not a versioned tx");
      }),
    },
    sendAndConfirmTransaction: vi.fn().mockResolvedValue("directTxSig"),
    LAMPORTS_PER_SOL: 1_000_000_000,
  };
});

// Mock @solana/spl-token
vi.mock("@solana/spl-token", () => {
  class MockPublicKey {
    private _key: string;
    constructor(key: string) { this._key = key; }
    toBase58() { return this._key; }
    toString() { return this._key; }
  }

  return {
    getAssociatedTokenAddress: vi.fn().mockResolvedValue(new MockPublicKey("mockATA")),
    getOrCreateAssociatedTokenAccount: vi.fn().mockResolvedValue({
      address: new MockPublicKey("mockATA"),
      amount: BigInt(10_000_000), // 10 USDC
    }),
    transfer: vi.fn().mockResolvedValue("directTransferSig"),
    createTransferInstruction: vi.fn().mockReturnValue({
      programId: "tokenProgram",
      keys: [],
      data: Buffer.alloc(0),
    }),
  };
});

// ─── Test helpers ─────────────────────────────────────────────────

function makeMockKoraClient(overrides?: Partial<KoraClient>): KoraClient {
  return {
    transferTransaction: vi.fn().mockResolvedValue({
      transaction: Buffer.from("koraTx").toString("base64"),
      blockhash: "bh",
      signer_pubkey: "userPubkey",
      message: "",
      instructions: [],
    }),
    signAndSendTransaction: vi.fn().mockResolvedValue({
      signature: "koraTxSig123",
      signed_transaction: "signedTxBase64",
      signer_pubkey: "koraFeePayer",
    }),
    signTransaction: vi.fn().mockResolvedValue({
      signature: "koraSignOnly",
      signed_transaction: "signedOnly",
    }),
    getPayerSigner: vi.fn(),
    getSupportedTokens: vi.fn(),
    estimateTransactionFee: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as KoraClient;
}

function makeMockKeypair() {
  return {
    publicKey: {
      toBase58: () => "userWalletAddress",
      toString: () => "userWalletAddress",
    },
    secretKey: new Uint8Array(64).fill(1),
  } as any;
}

// ─── Tests ───────────────────────────────────────────────────────

describe("transferUsdc", () => {
  // Import inside tests to use the mocked modules
  let transferUsdc: typeof import("../solana/usdc.js").transferUsdc;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../solana/usdc.js");
    transferUsdc = mod.transferUsdc;
  });

  // ── Kora path ────────────────────────────────────────────────

  describe("with Kora client", () => {
    it("uses Kora transferTransaction for the transfer", async () => {
      const koraClient = makeMockKoraClient();
      const keypair = makeMockKeypair();

      const result = await transferUsdc(
        keypair,
        "recipientWallet",
        1.0, // 1 USDC — within safety limit (balance = 10 USDC, 50% = 5)
        "mainnet-beta",
        undefined,
        koraClient,
      );

      expect(result.success).toBe(true);
      expect(result.txSignature).toBe("koraTxSig123");
      expect(koraClient.transferTransaction).toHaveBeenCalledOnce();
      expect(koraClient.signAndSendTransaction).toHaveBeenCalledOnce();
    });

    it("passes correct amount in raw units to Kora", async () => {
      const koraClient = makeMockKoraClient();
      const keypair = makeMockKeypair();

      await transferUsdc(keypair, "dest", 2.5, "mainnet-beta", undefined, koraClient);

      expect(koraClient.transferTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 2_500_000, // 2.5 * 1e6
          token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // mainnet USDC
          source: "userWalletAddress",
          destination: "dest",
        }),
      );
    });

    it("uses devnet USDC mint on devnet", async () => {
      const koraClient = makeMockKoraClient();
      const keypair = makeMockKeypair();

      await transferUsdc(keypair, "dest", 1.0, "devnet", undefined, koraClient);

      expect(koraClient.transferTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          token: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // devnet USDC
        }),
      );
    });

    it("enforces 50% safety limit even with Kora", async () => {
      const koraClient = makeMockKoraClient();
      const keypair = makeMockKeypair();

      // Balance mock returns 10 USDC; 50% = 5 USDC; trying to send 6 should fail
      const result = await transferUsdc(
        keypair,
        "dest",
        6.0,
        "mainnet-beta",
        undefined,
        koraClient,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Safety limit");
      // Kora should NOT have been called
      expect(koraClient.transferTransaction).not.toHaveBeenCalled();
    });

    it("returns error when Kora transferTransaction fails", async () => {
      const koraClient = makeMockKoraClient({
        transferTransaction: vi.fn().mockRejectedValue(new Error("Kora server down")),
      });
      const keypair = makeMockKeypair();

      const result = await transferUsdc(keypair, "dest", 1.0, "mainnet-beta", undefined, koraClient);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Kora transfer failed");
      expect(result.error).toContain("Kora server down");
    });

    it("returns error when signAndSendTransaction fails", async () => {
      const koraClient = makeMockKoraClient({
        signAndSendTransaction: vi.fn().mockRejectedValue(new Error("broadcast failed")),
      });
      const keypair = makeMockKeypair();

      const result = await transferUsdc(keypair, "dest", 1.0, "mainnet-beta", undefined, koraClient);

      expect(result.success).toBe(false);
      // Error is wrapped in "Kora transfer failed: ..."
      expect(result.error).toContain("Kora transfer failed");
    });
  });

  // ── Fallback (no Kora) ────────────────────────────────────────

  describe("without Kora client (fallback)", () => {
    it("uses direct transfer when koraClient is null", async () => {
      const { transfer } = await import("@solana/spl-token");
      const keypair = makeMockKeypair();

      const result = await transferUsdc(
        keypair,
        "recipientWallet",
        1.0,
        "mainnet-beta",
        undefined,
        null, // No Kora
      );

      expect(result.success).toBe(true);
      expect(result.txSignature).toBe("directTransferSig");
      expect(transfer).toHaveBeenCalled();
    });

    it("uses direct transfer when koraClient is undefined", async () => {
      const { transfer } = await import("@solana/spl-token");
      const keypair = makeMockKeypair();

      const result = await transferUsdc(
        keypair,
        "recipientWallet",
        1.0,
        "mainnet-beta",
      );

      expect(result.success).toBe(true);
      expect(transfer).toHaveBeenCalled();
    });

    it("enforces safety limit in direct path too", async () => {
      const keypair = makeMockKeypair();

      // balance = 10 USDC from mock, try to send 6 (> 50%)
      const result = await transferUsdc(keypair, "dest", 6.0, "mainnet-beta");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Safety limit");
    });
  });
});

// ─── getUsdcBalance tests ─────────────────────────────────────────

describe("getUsdcBalance", () => {
  it("returns balance from token account", async () => {
    const { getUsdcBalance } = await import("../solana/usdc.js");
    const balance = await getUsdcBalance("someAddress", "mainnet-beta");
    expect(balance).toBe(10.0);
  });

  it("returns 0 for missing account", async () => {
    const { Connection } = await import("@solana/web3.js");
    // Mock getTokenAccountBalance to throw "could not find account"
    const mockConn = (Connection as any).mock.results[0]?.value;
    if (mockConn) {
      mockConn.getTokenAccountBalance.mockRejectedValueOnce(
        new Error("could not find account"),
      );
    }

    const { getUsdcBalance } = await import("../solana/usdc.js");
    const balance = await getUsdcBalance("nonexistentAddress", "mainnet-beta");
    expect(balance).toBe(0);
  });
});

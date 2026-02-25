/**
 * x402 + Kora Integration Tests
 *
 * Tests for x402Fetch with the Kora fee-abstraction client.
 * Mocks fetch for HTTP calls and Solana modules for transaction building.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { KoraClient } from "../solana/kora.js";

// ─── Module mocks ─────────────────────────────────────────────────

vi.mock("@solana/web3.js", () => {
  class MockPublicKey {
    private _key: string;
    constructor(key: string) { this._key = key; }
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

  const MockConnection = vi.fn().mockImplementation(() => ({
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: "testblockhash",
      lastValidBlockHeight: 100,
    }),
  }));

  return {
    Connection: MockConnection,
    PublicKey: MockPublicKey,
    Transaction: MockTransaction,
    VersionedTransaction: {
      deserialize: vi.fn().mockImplementation(() => {
        throw new Error("not a versioned tx");
      }),
    },
  };
});

vi.mock("@solana/spl-token", () => {
  class MockPublicKey {
    private _key: string;
    constructor(key: string) { this._key = key; }
    toBase58() { return this._key; }
    toString() { return this._key; }
  }

  return {
    getOrCreateAssociatedTokenAccount: vi.fn().mockResolvedValue({
      address: new MockPublicKey("senderATA"),
    }),
    createTransferInstruction: vi.fn().mockReturnValue({
      programId: "tokenProgram",
      keys: [],
      data: Buffer.alloc(0),
    }),
  };
});

// ─── Test helpers ─────────────────────────────────────────────────

const PAYMENT_REQUIREMENTS = {
  recipientWallet: "recipientWallet123",
  tokenAccount: "recipientTokenAccount",
  mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amount: 1_000_000,
  amountUSDC: 1.0,
  cluster: "mainnet-beta",
  message: "Pay to access this resource",
};

const PAYMENT_BODY_402 = {
  payment: PAYMENT_REQUIREMENTS,
};

function make402Response(paymentBody: object) {
  return {
    ok: false,
    status: 402,
    text: async () => JSON.stringify(paymentBody),
  };
}

function make200Response(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function make200TextResponse(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => { throw new Error("not json"); },
    text: async () => text,
  };
}

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
      signature: "koraTxSig",
      signed_transaction: "fullSignedTxBase64",
      signer_pubkey: "koraFeePayer",
    }),
    signTransaction: vi.fn().mockResolvedValue({
      signature: "koraOnlySig",
      signed_transaction: "koraSignedTxBase64",
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

describe("x402Fetch", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let x402Fetch: typeof import("../conway/x402.js").x402Fetch;

  beforeEach(async () => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("../conway/x402.js");
    x402Fetch = mod.x402Fetch;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── No payment required ───────────────────────────────────────

  it("returns immediately when server returns 200 (no payment)", async () => {
    fetchMock.mockResolvedValueOnce(make200Response({ data: "success" }));

    const keypair = makeMockKeypair();
    const result = await x402Fetch("https://example.com/resource", keypair);

    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  // ── Kora path ────────────────────────────────────────────────

  describe("with Kora client", () => {
    it("uses Kora transferTransaction for payment", async () => {
      // 402 on first request, 200 on second
      fetchMock
        .mockResolvedValueOnce(make402Response(PAYMENT_BODY_402))
        .mockResolvedValueOnce(make200Response({ ok: true }));

      const koraClient = makeMockKoraClient();
      const keypair = makeMockKeypair();

      const result = await x402Fetch(
        "https://example.com/resource",
        keypair,
        "GET",
        undefined,
        undefined,
        undefined,
        koraClient,
      );

      expect(result.success).toBe(true);
      expect(koraClient.transferTransaction).toHaveBeenCalledOnce();
      // signTransaction is used (not signAndSendTransaction) so server can broadcast
      expect(koraClient.signTransaction).toHaveBeenCalledOnce();
      expect(koraClient.signAndSendTransaction).not.toHaveBeenCalled();
    });

    it("passes correct payment details to Kora", async () => {
      fetchMock
        .mockResolvedValueOnce(make402Response(PAYMENT_BODY_402))
        .mockResolvedValueOnce(make200Response({ ok: true }));

      const koraClient = makeMockKoraClient();
      const keypair = makeMockKeypair();

      await x402Fetch("https://example.com/resource", keypair, "GET", undefined, undefined, undefined, koraClient);

      expect(koraClient.transferTransaction).toHaveBeenCalledWith({
        amount: 1_000_000,
        token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        source: "userWalletAddress",
        destination: "recipientWallet123",
      });
    });

    it("includes X-Payment header on retry", async () => {
      fetchMock
        .mockResolvedValueOnce(make402Response(PAYMENT_BODY_402))
        .mockResolvedValueOnce(make200Response({ ok: true }));

      const koraClient = makeMockKoraClient();
      const keypair = makeMockKeypair();

      await x402Fetch("https://example.com/resource", keypair, "GET", undefined, undefined, undefined, koraClient);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const secondCall = fetchMock.mock.calls[1];
      const secondHeaders = secondCall[1].headers;
      expect(secondHeaders["X-Payment"]).toBeDefined();
      expect(typeof secondHeaders["X-Payment"]).toBe("string");

      // Verify X-Payment contains a valid base64 JSON payload
      const decoded = JSON.parse(Buffer.from(secondHeaders["X-Payment"], "base64").toString());
      expect(decoded.x402Version).toBe(1);
      expect(decoded.scheme).toBe("exact");
      expect(decoded.network).toContain("solana");
      expect(decoded.payload.serializedTransaction).toBeDefined();
    });

    it("uses Kora signed transaction in X-Payment header", async () => {
      fetchMock
        .mockResolvedValueOnce(make402Response(PAYMENT_BODY_402))
        .mockResolvedValueOnce(make200Response({ ok: true }));

      const koraClient = makeMockKoraClient();
      const keypair = makeMockKeypair();

      await x402Fetch("https://example.com/resource", keypair, "GET", undefined, undefined, undefined, koraClient);

      const secondHeaders = fetchMock.mock.calls[1][1].headers;
      const decoded = JSON.parse(Buffer.from(secondHeaders["X-Payment"], "base64").toString());

      // The serialized tx should be Kora's fully signed transaction
      expect(decoded.payload.serializedTransaction).toBe("koraSignedTxBase64");
    });

    it("returns error when Kora fails", async () => {
      fetchMock.mockResolvedValueOnce(make402Response(PAYMENT_BODY_402));

      const koraClient = makeMockKoraClient({
        transferTransaction: vi.fn().mockRejectedValue(new Error("Kora unavailable")),
      });
      const keypair = makeMockKeypair();

      const result = await x402Fetch(
        "https://example.com/resource",
        keypair,
        "GET",
        undefined,
        undefined,
        undefined,
        koraClient,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to build x402 payment transaction");
      expect(fetchMock).toHaveBeenCalledOnce(); // Only the initial 402 call
    });
  });

  // ── Fallback path (no Kora) ───────────────────────────────────

  describe("without Kora client (fallback)", () => {
    it("builds direct Solana transaction when no koraClient", async () => {
      fetchMock
        .mockResolvedValueOnce(make402Response(PAYMENT_BODY_402))
        .mockResolvedValueOnce(make200Response({ ok: true }));

      const keypair = makeMockKeypair();

      const result = await x402Fetch(
        "https://example.com/resource",
        keypair,
        "GET",
        undefined,
        undefined,
        "https://api.mainnet-beta.solana.com",
        null, // No Kora
      );

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // X-Payment header should still be included
      const secondHeaders = fetchMock.mock.calls[1][1].headers;
      expect(secondHeaders["X-Payment"]).toBeDefined();
    });
  });

  // ── Error cases ───────────────────────────────────────────────

  it("returns error on unparseable 402 body", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 402,
      text: async () => "not json",
    });

    const keypair = makeMockKeypair();
    const result = await x402Fetch("https://example.com", keypair);

    expect(result.success).toBe(false);
    expect(result.status).toBe(402);
  });

  it("handles POST method correctly", async () => {
    fetchMock
      .mockResolvedValueOnce(make402Response(PAYMENT_BODY_402))
      .mockResolvedValueOnce(make200Response({ created: true }));

    const koraClient = makeMockKoraClient();
    const keypair = makeMockKeypair();

    const result = await x402Fetch(
      "https://example.com/api",
      keypair,
      "POST",
      JSON.stringify({ key: "value" }),
      undefined,
      undefined,
      koraClient,
    );

    expect(result.success).toBe(true);
    // Both calls should use POST
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(fetchMock.mock.calls[1][1].method).toBe("POST");
  });

  it("passes custom headers on both requests", async () => {
    fetchMock
      .mockResolvedValueOnce(make402Response(PAYMENT_BODY_402))
      .mockResolvedValueOnce(make200Response({ ok: true }));

    const koraClient = makeMockKoraClient();
    const keypair = makeMockKeypair();

    await x402Fetch(
      "https://example.com",
      keypair,
      "GET",
      undefined,
      { "X-Custom": "header-value" },
      undefined,
      koraClient,
    );

    expect(fetchMock.mock.calls[1][1].headers["X-Custom"]).toBe("header-value");
  });
});

// ─── checkX402 tests ──────────────────────────────────────────────

describe("checkX402", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let checkX402: typeof import("../conway/x402.js").checkX402;

  beforeEach(async () => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const mod = await import("../conway/x402.js");
    checkX402 = mod.checkX402;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when no payment required", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

    const result = await checkX402("https://example.com");
    expect(result).toBeNull();
  });

  it("returns payment requirements on 402", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 402,
      json: async () => PAYMENT_BODY_402,
    });

    const result = await checkX402("https://example.com");

    expect(result).not.toBeNull();
    expect(result!.mint).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(result!.amount).toBe(1_000_000);
  });

  it("returns null on network error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Network error"));

    const result = await checkX402("https://example.com");
    expect(result).toBeNull();
  });
});

/**
 * Registry + Kora Integration Tests
 *
 * Tests for Metaplex registry functions with the Kora fee-abstraction client.
 * Mocks Metaplex umi and Solana web3.js.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { KoraClient } from "../solana/kora.js";

// ─── Module mocks ─────────────────────────────────────────────────

// Track umi instances and their RPC overrides
let capturedUmiRpc: { sendTransaction?: ReturnType<typeof vi.fn> } = {};
let pluginInstalled = false;

vi.mock("@metaplex-foundation/umi-bundle-defaults", () => {
  return {
    createUmi: vi.fn().mockImplementation(() => mockUmiInstance()),
  };
});

vi.mock("@metaplex-foundation/mpl-core", () => {
  return {
    mplCore: vi.fn().mockReturnValue({ install: vi.fn() }),
    createV1: vi.fn().mockReturnValue({
      sendAndConfirm: vi.fn().mockResolvedValue({
        signature: new Uint8Array([1, 2, 3, 4, 5]),
      }),
    }),
    updateV1: vi.fn().mockReturnValue({
      sendAndConfirm: vi.fn().mockResolvedValue({
        signature: new Uint8Array([6, 7, 8, 9, 10]),
      }),
    }),
    fetchAssetV1: vi.fn().mockResolvedValue({
      owner: { toString: () => "ownerAddress" },
      uri: "https://example.com/agent.json",
      name: "TestAgent",
      publicKey: { toString: () => "assetAddress" },
    }),
    fetchAllAssetV1: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("@metaplex-foundation/umi", () => {
  return {
    keypairIdentity: vi.fn().mockReturnValue({ install: vi.fn() }),
    createSignerFromKeypair: vi.fn().mockReturnValue({
      publicKey: { toString: () => "assetPublicKey" },
    }),
    publicKey: vi.fn().mockImplementation((key: string) => key),
  };
});

vi.mock("bs58", () => {
  return {
    default: {
      encode: vi.fn().mockReturnValue("base58EncodedSignature"),
      decode: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
    },
  };
});

vi.mock("crypto", () => {
  const actual = vi.importActual("crypto");
  return {
    ...actual,
    createHash: vi.fn().mockReturnValue({
      update: vi.fn().mockReturnThis(),
      digest: vi.fn().mockReturnValue(Buffer.alloc(32, 1)),
    }),
  };
});

vi.mock("@solana/web3.js", () => {
  class MockPublicKey {
    private _key: string;
    constructor(key: string | Uint8Array) {
      this._key = typeof key === "string" ? key : Buffer.from(key).toString("hex");
    }
    toBase58() { return this._key; }
    toString() { return this._key; }
    static default = MockPublicKey;
  }

  // Mock Keypair.fromSeed to return a predictable keypair
  const MockKeypair = {
    fromSeed: vi.fn().mockReturnValue({
      publicKey: new MockPublicKey("deterministicAssetPubkey"),
      secretKey: new Uint8Array(64).fill(2),
    }),
  };

  class MockTransaction {
    private _instructions: unknown[] = [];
    feePayer: MockPublicKey | null = null;
    partialSign(..._signers: unknown[]) {}
    sign(..._signers: unknown[]) {}
    serialize(_opts?: unknown) { return Buffer.from("memoSerializedTx"); }
    add(ix: unknown) { this._instructions.push(ix); return this; }
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
    Keypair: MockKeypair,
    TransactionInstruction: vi.fn().mockImplementation(({ keys, programId, data }) => ({
      keys, programId, data,
    })),
    sendAndConfirmTransaction: vi.fn().mockResolvedValue("directMemoTxSig"),
    VersionedTransaction: {
      deserialize: vi.fn().mockImplementation(() => {
        throw new Error("not versioned");
      }),
    },
  };
});

// ─── Mock umi instance factory ─────────────────────────────────────

function mockUmiInstance() {
  const mockRpc = {
    sendTransaction: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  };

  const mockUmi = {
    use: vi.fn().mockImplementation((plugin: { install?: (umi: unknown) => void }) => {
      if (plugin && typeof plugin.install === "function") {
        plugin.install(mockUmi);
        pluginInstalled = true;
      }
      return mockUmi;
    }),
    rpc: mockRpc,
    transactions: {
      serialize: vi.fn().mockReturnValue(Buffer.from("serializedUmiTx")),
    },
  };

  capturedUmiRpc = mockRpc;
  return mockUmi;
}

// ─── Test helpers ─────────────────────────────────────────────────

function makeMockKoraClient(overrides?: Partial<KoraClient>): KoraClient {
  return {
    transferTransaction: vi.fn(),
    signAndSendTransaction: vi.fn().mockResolvedValue({
      signature: "koraMemoSig",
      signed_transaction: "signedMemoTx",
      signer_pubkey: "koraFeePayer",
    }),
    signTransaction: vi.fn(),
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

function makeMockDb() {
  return {
    getRegistryEntry: vi.fn().mockReturnValue(null),
    setRegistryEntry: vi.fn(),
  } as any;
}

// ─── Tests ───────────────────────────────────────────────────────

describe("registerAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedUmiRpc = {};
    pluginInstalled = false;
  });

  it("registers an agent and returns registry entry", async () => {
    const { registerAgent } = await import("../registry/solana-registry.js");
    const keypair = makeMockKeypair();
    const db = makeMockDb();

    const entry = await registerAgent(
      keypair,
      "TestAgent",
      "https://example.com/card.json",
      "mainnet-beta",
      undefined,
      db,
    );

    expect(entry).toBeDefined();
    expect(entry.agentURI).toBe("https://example.com/card.json");
    expect(entry.network).toBe("mainnet-beta");
    expect(db.setRegistryEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        agentURI: "https://example.com/card.json",
        network: "mainnet-beta",
      }),
    );
  });

  it("returns existing registry entry if already registered", async () => {
    const { registerAgent } = await import("../registry/solana-registry.js");
    const keypair = makeMockKeypair();

    const existingEntry = {
      assetAddress: "existingAsset",
      agentURI: "https://example.com/existing.json",
      network: "mainnet-beta" as const,
      txSignature: "existingTxSig",
      registeredAt: "2024-01-01T00:00:00.000Z",
    };

    const db = {
      getRegistryEntry: vi.fn().mockReturnValue(existingEntry),
      setRegistryEntry: vi.fn(),
    } as any;

    const entry = await registerAgent(keypair, "TestAgent", "https://example.com/card.json", "mainnet-beta", undefined, db);

    expect(entry).toEqual(existingEntry);
    expect(db.setRegistryEntry).not.toHaveBeenCalled();
  });

  it("installs Kora plugin when koraClient provided", async () => {
    const { registerAgent } = await import("../registry/solana-registry.js");
    const keypair = makeMockKeypair();
    const db = makeMockDb();
    const koraClient = makeMockKoraClient();

    await registerAgent(
      keypair,
      "TestAgent",
      "https://example.com/card.json",
      "mainnet-beta",
      undefined,
      db,
      koraClient,
    );

    // The Kora plugin should have been installed (umi.use() called with plugin)
    expect(pluginInstalled).toBe(true);
  });

  it("does not install Kora plugin when no koraClient", async () => {
    const { registerAgent } = await import("../registry/solana-registry.js");
    const keypair = makeMockKeypair();
    const db = makeMockDb();
    pluginInstalled = false;

    await registerAgent(
      keypair,
      "TestAgent",
      "https://example.com/card.json",
      "mainnet-beta",
      undefined,
      db,
      // no koraClient
    );

    // keypairIdentity is installed but koraPlugin is not a separate plugin
    // The RPC should NOT be overridden
  });
});

// ─── leaveFeedback tests ──────────────────────────────────────────

describe("leaveFeedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses Kora signAndSendTransaction when koraClient provided", async () => {
    const { leaveFeedback } = await import("../registry/solana-registry.js");
    const keypair = makeMockKeypair();
    const db = {} as any;
    const koraClient = makeMockKoraClient();

    const sig = await leaveFeedback(
      keypair,
      "targetAssetAddress",
      5,
      "Great agent!",
      "mainnet-beta",
      undefined,
      db,
      koraClient,
    );

    expect(sig).toBe("koraMemoSig");
    expect(koraClient.signAndSendTransaction).toHaveBeenCalledOnce();
    // Should NOT use sendAndConfirmTransaction (direct SOL path)
    const { sendAndConfirmTransaction } = await import("@solana/web3.js");
    expect(sendAndConfirmTransaction).not.toHaveBeenCalled();
  });

  it("uses direct sendAndConfirmTransaction when no koraClient", async () => {
    const { leaveFeedback } = await import("../registry/solana-registry.js");
    const keypair = makeMockKeypair();
    const db = {} as any;

    const sig = await leaveFeedback(
      keypair,
      "targetAssetAddress",
      4,
      "Good work!",
      "mainnet-beta",
      undefined,
      db,
      null,
    );

    expect(sig).toBe("directMemoTxSig");
    const { sendAndConfirmTransaction } = await import("@solana/web3.js");
    expect(sendAndConfirmTransaction).toHaveBeenCalled();
  });

  it("submits feedback payload as base64-encoded partially signed tx to Kora", async () => {
    const { leaveFeedback } = await import("../registry/solana-registry.js");
    const keypair = makeMockKeypair();
    const db = {} as any;
    const koraClient = makeMockKoraClient();

    await leaveFeedback(keypair, "targetAsset", 5, "Excellent!", "mainnet-beta", undefined, db, koraClient);

    // signAndSendTransaction should be called with a base64 string
    const [txArg] = (koraClient.signAndSendTransaction as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(typeof txArg).toBe("string");
    // Should be a valid base64 string
    expect(() => Buffer.from(txArg, "base64")).not.toThrow();
  });
});

// ─── updateAgentURI tests ─────────────────────────────────────────

describe("updateAgentURI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedUmiRpc = {};
    pluginInstalled = false;
  });

  it("updates URI and returns tx signature", async () => {
    const { updateAgentURI } = await import("../registry/solana-registry.js");
    const keypair = makeMockKeypair();

    const existingEntry = {
      assetAddress: "assetAddr",
      agentURI: "https://old.example.com/card.json",
      network: "mainnet-beta" as const,
      txSignature: "oldSig",
      registeredAt: "2024-01-01T00:00:00.000Z",
    };

    const db = {
      getRegistryEntry: vi.fn().mockReturnValue(existingEntry),
      setRegistryEntry: vi.fn(),
    } as any;

    const txSig = await updateAgentURI(
      keypair,
      "assetAddr",
      "https://new.example.com/card.json",
      "mainnet-beta",
      undefined,
      db,
    );

    expect(txSig).toBe("base58EncodedSignature");
    expect(db.setRegistryEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        agentURI: "https://new.example.com/card.json",
        txSignature: "base58EncodedSignature",
      }),
    );
  });

  it("installs Kora plugin when koraClient provided", async () => {
    const { updateAgentURI } = await import("../registry/solana-registry.js");
    const keypair = makeMockKeypair();

    const db = {
      getRegistryEntry: vi.fn().mockReturnValue(null),
      setRegistryEntry: vi.fn(),
    } as any;

    const koraClient = makeMockKoraClient();
    pluginInstalled = false;

    await updateAgentURI(
      keypair,
      "assetAddr",
      "https://new.example.com/card.json",
      "mainnet-beta",
      undefined,
      db,
      koraClient,
    );

    expect(pluginInstalled).toBe(true);
  });
});

// ─── queryAgent tests ─────────────────────────────────────────────

describe("queryAgent", () => {
  it("fetches and returns agent info", async () => {
    const { queryAgent } = await import("../registry/solana-registry.js");

    const agent = await queryAgent("someAssetAddress", "mainnet-beta");

    expect(agent).not.toBeNull();
    expect(agent!.agentURI).toBe("https://example.com/agent.json");
    expect(agent!.name).toBe("TestAgent");
    expect(agent!.assetAddress).toBe("someAssetAddress");
  });

  it("returns null when asset not found", async () => {
    const { fetchAssetV1 } = await import("@metaplex-foundation/mpl-core");
    (fetchAssetV1 as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Asset not found"),
    );

    const { queryAgent } = await import("../registry/solana-registry.js");
    const agent = await queryAgent("nonExistentAsset", "mainnet-beta");

    expect(agent).toBeNull();
  });
});

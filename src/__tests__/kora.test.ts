/**
 * KoraClient Unit Tests
 *
 * Tests for the Kora fee-abstraction JSON-RPC client.
 * All network calls are mocked via vi.stubGlobal.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KoraClient, createKoraClient } from "../solana/kora.js";

// ─── Helpers ─────────────────────────────────────────────────────

const KORA_URL = "http://kora-test:8080";

function makeOkResponse(result: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, result }),
  };
}

function makeErrorResponse(code: number, message: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, error: { code, message } }),
  };
}

function makeHttpErrorResponse(status: number) {
  return { ok: false, status, statusText: "Internal Server Error" };
}

function parsedBody(fetchMock: ReturnType<typeof vi.fn>, callIndex = 0) {
  return JSON.parse(fetchMock.mock.calls[callIndex][1].body);
}

// ─── Tests ───────────────────────────────────────────────────────

describe("KoraClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: KoraClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    client = new KoraClient({ rpcUrl: KORA_URL });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── transferTransaction ──────────────────────────────────────

  describe("transferTransaction", () => {
    it("sends correct JSON-RPC payload", async () => {
      fetchMock.mockResolvedValueOnce(
        makeOkResponse({
          transaction: "base64EncodedTx",
          blockhash: "blockhash123",
          signer_pubkey: "userPubkey",
          message: "",
          instructions: [],
        }),
      );

      const result = await client.transferTransaction({
        amount: 1_000_000,
        token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        source: "sourceWallet123",
        destination: "destWallet456",
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe(KORA_URL);
      expect(opts.method).toBe("POST");
      expect(opts.headers["Content-Type"]).toBe("application/json");

      const body = parsedBody(fetchMock);
      expect(body.jsonrpc).toBe("2.0");
      expect(body.method).toBe("transferTransaction");
      expect(body.params.amount).toBe(1_000_000);
      expect(body.params.token).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
      expect(body.params.source).toBe("sourceWallet123");
      expect(body.params.destination).toBe("destWallet456");

      expect(result.transaction).toBe("base64EncodedTx");
      expect(result.signer_pubkey).toBe("userPubkey");
    });

    it("throws on RPC error response", async () => {
      fetchMock.mockResolvedValueOnce(
        makeErrorResponse(-32600, "Invalid params"),
      );

      await expect(
        client.transferTransaction({
          amount: 100,
          token: "mint",
          source: "src",
          destination: "dst",
        }),
      ).rejects.toThrow("Kora RPC error [-32600]: Invalid params");
    });
  });

  // ── signAndSendTransaction ────────────────────────────────────

  describe("signAndSendTransaction", () => {
    it("sends correct payload and returns signature", async () => {
      fetchMock.mockResolvedValueOnce(
        makeOkResponse({
          signature: "txSig123abc",
          signed_transaction: "fullSignedTxBase64",
          signer_pubkey: "koraPayerPubkey",
        }),
      );

      const result = await client.signAndSendTransaction("partiallySignedBase64");

      const body = parsedBody(fetchMock);
      expect(body.method).toBe("signAndSendTransaction");
      expect(body.params.transaction).toBe("partiallySignedBase64");

      expect(result.signature).toBe("txSig123abc");
      expect(result.signed_transaction).toBe("fullSignedTxBase64");
    });

    it("throws on HTTP error", async () => {
      fetchMock.mockResolvedValueOnce(makeHttpErrorResponse(500));

      await expect(
        client.signAndSendTransaction("someTx"),
      ).rejects.toThrow("Kora RPC HTTP error: 500");
    });
  });

  // ── signTransaction ───────────────────────────────────────────

  describe("signTransaction", () => {
    it("sends correct payload without broadcasting", async () => {
      fetchMock.mockResolvedValueOnce(
        makeOkResponse({
          signature: "koraSig",
          signed_transaction: "fullSignedTx",
        }),
      );

      const result = await client.signTransaction("myPartialTx");

      const body = parsedBody(fetchMock);
      expect(body.method).toBe("signTransaction");
      expect(body.params.transaction).toBe("myPartialTx");

      expect(result.signature).toBe("koraSig");
      expect(result.signed_transaction).toBe("fullSignedTx");
    });
  });

  // ── getPayerSigner ────────────────────────────────────────────

  describe("getPayerSigner", () => {
    it("returns payer signer info", async () => {
      fetchMock.mockResolvedValueOnce(
        makeOkResponse({
          payerSigner: "koraFeePayerPubkey",
          paymentDestination: "koraPaymentDestination",
        }),
      );

      const result = await client.getPayerSigner();

      const body = parsedBody(fetchMock);
      expect(body.method).toBe("getPayerSigner");

      expect(result.payerSigner).toBe("koraFeePayerPubkey");
      expect(result.paymentDestination).toBe("koraPaymentDestination");
    });
  });

  // ── getSupportedTokens ────────────────────────────────────────

  describe("getSupportedTokens", () => {
    it("returns list of tokens", async () => {
      fetchMock.mockResolvedValueOnce(
        makeOkResponse({
          tokens: [
            { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6 },
          ],
        }),
      );

      const result = await client.getSupportedTokens();

      const body = parsedBody(fetchMock);
      expect(body.method).toBe("getSupportedTokens");

      expect(result.tokens).toHaveLength(1);
      expect(result.tokens[0].symbol).toBe("USDC");
      expect(result.tokens[0].decimals).toBe(6);
    });
  });

  // ── estimateTransactionFee ────────────────────────────────────

  describe("estimateTransactionFee", () => {
    it("sends fee estimation request", async () => {
      fetchMock.mockResolvedValueOnce(
        makeOkResponse({
          lamports: 5000,
          token_amount: 100,
          fee_token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        }),
      );

      const result = await client.estimateTransactionFee(
        "myTxBase64",
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      );

      const body = parsedBody(fetchMock);
      expect(body.method).toBe("estimateTransactionFee");
      expect(body.params.transaction).toBe("myTxBase64");
      expect(body.params.fee_token).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

      expect(result.lamports).toBe(5000);
      expect(result.token_amount).toBe(100);
    });
  });

  // ── isAvailable ───────────────────────────────────────────────

  describe("isAvailable", () => {
    it("returns true when server responds", async () => {
      fetchMock.mockResolvedValueOnce(
        makeOkResponse({
          payerSigner: "pubkey",
          paymentDestination: "dest",
        }),
      );

      const available = await client.isAvailable();
      expect(available).toBe(true);
    });

    it("returns false when server is unreachable", async () => {
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const available = await client.isAvailable();
      expect(available).toBe(false);
    });

    it("returns false on HTTP error", async () => {
      fetchMock.mockResolvedValueOnce(makeHttpErrorResponse(503));

      const available = await client.isAvailable();
      expect(available).toBe(false);
    });
  });

  // ── Error handling ────────────────────────────────────────────

  describe("error handling", () => {
    it("includes error code in message", async () => {
      fetchMock.mockResolvedValueOnce(
        makeErrorResponse(-32700, "Parse error"),
      );

      await expect(client.getPayerSigner()).rejects.toThrow(
        "Kora RPC error [-32700]: Parse error",
      );
    });

    it("throws on non-OK HTTP status", async () => {
      fetchMock.mockResolvedValueOnce(makeHttpErrorResponse(404));

      await expect(client.getSupportedTokens()).rejects.toThrow(
        "Kora RPC HTTP error: 404",
      );
    });

    it("propagates network errors", async () => {
      fetchMock.mockRejectedValueOnce(new Error("Network failure"));

      await expect(client.signTransaction("tx")).rejects.toThrow("Network failure");
    });
  });
});

// ─── createKoraClient factory ─────────────────────────────────────

describe("createKoraClient", () => {
  it("returns KoraClient when URL is provided", () => {
    const client = createKoraClient("http://localhost:8080");
    expect(client).toBeInstanceOf(KoraClient);
  });

  it("returns null when URL is undefined", () => {
    const client = createKoraClient(undefined);
    expect(client).toBeNull();
  });

  it("returns null when URL is empty string", () => {
    const client = createKoraClient("");
    expect(client).toBeNull();
  });
});

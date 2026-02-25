/**
 * Kora — Solana Fee Abstraction Client
 *
 * Kora is a JSON-RPC signing service that allows users to pay transaction
 * fees in USDC instead of native SOL. Users never need SOL in their wallets.
 *
 * Docs: https://launch.solana.com/docs/kora
 * JSON-RPC API: https://launch.solana.com/docs/kora/json-rpc-api
 */

// ─── Types ────────────────────────────────────────────────────────

export interface KoraConfig {
  /** URL of the Kora RPC server (e.g. http://localhost:8080) */
  rpcUrl: string;
}

export interface TransferTransactionRequest {
  /** Amount in smallest token units (e.g. 1_000_000 = 1 USDC) */
  amount: number;
  /** SPL token mint address */
  token: string;
  /** Sender's wallet address (base58) */
  source: string;
  /** Recipient's wallet address (base58) */
  destination: string;
}

export interface TransferTransactionResponse {
  blockhash: string;
  /** Base64-encoded partially-built transaction (Kora is fee payer, awaits user signature) */
  transaction: string;
  /** The public key that must sign the transaction (user's wallet) */
  signer_pubkey: string;
  message: string;
  instructions: unknown;
}

export interface SignAndSendTransactionRequest {
  /** Base64-encoded partially signed transaction */
  transaction: string;
}

export interface SignAndSendTransactionResponse {
  /** Transaction signature (base58) */
  signature: string;
  /** Fully signed transaction (base64) */
  signed_transaction: string;
  /** Kora's fee payer public key */
  signer_pubkey: string;
}

export interface SignTransactionResponse {
  /** Kora's signature (base58) */
  signature: string;
  /** Fully signed transaction (base64) — Kora signed as fee payer */
  signed_transaction: string;
}

export interface GetPayerSignerResponse {
  /** Kora's fee payer public key (base58) */
  payerSigner: string;
  /** Kora's payment destination address (base58) — USDC fees go here */
  paymentDestination: string;
}

export interface SupportedToken {
  mint: string;
  symbol: string;
  decimals: number;
}

export interface GetSupportedTokensResponse {
  tokens: SupportedToken[];
}

export interface EstimateTransactionFeeResponse {
  /** Estimated fee in lamports */
  lamports: number;
  /** Estimated fee in the specified token (smallest units) */
  token_amount: number;
  /** Fee token mint */
  fee_token: string;
}

// ─── Kora JSON-RPC Client ─────────────────────────────────────────

export class KoraClient {
  private readonly rpcUrl: string;

  constructor(config: KoraConfig) {
    this.rpcUrl = config.rpcUrl;
  }

  private async rpc<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
    });

    if (!response.ok) {
      throw new Error(`Kora RPC HTTP error: ${response.status} ${response.statusText}`);
    }

    const json = await response.json() as { result?: T; error?: { code: number; message: string } };

    if (json.error) {
      throw new Error(`Kora RPC error [${json.error.code}]: ${json.error.message}`);
    }

    return json.result as T;
  }

  /**
   * Build a token transfer transaction with Kora as fee payer.
   * The returned transaction is partially built — user must sign it.
   */
  async transferTransaction(
    params: TransferTransactionRequest,
  ): Promise<TransferTransactionResponse> {
    return this.rpc<TransferTransactionResponse>("transferTransaction", params as unknown as Record<string, unknown>);
  }

  /**
   * Submit a partially-signed transaction to Kora.
   * Kora adds its fee payer signature and broadcasts to Solana.
   */
  async signAndSendTransaction(
    transaction: string,
  ): Promise<SignAndSendTransactionResponse> {
    return this.rpc<SignAndSendTransactionResponse>("signAndSendTransaction", {
      transaction,
    });
  }

  /**
   * Sign a transaction as fee payer WITHOUT broadcasting.
   * Useful when you need a fully signed tx to include in X-Payment headers.
   */
  async signTransaction(transaction: string): Promise<SignTransactionResponse> {
    return this.rpc<SignTransactionResponse>("signTransaction", { transaction });
  }

  /**
   * Get Kora's fee payer address and payment destination.
   */
  async getPayerSigner(): Promise<GetPayerSignerResponse> {
    return this.rpc<GetPayerSignerResponse>("getPayerSigner", {});
  }

  /**
   * List tokens that Kora accepts for fee payment.
   */
  async getSupportedTokens(): Promise<GetSupportedTokensResponse> {
    return this.rpc<GetSupportedTokensResponse>("getSupportedTokens", {});
  }

  /**
   * Estimate transaction fee in both lamports and a specified SPL token.
   */
  async estimateTransactionFee(
    transaction: string,
    feeToken: string,
  ): Promise<EstimateTransactionFeeResponse> {
    return this.rpc<EstimateTransactionFeeResponse>("estimateTransactionFee", {
      transaction,
      fee_token: feeToken,
    });
  }

  /**
   * Check if the Kora server is reachable.
   */
  async isAvailable(): Promise<boolean> {
    try {
      await this.getPayerSigner();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Create a KoraClient from a config URL.
 * Returns null if no URL is configured.
 */
export function createKoraClient(rpcUrl: string | undefined): KoraClient | null {
  if (!rpcUrl) return null;
  return new KoraClient({ rpcUrl });
}

/**
 * Helpers shared by both gas-station handlers.
 *
 * These lived twice, byte-identical, in the store's two handler files — once
 * per chain. There is one copy here because the two handlers answer the same
 * job protocol on two different chains: the same `['param', k, v]` tag shape,
 * the same base64-JSON receipt envelope, the same "a refusal is a successful
 * job whose answer is no" contract. A divergence between them would be a bug
 * in the protocol, not a chain difference.
 */

import type { NostrEvent } from 'nostr-tools/pure';
import type { GasStationHandlerResponse } from './gas-station-backend.js';

/** Which Solana cluster to target. No testnet — the TOON devnet settles on Solana devnet. */
export type SolanaNetwork = 'mainnet' | 'devnet';

/** Base58 Solana pubkey (32–44 chars, Bitcoin/Solana alphabet). */
export const SOLANA_PUBKEY_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** First value of a NIP-90 `['param', <key>, <value>]` tag, if present. */
export function paramTag(event: NostrEvent, key: string): string | undefined {
  for (const tag of event.tags) {
    if (tag[0] === 'param' && tag[1] === key) return tag[2];
  }
  return undefined;
}

/**
 * Wrap a receipt as an accepted job result. The receipt travels as base64 JSON
 * in the job's `data` field, which is what the kind:6096 / kind:6098 result
 * body carries.
 *
 * Note what this is used for: a POLICY REFUSAL is also an accept. The DVM was
 * asked a question, applied its rules, and answered "no" — that is a job it
 * processed successfully, and the caller gets a machine-readable reason rather
 * than a transport-level reject it cannot interpret.
 */
export function acceptReceipt(receipt: unknown): GasStationHandlerResponse {
  return {
    accept: true,
    data: Buffer.from(JSON.stringify(receipt), 'utf8').toString('base64'),
  };
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * ar.io's Solana program ids and the public cluster RPC URLs, per network.
 *
 * WHY THESE ARE LITERALS AND NOT AN SDK IMPORT
 *
 * These ids are one input to the kind:5096 program whitelist — the list of
 * programs the gas station is willing to co-sign a transaction against. That
 * makes them a security boundary, and a security boundary should not move
 * because a dependency published a minor version. The store imported them
 * from `@ar.io/sdk` at runtime through a variable specifier, which meant the
 * whitelist could widen on a `pnpm update` with no diff to review.
 *
 * So they are written down here, reviewed, and `ario-programs.test.ts` asserts
 * this table still equals what `@ar.io/sdk` exports. The SDK stays a
 * devDependency: drift fails CI, where it can be read, instead of changing
 * what a funded fee-payer will sign, in production, silently.
 *
 * Verified against @ar.io/sdk 4.2.0 (unchanged since 4.0.3).
 *
 * ar.io has NO deployment on Solana's testnet cluster — devnet and mainnet are
 * the only two networks that exist here.
 */

import type { SolanaNetwork } from './job-params.js';

/** Public cluster RPC, per network. Override with SOLANA_RPC_URL. */
export const SOLANA_RPC_URLS: Record<SolanaNetwork, string> = {
  devnet: 'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
};

/**
 * ar.io program ids per network. Devnet publishes five (the SDK's
 * `DEVNET_PROGRAM_IDS`); mainnet publishes three (`ARIO_ANT_PROGRAM_ID`,
 * `ARIO_ARNS_PROGRAM_ID`, `ARIO_CORE_PROGRAM_ID`) — there is no mainnet
 * export for gar or antEscrow.
 */
export const ARIO_PROGRAM_IDS: Record<SolanaNetwork, readonly string[]> = {
  devnet: [
    '8Njx9wPkXiNzDCgjwVsJFRjpAEV34gGW3n8DzX3V23m1', // core
    '7WsDTrtZBsfKtnP33XkjuqXCY69JE7n4QVYpynqJCFxz', // gar
    '6EZNezcg4rc5hnh8HG34vGquT3WpW5xXypzPb24uyEpp', // arns
    'DbHbRwUD1oAn1mrDSqtWtvwGcNrmhWdD2g8L4xmeQ7NX', // ant
    'bttco5oAnBwCucG63iKokBJCZmNr493f3Ewe9LM3oTx', // antEscrow
  ],
  mainnet: [
    '2MWexMHfMhGJwMHv9Qm9YAVCqjUFUJwDJAysW4oCUGk5', // ant
    '2yCUx5edFvUrkibYaUa2ZXWyx9kuJkS8CwyzsgHPWdZZ', // arns
    '73YoECm6NKXpVRoe5f1Q9BcP5DJGPFUjnFy6AxBE5Nvh', // core
  ],
} as const;

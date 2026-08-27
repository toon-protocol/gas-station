/**
 * The drift guard for ./ario-programs.ts.
 *
 * Those ids are a security whitelist input, so they are literals rather than a
 * runtime read off @ar.io/sdk — a whitelist that widens when a dependency
 * publishes a minor version is not a whitelist. The cost of that choice is
 * that the table can go stale, and this test is what pays it: @ar.io/sdk is a
 * devDependency, and CI fails here if the two disagree.
 *
 * If this test fails, ar.io moved a program. Do not just paste the new value
 * in — work out what moved and why, then update the table deliberately.
 */

import { describe, it, expect } from 'vitest';
import { ARIO_PROGRAM_IDS, SOLANA_RPC_URLS } from './ario-programs.js';

interface ArioSdkExports {
  DEVNET_RPC_URL?: string;
  DEFAULT_SOLANA_RPC_URL?: string;
  DEVNET_PROGRAM_IDS?: Record<string, string>;
  ARIO_ANT_PROGRAM_ID?: unknown;
  ARIO_ARNS_PROGRAM_ID?: unknown;
  ARIO_CORE_PROGRAM_ID?: unknown;
}

const sdk = (await import('@ar.io/sdk')) as ArioSdkExports;

describe('ario-programs matches @ar.io/sdk', () => {
  it('carries every devnet program id the SDK exports', () => {
    const fromSdk = Object.values(sdk.DEVNET_PROGRAM_IDS ?? {}).sort();
    expect(
      [...ARIO_PROGRAM_IDS.devnet].sort(),
      'ARIO_PROGRAM_IDS.devnet has drifted from @ar.io/sdk DEVNET_PROGRAM_IDS — ' +
        'a program moved, and the kind:5096 whitelist would be wrong'
    ).toEqual(fromSdk);
  });

  it('carries every mainnet program id the SDK exports', () => {
    const fromSdk = [
      sdk.ARIO_ANT_PROGRAM_ID,
      sdk.ARIO_ARNS_PROGRAM_ID,
      sdk.ARIO_CORE_PROGRAM_ID,
    ]
      .filter((id): id is string => typeof id === 'string')
      .sort();
    expect(
      [...ARIO_PROGRAM_IDS.mainnet].sort(),
      'ARIO_PROGRAM_IDS.mainnet has drifted from @ar.io/sdk ARIO_*_PROGRAM_ID'
    ).toEqual(fromSdk);
  });

  it('uses the SDK cluster RPC URLs', () => {
    expect(SOLANA_RPC_URLS.devnet).toBe(sdk.DEVNET_RPC_URL);
    expect(SOLANA_RPC_URLS.mainnet).toBe(sdk.DEFAULT_SOLANA_RPC_URL);
  });

  it('has no duplicates and every id is a plausible base58 pubkey', () => {
    for (const [network, ids] of Object.entries(ARIO_PROGRAM_IDS)) {
      expect(new Set(ids).size, `${network} has a duplicate program id`).toBe(ids.length);
      for (const id of ids) {
        expect(id, `${network} id ${id} is not base58`).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      }
    }
  });
});

/**
 * Unit tests for entrypoint-gas-station.ts.
 *
 * Infra-free: every test drives an exported function with a hand-built env
 * object. Nothing starts a server, dials a chain, or reads a key from disk.
 *
 * The theme of the env tests is one rule, applied to both chains: ABSENT and
 * MALFORMED must not look the same. Absent leaves a kind unregistered (a
 * deliberate deployment choice); malformed refuses to boot (a typo that would
 * otherwise ship a node quietly answering nothing).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createJobCounter,
  resolvePortConfig,
  resolveGasStationEnv,
  resolveEvmGasStationEnv,
  buildHandlers,
} from './entrypoint-gas-station.js';
import type { GasStationHandlerContext } from './gas-station-backend.js';

const SOLANA_KEY = 'b'.repeat(128);
const NOSTR_KEY = 'a'.repeat(64);
const CHANNEL_PROGRAM_ID = '2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip';
const FORWARDER = '0x111111111111111111111111111111111111111f';
const TOKEN_NETWORK = '0x222222222222222222222222222222222222222f';
const RELAYER_KEY = '0x' + '7'.repeat(64);

function evmEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chainId: 84532,
    rpcUrl: 'https://sepolia.base.org',
    forwarderAddress: FORWARDER,
    tokenNetworkAddress: TOKEN_NETWORK,
    relayerPrivateKey: RELAYER_KEY,
    ...overrides,
  };
}

const ctxStub = {} as GasStationHandlerContext;

// ---------------------------------------------------------------------------

describe('createJobCounter', () => {
  it('counts a success against its kind', async () => {
    const counter = createJobCounter();
    const wrapped = counter.wrap(5096, async () => ({ accept: true as const }));
    await wrapped(ctxStub);
    const snap = counter.snapshot();
    expect(snap.total).toBe(1);
    expect(snap.byKind).toEqual([{ kind: 5096, count: 1 }]);
    expect(snap.byStatus.success).toBe(1);
    expect(snap.byStatus.error).toBe(0);
    expect(snap.byStatus.processing).toBe(0);
  });

  it('counts a throw as an error and still lets it propagate', async () => {
    const counter = createJobCounter();
    const wrapped = counter.wrap(5098, async () => {
      throw new Error('boom');
    });
    await expect(wrapped(ctxStub)).rejects.toThrow('boom');
    const snap = counter.snapshot();
    expect(snap.byStatus.error).toBe(1);
    // The in-flight gauge must come back down on the failure path too, or it
    // ratchets up forever and /health reports a node that is permanently busy.
    expect(snap.byStatus.processing).toBe(0);
  });

  it('keeps kinds separate', async () => {
    const counter = createJobCounter();
    await counter.wrap(5096, async () => ({ accept: true as const }))(ctxStub);
    await counter.wrap(5098, async () => ({ accept: true as const }))(ctxStub);
    await counter.wrap(5098, async () => ({ accept: true as const }))(ctxStub);
    const byKind = Object.fromEntries(
      counter.snapshot().byKind.map((k) => [k.kind, k.count])
    );
    expect(byKind).toEqual({ 5096: 1, 5098: 2 });
  });

  it('evicts events older than the window', async () => {
    vi.useFakeTimers();
    try {
      const counter = createJobCounter(1000);
      await counter.wrap(5096, async () => ({ accept: true as const }))(ctxStub);
      expect(counter.snapshot().total).toBe(1);
      vi.advanceTimersByTime(1500);
      expect(counter.snapshot().total).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------

describe('resolvePortConfig', () => {
  it('reads the identity and defaults the ports', () => {
    const config = resolvePortConfig({ NODE_NOSTR_SECRET_KEY: NOSTR_KEY });
    expect(config.handlerPort).toBe(3300);
    expect(config.blsPort).toBe(3400);
    expect(Buffer.from(config.secretKey).toString('hex')).toBe(NOSTR_KEY);
  });

  it('requires the identity', () => {
    expect(() => resolvePortConfig({})).toThrow(/NODE_NOSTR_SECRET_KEY is required/);
  });

  it.each([['too short', 'abc'], ['not hex', 'z'.repeat(64)]])(
    'refuses an identity that is %s',
    (_label, value) => {
      expect(() => resolvePortConfig({ NODE_NOSTR_SECRET_KEY: value })).toThrow(
        /64-char hex/
      );
    }
  );

  it('honours port overrides', () => {
    const config = resolvePortConfig({
      NODE_NOSTR_SECRET_KEY: NOSTR_KEY,
      HANDLER_PORT: '8080',
      BLS_PORT: '8081',
    });
    expect(config.handlerPort).toBe(8080);
    expect(config.blsPort).toBe(8081);
  });

  it('refuses two servers on one port', () => {
    expect(() =>
      resolvePortConfig({
        NODE_NOSTR_SECRET_KEY: NOSTR_KEY,
        HANDLER_PORT: '3300',
        BLS_PORT: '3300',
      })
    ).toThrow(/must differ/);
  });

  it('refuses an out-of-range port', () => {
    expect(() =>
      resolvePortConfig({ NODE_NOSTR_SECRET_KEY: NOSTR_KEY, HANDLER_PORT: '99999' })
    ).toThrow(/0\.\.65535/);
  });
});

// ---------------------------------------------------------------------------

describe('resolveGasStationEnv', () => {
  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['whitespace', '   '],
  ])('leaves kind:5096 unregistered when the key is %s', (_label, value) => {
    const env = value === undefined ? {} : { GAS_STATION_SOLANA_SECRET_KEY: value };
    expect(resolveGasStationEnv(env)).toBeUndefined();
  });

  it('defaults to devnet — mainnet is explicit opt-in', () => {
    const config = resolveGasStationEnv({ GAS_STATION_SOLANA_SECRET_KEY: SOLANA_KEY });
    expect(config?.network).toBe('devnet');
  });

  it('accepts mainnet when asked for it', () => {
    const config = resolveGasStationEnv({
      GAS_STATION_SOLANA_SECRET_KEY: SOLANA_KEY,
      SOLANA_NETWORK: 'mainnet',
    });
    expect(config?.network).toBe('mainnet');
  });

  it.each([['testnet'], ['DEVNET'], ['localnet']])(
    'refuses SOLANA_NETWORK=%s (ar.io has no such deployment)',
    (network) => {
      expect(() =>
        resolveGasStationEnv({
          GAS_STATION_SOLANA_SECRET_KEY: SOLANA_KEY,
          SOLANA_NETWORK: network,
        })
      ).toThrow(/SOLANA_NETWORK/);
    }
  );

  it.each([
    ['too short', 'b'.repeat(64)],
    ['not hex', 'z'.repeat(128)],
  ])('refuses a fee-payer key that is %s', (_label, value) => {
    expect(() => resolveGasStationEnv({ GAS_STATION_SOLANA_SECRET_KEY: value })).toThrow(
      /128-char hex/
    );
  });

  describe('GAS_STATION_CHANNEL_PROGRAM_ID', () => {
    it('is undefined when absent', () => {
      const config = resolveGasStationEnv({ GAS_STATION_SOLANA_SECRET_KEY: SOLANA_KEY });
      expect(config?.channelProgramId).toBeUndefined();
    });

    it('surfaces a valid base58 program id', () => {
      const config = resolveGasStationEnv({
        GAS_STATION_SOLANA_SECRET_KEY: SOLANA_KEY,
        GAS_STATION_CHANNEL_PROGRAM_ID: CHANNEL_PROGRAM_ID,
      });
      expect(config?.channelProgramId).toBe(CHANNEL_PROGRAM_ID);
    });

    it('trims surrounding whitespace', () => {
      const config = resolveGasStationEnv({
        GAS_STATION_SOLANA_SECRET_KEY: SOLANA_KEY,
        GAS_STATION_CHANNEL_PROGRAM_ID: `  ${CHANNEL_PROGRAM_ID}  `,
      });
      expect(config?.channelProgramId).toBe(CHANNEL_PROGRAM_ID);
    });

    it('throws on a malformed one', () => {
      expect(() =>
        resolveGasStationEnv({
          GAS_STATION_SOLANA_SECRET_KEY: SOLANA_KEY,
          GAS_STATION_CHANNEL_PROGRAM_ID: 'not-base58!',
        })
      ).toThrow(/GAS_STATION_CHANNEL_PROGRAM_ID/);
    });

    it('does not by itself register the kind', () => {
      expect(
        resolveGasStationEnv({ GAS_STATION_CHANNEL_PROGRAM_ID: CHANNEL_PROGRAM_ID })
      ).toBeUndefined();
    });
  });

  describe('SOLANA_RPC_URL', () => {
    it('is undefined when absent (the cluster default is used)', () => {
      const config = resolveGasStationEnv({ GAS_STATION_SOLANA_SECRET_KEY: SOLANA_KEY });
      expect(config?.rpcUrl).toBeUndefined();
    });

    it('accepts an https override', () => {
      const config = resolveGasStationEnv({
        GAS_STATION_SOLANA_SECRET_KEY: SOLANA_KEY,
        SOLANA_RPC_URL: 'https://rpc.example.com',
      });
      expect(config?.rpcUrl).toBe('https://rpc.example.com');
    });

    it.each([['not-a-url'], ['ftp://rpc.example.com']])('refuses %s', (value) => {
      expect(() =>
        resolveGasStationEnv({
          GAS_STATION_SOLANA_SECRET_KEY: SOLANA_KEY,
          SOLANA_RPC_URL: value,
        })
      ).toThrow(/SOLANA_RPC_URL/);
    });
  });

  describe('GAS_STATION_MAX_LAMPORTS_CEILING', () => {
    it('is undefined when absent (the policy default applies)', () => {
      const config = resolveGasStationEnv({ GAS_STATION_SOLANA_SECRET_KEY: SOLANA_KEY });
      expect(config?.maxLamportsCeiling).toBeUndefined();
    });

    it('surfaces a positive integer of lamports as a bigint', () => {
      const config = resolveGasStationEnv({
        GAS_STATION_SOLANA_SECRET_KEY: SOLANA_KEY,
        GAS_STATION_MAX_LAMPORTS_CEILING: ' 16500000 ',
      });
      expect(config?.maxLamportsCeiling).toBe(16_500_000n);
    });

    it.each([['0'], ['-1'], ['0.02'], ['20e6'], ['lots']])('refuses %s', (value) => {
      expect(() =>
        resolveGasStationEnv({
          GAS_STATION_SOLANA_SECRET_KEY: SOLANA_KEY,
          GAS_STATION_MAX_LAMPORTS_CEILING: value,
        })
      ).toThrow(/GAS_STATION_MAX_LAMPORTS_CEILING/);
    });
  });

  describe('GAS_STATION_QUOTE_TTL_MS', () => {
    it('is surfaced when set', () => {
      const config = resolveGasStationEnv({
        GAS_STATION_SOLANA_SECRET_KEY: SOLANA_KEY,
        GAS_STATION_QUOTE_TTL_MS: '90000',
      });
      expect(config?.quoteTtlMs).toBe(90_000);
    });

    it.each([['zero', '0'], ['negative', '-1'], ['not a number', 'soon']])(
      'refuses %s',
      (_label, value) => {
        expect(() =>
          resolveGasStationEnv({
            GAS_STATION_SOLANA_SECRET_KEY: SOLANA_KEY,
            GAS_STATION_QUOTE_TTL_MS: value,
          })
        ).toThrow(/GAS_STATION_QUOTE_TTL_MS/);
      }
    );
  });
});

// ---------------------------------------------------------------------------

describe('resolveEvmGasStationEnv', () => {
  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['whitespace', '  '],
  ])('leaves kind:5098 unregistered when the config is %s', (_label, value) => {
    const env = value === undefined ? {} : { EVM_GAS_STATION_CONFIG_JSON: value };
    expect(resolveEvmGasStationEnv(env)).toBeUndefined();
  });

  it('parses a single chain and checksums its addresses', () => {
    // The live Base Sepolia forwarder and TokenNetwork, lowercased: a
    // real-world pair whose EIP-55 checksum is visibly different from the
    // input, so this asserts the normalization actually happened.
    const lowerForwarder = '0x350fcd266f95b1f5b84944e0c7e06c16b837fcaa';
    const lowerTokenNetwork = '0xe9e05dfecfe165266c88d73e61d483612651952a';
    const config = resolveEvmGasStationEnv({
      EVM_GAS_STATION_CONFIG_JSON: JSON.stringify([
        evmEntry({
          forwarderAddress: lowerForwarder,
          tokenNetworkAddress: lowerTokenNetwork,
        }),
      ]),
    });
    expect(config?.chains).toHaveLength(1);
    const chain = config?.chains[0];
    expect(chain?.chainId).toBe(84532);
    expect(chain?.forwarderAddress).toBe('0x350fCd266F95B1f5B84944E0C7e06C16B837FCAA');
    expect(chain?.tokenNetworkAddress).toBe('0xe9E05dfecfe165266C88d73e61D483612651952a');
  });

  it('parses several chains — adding one is a config entry, not a code change', () => {
    const config = resolveEvmGasStationEnv({
      EVM_GAS_STATION_CONFIG_JSON: JSON.stringify([
        evmEntry(),
        evmEntry({ chainId: 11155111, rpcUrl: 'https://sepolia.example.com' }),
      ]),
    });
    expect(config?.chains.map((c) => c.chainId)).toEqual([84532, 11155111]);
  });

  it.each([
    ['invalid JSON', '{not json'],
    ['not an array', JSON.stringify({ chainId: 1 })],
    ['an empty array', '[]'],
  ])('throws on %s', (_label, value) => {
    expect(() => resolveEvmGasStationEnv({ EVM_GAS_STATION_CONFIG_JSON: value })).toThrow(
      /EVM_GAS_STATION_CONFIG_JSON/
    );
  });

  it('throws on a duplicate chainId (two relayers for one chain is ambiguous)', () => {
    expect(() =>
      resolveEvmGasStationEnv({
        EVM_GAS_STATION_CONFIG_JSON: JSON.stringify([evmEntry(), evmEntry()]),
      })
    ).toThrow(/duplicate chainId 84532/);
  });

  it.each([
    ['chainId is a string', { chainId: '84532' }, /chainId/],
    ['chainId is zero', { chainId: 0 }, /chainId/],
    ['chainId is fractional', { chainId: 1.5 }, /chainId/],
    ['rpcUrl is empty', { rpcUrl: '' }, /rpcUrl/],
    ['rpcUrl is not a URL', { rpcUrl: 'nope' }, /rpcUrl/],
    ['rpcUrl is the wrong scheme', { rpcUrl: 'ftp://x.example.com' }, /rpcUrl/],
    ['forwarderAddress is not an address', { forwarderAddress: '0xdeadbeef' }, /forwarderAddress/],
    ['tokenNetworkAddress is missing', { tokenNetworkAddress: undefined }, /tokenNetworkAddress/],
    ['relayerPrivateKey lacks 0x', { relayerPrivateKey: '7'.repeat(64) }, /relayerPrivateKey/],
    ['relayerPrivateKey is short', { relayerPrivateKey: '0x7777' }, /relayerPrivateKey/],
  ])('throws when %s', (_label, overrides, pattern) => {
    expect(() =>
      resolveEvmGasStationEnv({
        EVM_GAS_STATION_CONFIG_JSON: JSON.stringify([evmEntry(overrides)]),
      })
    ).toThrow(pattern);
  });

  it('names the offending index so a multi-chain config is debuggable', () => {
    expect(() =>
      resolveEvmGasStationEnv({
        EVM_GAS_STATION_CONFIG_JSON: JSON.stringify([
          evmEntry(),
          evmEntry({ chainId: 5, forwarderAddress: 'nope' }),
        ]),
      })
    ).toThrow(/\[1\]\.forwarderAddress/);
  });

  it('surfaces the optional overrides', () => {
    const config = resolveEvmGasStationEnv({
      EVM_GAS_STATION_CONFIG_JSON: JSON.stringify([evmEntry()]),
      EVM_GAS_STATION_QUOTE_TTL_MS: '300000',
      EVM_GAS_STATION_MAX_GAS: '500000',
    });
    expect(config?.quoteTtlMs).toBe(300_000);
    expect(config?.maxGas).toBe(500_000n);
  });

  it.each([
    ['EVM_GAS_STATION_QUOTE_TTL_MS', 'soon'],
    ['EVM_GAS_STATION_MAX_GAS', 'lots'],
    ['EVM_GAS_STATION_MAX_GAS', '0'],
  ])('refuses a malformed %s', (key, value) => {
    expect(() =>
      resolveEvmGasStationEnv({
        EVM_GAS_STATION_CONFIG_JSON: JSON.stringify([evmEntry()]),
        [key]: value,
      })
    ).toThrow(new RegExp(key));
  });
});

// ---------------------------------------------------------------------------

describe('buildHandlers', () => {
  const counter = createJobCounter();

  it('registers only Solana when only Solana is configured', () => {
    const { handlers } = buildHandlers(
      { GAS_STATION_SOLANA_SECRET_KEY: SOLANA_KEY },
      counter
    );
    expect(Object.keys(handlers).map(Number)).toEqual([5096]);
  });

  it('registers only EVM when only EVM is configured', () => {
    const { handlers } = buildHandlers(
      { EVM_GAS_STATION_CONFIG_JSON: JSON.stringify([evmEntry()]) },
      counter
    );
    expect(Object.keys(handlers).map(Number)).toEqual([5098]);
  });

  it('registers both when both are configured', () => {
    const { handlers, describe: lines } = buildHandlers(
      {
        GAS_STATION_SOLANA_SECRET_KEY: SOLANA_KEY,
        EVM_GAS_STATION_CONFIG_JSON: JSON.stringify([evmEntry()]),
      },
      counter
    );
    expect(Object.keys(handlers).map(Number).sort()).toEqual([5096, 5098]);
    expect(lines).toHaveLength(2);
    expect(lines.join(' ')).toContain('84532');
  });

  it('describes each registered kind well enough to act on', () => {
    const { jobs } = buildHandlers(
      {
        GAS_STATION_SOLANA_SECRET_KEY: SOLANA_KEY,
        SOLANA_NETWORK: 'mainnet',
        EVM_GAS_STATION_CONFIG_JSON: JSON.stringify([
          evmEntry(),
          evmEntry({ chainId: 11155111, rpcUrl: 'https://sepolia.example.com' }),
        ]),
      },
      counter
    );
    // The request specs themselves are asserted against the handlers in
    // job-definitions.test.ts — here we only care that each job carries one.
    expect(jobs.map(({ request: _request, ...rest }) => rest)).toEqual([
      {
        kind: 5096,
        resultKind: 6096,
        name: 'solana-gas-station',
        phases: ['quote', 'execute'],
        chains: ['solana:mainnet'],
      },
      {
        kind: 5098,
        resultKind: 6098,
        name: 'evm-gas-station',
        phases: ['quote', 'execute'],
        chains: ['evm:84532', 'evm:11155111'],
      },
    ]);
    for (const job of jobs) {
      expect(Object.keys(job.request).sort()).toEqual(['execute', 'quote']);
    }
  });

  it('describes only what is registered — an unconfigured chain is absent, not empty', () => {
    // The point of deriving this from the registered handlers rather than a
    // config literal: it cannot claim a chain the node will not serve.
    const { jobs } = buildHandlers({ GAS_STATION_SOLANA_SECRET_KEY: SOLANA_KEY }, counter);
    expect(jobs.map((j) => j.kind)).toEqual([5096]);
  });

  it('keeps handlerKinds and jobs in agreement', () => {
    const { handlers, jobs } = buildHandlers(
      {
        GAS_STATION_SOLANA_SECRET_KEY: SOLANA_KEY,
        EVM_GAS_STATION_CONFIG_JSON: JSON.stringify([evmEntry()]),
      },
      counter
    );
    expect(jobs.map((j) => j.kind).sort()).toEqual(Object.keys(handlers).map(Number).sort());
    // The NIP-90 formula, not an arbitrary second allocation.
    for (const job of jobs) expect(job.resultKind).toBe(job.kind + 1000);
  });

  it('refuses to build a gas station with no chain at all', () => {
    // Not a degraded mode worth running: every kind this app serves is
    // optional, so a process with none registered would answer nothing.
    expect(() => buildHandlers({}, counter)).toThrow(/No chain is configured/);
  });
});

// ---------------------------------------------------------------------------

describe('entrypoint-gas-station.ts — health server static analysis', () => {
  let src: string;
  beforeEach(() => {
    src = readFileSync(join(__dirname, 'entrypoint-gas-station.ts'), 'utf-8');
  });

  it('registers GET /health', () => {
    expect(src).toMatch(/blsApp\.get\(['"]\/health['"]/);
  });

  it('serves the self-description at /describe, not /health', () => {
    // Health is polled every 30s by the container healthcheck and answers one
    // question: is this alive. A self-description is a different question from
    // a different caller — folding it in conflates the two.
    expect(src).toMatch(/blsApp\.get\(['"]\/describe['"]/);
    expect(src).toMatch(/blsApp\.get\(['"]\/health['"]/);
  });

  it('keeps the job specs and the transport contract out of /health', () => {
    const health = src.slice(src.indexOf("blsApp.get('/health'"), src.indexOf("blsApp.get('/describe'"));
    expect(health).not.toMatch(/jobs,/);
    expect(health).not.toMatch(/transport:/);
  });

  it('still reports handlerKinds on both — one line, and monitoring wants it', () => {
    expect(src.match(/handlerKinds,/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('serves it on blsPort', () => {
    expect(src).toMatch(/serve\(\s*\{[^}]*config\.blsPort/s);
  });

  it('closes both servers on shutdown', () => {
    expect(src).toMatch(/blsServer\.close\(/);
    expect(src).toMatch(/backend\.close\(/);
  });

  it('scrubs every secret it read out of the environment', () => {
    for (const key of [
      'NODE_NOSTR_SECRET_KEY',
      'GAS_STATION_SOLANA_SECRET_KEY',
      'EVM_GAS_STATION_CONFIG_JSON',
    ]) {
      expect(src).toMatch(new RegExp(`delete process\\.env\\['${key}'\\]`));
    }
  });

  it('does not start a server when imported under vitest', () => {
    expect(src).toMatch(/if \(!process\.env\['VITEST'\]\)/);
  });
});

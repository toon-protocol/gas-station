/**
 * The `/health` request specs must match what the handlers actually parse.
 *
 * A client builds a job from `GAS_STATION_REQUEST_SPEC` /
 * `EVM_GAS_STATION_REQUEST_SPEC`, so a declared param list that has drifted
 * from the parsing code is worse than no list at all — it produces requests
 * that look right and get refused.
 *
 * Being next to the parsing in the same file is not enough to stop that. So
 * these tests DRIVE each handler: for every param declared required, they send
 * a request with exactly that one omitted and assert the handler refuses. A
 * param that can be dropped without complaint was not really required, and a
 * param the handler needs but nobody declared shows up as a refusal in the
 * happy-path case.
 *
 * No chain is touched: the deps seams are stubs, and every case is expected to
 * fail before any RPC call.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';
import {
  GAS_STATION_KIND,
  GAS_STATION_REQUEST_SPEC,
  createGasStationHandler,
} from './solana-gas-station-handler.js';
import {
  EVM_GAS_STATION_KIND,
  EVM_GAS_STATION_REQUEST_SPEC,
  createEvmGasStationHandler,
} from './evm-gas-station-handler.js';
import type { JobRequestSpec } from './job-params.js';
import type {
  GasStationHandlerContext,
  GasStationHandlerResponse,
} from './gas-station-backend.js';

// ---------------------------------------------------------------------------

function jobEvent(kind: number, params: [string, string][]): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: 0,
    kind,
    tags: params.map(([k, v]) => ['param', k, v]),
    content: '',
    sig: 'c'.repeat(128),
  } as NostrEvent;
}

function ctxFor(event: NostrEvent): GasStationHandlerContext {
  return {
    toon: '',
    kind: event.kind,
    pubkey: event.pubkey,
    amount: 0n,
    destination: 'g.toon.gas',
    decode: () => event,
    accept: (metadata) => ({ accept: true, ...(metadata ? { metadata } : {}) }),
    reject: (code, message) => ({ accept: false, code, message }),
  };
}

/** A refusal, however it is spelled: a transport reject or a failed receipt. */
function refused(res: GasStationHandlerResponse): boolean {
  if (!res.accept) return true;
  if (!res.data) return false;
  const receipt = JSON.parse(Buffer.from(res.data, 'base64').toString('utf8')) as {
    status?: string;
  };
  return receipt.status === 'failed';
}

/** Deps stubs that would answer happily — so a refusal is about the params. */
const solanaDeps = () => ({
  rpc: {
    getLatestBlockhash: vi.fn(async () => ({ blockhash: 'H'.repeat(43) })),
    getBalance: vi.fn(async () => 10_000_000_000n),
    simulateTransaction: vi.fn(async () => ({
      err: null,
      logs: [],
      feePayerPostLamports: 10_000_000_000n,
    })),
    sendTransaction: vi.fn(async () => 'sig'),
    getSignatureStatus: vi.fn(async () => ({
      confirmationStatus: 'confirmed',
      err: null,
      slot: 1n,
    })),
    getTransactionFee: vi.fn(async () => 5000n),
  },
  signer: { address: 'F'.repeat(43), sign: vi.fn(async () => new Uint8Array(64)) },
  arioProgramIds: [],
});

const evmDeps = () => ({
  relayerAddress: '0x1111111111111111111111111111111111111111',
  getForwarderNonce: vi.fn(async () => 0n),
  getRelayerBalance: vi.fn(async () => 10n ** 20n),
  getGasPrice: vi.fn(async () => 1_000_000_000n),
  verifyRequest: vi.fn(async () => true),
  estimateExecuteGas: vi.fn(async () => 100_000n),
  sendExecuteTransaction: vi.fn(async () => '0xabc'),
  waitForReceipt: vi.fn(async () => ({
    status: 1,
    blockNumber: 1,
    gasUsed: 100_000n,
    effectiveGasPriceWei: 1_000_000_000n,
  })),
});

/**
 * A plausible value for each param, so the "one omitted" cases differ from the
 * baseline only in the omission. These need not be VALID — a request that gets
 * past param-presence and fails on content still proves presence was checked.
 */
const SAMPLE: Record<string, string> = {
  phase: '',
  transaction: Buffer.from('not-a-real-transaction').toString('base64'),
  quoteId: '00000000-0000-4000-8000-000000000000',
  idempotencyKey: 'idem-1',
  chainId: '84532',
  from: '0x2222222222222222222222222222222222222222',
  request: Buffer.from(JSON.stringify({})).toString('base64'),
};

function paramsFor(spec: JobRequestSpec, phase: 'quote' | 'execute'): [string, string][] {
  return spec[phase].params
    .filter((p) => p.required)
    .map((p) => [p.name, p.value ?? SAMPLE[p.name] ?? 'x'] as [string, string]);
}

// ---------------------------------------------------------------------------

const CASES = [
  {
    label: 'kind:5096 solana-gas-station',
    kind: GAS_STATION_KIND,
    spec: GAS_STATION_REQUEST_SPEC,
    sourceFile: 'solana-gas-station-handler.ts',
    make: () =>
      createGasStationHandler({
        network: 'devnet',
        solanaSecretKey: new Uint8Array(64),
        loadDeps: async () => solanaDeps() as never,
        confirm: { timeoutMs: 50, intervalMs: 5 },
      }),
  },
  {
    label: 'kind:5098 evm-gas-station',
    kind: EVM_GAS_STATION_KIND,
    spec: EVM_GAS_STATION_REQUEST_SPEC,
    sourceFile: 'evm-gas-station-handler.ts',
    make: () =>
      createEvmGasStationHandler({
        chains: [
          {
            chainId: 84532,
            rpcUrl: 'https://example.invalid',
            forwarderAddress: '0x3333333333333333333333333333333333333333',
            tokenNetworkAddress: '0x4444444444444444444444444444444444444444',
            relayerPrivateKey: '0x' + '7'.repeat(64),
          },
        ],
        loadDeps: async () => evmDeps() as never,
        confirm: { timeoutMs: 50, intervalMs: 5 },
      }),
  },
] as const;

describe.each(CASES)(
  '$label — the declared spec matches the handler',
  ({ kind, spec, make, sourceFile }) => {
  it.each(['quote', 'execute'] as const)(
    'declares phase as a required param fixed to its own name (%s)',
    (phase) => {
      const phaseParam = spec[phase].params.find((p) => p.name === 'phase');
      expect(phaseParam?.required).toBe(true);
      expect(phaseParam?.value).toBe(phase);
    }
  );

  it('refuses a request with no phase at all', async () => {
    const res = await make()(ctxFor(jobEvent(kind, [])));
    expect(refused(res)).toBe(true);
  });

  it('refuses a phase it does not serve', async () => {
    const res = await make()(ctxFor(jobEvent(kind, [['phase', 'settle']])));
    expect(refused(res)).toBe(true);
  });

  it('refuses a kind it is not registered for', async () => {
    const res = await make()(ctxFor(jobEvent(kind + 1, [['phase', 'quote']])));
    expect(refused(res)).toBe(true);
  });

  // The load-bearing one: every param the spec calls required must actually be.
  for (const phase of ['quote', 'execute'] as const) {
    const required = spec[phase].params.filter((p) => p.required).map((p) => p.name);
    for (const omitted of required) {
      it(`${phase}: omitting the declared-required '${omitted}' is refused`, async () => {
        const params = paramsFor(spec, phase).filter(([name]) => name !== omitted);
        const res = await make()(ctxFor(jobEvent(kind, params)));
        expect(
          refused(res),
          `'${omitted}' is declared required for ${phase}, but the handler accepted a ` +
            `request without it — the /health spec is lying to clients`
        ).toBe(true);
      });
    }
  }

  it('declares every param the handler actually reads', () => {
    // The other direction, and the one the omit-each-required loop above
    // CANNOT catch: if a param were wrongly declared optional — or left out
    // altogether — that loop would simply skip it and pass. So read the
    // handler's own source for its `paramTag(event, 'x')` calls and require
    // each one to be declared.
    const source = readFileSync(join(__dirname, sourceFile), 'utf8');
    const read = new Set(
      [...source.matchAll(/paramTag\(event,\s*'([a-zA-Z]+)'\)/g)].map((m) => m[1]!)
    );
    expect(read.size, `found no paramTag calls in ${sourceFile}`).toBeGreaterThan(0);

    const declared = new Set([
      ...spec.quote.params.map((p) => p.name),
      ...spec.execute.params.map((p) => p.name),
    ]);
    for (const name of read) {
      expect(
        declared.has(name),
        `${sourceFile} reads ['param','${name}'] but /health never mentions it — ` +
          `a client cannot build a working request from the spec`
      ).toBe(true);
    }
    // And nothing invented: a declared param nothing reads is a client writing
    // a tag into the void.
    for (const name of declared) {
      expect(read.has(name), `the spec declares '${name}' but ${sourceFile} never reads it`).toBe(
        true
      );
      }
    });
  }
);

describe('the two specs agree on the shape of a gas job', () => {
  it('both are quote-then-execute, both keyed on phase', () => {
    for (const spec of [GAS_STATION_REQUEST_SPEC, EVM_GAS_STATION_REQUEST_SPEC]) {
      expect(Object.keys(spec).sort()).toEqual(['execute', 'quote']);
      expect(spec.quote.params[0]?.name).toBe('phase');
      expect(spec.execute.params[0]?.name).toBe('phase');
    }
  });

  it('both require quoteId and idempotencyKey to execute', () => {
    // The two facts that make execute safe to retry. Neither is optional on
    // either chain, and a client should be able to rely on that symmetry.
    for (const spec of [GAS_STATION_REQUEST_SPEC, EVM_GAS_STATION_REQUEST_SPEC]) {
      const required = spec.execute.params.filter((p) => p.required).map((p) => p.name);
      expect(required).toContain('quoteId');
      expect(required).toContain('idempotencyKey');
    }
  });

  it('every param says what to put in it', () => {
    for (const spec of [GAS_STATION_REQUEST_SPEC, EVM_GAS_STATION_REQUEST_SPEC]) {
      for (const phase of ['quote', 'execute'] as const) {
        for (const param of spec[phase].params) {
          expect(param.description.length, `${param.name} has no description`).toBeGreaterThan(20);
        }
      }
    }
  });
});

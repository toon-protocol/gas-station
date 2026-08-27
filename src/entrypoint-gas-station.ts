/**
 * The gas-station entrypoint.
 *
 * A TOON app that pays other people's gas. A peer holding no SOL can still get
 * a Solana transaction landed; a peer holding no ETH can still get an EVM
 * meta-transaction mined. It serves two NIP-90 job kinds, one per chain
 * family, and each is registered only when its key material is configured:
 *
 *   kind:5096  Solana — co-sign as fee payer and broadcast    (./solana-gas-station-handler)
 *   kind:5098  EVM    — relay an ERC-2771 forward request     (./evm-gas-station-handler)
 *
 * It is deployed BEHIND the connector, which is the payment proxy: the
 * connector terminates the payment and reverse-proxies the job to this
 * process's `POST /gas` (RouteTermination — see ./gas-station-backend and
 * `deploy/`). There is no ILP, claim or settlement logic in this process.
 *
 * Environment:
 *   NODE_NOSTR_SECRET_KEY   REQUIRED. 64-char hex — this node's Nostr
 *                           identity, reported on /health. Secret; scrubbed
 *                           from process.env after boot.
 *   HANDLER_PORT            POST /gas backend (default 3300).
 *   BLS_PORT                health endpoint (default 3400). Must differ.
 *
 *   ── kind:5096, Solana ──
 *   GAS_STATION_SOLANA_SECRET_KEY  128-char hex (64-byte Ed25519 keypair) of
 *                           the DEDICATED fee-payer wallet. Absent leaves the
 *                           kind unregistered. Secret; scrubbed after boot.
 *   SOLANA_NETWORK          devnet (default) | mainnet. Chooses the cluster
 *                           and the ar.io program ids on the whitelist.
 *                           Mainnet is explicit opt-in.
 *   SOLANA_RPC_URL          Overrides the network's public cluster RPC. The
 *                           public endpoints are rate-limited; a deployment
 *                           doing volume wants its own.
 *   GAS_STATION_CHANNEL_PROGRAM_ID  base58 program id of the TOON
 *                           payment-channel program. When set, the whitelist
 *                           additionally permits deposit/close/settle
 *                           instructions against it, so an agent can fund or
 *                           reclaim its own channel without holding SOL. Use
 *                           the `program_id` the connector in front of this
 *                           process settles against (deploy/connector.toml's
 *                           `[settlement.solana]`) — it belongs to that
 *                           deployment and rotates with it.
 *   GAS_STATION_QUOTE_TTL_MS  Raises the merged quote/blockhash deadline for a
 *                           slow client ceremony. Keep it under Solana's
 *                           blockhash validity or execute answers
 *                           `blockhash_expired`.
 *
 *   ── kind:5098, EVM ──
 *   EVM_GAS_STATION_CONFIG_JSON  JSON array of chain configs
 *                           `[{chainId, rpcUrl, forwarderAddress,
 *                           tokenNetworkAddress, relayerPrivateKey}, ...]`,
 *                           one DEDICATED relayer wallet per chain. Adding a
 *                           chain is an entry here, not a code change. Absent
 *                           leaves the kind unregistered; malformed refuses to
 *                           boot. Secret; scrubbed after boot.
 *   EVM_GAS_STATION_QUOTE_TTL_MS  Overrides the 120s quote deadline.
 *   EVM_GAS_STATION_MAX_GAS       Overrides the 300,000 gas cap per call.
 *
 *   NODE_ENV                Anything but 'production' enables devMode, which
 *                           skips event signature verification.
 *
 * A deployment with NEITHER chain configured refuses to boot. The store, where
 * these two handlers came from, treats them as optional extras beside an
 * always-on storage job; here they are the entire app, so a process with no
 * chain to serve is a misconfiguration and not a degraded mode worth running.
 *
 * Compiled by esbuild into one ESM bundle (see esbuild.config.mjs); the
 * dependency closure is installed from package.json in Dockerfile.gas-station.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { getPublicKey } from 'nostr-tools/pure';
import { getAddress, isAddress } from 'ethers';
import {
  startGasStationBackend,
  type GasStationBackend,
  type GasStationHandler,
} from './gas-station-backend.js';
import {
  SOLANA_PUBKEY_REGEX,
  type JobRequestSpec,
  type SolanaNetwork,
} from './job-params.js';
import {
  GAS_STATION_KIND,
  GAS_STATION_REQUEST_SPEC,
  createGasStationHandler,
  assertSolanaKeypair,
} from './solana-gas-station-handler.js';
import {
  EVM_GAS_STATION_KIND,
  EVM_GAS_STATION_REQUEST_SPEC,
  createEvmGasStationHandler,
  type EvmChainConfig,
} from './evm-gas-station-handler.js';

// ---------------------------------------------------------------------------
// Job counter (5-minute sliding window, surfaced on /health)
// ---------------------------------------------------------------------------

interface JobEvent {
  ts: number;
  kind: number;
  status: 'success' | 'error';
}

interface JobCounterSnapshot {
  total: number;
  byKind: { kind: number; count: number }[];
  byStatus: { processing: number; success: number; error: number; partial: number };
}

interface JobCounter {
  wrap(kind: number, handler: GasStationHandler): GasStationHandler;
  snapshot(): JobCounterSnapshot;
}

export function createJobCounter(windowMs: number = 5 * 60 * 1000): JobCounter {
  const events: JobEvent[] = [];
  let processing = 0;

  function evict() {
    const cutoff = Date.now() - windowMs;
    // Events are appended in time order, so everything older than the window
    // is a prefix of the array.
    let expired = 0;
    while (expired < events.length) {
      const event = events[expired];
      if (event === undefined || event.ts >= cutoff) break;
      expired++;
    }
    events.splice(0, expired);
  }

  function wrap(kind: number, handler: GasStationHandler): GasStationHandler {
    return async (ctx) => {
      processing++;
      try {
        const result = await handler(ctx);
        processing = Math.max(0, processing - 1);
        events.push({ ts: Date.now(), kind, status: 'success' });
        evict();
        return result;
      } catch (err) {
        processing = Math.max(0, processing - 1);
        events.push({ ts: Date.now(), kind, status: 'error' });
        evict();
        throw err;
      }
    };
  }

  function snapshot(): JobCounterSnapshot {
    evict();
    const byKindMap = new Map<number, number>();
    let success = 0;
    let error = 0;
    for (const e of events) {
      byKindMap.set(e.kind, (byKindMap.get(e.kind) ?? 0) + 1);
      if (e.status === 'success') success++;
      else error++;
    }
    const byKind = Array.from(byKindMap.entries()).map(([kind, count]) => ({ kind, count }));
    return {
      total: events.length,
      byKind,
      byStatus: { processing, success, error, partial: 0 },
    };
  }

  return { wrap, snapshot };
}

/**
 * One registered job kind, described well enough for a client to decide
 * whether this node is any use to it.
 *
 * `handlerKinds` alone answers "which kinds" but not "which chains", and for a
 * gas station that second question is the one that matters: a caller wanting a
 * Base Sepolia transaction relayed needs to know this node serves 84532
 * specifically, not merely that it speaks kind:5098. Every field here is
 * derived from what actually got registered at boot, so it cannot drift from
 * what the node will really do.
 */
export interface JobKindDescription {
  /** The NIP-90 job-request kind a client sends. */
  kind: number;
  /** The result kind its receipt is shaped as (`kind + 1000`). */
  resultKind: number;
  name: 'solana-gas-station' | 'evm-gas-station';
  /** The two phases every gas job goes through. */
  phases: ['quote', 'execute'];
  /**
   * The chains this kind will actually transact on. `solana:devnet` /
   * `solana:mainnet` for kind:5096; one `evm:<chainId>` per configured chain
   * for kind:5098.
   */
  chains: string[];
  /** Which `['param', name, value]` tags to set, per phase. */
  request: JobRequestSpec;
}

/**
 * What `GET /health` answers on BLS_PORT. Declared here rather than imported
 * from the SDK: this app depends on no TOON package at runtime, and one
 * response shape is not a reason to start.
 *
 * This doubles as the app's discovery surface. The connector in front
 * advertises how to PAY this node (`GET /ilp` — addresses, settlement,
 * prices); nothing there says what to SEND, because the connector terminates
 * a route without knowing what the app behind it accepts. So the app answers
 * that itself, here.
 */
export interface GasStationHealthResponse {
  status: 'ok';
  version: string;
  nodePubkey: string;
  uptimeSec: number;
  /**
   * How a job reaches this node, and how the answer comes back. Stated
   * because it is the one thing a client cannot infer from "NIP-90 kind:5096":
   * there is no relay round-trip here. The signed job event is POSTed to this
   * node by the connector in front, as the termination of a paid ILP packet,
   * and the receipt returns in that response — it is never published as a
   * kind:6096 event on any relay. `resultKind` below describes the SHAPE the
   * receipt takes, not an event to go looking for.
   */
  transport: {
    protocol: 'nip90-over-ilp';
    /** Set these as `['param', name, value]` tags — not NIP-90 `i` tags. */
    inputEncoding: 'param-tags';
    /** The receipt is base64 JSON in the response's `data` field. */
    resultDelivery: 'ilp-fulfill-body';
    /** A refusal is an accepted job with `status:"failed"` and a `reason`. */
    refusals: 'in-band';
  };
  /** The registered kinds, bare. Kept for callers that only want the numbers. */
  handlerKinds: number[];
  /** The same kinds, described — see {@link JobKindDescription}. */
  jobs: JobKindDescription[];
  jobsRecent: JobCounterSnapshot;
}

// ---------------------------------------------------------------------------
// Ports + identity
// ---------------------------------------------------------------------------

export interface PortConfig {
  secretKey: Uint8Array;
  handlerPort: number;
  blsPort: number;
}

/** Read the identity and the two ports. Throws on anything malformed. */
export function resolvePortConfig(env: NodeJS.ProcessEnv): PortConfig {
  const hex = env['NODE_NOSTR_SECRET_KEY']?.trim();
  if (!hex) {
    throw new Error('NODE_NOSTR_SECRET_KEY is required (64-char hex)');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('NODE_NOSTR_SECRET_KEY must be a 64-char hex string');
  }

  const port = (name: string, fallback: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const p = parseInt(raw, 10);
    if (!Number.isFinite(p) || p < 0 || p > 65535) {
      throw new Error(`${name} must be 0..65535`);
    }
    return p;
  };

  const handlerPort = port('HANDLER_PORT', 3300);
  const blsPort = port('BLS_PORT', 3400);
  if (handlerPort === blsPort) {
    throw new Error('HANDLER_PORT and BLS_PORT must differ');
  }

  return {
    secretKey: Uint8Array.from(Buffer.from(hex, 'hex')),
    handlerPort,
    blsPort,
  };
}

// ---------------------------------------------------------------------------
// kind:5096 — Solana
// ---------------------------------------------------------------------------

/** Parsed kind:5096 configuration (undefined = the kind stays unregistered). */
export interface GasStationEnvConfig {
  network: SolanaNetwork;
  solanaSecretKey: Uint8Array;
  rpcUrl?: string;
  channelProgramId?: string;
  quoteTtlMs?: number;
}

/**
 * Resolve the kind:5096 config.
 *
 * Absent or empty `GAS_STATION_SOLANA_SECRET_KEY` leaves the kind
 * unregistered; a malformed one throws. That asymmetry is deliberate — "I did
 * not configure this" and "I configured this wrong" must not look the same at
 * boot, or a typo silently ships a node that answers nothing.
 */
export function resolveGasStationEnv(
  env: NodeJS.ProcessEnv
): GasStationEnvConfig | undefined {
  const hex = env['GAS_STATION_SOLANA_SECRET_KEY']?.trim();
  if (!hex) return undefined;
  if (!/^[0-9a-fA-F]{128}$/.test(hex)) {
    throw new Error(
      'GAS_STATION_SOLANA_SECRET_KEY must be a 128-char hex string ' +
        '(64-byte Ed25519 keypair: secretKey ‖ publicKey)'
    );
  }

  const networkRaw = env['SOLANA_NETWORK']?.trim() || 'devnet';
  if (networkRaw !== 'devnet' && networkRaw !== 'mainnet') {
    throw new Error(
      `SOLANA_NETWORK must be 'devnet' or 'mainnet', got ${JSON.stringify(networkRaw)}`
    );
  }

  const channelProgramId = env['GAS_STATION_CHANNEL_PROGRAM_ID']?.trim() || undefined;
  if (channelProgramId && !SOLANA_PUBKEY_REGEX.test(channelProgramId)) {
    throw new Error(
      `GAS_STATION_CHANNEL_PROGRAM_ID must be a base58 Solana program id, got ${JSON.stringify(channelProgramId)}`
    );
  }

  const rpcUrl = env['SOLANA_RPC_URL']?.trim() || undefined;
  if (rpcUrl !== undefined) {
    let protocol: string;
    try {
      protocol = new URL(rpcUrl).protocol;
    } catch {
      throw new Error(`SOLANA_RPC_URL is not a valid URL: ${JSON.stringify(rpcUrl)}`);
    }
    if (!['http:', 'https:'].includes(protocol)) {
      throw new Error(`SOLANA_RPC_URL must be http(s), got ${JSON.stringify(rpcUrl)}`);
    }
  }

  const ttlRaw = env['GAS_STATION_QUOTE_TTL_MS']?.trim();
  let quoteTtlMs: number | undefined;
  if (ttlRaw) {
    quoteTtlMs = Number(ttlRaw);
    if (!Number.isFinite(quoteTtlMs) || quoteTtlMs <= 0) {
      throw new Error(
        `GAS_STATION_QUOTE_TTL_MS must be a positive number of milliseconds, got ${JSON.stringify(ttlRaw)}`
      );
    }
  }

  return {
    network: networkRaw,
    solanaSecretKey: Uint8Array.from(Buffer.from(hex, 'hex')),
    ...(rpcUrl ? { rpcUrl } : {}),
    ...(channelProgramId ? { channelProgramId } : {}),
    ...(quoteTtlMs !== undefined ? { quoteTtlMs } : {}),
  };
}

// ---------------------------------------------------------------------------
// kind:5098 — EVM
// ---------------------------------------------------------------------------

interface EvmGasStationRawChainConfig {
  chainId?: number;
  rpcUrl?: string;
  forwarderAddress?: string;
  tokenNetworkAddress?: string;
  relayerPrivateKey?: string;
}

/** Parsed kind:5098 configuration (undefined = the kind stays unregistered). */
export interface EvmGasStationEnvConfig {
  chains: EvmChainConfig[];
  quoteTtlMs?: number;
  maxGas?: bigint;
}

/**
 * Resolve the kind:5098 config. Same absent-vs-malformed contract as
 * {@link resolveGasStationEnv}: absent disables, malformed throws. Chain
 * portability lives here — each array entry IS a chain.
 */
export function resolveEvmGasStationEnv(
  env: NodeJS.ProcessEnv
): EvmGasStationEnvConfig | undefined {
  const raw = env['EVM_GAS_STATION_CONFIG_JSON']?.trim();
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `EVM_GAS_STATION_CONFIG_JSON is not valid JSON: ${err instanceof Error ? err.message : err}`
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      'EVM_GAS_STATION_CONFIG_JSON must be a non-empty JSON array of chain configs ' +
        '({chainId, rpcUrl, forwarderAddress, tokenNetworkAddress, relayerPrivateKey})'
    );
  }

  const seenChainIds = new Set<number>();
  const chains: EvmChainConfig[] = parsed.map((entry: unknown, i: number) => {
    const c = (entry ?? {}) as EvmGasStationRawChainConfig;
    if (typeof c.chainId !== 'number' || !Number.isInteger(c.chainId) || c.chainId <= 0) {
      throw new Error(`EVM_GAS_STATION_CONFIG_JSON[${i}].chainId must be a positive integer`);
    }
    if (seenChainIds.has(c.chainId)) {
      throw new Error(`EVM_GAS_STATION_CONFIG_JSON has a duplicate chainId ${c.chainId}`);
    }
    seenChainIds.add(c.chainId);
    if (typeof c.rpcUrl !== 'string' || !c.rpcUrl.trim()) {
      throw new Error(`EVM_GAS_STATION_CONFIG_JSON[${i}].rpcUrl must be a non-empty string`);
    }
    let protocol: string;
    try {
      protocol = new URL(c.rpcUrl).protocol;
    } catch {
      throw new Error(`EVM_GAS_STATION_CONFIG_JSON[${i}].rpcUrl is not a valid URL: ${JSON.stringify(c.rpcUrl)}`);
    }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(protocol)) {
      throw new Error(`EVM_GAS_STATION_CONFIG_JSON[${i}].rpcUrl must be http(s) or ws(s), got ${JSON.stringify(c.rpcUrl)}`);
    }
    if (typeof c.forwarderAddress !== 'string' || !isAddress(c.forwarderAddress)) {
      throw new Error(`EVM_GAS_STATION_CONFIG_JSON[${i}].forwarderAddress must be a valid EVM address`);
    }
    if (typeof c.tokenNetworkAddress !== 'string' || !isAddress(c.tokenNetworkAddress)) {
      throw new Error(`EVM_GAS_STATION_CONFIG_JSON[${i}].tokenNetworkAddress must be a valid EVM address`);
    }
    if (typeof c.relayerPrivateKey !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(c.relayerPrivateKey)) {
      throw new Error(`EVM_GAS_STATION_CONFIG_JSON[${i}].relayerPrivateKey must be a 0x-prefixed 32-byte hex secret key`);
    }
    return {
      chainId: c.chainId,
      rpcUrl: c.rpcUrl.trim(),
      forwarderAddress: getAddress(c.forwarderAddress),
      tokenNetworkAddress: getAddress(c.tokenNetworkAddress),
      relayerPrivateKey: c.relayerPrivateKey,
    };
  });

  const result: EvmGasStationEnvConfig = { chains };
  const quoteTtlRaw = env['EVM_GAS_STATION_QUOTE_TTL_MS']?.trim();
  if (quoteTtlRaw) {
    const quoteTtlMs = Number(quoteTtlRaw);
    if (!Number.isFinite(quoteTtlMs) || quoteTtlMs <= 0) {
      throw new Error(
        `EVM_GAS_STATION_QUOTE_TTL_MS must be a positive number of milliseconds, got ${JSON.stringify(quoteTtlRaw)}`
      );
    }
    result.quoteTtlMs = quoteTtlMs;
  }
  const maxGasRaw = env['EVM_GAS_STATION_MAX_GAS']?.trim();
  if (maxGasRaw) {
    let maxGas: bigint;
    try {
      maxGas = BigInt(maxGasRaw);
    } catch {
      throw new Error(
        `EVM_GAS_STATION_MAX_GAS must be an integer, got ${JSON.stringify(maxGasRaw)}`
      );
    }
    if (maxGas <= 0n) {
      throw new Error(`EVM_GAS_STATION_MAX_GAS must be positive, got ${maxGasRaw}`);
    }
    result.maxGas = maxGas;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * Build the registered handler set from the environment. Exported so a test
 * can assert which kinds a given environment produces without starting a
 * server.
 */
export function buildHandlers(
  env: NodeJS.ProcessEnv,
  counter: JobCounter
): {
  handlers: Record<number, GasStationHandler>;
  describe: string[];
  jobs: JobKindDescription[];
} {
  const handlers: Record<number, GasStationHandler> = {};
  const describe: string[] = [];
  const jobs: JobKindDescription[] = [];

  const solana = resolveGasStationEnv(env);
  if (solana) {
    handlers[GAS_STATION_KIND] = counter.wrap(
      GAS_STATION_KIND,
      createGasStationHandler({
        network: solana.network,
        solanaSecretKey: solana.solanaSecretKey,
        ...(solana.rpcUrl ? { rpcUrl: solana.rpcUrl } : {}),
        ...(solana.channelProgramId ? { channelProgramId: solana.channelProgramId } : {}),
        ...(solana.quoteTtlMs !== undefined ? { quoteTtlMs: solana.quoteTtlMs } : {}),
      })
    );
    describe.push(
      `kind:${GAS_STATION_KIND} Solana (network: ${solana.network}` +
        `${solana.channelProgramId ? `, channel program: ${solana.channelProgramId}` : ''})`
    );
    jobs.push({
      kind: GAS_STATION_KIND,
      resultKind: GAS_STATION_KIND + 1000,
      name: 'solana-gas-station',
      phases: ['quote', 'execute'],
      chains: [`solana:${solana.network}`],
      request: GAS_STATION_REQUEST_SPEC,
    });
  }

  const evm = resolveEvmGasStationEnv(env);
  if (evm) {
    handlers[EVM_GAS_STATION_KIND] = counter.wrap(
      EVM_GAS_STATION_KIND,
      createEvmGasStationHandler({
        chains: evm.chains,
        ...(evm.quoteTtlMs !== undefined ? { quoteTtlMs: evm.quoteTtlMs } : {}),
        ...(evm.maxGas !== undefined ? { policy: { maxGas: evm.maxGas } } : {}),
      })
    );
    describe.push(
      `kind:${EVM_GAS_STATION_KIND} EVM (chains: ${evm.chains.map((c) => c.chainId).join(', ')})`
    );
    jobs.push({
      kind: EVM_GAS_STATION_KIND,
      resultKind: EVM_GAS_STATION_KIND + 1000,
      name: 'evm-gas-station',
      phases: ['quote', 'execute'],
      chains: evm.chains.map((c) => `evm:${c.chainId}`),
      request: EVM_GAS_STATION_REQUEST_SPEC,
    });
  }

  if (Object.keys(handlers).length === 0) {
    throw new Error(
      'No chain is configured, so this gas station would answer nothing. Set ' +
        'GAS_STATION_SOLANA_SECRET_KEY (kind:5096), EVM_GAS_STATION_CONFIG_JSON ' +
        '(kind:5098), or both.'
    );
  }

  return { handlers, describe, jobs };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('[gas-station] starting...');

  const config = resolvePortConfig(process.env);
  const counter = createJobCounter();
  const { handlers, describe, jobs } = buildHandlers(process.env, counter);
  for (const line of describe) console.log(`[gas-station] registered ${line}`);

  // Prove the Solana key can actually sign before advertising that it will.
  // The env parser only sees 128 hex characters; whether they are a keypair is
  // a cryptographic fact, and finding it out on the first paid job is too
  // late. Also logs the fee-payer address, which is what an operator has to
  // fund and otherwise has no easy way to read off a running node.
  const solanaSecretKey = resolveGasStationEnv(process.env)?.solanaSecretKey;
  if (solanaSecretKey) {
    const feePayer = await assertSolanaKeypair(solanaSecretKey);
    console.log(`[gas-station] Solana fee payer: ${feePayer} (fund this address)`);
  }

  const handlerKinds = Object.keys(handlers)
    .map(Number)
    .sort((a, b) => a - b);

  const devMode = process.env['NODE_ENV'] !== 'production';
  if (devMode) {
    console.warn(
      '[gas-station] NODE_ENV is not "production": event signature verification is OFF'
    );
  }

  const backend: GasStationBackend = startGasStationBackend({
    handlers,
    handlerPort: config.handlerPort,
    devMode,
  });

  const pubkey = getPublicKey(config.secretKey);
  const safePubkey = typeof pubkey === 'string' ? pubkey : 'unknown';
  const startedAt = Date.now();

  const blsApp = new Hono();
  blsApp.get('/health', (c) => {
    const health: GasStationHealthResponse = {
      status: 'ok',
      version: '1.0.0',
      nodePubkey: safePubkey,
      uptimeSec: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      transport: {
        protocol: 'nip90-over-ilp',
        inputEncoding: 'param-tags',
        resultDelivery: 'ilp-fulfill-body',
        refusals: 'in-band',
      },
      handlerKinds,
      jobs,
      jobsRecent: counter.snapshot(),
    };
    return c.json(health);
  });

  const blsServer = serve({ fetch: blsApp.fetch, port: config.blsPort }) as unknown as {
    close: (cb?: (err?: Error) => void) => void;
  };

  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                    gas-station ready                      ║
╠═══════════════════════════════════════════════════════════╣
║ Pubkey:        ${safePubkey.slice(0, 32)}... ║
║ Handler port:  ${config.handlerPort} (POST /gas)                          ║
║ Health port:   ${config.blsPort} (GET /health)                        ║
║ Handler kinds: ${handlerKinds.join(', ')}                                ║
╚═══════════════════════════════════════════════════════════╝
  `);

  // The key material has been read into memory; leaving a copy in the
  // environment only widens where it can leak from (a child process, a crash
  // dump, an accidental env log).
  delete process.env['NODE_NOSTR_SECRET_KEY'];
  delete process.env['GAS_STATION_SOLANA_SECRET_KEY'];
  delete process.env['EVM_GAS_STATION_CONFIG_JSON'];

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[gas-station] received ${signal}, shutting down...`);
    try {
      await new Promise<void>((resolve, reject) => {
        blsServer.close((err) => (err ? reject(err) : resolve()));
      });
      await new Promise<void>((resolve, reject) => {
        backend.close((err) => (err ? reject(err) : resolve()));
      });
      console.log('[gas-station] stopped gracefully');
    } catch (err) {
      console.error('[gas-station] error during shutdown:', err);
    } finally {
      process.exit(0);
    }
  };

  process.off('SIGTERM', shutdown);
  process.off('SIGINT', shutdown);
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Gated so importing this module from a test does not start a server — tests
// drive the exported functions directly.
if (!process.env['VITEST']) {
  main().catch((err) => {
    console.error(`[gas-station] [fatal] ${err instanceof Error ? err.message : err}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  });
}

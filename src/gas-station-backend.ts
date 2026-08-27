/**
 * The payment-oblivious HTTP backend: `POST /gas`.
 *
 * The connector runs in FRONT of this process as the payment proxy. It
 * terminates the payment on-chain — verifies the claim, meters it, records the
 * watermark — and then reverse-proxies a LITERAL HTTP request here
 * (RouteTermination), injecting `X-TOON-Payer` / `X-TOON-Amount` /
 * `X-TOON-Chain` as trusted headers. By the time a request arrives at this
 * surface the payment is ALREADY proven, so there is no ILP, claim or
 * settlement logic here and there must never be any: claim validation lives
 * only in the connector, and a second implementation of it would be a second
 * thing to get wrong.
 *
 * The connector serializes whatever comes back into the ILP FULFILL `data` —
 * including on a 5xx, so a caller always observes the body.
 *
 * DISPATCH IS BY KIND, WITH NO DEFAULT. Unlike the store — which has one
 * always-on job (kind:5094) and treats it as the fallback for anything
 * unrecognized — every kind this app serves is optional and independently
 * configured, so there is no sensible handler for a kind nobody registered.
 * An unregistered kind is a malformed request (F00), not a job.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { verifyEvent } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';

/**
 * Structural mirror of the SDK's `HandlerContext` / `HandlerResponse`.
 *
 * Declared here rather than imported so this app does not pin a
 * `@toon-protocol/sdk` version for two type aliases. The shapes match
 * `@toon-protocol/core`'s `HandlePacket{Accept,Reject}Response`.
 */
export interface GasStationHandlerContext {
  readonly toon: string;
  readonly kind: number;
  readonly pubkey: string;
  readonly amount: bigint;
  readonly destination: string;
  decode(): NostrEvent;
  accept(metadata?: Record<string, unknown>): {
    accept: true;
    data?: string;
    metadata?: Record<string, unknown>;
  };
  reject(code: string, message: string): { accept: false; code: string; message: string };
}

export type GasStationHandlerResponse =
  | { accept: true; data?: string; metadata?: Record<string, unknown> }
  | { accept: false; code: string; message: string; metadata?: Record<string, unknown> };

export type GasStationHandler = (
  ctx: GasStationHandlerContext
) => Promise<GasStationHandlerResponse>;

export interface GasStationBackendConfig {
  /**
   * Per-kind handlers. Dispatch is by the event's `kind` and there is no
   * fallback — see the note at the top of this file.
   */
  handlers: Record<number, GasStationHandler>;
  /** Plain-HTTP job port. The connector route's `handler_url` points here. */
  handlerPort: number;
  /** Skip Schnorr signature verification (smoke tests only). */
  devMode: boolean;
}

export interface GasStationBackend {
  close(cb?: (err?: Error) => void): void;
}

function safeBigInt(s: string): bigint {
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

/**
 * Start the job backend on `handlerPort`.
 *
 *   GET  /health   liveness on the job port (the richer health is on BLS_PORT)
 *   POST /gas      `{ event }` (a signed kind:5096 / kind:5098) -> `{ accept, result }`
 */
export function startGasStationBackend(
  config: GasStationBackendConfig
): GasStationBackend {
  const app = new Hono();

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.post('/gas', async (c) => {
    // A non-object body (`null`, a bare `5`) is still valid JSON, so the parse
    // does not throw — guard the shape before dereferencing `.event`, or
    // `null.event` escapes as a framework-level 500.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    if (body === null || typeof body !== 'object') {
      return c.json({ accept: false, code: 'F00', message: 'Invalid request body' }, 422);
    }
    const event = (body as { event?: NostrEvent }).event;
    if (!event) {
      return c.json({ accept: false, code: 'F00', message: 'Missing required field: event' }, 422);
    }

    // Trusted payment headers, captured for the log line. NOT validated here —
    // the connector already did, and re-deriving them would be a second source
    // of truth for a fact this process is not the authority on.
    const payer = c.req.header('X-TOON-Payer');
    const amount = c.req.header('X-TOON-Amount');
    const chain = c.req.header('X-TOON-Chain');

    // Integrity only: proves the event was not altered in transit. It is not
    // an authorization check — payment already authorized the request.
    if (!config.devMode && !verifyEvent(event)) {
      return c.json({ accept: false, code: 'F00', message: 'Invalid event signature' }, 422);
    }

    const handle = config.handlers[event.kind];
    if (!handle) {
      const registered = Object.keys(config.handlers).join(', ') || 'none';
      console.warn(
        `[gas-station] kind:${event.kind} rejected: no handler registered (registered kinds: ${registered})`
      );
      return c.json(
        {
          accept: false,
          code: 'F00',
          message:
            `No handler registered for kind:${event.kind}. ` +
            `This deployment serves: ${registered}.`,
        },
        422
      );
    }

    const ctx: GasStationHandlerContext = {
      toon: '',
      kind: event.kind,
      pubkey: event.pubkey,
      amount: amount ? safeBigInt(amount) : 0n,
      destination: 'g.toon.gas',
      decode: () => event,
      accept: (metadata) => ({ accept: true, ...(metadata ? { metadata } : {}) }),
      reject: (code, message) => ({ accept: false, code, message }),
    };

    let res: GasStationHandlerResponse;
    try {
      res = await handle(ctx);
    } catch (err) {
      console.error(
        '[gas-station] handler threw:',
        err instanceof Error ? (err.stack ?? err.message) : err
      );
      return c.json({ accept: false, code: 'T00', message: 'Internal handler error' }, 502);
    }

    if (res.accept) {
      // Handlers return `data = base64(JSON receipt)`. Decode it into `result`
      // for a readable response while echoing the base64 for byte-faithful
      // clients.
      const decoded = res.data
        ? Buffer.from(res.data, 'base64').toString('utf8')
        : undefined;
      let result: Record<string, unknown> | undefined;
      if (decoded !== undefined) {
        try {
          const parsed: unknown = JSON.parse(decoded);
          if (parsed !== null && typeof parsed === 'object') {
            result = parsed as Record<string, unknown>;
          }
        } catch {
          // A handler that did not return JSON is a bug, but not a reason to
          // drop the payload — it still rides out in `data`.
        }
      }
      console.log(
        `[gas-station] kind:${event.kind} id=${event.id} payer=${payer ?? '-'} ` +
          `amount=${amount ?? '-'} chain=${chain ?? '-'} -> ${decoded ?? '(no data)'}`
      );
      return c.json(
        {
          accept: true,
          ...(result !== undefined ? { result } : {}),
          data: res.data,
          payer,
          amount,
          chain,
        },
        200
      );
    }

    // F00 (malformed request) -> 422; anything else -> 502.
    console.warn(
      `[gas-station] kind:${event.kind} id=${event.id} rejected: ${res.code} ${res.message}`
    );
    return c.json(
      { accept: false, code: res.code, message: res.message },
      res.code === 'F00' ? 422 : 502
    );
  });

  return serve({ fetch: app.fetch, port: config.handlerPort }) as unknown as GasStationBackend;
}

/**
 * Unit tests for the `POST /gas` request-validation surface.
 *
 * Infra-free: the backend is started on an ephemeral port (`handlerPort: 0`)
 * in `devMode` (no signature verification) and driven with `fetch` — no
 * network, no chain, no keys. The handlers are stubs and must not run for a
 * malformed body.
 *
 * Two properties worth stating outright, because both are easy to regress:
 *
 *   * A non-object JSON body (`null`, a bare number) is VALID JSON, so
 *     `c.req.json()` does not throw. The shape guard has to catch it, or
 *     `null.event` escapes as a framework-level 500.
 *   * An unregistered kind is a 422, not a 500 and not a silent success.
 *     This app has no default handler on purpose — every kind it serves is
 *     independently configured, so "kind nobody registered" is a malformed
 *     request, and the answer should say which kinds this deployment does
 *     serve.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  startGasStationBackend,
  type GasStationHandler,
} from './gas-station-backend.js';

/** Start the backend, run against its ephemeral port, then close it. */
async function withBackend(
  handlers: Record<number, GasStationHandler>,
  run: (url: string) => Promise<void>
): Promise<void> {
  const backend = startGasStationBackend({ handlers, handlerPort: 0, devMode: true });
  const address = (backend as unknown as { address(): { port: number } }).address();
  const url = `http://127.0.0.1:${address.port}/gas`;
  try {
    await run(url);
  } finally {
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  }
}

/** A minimal unsigned event — devMode skips verification. */
function event(kind: number): Record<string, unknown> {
  return {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: 0,
    kind,
    tags: [],
    content: '',
    sig: 'c'.repeat(128),
  };
}

const neverCalled = (): GasStationHandler =>
  vi.fn(async (ctx) => ctx.reject('F00', 'should not be called'));

describe('POST /gas request-body validation', () => {
  it.each([
    ['null', 'null'],
    ['a bare number', '5'],
    ['a bare string', '"x"'],
  ])('returns 422 F00 for %s body (never a 500 / uncaught throw)', async (_label, rawBody) => {
    const handle = neverCalled();
    await withBackend({ 5096: handle }, async (url) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: rawBody,
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { accept: boolean; code: string };
      expect(body.accept).toBe(false);
      expect(body.code).toBe('F00');
      expect(handle).not.toHaveBeenCalled();
    });
  });

  it('returns 422 F00 for a well-formed object missing `event`', async () => {
    const handle = neverCalled();
    await withBackend({ 5096: handle }, async (url) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notEvent: true }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe('F00');
      expect(handle).not.toHaveBeenCalled();
    });
  });
});

describe('POST /gas dispatch', () => {
  it('routes an event to the handler registered for its kind', async () => {
    const solana: GasStationHandler = vi.fn(async () => ({
      accept: true as const,
      data: Buffer.from(JSON.stringify({ job: 'gas-station' }), 'utf8').toString('base64'),
    }));
    const evm = neverCalled();
    await withBackend({ 5096: solana, 5098: evm }, async (url) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: event(5096) }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { accept: boolean; result: { job: string } };
      expect(body.accept).toBe(true);
      expect(body.result.job).toBe('gas-station');
      expect(solana).toHaveBeenCalledOnce();
      expect(evm).not.toHaveBeenCalled();
    });
  });

  it('answers 422 naming the registered kinds when nothing handles this one', async () => {
    const solana = neverCalled();
    await withBackend({ 5096: solana }, async (url) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: event(5098) }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe('F00');
      // The message has to say what this deployment DOES serve — a caller
      // hitting a node with only one chain configured needs to know that from
      // the response, not from the operator.
      expect(body.message).toContain('5098');
      expect(body.message).toContain('5096');
      expect(solana).not.toHaveBeenCalled();
    });
  });

  it('turns a throwing handler into 502 T00, not a stack trace', async () => {
    const boom: GasStationHandler = vi.fn(async () => {
      throw new Error('rpc exploded');
    });
    await withBackend({ 5096: boom }, async (url) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: event(5096) }),
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe('T00');
      expect(body.message).not.toContain('rpc exploded');
    });
  });

  it('echoes the connector-injected payment headers back for the caller to see', async () => {
    const handle: GasStationHandler = vi.fn(async () => ({ accept: true as const }));
    await withBackend({ 5096: handle }, async (url) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-TOON-Payer': 'g.toon.client',
          'X-TOON-Amount': '1000',
          'X-TOON-Chain': 'evm:84532',
        },
        body: JSON.stringify({ event: event(5096) }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { payer: string; amount: string; chain: string };
      expect(body).toMatchObject({
        payer: 'g.toon.client',
        amount: '1000',
        chain: 'evm:84532',
      });
    });
  });

  it('hands the handler the amount from the header as a bigint', async () => {
    let seen: bigint | undefined;
    const handle: GasStationHandler = vi.fn(async (ctx) => {
      seen = ctx.amount;
      return { accept: true as const };
    });
    await withBackend({ 5096: handle }, async (url) => {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-TOON-Amount': '4200' },
        body: JSON.stringify({ event: event(5096) }),
      });
    });
    expect(seen).toBe(4200n);
  });
});

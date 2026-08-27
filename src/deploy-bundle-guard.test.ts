/**
 * The deploy bundle has to stay internally consistent, and nothing else checks
 * it: `deploy/` is shell, TOML and YAML that only ever runs on a box, so a
 * rename here and a stale reference there would be found by an operator at 2am
 * rather than by CI.
 *
 * These tests read the committed templates and assert the facts that MUST
 * agree across files — the route the connector terminates and the port the app
 * listens on, the hostnames nginx serves and the ones the certificate covers,
 * which ports are published and which are not, and which connector schema the
 * config is written against.
 *
 * They deliberately do NOT re-verify on-chain addresses against a live chain.
 * That would make CI depend on an RPC, and the addresses are pinned here as
 * literals precisely so a change to one is a diff somebody reads.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relativePath: string): string =>
  readFileSync(`${repoRoot}${relativePath}`, 'utf8');

// ── The facts, in one place ─────────────────────────────────────────────────

/** The ILP prefix this app is sold under. One name for one app. */
const ROUTE_PREFIX = 'g.toon.gas';
/** Where the connector delivers a paid job. The `/gas` path is load-bearing. */
const HANDLER_URL = 'http://gas-station:3300/gas';
/** 0.001 USDC in the smallest unit of a 6-decimal asset. */
const ROUTE_PRICE = 1000;
/** The app's two ports. Neither may ever be host-published. */
const PRIVATE_PORTS = ['3300', '3400'];
/** Base Sepolia's ERC-2771 TokenNetworkRegistry and the fleet's USDC. */
const EXPECTED_REGISTRY = '0x8263BdD4eB4862395Cb4ef5dA5d637F4b047Eea1';
const EXPECTED_TOKEN = '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce';
/** ADR 0010: 6-decimal USDC everywhere. */
const EXPECTED_DECIMALS = 6;
/** The Solana payment-channel program the connector settles against. */
const SOLANA_PROGRAM_ID = '2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip';

const connectorTemplate = read('deploy/connector.toml.template');
const renderScript = read('deploy/render.sh');
const nginxTemplate = read('deploy/nginx/node.conf.template');
const envExample = read('deploy/.env.example');
const bootstrapScript = read('deploy/bootstrap.sh');
const letsencryptScript = read('deploy/init-letsencrypt.sh');

/**
 * The template carries `${OPERATOR_*}` placeholders that are not valid TOML
 * values on their own — they are quoted strings, so they parse fine. Parse the
 * template directly rather than rendering, so this test needs no shell.
 */
interface ConnectorConfig {
  client_edge_addr: string;
  state_dir: string;
  routes: { prefix: string; handler_url: string; price: number }[];
  settlement: {
    evm: { contract_address: string; token_address: string; decimals: number };
  };
  operator: { bearer_token: string; write_keys: string[] };
}

const connector = parseToml(connectorTemplate) as unknown as ConnectorConfig;

interface ComposeService {
  image?: string;
  ports?: (string | number)[];
  expose?: (string | number)[];
  environment?: Record<string, string>;
  labels?: Record<string, string>;
  profiles?: string[];
}
const compose = parseYaml(read('deploy/docker-compose.yml')) as unknown as {
  services: Record<string, ComposeService>;
};

// ── The route ───────────────────────────────────────────────────────────────

describe('the route the connector sells', () => {
  it('terminates exactly one prefix', () => {
    expect(connector.routes.map((r) => r.prefix)).toEqual([ROUTE_PREFIX]);
  });

  it('delivers to the app at its job path', () => {
    // A bare origin comes back F99 "app declined the delivery with HTTP 404" —
    // the app serves POST /gas and nothing at /.
    expect(connector.routes[0]?.handler_url).toBe(HANDLER_URL);
  });

  it('is priced, not free', () => {
    // `price` is REQUIRED on a terminated route; write 0 deliberately if free
    // is what you mean. A gas station spends real value per job, so it is not.
    expect(connector.routes[0]?.price).toBe(ROUTE_PRICE);
    expect(connector.routes[0]?.price).toBeGreaterThan(0);
  });

  it('names the same service and port the compose file defines', () => {
    const url = new URL(connector.routes[0]?.handler_url ?? '');
    expect(Object.keys(compose.services)).toContain(url.hostname);
    expect(compose.services[url.hostname]?.expose?.map(String)).toContain(url.port);
  });
});

// ── Settlement ──────────────────────────────────────────────────────────────

describe('settlement', () => {
  it('points EVM at the live registry, token and decimals', () => {
    expect(connector.settlement.evm.contract_address).toBe(EXPECTED_REGISTRY);
    expect(connector.settlement.evm.token_address).toBe(EXPECTED_TOKEN);
    expect(connector.settlement.evm.decimals).toBe(EXPECTED_DECIMALS);
  });

  it('keeps the Solana table out of the template, where render.sh appends it', () => {
    // Not an accident and not a TODO: an unfunded Solana settlement key is a
    // refuse-to-start (startup simulates a transaction), so the table is
    // opt-in once the key holds SOL. Both halves of that have to stay true.
    expect(connectorTemplate).not.toMatch(/^\[settlement\.solana\]/m);
    expect(renderScript).toMatch(/SETTLEMENT_SOLANA/);
    expect(renderScript).toContain(SOLANA_PROGRAM_ID);
  });

  it('explains in the template why the Solana table is not there', () => {
    expect(connectorTemplate).toMatch(/settlement\.solana.*APPENDED by \.\/render\.sh/s);
  });
});

// ── The connector schema this bundle targets ────────────────────────────────

describe('the pinned connector schema', () => {
  it('uses the [announce]/inline-[operator] spelling, not the newer one', () => {
    // docker-compose pins `:rust-release`. On that build the announce section
    // is `[announce]` and the operator secrets are inline; both change when
    // the fleet promotes (connector#1165 / #1017). If this bundle is moved to
    // a newer tag, these assertions are the checklist.
    expect(connector.operator.bearer_token).toBe('${OPERATOR_BEARER_TOKEN}');
    expect(connector.operator.write_keys).toEqual(['${OPERATOR_WRITE_KEY}']);
    // As a live KEY, not as prose — the migration note below mentions the
    // newer spelling on purpose.
    expect(connectorTemplate).not.toMatch(/^\s*bearer_token_file\s*=/m);
    expect(renderScript).toMatch(/\[announce\]/);
    expect(renderScript).not.toMatch(/^\[node\]/m);
  });

  it('says out loud which tag it targets and what changes when that moves', () => {
    expect(connectorTemplate).toMatch(/targets `:rust-release`/);
    expect(connectorTemplate).toMatch(/\[node\]/);
    expect(connectorTemplate).toMatch(/bearer_token_file/);
  });

  it('runs the same connector image for the connector and the announce sidecar', () => {
    // They share connector.toml, so an older binary would refuse a config the
    // newer one wrote. Both must move together — hence both Watchtower labels.
    const image = compose.services['connector']?.image;
    expect(image).toBe('ghcr.io/toon-protocol/connector:rust-release');
    expect(compose.services['announce']?.image).toBe(image);
  });
});

// ── The privacy invariant ───────────────────────────────────────────────────

describe('what is reachable from off-box', () => {
  const published = Object.entries(compose.services).flatMap(([name, service]) =>
    (service.ports ?? []).map((entry) => ({ name, entry: String(entry) }))
  );

  it('publishes only nginx (80/443) and the connector on loopback', () => {
    expect(published.map((p) => `${p.name}:${p.entry}`).sort()).toEqual([
      'connector:127.0.0.1:4000:4000',
      'nginx:443:443',
      'nginx:80:80',
    ]);
  });

  it('never host-publishes the app', () => {
    // Docker's `ports:` writes iptables rules AHEAD of ufw, so a published
    // port is internet-reachable no matter what `ufw status` says. The answer
    // is not to add a firewall rule — it is to not publish the port.
    const appService = compose.services['gas-station'];
    expect(appService?.ports).toBeUndefined();
    for (const port of PRIVATE_PORTS) {
      expect(appService?.expose?.map(String)).toContain(port);
    }
    for (const { entry } of published) {
      expect(PRIVATE_PORTS).not.toContain(entry.split(':').pop());
    }
  });

  it('binds the connector edge to loopback, never all interfaces', () => {
    const entry = compose.services['connector']?.ports?.map(String)[0] ?? '';
    const segments = entry.split(':');
    expect(segments).toHaveLength(3);
    expect(['', '0.0.0.0']).not.toContain(segments[0]);
  });

  it('gives nginx no route to the app job port', () => {
    // The health port is served publicly; POST /gas is not. A public path to
    // the job backend would be a free door: signed transactions and paid gas,
    // for nothing.
    expect(nginxTemplate).toContain('gas-station:3400');
    expect(nginxTemplate).not.toContain('gas-station:3300');
  });
});

// ── Hostnames ───────────────────────────────────────────────────────────────

describe('hostnames agree across nginx, the certificate and .env.example', () => {
  const hosts = ['proxy.gas.${DOMAIN}', 'gas.${DOMAIN}'];

  it('nginx serves both names', () => {
    for (const host of hosts) {
      expect(nginxTemplate).toContain(host);
    }
  });

  it('the certificate covers both names', () => {
    expect(letsencryptScript).toMatch(/DOMAINS=\("proxy\.gas\.\$\{DOMAIN\}" "gas\.\$\{DOMAIN\}"\)/);
  });

  it('the certificate lineage defaults to the primary name in both scripts', () => {
    expect(renderScript).toMatch(/CERT_NAME:=proxy\.gas\.\$\{DOMAIN\}/);
    expect(letsencryptScript).toMatch(/PRIMARY="proxy\.gas\.\$\{DOMAIN\}"/);
  });

  it('.env.example tells the operator which A-records to point here', () => {
    for (const host of hosts) {
      expect(envExample).toContain(host);
    }
  });

  it('the announce endpoints use the public names, not the container address', () => {
    // Inside the container the node only ever sees 0.0.0.0:4000; these are the
    // facts it cannot introspect, which is the whole reason the section exists.
    expect(renderScript).toMatch(/http_endpoint\s*=\s*"https:\/\/proxy\.gas\./);
    expect(renderScript).toMatch(/btp_endpoint\s*=\s*"wss:\/\/proxy\.gas\./);
    expect(renderScript).toMatch(/addresses\s*=\s*\["g\.toon\.gas"\]/);
  });
});

// ── Rendering and secrets ───────────────────────────────────────────────────

describe('rendering', () => {
  it('renders every placeholder the template contains', () => {
    const placeholders = new Set(
      [...connectorTemplate.matchAll(/\$\{([A-Z_]+)\}/g)].map((m) => m[1])
    );
    const substituted = renderScript.match(/envsubst '([^']+)'/)?.[1] ?? '';
    for (const name of placeholders) {
      expect(substituted, `render.sh does not substitute \${${name}}`).toContain(
        `\${${name}}`
      );
    }
  });

  it('writes the rendered config 0600 and hands it to the container uid', () => {
    // It carries the operator bearer token inline, so it is a secret; and the
    // container runs as uid 10001, so a root-owned 0600 file is unreadable to
    // it — "Permission denied", then a restart loop.
    expect(renderScript).toMatch(/chmod 600 connector\.toml/);
    expect(renderScript).toMatch(/chown "\$\{CONNECTOR_UID:-10001\}/);
  });

  it('keeps every rendered file and every secret out of git', () => {
    const ignored = read('deploy/.gitignore');
    for (const entry of ['.env', 'connector.toml', 'nginx/conf.d/', '*.key', '*.secret']) {
      expect(ignored).toContain(entry);
    }
  });

  it('commits only templates — no rendered output is tracked', () => {
    expect(() => read('deploy/connector.toml')).toThrow();
    expect(() => read('deploy/nginx/conf.d/node.conf')).toThrow();
  });
});

// ── The app's own configuration ─────────────────────────────────────────────

describe('the app service', () => {
  const app = () => compose.services['gas-station'];

  it('follows the moving :release tag that Watchtower watches', () => {
    expect(app()?.image).toBe('ghcr.io/toon-protocol/gas-station:release');
    expect(app()?.labels?.['com.centurylinklabs.watchtower.enable']).toBe('true');
  });

  it('leaves nginx and certbot out of Watchtower', () => {
    // nginx holds the resolver that lets everything else survive being
    // recreated at a new address; it should outlive them, not be recreated on
    // an upstream push nobody reviewed.
    for (const name of ['nginx', 'certbot', 'watchtower']) {
      expect(compose.services[name]?.labels?.['com.centurylinklabs.watchtower.enable']).toBeUndefined();
    }
  });

  it('requires the identity and passes both chains through', () => {
    const env = app()?.environment ?? {};
    expect(env['NODE_NOSTR_SECRET_KEY']).toMatch(/GAS_STATION_NOSTR_SECRET_KEY:\?/);
    for (const key of [
      'GAS_STATION_SOLANA_SECRET_KEY',
      'SOLANA_NETWORK',
      'GAS_STATION_CHANNEL_PROGRAM_ID',
      'EVM_GAS_STATION_CONFIG_JSON',
    ]) {
      expect(Object.values(env).join(' ')).toContain(key);
    }
  });

  it('every variable the app reads is documented in .env.example', () => {
    const env = app()?.environment ?? {};
    const referenced = [...JSON.stringify(env).matchAll(/\$\{([A-Z_]+)/g)].map((m) => m[1]);
    for (const name of referenced) {
      if (name === 'LOG_LEVEL') continue;
      expect(envExample, `${name} is passed through but undocumented`).toContain(name);
    }
  });

  it('keeps the announce sidecar behind a profile', () => {
    // Publishing an announce is a PAID write needing a funded channel. A box
    // without one is reachable and serving, just not listed — that must not be
    // a crash-looping container.
    expect(compose.services['announce']?.profiles).toEqual(['announce']);
  });
});

// ── Bootstrap ───────────────────────────────────────────────────────────────

describe('bootstrap', () => {
  it('firewalls the box before installing anything that can fail', () => {
    const firewallAt = bootstrapScript.indexOf('ufw --force enable');
    const dockerAt = bootstrapScript.indexOf('get.docker.com');
    expect(firewallAt).toBeGreaterThan(-1);
    expect(dockerAt).toBeGreaterThan(firewallAt);
  });

  it('generates the connector key files before starting anything', () => {
    const keysAt = bootstrapScript.indexOf('openssl rand -hex 32 > "$f"');
    const upAt = bootstrapScript.indexOf('docker compose up -d');
    expect(keysAt).toBeGreaterThan(-1);
    expect(upAt).toBeGreaterThan(keysAt);
  });

  it('hands the key files to the container uid', () => {
    expect(bootstrapScript).toMatch(/chown 10001:10001 "\$f"/);
  });

  it('generates every key file the compose file mounts', () => {
    const mounted = [
      ...JSON.stringify(compose.services['connector']?.['volumes' as keyof ComposeService] ?? [])
        .matchAll(/\.\/([a-z-]+\.key)/g),
    ].map((m) => m[1]);
    expect(mounted.length).toBeGreaterThan(0);
    for (const file of mounted) {
      expect(bootstrapScript, `${file} is mounted but never generated`).toContain(file);
    }
  });
});

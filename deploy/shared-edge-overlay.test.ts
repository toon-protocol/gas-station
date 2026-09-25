/**
 * The shared-edge overlay (docker-compose.shared-edge.yml, TOON_Network#28,
 * infra#24, infra ADR 0001) has to do exactly what its own header comment and
 * deploy/README.md § "Running behind the shared edge" claim, and nothing it
 * changes may leak into the plain bundle nobody has opted into yet.
 *
 * `docker compose config` is the oracle throughout: it merges and interpolates
 * the compose files exactly the way `docker compose up -d` would, without
 * needing a reachable docker daemon (confirmed against DOCKER_HOST pointing
 * at a socket that does not exist -- `config` never dials it), so these tests
 * need only the `docker` CLI on PATH, the same as the connector-adoption
 * workflow already assumes in CI.
 */
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll } from 'vitest';
import { parse as parseYaml } from 'yaml';

const DEPLOY_DIR = dirname(fileURLToPath(import.meta.url));

interface ComposeService {
  image?: string;
  ports?: { published?: string | number; target?: string | number }[];
  expose?: (string | number)[];
  mem_limit?: string | number;
  profiles?: string[];
  networks?: Record<string, { aliases?: string[] } | null>;
}
interface ComposeConfig {
  services: Record<string, ComposeService>;
  networks?: Record<string, { external?: boolean; name?: string } | null>;
}

const REQUIRED_ENV = {
  // docker-compose.yml requires this with `:?` -- config fails to interpolate
  // without it, on the base file and the overlay alike.
  GAS_STATION_NOSTR_SECRET_KEY:
    '1111111111111111111111111111111111111111111111111111111111111111',
};

function composeConfig(files: string[], extraArgs: string[] = []): ComposeConfig {
  const args = files.flatMap((f) => ['-f', f]).concat(extraArgs, ['config']);
  const result = spawnSync('docker', ['compose', ...args], {
    cwd: DEPLOY_DIR,
    encoding: 'utf8',
    env: { ...process.env, ...REQUIRED_ENV },
  });
  if (result.status !== 0) {
    throw new Error(
      `docker compose ${args.join(' ')} failed (${result.status}):\n${result.stderr}`
    );
  }
  return parseYaml(result.stdout) as ComposeConfig;
}

let dockerAvailable = true;
beforeAll(() => {
  const probe = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  dockerAvailable = probe.status === 0;
  if (!dockerAvailable) {
    console.warn(
      'docker (with the compose plugin) is not on PATH -- skipping shared-edge overlay tests.'
    );
  }
});

const maybe = () => (dockerAvailable ? it : it.skip);

describe('the default bundle, without the overlay', () => {
  it('is what docker-compose.yml alone renders, unaffected by the overlay file existing on disk', () => {
    if (!dockerAvailable) return;
    const base = composeConfig(['docker-compose.yml']);

    // Every one of today's five services, none dropped by a stray `profiles:`.
    expect(Object.keys(base.services).sort()).toEqual(
      ['certbot', 'connector', 'gas-station', 'nginx', 'watchtower'].sort()
    );

    // nginx still owns the only public ports.
    const nginxPorts = (base.services.nginx?.ports ?? []).map((p) => String(p.published));
    expect(nginxPorts.sort()).toEqual(['443', '80']);

    // No service carries a mem_limit yet -- that is the overlay's addition,
    // not the base bundle's.
    for (const [name, service] of Object.entries(base.services)) {
      expect(service.mem_limit, `${name} should have no mem_limit without the overlay`).toBeUndefined();
    }

    // No `edge-gas` network exists at all without the overlay.
    expect(base.networks?.['edge-gas']).toBeUndefined();
    for (const [name, service] of Object.entries(base.services)) {
      expect(
        service.networks ?? {},
        `${name} should not know about an edge network without the overlay`
      ).not.toHaveProperty('edge-gas');
    }
  });
});

describe('the shared-edge overlay, applied the way COMPOSE_FILE turns it on', () => {
  const files = ['docker-compose.yml', 'docker-compose.shared-edge.yml'];

  maybe()('disables nginx, certbot and watchtower, and binds no host port 80 or 443', () => {
    const merged = composeConfig(files);

    // `docker compose config` (like `up`) leaves out a service whose profile
    // was never activated -- which IS the disabling.
    expect(Object.keys(merged.services).sort()).toEqual(['connector', 'gas-station'].sort());

    const everyPublished = Object.values(merged.services).flatMap((s) =>
      (s.ports ?? []).map((p) => String(p.published))
    );
    expect(everyPublished).not.toContain('80');
    expect(everyPublished).not.toContain('443');
  });

  maybe()('still disables them even when their profile is asked for explicitly -- they are `profiles: [disabled]`, not merely dropped', () => {
    // Prove the three ARE still defined (mem_limit and all), just gated behind
    // a profile nothing in this repo ever activates -- not accidentally
    // deleted by the overlay, which would look identical from the test above
    // alone.
    const withDisabled = composeConfig(files, ['--profile', 'disabled']);
    for (const name of ['nginx', 'certbot', 'watchtower']) {
      expect(withDisabled.services[name]?.profiles).toEqual(['disabled']);
    }
  });

  maybe()('joins connector and gas-station to the external `edge-gas` network under the contract aliases', () => {
    const merged = composeConfig(files);

    expect(merged.networks?.['edge-gas']).toMatchObject({ external: true });

    // proxy.gas.${DOMAIN} -> connector:4000, under alias gas-proxy.
    expect(merged.services.connector?.networks?.['edge-gas']?.aliases).toEqual(['gas-proxy']);
    // gas.${DOMAIN} -> gas-station:3400, under alias gas-web.
    expect(merged.services['gas-station']?.networks?.['edge-gas']?.aliases).toEqual(['gas-web']);

    // Neither service lost the implicit default network it needs to reach the
    // other one over (the connector proxies to gas-station:3300/3400 there).
    expect(merged.services.connector?.networks).toHaveProperty('default');
    expect(merged.services['gas-station']?.networks).toHaveProperty('default');
  });

  maybe()('joins ONLY this node\'s own `edge-gas` network, never the flat `edge` name shared-contract v2 retired', () => {
    // Shared contract v2: one fixed-named network per node (edge-relay,
    // edge-store, edge-gas, edge-gateway, edge-faucet), not one flat network
    // every node's containers share -- a flat network let any node reach any
    // other node's connector /admin or the gateway's handover port.
    const merged = composeConfig(files);
    expect(merged.networks?.edge).toBeUndefined();
    for (const [name, service] of Object.entries(merged.services)) {
      expect(
        service.networks ?? {},
        `${name} must not join the old flat 'edge' network`
      ).not.toHaveProperty('edge');
    }
  });

  maybe()('never aliases or exposes the job door, :3300, on the edge network', () => {
    const merged = composeConfig(files);
    const app = merged.services['gas-station'];
    // The health port is what the edge is aliased to serve; the job door is
    // still reached only by the connector, over the compose network -- see
    // README.md "Privacy invariant".
    expect(app?.expose?.map(String)).toContain('3300');
    expect(app?.networks?.['edge-gas']?.aliases).not.toContain('gas-station');
  });

  maybe()('gives every service in the bundle a mem_limit, active or disabled', () => {
    // `--profile disabled` is what makes docker compose config even print the
    // three disabled services -- the default `config` run above (correctly)
    // omits them entirely, the same as `up -d` would.
    const withDisabled = composeConfig(files, ['--profile', 'disabled']);
    for (const [name, service] of Object.entries(withDisabled.services)) {
      expect(service.mem_limit, `${name} has no mem_limit`).toBeTruthy();
      expect(Number(service.mem_limit)).toBeGreaterThan(0);
    }
  });

  maybe()('still keeps the connector reachable on loopback for bootstrap.sh and auto-apply.sh', () => {
    const merged = composeConfig(files);
    const connectorPorts = merged.services.connector?.ports ?? [];
    expect(connectorPorts.map((p) => String(p.published))).toContain('4000');
  });
});

# gas-station

The TOON Protocol **gas station** — a payment-oblivious app that pays other
people's gas. Two NIP-90 job kinds, each registered only when its key material
is configured: **kind:5096** Solana fee-payer co-sign/broadcast
(`src/solana-gas-station-handler.ts`, gated by `GAS_STATION_SOLANA_SECRET_KEY`)
and **kind:5098** EVM ERC-2771 meta-transaction relaying
(`src/evm-gas-station-handler.ts`, gated by `EVM_GAS_STATION_CONFIG_JSON`). A
deployment with neither refuses to boot. Built from `Dockerfile.gas-station`
over `src/entrypoint-gas-station.ts`, which serves `POST /gas`
(`src/gas-station-backend.ts`) behind the connector — the front-of-app payment
proxy that terminates the payment and reverse-proxies to it (RouteTermination).
This is a **container, not an npm package** (`@toon-protocol/gas-station`, kept
private).

`deploy/` **is** a gas-station box, not a sketch of one: nginx/TLS, connector,
the app, certbot, Watchtower and an opt-in announce sidecar, installed by
`deploy/bootstrap.sh` on a fresh Ubuntu host. It is sized for a 1GB host. The
connector image is the fleet promotion tag
`ghcr.io/toon-protocol/connector:rust-release` with `connector.toml`
bind-mounted. Config files are rendered from committed `*.template` files by
`deploy/render.sh`; the rendered output and all key material are gitignored.
`src/deploy-bundle-guard.test.ts` asserts the bundle stays consistent.

Part of the **TOON Protocol** — pay-to-write Nostr over Interledger (ILP),
split into per-team repos.

## The one thing to keep in mind

This process signs transactions other people wrote, with a funded key. Every
guard in the two handlers exists because of that, and the module comments carry
the argument — read them before changing an inspection rule, a cap or a
whitelist. In particular:

- **Never widen a whitelist to make a caller's transaction work.** That is the
  gate doing its job. `src/ario-programs.ts` holds reviewed literals rather
  than an SDK read for exactly this reason.
- **A policy refusal is an accepted job** with a machine-readable `reason`, not
  a transport reject.
- **No test may touch a live chain.** Both suites inject stub RPC seams.

## Build

This builds a Docker image, not an npm package:
```
pnpm install
pnpm build            # esbuild bundle of the entrypoint
docker build -f Dockerfile.gas-station -t toon-gas-station .
```
Image-publish workflow: `publish-gas-station-image.yml` (→
`ghcr.io/toon-protocol/gas-station`, moving the `:release` tag Watchtower
follows on every green `main`).

## Shared skills, docs & project context → toon-protocol/toon-meta
Cross-cutting agent skills, docs, and the canonical project context live in
**[toon-protocol/toon-meta](https://github.com/toon-protocol/toon-meta)**. Load
the shared skills:
```
/plugin marketplace add toon-protocol/toon-meta
/plugin install toon-skills@toon-meta
```
Canonical rules/decisions: `toon-meta` → `_bmad-output/project-context.md`.

## Cross-repo dependencies
- Depends on no TOON package at runtime. The handler context/response types are
  a deliberate structural mirror in `src/gas-station-backend.ts` rather than an
  SDK import, so this app pins no `@toon-protocol/*` version.
- The ILP payment engine is the separate
  **[toon-protocol/connector](https://github.com/toon-protocol/connector)**
  repo. This app receives already-paid HTTP from it and trusts that;
  **claim validation lives ONLY in the connector.**
- Extracted from **[toon-protocol/store](https://github.com/toon-protocol/store)**,
  which still shipped both handlers as optional kinds at the time of the split.

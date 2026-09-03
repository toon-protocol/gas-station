# Running a gas-station box

This directory is the whole deployment. Everything a gas-station box runs is
here: the payment proxy, the job backend, TLS, discovery and unattended
updates. `./bootstrap.sh` on a fresh Ubuntu host is the entire install.

```
                         ┌──────────────────────────────────────┐
   client ──── :443 ────▶│ nginx          the only public port  │
   (pays)                └───────┬──────────────────────┬───────┘
                                 │                      │
                     proxy.gas.* │                      │ gas.*
                                 ▼                      ▼
                    ┌────────────────────┐    ┌──────────────────┐
                    │ connector   :4000  │    │ gas-station:3400 │
                    │ meters & settles   │    │ health           │
                    └─────────┬──────────┘    └──────────────────┘
                              │ POST /gas (payment already proven)
                              ▼
                    ┌────────────────────┐
                    │ gas-station :3300  │──▶ Solana / EVM
                    └────────────────────┘

   certbot  ──▶ renews the certificate
   watchtower ▶ recreates connector and gas-station when their tag moves
```

## Files

| File | What it is |
|---|---|
| `docker-compose.yml` | The containers above. The only file that names an image tag. |
| `connector.toml.template` | The payment proxy's config: what this node sells, at what price, and how it settles. Rendered to `connector.toml`. It names key and credential PATHS only, so it holds no secret. |
| `nginx/node.conf.template` | The TLS edge. Rendered to `nginx/conf.d/node.conf`. |
| `render.sh` | Fills the templates in from `.env`, and writes the operator surface's two credential files — `operator-bearer.token` and `operator-write.keys` — from `OPERATOR_BEARER_TOKEN` and `OPERATOR_WRITE_KEY`. |
| `bootstrap.sh` | Fresh-host install: firewall, swap, docker, keys, render, start, TLS. |
| `init-letsencrypt.sh` | Issues or reuses the certificate. Idempotent. |
| `.env.example` | Every variable, with what it is and how to generate it. |

`.env`, the rendered `connector.toml`, `operator-bearer.token`,
`operator-write.keys`, `nginx/conf.d/` and all key material are gitignored.
**Only templates are committed.**

## What this box is sized for

A gas station is a small, stateless HTTP service in front of two RPC clients.
It stores nothing — quotes and idempotency records live in memory on purpose —
so the box only has to hold the working set of five containers. **A 1GB / 1
vCPU host is enough**, which on Linode is the $5 Nanode, and this bundle is
written for that: the app's heap is capped (`NODE_OPTIONS`), the journal is
capped, and `bootstrap.sh` ensures there is swap.

The thing that actually needs the headroom is not serving traffic — it is
Watchtower pulling a new image while every container is still resident. That is
what the swap is for.

Measured on the TOON devnet gas box (Linode `g6-nanode-1`, 1GB/1vCPU/25GB,
Ubuntu 24.04) with all five containers up and serving:

| | |
|---|---|
| app (node) | 85 MB |
| watchtower | 19 MB |
| certbot | 17 MB |
| connector | 14 MB |
| nginx | 4 MB |
| **available** | **532 MB of 961** |
| swap in use | 22 MB of 496 |
| disk | 3.9 GB of 25 |

Linode's Ubuntu image already ships a 496MB swap partition, so `bootstrap.sh`
finds one and adds nothing. If free memory ever sits below ~200MB, or
`docker inspect --format '{{.State.OOMKilled}}'` ever reports true after a
Watchtower recreate, resize to the 2GB plan — it is an in-place resize plus a
reboot, not a rebuild.

## Standing one up

**Before you start** you need a host, two DNS A-records pointing at it —
`proxy.gas.<your-domain>` and `gas.<your-domain>` — and the keys below.

**1. Clone and configure.**

```bash
git clone https://github.com/toon-protocol/gas-station /root/gas-station
cd /root/gas-station/deploy
cp .env.example .env
$EDITOR .env          # every variable is documented in the file
```

**2. The two kinds of key, which are not interchangeable.**

*The connector's* three keys are generated for you by `bootstrap.sh` on first
run and never regenerated. They are raw 32-byte secrets:

| File | What it is |
|---|---|
| `signer.key` | this node's ILP identity. `GET /ilp/identity` answers with it and clients seal packets to it. Holds no money. |
| `settlement.key` | the EVM identity clients open payment channels against. |
| `settlement-solana.key` | the same, on Solana. |

**Back the last two up.** They are what a payer's channel is opened toward.

*The gas station's* keys go in `.env` and are the floats this node spends on
other people's behalf — see the next section. They are deliberately separate
from the connector's: one process signs other people's transactions, the other
holds the money this node has earned, and a single key doing both would put the
earnings inside the blast radius of the co-signing gate.

**3. Bring it up.**

```bash
./bootstrap.sh
```

That firewalls the host, ensures swap, installs docker, generates the connector
keys, renders the config, starts the containers and requests a certificate. It
is idempotent — re-run it to reconcile a box.

## Funding the floats

A gas station that cannot pay gas is not a gas station, and this is the step
that is easy to skip because nothing looks broken: the box comes up, `/health`
is green, and every caller gets `float_exhausted`.

Four addresses want funding. The app prints the first at boot
(`docker compose logs gas-station | grep 'fee payer'`); the others come from the
key files.

| Address | Needs | Why |
|---|---|---|
| the Solana fee payer (`GAS_STATION_SOLANA_SECRET_KEY`) | SOL — keep ≥ 0.05 | pays the fee on every kind:5096 job. The app refuses to quote below ~2 jobs' worth. |
| the EVM relayer (in `EVM_GAS_STATION_CONFIG_JSON`) | native gas — ~0.05 is plenty on a testnet | pays the gas on every kind:5098 job. |
| `settlement.key`'s address | a little native gas | the connector spends it redeeming what this node has earned. |
| `settlement-solana.key`'s address | SOL | the same, on Solana — **and it is a precondition of boot**, see below. |

**The Solana settlement table is opt-in for a reason.** The connector's EVM
startup only reads the chain, but its Solana startup *simulates a transaction*,
which an account holding no SOL cannot do. Point it at an unfunded key and it
exits 1 at boot with

```
RPC response error -32002: Transaction simulation failed:
Attempt to debit an account but found no record of a prior credit.
```

and restart-loops. So `render.sh` writes `[settlement.solana]` only when
`SETTLEMENT_SOLANA=on`. Bring the box up EVM-only, fund
`settlement-solana.key`, then set it and re-render. Until you do, this node
accepts EVM-paid claims and refuses Solana-paid ones — which for a gas station
matters more than usual, because the caller who needs Solana gas is very often
the caller paying in something else.

## Checking it works

```bash
docker compose ps                              # every service up, connector and gas-station healthy
# the connector's healthcheck is GET /ilp/identity — 200 only once it is
# serving AND has read its signer key, which "Up" alone does not prove
curl https://gas.<domain>/health               # {"status":"ok","handlerKinds":[5096,5098],...}
curl https://proxy.gas.<domain>/ilp/identity   # the signer pubkey clients seal to
```

`handlerKinds` is the thing to read: it is the list of chains this box actually
registered, and a chain whose key is missing or malformed will not be in it.

To prove the paid path end to end, send a kind:5096 or kind:5098 quote with a
TOON client pointed at `https://proxy.gas.<domain>/ilp`. The client pays 0.001
USDC, the connector settles it, and the app answers with a quote — or with a
machine-readable refusal, which is also a successful job.

## How updates arrive

Nothing here is deployed by hand. Watchtower polls once a minute and recreates
a container when the tag it follows changes digest.

| Container | Follows | Moves when |
|---|---|---|
| `gas-station` | `ghcr.io/toon-protocol/gas-station:release` | every green merge to `main` in this repo |
| `connector` | an immutable pin — a `rust-sha-<short>` build or a `rust-<release handle>` | when a connector release is adopted: a reviewed commit here, opened and merged automatically, then applied by this box's own timer (see "Following connector releases") |

The difference is deliberate. This app's image is this repo's to move; the
connector's is pinned to one immutable build, because nothing moves the old
`:rust-release` pointer any more (connector ADR 0068 — a node repository pins
the connector it runs, in one place, guarded there). Watchtower still carries
the label so a bumped pin is picked up on the next `docker compose up -d`.

`nginx` and `certbot` deliberately carry no Watchtower label. nginx holds the
resolver that lets every other container survive being recreated at a new
address, and certbot holds the renewal timer; neither should change because an
upstream base image was pushed.

**To roll back**, pin the immutable tag:

```bash
GAS_STATION_IMAGE=ghcr.io/toon-protocol/gas-station:sha-<known-good> \
  docker compose up -d --no-deps gas-station
```

Every superseded build stays pullable from GHCR by its own `sha-` tag.

**Config changes need a restart.** The connector reads `connector.toml` once at
startup and holds it for the process lifetime — a bind mount is not a reload,
and there is no environment-variable layer. After editing:

```bash
./render.sh && docker compose restart connector
```

The app's own configuration is environment, so it restarts the ordinary way:
`docker compose up -d gas-station`.

## Discovery, and the relay's peering

`GET https://proxy.gas.<domain>/ilp` is this node's self-description: the
prefixes it terminates, the URLs it is reachable on, its edge identity and its
settlement addresses on both chains. That is how a client finds it and how a
counterparty peers with it — there is no announce to publish and no sidecar to
run.

The relay peers with this node through the relay's own operator surface
(`POST /peers` at this URL, connector ADR 0058): it reads the self-description,
derives the payment channel from the two settlement addresses, opens it if
absent, and dials the BTP endpoint. Packets it forwards arrive addressed to
`g.toon.relay.gas`, which `connector.toml.template` terminates at the same app
and price as `g.toon.gas`. This node's own side of the peering — the channel
it pays the relay from — is established the same way from here:

```bash
# from a shell holding the private half of OPERATOR_WRITE_KEY
sign-write.sh -k operator-write.key -X POST -p /peers \
  -b '{"id":"relay","url":"https://proxy.relay.devnet.toonprotocol.dev/ilp","fee":1,"max_packet_amount":100000,"chain":"solana"}' \
  -u https://proxy.gas.<domain>
```

(`sign-write.sh` is the connector repo's `docs/operators/sign-write.sh`.) Both
sides' rows live in the connector's state volume, not in this file.

## Make it yours

Most of `connector.toml.template` describes any app behind any connector. To
put your own app here, change three things:

```toml
[[routes]]
prefix      = "g.example.myapp"          # the ILP address clients pay
handler_url = "http://myapp:8080/jobs"   # your backend; the path is literal
price       = 1000                       # smallest unit of the settlement token
```

Point `docker-compose.yml`'s `gas-station` service at your own image, keep a
health endpoint so compose can tell when it is ready, and the rest of this
directory works unchanged.

Pricing a gas station is the one place where copying a storage app's numbers
misleads: this node spends **real value** per job, at whatever the chain
charges that second. The per-job ceilings in the app bound what any single
execute can cost, and the float checks stop it quoting once the wallet is
nearly empty — so underpricing drains the float and starts answering
`float_exhausted`, rather than signing something ruinous. Watch the float.

Price the two phases apart: terminate a `…gas.quote` route at `/gas/quote`
for next to nothing and the execute route at `/gas/execute` for what
`GAS_STATION_MAX_LAMPORTS_CEILING` buys. See the top-level README,
"Pricing the two phases apart".

## Privacy invariant

The job backend is **payment-oblivious**: by the time a request reaches
`POST /gas` the payment is already proven, and the backend contains no ILP,
claim or settlement logic. It never sees a payer's channel, balance or claim
history.

It is also never reachable from off-box. There is no nginx location for
`:3300`, and the service publishes no port — the only path in is a paid packet
through the connector. A public path to `POST /gas` would be a free door:
anyone who found the URL would get their transactions signed and their gas paid
out of this box's float, for nothing.

### `ports:` bypasses ufw

Docker manages its own iptables rules ahead of ufw's, so a container published
with `ports:` is reachable from the internet **regardless of what `ufw status`
shows**. A ufw rule allowing only loopback does **not** make a
`ports:`-published container private.

This bundle therefore keeps every published port host-IP-prefixed — the
connector is `127.0.0.1:4000:4000`, and the app publishes nothing at all — so
the paid edge is reachable only through this box's own reverse proxy rather
than by trusting the firewall to hide a `0.0.0.0` bind.
`src/deploy-bundle-guard.test.ts` fails CI if that ever regresses.

## Following connector releases

**A newer connector arrives on its own, from a release.** When the connector
repo cuts a release — one human dispatch, stamping an immutable
`ghcr.io/toon-protocol/connector:rust-<handle>` that nothing ever moves — this
repo notices within half an hour and opens the pin bump itself
([`../.github/workflows/adopt-connector-release.yml`](../.github/workflows/adopt-connector-release.yml)).

It is keyed to a **release**, not to every green `main` in the connector. That
dispatch is the human decision point, and following every green merge instead
is the shape that took the devnet dark in about sixty seconds when it was
tried (connector#990) and was reverted.

Before it opens anything it **renders this bundle's `connector.toml` from the
committed template the way this box does, boots the candidate image against
it, and requires the build to accept the file.** A build that refused a key by
name, renamed a field or newly required one fails there, and no pull request
appears. That is connector ADR 0041's Decision 1 — an image a box follows
unattended may only move to a build that still accepts the config that box
runs — asked at the one moment the candidate image and this node's config are
in front of the same machine. It used to be a tag move in the connector repo;
since ADR 0068 there is no tag move, so the moment is that pull request and
the gate lives with it.

Two outcomes count as acceptance: `connector listening`, and `failed to
construct the configured settlement backend` — the latter because config
validation happens strictly before backend construction, so reaching it means
the whole file parsed, and a CI runner holds no funded settlement key. `config
file ... is not valid` is the failure the gate exists to catch.

Once that PR merges, the box applies it within five minutes:
[`auto-apply.sh`](./auto-apply.sh) on a systemd timer fast-forwards `main`,
re-renders, runs `docker compose up -d`, and requires the connector to come
back **healthy**. It is pull-based deliberately — no CI job anywhere holds SSH
into a node, which is the posture connector ADR 0068 settled — and it refuses
to touch a box whose working tree is dirty, so a human mid-operation is never
overwritten.

| File | What it is |
|---|---|
| `../.github/workflows/adopt-connector-release.yml` | Watches the connector repo for a cut release, renders this bundle's `connector.toml` and boots the candidate against it, then opens (and auto-merges) the pin bump. |
| `auto-apply.sh` | On the box: fast-forwards `main`, re-renders, `docker compose up -d`, and requires the connector to come back healthy. |
| `toon-auto-apply.service` / `.timer` | The systemd pair that runs it every five minutes. Install once, below. |

The split is deliberate: the workflow decides **what** to run and proves it
accepts this node's config first; the box decides **when** to apply, by
pulling. Nothing outside this box can make this box deploy.

Install the timer once per box:

```bash
sudo cp /root/gas-station/deploy/toon-auto-apply.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now toon-auto-apply.timer
systemctl list-timers toon-auto-apply.timer     # when it next fires
journalctl -u toon-auto-apply.service -n 50     # what it last did
systemctl start toon-auto-apply.service         # run one now, by hand
```

The pin is still the only place a connector build is named here, and it is
still immutable — a `rust-sha-` build or a `rust-<handle>` release, never a
moving tag. The config parser is `deny_unknown_fields` and startup is
fail-closed, which is exactly why the gate runs before the pin moves rather
than after.

## Bumping the connector pin

Usually you do not: § "Following connector releases" above does it for you,
gate and all. This is the manual path — a build between releases, or a
rollback.

`docker-compose.yml` pins the connector to one immutable `rust-sha-` build, and
`src/deploy-bundle-guard.test.ts` pins the same literal. To move:

1. Read the connector's release notes for schema changes. The parser is
   `deny_unknown_fields` and startup is fail-closed, so a key the new build
   refuses is a refuse-to-start, never a degraded run.
2. Change `connector.toml.template` first if the new build wants it, then the
   tag in `docker-compose.yml` and the test literal, in one commit.
3. On the box: `git pull && ./render.sh && docker compose up -d`.

To roll the connector back, pin the previous `rust-sha-` tag the same way.

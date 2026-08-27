# gas-station

**A TOON app that pays other people's gas.** A peer holding no SOL can still
get a Solana transaction landed; a peer holding no ETH can still get an EVM
call mined. They pay for it in whatever they *do* hold, over an ILP payment
channel, and this node contributes exactly the gas and nothing else.

Two NIP-90 job kinds, one per chain family:

| Kind | Chain | What it does |
|---|---|---|
| **5096** | Solana | co-signs a client-authored transaction as **fee payer** and broadcasts it |
| **5098** | EVM | relays a client-signed **ERC-2771** forward request through a trusted forwarder |

Each is registered only when its key material is configured, so one deployment
can serve either chain or both. A deployment with neither refuses to boot.

```
   client ──paid POST /ilp──▶ connector ──POST /gas──▶ gas-station ──▶ chain
   (no gas on            (terminates the payment)     (inspects, simulates,
    the target chain)                                  signs, broadcasts)
```

The app is **payment-oblivious**: the connector in front proves the payment and
reverse-proxies a plain HTTP request (RouteTermination). There is no ILP,
claim or settlement logic in this process, and there must never be — claim
validation lives only in the connector.

- **Deploying it:** [`deploy/`](./deploy) is a complete box — payment proxy,
  TLS, unattended updates — that runs on a $5 1GB host.
- **The code:** `src/solana-gas-station-handler.ts` and
  `src/evm-gas-station-handler.ts` carry the full security argument in their
  module comments. Start there.

## Ask the node what it serves

Don't hardcode the kinds. A deployment registers only the chains it has keys
and funding for, so the node itself is the authority on what it will do:

```bash
curl https://gas.devnet.toonprotocol.dev/describe
```
```json
{
  "handlerKinds": [5096, 5098],
  "jobs": [
    { "kind": 5096, "resultKind": 6096, "name": "solana-gas-station",
      "phases": ["quote", "execute"], "chains": ["solana:devnet"] },
    { "kind": 5098, "resultKind": 6098, "name": "evm-gas-station",
      "phases": ["quote", "execute"], "chains": ["evm:84532"] }
  ]
}
```

`/health` is next door and answers a different question — is this alive, and
what has it been doing. It carries `handlerKinds` too, because a monitoring
system reasonably alerts on a node that came up serving fewer kinds than
expected, but the protocol detail lives in `/describe`.

`chains` is the field that usually decides it: knowing a node speaks kind:5098
is not the same as knowing it will relay on *your* chain. Every field is
derived from what actually registered at boot, so it cannot advertise a chain
the node has no key for.

Each job also carries a `request` block — the `['param', name, value]` tags to
set, per phase, with what goes in each:

```json
"request": {
  "quote": { "params": [
    { "name": "phase",   "required": true, "value": "quote", "description": "…" },
    { "name": "chainId", "required": true, "description": "Decimal EVM chain id…" },
    { "name": "from",    "required": true, "description": "The address that will sign…" }
  ]},
  "execute": { "params": [ … "request", "quoteId", "idempotencyKey" … ] }
}
```

That is enough to build a job without reading this repo.
`src/job-definitions.test.ts` keeps it honest in both directions: it drives
each handler with each declared-required param omitted and requires a refusal,
and it reads the handler's own `paramTag` calls to catch a param the code reads
but the spec never mentions. A spec a client builds requests from is worse than
no spec if it has drifted.

### One thing you cannot guess: there is no relay round-trip

`/describe` states it under `transport`, because "NIP-90 kind:5096" implies
something that is not true here:

```json
"transport": {
  "protocol": "nip90-over-ilp",
  "inputEncoding": "param-tags",
  "resultDelivery": "ilp-fulfill-body",
  "refusals": "in-band"
}
```

The signed job event is POSTed to this node by the connector in front, as the
termination of a paid ILP packet, and the receipt comes back **in that
response**. It is never published as a `kind:6096` event on any relay.
`resultKind` describes the *shape* the receipt takes, not an event to go
looking for. Inputs are `param` tags, not NIP-90 `i` tags. And a refusal
arrives in-band as an accepted job with `status: "failed"` — see below.

The connector in front answers the other half — how to **pay** — at
`GET /ilp` on the paid edge: ILP addresses, settlement contracts per chain, and
the price of each route. Between the two you have everything needed to send a
job: what to send, where to send it, and what it costs.

```bash
curl https://proxy.gas.devnet.toonprotocol.dev/ilp
```

Two documents is one too many, and `GET /ilp` is the one that should carry
both — it is the *self-description*, and "what this node serves" is a fact
about the node.

The reason it doesn't yet is worth knowing, because it also rules out the
obvious fix. The connector's `[node]` section is explicitly only for facts a
node **cannot introspect** — its public endpoints and its ILP addresses —
and everything else it publishes is *derived*: prices from `[[routes]]`,
settlement facts from the backends that verified them on chain. That rule
exists because a declared copy drifts: `[announce].solana_chain_id` was a
second declaration of a fact the Solana backend already held, nothing compared
the two, and a mainnet node described itself as devnet (connector#981). A
`kinds = [5096, 5098]` line in `connector.toml` would be exactly that bug
again — and `relay_url` was deleted from that section for being an
*application* fact, which job kinds also are.

So the fix is not to declare them there but to **derive** them there, the way
settlement facts already are: the connector projects into `/ilp` what the app
authoritatively answers at `/describe`. That is connector#1210. This endpoint
is the half of it that can exist today.

---

## The security property

Everything else in this repo follows from one sentence: **a gas station
decides whether to spend its own money on a transaction somebody else wrote.**

That is a strange position to be in. On Solana it is sharper still — one
Ed25519 signature covers the whole message, so co-signing as fee payer
authorizes *every instruction in the transaction*, not just the fee. A naive
implementation signs whatever it is handed and is drained in one request.

So the answer is not "trust the caller". It is a gate, in five parts, applied
identically on both chains:

| | Solana (kind:5096) | EVM (kind:5098) |
|---|---|---|
| **(a) Dedicated key** | a fee-payer wallet that holds working SOL and nothing else | one relayer wallet per chain, holding native gas only |
| **(b) Static inspection** | the fee payer must be static account 0, appear exactly once, and may appear in an instruction only in whitelisted rent-payer slots | `to` must be the configured `TokenNetwork`; `value`, `gas` and `deadline` must be within policy |
| **(c) Simulation + cap** | `simulateTransaction`, then the fee payer's lamport delta must be ≤ the quoted `maxLamports` | `estimateGas` on `forwarder.execute(request)`, then ≤ the gas cap |
| **(d) Whitelist** | program whitelist: System, ComputeBudget, MPL Core, ar.io | function-selector whitelist: `setTotalDeposit`, `closeChannel`, `settleChannel` |
| **(e) Channel ops** | instructions against the TOON channel program are restricted to deposit / close / settle | the same three, by selector |

Two details worth pulling out, because they are where the design is least
obvious:

**Simulation is not a second opinion, it is the backstop.** Static inspection
reads the transaction as written; simulation observes what it actually *does*.
A transaction that passes (b) and then shows an over-cap debit in (c) is not a
near miss — it is the signature of an inspection bypass, and both handlers
log it as an ALARM before refusing.

**Opening a channel and claiming from one are deliberately excluded.** (e)
permits exactly the operations an agent needs to fund or reclaim *its own*
collateral. `INITIALIZE_CHANNEL` and `claimFromChannel` are not that, and a
gas station has no business co-signing them.

On the EVM side, signature, nonce and deadline validity are delegated to the
forwarder's own `verify(request)` view call rather than re-derived offline.
The forwarder is the one contract that actually knows its EIP-712 domain and
the signer's current nonce; re-implementing that here would be a second,
driftable source of truth for the same fact.

## The job protocol

Both kinds are two-phase — **quote**, then **execute** — and both take their
input as NIP-90 `['param', key, value]` tags.

### Quote

The free phase. It tells the caller what this node will do and what it will
cost, and hands back a `quoteId` to execute against.

| | kind:5096 | kind:5098 |
|---|---|---|
| **Params** | `phase=quote`, optional `transaction` (base64 draft) | `phase=quote`, `chainId`, `from` |
| **Returns** | `quoteId`, `feePayer`, `maxLamports`, `recentBlockhash`, `expiresAt` | `quoteId`, `relayer`, `forwarder`, `tokenNetwork`, `forwarderNonce`, `maxGas`, `recommendedDeadline`, `expiresAt` |

The caller must build against what the quote returns. On Solana that means the
**quoted blockhash**: quote TTL and blockhash validity are one merged deadline
(~60s by default), because there is no useful state in between — a quote whose
blockhash has expired cannot be executed anyway. Passing a draft transaction to
the quote phase is worth doing: it runs the full gate for free, so a policy
violation is something the caller learns about before signing anything.

### Execute

| | kind:5096 | kind:5098 |
|---|---|---|
| **Params** | `phase=execute`, `transaction` (base64, partially signed), `quoteId`, `idempotencyKey` | `phase=execute`, `chainId`, `request` (base64 JSON `ForwardRequestData`), `quoteId`, `idempotencyKey` |
| **Returns** | `signature`, `slot`, `feeLamportsActual` | `txHash`, `blockNumber`, `gasUsed`, `effectiveGasPriceWei` |

`idempotencyKey` is what makes a retry safe. A confirmation timeout does not
mean the transaction failed — it may still land — so retrying with the same key
returns the original result (`replayed: true`) rather than broadcasting twice.

### A refusal is a successful job

This is the part most worth internalising. When the gate says no, the answer is
`status: 'failed'` with a machine-readable `reason`, delivered as a normal
accepted result — not a transport-level reject:

```json
{ "job": "evm-gas-station", "phase": "quote", "status": "failed",
  "chainId": 84532, "reason": "float_exhausted",
  "detail": "relayer float 0 wei cannot cover this job (needs ≥ 3600000000000 …)" }
```

The DVM was asked a question, applied its rules, and answered. The caller gets
a reason it can branch on. A transport reject would say only "something went
wrong", which is true of a bug, a network blip and a deliberate policy decision
alike.

The vocabularies are closed sets — `GasStationFailureReason` and
`EvmGasStationFailureReason` in the two handler files. Some worth knowing:

- `float_exhausted` — this node is out of gas money. Fund it.
- `dvm_key_misplaced` — the fee-payer key appears somewhere it has no business
  being. This is the interesting one; it usually means the caller built the
  transaction wrong, and occasionally means they tried something.
- `delta_cap_exceeded` / `gas_cap_exceeded` after inspection passed — the
  bypass signature described above.
- `quote_expired`, `blockhash_expired`, `blockhash_mismatch` — re-quote and
  rebuild.
- `confirmation_timeout` — broadcast, not confirmed in time. **Retry with the
  same `idempotencyKey`.**

## Configuration

Everything is environment. Full documentation lives in
[`src/entrypoint-gas-station.ts`](./src/entrypoint-gas-station.ts)'s module
comment and in [`deploy/.env.example`](./deploy/.env.example).

| Variable | |
|---|---|
| `NODE_NOSTR_SECRET_KEY` | **required** — this node's identity, 64 hex chars |
| `HANDLER_PORT` / `BLS_PORT` | 3300 (`POST /gas`) and 3400 (health) |
| `GAS_STATION_SOLANA_SECRET_KEY` | enables kind:5096 — 128 hex chars, a real Ed25519 keypair |
| `SOLANA_NETWORK` / `SOLANA_RPC_URL` | `devnet` (default) or `mainnet`; your own RPC if you have one |
| `GAS_STATION_CHANNEL_PROGRAM_ID` | enables mitigation (e) for the TOON channel program |
| `GAS_STATION_QUOTE_TTL_MS` | raises the merged quote/blockhash deadline |
| `EVM_GAS_STATION_CONFIG_JSON` | enables kind:5098 — a JSON array of chains |
| `EVM_GAS_STATION_QUOTE_TTL_MS` / `EVM_GAS_STATION_MAX_GAS` | override 120s / 300,000 |

Absent and malformed are treated differently on purpose: an absent key leaves
its kind unregistered (a deployment choice), a malformed one refuses to boot (a
typo that would otherwise ship a node quietly answering nothing).

The Solana key gets a stronger check than its shape. 128 random hex characters
are the right *length* and not a keypair — `openssl rand -hex 64` produces
exactly that — so the node verifies at boot that the trailing 32 bytes really
are the public key of the leading 32, and prints the fee-payer address it will
be asking you to fund.

### Adding an EVM chain is a config entry

```json
[{"chainId":84532,
  "rpcUrl":"https://base-sepolia-rpc.publicnode.com",
  "forwarderAddress":"0xf1b0B8BA9CA90A0779C382Fe4212a3D4C5646Ee9",
  "tokenNetworkAddress":"0xa79C3b1dbcEA00a6d84735a134395D8eF6D6a478",
  "relayerPrivateKey":"0x…"}]
```

One entry per chain, each with its own dedicated relayer wallet. No code
change — that is the point. Every field is validated at boot, and the error
names the array index so a multi-chain config is debuggable.

## Public network ids

The whitelist inputs. These are network-scoped, and pointing them at the wrong
network silently targets the wrong registry.

**Cluster-invariant** (same on every Solana cluster):

| Program | Id |
|---|---|
| System | `11111111111111111111111111111111` |
| ComputeBudget | `ComputeBudget111111111111111111111111111111` |
| Metaplex Core | `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d` |

**ar.io**, per network — `src/ario-programs.ts`. These are reviewed literals
rather than a runtime read off `@ar.io/sdk`, because a whitelist that widens
when a dependency publishes a minor version is not a whitelist. The SDK is a
devDependency and `src/ario-programs.test.ts` fails CI if the table drifts from
it.

**The TOON payment-channel program** is not a preset at all. It belongs to a
particular connector deployment and rotates with it, so
`GAS_STATION_CHANNEL_PROGRAM_ID` should be whatever the connector in front of
*your* node settles against — its `[settlement.solana] program_id`. On the TOON
devnet that is `2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip`.

## Working on it

```bash
pnpm install
pnpm build       # esbuild bundle of the entrypoint
pnpm typecheck
pnpm lint
pnpm test
```

Or `devbox shell` for the pinned toolchain (Node 22, pnpm 8.15.9) that CI uses.

**No test touches a live chain, ever.** Both handler suites inject stub RPC
seams and build real wire transactions offline; the Solana suite compiles and
partially signs actual transactions with `@solana/kit` to exercise the
inspection gate against real bytes. A test that needed a cluster would be a
test that fails when a faucet is down.

Build the image:

```bash
docker build -f Dockerfile.gas-station -t ghcr.io/toon-protocol/gas-station:dev .
```

The image installs its dependency closure from `package.json` +
`pnpm-lock.yaml` and asserts no native module ends up in it — the closure is
pure JavaScript, and the build fails rather than shipping something that boots
only on the architecture it was built on.

---

## Provenance

Extracted from [toon-protocol/store](https://github.com/toon-protocol/store),
where both handlers shipped as optional job kinds beside Arweave blob storage
(store#41, #40, #69, #73). They are their own app because they are their own
thing: storage sells bytes, a gas station spends its own money on a stranger's
transaction, and those want different security review, different funding,
different scaling and — as it turns out — a much smaller box.

Part of the **TOON Protocol** — pay-to-write Nostr over Interledger (ILP),
split into per-team repos.

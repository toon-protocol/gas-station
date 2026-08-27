#!/usr/bin/env bash
# Render the two config files that carry deployment-specific values.
#
#   connector.toml.template   -> connector.toml       (0600 — holds a secret)
#   nginx/node.conf.template  -> nginx/conf.d/node.conf
#
# Both outputs are gitignored. Edit the templates.
#
# envsubst is given an EXPLICIT variable list. Without one it would substitute
# every $NAME it sees, and both templates contain nginx variables ($host,
# $backend, $binary_remote_addr) that must survive to the rendered file.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "Missing .env — copy .env.example and fill it in." >&2; exit 1; }
set -a; . ./.env; set +a

: "${DOMAIN:?set DOMAIN in .env}"
: "${OPERATOR_BEARER_TOKEN:?set OPERATOR_BEARER_TOKEN in .env (openssl rand -hex 32)}"
: "${OPERATOR_WRITE_KEY:?set OPERATOR_WRITE_KEY in .env (the nostr pubkey allowed to sign operator writes)}"
: "${CERT_NAME:=proxy.gas.${DOMAIN}}"
export CERT_NAME

envsubst '${OPERATOR_BEARER_TOKEN} ${OPERATOR_WRITE_KEY}' \
  < connector.toml.template > connector.toml

# ── [settlement.solana] is appended, not templated ───────────────────────────
# Why this is not just in the template: see connector.toml.template's own note
# where the section would otherwise sit. Short version — an unfunded Solana
# settlement key is a refuse-to-start, so a box turns this on once the key has
# SOL, not before.
if [ "${SETTLEMENT_SOLANA:-off}" = "on" ]; then
  cat >> connector.toml <<'SOLANA'

# Accepting Solana-paid claims. Requires /app/data/settlement-solana.key to
# hold SOL before this container starts — startup simulates a transaction, and
# an account with no prior credit cannot.
[settlement.solana]
rpc_url       = "https://api.devnet.solana.com"
program_id    = "2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip"
token_address = "xyc5J8MgKFiEN13PnfftdXxUzYH34FEvw1LCrFwN7in"   # mock USDC (6dp)
decimals      = 6

[settlement.solana.key]
key_file = "/app/data/settlement-solana.key"
SOLANA
  settlement_state="EVM + Solana"
else
  settlement_state="EVM only — set SETTLEMENT_SOLANA=on once settlement-solana.key is funded"
fi

# ── The [announce] section is appended, not templated ────────────────────────
# Discovery costs money: publishing a kind:10032 is a PAID write through
# another node's client edge, so it needs a funded payment channel
# (ANNOUNCE_PAY_CHANNEL). A box that does not have one yet is a normal state —
# it is reachable and serving, just not yet listed — and it must not be a
# broken state.
#
# The connector's parser is `deny_unknown_fields` and refuses a half-filled
# section, so "leave the value blank" is not available: the section is either
# written completely or not at all. Hence this, rather than a `${VAR}` in the
# template that renders to an empty string and fails at boot.
if [ -n "${ANNOUNCE_PAY_CHANNEL:-}" ]; then
  : "${ANNOUNCE_PUBLISH_TO:?set ANNOUNCE_PUBLISH_TO in .env when ANNOUNCE_PAY_CHANNEL is set}"
  : "${ANNOUNCE_PUBLISH_BTP_URL:?set ANNOUNCE_PUBLISH_BTP_URL in .env when ANNOUNCE_PAY_CHANNEL is set}"
  cat >> connector.toml <<ANNOUNCE

# The kind:10032 self-announce: how a client DISCOVERS that g.toon.gas exists,
# what it costs, and which identity to seal to. These are the facts a node
# behind a TLS terminator cannot introspect — inside the container it only ever
# sees 0.0.0.0:4000 and a private docker network.
#
# Published THROUGH another node's client edge and paid for out of
# \`pay_channel\`, like any other client write. The \`announce\` service in
# docker-compose.yml is what runs it.
#
# No \`relay_url\`: this box fronts no Nostr relay, and announcing somebody
# else's would advertise reads it does not serve.
[announce]
addresses       = ["g.toon.gas"]
http_endpoint   = "https://proxy.gas.${DOMAIN}/ilp"
btp_endpoint    = "wss://proxy.gas.${DOMAIN}/ilp/btp"
publish_to      = "${ANNOUNCE_PUBLISH_TO}"
publish_btp_url = "${ANNOUNCE_PUBLISH_BTP_URL}"
pay_channel     = "${ANNOUNCE_PAY_CHANNEL}"
ANNOUNCE
  announce_state="configured (publishing through ${ANNOUNCE_PUBLISH_TO})"
else
  announce_state="OFF — no ANNOUNCE_PAY_CHANNEL, so the box serves but is not discoverable"
fi

# This file carries the operator bearer token inline, so it must not be
# world-readable — but the connector container runs as uid 10001, and a
# root-owned 0600 file is unreadable to it ("failed to read config file:
# Permission denied", then a restart loop). Hand it to that uid rather than
# widening the mode.
chmod 600 connector.toml
if [ "$(id -u)" = 0 ]; then
  chown "${CONNECTOR_UID:-10001}:${CONNECTOR_UID:-10001}" connector.toml
else
  echo "note: not running as root, so connector.toml stays owned by $(id -un)." >&2
  echo "      The connector container runs as uid 10001 and will not be able to" >&2
  echo "      read it. Fine for a local render; re-run as root on the box." >&2
fi

mkdir -p nginx/conf.d
envsubst '${DOMAIN} ${CERT_NAME}' \
  < nginx/node.conf.template > nginx/conf.d/node.conf

echo "rendered connector.toml (0600) and nginx/conf.d/node.conf for ${DOMAIN}"
echo "  certificate lineage: ${CERT_NAME}"
echo "  settlement: ${settlement_state}"
echo "  announce: ${announce_state}"

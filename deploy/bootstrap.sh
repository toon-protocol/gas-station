#!/usr/bin/env bash
# Bring the gas-station box up from a fresh Ubuntu host. Idempotent —
# re-running it reconciles the box rather than rebuilding it.
#
#   ./bootstrap.sh
#
# Expects .env to be filled in; it GENERATES the three connector key files on
# first run if they are absent (see below). Everything it installs is listed
# here, and it makes no changes outside this directory, ufw, docker, swap and
# journald.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "Missing .env — copy .env.example and fill it in." >&2; exit 1; }

echo "==> [1/7] Firewall"
# Only SSH, HTTP (for ACME) and HTTPS. Note that docker publishes ports by
# writing iptables rules that BYPASS ufw, so this protects the host but not a
# container that publishes on 0.0.0.0 — which is why docker-compose.yml binds
# the connector to 127.0.0.1.
apt-get update -y
apt-get install -y ufw curl gettext-base openssl
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp  comment 'SSH'
ufw allow 80/tcp  comment 'HTTP (ACME)'
ufw allow 443/tcp comment 'HTTPS'
ufw --force enable

echo "==> [2/7] Swap"
# This box is sized to be the cheapest thing that works, which leaves no room
# for a spike — and the spike is predictable: Watchtower pulling a new image
# has dockerd decompressing layers while every container is still resident.
# Swap is what turns that into a slow minute instead of an OOM kill.
#
# Linode's Ubuntu image ships a 512MB swap partition. If this box has one
# already, leave it alone; a second swap file on top would just be more disk
# doing the same job.
if [ -z "$(swapon --show --noheadings 2>/dev/null)" ]; then
  if [ ! -f /swapfile ]; then
    fallocate -l 1G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=1024
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  # Prefer reclaiming page cache to swapping out a running node process.
  sysctl -w vm.swappiness=10 >/dev/null
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
  echo "  swap on (1G file)"
else
  echo "  swap already present: $(swapon --show --noheadings | tr '\n' ' ')"
fi

echo "==> [3/7] Docker"
command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh

echo "==> [4/7] Cap the journal"
# A small box should not lose its disk to logs.
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=100M\n' > /etc/systemd/journald.conf.d/00-cap.conf
systemctl restart systemd-journald || true

echo "==> [5/7] Connector keys"
# Three key files, generated here on first run and never regenerated.
#
# All three are raw 32-byte secrets as 64 hex characters, and they are
# GENERATED rather than derived from a seed on purpose: this is a new node
# with no channels open against it, so there is no prior address to reproduce.
# A derivation path only earns its complexity when you need to land on an
# identity somebody already funded.
#
#   signer.key             this node's ILP signing identity. Holds no money.
#   settlement.key         the EVM identity clients open channels against.
#   settlement-solana.key  the same, on Solana.
#
# BACK THE LAST TWO UP. They are what a payer's channel is opened toward;
# losing them strands whatever has been paid into those channels. The
# container runs as uid 10001, and a bind-mounted file keeps its HOST
# ownership inside the container, so a root-owned 0600 key is unreadable to
# the process that needs it — hence the chown.
for f in signer.key settlement.key settlement-solana.key; do
  if [ ! -f "$f" ]; then
    openssl rand -hex 32 > "$f"
    echo "  generated $f"
  fi
  chmod 600 "$f"
  chown 10001:10001 "$f"
done

echo "==> [6/7] Render config"
./render.sh

echo "==> [7/7] Pull and start"
docker compose pull --ignore-pull-failures
docker compose up -d

./init-letsencrypt.sh

set -a; . ./.env; set +a
echo
echo "gas-station box up."
echo "  paid ILP edge : https://proxy.gas.${DOMAIN}/ilp"
echo "  identity      : https://proxy.gas.${DOMAIN}/ilp/identity"
echo "  health        : https://gas.${DOMAIN}/health"
echo
echo "The floats still need funding — the app answers float_exhausted until they are."
echo "See README.md § Funding the floats."

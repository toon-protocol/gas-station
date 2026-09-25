#!/usr/bin/env bash
#
# Apply what was merged. Run by systemd on a timer; see deploy/README.md.
#
# This is the box half of "the fleet follows connector releases". The repo half
# is .github/workflows/adopt-connector-release.yml, which opens and merges the
# pin bump after proving the candidate still accepts this node's config. This
# script's whole job is to notice that main moved and apply it.
#
# It is PULL-based on purpose. The alternative -- a CI job holding an SSH key
# into this box -- is the write path connector ADR 0068 deliberately removed,
# and putting it back in three repos' secrets is a wider blast radius than the
# tedium it saves. Nothing outside this box can make this box deploy.
#
# It refuses rather than guesses:
#   * a dirty working tree means a human is mid-operation here -- stop, loudly;
#   * only a fast-forward is applied, never a merge or a reset, so a box can
#     never end up on a tree nobody reviewed;
#   * after `up -d` the connector must reach `healthy`, or this exits non-zero
#     so `systemctl status` and the journal show it. A box that comes back
#     unhealthy is also picked up by the connector repo's fleet-health.yml,
#     which opens a needs:human issue;
#   * a render or apply failure is retried, and reported, on every run until
#     it is fixed -- never silently sat on with the box left on the new
#     commit and the old config (TOON_Network#164, porting TOON_Network#160;
#     see `deploy/.applied`, below the fetch, for how).
set -euo pipefail

REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
DEPLOY_DIR="$REPO_DIR/deploy"
cd "$REPO_DIR"

# One apply at a time, and never one racing a human. Named per node --
# TOON_Network#28/infra#25's shared devnet host runs five of these bundles at
# once, so a shared lock name would serialise unrelated nodes' applies against
# each other for no reason. The path is overridable only for tests
# (TOON_AUTOAPPLY_LOCK) -- a box always takes the real one.
LOCK_FILE=${TOON_AUTOAPPLY_LOCK:-/var/lock/toon-auto-apply-gas.lock}
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "another apply is already running; leaving it alone"; exit 0; }

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "REFUSING: the working tree at $REPO_DIR is dirty."
  echo "Someone is editing on the box. Commit, stash or discard it, then this resumes on its own."
  exit 1
fi

git fetch -q origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

# The commit the LAST run applied AND VERIFIED, held separately from HEAD
# (TOON_Network#160, ported here as TOON_Network#164). Without it,
# "LOCAL = REMOTE" alone reads as "nothing to do" even when the PREVIOUS run
# fast-forwarded here and then failed partway through -- render.sh, the pull,
# `up -d` or the health check below -- which leaves the box sitting on the
# new commit with the OLD rendered config and the OLD containers, reporting
# success on every run after. Comparing HEAD to `.applied` instead of to what
# was just fetched means a fetch that brings back nothing new is still
# retried as work when the two disagree.
#
# Missing entirely -- an existing box's first run under this check, or one
# whose `deploy/.applied` was lost -- is read the SAFER of the two ways: as
# needing an apply, not as "must already be applied". Re-running the full
# apply against a box already on the right commit with a healthy connector is
# a harmless no-op, where guessing the other way would paper over a first
# apply that had in fact failed before this file ever existed. bootstrap.sh
# deliberately does not write it either: the box's first-ever apply IS this
# script's first run, and it should prove itself exactly like every later
# one does.
APPLIED_FILE="$DEPLOY_DIR/.applied"
APPLIED=$(cat "$APPLIED_FILE" 2>/dev/null || true)

if [ "$LOCAL" = "$REMOTE" ] && [ "$LOCAL" = "$APPLIED" ]; then
  exit 0   # nothing merged since last time, and it is already applied
fi

if [ "$LOCAL" != "$REMOTE" ]; then
  echo "applying ${LOCAL:0:7} -> ${REMOTE:0:7}"
  git merge --ff-only origin/main
else
  echo "retrying ${LOCAL:0:7}: the last apply did not finish (deploy/.applied is '${APPLIED:-<none>}')"
fi

cd "$DEPLOY_DIR"
# This bundle's connector.toml is RENDERED from connector.toml.template and
# .env, so a pulled template change is not live until render.sh has run. (The
# relay's config is committed whole and has no render.sh; the check is kept in
# all three copies so the script is the same file everywhere.) render.sh is
# also what chowns the rendered files to uid 10001 -- it must run as root, and
# systemd runs this as root.
if [ -x ./render.sh ]; then
  if ! ./render.sh; then
    echo "FAILED: render.sh could not render the config for ${REMOTE:0:7} (its message is" >&2
    echo "above). If it names a missing .env variable, add it -- deploy/.env.example lists" >&2
    echo "every required one. deploy/.applied is left naming the last commit that DID apply," >&2
    echo "so this is retried, and reported the same way, on every run, until it is fixed." >&2
    exit 1
  fi
fi

# The overlay set this box actually runs is named in deploy/.env, not guessed
# here -- COMPOSE_FILE=docker-compose.yml:docker-compose.shared-edge.yml turns
# on the shared-edge overlay (TOON_Network#28, infra#24) the same way an
# operator's own `docker compose ps` in this directory sees it: docker compose
# reads COMPOSE_FILE out of .env itself. So when .env sets it, this passes NO
# `-f` flags at all -- an explicit `-f` on the command line would override
# .env's COMPOSE_FILE and silently run the base file alone, defeating the
# overlay on every apply. Only a `.env` with no COMPOSE_FILE line falls back
# to this script's own default, which is the base file plus the (currently
# unused) Watchtower overlay probe kept here so this box picks that up on its
# own if the file is ever added. (No `[ -f .env ]` guard here: render.sh,
# just above, already refuses loudly and exits this script if `.env` is
# missing, so by this line it is guaranteed to exist.)
set -a; . ./.env; set +a
if [ -n "${COMPOSE_FILE:-}" ]; then
  COMPOSE=()
else
  COMPOSE=(-f docker-compose.yml)
  [ -f docker-compose.watchtower.yml ] && COMPOSE+=(-f docker-compose.watchtower.yml)
fi

if ! docker compose "${COMPOSE[@]}" pull; then
  echo "FAILED: 'docker compose pull' could not get the images for ${REMOTE:0:7} (its message" >&2
  echo "is above). deploy/.applied is left naming the last commit that DID apply, so this is" >&2
  echo "retried, and reported the same way, on every run, until it is fixed." >&2
  exit 1
fi
if ! docker compose "${COMPOSE[@]}" up -d; then
  echo "FAILED: 'docker compose up -d' failed for ${REMOTE:0:7} (its message is above)." >&2
  exit 1
fi

# The connector must come back healthy. Every node bundle defines a healthcheck
# on it (GET /ilp/identity), so this is a real answer rather than "the container
# exists".
CONNECTOR=$(docker compose "${COMPOSE[@]}" ps -q connector)
for _ in $(seq 1 40); do
  STATUS=$(docker inspect "$CONNECTOR" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')
  [ "$STATUS" = healthy ] && break
  sleep 3
done

if [ "${STATUS:-unknown}" != healthy ]; then
  echo "FAILED: the connector is '$STATUS' after applying ${REMOTE:0:7}."
  docker compose "${COMPOSE[@]}" logs --tail 40 connector || true
  exit 1
fi

# Written only now, after render, the pull, `up -d` and the health wait have
# all succeeded -- the one thing this file is allowed to claim. Gitignored
# (deploy/.gitignore).
printf '%s\n' "$REMOTE" > "$APPLIED_FILE"

echo "applied ${REMOTE:0:7}; connector healthy."

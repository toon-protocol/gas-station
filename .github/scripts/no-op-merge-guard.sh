#!/usr/bin/env bash
# No-op merge guard: a PR whose merge result changes zero files must not merge
# green. Run from a checkout of refs/pull/N/merge (what a `pull_request` run
# checks out); first parent is the base tip, second is the PR head, so
# `git diff base HEAD` is exactly what the squash commit would carry.
#
# History: this was toon-meta's reusable empty-pr-guard.yml, copied in so CI
# does not depend on toon-meta. It exists because connector#1008 merged green,
# closed its ticket and changed zero files: the branch's three-dot diff was
# non-empty, but `main` had already acquired that content from another PR.
#
# Inputs (env): GITHUB_EVENT_NAME, PR_HEAD_SHA, PR_BASE_REF, PR_NUMBER,
# PR_CHANGED_FILES (the Files-changed count from the event payload; not
# recomputed, because a shallow clone lacks the merge base), GITHUB_STEP_SUMMARY.
#
# It warns and passes wherever it cannot tell (not a PR event, no merge ref,
# stale merge ref): a required check that fails on "I could not tell" gets
# disabled, and a conflicted PR cannot merge anyway.
set -uo pipefail

if [ "${GITHUB_EVENT_NAME:-}" != "pull_request" ]; then
  echo "event is '${GITHUB_EVENT_NAME:-}', not 'pull_request' — no merge result to evaluate"
  exit 0
fi

if ! git rev-parse --verify -q HEAD^2 >/dev/null; then
  echo "::warning::no merge ref for this PR (HEAD is not a merge commit) — the merge result could not be evaluated. A conflicted PR is the usual cause; resolve the conflict and this guard re-runs."
  exit 0
fi

P1=$(git rev-parse HEAD^1)
P2=$(git rev-parse HEAD^2)

# Assert the parent order against the event payload rather than trusting it.
PR_HEAD_SHA="${PR_HEAD_SHA:-}"
if [ "$P2" = "$PR_HEAD_SHA" ]; then
  BASE="$P1"
elif [ "$P1" = "$PR_HEAD_SHA" ]; then
  BASE="$P2"
else
  echo "::warning::neither parent of the merge ref is the PR head ($PR_HEAD_SHA) — the merge ref is probably stale. Not evaluated; push to the branch to refresh it."
  exit 0
fi

git diff --quiet "$BASE" HEAD
DIFF_STATUS=$?
if [ "$DIFF_STATUS" -gt 1 ]; then
  echo "::warning::git diff $BASE HEAD failed (status $DIFF_STATUS) — the merge result could not be evaluated."
  exit 0
fi
if [ "$DIFF_STATUS" -eq 1 ]; then
  CHANGED=$(git diff --name-only "$BASE" HEAD | wc -l)
  echo "✓ merging this PR changes $CHANGED file(s) against $PR_BASE_REF"
  exit 0
fi

BRANCH_FILES="${PR_CHANGED_FILES:-0}"

{
  echo "## ❌ Merging this PR would change nothing"
  echo ""
  echo "The merge result is byte-identical to \`$PR_BASE_REF\`, so squashing this PR"
  echo "would land an **empty commit** — a green check, a closed ticket, and no change."
  echo ""
  if [ "$BRANCH_FILES" -gt 0 ]; then
    echo "**The content is already on \`$PR_BASE_REF\`.** The Files-changed tab still shows"
    echo "$BRANCH_FILES file(s) because that is the three-dot diff against this branch's fork"
    echo "point — another PR has landed this same content since."
    echo ""
    echo "Almost certainly a duplicate PR. Find the PR that landed it"
    echo "(\`git log --oneline $PR_BASE_REF -- <a file this PR touches>\`), close this one and"
    echo "point its ticket there. If the change is still missing from \`$PR_BASE_REF\`, open a"
    echo "PR from a branch cut fresh off it."
  else
    echo "**This branch's own commits cancel out.** Its three-dot diff against"
    echo "\`$PR_BASE_REF\` is empty too, so there was never anything to merge."
    echo ""
    echo "Close this PR, or push the change it was supposed to carry."
  fi
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

if [ "$BRANCH_FILES" -gt 0 ]; then
  echo "::error::merging PR #${PR_NUMBER:-?} would produce an EMPTY commit — its content is already on $PR_BASE_REF (the Files-changed tab shows $BRANCH_FILES file(s) only because that is the three-dot diff). This is probably a duplicate PR; close it. See the job summary."
else
  echo "::error::merging PR #${PR_NUMBER:-?} would produce an EMPTY commit — this branch's commits cancel out, so it has nothing to merge. See the job summary."
fi
exit 1

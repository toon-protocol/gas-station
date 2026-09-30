/mattpocock-skills:implement {{ISSUE_URL}}

You are running AFK in a sandbox, on branch `{{BRANCH}}`, which is already checked out.
Nobody will answer a question, so do not ask one. Treat the issue, its comments and its
parent spec (if it has one) as settled. Read them with `gh issue view {{ISSUE_NUMBER}} --comments`.

Commit to `{{BRANCH}}`, and reference `#{{ISSUE_NUMBER}}` in each commit message. Do not
push, open a PR or close the issue. The runner does all three once you finish.

## This repository

- `CLAUDE.md` covers how this app is built and what its guards are for. Read it first: this
  process signs transactions other people wrote, with a funded key.
- Never widen a whitelist to make a caller's transaction work. A policy refusal is an accepted
  job with a machine-readable `reason`, not a transport reject.
- No test may touch a live chain. Both handler suites inject stub RPC seams.
- It is a single-package pnpm repo (`pnpm@8.15.9`, Node 22). Dependencies are already installed.
- After you finish, the runner runs CI's `build` job itself and won't open a PR while it is red:
  `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint` and `pnpm test`.
  Run them yourself before you commit. Never weaken, skip or delete a test, and never loosen a
  lint, to get green. `pnpm test` also runs the deploy bundle's guards (`deploy/*.test.ts`).
- Anything in `deploy/` or the connector pin is a change to a live box's bundle. Check
  `src/deploy-bundle-guard.test.ts` before touching it.

## When you cannot finish

Stop only when a genuinely new decision is needed, the action is irreversible, it touches
real funds or a live box, or it needs a credential the sandbox doesn't have. In that case,
commit nothing and explain what blocks you in a comment on the issue
(`gh issue comment {{ISSUE_NUMBER}}`). The runner moves an issue with no commits to
`needs-triage`.

If your context is getting full (around 150k tokens) before you are done, commit what works,
write the remaining steps to `.sandcastle/logs/handoff-{{ISSUE_NUMBER}}.md`, commit it with
`git add -f`, and end your turn. A fresh session continues from your commits.

When the ticket is done and committed, output <promise>COMPLETE</promise>.

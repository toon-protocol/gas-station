# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the
codebase. This repo is **single-context**, and small: one app, one container.

## Before exploring, read these

- **`CLAUDE.md`** at the repo root. It says what the app is, what its guards are for, and how
  it is built and deployed. The module comments in `src/` carry the argument for each
  inspection rule, cap and whitelist.
- **`deploy/README.md`**, for anything touching the box bundle.

This repo has no `CONTEXT.md`, no `CONTEXT-MAP.md` and no `docs/adr/` of its own. The protocol
vocabulary (connector, app, handler, route termination, claims) and the decisions behind it live
in [`toon-protocol/connector`](https://github.com/toon-protocol/connector): its `CONTEXT.md` is the
glossary and its `docs/adr/` holds the ADRs. This app trusts the connector's payment verdict and
never validates a claim itself.

If a file above doesn't exist, **proceed silently**. Don't flag its absence; don't suggest
creating it upfront. The `/domain-modeling` skill creates `CONTEXT.md` and ADRs lazily when
terms or decisions actually get resolved.

## File structure

```
/
├── CLAUDE.md
├── src/          ← the app, and its tests beside it
├── deploy/       ← the gas-station box bundle, and the tests that guard it
└── docs/agents/  ← issue tracker, triage labels, domain docs conventions
```

## Use the glossary's vocabulary

When your output names a domain concept, use the connector's term. It calls the service behind a
route the **app** (or **handler**, for the HTTP endpoint specifically), never "terminator", "BLS"
or "agent runtime". If a concept isn't in the glossary yet, either you're inventing language the
project doesn't use (reconsider) or there's a real gap.

## Flag ADR conflicts

If your output contradicts an ADR in the connector repo, surface it explicitly rather than
silently overriding it.

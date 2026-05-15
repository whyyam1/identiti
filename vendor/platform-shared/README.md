# @kmv/platform-shared

Shared utilities for the KMV Platform Rails. Consumed by all three rail APIs (Kipkiren Pay, Identiti, Todoku) and by any internal tooling that needs to talk to them.

## What's in here

| Module | Purpose | Spec |
|---|---|---|
| `ulid` | ULID generation for canonical platform identifiers | Instruction Pack §2.1 |
| `money` | KES minor-units type, integer arithmetic, formatting helpers | Instruction Pack §2.2; Reboot Pack §9.2 |
| `hmac` | HMAC-SHA-256 canonical-string construction, signing, verification, timestamp checks | Instruction Pack §2.3, §4.1 |
| `idempotency` | Idempotency-store interface (Redis or Supabase implementations live in each rail) | Instruction Pack §2.4 |
| `envelope` | Response envelope builder — `{ok, data, meta}` and `{ok, error, meta}` | Instruction Pack §2.5; Reboot Pack §9.4 |
| `trace` | W3C Trace Context (Traceparent) parsing and generation | Instruction Pack §2.6; Reboot Pack §5 |
| `fastify-auth` | Fastify plugin: HMAC verification + scope check; instantiated per rail with rail-specific config | Instruction Pack §2.7, §4 |
| `fastify-idempotency` | Fastify plugin: idempotency middleware over a pluggable store | Instruction Pack §2.8 |

## Why this is a separate package

The Reboot Pack mandates that **every rail implements identical conventions** for authentication (HMAC), identifiers (ULID), money (KES minor units), responses (envelope shape), and tracing (W3C Traceparent). Three subtly-different HMAC verifiers across three rails is exactly how you ship a security bug. One package, one source of truth, three consumers.

## Consumption

This package is published privately. Two consumption modes are supported:

### Mode A — Published private package (recommended)

```jsonc
// in each rail's package.json
"dependencies": {
  "@kmv/platform-shared": "^0.1.0"
}
```

Publish target is determined at the first `npm publish` run. Options under consideration: GitHub Packages (private, free for the org), private npm registry, or self-hosted Verdaccio. **Decision pending.**

### Mode B — Path dependency (interim, while monorepo question is open)

```jsonc
// in each rail's package.json, when the rails live as siblings
"dependencies": {
  "@kmv/platform-shared": "file:../platform-shared"
}
```

This works for local development but does not survive separate-repo deployment to Railway. Use Mode A in production.

## Build

```sh
pnpm install
pnpm build      # emits dist/
pnpm test       # runs Vitest suite
pnpm typecheck  # type-only check, no emit
```

## Coverage targets

Per Instruction Pack §10.1:

- Every utility: 90% line coverage minimum.
- HMAC module: 100% — every error path must be tested.
- Envelope and idempotency middleware: 100%.

These are floors, not goals.

## Repo status

This folder is the package skeleton. Source modules are stubbed in `src/` with the export shapes described in the Instruction Pack §2. Implementations land in the build sprint per the sequence in Instruction Pack §12 (step 1: build this package to completion before any rail can consume it).

## Authoritative source documents

If anything in this README conflicts with the documents below, the source documents win and this README is wrong:

1. `Claude_Code_Instruction_Pack_Platform_Rails_v1_0.md` §2 — module specs
2. `Claude_Code_Instruction_Pack_Platform_Rails_v1_0.md` §4 — auth implementation
3. `Platform_Rails_Reboot_Pack_v1_2.md` §9 — platform-wide standards (identifiers, money, timestamps, envelope, audit, secrets)

---

*Programme: KMV Platform Rails · Read the Reboot Pack first.*

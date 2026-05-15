# Vendored: `@kmv/platform-shared`

This directory is a **vendored copy** of `@kmv/platform-shared` — the shared
utility package consumed by every KMV Platform Rail (HMAC, ULID, money,
envelope, traceparent, idempotency, Fastify auth/idempotency plugins).

## Why it's here

`@kmv/platform-shared` lives as a sibling folder during local development
(`C:\Projects\platform-shared\`) and Identiti depended on it via a
`file:../platform-shared` path. That path **does not survive deployment** —
Railway clones only the `identiti` GitHub repo, so the sibling folder is not
present and `pnpm install` fails (see the `platform-shared` README, "Mode B").

Vendoring the built package into the repo makes Identiti **self-contained and
deployable** with no private registry and no auth token.

## What's here

- `dist/` — the compiled output (`.js` + `.d.ts` + source maps), copied
  verbatim from `platform-shared/dist/`.
- `package.json` — a trimmed consumer manifest: the `exports` map, runtime
  `dependencies` (`ulid`, `fastify-plugin`), and the optional `fastify` peer.
  Build scripts and devDependencies are dropped — this is a built artefact,
  not a dev project.

Identiti's `package.json` references it as `"@kmv/platform-shared": "file:./vendor/platform-shared"`.

## Source of truth

The canonical source is `C:\Projects\platform-shared\` — **not this copy**.
Do not hand-edit anything under `vendor/`.

## Re-vendoring (when platform-shared changes)

```sh
# in platform-shared:
pnpm build

# in identiti:
rm -rf vendor/platform-shared/dist
cp -r ../platform-shared/dist vendor/platform-shared/dist
# bump the version in vendor/platform-shared/package.json if it changed
pnpm install      # refreshes pnpm-lock.yaml
pnpm test         # confirm nothing broke
```

## Migration path

Vendoring is the **interim** answer. The canonical long-term plan
(`platform-shared` README, "Mode A") is to publish `@kmv/platform-shared` to a
private registry — GitHub Packages is the front-runner — so all four rails
consume one published version instead of each vendoring its own copy. When
that lands, delete this directory and depend on the published version.

# Identiti

The **identity rail** for the KMV Platform Rails programme. Source of truth for the **Account UUID** — the universal foreign key every other rail and every consuming app uses to identify a customer.

| | |
|---|---|
| **Function** | KYC tier signal, IPRS verification, Account UUID issuance, step-up authentication, behavioural biometrics, sanctions/PEP screening, phone management |
| **Legal entity** | Identiti Ltd *(home decision pending counsel; recommendation: separate entity from incorporation)* |
| **Regulator** | DPA 2019; CA-K where applicable. Heaviest PII surface on the platform |
| **Domain** | `identiti.co.ke` |
| **Stack** | Node.js 22 LTS · TypeScript 5.x strict · Fastify 4.x · AJV · PostgreSQL 16 (Supabase, `af-south-1`) · Drizzle ORM · Kafka (`kafkajs`) · Railway |

## Where things live

| What | Where |
|---|---|
| **Integration map** — how this rail relates to Kipkiren Pay and Todoku | [`docs/INTEGRATION_MAP.md`](docs/INTEGRATION_MAP.md) |
| **Rail contract** (locked v1.0 — endpoint list, error codes, JSON schemas) | `platform-rails-docs/Identiti_Rail_Contract_v1.0_Scaffold.md` and `..._Schema_Appendix.md` |
| **Build brief** (stack, schemas, endpoint order, handoff checklist) | `platform-rails-docs/Claude_Code_Instruction_Pack_Platform_Rails_v1_0.md` §6 |
| **Programme canonical record** | `platform-rails-docs/Platform_Rails_Reboot_Pack_v1_2.md` §7 |

`platform-rails-docs/` is the canonical docs repo. Clone it as a sibling of this folder.

## Cardinal rule

> Identiti owns identity. It does not hold customer funds. It does not run SMS infrastructure.
>
> Identiti is the **root of the trust graph** — Kipkiren Pay and Todoku depend on it; it depends on neither.

See [`docs/INTEGRATION_MAP.md`](docs/INTEGRATION_MAP.md) §2 for the full list of what Identiti must NOT do.

## Repo status

ID-1 (Foundation) closed 8 May 2026: Fastify scaffold, HMAC auth middleware (rail prefix `Identiti`), idempotency middleware, `GET /v1/health`, migrations 0001–0003 (universal + accounts + phones + sessions). 50/50 tests pass; typecheck clean. mTLS termination is deferred to Stage 1 edge deployment. ID-2/ID-3/ID-5-partial/ID-8/ID-9-partial code is present ahead-of-schedule and pending contract-drift audit before formal close — see `RECAP.md` §2 / §5. Identiti's step-up endpoints (Phase 5) and phone-token endpoints (Phase 6) remain the sync points the other two rails block on.

---

*Programme: KMV Platform Rails · Read the Reboot Pack first.*

/**
 * ID-10 (H4 joint with Helpan AI) — POST /v1/internal/sign.
 *
 * Identiti signs the delegated-authority claim set Helpan AI submits, using
 * the dedicated delegated-authority RS256 key. Verifies the wire contract in
 * Helpan AI Delegated Authority Contract §2 (token format), §6.3 (signing
 * API), §8.2 (the H4-pending integration point this sprint closes).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jwtVerify, createLocalJWKSet, decodeProtectedHeader } from 'jose';
import { generateUlid } from '@kmv/platform-shared';
import { buildCanonicalString, sha256Hex, signRequest } from '@kmv/platform-shared/hmac';
import { buildApp, type App } from '../src/app.js';
import { buildJwks } from '../src/services/jwtKeys.js';
import {
  makeTestDeps,
  makeMemCredStore,
  TEST_APP_ID,
  TEST_HMAC_SECRET,
  TEST_HELPAN_AI_APP_ID,
  TEST_HELPAN_AI_HMAC_SECRET,
  type TestDepsBundle,
} from './helpers.js';

const ISSUER = 'https://api.id.identiti.co.ke';
const DA_KID = 'helpan-da-2026-q2-test';
const HELPAN_AUD = 'https://api.helpan.co.ke';
const KP_AUD = 'https://api.pay.kipkiren.co.ke';

/** HMAC-sign a request as a given tenant. */
function signAs(
  appId: string,
  secret: string,
  opts: { method: string; url: string; body?: string; idempotencyKey?: string },
): Record<string, string> {
  const body = opts.body ?? '';
  const contentType = body ? 'application/json; charset=utf-8' : '';
  const ts = new Date().toISOString();
  const canonical = buildCanonicalString({
    method: opts.method,
    pathAndQuery: opts.url,
    contentType,
    timestamp: ts,
    bodySha256Hex: sha256Hex(body),
  });
  const sig = signRequest(canonical, secret);
  const headers: Record<string, string> = {
    authorization: `Identiti-HMAC-SHA256 app_id=${appId}, signature=${sig}`,
    'x-identiti-timestamp': ts,
  };
  if (contentType) headers['content-type'] = contentType;
  if (opts.idempotencyKey) headers['x-idempotency-key'] = opts.idempotencyKey;
  return headers;
}

async function createCustomer(app: App, phone: string): Promise<string> {
  const body = JSON.stringify({
    phone,
    name_first: 'A',
    name_last: 'B',
    consent: { dpa_consent: true, kyc_consent: true, captured_at: new Date().toISOString() },
    app_correlation: `corr_${Math.random().toString(36).slice(2)}`,
  });
  const r = await app.inject({
    method: 'POST',
    url: '/v1/customers',
    headers: signAs(TEST_APP_ID, TEST_HMAC_SECRET, {
      method: 'POST',
      url: '/v1/customers',
      body,
      idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
    }),
    payload: body,
  });
  if (r.statusCode !== 201) throw new Error(`createCustomer failed: ${r.statusCode} ${r.body}`);
  return r.json().data.account_uuid as string;
}

/** Build a valid delegated-authority claim set per §2.3. */
function daClaims(
  sub: string,
  overrides: Partial<{
    iss: string;
    aud: string[];
    iat: number;
    exp: number;
    jti: string;
    token_class: string;
    scopes: unknown[];
    step_up_jti: string;
  }> = {},
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const jti = overrides.jti ?? `daa_${generateUlid()}`;
  return {
    iss: overrides.iss ?? ISSUER,
    aud: overrides.aud ?? [HELPAN_AUD, KP_AUD],
    sub,
    iat: overrides.iat ?? now,
    exp: overrides.exp ?? now + 3600,
    jti,
    token_class: overrides.token_class ?? 'delegated_authority',
    actor: { type: 'agent', agent_id: `agt_${generateUlid()}` },
    initiated_by: 'agent',
    scopes: overrides.scopes ?? [
      {
        scope_id: 'kipkiren.write.payments',
        amount_limit_minor: 500_000,
        per_period_limit_minor: 5_000_000,
        period: 'weekly',
      },
    ],
    ...(overrides.step_up_jti ? { step_up_jti: overrides.step_up_jti } : {}),
    revocation_endpoint: `${HELPAN_AUD}/v1/authorities/${jti}/validate`,
  };
}

function postSign(app: App, appId: string, secret: string, payload: object) {
  const body = JSON.stringify(payload);
  return app.inject({
    method: 'POST',
    url: '/v1/internal/sign',
    headers: signAs(appId, secret, {
      method: 'POST',
      url: '/v1/internal/sign',
      body,
      idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
    }),
    payload: body,
  });
}

describe('POST /v1/internal/sign', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('signs a delegated-authority token verifiable against JWKS by its kid', async () => {
    const sub = await createCustomer(app, '+254712360001');
    const claims = daClaims(sub);

    const res = await postSign(app, TEST_HELPAN_AI_APP_ID, TEST_HELPAN_AI_HMAC_SECRET, {
      kid: DA_KID,
      claims,
    });

    expect(res.statusCode).toBe(200);
    const env = res.json();
    expect(typeof env.data.token).toBe('string');
    expect(typeof env.data.signed_at).toBe('string');

    // Header carries the delegated-authority kid (distinct from step-up keys).
    expect(decodeProtectedHeader(env.data.token as string).kid).toBe(DA_KID);

    // Verifies against the published JWKS — the kid selects the DA key.
    const jwks = await buildJwks(deps.jwtKeys);
    const keyset = createLocalJWKSet(jwks as unknown as Parameters<typeof createLocalJWKSet>[0]);
    const verified = await jwtVerify(env.data.token as string, keyset, {
      issuer: ISSUER,
      audience: HELPAN_AUD,
    });
    expect(verified.payload.sub).toBe(sub);
    expect(verified.payload.jti).toBe(claims.jti);
    expect(verified.payload.token_class).toBe('delegated_authority');
    expect(verified.payload.initiated_by).toBe('agent');
    expect((verified.payload.actor as { type: string }).type).toBe('agent');
    expect(Array.isArray(verified.payload.scopes)).toBe(true);

    // Durable audit row written.
    const row = await deps.delegatedAuthoritySigningsRepo.findByJti(claims.jti as string);
    expect(row).not.toBeNull();
    expect(row!.accountUuid).toBe(sub);
    expect(row!.kid).toBe(DA_KID);
    expect(row!.callerAppId).toBe(TEST_HELPAN_AI_APP_ID);

    // Audit-log entry written.
    expect(
      deps.auditLogger.entries.some((e) => e.action === 'internal.sign.delegated_authority'),
    ).toBe(true);
  });

  it('rejects a caller without the internal-sign scope (403)', async () => {
    const sub = await createCustomer(app, '+254712360002');
    const res = await postSign(app, TEST_APP_ID, TEST_HMAC_SECRET, {
      kid: DA_KID,
      claims: daClaims(sub),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUTH_SCOPE_INSUFFICIENT');
  });

  it('rejects a scoped caller that is not the pinned Helpan AI tenant (403)', async () => {
    // Contrived cred store: grant the internal-sign scope to the ordinary app.
    await app.close();
    const base = makeMemCredStore();
    deps = makeTestDeps({
      credentialStore: {
        async lookup(appId) {
          const r = await base.lookup(appId);
          if (!r || appId !== TEST_APP_ID) return r;
          return {
            ...r,
            record: {
              ...r.record,
              scopes: [...r.record.scopes, 'identiti:internal:sign:delegated_authority'],
            },
          };
        },
      },
    });
    app = await buildApp(deps);

    const sub = await createCustomer(app, '+254712360003');
    const res = await postSign(app, TEST_APP_ID, TEST_HMAC_SECRET, {
      kid: DA_KID,
      claims: daClaims(sub),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUTH_SCOPE_INSUFFICIENT');
  });

  it('rejects an unknown kid (400 kid_unknown)', async () => {
    const sub = await createCustomer(app, '+254712360004');
    const res = await postSign(app, TEST_HELPAN_AI_APP_ID, TEST_HELPAN_AI_HMAC_SECRET, {
      kid: 'helpan-da-does-not-exist',
      claims: daClaims(sub),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('kid_unknown');
  });

  it('rejects a money-scope token whose TTL exceeds the 1-hour class max', async () => {
    const sub = await createCustomer(app, '+254712360005');
    const now = Math.floor(Date.now() / 1000);
    const res = await postSign(app, TEST_HELPAN_AI_APP_ID, TEST_HELPAN_AI_HMAC_SECRET, {
      kid: DA_KID,
      claims: daClaims(sub, { iat: now, exp: now + 7200 }), // 2h > 3600 money cap
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('expiry_out_of_bounds');
  });

  it('rejects an issuer that is not the Identiti literal', async () => {
    const sub = await createCustomer(app, '+254712360006');
    const res = await postSign(app, TEST_HELPAN_AI_APP_ID, TEST_HELPAN_AI_HMAC_SECRET, {
      kid: DA_KID,
      claims: daClaims(sub, { iss: 'https://evil.example.com' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('issuer_mismatch');
  });

  it('rejects a malformed claims payload at schema ingress', async () => {
    const sub = await createCustomer(app, '+254712360007');
    const claims = daClaims(sub);
    delete (claims as Record<string, unknown>).revocation_endpoint;
    const res = await postSign(app, TEST_HELPAN_AI_APP_ID, TEST_HELPAN_AI_HMAC_SECRET, {
      kid: DA_KID,
      claims,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_request_invalid');
  });

  it('rejects an unknown account (404)', async () => {
    const res = await postSign(app, TEST_HELPAN_AI_APP_ID, TEST_HELPAN_AI_HMAC_SECRET, {
      kid: DA_KID,
      claims: daClaims('acc_00000000-0000-4000-8000-000000000000'),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('customer_not_found');
  });

  it('allows a read-only scope token up to the 24-hour class max', async () => {
    const sub = await createCustomer(app, '+254712360008');
    const now = Math.floor(Date.now() / 1000);
    const res = await postSign(app, TEST_HELPAN_AI_APP_ID, TEST_HELPAN_AI_HMAC_SECRET, {
      kid: DA_KID,
      claims: daClaims(sub, {
        iat: now,
        exp: now + 86_400,
        scopes: [{ scope_id: 'kipkiren.read.aggregate' }],
      }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('consumes a supplied step-up JTI single-use; replay returns 409', async () => {
    const sub = await createCustomer(app, '+254712360009');
    const stepUpJti = `stp_${generateUlid()}`;
    const now = new Date();
    await deps.stepUpTokensRepo.create({
      jti: stepUpJti,
      accountUuid: sub,
      challengeId: stepUpJti,
      audience: 'helpan_authority_issuance',
      operationKind: 'helpan_ai.authority_issuance',
      operationRiskTier: 'high',
      factor: 'phone_otp',
      env: 'test',
      iat: now,
      exp: new Date(now.getTime() + 300_000),
    });

    const first = await postSign(app, TEST_HELPAN_AI_APP_ID, TEST_HELPAN_AI_HMAC_SECRET, {
      kid: DA_KID,
      claims: daClaims(sub, { step_up_jti: stepUpJti }),
    });
    expect(first.statusCode).toBe(200);

    const replay = await postSign(app, TEST_HELPAN_AI_APP_ID, TEST_HELPAN_AI_HMAC_SECRET, {
      kid: DA_KID,
      claims: daClaims(sub, { step_up_jti: stepUpJti }),
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe('step_up_token_already_used');
  });

  it('rejects a step-up JTI bound to a different account', async () => {
    const subA = await createCustomer(app, '+254712360010');
    const subB = await createCustomer(app, '+254712360011');
    const stepUpJti = `stp_${generateUlid()}`;
    const now = new Date();
    await deps.stepUpTokensRepo.create({
      jti: stepUpJti,
      accountUuid: subB, // bound to B
      challengeId: stepUpJti,
      audience: 'helpan_authority_issuance',
      operationKind: 'helpan_ai.authority_issuance',
      operationRiskTier: 'high',
      factor: 'phone_otp',
      env: 'test',
      iat: now,
      exp: new Date(now.getTime() + 300_000),
    });
    const res = await postSign(app, TEST_HELPAN_AI_APP_ID, TEST_HELPAN_AI_HMAC_SECRET, {
      kid: DA_KID,
      claims: daClaims(subA, { step_up_jti: stepUpJti }), // claims A
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('step_up_token_subject_mismatch');
  });

  it('rejects an unknown step-up JTI', async () => {
    const sub = await createCustomer(app, '+254712360012');
    const res = await postSign(app, TEST_HELPAN_AI_APP_ID, TEST_HELPAN_AI_HMAC_SECRET, {
      kid: DA_KID,
      claims: daClaims(sub, { step_up_jti: `stp_${generateUlid()}` }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('step_up_token_unknown');
  });
});

/**
 * ID-10 — request-side `actor` + `initiated_by` on /v1/stepup/challenges, and
 * the `helpan_authority_issuance` step-up audience.
 *
 * Schema Appendix Amendment §A.1/§A.2: an app dispatching a step-up on behalf
 * of a Helpan AI agent populates `actor` + `initiated_by`; the values ride
 * through the challenge, the STEP_UP_REQUIRED event, and end up as claims on
 * the issued step-up JWT (so KP/Todoku audit them per Reboot Pack §A.2).
 *
 * The `helpan_authority_issuance` audience + `helpan_ai.authority_issuance`
 * operation kind are the §8.3 additions that let a step-up token authorise
 * the act of granting delegated authority.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jwtVerify, createLocalJWKSet } from 'jose';
import { generateUlid } from '@kmv/platform-shared';
import { buildCanonicalString, sha256Hex, signRequest } from '@kmv/platform-shared/hmac';
import { buildApp, type App } from '../src/app.js';
import { buildJwks } from '../src/services/jwtKeys.js';
import { makeTestDeps, TEST_APP_ID, TEST_HMAC_SECRET, type TestDepsBundle } from './helpers.js';

const ISSUER = 'https://api.id.identiti.co.ke';
const HELPAN_AUDIENCE = 'helpan_authority_issuance';

function signed(opts: {
  method: string;
  url: string;
  body?: string;
  idempotencyKey?: string;
}): Record<string, string> {
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
  const sig = signRequest(canonical, TEST_HMAC_SECRET);
  const headers: Record<string, string> = {
    authorization: `Identiti-HMAC-SHA256 app_id=${TEST_APP_ID}, signature=${sig}`,
    'x-identiti-timestamp': ts,
  };
  if (contentType) headers['content-type'] = contentType;
  if (opts.idempotencyKey) headers['x-idempotency-key'] = opts.idempotencyKey;
  return headers;
}

describe('ID-10 — stepup actor/initiated_by + helpan_authority_issuance', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  async function createActiveCustomer(phone: string): Promise<string> {
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
      headers: signed({
        method: 'POST',
        url: '/v1/customers',
        body,
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
      payload: body,
    });
    if (r.statusCode !== 201) throw new Error(`createCustomer failed: ${r.statusCode} ${r.body}`);
    const accountUuid = r.json().data.account_uuid as string;
    const ok = await deps.customersRepo.changeState(accountUuid, ['pending_onboarding'], 'active');
    if (!ok) throw new Error('failed to activate test account');
    return accountUuid;
  }

  function initiate(account: string, body: Record<string, unknown>) {
    const payload = JSON.stringify({ account_uuid: account, ...body });
    return app.inject({
      method: 'POST',
      url: '/v1/stepup/challenges',
      headers: signed({
        method: 'POST',
        url: '/v1/stepup/challenges',
        body: payload,
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
      payload,
    });
  }

  const agentId = `agt_${generateUlid()}`;
  const daJti = `daa_${generateUlid()}`;

  it('accepts the helpan_authority_issuance audience + operation kind', async () => {
    const account = await createActiveCustomer('+254712370001');
    const res = await initiate(account, {
      operation_audience: HELPAN_AUDIENCE,
      operation_kind: 'helpan_ai.authority_issuance',
      operation_risk_tier: 'high',
      factor: 'phone_otp',
    });
    expect(res.statusCode).toBe(201);
  });

  it('carries actor + initiated_by onto the STEP_UP_REQUIRED event', async () => {
    const account = await createActiveCustomer('+254712370002');
    const res = await initiate(account, {
      operation_audience: HELPAN_AUDIENCE,
      operation_kind: 'helpan_ai.authority_issuance',
      operation_risk_tier: 'high',
      factor: 'phone_otp',
      actor: { type: 'agent', agent_id: agentId, delegated_authority_jti: daJti },
      initiated_by: 'agent',
    });
    expect(res.statusCode).toBe(201);
    const challengeId = res.json().data.challenge_id as string;

    const event = deps.eventProducer.events.find(
      (e) => e.type === 'STEP_UP_REQUIRED' && e.data.challenge_id === challengeId,
    );
    expect(event).toBeDefined();
    expect(event!.data.actor).toEqual({
      type: 'agent',
      agent_id: agentId,
      delegated_authority_jti: daJti,
    });
    expect(event!.data.initiated_by).toBe('agent');
  });

  it('stamps actor + initiated_by into the issued step-up JWT and step_up_tokens row', async () => {
    const account = await createActiveCustomer('+254712370003');
    const initRes = await initiate(account, {
      operation_audience: HELPAN_AUDIENCE,
      operation_kind: 'helpan_ai.authority_issuance',
      operation_risk_tier: 'high',
      factor: 'phone_otp',
      actor: { type: 'agent', agent_id: agentId, delegated_authority_jti: daJti },
      initiated_by: 'agent',
    });
    expect(initRes.statusCode).toBe(201);
    const challengeId = initRes.json().data.challenge_id as string;
    const event = deps.eventProducer.events.find(
      (e) => e.type === 'STEP_UP_REQUIRED' && e.data.challenge_id === challengeId,
    );
    const otp = event!.data.otp_plaintext as string;

    const verifyBody = JSON.stringify({ challenge_id: challengeId, response: otp });
    const verifyRes = await app.inject({
      method: 'POST',
      url: '/v1/stepup/verify',
      headers: signed({
        method: 'POST',
        url: '/v1/stepup/verify',
        body: verifyBody,
        idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
      }),
      payload: verifyBody,
    });
    expect(verifyRes.statusCode).toBe(200);
    const token = verifyRes.json().data.stepup_token as string;

    // JWT carries the §A.1/§A.2 claims.
    const jwks = await buildJwks(deps.jwtKeys);
    const keyset = createLocalJWKSet(jwks as unknown as Parameters<typeof createLocalJWKSet>[0]);
    const verified = await jwtVerify(token, keyset, {
      issuer: ISSUER,
      audience: HELPAN_AUDIENCE,
    });
    expect(verified.payload.actor).toEqual({
      type: 'agent',
      agent_id: agentId,
      delegated_authority_jti: daJti,
    });
    expect(verified.payload.initiated_by).toBe('agent');

    // Durable copy persisted on step_up_tokens.
    const row = await deps.stepUpTokensRepo.findByJti(challengeId);
    expect(row).not.toBeNull();
    expect(row!.actor).toEqual({
      type: 'agent',
      agentId,
      delegatedAuthorityJti: daJti,
    });
    expect(row!.initiatedBy).toBe('agent');
  });

  it('omits actor/initiated_by when not supplied (backward-compatible)', async () => {
    const account = await createActiveCustomer('+254712370004');
    const res = await initiate(account, {
      operation_audience: 'https://api.pay.kipkiren.com',
      operation_kind: 'kipkiren_pay.redemption',
      operation_risk_tier: 'medium',
      factor: 'phone_otp',
    });
    expect(res.statusCode).toBe(201);
    const challengeId = res.json().data.challenge_id as string;
    const event = deps.eventProducer.events.find(
      (e) => e.type === 'STEP_UP_REQUIRED' && e.data.challenge_id === challengeId,
    );
    expect(event!.data.actor).toBeUndefined();
    expect(event!.data.initiated_by).toBeUndefined();
  });

  it('rejects a malformed agent_id in actor', async () => {
    const account = await createActiveCustomer('+254712370005');
    const res = await initiate(account, {
      operation_audience: HELPAN_AUDIENCE,
      operation_kind: 'helpan_ai.authority_issuance',
      operation_risk_tier: 'high',
      factor: 'phone_otp',
      actor: { type: 'agent', agent_id: 'not-an-agent-id' },
      initiated_by: 'agent',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_request_invalid');
  });
});

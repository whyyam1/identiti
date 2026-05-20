/**
 * GET /v1/customers/:uuid/tier/history — Schema Appendix §6.4.
 *
 * One row per tier ASSIGNMENT (period the account spent at that tier). The
 * current assignment has no ended_at. Newest first; opaque cursor pagination.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCanonicalString, sha256Hex, signRequest } from '@kmv/platform-shared/hmac';
import { buildApp, type App } from '../src/app.js';
import {
  makeMemCredStore,
  makeTestDeps,
  TEST_APP_ID,
  TEST_HMAC_SECRET,
  type TestDepsBundle,
} from './helpers.js';

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

describe('GET /v1/customers/:uuid/tier/history', () => {
  let app: App;
  let deps: TestDepsBundle;

  beforeEach(async () => {
    deps = makeTestDeps();
    app = await buildApp(deps);
  });

  afterEach(async () => {
    await app.close();
  });

  async function createCustomer(phone: string): Promise<string> {
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
    if (r.statusCode !== 201) throw new Error(`createCustomer: ${r.statusCode} ${r.body}`);
    return r.json().data.account_uuid as string;
  }

  function getHistory(uuid: string, query = '') {
    const url = `/v1/customers/${uuid}/tier/history${query}`;
    return app.inject({ method: 'GET', url, headers: signed({ method: 'GET', url }) });
  }

  it('seeds the initial tier_0 assignment on account creation', async () => {
    const uuid = await createCustomer('+254712390001');
    const res = await getHistory(uuid);
    expect(res.statusCode).toBe(200);
    const env = res.json();
    expect(env.ok).toBe(true);
    expect(env.data.items).toHaveLength(1);
    const a = env.data.items[0];
    expect(a.tier).toBe('tier_0');
    expect(a.reason).toBe('rule_based_tier_0_default');
    expect(typeof a.assignment_id).toBe('string');
    expect(a.assignment_id).toMatch(/^tas_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.ended_at).toBeUndefined();
    expect(env.data.cursor).toBeNull();
  });

  it('closes the prior assignment and opens a new one on setTier', async () => {
    const uuid = await createCustomer('+254712390002');
    // Small sleep so assigned_at moves forward and orderings are stable.
    await new Promise((r) => setTimeout(r, 5));
    const change = await deps.customersRepo.setTier(
      uuid,
      'tier_1',
      'rule_based_tier_1_kyc_complete',
    );
    expect(change?.toTier).toBe('tier_1');

    const env = (await getHistory(uuid)).json();
    expect(env.data.items).toHaveLength(2);
    // Newest first.
    const items = env.data.items as Array<{
      tier: string;
      ended_at?: string;
      reason: string;
    }>;
    const current = items[0]!;
    const prior = items[1]!;
    expect(current.tier).toBe('tier_1');
    expect(current.ended_at).toBeUndefined();
    expect(current.reason).toBe('rule_based_tier_1_kyc_complete');
    expect(prior.tier).toBe('tier_0');
    expect(typeof prior.ended_at).toBe('string');
    expect(prior.reason).toBe('rule_based_tier_0_default');
  });

  it('records a full promotion sequence — exactly one open assignment at the end', async () => {
    const uuid = await createCustomer('+254712390003');
    await new Promise((r) => setTimeout(r, 5));
    await deps.customersRepo.setTier(uuid, 'tier_1', 'rule_based_tier_1_kyc_complete');
    await new Promise((r) => setTimeout(r, 5));
    await deps.customersRepo.setTier(uuid, 'tier_2', 'operator_tier_2_approval');

    const items = (await getHistory(uuid)).json().data.items as Array<{
      tier: string;
      ended_at?: string;
    }>;
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.tier)).toEqual(['tier_2', 'tier_1', 'tier_0']);
    // Exactly one open assignment — the current one (newest).
    const open = items.filter((i) => i.ended_at === undefined);
    expect(open).toHaveLength(1);
    expect(open[0]!.tier).toBe('tier_2');
  });

  it('paginates with ?limit and ?cursor', async () => {
    const uuid = await createCustomer('+254712390004');
    // Drive 4 promotions on top of the initial assignment → 5 total items.
    const promotions: Array<['tier_1' | 'tier_2', string]> = [
      ['tier_1', 'rule_based_tier_1_kyc_complete'],
      ['tier_2', 'operator_tier_2_approval'],
      ['tier_1', 'operator_demotion_aml'],
      ['tier_2', 'operator_tier_2_approval'],
    ];
    for (const [tier, reason] of promotions) {
      await new Promise((r) => setTimeout(r, 5));
      await deps.customersRepo.setTier(uuid, tier, reason);
    }

    const first = (await getHistory(uuid, '?limit=2')).json();
    expect(first.data.items).toHaveLength(2);
    expect(typeof first.data.cursor).toBe('string');

    const second = (await getHistory(uuid, `?limit=2&cursor=${first.data.cursor}`)).json();
    expect(second.data.items).toHaveLength(2);
    expect(typeof second.data.cursor).toBe('string');

    const third = (await getHistory(uuid, `?limit=2&cursor=${second.data.cursor}`)).json();
    expect(third.data.items).toHaveLength(1); // 5 total - 4 already paged
    expect(third.data.cursor).toBeNull();

    // No overlap and no gaps across pages.
    const allIds = [...first.data.items, ...second.data.items, ...third.data.items].map(
      (i: { assignment_id: string }) => i.assignment_id,
    );
    expect(new Set(allIds).size).toBe(5);
  });

  it('returns 404 for an unknown account', async () => {
    const res = await getHistory('acc_00000000-0000-4000-8000-000000000000');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('customer_not_found');
  });

  it('rejects a malformed account UUID with 400', async () => {
    const res = await getHistory('not-a-uuid');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_account_uuid_invalid');
  });

  it('rejects an out-of-range limit with 400', async () => {
    const uuid = await createCustomer('+254712390005');
    const res = await getHistory(uuid, '?limit=999');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_request_invalid');
  });

  it('rejects a malformed cursor with 400', async () => {
    const uuid = await createCustomer('+254712390006');
    const res = await getHistory(uuid, '?cursor=not-a-tier-assignment');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_request_invalid');
  });

  it('rejects a caller without identiti:tier:read with 403', async () => {
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
              scopes: r.record.scopes.filter((s) => s !== 'identiti:tier:read'),
            },
          };
        },
      },
    });
    app = await buildApp(deps);
    const uuid = await createCustomer('+254712390007');
    const res = await getHistory(uuid);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUTH_SCOPE_INSUFFICIENT');
  });
});

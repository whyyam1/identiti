/**
 * Contract tests — validate live response payloads against the JSON Schemas
 * inlined from Rail Contract Schema Appendix §4. Catches drift between API
 * implementations and the published contract.
 *
 * Phase 1 (foundation) does not have schemas at the appendix level; Sprint 1
 * adds /v1/customers schemas so we start validating now.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCanonicalString, sha256Hex, signRequest } from '@kmv/platform-shared/hmac';
import { buildApp, type App } from '../src/app.js';
import { makeTestDeps, TEST_APP_ID, TEST_HMAC_SECRET } from './helpers.js';
import { createAjv } from '../src/lib/ajv.js';
import {
  createCustomerResponseSchema,
  readCustomerResponseSchema,
} from '../src/schemas/customers.js';

const ajv = createAjv();
const validateCreateResponse = ajv.compile(createCustomerResponseSchema);
const validateReadResponse = ajv.compile(readCustomerResponseSchema);

function signedHeaders(opts: {
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

describe('contract: POST /v1/customers response (Schema Appendix §4.2)', () => {
  let app: App;

  beforeEach(async () => {
    app = await buildApp(makeTestDeps());
  });

  afterEach(async () => {
    await app.close();
  });

  it('matches the JSON schema', async () => {
    const body = JSON.stringify({
      phone: '+254712345678',
      name_first: 'Wanjiru',
      name_last: 'Kamau',
      consent: {
        dpa_consent: true,
        kyc_consent: true,
        captured_at: new Date().toISOString(),
        captured_via: 'app_onboarding',
      },
      app_correlation: 'corr-001',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: signedHeaders({
        method: 'POST',
        url: '/v1/customers',
        body,
        idempotencyKey: 'idem-contract-create',
      }),
      payload: body,
    });
    expect(res.statusCode).toBe(201);

    const data = res.json().data;
    const valid = validateCreateResponse(data);
    if (!valid) {
      throw new Error(
        'Schema validation failed: ' + JSON.stringify(validateCreateResponse.errors)
      );
    }
    expect(valid).toBe(true);
  });
});

describe('contract: GET /v1/customers/{uuid} response (Schema Appendix §4.3)', () => {
  let app: App;

  beforeEach(async () => {
    app = await buildApp(makeTestDeps());
  });

  afterEach(async () => {
    await app.close();
  });

  it('matches the JSON schema', async () => {
    const body = JSON.stringify({
      phone: '+254712345600',
      name_first: 'A',
      name_last: 'B',
      consent: {
        dpa_consent: true,
        kyc_consent: true,
        captured_at: new Date().toISOString(),
      },
      app_correlation: 'corr-002',
    });
    const created = await app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: signedHeaders({
        method: 'POST',
        url: '/v1/customers',
        body,
        idempotencyKey: 'idem-contract-read-setup',
      }),
      payload: body,
    });
    const accountUuid = created.json().data.account_uuid as string;

    const res = await app.inject({
      method: 'GET',
      url: `/v1/customers/${accountUuid}`,
      headers: signedHeaders({
        method: 'GET',
        url: `/v1/customers/${accountUuid}`,
      }),
    });
    expect(res.statusCode).toBe(200);

    const data = res.json().data;
    const valid = validateReadResponse(data);
    if (!valid) {
      throw new Error(
        'Schema validation failed: ' + JSON.stringify(validateReadResponse.errors)
      );
    }
    expect(valid).toBe(true);
  });
});

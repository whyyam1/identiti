/**
 * Identiti end-to-end smoke — a faithful *consuming-app* reproduction.
 *
 * Signs exactly the way the App Integration Guide §21.3/§21.9 documents (the
 * canonical string reproduced inline, NOT imported from @kmv/platform-shared),
 * so a green run proves the documented contract, not just the rail's own helper.
 *
 * Sequence: health → create customer → auth challenge → customer-token →
 *           phone-token → step-up challenge → step-up verify → GET tier (signed GET).
 *
 * Usage:
 *   node scripts/smoke-identiti.mjs
 *
 * Env (all optional):
 *   IDENTITI_API_BASE    default http://localhost:3002
 *   IDENTITI_APP_ID      default lunchdrop_sandbox
 *   IDENTITI_APP_SECRET  the 64-hex HMAC secret; if unset, read from
 *                        secrets/<app_id>.hmac (gitignored, written by db:seed)
 *
 * Requires the tenant's scopes to cover customers:write/read, stepup:request,
 * tier:read (the standard 7-scope integrator set). Non-production only: relies
 * on the sandbox `otp_plaintext` echo to complete OTP + step-up.
 */
import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.IDENTITI_API_BASE || 'http://localhost:3002').replace(/\/$/, '');
const APP_ID = process.env.IDENTITI_APP_ID || 'lunchdrop_sandbox';
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = (
  process.env.IDENTITI_APP_SECRET || readFileSync(join(repoRoot, 'secrets', `${APP_ID}.hmac`), 'utf8')
).trim();

const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const sign = (canonical) => createHmac('sha256', SECRET).update(canonical, 'utf8').digest('base64');

async function call(method, path, body, { signed = true } = {}) {
  const hasBody = body !== undefined;
  const bodyStr = hasBody ? JSON.stringify(body) : '';
  const contentType = hasBody ? 'application/json' : ''; // bodyless GET: no Content-Type, sign empty
  const ts = new Date().toISOString();
  const headers = {};
  if (hasBody) headers['Content-Type'] = 'application/json';
  // Every write (POST/PUT/PATCH/DELETE) requires X-Idempotency-Key (App
  // Integration Guide §21.9.5) — fresh per intent; missing → 400.
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) {
    headers['X-Idempotency-Key'] = randomUUID();
  }
  if (signed) {
    const canonical = [method.toUpperCase(), path, contentType, ts, sha256Hex(bodyStr)].join('\n');
    headers['Authorization'] = `Identiti-HMAC-SHA256 app_id=${APP_ID}, signature=${sign(canonical)}`;
    headers['X-Identiti-Timestamp'] = ts;
  }
  let res, text;
  try {
    res = await fetch(BASE + path, { method, headers, body: hasBody ? bodyStr : undefined });
    text = await res.text();
  } catch (err) {
    return { status: 0, json: { network_error: String(err?.cause?.code || err?.message || err) } };
  }
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

const data = (r) => (r.json && typeof r.json === 'object' && 'data' in r.json ? r.json.data : r.json);
let failed = false;
function show(label, r, ok = (s) => s >= 200 && s < 300) {
  const pass = ok(r.status);
  if (!pass) failed = true;
  const body = typeof r.json === 'object' ? JSON.stringify(r.json) : String(r.json);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${String(r.status).padEnd(3)}  ${label}`);
  if (!pass) console.log(`        ${body.slice(0, 400)}`);
  return r;
}

const phone = '+2547' + String(randomInt(10_000_000, 100_000_000));
console.log(`\nIdentiti smoke → ${BASE}  (tenant ${APP_ID})\n`);

const health = show('GET  /v1/health (unauth)', await call('GET', '/v1/health', undefined, { signed: false }));
console.log(`        environment: ${data(health)?.environment ?? '(unknown)'}`);

const created = show('POST /v1/customers', await call('POST', '/v1/customers', {
  phone, name_first: 'Smoke', name_last: 'Test',
  consent: { dpa_consent: true, kyc_consent: true, captured_at: new Date().toISOString(), captured_via: 'app_onboarding' },
  app_correlation: 'smoke-' + Date.now(),
}));
const uuid = data(created)?.account_uuid;
console.log(`        account_uuid: ${uuid ?? '—'}   phone: ${phone}`);

const ch = show('POST /v1/auth/challenges (login)', await call('POST', '/v1/auth/challenges', {
  phone, factor: 'phone_otp', purpose: 'login',
}));
const loginOtp = data(ch)?.otp_plaintext;
console.log(`        challenge_id: ${data(ch)?.challenge_id ?? '—'}   otp echoed: ${loginOtp ? 'yes' : 'no'}`);

const tok = show('POST /v1/auth/customer-token', await call('POST', '/v1/auth/customer-token', {
  challenge_id: data(ch)?.challenge_id, response: loginOtp, requested_audience: 'https://lunchdrop.co.ke',
}));
console.log(`        JWT sub match: ${data(tok)?.account_uuid === uuid ? 'yes' : 'no'}   token: ${data(tok)?.access_token ? 'issued' : '—'}`);

const pt = show('POST /v1/phone-tokens', await call('POST', '/v1/phone-tokens', { account_uuid: uuid }));
console.log(`        jti: ${data(pt)?.jti ?? '—'}   aud: ${data(pt)?.audience ?? '—'}`);

const su = show('POST /v1/stepup/challenges', await call('POST', '/v1/stepup/challenges', {
  account_uuid: uuid, operation_audience: 'https://pay.kipkiren.co.ke',
  operation_kind: 'kipkiren_pay.redemption', operation_risk_tier: 'medium', factor: 'phone_otp',
}));
const suOtp = data(su)?.otp_plaintext;
console.log(`        challenge_id: ${data(su)?.challenge_id ?? '—'}   sandbox_only: ${data(su)?.sandbox_only ?? '—'}`);

const sv = show('POST /v1/stepup/verify', await call('POST', '/v1/stepup/verify', {
  challenge_id: data(su)?.challenge_id, response: suOtp,
}));
console.log(`        stepup_token: ${data(sv)?.stepup_token ? 'issued' : '—'}   expires_in: ${data(sv)?.expires_in ?? '—'}s`);

const tier = show('GET  /v1/customers/{uuid}/tier (signed GET)', uuid
  ? await call('GET', `/v1/customers/${uuid}/tier`, undefined)
  : { status: 0, json: 'skipped (no uuid)' });
console.log(`        tier: ${data(tier)?.tier ?? '—'}   reason: ${data(tier)?.reason ?? '—'}`);

console.log(`\n${failed ? 'RESULT: FAIL (see above)' : 'RESULT: PASS — full app-facing surface exercised end-to-end'}\n`);
process.exit(failed ? 1 : 0);

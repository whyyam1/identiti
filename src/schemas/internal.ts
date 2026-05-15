/**
 * Internal signing API schemas — POST /v1/internal/sign (ID-10).
 *
 * Wire shape per Helpan AI Delegated Authority Contract v1.0 §6.3:
 *   request:  { kid, claims }
 *   response: { token, signed_at }
 *
 * The `claims` object must validate against the §2.3 token-format shape. We
 * validate the full claim set here so a malformed claims payload fails at
 * ingress with a structured 400 — the signer service then only enforces the
 * server-side semantic guards (kid match, exp bounds, issuer literal).
 */

const ACCOUNT_UUID_PATTERN =
  '^acc_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const DA_JTI_PATTERN = '^daa_[0-9A-HJKMNP-TV-Z]{26}$';
const STEPUP_JTI_PATTERN = '^stp_[0-9A-HJKMNP-TV-Z]{26}$';
const AGENT_ID_PATTERN = '^agt_[0-9A-HJKMNP-TV-Z]{26}$';

export const PERIOD_ENUM = ['single_use', 'daily', 'weekly', 'monthly'] as const;

const scopeObjectSchema = {
  type: 'object',
  required: ['scope_id'],
  additionalProperties: false,
  properties: {
    scope_id: { type: 'string', minLength: 1 },
    amount_limit_minor: { type: 'integer', minimum: 0 },
    per_period_limit_minor: { type: 'integer', minimum: 0 },
    period: { type: 'string', enum: PERIOD_ENUM },
    category_whitelist: { type: 'array', items: { type: 'string' } },
    recipient_whitelist: { type: 'array', items: { type: 'string' } },
  },
} as const;

const actorObjectSchema = {
  type: 'object',
  required: ['type', 'agent_id'],
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['agent'] },
    agent_id: { type: 'string', pattern: AGENT_ID_PATTERN },
  },
} as const;

export const internalSignClaimsSchema = {
  type: 'object',
  required: [
    'iss',
    'aud',
    'sub',
    'iat',
    'exp',
    'jti',
    'token_class',
    'actor',
    'initiated_by',
    'scopes',
    'revocation_endpoint',
  ],
  additionalProperties: false,
  properties: {
    iss: { type: 'string', format: 'uri' },
    aud: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
    sub: { type: 'string', pattern: ACCOUNT_UUID_PATTERN },
    iat: { type: 'integer', minimum: 0 },
    exp: { type: 'integer', minimum: 0 },
    jti: { type: 'string', pattern: DA_JTI_PATTERN },
    token_class: { type: 'string', enum: ['delegated_authority'] },
    actor: actorObjectSchema,
    initiated_by: { type: 'string', enum: ['agent'] },
    scopes: { type: 'array', minItems: 1, items: scopeObjectSchema },
    step_up_jti: { type: 'string', pattern: STEPUP_JTI_PATTERN },
    revocation_endpoint: { type: 'string', format: 'uri' },
  },
} as const;

export const internalSignRequestSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/InternalSignRequest.json',
  type: 'object',
  required: ['kid', 'claims'],
  additionalProperties: false,
  properties: {
    kid: { type: 'string', minLength: 1 },
    claims: internalSignClaimsSchema,
  },
} as const;

export const internalSignResponseSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/InternalSignResponse.json',
  type: 'object',
  required: ['token', 'signed_at'],
  additionalProperties: false,
  properties: {
    token: { type: 'string', minLength: 1 },
    signed_at: { type: 'string', format: 'date-time' },
  },
} as const;

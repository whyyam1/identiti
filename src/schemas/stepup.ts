/**
 * Step-up endpoint JSON schemas — Schema Appendix §7.
 *
 * Path-naming reconciliation: the Rail Contract names these
 * `/v1/stepup/challenges` and `/v1/stepup/verify`; the rail RECAP and the
 * Reboot Pack §16.8 sometimes use `/v1/step-up/initiate` and
 * `/v1/step-up/complete`. The Rail Contract wins app-facing per memory
 * `canonical_docs_location.md` authority order.
 */

const ACCOUNT_UUID_PATTERN =
  '^acc_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const CHALLENGE_ID_PATTERN = '^stp_[0-9A-HJKMNP-TV-Z]{26}$';
const AGENT_ID_PATTERN = '^agt_[0-9A-HJKMNP-TV-Z]{26}$';
const DA_JTI_PATTERN = '^daa_[0-9A-HJKMNP-TV-Z]{26}$';

const FACTOR_ENUM = ['phone_otp', 'hardware_key', 'passive_biometric'] as const;
const RISK_TIER_ENUM = ['low', 'medium', 'high', 'very_high'] as const;
const OPERATION_KIND_ENUM = [
  'kipkiren_pay.redemption',
  'kipkiren_pay.reversal',
  'kipkiren_pay.goal_release',
  'kipkiren_pay.large_transfer',
  'todoku.bulk_send',
  'identiti.phone_change',
  'identiti.account_close',
  'identiti.tier_2_promotion_evidence_view',
  // ID-10 (H4 joint with Helpan AI): step-up token authorising the user's
  // act of granting delegated authority to an agent. Per Delegated Authority
  // Contract §1 ("The two compose") + §8.3.
  'helpan_ai.authority_issuance',
  'app.custom_high_risk',
] as const;

/**
 * Special-cased audiences that are NOT URI-shaped. The strawman names
 * `helpan_authority_issuance` as a bare audience string (Delegated Authority
 * Contract §8.3). All other audiences must validate against `format: uri`.
 */
const NON_URI_AUDIENCES = ['helpan_authority_issuance'] as const;

const operationAudienceSchema = {
  oneOf: [
    { type: 'string', format: 'uri' },
    { type: 'string', enum: NON_URI_AUDIENCES },
  ],
} as const;

const actorSchema = {
  type: 'object',
  required: ['type', 'agent_id'],
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['agent'] },
    agent_id: { type: 'string', pattern: AGENT_ID_PATTERN },
    delegated_authority_jti: { type: 'string', pattern: DA_JTI_PATTERN },
  },
} as const;

export const initiateStepupRequestSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/InitiateStepupRequest.json',
  type: 'object',
  required: [
    'account_uuid',
    'operation_audience',
    'operation_kind',
    'operation_risk_tier',
    'factor',
  ],
  additionalProperties: false,
  properties: {
    account_uuid: { type: 'string', pattern: ACCOUNT_UUID_PATTERN },
    operation_audience: operationAudienceSchema,
    operation_kind: { type: 'string', enum: OPERATION_KIND_ENUM },
    operation_risk_tier: { type: 'string', enum: RISK_TIER_ENUM },
    factor: { type: 'string', enum: FACTOR_ENUM },
    device: { type: 'object' },
    // Amendment §A.1/§A.2 — agentic-AI propagation. Optional at v1.0; an app
    // dispatching a step-up on behalf of an agent populates these so the
    // resulting step-up JWT carries the actor + initiated_by claims that
    // KP/Todoku audit on relying-party calls.
    actor: actorSchema,
    initiated_by: { type: 'string', enum: ['human', 'agent', 'system'] },
  },
} as const;

export const initiateStepupResponseSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/InitiateStepupResponse.json',
  type: 'object',
  required: ['challenge_id', 'factor', 'expires_at', 'delivery_status'],
  additionalProperties: false,
  properties: {
    challenge_id: { type: 'string', pattern: CHALLENGE_ID_PATTERN },
    factor: { type: 'string', enum: FACTOR_ENUM },
    factor_upgraded_from: { type: 'string', enum: FACTOR_ENUM },
    expires_at: { type: 'string', format: 'date-time' },
    delivery_status: {
      type: 'string',
      enum: ['dispatched', 'delivered', 'failed', 'n/a'],
    },
  },
} as const;

export const verifyStepupRequestSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/VerifyStepupRequest.json',
  type: 'object',
  required: ['challenge_id', 'response'],
  additionalProperties: false,
  properties: {
    challenge_id: { type: 'string', pattern: CHALLENGE_ID_PATTERN },
    response: {
      oneOf: [{ type: 'string', pattern: '^[0-9]{6}$' }, { type: 'object' }],
    },
    client_device: { type: 'object' },
  },
} as const;

export const verifyStepupResponseSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/VerifyStepupResponse.json',
  type: 'object',
  required: ['stepup_token', 'expires_in'],
  additionalProperties: false,
  properties: {
    stepup_token: { type: 'string' },
    expires_in: { type: 'integer', minimum: 60, maximum: 600 },
  },
} as const;

/**
 * `POST /v1/stepup/tokens/validate` — diagnostic token validation (Schema
 * Appendix §7.5 / §7.6, Scaffold §14.4). A query, not a guard: it verifies a
 * step-up JWT cryptographically and against the expected claims, and does NOT
 * consume the JTI. `expected_audience` accepts a URI or the non-URI
 * `helpan_authority_issuance` audience, consistent with the step-up challenge.
 */
export const validateStepupTokenRequestSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/ValidateStepupTokenRequest.json',
  type: 'object',
  required: ['stepup_token', 'expected_audience', 'expected_subject', 'expected_operation_kind'],
  additionalProperties: false,
  properties: {
    stepup_token: { type: 'string', minLength: 1 },
    expected_audience: operationAudienceSchema,
    expected_subject: { type: 'string', pattern: ACCOUNT_UUID_PATTERN },
    expected_operation_kind: { type: 'string', enum: OPERATION_KIND_ENUM },
  },
} as const;

export const validateStepupTokenResponseSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/ValidateStepupTokenResponse.json',
  type: 'object',
  required: ['valid'],
  additionalProperties: false,
  properties: {
    valid: { type: 'boolean' },
    claims: { type: 'object', description: 'Present when valid is true.' },
    invalid_reason: { type: 'string', description: 'Present when valid is false.' },
  },
} as const;

/**
 * Risk-tier → step-up token TTL (seconds), per Schema Appendix §7.4 envelope
 * (60 minimum, 600 maximum) and Scaffold §14.3 ("default 300; can be 60 for
 * very-high-risk operations"). Lower risk = longer freshness window.
 */
export const STEPUP_TTL_BY_RISK: Record<(typeof RISK_TIER_ENUM)[number], number> = {
  low: 600,
  medium: 300,
  high: 180,
  very_high: 60,
};

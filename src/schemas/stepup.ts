/**
 * Step-up endpoint JSON schemas — Schema Appendix §7.
 *
 * Path-naming reconciliation: the Rail Contract names these
 * `/v1/stepup/challenges` and `/v1/stepup/verify`; the rail RECAP and the
 * Reboot Pack §16.8 sometimes use `/v1/step-up/initiate` and
 * `/v1/step-up/complete`. The Rail Contract wins app-facing per memory
 * `canonical_docs_location.md` authority order.
 */

const ACCOUNT_UUID_PATTERN = '^acc_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const CHALLENGE_ID_PATTERN = '^stp_[0-9A-HJKMNP-TV-Z]{26}$';

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
  'app.custom_high_risk',
] as const;

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
    operation_audience: { type: 'string', format: 'uri' },
    operation_kind: { type: 'string', enum: OPERATION_KIND_ENUM },
    operation_risk_tier: { type: 'string', enum: RISK_TIER_ENUM },
    factor: { type: 'string', enum: FACTOR_ENUM },
    device: { type: 'object' },
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
      oneOf: [
        { type: 'string', pattern: '^[0-9]{6}$' },
        { type: 'object' },
      ],
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
 * Risk-tier → step-up token TTL (seconds), per Schema Appendix §7.4 envelope
 * (60 minimum, 600 maximum) and Scaffold §14.3 ("default 300; can be 60 for
 * very-high-risk operations"). Lower risk = longer freshness window.
 */
export const STEPUP_TTL_BY_RISK: Record<typeof RISK_TIER_ENUM[number], number> = {
  low: 600,
  medium: 300,
  high: 180,
  very_high: 60,
};

/**
 * Tier-resolution schemas. Inlined from Rail Contract Schema Appendix §6.
 */

const TIMESTAMP_PATTERN =
  '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?(Z|[+-]\\d{2}:\\d{2})$';

const TIER_REASON_ENUM = [
  'rule_based_tier_0_default',
  'rule_based_tier_1_kyc_complete',
  'rule_based_tier_2_business_customer',
  'operator_tier_2_approval',
  'operator_demotion_kyc_lapse',
  'operator_demotion_aml',
  'automated_demotion_evidence_expiry',
] as const;

/** Response: GET /v1/customers/{uuid}/tier — Schema Appendix §6.1 */
export const tierResponseSchema = {
  $id: 'identiti/TierResponse',
  type: 'object',
  required: ['tier', 'assigned_at', 'reason'],
  additionalProperties: false,
  properties: {
    tier: { type: 'string', enum: ['tier_0', 'tier_1', 'tier_2'] },
    assigned_at: { type: 'string', pattern: TIMESTAMP_PATTERN },
    reason: { type: 'string', enum: TIER_REASON_ENUM },
    next_review_at: { type: 'string', pattern: TIMESTAMP_PATTERN },
  },
} as const;

const TIER_ASSIGNMENT_ID_PATTERN = '^tas_[0-9A-HJKMNP-TV-Z]{26}$';

/**
 * Response: GET /v1/customers/{uuid}/tier/history — Schema Appendix §6.4.
 * Each item is an assignment (a period the account spent at a tier). The
 * currently-open assignment has no `ended_at`. Newest-first; opaque cursor.
 */
export const tierHistoryResponseSchema = {
  $id: 'identiti/TierHistoryResponse',
  type: 'object',
  required: ['items', 'cursor'],
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['assignment_id', 'tier', 'assigned_at', 'reason'],
        additionalProperties: false,
        properties: {
          assignment_id: { type: 'string', pattern: TIER_ASSIGNMENT_ID_PATTERN },
          tier: { type: 'string', enum: ['tier_0', 'tier_1', 'tier_2'] },
          assigned_at: { type: 'string', pattern: TIMESTAMP_PATTERN },
          reason: { type: 'string', enum: TIER_REASON_ENUM },
          ended_at: { type: 'string', pattern: TIMESTAMP_PATTERN },
        },
      },
    },
    cursor: { type: ['string', 'null'] },
  },
} as const;

/** Operator tier-override request (rail-internal — not in Schema Appendix). */
export const tierOverrideRequestSchema = {
  $id: 'identiti/TierOverrideRequest',
  type: 'object',
  required: ['tier', 'reason'],
  additionalProperties: false,
  properties: {
    tier: { type: 'string', enum: ['tier_0', 'tier_1', 'tier_2'] },
    reason: {
      type: 'string',
      enum: ['operator_tier_2_approval', 'operator_demotion_kyc_lapse', 'operator_demotion_aml'],
    },
    narrative: { type: 'string', maxLength: 500 },
  },
} as const;

export const TIER_REASON_VALUES = TIER_REASON_ENUM;

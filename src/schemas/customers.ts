/**
 * AJV-compiled JSON Schemas for the /v1/customers endpoint family.
 * Inlined from Rail Contract Schema Appendix §1, §4.
 *
 * v1 schemas use draft 2020-12. additionalProperties: false everywhere.
 */

const ACCOUNT_UUID_PATTERN =
  '^acc_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

const PHONE_KE_PATTERN = '^\\+254[17][0-9]{8}$';

const TIMESTAMP_PATTERN =
  '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?(Z|[+-]\\d{2}:\\d{2})$';

export const ACCOUNT_STATE_ENUM = [
  'pending_onboarding',
  'active',
  'frozen_kyc',
  'frozen_aml',
  'closed_customer',
  'closed_operator',
  'closed_regulatory',
] as const;

export const TIER_ENUM = ['tier_0', 'tier_1', 'tier_2'] as const;

/** Request: POST /v1/customers — Schema Appendix §4.1 */
export const createCustomerRequestSchema = {
  $id: 'identiti/CreateCustomerRequest',
  type: 'object',
  required: ['phone', 'name_first', 'name_last', 'consent', 'app_correlation'],
  additionalProperties: false,
  properties: {
    phone: { type: 'string', pattern: PHONE_KE_PATTERN },
    name_first: { type: 'string', minLength: 1, maxLength: 100 },
    name_last: { type: 'string', minLength: 1, maxLength: 100 },
    name_middle: { type: 'string', maxLength: 100 },
    preferred_name: { type: 'string', maxLength: 100 },
    email: { type: 'string', format: 'email', maxLength: 254 },
    consent: {
      type: 'object',
      required: ['dpa_consent', 'kyc_consent', 'captured_at'],
      additionalProperties: false,
      properties: {
        dpa_consent: { type: 'boolean', const: true },
        kyc_consent: { type: 'boolean', const: true },
        marketing_consent: { type: 'boolean' },
        captured_at: { type: 'string', pattern: TIMESTAMP_PATTERN },
        captured_via: {
          type: 'string',
          enum: ['app_onboarding', 'operator_console', 'self_service_portal'],
        },
      },
    },
    app_correlation: { type: 'string', minLength: 1, maxLength: 64 },
    device: {
      type: 'object',
      additionalProperties: false,
      properties: {
        device_id: { type: 'string', minLength: 16, maxLength: 256 },
        platform: {
          type: 'string',
          enum: ['ios', 'android', 'web', 'ussd', 'operator_console'],
        },
        platform_version: { type: 'string', maxLength: 32 },
        app_version: { type: 'string', maxLength: 32 },
        user_agent: { type: 'string', maxLength: 512 },
        ip_token: { type: 'string' },
      },
    },
  },
} as const;

/** Response: POST /v1/customers — Schema Appendix §4.2 */
export const createCustomerResponseSchema = {
  $id: 'identiti/CreateCustomerResponse',
  type: 'object',
  required: ['account_uuid', 'state', 'tier', 'created_at'],
  additionalProperties: false,
  properties: {
    account_uuid: { type: 'string', pattern: ACCOUNT_UUID_PATTERN },
    state: { type: 'string', enum: ACCOUNT_STATE_ENUM },
    tier: { type: 'string', enum: TIER_ENUM },
    created_at: { type: 'string', pattern: TIMESTAMP_PATTERN },
  },
} as const;

/** Response: GET /v1/customers/{uuid} — Schema Appendix §4.3 */
export const readCustomerResponseSchema = {
  $id: 'identiti/ReadCustomerResponse',
  type: 'object',
  required: ['account_uuid', 'state', 'tier', 'kyc_completion', 'created_at'],
  additionalProperties: false,
  properties: {
    account_uuid: { type: 'string', pattern: ACCOUNT_UUID_PATTERN },
    state: { type: 'string', enum: ACCOUNT_STATE_ENUM },
    tier: { type: 'string', enum: TIER_ENUM },
    tier_assigned_at: { type: 'string', pattern: TIMESTAMP_PATTERN },
    kyc_completion: {
      type: 'object',
      required: ['tier_1_progress_pct', 'tier_2_progress_pct'],
      additionalProperties: false,
      properties: {
        tier_1_progress_pct: { type: 'integer', minimum: 0, maximum: 100 },
        tier_2_progress_pct: { type: 'integer', minimum: 0, maximum: 100 },
        missing_artefacts: { type: 'array', items: { type: 'string' } },
      },
    },
    created_at: { type: 'string', pattern: TIMESTAMP_PATTERN },
    last_active_at: { type: 'string', pattern: TIMESTAMP_PATTERN },
  },
} as const;

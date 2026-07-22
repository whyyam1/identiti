/**
 * AJV-compiled JSON Schemas for the /v1/auth endpoint family.
 * Inlined from Rail Contract Schema Appendix §2.
 */

const PHONE_KE_PATTERN = '^\\+254[17][0-9]{8}$';
const TIMESTAMP_PATTERN =
  '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?(Z|[+-]\\d{2}:\\d{2})$';
const ACCOUNT_UUID_PATTERN =
  '^acc_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const CHALLENGE_ID_PATTERN = '^stp_[0-9A-HJKMNP-TV-Z]{26}$';
const SESSION_ID_PATTERN = '^ses_[0-9A-HJKMNP-TV-Z]{26}$';

/** Request: POST /v1/auth/challenges — Schema Appendix §2.3 */
export const createChallengeRequestSchema = {
  $id: 'identiti/CreateChallengeRequest',
  type: 'object',
  required: ['phone', 'factor', 'purpose'],
  additionalProperties: false,
  properties: {
    phone: { type: 'string', pattern: PHONE_KE_PATTERN },
    factor: {
      type: 'string',
      enum: ['phone_otp', 'hardware_key', 'passive_biometric'],
    },
    purpose: {
      type: 'string',
      enum: ['login', 'stepup', 'phone_change_to_old', 'phone_change_to_new'],
    },
    app_correlation: { type: 'string', maxLength: 64 },
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

/** Response: POST /v1/auth/challenges — Schema Appendix §2.4 */
export const createChallengeResponseSchema = {
  $id: 'identiti/CreateChallengeResponse',
  type: 'object',
  required: ['challenge_id', 'factor', 'expires_at', 'delivery_status'],
  additionalProperties: false,
  properties: {
    challenge_id: { type: 'string', pattern: CHALLENGE_ID_PATTERN },
    factor: { type: 'string', enum: ['phone_otp', 'hardware_key', 'passive_biometric'] },
    expires_at: { type: 'string', pattern: TIMESTAMP_PATTERN },
    delivery_status: {
      type: 'string',
      enum: ['dispatched', 'delivered', 'failed', 'n/a'],
    },
    /**
     * Sandbox-only (GAP-2): when env != production the login OTP is echoed
     * here so integrators can complete /v1/auth/customer-token without a
     * Todoku→SMS bridge. Always paired with `sandbox_only: true`.
     * Production strips both fields.
     */
    otp_plaintext: { type: 'string', pattern: '^[0-9]{6}$' },
    sandbox_only: { type: 'boolean', enum: [true] },
  },
} as const;

/** Request: POST /v1/auth/customer-token — Schema Appendix §2.5 */
export const customerTokenRequestSchema = {
  $id: 'identiti/CustomerTokenRequest',
  type: 'object',
  required: ['challenge_id', 'response', 'requested_audience'],
  additionalProperties: false,
  properties: {
    challenge_id: { type: 'string', pattern: CHALLENGE_ID_PATTERN },
    response: {
      oneOf: [{ type: 'string', pattern: '^[0-9]{6}$' }, { type: 'object' }],
    },
    requested_audience: { type: 'string', format: 'uri' },
  },
} as const;

/** Response: POST /v1/auth/customer-token — Schema Appendix §2.6 */
export const customerTokenResponseSchema = {
  $id: 'identiti/CustomerTokenResponse',
  type: 'object',
  required: ['access_token', 'token_type', 'expires_in', 'account_uuid'],
  additionalProperties: false,
  properties: {
    access_token: { type: 'string' },
    token_type: { type: 'string', enum: ['bearer'] },
    expires_in: { type: 'integer', minimum: 60, maximum: 1800 },
    account_uuid: { type: 'string', pattern: ACCOUNT_UUID_PATTERN },
    session_id: { type: 'string', pattern: SESSION_ID_PATTERN },
  },
} as const;

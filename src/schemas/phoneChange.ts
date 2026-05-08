/**
 * Phone-change endpoint JSON schemas — Schema Appendix §10.3-§10.4 + §17.4.
 *
 *   POST /v1/customers/:uuid/profile/phone-change           initiate (§10.3)
 *   POST /v1/customers/:uuid/profile/phone-change/confirm   confirm  (Instruction Pack §6.3 #20)
 *
 * The confirm endpoint isn't in the Schema Appendix; it's implied by the
 * "Two-phone OTP flow required" rule in Reboot Pack §7 ID-D-08 +
 * Instruction Pack §6.3 Phase 7. Path uses the contract's
 * `/profile/phone-change` style with a `/confirm` suffix.
 */

const PHONE_KE_PATTERN = '^\\+254[17][0-9]{8}$';
const PHONE_CHANGE_ID_PATTERN = '^pch_[0-9A-HJKMNP-TV-Z]{26}$';

export const initiatePhoneChangeRequestSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/InitiatePhoneChangeRequest.json',
  type: 'object',
  required: ['new_phone', 'verification_method'],
  additionalProperties: false,
  properties: {
    new_phone: { type: 'string', pattern: PHONE_KE_PATTERN },
    verification_method: {
      type: 'string',
      enum: ['otp_to_old_phone', 'otp_to_new_phone_with_step_up_to_old'],
    },
  },
} as const;

export const initiatePhoneChangeResponseSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/InitiatePhoneChangeResponse.json',
  type: 'object',
  required: ['change_state', 'cooldown_until'],
  additionalProperties: false,
  properties: {
    change_id: { type: 'string', pattern: PHONE_CHANGE_ID_PATTERN },
    change_state: { type: 'string', enum: ['cooldown_active', 'completed'] },
    cooldown_until: { type: 'string', format: 'date-time' },
    expires_at: { type: 'string', format: 'date-time' },
    delivery_status: {
      type: 'string',
      enum: ['dispatched', 'delivered', 'failed', 'n/a'],
    },
  },
} as const;

export const confirmPhoneChangeRequestSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/ConfirmPhoneChangeRequest.json',
  type: 'object',
  required: ['change_id', 'otp_response'],
  additionalProperties: false,
  properties: {
    change_id: { type: 'string', pattern: PHONE_CHANGE_ID_PATTERN },
    otp_response: { type: 'string', pattern: '^[0-9]{6}$' },
  },
} as const;

export const confirmPhoneChangeResponseSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/ConfirmPhoneChangeResponse.json',
  type: 'object',
  required: ['change_id', 'change_state', 'cooldown_until'],
  additionalProperties: false,
  properties: {
    change_id: { type: 'string', pattern: PHONE_CHANGE_ID_PATTERN },
    change_state: { type: 'string', enum: ['completed'] },
    cooldown_until: { type: 'string', format: 'date-time' },
  },
} as const;

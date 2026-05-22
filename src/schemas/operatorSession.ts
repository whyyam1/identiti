/**
 * ID-17 — Operator user identity + WebAuthn credential registration.
 *
 * Operator step-up itself reuses /v1/stepup/challenges + /v1/stepup/verify
 * (per docs/NEWDOCS_DECISIONS.md Q3). What this surface adds:
 *
 *   POST /v1/operator/users                              — provision operator user
 *   GET  /v1/operator/users/{user_id}                    — read
 *   POST /v1/operator/users/{user_id}/webauthn/options   — mint server challenge
 *   POST /v1/operator/users/{user_id}/webauthn/register  — store credential
 */

const OPERATOR_USER_ID_PATTERN = '^opu_[0-9A-HJKMNP-TV-Z]{26}$';
const EMAIL_PATTERN = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$';
const B64URL_PATTERN = '^[A-Za-z0-9_-]+$';

export const createOperatorUserRequestSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/CreateOperatorUserRequest.json',
  type: 'object',
  required: ['email', 'display_name'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', pattern: EMAIL_PATTERN, maxLength: 256 },
    display_name: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const;

export const operatorUserResponseSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/OperatorUserResponse.json',
  type: 'object',
  required: ['user_id', 'app_id', 'email', 'display_name', 'status', 'created_at'],
  additionalProperties: false,
  properties: {
    user_id: { type: 'string', pattern: OPERATOR_USER_ID_PATTERN },
    app_id: { type: 'string' },
    email: { type: 'string' },
    display_name: { type: 'string' },
    status: { type: 'string', enum: ['active', 'disabled'] },
    created_at: { type: 'string', format: 'date-time' },
    last_login_at: { type: 'string', format: 'date-time' },
  },
} as const;

export const webauthnRegisterOptionsResponseSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/WebauthnRegisterOptionsResponse.json',
  type: 'object',
  required: ['challenge_b64', 'rp_id', 'origin', 'expires_at'],
  additionalProperties: false,
  properties: {
    challenge_b64: { type: 'string', pattern: B64URL_PATTERN, minLength: 16 },
    rp_id: { type: 'string' },
    origin: { type: 'string' },
    user: {
      type: 'object',
      required: ['id', 'name', 'display_name'],
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        display_name: { type: 'string' },
      },
    },
    /** Challenge expiry; clients SHOULD complete registration before this. */
    expires_at: { type: 'string', format: 'date-time' },
  },
} as const;

export const webauthnRegisterRequestSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/WebauthnRegisterRequest.json',
  type: 'object',
  required: ['challenge_b64', 'credential_id_b64', 'attestation_object_b64', 'client_data_json_b64'],
  additionalProperties: false,
  properties: {
    /** The same challenge bytes returned from /webauthn/options. */
    challenge_b64: { type: 'string', pattern: B64URL_PATTERN },
    credential_id_b64: { type: 'string', pattern: B64URL_PATTERN, minLength: 8 },
    attestation_object_b64: { type: 'string', pattern: B64URL_PATTERN },
    client_data_json_b64: { type: 'string', pattern: B64URL_PATTERN },
    transports: {
      type: 'array',
      items: { type: 'string', enum: ['usb', 'nfc', 'ble', 'internal', 'hybrid'] },
      maxItems: 8,
    },
    display_name: { type: 'string', maxLength: 128 },
  },
} as const;

export const webauthnRegisterResponseSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/WebauthnRegisterResponse.json',
  type: 'object',
  required: ['credential_id', 'created_at'],
  additionalProperties: false,
  properties: {
    credential_id: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
    attestation_format: { type: 'string' },
  },
} as const;

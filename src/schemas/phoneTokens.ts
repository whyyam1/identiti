/**
 * Phone-tokens endpoint JSON schemas — Phase 6.
 *
 * Endpoints (Instruction Pack §6.3):
 *   POST /v1/phone-tokens                 — issue
 *   POST /v1/phone-tokens/resolve         — Todoku-internal; scope phone_token:resolve
 *   POST /v1/phone-tokens/{jti}/revoke    — operator
 */

const ACCOUNT_UUID_PATTERN =
  '^acc_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const PHONE_TOKEN_JTI_PATTERN = '^pht_[0-9A-HJKMNP-TV-Z]{26}$';

const PHONE_TOKEN_AUDIENCES = ['todoku'] as const;

export const issuePhoneTokenRequestSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/IssuePhoneTokenRequest.json',
  type: 'object',
  required: ['account_uuid'],
  additionalProperties: false,
  properties: {
    account_uuid: { type: 'string', pattern: ACCOUNT_UUID_PATTERN },
    audience: {
      type: 'string',
      enum: PHONE_TOKEN_AUDIENCES,
      description: 'Defaults to "todoku" if omitted. v1.0: only "todoku" accepted.',
    },
  },
} as const;

export const issuePhoneTokenResponseSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/IssuePhoneTokenResponse.json',
  type: 'object',
  required: ['phone_token', 'jti', 'audience', 'expires_at'],
  additionalProperties: false,
  properties: {
    phone_token: { type: 'string' },
    jti: { type: 'string', pattern: PHONE_TOKEN_JTI_PATTERN },
    audience: { type: 'string', enum: PHONE_TOKEN_AUDIENCES },
    expires_at: { type: 'string', format: 'date-time' },
  },
} as const;

export const resolvePhoneTokenRequestSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/ResolvePhoneTokenRequest.json',
  type: 'object',
  required: ['phone_token'],
  additionalProperties: false,
  properties: {
    phone_token: { type: 'string' },
    expected_audience: { type: 'string', enum: PHONE_TOKEN_AUDIENCES },
  },
} as const;

export const resolvePhoneTokenResponseSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/ResolvePhoneTokenResponse.json',
  type: 'object',
  required: ['account_uuid', 'phone_encrypted', 'encrypted_format'],
  additionalProperties: false,
  properties: {
    account_uuid: { type: 'string', pattern: ACCOUNT_UUID_PATTERN },
    phone_encrypted: {
      type: 'string',
      description:
        'AES-256-GCM ciphertext of the normalised E.164 phone, base64-encoded as iv(12) || tag(16) || ciphertext. Decrypt with the shared PHONE_ENCRYPTION_KEY in-memory only; never log or persist plaintext.',
    },
    encrypted_format: {
      type: 'string',
      enum: ['aes-256-gcm-v1'],
    },
  },
} as const;

export const revokePhoneTokenRequestSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/RevokePhoneTokenRequest.json',
  type: 'object',
  required: ['reason'],
  additionalProperties: false,
  properties: {
    reason: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const;

export const revokePhoneTokenResponseSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/RevokePhoneTokenResponse.json',
  type: 'object',
  required: ['jti', 'revoked_at', 'reason'],
  additionalProperties: false,
  properties: {
    jti: { type: 'string', pattern: PHONE_TOKEN_JTI_PATTERN },
    revoked_at: { type: 'string', format: 'date-time' },
    reason: { type: 'string' },
  },
} as const;

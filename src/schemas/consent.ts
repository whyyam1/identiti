/**
 * ID-14 — Hakken consent surface JSON schemas.
 *
 * v1.0 keeps `scope` a free-form string (min 1, max 64). The
 * Hakken-agreed enum lock — `profile:read`, `phone:read`,
 * `payments:read`, … — is a Phase-2 hardening pass after the
 * joint design session.
 */

const ACCOUNT_UUID_PATTERN =
  '^acc_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const CONSENT_GRANT_ID_PATTERN = '^cgr_[0-9A-HJKMNP-TV-Z]{26}$';
const APP_ID_PATTERN = '^[a-z0-9_-]{3,64}$';
const SCOPE_PATTERN = '^[a-z][a-z0-9._:-]{0,63}$';

export const createConsentGrantRequestSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/CreateConsentGrantRequest.json',
  type: 'object',
  required: ['account_uuid', 'app_id', 'scope'],
  additionalProperties: false,
  properties: {
    account_uuid: { type: 'string', pattern: ACCOUNT_UUID_PATTERN },
    app_id: { type: 'string', pattern: APP_ID_PATTERN },
    scope: { type: 'string', pattern: SCOPE_PATTERN, minLength: 1, maxLength: 64 },
  },
} as const;

const consentGrantSchema = {
  type: 'object',
  required: ['grant_id', 'account_uuid', 'app_id', 'scope', 'granted_at', 'granted_via_app_id'],
  additionalProperties: false,
  properties: {
    grant_id: { type: 'string', pattern: CONSENT_GRANT_ID_PATTERN },
    account_uuid: { type: 'string', pattern: ACCOUNT_UUID_PATTERN },
    app_id: { type: 'string' },
    scope: { type: 'string' },
    granted_at: { type: 'string', format: 'date-time' },
    granted_via_app_id: { type: 'string' },
    revoked_at: { type: 'string', format: 'date-time' },
    revoked_by_app_id: { type: 'string' },
    revoke_reason: { type: 'string' },
  },
} as const;

export const createConsentGrantResponseSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/CreateConsentGrantResponse.json',
  ...consentGrantSchema,
} as const;

export const getConsentForUserResponseSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/GetConsentForUserResponse.json',
  type: 'object',
  required: ['account_uuid', 'grants'],
  additionalProperties: false,
  properties: {
    account_uuid: { type: 'string', pattern: ACCOUNT_UUID_PATTERN },
    /**
     * By default this is the OPEN grants only — what a consuming rail
     * caches. `?include=revoked` returns the full history.
     */
    grants: { type: 'array', items: consentGrantSchema },
  },
} as const;

export const revokeConsentGrantRequestSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/RevokeConsentGrantRequest.json',
  type: 'object',
  required: ['reason'],
  additionalProperties: false,
  properties: {
    reason: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const;

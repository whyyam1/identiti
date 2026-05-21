/**
 * KYB endpoint schemas — ID-13 (LipaStack §A5.1).
 *
 * Request shape per the newdocs pack ID-13 + LipaStack tech spec.
 * Director KYC re-uses existing per-customer `iprs_lookup` records on
 * `kyc_records`; the request carries the director Account UUIDs and the
 * route gates submission on those directors having verified IPRS.
 */

const ACCOUNT_UUID_PATTERN =
  '^acc_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const KYB_ID_PATTERN = '^kyb_[0-9A-HJKMNP-TV-Z]{26}$';

const directorSchema = {
  type: 'object',
  required: ['account_uuid', 'is_signatory'],
  additionalProperties: false,
  properties: {
    account_uuid: { type: 'string', pattern: ACCOUNT_UUID_PATTERN },
    is_signatory: { type: 'boolean' },
    ownership_pct: { type: 'number', minimum: 0, maximum: 100 },
  },
} as const;

export const initiateKybRequestSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/InitiateKybRequest.json',
  type: 'object',
  required: [
    'business_name',
    'business_registration_number',
    'kra_pin',
    'business_type',
    'directors',
  ],
  additionalProperties: false,
  properties: {
    business_name: { type: 'string', minLength: 2, maxLength: 256 },
    business_registration_number: { type: 'string', minLength: 4, maxLength: 32 },
    kra_pin: { type: 'string', minLength: 4, maxLength: 16 },
    business_type: {
      type: 'string',
      enum: ['sole_proprietor', 'partnership', 'company', 'llp'],
    },
    country_code: { type: 'string', enum: ['KE'] },
    directors: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: directorSchema,
    },
  },
} as const;

export const initiateKybResponseSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/InitiateKybResponse.json',
  type: 'object',
  required: ['kyb_id', 'state'],
  additionalProperties: false,
  properties: {
    kyb_id: { type: 'string', pattern: KYB_ID_PATTERN },
    state: { type: 'string', enum: ['pending', 'verified', 'rejected', 'pending_info'] },
    rejection_reason: { type: 'string' },
    pending_info_reason: { type: 'string' },
  },
} as const;

const directorReadSchema = {
  type: 'object',
  required: ['account_uuid', 'is_signatory', 'kyc_verified_at_submit'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    account_uuid: { type: 'string', pattern: ACCOUNT_UUID_PATTERN },
    is_signatory: { type: 'boolean' },
    ownership_pct: { type: 'number' },
    kyc_verified_at_submit: { type: 'boolean' },
  },
} as const;

export const getKybResponseSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/GetKybResponse.json',
  type: 'object',
  required: [
    'kyb_id',
    'state',
    'business_name',
    'business_type',
    'country_code',
    'directors',
    'submitted_at',
  ],
  additionalProperties: false,
  properties: {
    kyb_id: { type: 'string', pattern: KYB_ID_PATTERN },
    state: { type: 'string', enum: ['pending', 'verified', 'rejected', 'pending_info'] },
    business_name: { type: 'string' },
    business_type: {
      type: 'string',
      enum: ['sole_proprietor', 'partnership', 'company', 'llp'],
    },
    country_code: { type: 'string' },
    rejection_reason: { type: 'string' },
    pending_info_reason: { type: 'string' },
    submitted_at: { type: 'string', format: 'date-time' },
    verified_at: { type: 'string', format: 'date-time' },
    rejected_at: { type: 'string', format: 'date-time' },
    expires_at: { type: 'string', format: 'date-time' },
    directors: { type: 'array', items: directorReadSchema },
  },
} as const;

/**
 * KYC endpoint JSON schemas — Schema Appendix §5 + Scaffold §11.
 *
 * v1.0 ships the IPRS path only (§5.3 / §5.4). Documents, selfie/liveness, and
 * address-proof flows depend on KYC vendor selection (Track A) and ship in a
 * follow-up sprint.
 */

const ACCOUNT_UUID_PATTERN =
  '^acc_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const VERIFICATION_ARTEFACT_ID_PATTERN = '^ver_[0-9A-HJKMNP-TV-Z]{26}$';

export const iprsLookupRequestSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/IprsLookupRequest.json',
  type: 'object',
  required: ['national_id', 'name_first', 'name_last', 'date_of_birth'],
  additionalProperties: false,
  properties: {
    national_id: { type: 'string', pattern: '^[0-9]{7,9}$' },
    name_first: { type: 'string', minLength: 1, maxLength: 100 },
    name_last: { type: 'string', minLength: 1, maxLength: 100 },
    date_of_birth: { type: 'string', format: 'date' },
  },
} as const;

export const iprsLookupResponseSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/IprsLookupResponse.json',
  type: 'object',
  required: ['artefact_id', 'state'],
  additionalProperties: false,
  properties: {
    artefact_id: { type: 'string', pattern: VERIFICATION_ARTEFACT_ID_PATTERN },
    state: {
      type: 'string',
      enum: ['pending', 'verified', 'failed', 'expired', 'revoked'],
    },
    iprs_summary: {
      type: 'object',
      additionalProperties: false,
      properties: {
        match: {
          type: 'string',
          enum: ['full_match', 'partial_match', 'no_match'],
        },
        confidence_band: { type: 'string', enum: ['high', 'medium', 'low'] },
        verified_at: { type: 'string', format: 'date-time' },
        expires_at: { type: 'string', format: 'date-time' },
      },
    },
    tier_promoted_to: {
      type: 'string',
      enum: ['tier_1', 'tier_2'],
      description: 'Present when this artefact unlocked a tier promotion.',
    },
  },
} as const;

export const kycArtefactResourceSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/KycArtefactResource.json',
  type: 'object',
  required: ['artefact_id', 'kind', 'state', 'created_at'],
  additionalProperties: false,
  properties: {
    artefact_id: { type: 'string', pattern: VERIFICATION_ARTEFACT_ID_PATTERN },
    kind: { type: 'string' },
    state: {
      type: 'string',
      enum: ['pending', 'verified', 'failed', 'expired', 'revoked'],
    },
    created_at: { type: 'string', format: 'date-time' },
    verified_at: { type: 'string', format: 'date-time' },
    expires_at: { type: 'string', format: 'date-time' },
    failure_reason: { type: 'string' },
  },
} as const;

export const kycArtefactsListResponseSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/KycArtefactsList.json',
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: kycArtefactResourceSchema },
  },
} as const;

export const ACCOUNT_UUID_PATTERN_EXPORT = ACCOUNT_UUID_PATTERN;

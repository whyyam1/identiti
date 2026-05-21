/**
 * Rider-KYC endpoint schemas — ID-12 (Itafika §15).
 *
 * Submission body carries structured text fields (licence number/class/expiry,
 * bike registration + make/model, M-Pesa MSISDN, optional insurance). Image
 * uploads are referenced as opaque `image_ref` strings — the signed-URL
 * upload pipeline is Sprint 2+; the stub accepts any non-empty ref.
 */

const ACCOUNT_UUID_PATTERN =
  '^acc_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const SUBMISSION_ID_PATTERN = '^rks_[0-9A-HJKMNP-TV-Z]{26}$';

const drivingLicenceSchema = {
  type: 'object',
  required: ['number', 'class', 'expiry'],
  additionalProperties: false,
  properties: {
    number: { type: 'string', minLength: 4, maxLength: 32 },
    class: { type: 'string', minLength: 1, maxLength: 4 },
    expiry: { type: 'string', format: 'date-time' },
    image_ref: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const;

const bikeRegistrationSchema = {
  type: 'object',
  required: ['number'],
  additionalProperties: false,
  properties: {
    number: { type: 'string', minLength: 4, maxLength: 16 },
    make: { type: 'string', maxLength: 64 },
    model: { type: 'string', maxLength: 64 },
    image_ref: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const;

const insuranceSchema = {
  type: 'object',
  required: ['policy_number', 'expiry'],
  additionalProperties: false,
  properties: {
    policy_number: { type: 'string', minLength: 4, maxLength: 64 },
    expiry: { type: 'string', format: 'date-time' },
    image_ref: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const;

export const submitRiderKycRequestSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/SubmitRiderKycRequest.json',
  type: 'object',
  required: ['account_uuid', 'driving_licence', 'motorbike_registration', 'mpesa_msisdn'],
  additionalProperties: false,
  properties: {
    account_uuid: { type: 'string', pattern: ACCOUNT_UUID_PATTERN },
    driving_licence: drivingLicenceSchema,
    motorbike_registration: bikeRegistrationSchema,
    mpesa_msisdn: { type: 'string', minLength: 7, maxLength: 16 },
    insurance: insuranceSchema, // optional — Sprint 2+ promotes to rider_tier_2
  },
} as const;

export const submitRiderKycResponseSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/SubmitRiderKycResponse.json',
  type: 'object',
  required: ['submission_id', 'state', 'rider_class'],
  additionalProperties: false,
  properties: {
    submission_id: { type: 'string', pattern: SUBMISSION_ID_PATTERN },
    state: { type: 'string', enum: ['pending', 'verified', 'rejected'] },
    rider_class: { type: 'string', enum: ['none', 'rider_tier_1', 'rider_tier_2'] },
    rejection_reason: { type: 'string' },
  },
} as const;

const artefactReadSchema = {
  type: 'object',
  required: ['kind', 'state'],
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    kind: {
      type: 'string',
      enum: [
        'rider_driving_licence',
        'rider_motorbike_registration',
        'rider_mpesa_ownership_probe',
        'rider_insurance',
      ],
    },
    state: { type: 'string', enum: ['pending', 'verified', 'rejected'] },
    failure_reason: { type: 'string' },
    licence_class: { type: 'string' },
    licence_expiry: { type: 'string', format: 'date-time' },
    bike_make: { type: 'string' },
    bike_model: { type: 'string' },
    insurance_policy_number: { type: 'string' },
    insurance_expiry: { type: 'string', format: 'date-time' },
  },
} as const;

export const getRiderKycResponseSchema = {
  $id: 'https://schemas.id.identiti.co.ke/v1/GetRiderKycResponse.json',
  type: 'object',
  required: ['submission_id', 'account_uuid', 'state', 'rider_class', 'artefacts', 'submitted_at'],
  additionalProperties: false,
  properties: {
    submission_id: { type: 'string', pattern: SUBMISSION_ID_PATTERN },
    account_uuid: { type: 'string', pattern: ACCOUNT_UUID_PATTERN },
    state: { type: 'string', enum: ['pending', 'verified', 'rejected'] },
    rider_class: { type: 'string', enum: ['none', 'rider_tier_1', 'rider_tier_2'] },
    rejection_reason: { type: 'string' },
    submitted_at: { type: 'string', format: 'date-time' },
    verified_at: { type: 'string', format: 'date-time' },
    rejected_at: { type: 'string', format: 'date-time' },
    expires_at: { type: 'string', format: 'date-time' },
    artefacts: { type: 'array', items: artefactReadSchema },
  },
} as const;

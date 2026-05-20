/**
 * Drizzle schema — Identiti.
 * Phase 1 (foundation): app_credentials, idempotency_keys, audit_log.
 * Phase 2 (Sprint 1):    platform_accounts, phone_records.
 * Phase 3 (Sprint 2):    auth_challenges, sessions.
 * Phase 4 (Sprint 6):    kyc_records.
 * Phase 5 (Sprint 4):    step_up_tokens (with Amendment §A.1 columns).
 * Phase 6 (Sprint 5):    phone_tokens.
 * Phase 7 (Sprint 7):    phone_changes; step_up_tokens.consumed_at.
 *
 * Per Instruction Pack §3 (universal conventions) + §6.2 (Identiti-specific).
 */

import {
  pgTable,
  text,
  jsonb,
  integer,
  timestamp,
  primaryKey,
  index,
  boolean,
} from 'drizzle-orm/pg-core';

// ─── Phase 1 universal tables ─────────────────────────────────────────────

export const appCredentials = pgTable('app_credentials', {
  appId: text('app_id').primaryKey(),
  appName: text('app_name').notNull(),
  tenantClass: text('tenant_class').notNull(),
  hmacSecret: text('hmac_secret').notNull(),
  status: text('status').notNull().default('active'),
  scopes: text('scopes').array().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').notNull(),
    appId: text('app_id').notNull(),
    requestBodyHash: text('request_body_hash').notNull(),
    statusCode: integer('status_code').notNull(),
    responseBody: jsonb('response_body').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.key, t.appId] }),
    expiresAtIdx: index('idempotency_keys_expires_at_idx').on(t.expiresAt),
  }),
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    requestId: text('request_id').notNull(),
    traceparent: text('traceparent'),
    ipAddress: text('ip_address'),
    outcome: text('outcome').notNull(),
    detail: jsonb('detail'),
    previousHash: text('previous_hash'),
    entryHash: text('entry_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    appCreatedIdx: index('audit_log_app_id_created_at_idx').on(t.appId, t.createdAt),
    resourceIdx: index('audit_log_resource_idx').on(t.resourceType, t.resourceId, t.createdAt),
  }),
);

// ─── Phase 2 (Sprint 1) — accounts and phone records ──────────────────────

export const platformAccounts = pgTable(
  'platform_accounts',
  {
    id: text('id').primaryKey(),
    status: text('status').notNull().default('pending_onboarding'),
    tier: text('tier').notNull().default('tier_0'),
    tierAssignedAt: timestamp('tier_assigned_at', { withTimezone: true }),
    tierReason: text('tier_reason'),
    nameFirst: text('name_first').notNull(),
    nameLast: text('name_last').notNull(),
    nameMiddle: text('name_middle'),
    preferredName: text('preferred_name'),
    email: text('email'),
    appCorrelation: text('app_correlation').notNull(),
    originAppId: text('origin_app_id').notNull(),
    dpaConsentAt: timestamp('dpa_consent_at', { withTimezone: true }).notNull(),
    kycConsentAt: timestamp('kyc_consent_at', { withTimezone: true }).notNull(),
    marketingConsent: boolean('marketing_consent').notNull().default(false),
    consentCapturedVia: text('consent_captured_via').notNull(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    originAppIdx: index('platform_accounts_origin_app_idx').on(t.originAppId),
    correlationIdx: index('platform_accounts_app_correlation_idx').on(
      t.originAppId,
      t.appCorrelation,
    ),
  }),
);

export const phoneRecords = pgTable(
  'phone_records',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull().unique(),
    phoneHash: text('phone_hash').notNull().unique(),
    phoneEncrypted: text('phone_encrypted').notNull(),
    lastChangeAt: timestamp('last_change_at', { withTimezone: true }).notNull().defaultNow(),
    cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    phoneHashIdx: index('phone_records_phone_hash_idx').on(t.phoneHash),
  }),
);

// ─── Sprint 2 (Phase 3) — auth challenges and sessions ────────────────────

export const authChallenges = pgTable(
  'auth_challenges',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id'),
    appId: text('app_id').notNull(),
    factor: text('factor').notNull(),
    purpose: text('purpose').notNull(),
    otpHash: text('otp_hash'),
    attemptsUsed: integer('attempts_used').notNull().default(0),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    intendedOperation: text('intended_operation'),
    // Phase 5: only populated for purpose='stepup'. /v1/stepup/verify uses
    // these to reissue the JWT bound to the audience the customer authorised
    // against. NULL for purpose='login'.
    operationAudience: text('operation_audience'),
    operationRiskTier: text('operation_risk_tier'),
    // ID-10: Amendment §A.1/§A.2 propagation. Survives the async gap from
    // /v1/stepup/challenges to /v1/stepup/verify so the resulting step-up
    // JWT carries the same `actor` + `initiated_by` the caller bound at
    // challenge time. step_up_tokens carries the eventual durable copy.
    actorType: text('actor_type'),
    actorAgentId: text('actor_agent_id'),
    actorDelegatedAuthorityJti: text('actor_delegated_authority_jti'),
    initiatedBy: text('initiated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    accountStatusIdx: index('auth_challenges_account_status_idx').on(
      t.accountId,
      t.status,
      t.expiresAt,
    ),
  }),
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    jti: text('jti').notNull().unique(),
    audience: text('audience').notNull(),
    factorsUsed: text('factors_used').array().notNull(),
    sessionKind: text('session_kind').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    accountIdx: index('sessions_account_idx').on(t.accountId, t.expiresAt),
    jtiIdx: index('sessions_jti_idx').on(t.jti),
  }),
);

// ─── Sprint 6 (Phase 4) — KYC artefacts ───────────────────────────────────

export const kycRecords = pgTable(
  'kyc_records',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    kind: text('kind').notNull(),
    tier: text('tier').notNull(),
    verificationMethod: text('verification_method').notNull(),
    status: text('status').notNull().default('pending'),
    nationalIdHash: text('national_id_hash'),
    iprsVerified: boolean('iprs_verified').notNull().default(false),
    iprsVerificationRef: text('iprs_verification_ref'),
    iprsMatch: text('iprs_match'),
    iprsConfidenceBand: text('iprs_confidence_band'),
    sanctionsChecked: boolean('sanctions_checked').notNull().default(false),
    sanctionsCheckRef: text('sanctions_check_ref'),
    pepChecked: boolean('pep_checked').notNull().default(false),
    pepCheckRef: text('pep_check_ref'),
    failureReason: text('failure_reason'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    accountKindStatusIdx: index('kyc_records_account_kind_status_idx').on(
      t.accountId,
      t.kind,
      t.status,
    ),
  }),
);

// ─── Sprint 5 (Phase 6) — phone-token issuance ledger ────────────────────

export const phoneTokens = pgTable(
  'phone_tokens',
  {
    jti: text('jti').primaryKey(),
    accountUuid: text('account_uuid').notNull(),
    audience: text('audience').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revoked: boolean('revoked').notNull().default(false),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: text('revoked_by'),
    revokeReason: text('revoke_reason'),
  },
  (t) => ({
    accountActiveIdx: index('phone_tokens_account_active_idx').on(
      t.accountUuid,
      t.revoked,
      t.expiresAt,
    ),
  }),
);

// ─── Sprint 4 (Phase 5) — step-up token issuance ledger ───────────────────

export const stepUpTokens = pgTable(
  'step_up_tokens',
  {
    jti: text('jti').primaryKey(),
    accountUuid: text('account_uuid').notNull(),
    challengeId: text('challenge_id').notNull(),
    audience: text('audience').notNull(),
    operationKind: text('operation_kind').notNull(),
    operationRiskTier: text('operation_risk_tier').notNull(),
    factor: text('factor').notNull(),
    env: text('env').notNull(),
    actorType: text('actor_type'),
    actorAgentId: text('actor_agent_id'),
    delegatedAuthorityJti: text('delegated_authority_jti'),
    initiatedBy: text('initiated_by'),
    iat: timestamp('iat', { withTimezone: true }).notNull(),
    exp: timestamp('exp', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    accountExpIdx: index('step_up_tokens_account_exp_idx').on(t.accountUuid, t.exp),
    delegatedAuthorityIdx: index('step_up_tokens_delegated_authority_idx').on(
      t.delegatedAuthorityJti,
    ),
  }),
);

// ─── Tier history (backlog — customer-facing §6.4) ────────────────────────

export const tierHistory = pgTable(
  'tier_history',
  {
    id: text('id').primaryKey(),
    accountUuid: text('account_uuid').notNull(),
    tier: text('tier').notNull(),
    reason: text('reason').notNull(),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    accountAssignedIdx: index('tier_history_account_assigned_idx').on(t.accountUuid, t.assignedAt),
  }),
);

// ─── ID-10 — delegated-authority signing ledger ───────────────────────────

export const delegatedAuthoritySignings = pgTable(
  'delegated_authority_signings',
  {
    jti: text('jti').primaryKey(),
    accountUuid: text('account_uuid').notNull(),
    agentId: text('agent_id').notNull(),
    stepUpJti: text('step_up_jti'),
    scopes: jsonb('scopes').notNull(),
    kid: text('kid').notNull(),
    signedAt: timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    callerAppId: text('caller_app_id').notNull(),
    traceparent: text('traceparent'),
    businessOpId: text('business_op_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    accountSignedIdx: index('delegated_authority_signings_account_signed_idx').on(
      t.accountUuid,
      t.signedAt,
    ),
    stepUpIdx: index('delegated_authority_signings_step_up_idx').on(t.stepUpJti),
    agentIdx: index('delegated_authority_signings_agent_idx').on(t.agentId),
  }),
);

// ─── Sprint 7 (Phase 7) — phone-change ledger ────────────────────────────

export const phoneChanges = pgTable(
  'phone_changes',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    state: text('state').notNull().default('cooldown_active'),
    verificationMethod: text('verification_method').notNull(),
    newPhoneHash: text('new_phone_hash').notNull(),
    newPhoneEncrypted: text('new_phone_encrypted').notNull(),
    challengeOldId: text('challenge_old_id'),
    challengeNewId: text('challenge_new_id'),
    authorisingStepupJti: text('authorising_stepup_jti').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    initiatedAt: timestamp('initiated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    accountStateIdx: index('phone_changes_account_state_idx').on(t.accountId, t.state, t.expiresAt),
  }),
);

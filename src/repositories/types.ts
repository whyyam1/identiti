/**
 * Repository contracts. Implementations are DB-backed in production and
 * in-memory in tests. Routes depend on the interface, not the impl.
 */

export type AccountState =
  | 'pending_onboarding'
  | 'active'
  | 'frozen_kyc'
  | 'frozen_aml'
  | 'closed_customer'
  | 'closed_operator'
  | 'closed_regulatory';

export type Tier = 'tier_0' | 'tier_1' | 'tier_2';

// ─── CustomersRepo ────────────────────────────────────────────────────────

export interface CustomerInsert {
  accountUuid: string;
  nameFirst: string;
  nameLast: string;
  nameMiddle: string | null;
  preferredName: string | null;
  email: string | null;
  appCorrelation: string;
  originAppId: string;
  dpaConsentAt: Date;
  kycConsentAt: Date;
  marketingConsent: boolean;
  consentCapturedVia: string;
  phoneRecordId: string;
  phoneHash: string;
  phoneEncrypted: string;
}

export interface CustomerRow {
  accountUuid: string;
  state: AccountState;
  tier: Tier;
  tierAssignedAt: Date | null;
  createdAt: Date;
  lastActiveAt: Date | null;
}

export interface CreateOutcome {
  accountUuid: string;
  state: AccountState;
  tier: Tier;
  createdAt: Date;
}

export type CreateResult =
  | { kind: 'created'; outcome: CreateOutcome }
  | { kind: 'phone_collision' };

export interface StateChangeResult {
  fromState: AccountState;
  toState: AccountState;
}

export interface TierSnapshot {
  tier: Tier;
  assignedAt: Date;
  reason: string;
}

export interface TierChangeResult {
  fromTier: Tier;
  toTier: Tier;
  assignedAt: Date;
  reason: string;
}

export interface PhoneRecord {
  phoneHash: string;
  phoneEncrypted: string;
  cooldownUntil: Date | null;
  lastChangeAt: Date;
}

export interface SwapPhoneInput {
  newPhoneHash: string;
  newPhoneEncrypted: string;
  cooldownUntil: Date;
}

export interface CustomersRepo {
  create(input: CustomerInsert): Promise<CreateResult>;
  findById(accountUuid: string): Promise<CustomerRow | null>;
  findByPhoneHash(phoneHash: string): Promise<{ accountUuid: string } | null>;
  /** AES-256-GCM ciphertext of the bound phone, base64. Phase 6 phone-token resolve. */
  findEncryptedPhoneFor(accountUuid: string): Promise<string | null>;
  /** Phase 7 phone change: read the bound phone record (hash + ciphertext + cooldown). */
  getPhoneRecord(accountUuid: string): Promise<PhoneRecord | null>;
  /** Phase 7 phone change: atomically swap the bound phone and reset cooldown. */
  swapPhone(accountUuid: string, input: SwapPhoneInput): Promise<PhoneRecord | null>;
  changeState(
    accountUuid: string,
    fromStates: readonly AccountState[],
    toState: AccountState
  ): Promise<StateChangeResult | null>;
  getTier(accountUuid: string): Promise<TierSnapshot | null>;
  setTier(accountUuid: string, tier: Tier, reason: string): Promise<TierChangeResult | null>;
}

// ─── AuthChallengesRepo ───────────────────────────────────────────────────

export type Factor = 'phone_otp' | 'hardware_key' | 'passive_biometric';
export type ChallengePurpose =
  | 'login'
  | 'stepup'
  | 'phone_change_to_old'
  | 'phone_change_to_new';
export type ChallengeStatus = 'pending' | 'consumed' | 'expired' | 'failed';

export interface AuthChallengeInsert {
  id: string;
  accountId: string | null;
  appId: string;
  factor: Factor;
  purpose: ChallengePurpose;
  otpHash: string | null;
  expiresAt: Date;
  intendedOperation: string | null;
  /** Step-up: target rail audience. NULL for purpose='login'. */
  operationAudience: string | null;
  /** Step-up: drives factor selection + freshness window. NULL for purpose='login'. */
  operationRiskTier: RiskTier | null;
  /** ID-10: Amendment §A.1 — agentic actor bound at challenge time. NULL for human-initiated. */
  actor?: StepUpActor;
  /** ID-10: Amendment §A.2 — originating intent class. */
  initiatedBy?: InitiatedBy;
}

export interface AuthChallenge {
  id: string;
  accountId: string | null;
  appId: string;
  factor: Factor;
  purpose: ChallengePurpose;
  otpHash: string | null;
  attemptsUsed: number;
  status: ChallengeStatus;
  expiresAt: Date;
  consumedAt: Date | null;
  intendedOperation: string | null;
  operationAudience: string | null;
  operationRiskTier: RiskTier | null;
  actor: StepUpActor | null;
  initiatedBy: InitiatedBy | null;
  createdAt: Date;
}

export interface AuthChallengesRepo {
  create(input: AuthChallengeInsert): Promise<AuthChallenge>;
  findById(id: string): Promise<AuthChallenge | null>;
  /** Atomically increment attempts and (optionally) move to terminal status. */
  recordAttempt(
    id: string,
    next: { status: ChallengeStatus; consumedAt: Date | null; incrementAttempts: boolean }
  ): Promise<AuthChallenge | null>;
}

// ─── SessionsRepo ─────────────────────────────────────────────────────────

export type SessionKind = 'primary' | 'stepup';

export interface SessionInsert {
  id: string;
  accountId: string;
  jti: string;
  audience: string;
  factorsUsed: readonly string[];
  sessionKind: SessionKind;
  expiresAt: Date;
}

export interface SessionsRepo {
  create(input: SessionInsert): Promise<{ id: string; issuedAt: Date }>;
}

// ─── StepUpTokensRepo ─────────────────────────────────────────────────────
// Schema Appendix §16.2 / §14.5: jti = challenge_id; single-use at issuance is
// the PRIMARY KEY uniqueness. Amendment §A.1 columns are nullable in v1.0;
// they activate when ID-10 H4 lands and Helpan AI dispatches step-ups.

export type RiskTier = 'low' | 'medium' | 'high' | 'very_high';
export type ActorType = 'human' | 'agent';
export type InitiatedBy = 'human' | 'agent' | 'system';

export interface StepUpActor {
  type: ActorType;
  agentId?: string;
  delegatedAuthorityJti?: string;
}

export interface StepUpTokenInsert {
  jti: string;
  accountUuid: string;
  challengeId: string;
  audience: string;
  operationKind: string;
  operationRiskTier: RiskTier;
  factor: Factor;
  env: string;
  iat: Date;
  exp: Date;
  actor?: StepUpActor;
  initiatedBy?: InitiatedBy;
}

export interface StepUpTokensRepo {
  create(input: StepUpTokenInsert): Promise<void>;
  findByJti(jti: string): Promise<StepUpTokenInsert | null>;
  /**
   * Atomically mark a token consumed. Returns true on first call; false if the
   * token was already consumed (caller should reject as `replay_detected` per
   * Schema Appendix §16.3 step 12).
   */
  markConsumed(jti: string, consumedAt: Date): Promise<boolean>;
}

// ─── PhoneChangesRepo ─────────────────────────────────────────────────────

export type PhoneChangeState = 'initiated' | 'cooldown_active' | 'completed' | 'cancelled';
export type PhoneChangeVerificationMethod =
  | 'otp_to_old_phone'
  | 'otp_to_new_phone_with_step_up_to_old';

export interface PhoneChangeInsert {
  id: string;
  accountId: string;
  state: PhoneChangeState;
  verificationMethod: PhoneChangeVerificationMethod;
  newPhoneHash: string;
  newPhoneEncrypted: string;
  challengeOldId: string | null;
  challengeNewId: string | null;
  authorisingStepupJti: string;
  expiresAt: Date;
}

export interface PhoneChange extends PhoneChangeInsert {
  initiatedAt: Date;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdAt: Date;
}

export interface PhoneChangesRepo {
  create(input: PhoneChangeInsert): Promise<PhoneChange>;
  findById(id: string): Promise<PhoneChange | null>;
  findActiveForAccount(accountId: string): Promise<PhoneChange | null>;
  /** Marks state='completed', sets completed_at; returns the updated record or null if not in cooldown_active. */
  complete(id: string, completedAt: Date): Promise<PhoneChange | null>;
  /** Marks state='cancelled', sets cancel_reason; returns the updated record or null if already terminal. */
  cancel(id: string, reason: string, cancelledAt: Date): Promise<PhoneChange | null>;
}

// ─── KycRecordsRepo ───────────────────────────────────────────────────────
// Phase 4. One row per KYC artefact submission. State machine per Schema
// Appendix §17.2: pending → verified → expired/revoked; pending → failed.

export type KycKind =
  | 'iprs_lookup'
  | 'national_id_front'
  | 'national_id_back'
  | 'passport_main'
  | 'passport_signed'
  | 'selfie_liveness'
  | 'address_proof_utility'
  | 'address_proof_bank_statement'
  | 'address_proof_tenancy'
  | 'address_proof_government'
  | 'sanctions_check'
  | 'pep_check'
  | 'kmpdc_verification'
  | 'business_registration';

export type KycArtefactState = 'pending' | 'verified' | 'failed' | 'expired' | 'revoked';
export type KycVerificationMethod =
  | 'iprs'
  | 'manual'
  | 'document_scan'
  | 'selfie_liveness'
  | 'address_proof';
export type IprsMatch = 'full_match' | 'partial_match' | 'no_match';
export type IprsConfidenceBand = 'high' | 'medium' | 'low';

export interface KycRecordInsert {
  id: string;
  accountId: string;
  kind: KycKind;
  tier: 'tier_1' | 'tier_2';
  verificationMethod: KycVerificationMethod;
  status: KycArtefactState;
  nationalIdHash?: string;
  iprsVerified?: boolean;
  iprsVerificationRef?: string;
  iprsMatch?: IprsMatch;
  iprsConfidenceBand?: IprsConfidenceBand;
  failureReason?: string;
  verifiedAt?: Date;
  expiresAt?: Date;
}

export interface KycRecord {
  id: string;
  accountId: string;
  kind: KycKind;
  tier: 'tier_1' | 'tier_2';
  verificationMethod: KycVerificationMethod;
  status: KycArtefactState;
  nationalIdHash: string | null;
  iprsVerified: boolean;
  iprsVerificationRef: string | null;
  iprsMatch: IprsMatch | null;
  iprsConfidenceBand: IprsConfidenceBand | null;
  sanctionsChecked: boolean;
  pepChecked: boolean;
  failureReason: string | null;
  verifiedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface KycRecordsRepo {
  create(input: KycRecordInsert): Promise<KycRecord>;
  findById(id: string): Promise<KycRecord | null>;
  listByAccount(accountId: string): Promise<KycRecord[]>;
  /** Operator console: list records currently in a given state (e.g. 'pending' for review). */
  listByStatus(status: KycArtefactState, limit?: number): Promise<KycRecord[]>;
  /** Returns true iff some other account already has a verified row for this hash. */
  isNationalIdHashClaimedByOther(
    nationalIdHash: string,
    excludingAccountId: string
  ): Promise<boolean>;
  /** Operator approve: pending → verified. Returns null if not found or not pending. */
  markVerified(id: string, opts: { verifiedAt: Date; expiresAt: Date }): Promise<KycRecord | null>;
  /** Operator reject: pending → failed. Returns null if not found or not pending. */
  markFailed(id: string, reason: string): Promise<KycRecord | null>;
}

// ─── DelegatedAuthoritySigningsRepo (ID-10) ───────────────────────────────
// Helpan AI Delegated Authority Contract §2.5 scope shape; §6.3 signing API;
// §A.2 cross-rail audit invariant.

export type DelegatedAuthorityPeriod =
  | 'single_use'
  | 'daily'
  | 'weekly'
  | 'monthly';

export interface DelegatedAuthorityScope {
  scope_id: string;
  amount_limit_minor?: number;
  per_period_limit_minor?: number;
  period?: DelegatedAuthorityPeriod;
  category_whitelist?: readonly string[];
  recipient_whitelist?: readonly string[];
}

export interface DelegatedAuthoritySigningInsert {
  jti: string;
  accountUuid: string;
  agentId: string;
  stepUpJti: string | null;
  scopes: readonly DelegatedAuthorityScope[];
  kid: string;
  signedAt: Date;
  expiresAt: Date;
  callerAppId: string;
  traceparent: string | null;
  businessOpId: string | null;
}

export interface DelegatedAuthoritySigningsRepo {
  create(input: DelegatedAuthoritySigningInsert): Promise<void>;
  findByJti(jti: string): Promise<DelegatedAuthoritySigningInsert | null>;
}

// ─── PhoneTokensRepo ──────────────────────────────────────────────────────
// Phase 6. Phone tokens are HS256 opaque JWTs; the resolve path is the
// authoritative verification, not the JWT signature.

export type PhoneTokenAudience = 'todoku';

export interface PhoneTokenInsert {
  jti: string;
  accountUuid: string;
  audience: PhoneTokenAudience;
  issuedAt: Date;
  expiresAt: Date;
}

export interface PhoneTokenRecord extends PhoneTokenInsert {
  revoked: boolean;
  revokedAt: Date | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

export interface PhoneTokensRepo {
  create(input: PhoneTokenInsert): Promise<void>;
  findByJti(jti: string): Promise<PhoneTokenRecord | null>;
  /** Returns the updated record, or null if jti unknown / already revoked. */
  revoke(jti: string, by: string, reason: string): Promise<PhoneTokenRecord | null>;
}

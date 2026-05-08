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

export interface CustomersRepo {
  create(input: CustomerInsert): Promise<CreateResult>;
  findById(accountUuid: string): Promise<CustomerRow | null>;
  findByPhoneHash(phoneHash: string): Promise<{ accountUuid: string } | null>;
  /** AES-256-GCM ciphertext of the bound phone, base64. Phase 6 phone-token resolve. */
  findEncryptedPhoneFor(accountUuid: string): Promise<string | null>;
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
  /** Returns true iff some other account already has a verified row for this hash. */
  isNationalIdHashClaimedByOther(
    nationalIdHash: string,
    excludingAccountId: string
  ): Promise<boolean>;
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

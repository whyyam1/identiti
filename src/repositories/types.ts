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
  /** ID-12 (Q1 orthogonal): rider verification dimension. Default 'none'. */
  riderClass: RiderClass;
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

/**
 * A tier assignment — one period the account spent at a given tier.
 * Schema Appendix §6.4. The currently-open assignment has `endedAt: null`.
 */
export interface TierAssignment {
  assignmentId: string; // tas_<ULID>
  tier: Tier;
  assignedAt: Date;
  endedAt: Date | null;
  reason: string;
}

export interface TierHistoryListOptions {
  /** Hard cap on items returned. Defaults to 50; clamped to 200. */
  limit?: number;
  /** Opaque cursor: the assignment_id of the next item from a previous page. */
  cursor?: string | null;
}

export interface TierHistoryPage {
  items: readonly TierAssignment[];
  /** Next-page cursor when more items exist; null when the page is the last. */
  cursor: string | null;
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
    toState: AccountState,
  ): Promise<StateChangeResult | null>;
  getTier(accountUuid: string): Promise<TierSnapshot | null>;
  setTier(accountUuid: string, tier: Tier, reason: string): Promise<TierChangeResult | null>;
  /** ID-12 (Q1 orthogonal): set the rider verification dimension. Returns false iff the account does not exist. */
  setRiderClass(accountUuid: string, riderClass: RiderClass): Promise<boolean>;
  /** Schema Appendix §6.4 — paginated, newest first. Returns null if the account does not exist. */
  getTierHistory(
    accountUuid: string,
    opts?: TierHistoryListOptions,
  ): Promise<TierHistoryPage | null>;
}

// ─── AuthChallengesRepo ───────────────────────────────────────────────────

export type Factor = 'phone_otp' | 'hardware_key' | 'passive_biometric';
export type ChallengePurpose =
  | 'login'
  | 'stepup'
  | 'phone_change_to_old'
  | 'phone_change_to_new'
  | 'operator_webauthn_register';
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
  /** ID-17: operator-user subject (opu_<ULID>). Mutually exclusive with accountId. */
  operatorUserId?: string | null;
  /** ID-17: factor-specific JSON blob (e.g. WebAuthn challenge bytes for hardware_key). */
  factorData?: Record<string, unknown> | null;
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
  operatorUserId: string | null;
  factorData: Record<string, unknown> | null;
  createdAt: Date;
}

export interface AuthChallengesRepo {
  create(input: AuthChallengeInsert): Promise<AuthChallenge>;
  findById(id: string): Promise<AuthChallenge | null>;
  /** Atomically increment attempts and (optionally) move to terminal status. */
  recordAttempt(
    id: string,
    next: { status: ChallengeStatus; consumedAt: Date | null; incrementAttempts: boolean },
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
  /** Customer subject. Exactly one of accountUuid / operatorUserId is non-null. */
  accountUuid: string | null;
  /** ID-17 operator subject. Exactly one of accountUuid / operatorUserId is non-null. */
  operatorUserId: string | null;
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
    excludingAccountId: string,
  ): Promise<boolean>;
  /** Operator approve: pending → verified. Returns null if not found or not pending. */
  markVerified(id: string, opts: { verifiedAt: Date; expiresAt: Date }): Promise<KycRecord | null>;
  /** Operator reject: pending → failed. Returns null if not found or not pending. */
  markFailed(id: string, reason: string): Promise<KycRecord | null>;
}

// ─── KYB (ID-13 — LipaStack §A5.1) ────────────────────────────────────────

export type KybBusinessType = 'sole_proprietor' | 'partnership' | 'company' | 'llp';
export type KybState = 'pending' | 'verified' | 'rejected' | 'pending_info';

export interface KybRecord {
  id: string; // kyb_<ULID>
  state: KybState;
  businessName: string;
  businessType: KybBusinessType;
  countryCode: string;
  businessRegistrationHash: string;
  kraPinHash: string;
  rejectionReason: string | null;
  pendingInfoReason: string | null;
  submittedByAppId: string;
  submittedAt: Date;
  verifiedAt: Date | null;
  rejectedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface KybDirector {
  id: string; // kybd_<ULID>
  kybId: string;
  directorAccountUuid: string;
  isSignatory: boolean;
  ownershipPct: number | null;
  kycVerifiedAtSubmit: boolean;
  createdAt: Date;
}

export interface KybDirectorInsert {
  id: string;
  kybId: string;
  directorAccountUuid: string;
  isSignatory: boolean;
  ownershipPct?: number;
  kycVerifiedAtSubmit: boolean;
}

export interface KybRecordInsert {
  id: string;
  state: KybState;
  businessName: string;
  businessType: KybBusinessType;
  countryCode: string;
  businessRegistrationHash: string;
  kraPinHash: string;
  rejectionReason?: string;
  pendingInfoReason?: string;
  submittedByAppId: string;
  verifiedAt?: Date;
  rejectedAt?: Date;
  expiresAt?: Date;
}

export interface KybFull {
  record: KybRecord;
  directors: readonly KybDirector[];
}

export type KybInsertOutcome =
  | { kind: 'created'; record: KybRecord }
  | {
      kind: 'cross_account_collision';
      conflictKind: 'business_registration' | 'kra_pin';
    };

export interface KybRepo {
  create(
    record: KybRecordInsert,
    directors: readonly KybDirectorInsert[],
  ): Promise<KybInsertOutcome>;
  findById(id: string): Promise<KybFull | null>;
}

// ─── Rider-KYC (ID-12) ────────────────────────────────────────────────────
// Per docs/NEWDOCS_DECISIONS.md Q1: rider verification is orthogonal to the
// financial 3-tier model. `RiderClass` is a separate dimension on
// platform_accounts; setting it does not move `Tier`.

export type RiderClass = 'none' | 'rider_tier_1' | 'rider_tier_2';

export type RiderKycArtefactKind =
  | 'rider_driving_licence'
  | 'rider_motorbike_registration'
  | 'rider_mpesa_ownership_probe'
  | 'rider_insurance';

export type RiderKycArtefactState = 'pending' | 'verified' | 'rejected';
export type RiderKycSubmissionState = 'pending' | 'verified' | 'rejected';

export interface RiderKycSubmission {
  id: string; // rks_<ULID>
  accountUuid: string;
  state: RiderKycSubmissionState;
  riderClass: RiderClass;
  rejectionReason: string | null;
  submittedAt: Date;
  verifiedAt: Date | null;
  rejectedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface RiderKycArtefact {
  id: string; // rka_<ULID>
  submissionId: string;
  accountUuid: string;
  kind: RiderKycArtefactKind;
  state: RiderKycArtefactState;
  licenceNumberHash: string | null;
  bikeRegistrationHash: string | null;
  mpesaMsisdnHash: string | null;
  imageRef: string | null;
  licenceClass: string | null;
  licenceExpiry: Date | null;
  bikeMake: string | null;
  bikeModel: string | null;
  insurancePolicyNumber: string | null;
  insuranceExpiry: Date | null;
  vendorRef: string | null;
  failureReason: string | null;
  verifiedAt: Date | null;
  rejectedAt: Date | null;
  createdAt: Date;
}

export interface RiderKycArtefactInsert {
  id: string;
  submissionId: string;
  accountUuid: string;
  kind: RiderKycArtefactKind;
  state: RiderKycArtefactState;
  licenceNumberHash?: string;
  bikeRegistrationHash?: string;
  mpesaMsisdnHash?: string;
  imageRef?: string;
  licenceClass?: string;
  licenceExpiry?: Date;
  bikeMake?: string;
  bikeModel?: string;
  insurancePolicyNumber?: string;
  insuranceExpiry?: Date;
  vendorRef?: string;
  failureReason?: string;
  verifiedAt?: Date;
  rejectedAt?: Date;
}

export interface RiderKycSubmissionFull {
  submission: RiderKycSubmission;
  artefacts: readonly RiderKycArtefact[];
}

export interface RiderKycSubmissionInsert {
  id: string;
  accountUuid: string;
  state: RiderKycSubmissionState;
  riderClass: RiderClass;
  rejectionReason?: string;
  verifiedAt?: Date;
  rejectedAt?: Date;
  expiresAt?: Date;
}

export type RiderKycInsertOutcome =
  | { kind: 'created'; submission: RiderKycSubmission }
  | { kind: 'cross_account_collision'; conflictKind: 'driving_licence' | 'bike_registration' };

export interface RiderKycRepo {
  /**
   * Atomically inserts the submission and its artefacts. The
   * partial-unique indexes on licence + bike hashes (where state='verified')
   * mean a collision can only happen at artefact-state='verified' insertion
   * time. Verification stubs run server-side before this call; if any
   * artefact is to be inserted as 'verified', the cross-account check is
   * enforced by the index.
   */
  create(
    submission: RiderKycSubmissionInsert,
    artefacts: readonly RiderKycArtefactInsert[],
  ): Promise<RiderKycInsertOutcome>;
  findById(id: string): Promise<RiderKycSubmissionFull | null>;
  listByAccount(accountUuid: string, limit?: number): Promise<readonly RiderKycSubmission[]>;
}

// ─── DelegatedAuthoritySigningsRepo (ID-10) ───────────────────────────────
// Helpan AI Delegated Authority Contract §2.5 scope shape; §6.3 signing API;
// §A.2 cross-rail audit invariant.

export type DelegatedAuthorityPeriod = 'single_use' | 'daily' | 'weekly' | 'monthly';

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

// ─── ID-17 — Operator users + WebAuthn credentials ────────────────────────
// Per docs/NEWDOCS_DECISIONS.md Q3: operator step-up is a sub-surface of
// /v1/stepup/* with `factor=hardware_key` and `operation_kind=operator.*`.
// Operator users are NOT platform accounts — they exist in their own
// table; the step-up token's `sub` claim is the operator user_id
// (opu_<ULID>) instead of the customer account UUID.

export type OperatorUserStatus = 'active' | 'disabled';

export interface OperatorUser {
  id: string; // opu_<ULID>
  appId: string;
  email: string;
  displayName: string;
  status: OperatorUserStatus;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface OperatorUserInsert {
  id: string;
  appId: string;
  email: string;
  displayName: string;
}

export type OperatorUserCreateOutcome =
  | { kind: 'created'; user: OperatorUser }
  | { kind: 'email_collision' };

export interface OperatorUsersRepo {
  create(input: OperatorUserInsert): Promise<OperatorUserCreateOutcome>;
  findById(id: string): Promise<OperatorUser | null>;
  findByAppAndEmail(appId: string, email: string): Promise<OperatorUser | null>;
  recordLogin(id: string, at: Date): Promise<void>;
}

/**
 * A registered FIDO2/WebAuthn credential. `publicKeyJwk` is the COSE key
 * reduced to a JWK-shaped record stored as JSONB. v1.0 stub mode stores
 * a degenerate placeholder; real attestation lands when WEBAUTHN_STUB_MODE
 * flips off.
 */
export interface OperatorWebauthnCredential {
  id: string; // opc_<ULID>
  userId: string;
  credentialIdB64: string;
  publicKeyJwk: Record<string, unknown>;
  signatureCounter: number;
  attestationFormat: string;
  transports: readonly string[] | null;
  displayName: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface OperatorWebauthnCredentialInsert {
  id: string;
  userId: string;
  credentialIdB64: string;
  publicKeyJwk: Record<string, unknown>;
  attestationFormat: string;
  transports?: readonly string[];
  displayName?: string;
}

export interface OperatorWebauthnCredentialsRepo {
  create(input: OperatorWebauthnCredentialInsert): Promise<OperatorWebauthnCredential>;
  findByCredentialId(credentialIdB64: string): Promise<OperatorWebauthnCredential | null>;
  listByUser(userId: string): Promise<OperatorWebauthnCredential[]>;
  /** Bump signature_counter + stamp last_used_at after a successful assertion. */
  recordUse(id: string, newCounter: number, at: Date): Promise<void>;
}

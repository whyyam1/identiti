import { pino } from 'pino';
import { randomBytes } from 'node:crypto';
import type { AppCredentialStore } from '@kmv/platform-shared/fastify-auth';
import type { IdempotencyRecord, IdempotencyStore } from '@kmv/platform-shared';
import type { AppDeps } from '../src/app.js';
import { createPhoneCrypto } from '../src/services/phoneCrypto.js';
import { InMemoryEventProducer } from '../src/services/eventProducer.js';
import { InMemoryAuditLogger } from '../src/services/auditLogger.js';
import { createMemoryCustomersRepo } from '../src/repositories/customers.memory.js';
import { createMemoryAuthChallengesRepo } from '../src/repositories/authChallenges.memory.js';
import { createMemorySessionsRepo } from '../src/repositories/sessions.memory.js';
import { createMemoryStepUpTokensRepo } from '../src/repositories/stepUpTokens.memory.js';
import { createMemoryPhoneTokensRepo } from '../src/repositories/phoneTokens.memory.js';
import { createMemoryKycRecordsRepo } from '../src/repositories/kycRecords.memory.js';
import { createMemoryPhoneChangesRepo } from '../src/repositories/phoneChanges.memory.js';
import { createMemoryDelegatedAuthoritySigningsRepo } from '../src/repositories/delegatedAuthoritySignings.memory.js';
import { createMemoryRiderKycRepo } from '../src/repositories/riderKyc.memory.js';
import { createMemoryKybRepo } from '../src/repositories/kyb.memory.js';
import { createMemoryConsentGrantsRepo } from '../src/repositories/consentGrants.memory.js';
import { createMemoryOperatorUsersRepo } from '../src/repositories/operatorUsers.memory.js';
import { createMemoryOperatorWebauthnCredentialsRepo } from '../src/repositories/operatorWebauthnCredentials.memory.js';
import { loadOrGenerateKeys } from '../src/services/jwtKeys.js';
import { createJwtSigner } from '../src/services/jwtSigner.js';
import { createPhoneTokenSigner } from '../src/services/phoneTokenSigner.js';
import { createStubIprsService } from '../src/services/iprsService.js';
import { createKycHasher } from '../src/services/kycHash.js';
import { createStepupVerifier } from '../src/services/stepupVerifier.js';
import { createDelegatedAuthoritySigner } from '../src/services/delegatedAuthoritySigner.js';
import { createRiderHasher } from '../src/services/riderHash.js';
import { createStubNtsaService } from '../src/services/ntsaService.js';
import { createStubMpesaProbeService } from '../src/services/mpesaProbeService.js';
import { createStubInsuranceService } from '../src/services/insuranceService.js';
import { createKybHasher } from '../src/services/kybHash.js';
import { createStubBrsService } from '../src/services/brsService.js';
import { createStubWebauthnAdapter } from '../src/services/webauthnAdapter.js';

export const TEST_APP_ID = 'identiti_test_app';
export const TEST_HMAC_SECRET = 'test-hmac-secret-32-bytes-of-rand';
export const TEST_OPERATOR_APP_ID = 'identiti_test_operator';
export const TEST_OPERATOR_HMAC_SECRET = 'operator-test-secret-32-bytes_xyz';
export const TEST_TODOKU_APP_ID = 'identiti_test_todoku';
export const TEST_TODOKU_HMAC_SECRET = 'todoku-test-secret-32-bytes_abcde';
export const TEST_HELPAN_AI_APP_ID = 'helpan_ai_internal';
export const TEST_HELPAN_AI_HMAC_SECRET = 'helpan-ai-test-secret-32-bytes_qa';

const TEST_PHONE_ENCRYPTION_KEY = randomBytes(32).toString('hex');
const TEST_PHONE_HASH_SALT = randomBytes(32).toString('hex');
const TEST_KYC_HASH_SALT = randomBytes(32).toString('hex');

// Generate RSA keypairs at module load and share them across every test.
// RSA-2048 generation is ~150-300 ms on modern hardware, far too slow to do
// per buildApp call. Two pairs: one for step-up (Phase 5), one for
// delegated-authority signing (ID-10). Both are published in JWKS.
const SHARED_TEST_KEY_PAIR = loadOrGenerateKeys({
  keyClass: 'step_up',
  ephemeralAllowed: true,
  logger: pino({ level: 'silent' }),
});
const SHARED_TEST_DA_KEY_PAIR = loadOrGenerateKeys({
  keyClass: 'delegated_authority',
  kidOverride: 'helpan-da-2026-q2-test',
  ephemeralAllowed: true,
  logger: pino({ level: 'silent' }),
});

export { SHARED_TEST_KEY_PAIR, SHARED_TEST_DA_KEY_PAIR };

export function makeMemCredStore(opts: { suspended?: boolean } = {}): AppCredentialStore {
  return {
    async lookup(appId) {
      if (appId === TEST_APP_ID) {
        return {
          record: {
            app_id: TEST_APP_ID,
            app_name: 'Test app',
            tenant_class: 'external',
            scopes: [
              'identiti:customers:read',
              'identiti:customers:write',
              'identiti:stepup:request',
              'identiti:stepup:verify',
              'identiti:tier:read',
              // ID-14: a user-facing app records consent grants on the
              // user's behalf, and can read what's open.
              'identiti:consent:read',
              'identiti:consent:write',
            ],
            status: opts.suspended ? 'suspended' : 'active',
          },
          hmacSecret: TEST_HMAC_SECRET,
        };
      }
      if (appId === TEST_OPERATOR_APP_ID) {
        return {
          record: {
            app_id: TEST_OPERATOR_APP_ID,
            app_name: 'Test operator console',
            tenant_class: 'internal',
            scopes: [
              'identiti:operator',
              'identiti:customers:read',
              'identiti:tier:read',
              // ID-17: operator step-up reuses /v1/stepup/* with
              // operation_kind=operator.* + factor=hardware_key.
              'identiti:stepup:request',
              'identiti:stepup:verify',
            ],
            status: 'active',
          },
          hmacSecret: TEST_OPERATOR_HMAC_SECRET,
        };
      }
      if (appId === TEST_TODOKU_APP_ID) {
        return {
          record: {
            app_id: TEST_TODOKU_APP_ID,
            app_name: 'Test Todoku rail-internal',
            tenant_class: 'internal',
            scopes: ['phone_token:resolve'],
            status: 'active',
          },
          hmacSecret: TEST_TODOKU_HMAC_SECRET,
        };
      }
      if (appId === TEST_HELPAN_AI_APP_ID) {
        return {
          record: {
            app_id: TEST_HELPAN_AI_APP_ID,
            app_name: 'Test Helpan AI rail-internal',
            tenant_class: 'internal',
            scopes: ['identiti:internal:sign:delegated_authority'],
            status: 'active',
          },
          hmacSecret: TEST_HELPAN_AI_HMAC_SECRET,
        };
      }
      return null;
    },
  };
}

export function makeMemIdempotencyStore(): IdempotencyStore {
  const data = new Map<string, IdempotencyRecord>();
  return {
    async get(key, appId) {
      return data.get(`${appId}:${key}`) ?? null;
    },
    async set(key, appId, record) {
      data.set(`${appId}:${key}`, record);
    },
  };
}

export interface TestDepsOverrides {
  credentialStore?: AppCredentialStore;
  idempotencyStore?: IdempotencyStore;
  eventProducer?: InMemoryEventProducer;
  auditLogger?: InMemoryAuditLogger;
}

export interface TestDepsBundle extends AppDeps {
  eventProducer: InMemoryEventProducer;
  auditLogger: InMemoryAuditLogger;
  stepUpTokensRepo: ReturnType<typeof createMemoryStepUpTokensRepo>;
  phoneTokensRepo: ReturnType<typeof createMemoryPhoneTokensRepo>;
  kycRecordsRepo: ReturnType<typeof createMemoryKycRecordsRepo>;
  phoneChangesRepo: ReturnType<typeof createMemoryPhoneChangesRepo>;
  delegatedAuthoritySigningsRepo: ReturnType<typeof createMemoryDelegatedAuthoritySigningsRepo>;
  riderKycRepo: ReturnType<typeof createMemoryRiderKycRepo>;
  kybRepo: ReturnType<typeof createMemoryKybRepo>;
  consentGrantsRepo: ReturnType<typeof createMemoryConsentGrantsRepo>;
  operatorUsersRepo: ReturnType<typeof createMemoryOperatorUsersRepo>;
  operatorWebauthnCredentialsRepo: ReturnType<
    typeof createMemoryOperatorWebauthnCredentialsRepo
  >;
  iprsService: ReturnType<typeof createStubIprsService>;
}

export function makeTestDeps(overrides: TestDepsOverrides = {}): TestDepsBundle {
  const eventProducer = overrides.eventProducer ?? new InMemoryEventProducer();
  const auditLogger = overrides.auditLogger ?? new InMemoryAuditLogger();
  const logger = pino({ level: 'silent' });

  const jwtKeyPair = SHARED_TEST_KEY_PAIR;
  const daKeyPair = SHARED_TEST_DA_KEY_PAIR;
  const jwtSigner = createJwtSigner({
    keyPair: jwtKeyPair,
    issuer: 'https://api.id.identiti.co.ke',
  });
  const phoneTokenSigningKey = randomBytes(32);
  const phoneTokenSigner = createPhoneTokenSigner({
    signingKey: phoneTokenSigningKey,
    issuer: 'https://api.id.identiti.co.ke',
  });
  const iprsService = createStubIprsService();
  const kycHasher = createKycHasher(TEST_KYC_HASH_SALT);
  const stepUpTokensRepo = createMemoryStepUpTokensRepo();
  const stepupVerifier = createStepupVerifier({
    jwtKeys: [jwtKeyPair],
    stepUpTokensRepo,
    issuer: 'https://api.id.identiti.co.ke',
  });
  const delegatedAuthoritySigningsRepo = createMemoryDelegatedAuthoritySigningsRepo();
  const delegatedAuthoritySigner = createDelegatedAuthoritySigner({
    daKeys: [daKeyPair],
    expectedIssuer: 'https://api.id.identiti.co.ke',
  });
  const riderKycRepo = createMemoryRiderKycRepo();
  const riderHasher = createRiderHasher(TEST_KYC_HASH_SALT);
  const ntsaService = createStubNtsaService();
  const mpesaProbeService = createStubMpesaProbeService();
  const insuranceService = createStubInsuranceService();
  const kybRepo = createMemoryKybRepo();
  const kybHasher = createKybHasher(TEST_KYC_HASH_SALT);
  const brsService = createStubBrsService();
  const consentGrantsRepo = createMemoryConsentGrantsRepo();
  const operatorUsersRepo = createMemoryOperatorUsersRepo();
  const operatorWebauthnCredentialsRepo = createMemoryOperatorWebauthnCredentialsRepo();
  const webauthnAdapter = createStubWebauthnAdapter({
    origin: 'http://localhost:3002',
  });

  return {
    env: {
      NODE_ENV: 'test',
      PORT: 3002,
      RAIL_VERSION: '0.1.0-test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: 'postgres://test',
      AUTH_HMAC_TOLERANCE_SECONDS: 300,
      IDEMPOTENCY_TTL_SECONDS: 86_400,
      PHONE_ENCRYPTION_KEY: TEST_PHONE_ENCRYPTION_KEY,
      PHONE_HASH_SALT: TEST_PHONE_HASH_SALT,
      KAFKA_BROKERS: [],
      KAFKA_CLIENT_ID: 'identiti-test',
      KAFKA_SSL: false,
      KAFKA_SASL: null,
      JWT_PRIVATE_KEY_PEM: null,
      JWT_PUBLIC_KEY_PEM: null,
      JWT_ISSUER: 'https://api.id.identiti.co.ke',
      JWT_DA_PRIVATE_KEY_PEM: null,
      JWT_DA_PUBLIC_KEY_PEM: null,
      JWT_DA_KID: 'helpan-da-2026-q2-test',
      HELPAN_AI_APP_ID: TEST_HELPAN_AI_APP_ID,
      OTP_BCRYPT_ROUNDS: 4, // fast in tests
      PHONE_TOKEN_SIGNING_KEY: phoneTokenSigningKey.toString('hex'),
      KYC_HASH_SALT: TEST_KYC_HASH_SALT,
      IPRS_STUB_MODE: true,
      WEBAUTHN_STUB_MODE: true,
      WEBAUTHN_RP_ID: 'localhost',
      WEBAUTHN_ORIGIN: 'http://localhost:3002',
    },
    credentialStore: overrides.credentialStore ?? makeMemCredStore(),
    idempotencyStore: overrides.idempotencyStore ?? makeMemIdempotencyStore(),
    customersRepo: createMemoryCustomersRepo(),
    challengesRepo: createMemoryAuthChallengesRepo(),
    sessionsRepo: createMemorySessionsRepo(),
    stepUpTokensRepo,
    phoneTokensRepo: createMemoryPhoneTokensRepo(),
    kycRecordsRepo: createMemoryKycRecordsRepo(),
    phoneChangesRepo: createMemoryPhoneChangesRepo(),
    delegatedAuthoritySigningsRepo,
    riderKycRepo,
    kybRepo,
    consentGrantsRepo,
    operatorUsersRepo,
    operatorWebauthnCredentialsRepo,
    webauthnAdapter,
    phoneCrypto: createPhoneCrypto({
      encryptionKeyHex: TEST_PHONE_ENCRYPTION_KEY,
      hashSaltHex: TEST_PHONE_HASH_SALT,
    }),
    eventProducer,
    auditLogger,
    jwtKeys: [jwtKeyPair, daKeyPair],
    jwtSigner,
    phoneTokenSigner,
    iprsService,
    kycHasher,
    stepupVerifier,
    delegatedAuthoritySigner,
    riderHasher,
    ntsaService,
    mpesaProbeService,
    insuranceService,
    kybHasher,
    brsService,
    logger,
  };
}

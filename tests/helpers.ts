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
import { loadOrGenerateKeys } from '../src/services/jwtKeys.js';
import { createJwtSigner } from '../src/services/jwtSigner.js';
import { createPhoneTokenSigner } from '../src/services/phoneTokenSigner.js';
import { createStubIprsService } from '../src/services/iprsService.js';
import { createKycHasher } from '../src/services/kycHash.js';

export const TEST_APP_ID = 'identiti_test_app';
export const TEST_HMAC_SECRET = 'test-hmac-secret-32-bytes-of-rand';
export const TEST_OPERATOR_APP_ID = 'identiti_test_operator';
export const TEST_OPERATOR_HMAC_SECRET = 'operator-test-secret-32-bytes_xyz';
export const TEST_TODOKU_APP_ID = 'identiti_test_todoku';
export const TEST_TODOKU_HMAC_SECRET = 'todoku-test-secret-32-bytes_abcde';

const TEST_PHONE_ENCRYPTION_KEY = randomBytes(32).toString('hex');
const TEST_PHONE_HASH_SALT = randomBytes(32).toString('hex');
const TEST_KYC_HASH_SALT = randomBytes(32).toString('hex');

// Generate a single RSA keypair at module load and share it across every
// test. RSA-2048 generation is ~150-300 ms on modern hardware, far too slow
// to do per buildApp call.
const SHARED_TEST_KEY_PAIR = loadOrGenerateKeys({
  ephemeralAllowed: true,
  logger: pino({ level: 'silent' }),
});

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
              'identiti:tier:read',
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
  iprsService: ReturnType<typeof createStubIprsService>;
}

export function makeTestDeps(overrides: TestDepsOverrides = {}): TestDepsBundle {
  const eventProducer = overrides.eventProducer ?? new InMemoryEventProducer();
  const auditLogger = overrides.auditLogger ?? new InMemoryAuditLogger();
  const logger = pino({ level: 'silent' });

  const jwtKeyPair = SHARED_TEST_KEY_PAIR;
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
      OTP_BCRYPT_ROUNDS: 4, // fast in tests
      PHONE_TOKEN_SIGNING_KEY: phoneTokenSigningKey.toString('hex'),
      KYC_HASH_SALT: TEST_KYC_HASH_SALT,
      IPRS_STUB_MODE: true,
    },
    credentialStore: overrides.credentialStore ?? makeMemCredStore(),
    idempotencyStore: overrides.idempotencyStore ?? makeMemIdempotencyStore(),
    customersRepo: createMemoryCustomersRepo(),
    challengesRepo: createMemoryAuthChallengesRepo(),
    sessionsRepo: createMemorySessionsRepo(),
    stepUpTokensRepo: createMemoryStepUpTokensRepo(),
    phoneTokensRepo: createMemoryPhoneTokensRepo(),
    kycRecordsRepo: createMemoryKycRecordsRepo(),
    phoneCrypto: createPhoneCrypto({
      encryptionKeyHex: TEST_PHONE_ENCRYPTION_KEY,
      hashSaltHex: TEST_PHONE_HASH_SALT,
    }),
    eventProducer,
    auditLogger,
    jwtKeys: [jwtKeyPair],
    jwtSigner,
    phoneTokenSigner,
    iprsService,
    kycHasher,
    logger,
  };
}

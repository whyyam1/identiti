/**
 * Process entrypoint. Loads env, wires real dependencies (DB-backed stores +
 * Kafka producer + RS256 keypair + JWT signer), builds the Fastify app, and
 * starts listening.
 *
 * Fallbacks (development/test only):
 *   - KAFKA_BROKERS empty → in-memory event producer (with warning).
 *   - JWT_*_PEM unset    → ephemeral RS256 keypair (with warning).
 */

import { loadEnv } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { createDb } from './db/client.js';
import { createCredentialStore } from './adapters/credentialStore.js';
import { createIdempotencyStore } from './adapters/idempotencyStore.js';
import { createPhoneCrypto } from './services/phoneCrypto.js';
import { createPgCustomersRepo } from './repositories/customers.js';
import { createPgAuthChallengesRepo } from './repositories/authChallenges.js';
import { createPgSessionsRepo } from './repositories/sessions.js';
import { createPgStepUpTokensRepo } from './repositories/stepUpTokens.js';
import { createPgPhoneTokensRepo } from './repositories/phoneTokens.js';
import { createPgKycRecordsRepo } from './repositories/kycRecords.js';
import { createDbAuditLogger } from './services/auditLogger.js';
import {
  InMemoryEventProducer,
  KafkaJsEventProducer,
  type EventProducer,
} from './services/eventProducer.js';
import { loadOrGenerateKeys } from './services/jwtKeys.js';
import { createJwtSigner } from './services/jwtSigner.js';
import { createPhoneTokenSigner } from './services/phoneTokenSigner.js';
import { createStubIprsService } from './services/iprsService.js';
import { createKycHasher } from './services/kycHash.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env);

  const db = createDb(env.DATABASE_URL);
  const credentialStore = createCredentialStore(db);
  const idempotencyStore = createIdempotencyStore(db);
  const customersRepo = createPgCustomersRepo(db);
  const challengesRepo = createPgAuthChallengesRepo(db);
  const sessionsRepo = createPgSessionsRepo(db);
  const stepUpTokensRepo = createPgStepUpTokensRepo(db);
  const phoneTokensRepo = createPgPhoneTokensRepo(db);
  const kycRecordsRepo = createPgKycRecordsRepo(db);
  const kycHasher = createKycHasher(env.KYC_HASH_SALT);

  // IPRS Track A access not provisioned at v1.0 build time. The stub is the
  // only impl shipped today; production must wire a real IprsService when
  // Reboot Pack §7 ID-D-06 closes.
  if (!env.IPRS_STUB_MODE && env.NODE_ENV === 'production') {
    throw new Error(
      'IPRS_STUB_MODE=false in production but no real IPRS adapter is wired (Reboot Pack §7 ID-D-06)'
    );
  }
  const iprsService = createStubIprsService();
  if (env.IPRS_STUB_MODE) {
    logger.warn('IPRS_STUB_MODE=true — using deterministic IPRS stub. Track A access pending.');
  }
  const phoneCrypto = createPhoneCrypto({
    encryptionKeyHex: env.PHONE_ENCRYPTION_KEY,
    hashSaltHex: env.PHONE_HASH_SALT,
  });
  const auditLogger = createDbAuditLogger(db);

  const jwtKeyPair = loadOrGenerateKeys({
    privatePem: env.JWT_PRIVATE_KEY_PEM ?? undefined,
    publicPem: env.JWT_PUBLIC_KEY_PEM ?? undefined,
    ephemeralAllowed: env.NODE_ENV === 'development' || env.NODE_ENV === 'test',
    logger,
  });
  const jwtSigner = createJwtSigner({ keyPair: jwtKeyPair, issuer: env.JWT_ISSUER });
  const phoneTokenSigningKey = Buffer.from(env.PHONE_TOKEN_SIGNING_KEY, 'hex');
  if (phoneTokenSigningKey.length < 32) {
    throw new Error(
      `PHONE_TOKEN_SIGNING_KEY must decode to >= 32 bytes; got ${phoneTokenSigningKey.length}`
    );
  }
  const phoneTokenSigner = createPhoneTokenSigner({
    signingKey: phoneTokenSigningKey,
    issuer: env.JWT_ISSUER,
  });

  let eventProducer: EventProducer;
  if (env.KAFKA_BROKERS.length > 0) {
    eventProducer = new KafkaJsEventProducer({
      clientId: env.KAFKA_CLIENT_ID,
      brokers: env.KAFKA_BROKERS,
      logger,
      ssl: env.KAFKA_SSL,
      ...(env.KAFKA_SASL ? { sasl: env.KAFKA_SASL } : {}),
    });
  } else {
    logger.warn(
      'KAFKA_BROKERS empty — using in-memory event producer. Events will not propagate cross-rail. Acceptable for dev only.'
    );
    eventProducer = new InMemoryEventProducer();
  }

  const app = await buildApp({
    env,
    credentialStore,
    idempotencyStore,
    customersRepo,
    challengesRepo,
    sessionsRepo,
    stepUpTokensRepo,
    phoneTokensRepo,
    kycRecordsRepo,
    phoneCrypto,
    eventProducer,
    auditLogger,
    jwtKeys: [jwtKeyPair],
    jwtSigner,
    phoneTokenSigner,
    iprsService,
    kycHasher,
    logger,
  });

  try {
    await app.listen({ host: '0.0.0.0', port: env.PORT });
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, kid: jwtKeyPair.kid },
      'Identiti API listening'
    );
  } catch (err) {
    logger.error({ err }, 'failed to start server');
    process.exit(1);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      logger.info({ signal }, 'received shutdown signal');
      void (async () => {
        await app.close();
        await eventProducer.shutdown();
        process.exit(0);
      })();
    });
  }
}

void main();

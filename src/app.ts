/**
 * App factory. Composes plugins and routes; takes deps via injection so tests
 * can supply in-memory stubs without a live database.
 *
 * Plugin order matters:
 *   1. requestContext   — sets request.requestId.
 *   2. authPlugin       — verifies HMAC; sets request.appId / tenantRecord.
 *   3. idempotencyPlugin — depends on request.appId.
 *   4. routes           — health, jwks (public), customers, auth, tier, operator.
 *
 * Exempt paths bypass auth entirely: /v1/health and /.well-known/jwks.json.
 */

import Fastify from 'fastify';
import { authPlugin, type AppCredentialStore } from '@kmv/platform-shared/fastify-auth';
import { idempotencyPlugin } from '@kmv/platform-shared/fastify-idempotency';
import { errorResponse, type IdempotencyStore } from '@kmv/platform-shared';
import { requestContextPlugin } from './plugins/requestContext.js';
import { healthRoutes } from './routes/health.js';
import { customersRoutes } from './routes/customers.js';
import { operatorRoutes } from './routes/operator.js';
import { jwksRoutes } from './routes/jwks.js';
import { authRoutes } from './routes/auth.js';
import { tierRoutes } from './routes/tier.js';
import { stepupRoutes } from './routes/stepup.js';
import { phoneTokensRoutes } from './routes/phoneTokens.js';
import { phoneChangeRoutes } from './routes/phoneChange.js';
import { kycRoutes } from './routes/kyc.js';
import { riderKycRoutes } from './routes/riderKyc.js';
import { kybRoutes } from './routes/kyb.js';
import { internalRoutes } from './routes/internal.js';
import { operatorSessionRoutes } from './routes/operatorSession.js';
import { consentRoutes } from './routes/consent.js';
import { demoRoutes } from './routes/demo.js';
import type { Env } from './config/env.js';
import type { Logger } from './lib/logger.js';
import type {
  AuthChallengesRepo,
  ConsentGrantsRepo,
  CustomersRepo,
  DelegatedAuthoritySigningsRepo,
  KybRepo,
  KycRecordsRepo,
  OperatorUsersRepo,
  OperatorWebauthnCredentialsRepo,
  PhoneChangesRepo,
  PhoneTokensRepo,
  RiderKycRepo,
  SessionsRepo,
  StepUpTokensRepo,
} from './repositories/types.js';
import type { PhoneCrypto } from './services/phoneCrypto.js';
import type { EventProducer } from './services/eventProducer.js';
import type { AuditLogger } from './services/auditLogger.js';
import type { JwtKeyPair } from './services/jwtKeys.js';
import type { JwtSigner } from './services/jwtSigner.js';
import type { PhoneTokenSigner } from './services/phoneTokenSigner.js';
import type { IprsService } from './services/iprsService.js';
import type { KycHasher } from './services/kycHash.js';
import type { StepupVerifier } from './services/stepupVerifier.js';
import type { DelegatedAuthoritySigner } from './services/delegatedAuthoritySigner.js';
import type { RiderHasher } from './services/riderHash.js';
import type { NtsaService } from './services/ntsaService.js';
import type { MpesaProbeService } from './services/mpesaProbeService.js';
import type { InsuranceService } from './services/insuranceService.js';
import type { KybHasher } from './services/kybHash.js';
import type { BrsService } from './services/brsService.js';
import type { WebauthnAdapter } from './services/webauthnAdapter.js';

export interface AppDeps {
  env: Env;
  credentialStore: AppCredentialStore;
  idempotencyStore: IdempotencyStore;
  customersRepo: CustomersRepo;
  challengesRepo: AuthChallengesRepo;
  sessionsRepo: SessionsRepo;
  stepUpTokensRepo: StepUpTokensRepo;
  phoneTokensRepo: PhoneTokensRepo;
  kycRecordsRepo: KycRecordsRepo;
  phoneChangesRepo: PhoneChangesRepo;
  delegatedAuthoritySigningsRepo: DelegatedAuthoritySigningsRepo;
  riderKycRepo: RiderKycRepo;
  kybRepo: KybRepo;
  /** ID-14 */
  consentGrantsRepo: ConsentGrantsRepo;
  /** ID-17 */
  operatorUsersRepo: OperatorUsersRepo;
  /** ID-17 */
  operatorWebauthnCredentialsRepo: OperatorWebauthnCredentialsRepo;
  /** ID-17 */
  webauthnAdapter: WebauthnAdapter;
  phoneCrypto: PhoneCrypto;
  eventProducer: EventProducer;
  auditLogger: AuditLogger;
  /** All JWKS-publishable RSA keys — both step-up (Phase 3/5) and delegated-authority (ID-10). */
  jwtKeys: readonly JwtKeyPair[];
  jwtSigner: JwtSigner;
  phoneTokenSigner: PhoneTokenSigner;
  iprsService: IprsService;
  kycHasher: KycHasher;
  stepupVerifier: StepupVerifier;
  delegatedAuthoritySigner: DelegatedAuthoritySigner;
  riderHasher: RiderHasher;
  ntsaService: NtsaService;
  mpesaProbeService: MpesaProbeService;
  insuranceService: InsuranceService;
  kybHasher: KybHasher;
  brsService: BrsService;
  logger: Logger;
}

export type App = Awaited<ReturnType<typeof buildApp>>;

const EXEMPT_PATHS = ['/v1/health', '/.well-known/jwks.json', '/', '/demo'] as const;

export async function buildApp(deps: AppDeps) {
  const app = Fastify({
    logger: deps.logger,
    disableRequestLogging: false,
    bodyLimit: 1024 * 1024,
  });

  app.setErrorHandler(async (err, request, reply) => {
    deps.logger.error({ err, requestId: request.requestId }, 'unhandled error');
    return reply
      .code(500)
      .send(errorResponse('INTERNAL_UNSPECIFIED', 'Internal server error', request.requestId));
  });

  app.setNotFoundHandler(async (request, reply) => {
    return reply.code(404).send(errorResponse('NOT_FOUND', 'Route not found', request.requestId));
  });

  await app.register(requestContextPlugin);

  await app.register(authPlugin, {
    railPrefix: 'Identiti',
    timestampHeaderName: 'X-Identiti-Timestamp',
    toleranceSeconds: deps.env.AUTH_HMAC_TOLERANCE_SECONDS,
    credentialStore: deps.credentialStore,
    exemptPaths: EXEMPT_PATHS,
  });

  await app.register(idempotencyPlugin, {
    store: deps.idempotencyStore,
    ttlSeconds: deps.env.IDEMPOTENCY_TTL_SECONDS,
    protectedMethods: ['POST', 'PUT', 'PATCH', 'DELETE'],
  });

  await app.register(healthRoutes(deps.env));
  await app.register(jwksRoutes({ keys: deps.jwtKeys }));
  await app.register(demoRoutes({ logger: deps.logger }));
  await app.register(
    customersRoutes({
      customersRepo: deps.customersRepo,
      phoneCrypto: deps.phoneCrypto,
      eventProducer: deps.eventProducer,
      auditLogger: deps.auditLogger,
    }),
  );
  await app.register(
    authRoutes({
      customersRepo: deps.customersRepo,
      challengesRepo: deps.challengesRepo,
      sessionsRepo: deps.sessionsRepo,
      phoneTokensRepo: deps.phoneTokensRepo,
      phoneCrypto: deps.phoneCrypto,
      eventProducer: deps.eventProducer,
      auditLogger: deps.auditLogger,
      jwtSigner: deps.jwtSigner,
      phoneTokenSigner: deps.phoneTokenSigner,
      otpBcryptRounds: deps.env.OTP_BCRYPT_ROUNDS,
      envName: deps.env.NODE_ENV,
    }),
  );
  await app.register(
    phoneTokensRoutes({
      customersRepo: deps.customersRepo,
      phoneTokensRepo: deps.phoneTokensRepo,
      phoneTokenSigner: deps.phoneTokenSigner,
      auditLogger: deps.auditLogger,
    }),
  );
  await app.register(
    kycRoutes({
      customersRepo: deps.customersRepo,
      kycRecordsRepo: deps.kycRecordsRepo,
      iprsService: deps.iprsService,
      kycHasher: deps.kycHasher,
      eventProducer: deps.eventProducer,
      auditLogger: deps.auditLogger,
    }),
  );
  await app.register(
    riderKycRoutes({
      customersRepo: deps.customersRepo,
      riderKycRepo: deps.riderKycRepo,
      riderHasher: deps.riderHasher,
      ntsaService: deps.ntsaService,
      mpesaProbeService: deps.mpesaProbeService,
      insuranceService: deps.insuranceService,
      eventProducer: deps.eventProducer,
      auditLogger: deps.auditLogger,
    }),
  );
  await app.register(
    kybRoutes({
      customersRepo: deps.customersRepo,
      kycRecordsRepo: deps.kycRecordsRepo,
      kybRepo: deps.kybRepo,
      kybHasher: deps.kybHasher,
      brsService: deps.brsService,
      eventProducer: deps.eventProducer,
      auditLogger: deps.auditLogger,
    }),
  );
  await app.register(
    phoneChangeRoutes({
      customersRepo: deps.customersRepo,
      challengesRepo: deps.challengesRepo,
      phoneChangesRepo: deps.phoneChangesRepo,
      phoneCrypto: deps.phoneCrypto,
      eventProducer: deps.eventProducer,
      auditLogger: deps.auditLogger,
      stepupVerifier: deps.stepupVerifier,
      otpBcryptRounds: deps.env.OTP_BCRYPT_ROUNDS,
    }),
  );
  await app.register(tierRoutes({ customersRepo: deps.customersRepo }));
  await app.register(
    stepupRoutes({
      customersRepo: deps.customersRepo,
      challengesRepo: deps.challengesRepo,
      stepUpTokensRepo: deps.stepUpTokensRepo,
      operatorUsersRepo: deps.operatorUsersRepo,
      operatorWebauthnCredentialsRepo: deps.operatorWebauthnCredentialsRepo,
      webauthnAdapter: deps.webauthnAdapter,
      eventProducer: deps.eventProducer,
      auditLogger: deps.auditLogger,
      jwtSigner: deps.jwtSigner,
      stepupVerifier: deps.stepupVerifier,
      otpBcryptRounds: deps.env.OTP_BCRYPT_ROUNDS,
      envName: deps.env.NODE_ENV,
    }),
  );
  await app.register(
    operatorSessionRoutes({
      operatorUsersRepo: deps.operatorUsersRepo,
      operatorWebauthnCredentialsRepo: deps.operatorWebauthnCredentialsRepo,
      challengesRepo: deps.challengesRepo,
      webauthnAdapter: deps.webauthnAdapter,
      auditLogger: deps.auditLogger,
      webauthnRpId: deps.env.WEBAUTHN_RP_ID,
      webauthnOrigin: deps.env.WEBAUTHN_ORIGIN,
    }),
  );
  await app.register(
    operatorRoutes({
      customersRepo: deps.customersRepo,
      kycRecordsRepo: deps.kycRecordsRepo,
      eventProducer: deps.eventProducer,
      auditLogger: deps.auditLogger,
    }),
  );
  await app.register(
    consentRoutes({
      customersRepo: deps.customersRepo,
      consentGrantsRepo: deps.consentGrantsRepo,
      eventProducer: deps.eventProducer,
      auditLogger: deps.auditLogger,
    }),
  );
  await app.register(
    internalRoutes({
      customersRepo: deps.customersRepo,
      stepUpTokensRepo: deps.stepUpTokensRepo,
      delegatedAuthoritySigningsRepo: deps.delegatedAuthoritySigningsRepo,
      delegatedAuthoritySigner: deps.delegatedAuthoritySigner,
      auditLogger: deps.auditLogger,
      helpanAiAppId: deps.env.HELPAN_AI_APP_ID,
    }),
  );

  return app;
}

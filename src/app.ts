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
import type { Env } from './config/env.js';
import type { Logger } from './lib/logger.js';
import type {
  AuthChallengesRepo,
  CustomersRepo,
  PhoneTokensRepo,
  SessionsRepo,
  StepUpTokensRepo,
} from './repositories/types.js';
import type { PhoneCrypto } from './services/phoneCrypto.js';
import type { EventProducer } from './services/eventProducer.js';
import type { AuditLogger } from './services/auditLogger.js';
import type { JwtKeyPair } from './services/jwtKeys.js';
import type { JwtSigner } from './services/jwtSigner.js';
import type { PhoneTokenSigner } from './services/phoneTokenSigner.js';

export interface AppDeps {
  env: Env;
  credentialStore: AppCredentialStore;
  idempotencyStore: IdempotencyStore;
  customersRepo: CustomersRepo;
  challengesRepo: AuthChallengesRepo;
  sessionsRepo: SessionsRepo;
  stepUpTokensRepo: StepUpTokensRepo;
  phoneTokensRepo: PhoneTokensRepo;
  phoneCrypto: PhoneCrypto;
  eventProducer: EventProducer;
  auditLogger: AuditLogger;
  jwtKeys: readonly JwtKeyPair[];
  jwtSigner: JwtSigner;
  phoneTokenSigner: PhoneTokenSigner;
  logger: Logger;
}

export type App = Awaited<ReturnType<typeof buildApp>>;

const EXEMPT_PATHS = ['/v1/health', '/.well-known/jwks.json'] as const;

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
    return reply
      .code(404)
      .send(errorResponse('NOT_FOUND', 'Route not found', request.requestId));
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
  await app.register(
    customersRoutes({
      customersRepo: deps.customersRepo,
      phoneCrypto: deps.phoneCrypto,
      eventProducer: deps.eventProducer,
      auditLogger: deps.auditLogger,
    })
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
    })
  );
  await app.register(
    phoneTokensRoutes({
      customersRepo: deps.customersRepo,
      phoneTokensRepo: deps.phoneTokensRepo,
      phoneTokenSigner: deps.phoneTokenSigner,
      auditLogger: deps.auditLogger,
    })
  );
  await app.register(tierRoutes({ customersRepo: deps.customersRepo }));
  await app.register(
    stepupRoutes({
      customersRepo: deps.customersRepo,
      challengesRepo: deps.challengesRepo,
      stepUpTokensRepo: deps.stepUpTokensRepo,
      eventProducer: deps.eventProducer,
      auditLogger: deps.auditLogger,
      jwtSigner: deps.jwtSigner,
      otpBcryptRounds: deps.env.OTP_BCRYPT_ROUNDS,
      envName: deps.env.NODE_ENV,
    })
  );
  await app.register(
    operatorRoutes({
      customersRepo: deps.customersRepo,
      eventProducer: deps.eventProducer,
      auditLogger: deps.auditLogger,
    })
  );

  return app;
}

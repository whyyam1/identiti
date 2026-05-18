/**
 * Environment loader. Loads .env in dev/test (via dotenv); validates required keys;
 * returns a typed Env object. Fails fast on missing required keys.
 *
 * Sprint 1 adds: PHONE_ENCRYPTION_KEY (required), PHONE_HASH_SALT (required),
 *                KAFKA_* (required in production; optional elsewhere — falls
 *                back to in-memory event producer with a startup warning).
 */

import { config as loadDotenv } from 'dotenv';

loadDotenv();

export type NodeEnv = 'development' | 'test' | 'staging' | 'production';

// Discriminated union to match kafkajs's SASLOptions shape (each mechanism
// is its own type member; widening to a string-union breaks assignment).
export type KafkaSaslConfig =
  | { mechanism: 'plain'; username: string; password: string }
  | { mechanism: 'scram-sha-256'; username: string; password: string }
  | { mechanism: 'scram-sha-512'; username: string; password: string };

export interface Env {
  NODE_ENV: NodeEnv;
  PORT: number;
  RAIL_VERSION: string;
  LOG_LEVEL: string;
  DATABASE_URL: string;
  AUTH_HMAC_TOLERANCE_SECONDS: number;
  IDEMPOTENCY_TTL_SECONDS: number;
  PHONE_ENCRYPTION_KEY: string;
  PHONE_HASH_SALT: string;
  KAFKA_BROKERS: string[];
  KAFKA_CLIENT_ID: string;
  KAFKA_SSL: boolean;
  KAFKA_SASL: KafkaSaslConfig | null;
  JWT_PRIVATE_KEY_PEM: string | null;
  JWT_PUBLIC_KEY_PEM: string | null;
  JWT_ISSUER: string;
  /** ID-10 (Delegated Authority Contract §8.1) — separate signing key for delegated-authority tokens. */
  JWT_DA_PRIVATE_KEY_PEM: string | null;
  JWT_DA_PUBLIC_KEY_PEM: string | null;
  /** ID-10 — literal kid for the DA key, e.g. `helpan-da-2026-q2`. Falls back to an ephemeral kid in dev/test. */
  JWT_DA_KID: string | null;
  /** ID-10 — Helpan AI's HMAC tenant app_id; restricts who can call POST /v1/internal/sign. */
  HELPAN_AI_APP_ID: string;
  OTP_BCRYPT_ROUNDS: number;
  /** HS256 key for phone-token signing. 64 hex chars (32 bytes). */
  PHONE_TOKEN_SIGNING_KEY: string;
  /** PBKDF2 salt for hashing national IDs. 64 hex chars recommended. */
  KYC_HASH_SALT: string;
  /** When true, IPRS lookups go to the deterministic stub instead of the real upstream. */
  IPRS_STUB_MODE: boolean;
}

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function asInt(name: string, value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Environment variable ${name} must be an integer; got ${value}`);
  }
  return n;
}

function asBool(name: string, value: string): boolean {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0' || value === '') return false;
  throw new Error(`Environment variable ${name} must be true/false; got ${value}`);
}

const VALID_NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'staging', 'production'];

function asNodeEnv(value: string): NodeEnv {
  if (!VALID_NODE_ENVS.includes(value as NodeEnv)) {
    throw new Error(`NODE_ENV must be one of ${VALID_NODE_ENVS.join(', ')}; got ${value}`);
  }
  return value as NodeEnv;
}

function loadKafka(nodeEnv: NodeEnv): {
  brokers: string[];
  clientId: string;
  ssl: boolean;
  sasl: KafkaSaslConfig | null;
} {
  const brokersRaw = optional('KAFKA_BROKERS', '');
  const brokers = brokersRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (brokers.length === 0 && nodeEnv === 'production') {
    throw new Error('KAFKA_BROKERS is required in production');
  }

  const clientId = optional('KAFKA_CLIENT_ID', 'identiti');
  const ssl = asBool('KAFKA_SSL', optional('KAFKA_SSL', 'false'));

  const saslMechRaw = optional('KAFKA_SASL_MECHANISM', '');
  let sasl: KafkaSaslConfig | null = null;
  if (saslMechRaw) {
    const username = required('KAFKA_SASL_USERNAME');
    const password = required('KAFKA_SASL_PASSWORD');
    if (saslMechRaw === 'plain') {
      sasl = { mechanism: 'plain', username, password };
    } else if (saslMechRaw === 'scram-sha-256') {
      sasl = { mechanism: 'scram-sha-256', username, password };
    } else if (saslMechRaw === 'scram-sha-512') {
      sasl = { mechanism: 'scram-sha-512', username, password };
    } else {
      throw new Error(
        `KAFKA_SASL_MECHANISM must be plain|scram-sha-256|scram-sha-512; got ${saslMechRaw}`,
      );
    }
  }

  return { brokers, clientId, ssl, sasl };
}

export function loadEnv(): Env {
  const NODE_ENV = asNodeEnv(optional('NODE_ENV', 'development'));
  const kafka = loadKafka(NODE_ENV);

  return {
    NODE_ENV,
    PORT: asInt('PORT', optional('PORT', '3002')),
    RAIL_VERSION: optional('RAIL_VERSION', '0.1.0'),
    LOG_LEVEL: optional('LOG_LEVEL', NODE_ENV === 'development' ? 'debug' : 'info'),
    DATABASE_URL: required('DATABASE_URL'),
    AUTH_HMAC_TOLERANCE_SECONDS: asInt(
      'AUTH_HMAC_TOLERANCE_SECONDS',
      optional('AUTH_HMAC_TOLERANCE_SECONDS', '300'),
    ),
    IDEMPOTENCY_TTL_SECONDS: asInt(
      'IDEMPOTENCY_TTL_SECONDS',
      optional('IDEMPOTENCY_TTL_SECONDS', '86400'),
    ),
    PHONE_ENCRYPTION_KEY: required('PHONE_ENCRYPTION_KEY'),
    PHONE_HASH_SALT: required('PHONE_HASH_SALT'),
    KAFKA_BROKERS: kafka.brokers,
    KAFKA_CLIENT_ID: kafka.clientId,
    KAFKA_SSL: kafka.ssl,
    KAFKA_SASL: kafka.sasl,
    JWT_PRIVATE_KEY_PEM: loadJwtPem('JWT_PRIVATE_KEY_PEM', NODE_ENV),
    JWT_PUBLIC_KEY_PEM: loadJwtPem('JWT_PUBLIC_KEY_PEM', NODE_ENV),
    JWT_ISSUER: optional('JWT_ISSUER', 'https://api.id.identiti.co.ke'),
    JWT_DA_PRIVATE_KEY_PEM: loadJwtPem('JWT_DA_PRIVATE_KEY_PEM', NODE_ENV),
    JWT_DA_PUBLIC_KEY_PEM: loadJwtPem('JWT_DA_PUBLIC_KEY_PEM', NODE_ENV),
    JWT_DA_KID: optional('JWT_DA_KID', '') || null,
    HELPAN_AI_APP_ID: optional('HELPAN_AI_APP_ID', 'helpan_ai_internal'),
    OTP_BCRYPT_ROUNDS: asInt('OTP_BCRYPT_ROUNDS', optional('OTP_BCRYPT_ROUNDS', '10')),
    PHONE_TOKEN_SIGNING_KEY: required('PHONE_TOKEN_SIGNING_KEY'),
    KYC_HASH_SALT: required('KYC_HASH_SALT'),
    IPRS_STUB_MODE: asBool('IPRS_STUB_MODE', optional('IPRS_STUB_MODE', 'true')),
  };
}

function loadJwtPem(name: string, nodeEnv: NodeEnv): string | null {
  const v = process.env[name];
  if (v && v.length > 0) {
    // Railway / docker single-line env values commonly escape newlines as `\n`.
    return v.includes('\\n') ? v.replace(/\\n/g, '\n') : v;
  }
  if (nodeEnv === 'production' || nodeEnv === 'staging') {
    throw new Error(`${name} is required in ${nodeEnv}`);
  }
  return null;
}

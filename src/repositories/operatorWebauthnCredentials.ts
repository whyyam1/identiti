/**
 * Postgres-backed OperatorWebauthnCredentialsRepo. ID-17.
 */

import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { operatorWebauthnCredentials } from '../db/schema.js';
import type {
  OperatorWebauthnCredential,
  OperatorWebauthnCredentialsRepo,
} from './types.js';

export function createPgOperatorWebauthnCredentialsRepo(
  db: Db,
): OperatorWebauthnCredentialsRepo {
  const toRow = (
    r: typeof operatorWebauthnCredentials.$inferSelect,
  ): OperatorWebauthnCredential => ({
    id: r.id,
    userId: r.userId,
    credentialIdB64: r.credentialIdB64,
    publicKeyJwk: r.publicKeyJwk as Record<string, unknown>,
    signatureCounter: r.signatureCounter,
    attestationFormat: r.attestationFormat,
    transports: r.transports,
    displayName: r.displayName,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
  });

  return {
    async create(input) {
      const [row] = await db
        .insert(operatorWebauthnCredentials)
        .values({
          id: input.id,
          userId: input.userId,
          credentialIdB64: input.credentialIdB64,
          publicKeyJwk: input.publicKeyJwk,
          attestationFormat: input.attestationFormat,
          transports: input.transports ? [...input.transports] : null,
          displayName: input.displayName ?? null,
        })
        .returning();
      if (!row) throw new Error('operator_webauthn_credentials insert returned no row');
      return toRow(row);
    },

    async findByCredentialId(credentialIdB64) {
      const rows = await db
        .select()
        .from(operatorWebauthnCredentials)
        .where(eq(operatorWebauthnCredentials.credentialIdB64, credentialIdB64))
        .limit(1);
      const r = rows[0];
      return r ? toRow(r) : null;
    },

    async listByUser(userId) {
      const rows = await db
        .select()
        .from(operatorWebauthnCredentials)
        .where(eq(operatorWebauthnCredentials.userId, userId));
      return rows.map(toRow);
    },

    async recordUse(id, newCounter, at) {
      await db
        .update(operatorWebauthnCredentials)
        .set({ signatureCounter: newCounter, lastUsedAt: at })
        .where(eq(operatorWebauthnCredentials.id, id));
    },
  };
}

/**
 * In-memory OperatorWebauthnCredentialsRepo for tests. ID-17.
 */

import type {
  OperatorWebauthnCredential,
  OperatorWebauthnCredentialsRepo,
} from './types.js';

export function createMemoryOperatorWebauthnCredentialsRepo(): OperatorWebauthnCredentialsRepo {
  const byId = new Map<string, OperatorWebauthnCredential>();
  const byCredId = new Map<string, OperatorWebauthnCredential>();

  return {
    async create(input) {
      const c: OperatorWebauthnCredential = {
        id: input.id,
        userId: input.userId,
        credentialIdB64: input.credentialIdB64,
        publicKeyJwk: { ...input.publicKeyJwk },
        signatureCounter: 0,
        attestationFormat: input.attestationFormat,
        transports: input.transports ? [...input.transports] : null,
        displayName: input.displayName ?? null,
        createdAt: new Date(),
        lastUsedAt: null,
      };
      byId.set(c.id, c);
      byCredId.set(c.credentialIdB64, c);
      return { ...c, publicKeyJwk: { ...c.publicKeyJwk } };
    },

    async findByCredentialId(credentialIdB64) {
      const c = byCredId.get(credentialIdB64);
      return c ? { ...c, publicKeyJwk: { ...c.publicKeyJwk } } : null;
    },

    async listByUser(userId) {
      return Array.from(byId.values())
        .filter((c) => c.userId === userId)
        .map((c) => ({ ...c, publicKeyJwk: { ...c.publicKeyJwk } }));
    },

    async recordUse(id, newCounter, at) {
      const c = byId.get(id);
      if (c) {
        c.signatureCounter = newCounter;
        c.lastUsedAt = at;
      }
    },
  };
}

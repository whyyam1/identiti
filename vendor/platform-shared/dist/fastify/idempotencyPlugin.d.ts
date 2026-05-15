/**
 * Fastify plugin: idempotency middleware.
 * Per Instruction Pack §2.8; Identiti Rail Contract §6 (per-(app, endpoint, key) scope).
 *
 *   1. On protected method (POST/PUT/PATCH/DELETE), require X-Idempotency-Key.
 *      Missing → REQ_IDEMPOTENCY_KEY_MISSING (400).
 *   2. Compose scoped key: {METHOD}:{routePath}:{key} so the same key on a
 *      different endpoint cannot collide.
 *   3. Hash request body (raw bytes, captured by authPlugin's parser).
 *   4. Look up store by (scopedKey, appId).
 *      - Found + body hash matches → replay stored response with
 *        X-Idempotency-Replayed: true.
 *      - Found + body hash differs → REQ_IDEMPOTENCY_KEY_CONFLICT (409).
 *      - Not found → continue; capture response in onSend and persist.
 *
 * Requires authPlugin to have run first so request.appId is set.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { IdempotencyStore } from '../idempotency.js';
export interface IdempotencyPluginConfig {
    store: IdempotencyStore;
    ttlSeconds: number;
    protectedMethods: readonly ('POST' | 'PUT' | 'PATCH' | 'DELETE')[];
    /**
     * Paths exempt from the idempotency check (e.g. vendor inbound webhooks
     * that have their own per-vendor signature surface and don't carry
     * X-Idempotency-Key). Matched on the URL path with exact equality, same
     * shape as authPlugin's exemptPaths.
     */
    exemptPaths?: readonly string[];
    /** Prefix-match exemptions. Mirrors authPlugin.exemptPrefixes. */
    exemptPrefixes?: readonly string[];
}
interface IdempotencyMeta {
    scopedKey: string;
    appId: string;
    bodyHash: string;
}
declare module 'fastify' {
    interface FastifyRequest {
        idempotencyMeta?: IdempotencyMeta;
    }
}
export declare const idempotencyPlugin: FastifyPluginAsync<IdempotencyPluginConfig>;
export {};
//# sourceMappingURL=idempotencyPlugin.d.ts.map
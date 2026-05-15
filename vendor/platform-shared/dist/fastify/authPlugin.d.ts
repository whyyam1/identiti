/**
 * Fastify plugin: HMAC verification for inbound rail requests.
 * Per Instruction Pack §2.7, §4.
 *
 * Verification sequence:
 *   1. Skip exempt paths (e.g. /v1/health).
 *   2. Parse Authorization header   → AUTH_HMAC_INVALID (401)
 *   3. Verify rail prefix matches   → AUTH_HMAC_INVALID (401)
 *   4. Validate timestamp window    → AUTH_TIMESTAMP_EXPIRED (401)
 *   5. Look up app credentials      → AUTH_HMAC_INVALID (401) if unknown
 *   6. Reject if app suspended      → AUTH_APP_SUSPENDED (403)
 *   7. Recompute HMAC over canonical string and compare (constant-time)
 *                                    → AUTH_HMAC_INVALID (401) on mismatch
 *   8. Attach { appId, tenantRecord } to request.
 *
 * Side-effect: replaces the default application/json parser with one that
 * also captures the raw request body on `request.rawBody`. The raw body
 * is required for HMAC computation (canonical string includes SHA-256 of
 * the bytes the client signed; serialise-then-rehash is fragile).
 */
import type { FastifyPluginAsync } from 'fastify';
import { type RailPrefix } from '../hmac.js';
export interface TenantRecord {
    app_id: string;
    app_name: string;
    tenant_class: 'internal' | 'external';
    scopes: readonly string[];
    status: 'active' | 'suspended';
}
export interface AppCredentialStore {
    lookup(appId: string): Promise<{
        record: TenantRecord;
        hmacSecret: string;
    } | null>;
}
export interface AuthPluginConfig {
    railPrefix: RailPrefix;
    timestampHeaderName: string;
    toleranceSeconds: number;
    credentialStore: AppCredentialStore;
    /** Exact-match paths exempt from auth (e.g. /v1/health). */
    exemptPaths: readonly string[];
    /**
     * Prefix-match exemptions. Applied with `path.startsWith(prefix)`. Used
     * for path families with variable segments (e.g. /v1/inbound/, /v1/operator/)
     * which have their own per-vendor or per-operator auth surface.
     */
    exemptPrefixes?: readonly string[];
}
declare module 'fastify' {
    interface FastifyRequest {
        rawBody?: string;
        appId?: string;
        tenantRecord?: TenantRecord;
    }
}
export declare const authPlugin: FastifyPluginAsync<AuthPluginConfig>;
//# sourceMappingURL=authPlugin.d.ts.map
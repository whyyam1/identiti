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
import fp from 'fastify-plugin';
import { buildCanonicalString, parseAuthorizationHeader, sha256Hex, verifyHmac, verifyTimestamp, } from '../hmac.js';
import { errorResponse } from '../envelope.js';
function pathOf(url) {
    const q = url.indexOf('?');
    return q === -1 ? url : url.slice(0, q);
}
function isExempt(url, exemptPaths, exemptPrefixes = []) {
    const path = pathOf(url);
    for (const p of exemptPaths) {
        if (path === p)
            return true;
    }
    for (const p of exemptPrefixes) {
        if (path.startsWith(p))
            return true;
    }
    return false;
}
function headerString(value) {
    if (value === undefined)
        return undefined;
    return Array.isArray(value) ? value[0] : value;
}
const authPluginImpl = async (fastify, config) => {
    fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
        const text = typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
        req.rawBody = text;
        if (text.length === 0) {
            done(null, undefined);
            return;
        }
        try {
            done(null, JSON.parse(text));
        }
        catch (err) {
            done(err, undefined);
        }
    });
    fastify.addHook('preHandler', async (request, reply) => {
        if (isExempt(request.url, config.exemptPaths, config.exemptPrefixes ?? []))
            return;
        const authHeader = headerString(request.headers['authorization']);
        if (!authHeader) {
            return reply
                .code(401)
                .send(errorResponse('AUTH_HMAC_INVALID', 'Authorization header missing'));
        }
        const parsed = parseAuthorizationHeader(authHeader);
        if (!parsed || parsed.railPrefix !== config.railPrefix) {
            return reply
                .code(401)
                .send(errorResponse('AUTH_HMAC_INVALID', 'Authorization header malformed'));
        }
        const tsHeaderName = config.timestampHeaderName.toLowerCase();
        const tsHeader = headerString(request.headers[tsHeaderName]);
        if (!tsHeader || !verifyTimestamp(tsHeader, config.toleranceSeconds)) {
            return reply
                .code(401)
                .send(errorResponse('AUTH_TIMESTAMP_EXPIRED', 'Timestamp missing or outside tolerance'));
        }
        const creds = await config.credentialStore.lookup(parsed.appId);
        if (!creds) {
            return reply.code(401).send(errorResponse('AUTH_HMAC_INVALID', 'Unknown app_id'));
        }
        if (creds.record.status === 'suspended') {
            return reply.code(403).send(errorResponse('AUTH_APP_SUSPENDED', 'App suspended'));
        }
        const contentType = headerString(request.headers['content-type']) ?? '';
        const rawBody = request.rawBody ?? '';
        const canonical = buildCanonicalString({
            method: request.method,
            pathAndQuery: request.url,
            contentType,
            timestamp: tsHeader,
            bodySha256Hex: sha256Hex(rawBody),
        });
        if (!verifyHmac(canonical, creds.hmacSecret, parsed.signature)) {
            return reply.code(401).send(errorResponse('AUTH_HMAC_INVALID', 'Signature mismatch'));
        }
        request.appId = parsed.appId;
        request.tenantRecord = creds.record;
        return;
    });
};
export const authPlugin = fp(authPluginImpl, {
    name: 'kmv-platform-shared/auth',
    fastify: '4.x',
});
//# sourceMappingURL=authPlugin.js.map
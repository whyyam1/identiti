/**
 * Standard response envelope used by all three rails.
 * Per Instruction Pack §2.5; Reboot Pack §9.4.
 */
import { generateUlid } from './ulid.js';
export const SCHEMA_VERSION = '1.0';
function buildMeta(requestId) {
    return {
        request_id: requestId ?? generateUlid(),
        timestamp: new Date().toISOString(),
        schema_version: SCHEMA_VERSION,
    };
}
export function successResponse(data, requestId) {
    return {
        ok: true,
        data,
        meta: buildMeta(requestId),
    };
}
export function errorResponse(code, message, requestId, opts = {}) {
    const error = { code, message };
    if (opts.field !== undefined)
        error.field = opts.field;
    if (opts.detail !== undefined)
        error.detail = opts.detail;
    if (opts.documentationUrl !== undefined)
        error.documentation_url = opts.documentationUrl;
    return {
        ok: false,
        error,
        meta: buildMeta(requestId),
    };
}
//# sourceMappingURL=envelope.js.map
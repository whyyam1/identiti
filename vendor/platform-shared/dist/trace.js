/**
 * W3C Trace Context (Traceparent) — parse and generate.
 * Per Instruction Pack §2.6; Reboot Pack §5.
 *
 * Format: <version>-<trace_id>-<parent_id>-<flags>
 *   version:   2 hex chars (currently "00")
 *   trace_id:  32 hex chars
 *   parent_id: 16 hex chars
 *   flags:     2 hex chars
 */
import { randomBytes } from 'node:crypto';
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
export function generateTraceparent() {
    const traceId = randomBytes(16).toString('hex');
    const parentId = randomBytes(8).toString('hex');
    return `00-${traceId}-${parentId}-01`;
}
export function parseTraceparent(header) {
    const match = TRACEPARENT_RE.exec(header.trim());
    if (!match)
        return null;
    const [, version, traceId, parentId, flags] = match;
    if (version === 'ff')
        return null;
    if (traceId === '00000000000000000000000000000000')
        return null;
    if (parentId === '0000000000000000')
        return null;
    return { version: version, traceId: traceId, parentId: parentId, flags: flags };
}
//# sourceMappingURL=trace.js.map
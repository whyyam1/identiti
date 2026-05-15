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
export interface TraceparentComponents {
    version: string;
    traceId: string;
    parentId: string;
    flags: string;
}
export declare function generateTraceparent(): string;
export declare function parseTraceparent(header: string): TraceparentComponents | null;
//# sourceMappingURL=trace.d.ts.map
/**
 * Standard response envelope used by all three rails.
 * Per Instruction Pack §2.5; Reboot Pack §9.4.
 */
export declare const SCHEMA_VERSION: "1.0";
export interface Meta {
    request_id: string;
    timestamp: string;
    schema_version: typeof SCHEMA_VERSION;
}
export interface SuccessEnvelope<T> {
    ok: true;
    data: T;
    meta: Meta;
}
export interface ErrorBody {
    code: string;
    message: string;
    field?: string | null;
    detail?: Record<string, unknown>;
    documentation_url?: string;
}
export interface ErrorEnvelope {
    ok: false;
    error: ErrorBody;
    meta: Meta;
}
export interface ErrorOpts {
    field?: string | null;
    detail?: Record<string, unknown>;
    documentationUrl?: string;
}
export declare function successResponse<T>(data: T, requestId?: string): SuccessEnvelope<T>;
export declare function errorResponse(code: string, message: string, requestId?: string, opts?: ErrorOpts): ErrorEnvelope;
//# sourceMappingURL=envelope.d.ts.map
/**
 * Idempotency-key store interface.
 * Per Instruction Pack §2.4. Each rail provides its own implementation
 * (Supabase table or Redis); this package defines the interface only.
 */
export interface IdempotencyRecord {
    requestBodyHash: string;
    statusCode: number;
    responseBody: unknown;
    createdAt: string;
}
export interface IdempotencyStore {
    get(key: string, appId: string): Promise<IdempotencyRecord | null>;
    set(key: string, appId: string, record: IdempotencyRecord, ttlSeconds: number): Promise<void>;
}
//# sourceMappingURL=idempotency.d.ts.map
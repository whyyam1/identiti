/**
 * HMAC request signing and verification.
 * Per Instruction Pack §2.3 / §4.1.
 *
 * Canonical string format (identical across all three rails):
 *   {HTTP_METHOD}\n
 *   {PATH_AND_QUERY}\n
 *   {CONTENT_TYPE}\n
 *   {X-{Rail}-Timestamp}\n
 *   {SHA256_HEX(request_body)}
 *
 * Authorization header format:
 *   {Rail}-HMAC-SHA256 app_id={appId}, signature={base64Sig}
 *
 * Constant-time signature comparison via timingSafeEqual.
 */
export interface CanonicalStringParams {
    method: string;
    pathAndQuery: string;
    contentType: string;
    timestamp: string;
    bodySha256Hex: string;
}
export type RailPrefix = 'KipkirenPay' | 'Identiti' | 'Todoku' | 'Helpan';
export declare function buildCanonicalString(params: CanonicalStringParams): string;
export declare function sha256Hex(body: string | Buffer): string;
export declare function signRequest(canonicalString: string, secret: string): string;
export declare function verifyHmac(canonicalString: string, secret: string, provided: string): boolean;
export interface ParsedAuthorizationHeader {
    railPrefix: RailPrefix;
    appId: string;
    signature: string;
}
export declare function parseAuthorizationHeader(header: string): ParsedAuthorizationHeader | null;
export declare function verifyTimestamp(timestamp: string, toleranceSeconds: number): boolean;
//# sourceMappingURL=hmac.d.ts.map
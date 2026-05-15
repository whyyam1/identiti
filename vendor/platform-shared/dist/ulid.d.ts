export type Ulid = string & {
    readonly __brand: 'Ulid';
};
export declare function generateUlid(): Ulid;
export declare function isUlid(value: string): value is Ulid;
//# sourceMappingURL=ulid.d.ts.map
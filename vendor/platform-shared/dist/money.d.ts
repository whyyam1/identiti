/**
 * KES minor units (fils). Integer arithmetic only.
 * Per Reboot Pack §9.2: no floating-point for monetary values anywhere.
 */
export type KesMinorUnits = number & {
    readonly __brand: 'KesMinorUnits';
};
export declare function toKesMinorUnits(value: number): KesMinorUnits;
export declare function formatKes(minor: KesMinorUnits): string;
export declare function assertNonNegative(amount: KesMinorUnits): void;
export declare function assertPositive(amount: KesMinorUnits): void;
//# sourceMappingURL=money.d.ts.map
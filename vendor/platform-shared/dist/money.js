export function toKesMinorUnits(value) {
    if (!Number.isInteger(value)) {
        throw new Error(`KES minor units must be an integer; got ${value}`);
    }
    return value;
}
export function formatKes(minor) {
    const major = Math.floor(minor / 100);
    const cents = (minor % 100).toString().padStart(2, '0');
    return `KES ${major.toLocaleString('en-KE')}.${cents}`;
}
export function assertNonNegative(amount) {
    if (amount < 0) {
        throw new Error(`Amount must be non-negative; got ${amount}`);
    }
}
export function assertPositive(amount) {
    if (amount <= 0) {
        throw new Error(`Amount must be positive; got ${amount}`);
    }
}
//# sourceMappingURL=money.js.map
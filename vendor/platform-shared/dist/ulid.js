import { ulid } from 'ulid';
export function generateUlid() {
    return ulid();
}
export function isUlid(value) {
    return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}
//# sourceMappingURL=ulid.js.map
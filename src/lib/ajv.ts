/**
 * Shared AJV instance configured for JSON Schema 2020-12 (per Reboot Pack §5).
 *
 * Note: ajv 8 + ajv-formats are CJS packages without ESM `exports` declarations;
 * under NodeNext + esModuleInterop the default-import shape is unreliable. We
 * use named imports where available (Ajv2020 is exported by name) and the
 * `.default` interop dance for ajv-formats (which only exposes a default).
 */

import { Ajv2020 } from 'ajv/dist/2020.js';
import * as addFormatsNs from 'ajv-formats';
import type { ErrorObject, ValidateFunction } from 'ajv';

export type { ErrorObject, ValidateFunction };
export type Ajv = InstanceType<typeof Ajv2020>;

// ajv-formats is published as CJS with `module.exports = formatsPlugin` plus
// `module.exports.default = formatsPlugin`. NodeNext type resolution exposes it
// as a namespace where the callable lives at `.default`. Cast through the known
// runtime shape.
type AddFormats = (ajv: Ajv) => Ajv;
const addFormats: AddFormats = (addFormatsNs as unknown as { default: AddFormats }).default;

export function createAjv(): Ajv {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  addFormats(ajv);
  return ajv;
}

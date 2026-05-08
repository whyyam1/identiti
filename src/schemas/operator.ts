/**
 * Operator-side schemas. Not in Rail Contract Schema Appendix (operator
 * surface is rail-internal); shapes derived from Reboot Pack §16.8 and
 * Instruction Pack §6.3 Phase 2.
 */

export const operatorActionRequestSchema = {
  $id: 'identiti/OperatorActionRequest',
  type: 'object',
  required: ['reason'],
  additionalProperties: false,
  properties: {
    reason: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const;

export const operatorActionResponseSchema = {
  $id: 'identiti/OperatorActionResponse',
  type: 'object',
  required: ['account_uuid', 'from_state', 'to_state', 'changed_at'],
  additionalProperties: false,
  properties: {
    account_uuid: { type: 'string' },
    from_state: { type: 'string' },
    to_state: { type: 'string' },
    changed_at: { type: 'string' },
  },
} as const;

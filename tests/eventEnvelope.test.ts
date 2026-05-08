/**
 * Cross-rail event-envelope wire contract.
 *
 * Locks the JSON shape that KP, Todoku, and Helpan AI consume off the Kafka
 * message value: { event_type, occurred_at, data }. Topic and key are Kafka
 * routing metadata and are not part of the value.
 *
 * Changing this test = breaking cross-rail change. Coordinate with consumer
 * rails before re-shaping.
 */

import { describe, expect, it } from 'vitest';
import {
  serializeEventValue,
  type RailEvent,
  type SerializedRailEvent,
} from '../src/services/eventProducer.js';

describe('cross-rail event-envelope wire contract', () => {
  const sample: RailEvent = {
    topic: 'identiti.account.events',
    key: 'acc_11111111-1111-4111-8111-111111111111',
    type: 'ACCOUNT_CREATED',
    occurredAt: '2026-05-08T12:00:00.000Z',
    data: {
      account_uuid: 'acc_11111111-1111-4111-8111-111111111111',
      origin_app_id: 'app_test',
      initial_state: 'pending_onboarding',
      initial_tier: 'tier_0',
    },
  };

  it('serializes to the canonical { event_type, occurred_at, data } shape', () => {
    const wireJson = serializeEventValue(sample);
    const wire = JSON.parse(wireJson) as SerializedRailEvent;

    // Exact key set — no extras, no omissions.
    expect(Object.keys(wire).sort()).toEqual(['data', 'event_type', 'occurred_at']);

    expect(wire.event_type).toBe('ACCOUNT_CREATED');
    expect(wire.occurred_at).toBe('2026-05-08T12:00:00.000Z');
    expect(wire.data).toEqual(sample.data);
  });

  it('does not include topic or key in the value', () => {
    const wire = JSON.parse(serializeEventValue(sample));
    expect(wire).not.toHaveProperty('topic');
    expect(wire).not.toHaveProperty('key');
  });

  it('preserves data verbatim — no field renaming or coercion', () => {
    const event: RailEvent = {
      topic: 'identiti.step_up.events',
      key: 'acc_22222222-2222-4222-8222-222222222222',
      type: 'AUTH_CHALLENGE_REQUIRED',
      occurredAt: '2026-05-08T12:00:01.000Z',
      data: {
        nested: { a: 1, b: [2, 3] },
        nullable: null,
        boolean_flag: true,
        zero: 0,
      },
    };
    const wire = JSON.parse(serializeEventValue(event));
    expect(wire.data).toEqual({
      nested: { a: 1, b: [2, 3] },
      nullable: null,
      boolean_flag: true,
      zero: 0,
    });
  });
});

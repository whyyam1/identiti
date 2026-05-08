/**
 * Cross-rail event publishing.
 * Topics per Reboot Pack §16.8 and Instruction Pack §6.6:
 *   identiti.account.events    — ACCOUNT_CREATED, TIER_CHANGED,
 *                                ACCOUNT_SUSPENDED, ACCOUNT_REACTIVATED
 *   identiti.phone.events      — PHONE_CHANGED
 *   identiti.kyc.events        — KYC_APPROVED, KYC_REJECTED
 *   identiti.step_up.events    — STEP_UP_REQUIRED
 *
 * Two implementations:
 *   - InMemoryEventProducer  — tests; records events to an array.
 *   - KafkaJsEventProducer   — production; uses kafkajs.
 */

import { Kafka, type Producer, logLevel } from 'kafkajs';
import type { Logger } from '../lib/logger.js';

export interface RailEvent {
  topic: string;
  key: string;
  type: string;
  occurredAt: string; // RFC 3339
  data: Record<string, unknown>;
}

/**
 * Wire envelope sent over Kafka. Cross-rail consumers (KP, Todoku, Helpan AI)
 * parse this exact shape from the message value. `topic` and `key` are
 * Kafka-level routing metadata and are NOT part of the value. Field names are
 * snake_case JSON; the in-process `RailEvent` uses camelCase ergonomically.
 *
 * Locked by `tests/eventEnvelope.test.ts`. Changing this shape is a breaking
 * cross-rail change.
 */
export interface SerializedRailEvent {
  event_type: string;
  occurred_at: string;
  data: Record<string, unknown>;
}

/** Serialize a RailEvent into the canonical Kafka message-value JSON. */
export function serializeEventValue(event: RailEvent): string {
  const wire: SerializedRailEvent = {
    event_type: event.type,
    occurred_at: event.occurredAt,
    data: event.data,
  };
  return JSON.stringify(wire);
}

export interface EventProducer {
  publish(event: RailEvent): Promise<void>;
  shutdown(): Promise<void>;
}

export class InMemoryEventProducer implements EventProducer {
  readonly events: RailEvent[] = [];

  async publish(event: RailEvent): Promise<void> {
    this.events.push(event);
  }

  async shutdown(): Promise<void> {
    /* no-op */
  }
}

export type KafkaSaslOption =
  | { mechanism: 'plain'; username: string; password: string }
  | { mechanism: 'scram-sha-256'; username: string; password: string }
  | { mechanism: 'scram-sha-512'; username: string; password: string };

export interface KafkaProducerOptions {
  clientId: string;
  brokers: string[];
  logger: Logger;
  ssl?: boolean;
  sasl?: KafkaSaslOption;
}

export class KafkaJsEventProducer implements EventProducer {
  private readonly producer: Producer;
  private readonly logger: Logger;
  private connected = false;

  constructor(opts: KafkaProducerOptions) {
    this.logger = opts.logger;
    const kafka = new Kafka({
      clientId: opts.clientId,
      brokers: opts.brokers,
      ssl: opts.ssl ?? false,
      ...(opts.sasl ? { sasl: opts.sasl } : {}),
      logLevel: logLevel.WARN,
    });
    this.producer = kafka.producer({ allowAutoTopicCreation: false });
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.producer.connect();
      this.connected = true;
      this.logger.info('Kafka producer connected');
    }
  }

  async publish(event: RailEvent): Promise<void> {
    await this.ensureConnected();
    await this.producer.send({
      topic: event.topic,
      messages: [
        {
          key: event.key,
          value: serializeEventValue(event),
        },
      ],
    });
  }

  async shutdown(): Promise<void> {
    if (this.connected) {
      await this.producer.disconnect();
      this.connected = false;
    }
  }
}

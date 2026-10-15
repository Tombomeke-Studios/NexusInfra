import { describe, expect, it } from 'vitest';
import { logsTraffic, redactUrl } from './rabbitmq.js';

describe('redactUrl (#394)', () => {
  it('hides the password of a broker URL and keeps where it points', () => {
    const logged = redactUrl('amqp://nexus:s3cr3t-pass@rabbitmq:5672');
    expect(logged).not.toContain('s3cr3t-pass');
    expect(logged).toBe('amqp://nexus:***@rabbitmq:5672');
  });

  it('hides the password of a database URL, query and path included', () => {
    const logged = redactUrl('postgresql://app:hunter2@db.internal:5432/nexus?schema=public');
    expect(logged).not.toContain('hunter2');
    expect(logged).toBe('postgresql://app:***@db.internal:5432/nexus?schema=public');
  });

  it('hides a percent-encoded password', () => {
    expect(redactUrl('amqps://u:p%40ss%3Aword@broker/vhost')).toBe('amqps://u:***@broker/vhost');
  });

  it('leaves a URL with no password as it was', () => {
    expect(redactUrl('amqp://rabbitmq:5672')).toBe('amqp://rabbitmq:5672');
    expect(redactUrl('file:/data/orchestrator.db')).toBe('file:/data/orchestrator.db');
  });

  it('still cuts the credentials out of something that does not parse', () => {
    const logged = redactUrl('amqp://user:pa ss@[not-a-host');
    expect(logged).not.toContain('pa ss');
    expect(logged).toBe('amqp://user:***@[not-a-host');
  });
});

describe('logsTraffic (#395)', () => {
  it('keeps heartbeats out of the log', () => {
    expect(logsTraffic('heartbeat.service')).toBe(false);
    expect(logsTraffic('heartbeat.node')).toBe(false);
  });

  it('still logs every other event', () => {
    for (const type of ['server.start', 'server.crashed', 'node.inventory', 'payment.request']) {
      expect(logsTraffic(type)).toBe(true);
    }
  });
});

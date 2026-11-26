import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { InMemoryRepository } from './repository.js';
import { createBillingService } from './service.js';
import { DEFAULT_PLAN } from './pricing.js';
import { MAX_ADVANCE_HOURS, createTestClock, createTestToolRouter, testPlanFor, testPlanId, testToolsEnabled } from './testTools.js';

const START = Date.parse('2026-07-01T00:00:00.000Z');

describe('testToolsEnabled (#439)', () => {
  it('is off unless asked for in so many words', () => {
    expect(testToolsEnabled({})).toBe(false);
    expect(testToolsEnabled({ BILLING_TEST_TOOLS: '1' })).toBe(false);
    expect(testToolsEnabled({ BILLING_TEST_TOOLS: 'true' })).toBe(true);
  });
});

describe('createTestClock', () => {
  it('reads the wall clock plus everything it was moved forward', () => {
    const clock = createTestClock(() => START);
    expect(clock.now()).toBe('2026-07-01T00:00:00.000Z');
    clock.advance(24);
    clock.advance(0.5);
    expect(clock.now()).toBe('2026-07-02T00:30:00.000Z');
    expect(clock.offsetHours()).toBe(24.5);
  });

  it('only ever moves forward, and not absurdly far', () => {
    const clock = createTestClock(() => START);
    for (const hours of [0, -1, NaN, Infinity, MAX_ADVANCE_HOURS + 1]) expect(() => clock.advance(hours)).toThrow(/forward/);
    expect(clock.offsetHours()).toBe(0);
  });
});

describe('testPlanFor', () => {
  it('copies the current plan with the new numbers, retired so nobody else can pick it', () => {
    const plan = testPlanFor(DEFAULT_PLAN, 'u1', { freeHoursPerMonth: 0, pricePerHour: 1.5 });
    expect(plan).toEqual({ ...DEFAULT_PLAN, id: testPlanId('u1'), name: 'Test plan (Standard)', freeHoursPerMonth: 0, pricePerHour: 1.5, active: false });
  });

  it('keeps what it was not asked to change, and does not nest its own name', () => {
    const first = testPlanFor(DEFAULT_PLAN, 'u1', { freeHoursPerMonth: 0 });
    const second = testPlanFor(first, 'u1', { pricePerHour: 3 });
    expect(second).toMatchObject({ name: 'Test plan (Standard)', freeHoursPerMonth: 0, pricePerHour: 3 });
  });

  it('refuses numbers billing could not use', () => {
    expect(() => testPlanFor(DEFAULT_PLAN, 'u1', { pricePerHour: -1 })).toThrow(/rate/);
    expect(() => testPlanFor(DEFAULT_PLAN, 'u1', { pricePerHour: '2' })).toThrow(/rate/);
    expect(() => testPlanFor(DEFAULT_PLAN, 'u1', { freeHoursPerMonth: -5 })).toThrow(/free hours/);
  });
});

function harness() {
  const repo = new InMemoryRepository();
  const clock = createTestClock(() => START);
  const svc = createBillingService({ repo, now: clock.now, publish: async () => true });
  const afterAdvance: string[] = [];
  const app = express()
    .use(express.json())
    .use(createTestToolRouter({ repo, clock, afterAdvance: async () => void afterAdvance.push(clock.now()) }));
  return { repo, clock, svc, app, afterAdvance };
}

describe('the test routes', () => {
  it('moves the clock forward and settles straight away', async () => {
    const { app, afterAdvance } = harness();
    const res = await request(app).post('/test/clock').send({ hours: 24 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ now: '2026-07-02T00:00:00.000Z', offsetHours: 24 });
    expect(afterAdvance).toEqual(['2026-07-02T00:00:00.000Z']);
    expect((await request(app).get('/test/clock')).body.offsetHours).toBe(24);
  });

  it('refuses to move time back', async () => {
    const { app, afterAdvance } = harness();
    const res = await request(app).post('/test/clock').send({ hours: -1 });
    expect(res.status).toBe(400);
    expect(afterAdvance).toEqual([]);
  });

  it('puts an account on its own test plan', async () => {
    const { app, repo } = harness();
    const res = await request(app).post('/test/accounts/u1/plan').send({ freeHoursPerMonth: 0 });
    expect(res.status).toBe(200);
    expect((await repo.getUserPlan('u1')).id).toBe(testPlanId('u1'));
    // Nobody else moves.
    expect((await repo.getUserPlan('u2')).id).toBe(DEFAULT_PLAN.id);
  });

  it('answers 400, not 500, for a number billing could not use', async () => {
    const { app } = harness();
    expect((await request(app).post('/test/accounts/u1/plan').send({ pricePerHour: -1 })).status).toBe(400);
  });
});

describe('the real billing, through the moved clock', () => {
  it('runs free hours out and charges at the test plan’s rate', async () => {
    const { app, clock, svc } = harness();
    await request(app).post('/test/accounts/u1/plan').send({ freeHoursPerMonth: 1, pricePerHour: 1 });
    await svc.handleDeploymentCreated({ deploymentId: 'd1', userId: 'u1', resourceLimits: { cpuPercent: 100, ramPercent: 100 } });
    await svc.handleServerStarted({ deploymentId: 'd1' });

    expect((await svc.getStanding('u1')).freeHoursLeft).toBe(1);
    clock.advance(3);
    const standing = await svc.getStanding('u1');
    expect(standing.freeHoursLeft).toBe(0);
    // Three hours run, one of them free, at the test plan's rate: usage is held against the balance.
    expect(standing.accrued).toBeGreaterThan(0);
    expect(standing.canRun).toBe(false);
  });
});

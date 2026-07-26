import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createMonitoringRouter } from './monitoring.js';

// The proxy forwards the Control Room's /status and flags reachability so the
// dashboard can show it even when the Control Room is down.

describe('monitoring proxy', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  function app() {
    return express().use(createMonitoringRouter());
  }

  it('passes the Control Room status through with reachable:true', async () => {
    const snapshot = { monitored: [{ source: 'control-room', status: 'healthy', lastSeenMsAgo: 200 }], thresholds: { degradedMs: 3000, offlineMs: 10000 } };
    fetchMock.mockResolvedValue({ ok: true, json: async () => snapshot } as Response);

    const res = await request(app()).get('/monitoring');
    expect(res.status).toBe(200);
    expect(res.body.reachable).toBe(true);
    expect(res.body.monitored).toHaveLength(1);
    expect(res.body.monitored[0].source).toBe('control-room');
  });

  it('reports reachable:false when the Control Room is down', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await request(app()).get('/monitoring');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ monitored: [], reachable: false });
  });
});

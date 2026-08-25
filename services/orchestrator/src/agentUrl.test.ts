import { describe, it, expect } from 'vitest';
import { normalizeAgentUrl, resolveAgentUrl } from './agentUrl.js';

const FALLBACK = 'http://node-agent:9100';

describe('normalizeAgentUrl', () => {
  it('strips trailing slashes so paths can be appended', () => {
    expect(normalizeAgentUrl('http://a:9100/')).toBe('http://a:9100');
    expect(normalizeAgentUrl('http://a:9100///')).toBe('http://a:9100');
    expect(normalizeAgentUrl('  http://a:9100  ')).toBe('http://a:9100');
  });

  it('leaves a clean URL untouched', () => {
    expect(normalizeAgentUrl('http://a:9100')).toBe('http://a:9100');
  });
});

describe('resolveAgentUrl', () => {
  it("prefers the node's own agent URL", () => {
    expect(resolveAgentUrl({ agentUrl: 'http://node-b:9100' }, FALLBACK)).toBe('http://node-b:9100');
  });

  it('normalizes the node URL', () => {
    expect(resolveAgentUrl({ agentUrl: 'http://node-b:9100/' }, FALLBACK)).toBe('http://node-b:9100');
  });

  it('falls back for a node that reports no URL (single-node setups)', () => {
    expect(resolveAgentUrl({ agentUrl: null }, FALLBACK)).toBe(FALLBACK);
    expect(resolveAgentUrl({ agentUrl: '' }, FALLBACK)).toBe(FALLBACK);
    expect(resolveAgentUrl({ agentUrl: '   ' }, FALLBACK)).toBe(FALLBACK);
  });

  it('falls back for an unknown node', () => {
    expect(resolveAgentUrl(null, FALLBACK)).toBe(FALLBACK);
    expect(resolveAgentUrl(undefined, FALLBACK)).toBe(FALLBACK);
  });
});

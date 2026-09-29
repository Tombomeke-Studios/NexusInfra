import { describe, it, expect } from 'vitest';
import { formatLimits, isGameServer, parsePathList } from './format';

describe('formatLimits (#318)', () => {
  it('renders the percentages a server was given', () => {
    expect(formatLimits({ cpuPercent: 40, ramPercent: 60 })).toBe('cpu 40% · ram 60%');
  });

  it('prefers the absolute units, which win server-side too (#275)', () => {
    expect(formatLimits({ cpuCores: 1.5, cpuPercent: 40, ramMb: 2048, ramPercent: 60 })).toBe('cpu 1.5 cores · ram 2048 MB');
    expect(formatLimits({ cpuCores: 1 })).toBe('cpu 1 core');
  });

  it('says nothing rather than inventing a figure when there are no caps', () => {
    expect(formatLimits({})).toBe('—');
    expect(formatLimits(undefined)).toBe('—');
    expect(formatLimits({ restartPolicy: 'always' })).toBe('—');
  });

  it('shows only the half that is capped', () => {
    expect(formatLimits({ ramMb: 512 })).toBe('ram 512 MB');
  });
});

describe('isGameServer (#318)', () => {
  it('treats a server created from an egg as a game server', () => {
    expect(isGameServer({ type: 'minecraft-java', dockerImage: 'itzg/minecraft-server' })).toBe(true);
    expect(isGameServer({ type: 'valheim', dockerImage: 'x' })).toBe(true);
  });

  it('keeps the legacy game type and image prefix', () => {
    expect(isGameServer({ type: 'game', dockerImage: 'x' })).toBe(true);
    expect(isGameServer({ type: 'generic', dockerImage: 'nexusinfra/mc' })).toBe(true);
  });

  it('treats plain deployments as applications', () => {
    expect(isGameServer({ type: 'app', dockerImage: 'nginx' })).toBe(false);
    expect(isGameServer({ type: 'generic', dockerImage: 'nginx' })).toBe(false);
    expect(isGameServer({ type: '', dockerImage: 'nginx' })).toBe(false);
  });
});

describe('parsePathList (#324)', () => {
  it('splits on commas and new lines and drops blanks', () => {
    expect(parsePathList(' /data , /srv\n\n/etc ,')).toEqual(['/data', '/srv', '/etc']);
    expect(parsePathList('')).toEqual([]);
  });
});

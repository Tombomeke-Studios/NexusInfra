import { describe, it, expect } from 'vitest';
import { containerNameFor, DOCKER_NAME_PATTERN } from './containerName.js';

const DEPLOYMENT = 'a68663dc-5bc2-492d-894e-b84ed0c6278c';

describe('containerNameFor', () => {
  it('accepts a name Docker rejected verbatim (#286)', () => {
    const name = containerNameFor('test minecraft server', DEPLOYMENT);
    expect(name).toMatch(DOCKER_NAME_PATTERN);
    expect(name).toContain('test-minecraft-server');
  });

  it('is deterministic, so a restart reuses the same container name', () => {
    expect(containerNameFor('My Server', DEPLOYMENT)).toBe(containerNameFor('My Server', DEPLOYMENT));
  });

  it('distinguishes two servers that share a display name', () => {
    const a = containerNameFor('survival', DEPLOYMENT);
    const b = containerNameFor('survival', 'e933e779-ee04-4deb-b1ff-1afc665496bf');
    expect(a).not.toBe(b);
  });

  it.each([
    ['spaces', 'test minecraft server'],
    ['slashes and colons', 'prod/web:1'],
    ['unicode', 'wereld café ✨'],
    ['leading punctuation', '---leading'],
    ['only invalid characters', '✨✨✨'],
    ['empty', ''],
    ['whitespace only', '   '],
    ['very long', 'x'.repeat(300)],
  ])('produces a Docker-valid name for %s', (_label, input) => {
    expect(containerNameFor(input, DEPLOYMENT)).toMatch(DOCKER_NAME_PATTERN);
  });

  it('falls back to a generic slug when nothing usable survives', () => {
    expect(containerNameFor('✨✨✨', DEPLOYMENT)).toContain('server');
  });

  it('keeps the name short enough to stay readable in docker ps', () => {
    expect(containerNameFor('x'.repeat(300), DEPLOYMENT).length).toBeLessThanOrEqual(63);
  });

  it('collapses runs of separators rather than emitting empty segments', () => {
    expect(containerNameFor('a   b', DEPLOYMENT)).toContain('a-b');
  });

  it('does not end the slug on a separator', () => {
    expect(containerNameFor('trailing -- ', DEPLOYMENT)).toContain('trailing-');
    expect(containerNameFor('trailing -- ', DEPLOYMENT)).not.toContain('trailing---');
  });
});

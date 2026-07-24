import { describe, it, expect } from 'vitest';
import { lineSplitter } from './logs.js';

describe('lineSplitter', () => {
  it('emits one callback per complete line across chunk boundaries', () => {
    const lines: string[] = [];
    const w = lineSplitter((l) => lines.push(l));
    w.write(Buffer.from('hello wo'));
    w.write(Buffer.from('rld\nsecond line\nthi'));
    w.write(Buffer.from('rd\n'));
    expect(lines).toEqual(['hello world', 'second line', 'third']);
  });

  it('strips trailing CR and skips empty lines', () => {
    const lines: string[] = [];
    const w = lineSplitter((l) => lines.push(l));
    w.write(Buffer.from('a\r\n\r\nb\r\n'));
    expect(lines).toEqual(['a', 'b']);
  });

  it('flushes a trailing partial line on end', () => {
    const lines: string[] = [];
    const w = lineSplitter((l) => lines.push(l));
    w.write(Buffer.from('line1\npartial'));
    w.end();
    expect(lines).toEqual(['line1', 'partial']);
  });
});

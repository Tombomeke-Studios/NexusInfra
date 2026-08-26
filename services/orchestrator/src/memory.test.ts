import { describe, it, expect } from 'vitest';
import { parseMemoryMb, containerMemoryMb, jvmOverheadMb, heapBudgetProblem, largestHeapForCap } from './memory.js';

// The two settings that control the same physical RAM (#271): the container cap
// the kernel enforces, and the JVM heap the server actually commits.

describe('parseMemoryMb', () => {
  it('reads the forms people write', () => {
    expect(parseMemoryMb('2G')).toBe(2048);
    expect(parseMemoryMb('2g')).toBe(2048);
    expect(parseMemoryMb('2048M')).toBe(2048);
    expect(parseMemoryMb('2048')).toBe(2048); // bare number is MB, as the JVM reads it
    expect(parseMemoryMb('1536m')).toBe(1536);
    expect(parseMemoryMb(' 4G ')).toBe(4096);
    expect(parseMemoryMb('1.5G')).toBe(1536);
  });

  it('returns null for anything it does not understand', () => {
    // A variable that is not a memory size must not be silently treated as one.
    expect(parseMemoryMb('lots')).toBeNull();
    expect(parseMemoryMb('')).toBeNull();
    expect(parseMemoryMb('0')).toBeNull();
    expect(parseMemoryMb('-2G')).toBeNull();
    expect(parseMemoryMb('2 gigs')).toBeNull();
  });
});

describe('containerMemoryMb', () => {
  it('resolves the percentage against the node it lands on', () => {
    // The same 50% is 2 GB on a small box and 32 GB on a large one, which is most
    // of why a percentage was the wrong thing to show someone.
    expect(containerMemoryMb(50, 4096)).toBe(2048);
    expect(containerMemoryMb(50, 65536)).toBe(32768);
    expect(containerMemoryMb(25, 8192)).toBe(2048);
  });

  it('is null when there is no cap or the node has not reported its RAM', () => {
    expect(containerMemoryMb(undefined, 4096)).toBeNull();
    expect(containerMemoryMb(0, 4096)).toBeNull();
    expect(containerMemoryMb(50, null)).toBeNull();
    expect(containerMemoryMb(50, 0)).toBeNull();
  });
});

describe('jvmOverheadMb', () => {
  it('never assumes less than a floor', () => {
    expect(jvmOverheadMb(512)).toBe(512);
    expect(jvmOverheadMb(1024)).toBe(512);
  });

  it('scales with the heap once the floor is passed', () => {
    expect(jvmOverheadMb(4096)).toBe(1024);
    expect(jvmOverheadMb(8192)).toBe(2048);
  });
});

describe('heapBudgetProblem', () => {
  it('accepts a heap with room to spare', () => {
    expect(heapBudgetProblem({ heapMb: 2048, capMb: 4096 })).toBeNull();
    expect(heapBudgetProblem({ heapMb: 1024, capMb: 2048 })).toBeNull();
  });

  // The collision the defaults produced: a 2G heap in a 2048 MB cap.
  it('refuses a heap equal to the cap', () => {
    expect(heapBudgetProblem({ heapMb: 2048, capMb: 2048 })).toMatch(/2048 MB heap/);
  });

  it('refuses a heap that leaves too little headroom', () => {
    // 1800 + 512 overhead = 2312 > 2048.
    expect(heapBudgetProblem({ heapMb: 1800, capMb: 2048 })).not.toBeNull();
  });

  it('speaks in MB and suggests a heap that would fit', () => {
    const problem = heapBudgetProblem({ heapMb: 4096, capMb: 4096 })!;
    expect(problem).toMatch(/4096 MB/);
    // Never "50%" — the unit the setting is stored in is the one nobody can act on.
    expect(problem).not.toMatch(/%/);
    expect(problem).toMatch(/lower the heap to about \d+ MB/);
  });
});

describe('largestHeapForCap', () => {
  it('suggests a heap that actually passes the check', () => {
    for (const cap of [1024, 2048, 3000, 4096, 8192, 16384, 65536]) {
      const heap = largestHeapForCap(cap);
      expect(heap).toBeGreaterThan(0);
      // The suggestion has to be one the same rule accepts, or it is advice that
      // fails when followed.
      expect(heapBudgetProblem({ heapMb: heap, capMb: cap })).toBeNull();
    }
  });

  it('uses the flat floor for small caps and the proportional share for large ones', () => {
    expect(largestHeapForCap(2048)).toBe(1536); // 2048 - 512
    expect(largestHeapForCap(16384)).toBe(13107); // 4/5 of the cap
  });
});

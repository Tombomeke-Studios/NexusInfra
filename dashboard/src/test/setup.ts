import '@testing-library/jest-dom';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount rendered trees after each test so they don't leak into the next.
afterEach(() => cleanup());

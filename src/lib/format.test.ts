import { describe, it, expect } from 'vitest';
import { formatBytes, formatCpu } from './format';

describe('format', () => {
  it('formats bytes to human units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(2_576_980_377)).toBe('2.4 GB');
  });
  it('formats cpu percent to one decimal', () => {
    expect(formatCpu(58.234)).toBe('58.2%');
    expect(formatCpu(0)).toBe('0.0%');
  });
});

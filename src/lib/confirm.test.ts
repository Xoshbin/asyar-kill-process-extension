import { describe, it, expect } from 'vitest';
import { shouldConfirm } from './confirm';

describe('shouldConfirm', () => {
  it('protected always confirms, even when skip is on', () => {
    expect(shouldConfirm({ protected: true } as any, true)).toBe(true);
  });
  it('normal app skips when skip is on', () => {
    expect(shouldConfirm({ protected: false } as any, true)).toBe(false);
  });
  it('normal app confirms when skip is off', () => {
    expect(shouldConfirm({ protected: false } as any, false)).toBe(true);
  });
});

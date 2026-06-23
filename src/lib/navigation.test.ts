import { describe, it, expect } from 'vitest';
import { buildFlatRows, nextIndex, clampIndex, keyIntent, resolveKeyAction } from './navigation';
import type { AppGroup } from 'asyar-sdk/contracts';

function group(appName: string, childPids: number[], protectedFlag = false): AppGroup {
  return {
    appName,
    icon: null,
    owner: 'alice',
    totalCpu: 0,
    totalMemoryBytes: 0,
    processCount: childPids.length,
    protected: protectedFlag,
    children: childPids.map((pid) => ({
      pid,
      name: `${appName}-${pid}`,
      cpuPercent: 0,
      memoryBytes: 0,
      path: '',
      owner: 'alice',
      protected: protectedFlag,
    })),
  };
}

describe('buildFlatRows', () => {
  it('emits one group row per group when nothing is expanded', () => {
    const rows = buildFlatRows([group('A', [1, 2]), group('B', [3])], new Set());
    expect(rows.map((r) => r.kind)).toEqual(['group', 'group']);
    expect(rows.map((r) => r.group.appName)).toEqual(['A', 'B']);
  });

  it('emits child rows only for expanded groups, right after their group', () => {
    const rows = buildFlatRows([group('A', [1, 2]), group('B', [3])], new Set(['A']));
    expect(rows.map((r) => r.kind)).toEqual(['group', 'child', 'child', 'group']);
    expect(rows[1].kind).toBe('child');
    expect(rows[1].child?.pid).toBe(1);
    expect(rows[2].child?.pid).toBe(2);
    expect(rows[3].group.appName).toBe('B');
  });

  it('expanding a group with no children adds no child rows', () => {
    const rows = buildFlatRows([group('A', [])], new Set(['A']));
    expect(rows.map((r) => r.kind)).toEqual(['group']);
  });
});

describe('nextIndex', () => {
  it('ArrowDown increments and clamps at the last row', () => {
    expect(nextIndex(3, 0, 'ArrowDown')).toBe(1);
    expect(nextIndex(3, 2, 'ArrowDown')).toBe(2);
  });

  it('ArrowUp decrements and clamps at 0', () => {
    expect(nextIndex(3, 2, 'ArrowUp')).toBe(1);
    expect(nextIndex(3, 0, 'ArrowUp')).toBe(0);
  });

  it('returns the current index unchanged for non-navigation keys', () => {
    expect(nextIndex(3, 1, 'Enter')).toBe(1);
  });

  it('handles an empty list without going negative', () => {
    expect(nextIndex(0, 0, 'ArrowDown')).toBe(0);
    expect(nextIndex(0, 0, 'ArrowUp')).toBe(0);
  });
});

describe('clampIndex', () => {
  it('clamps to the last valid index when the list shrinks', () => {
    expect(clampIndex(5, 3)).toBe(2);
  });

  it('keeps a valid index unchanged', () => {
    expect(clampIndex(1, 5)).toBe(1);
  });

  it('returns 0 for an empty list', () => {
    expect(clampIndex(3, 0)).toBe(0);
  });
});

describe('keyIntent', () => {
  it('arrows map to navigation intents', () => {
    expect(keyIntent({ key: 'ArrowUp' })).toBe('up');
    expect(keyIntent({ key: 'ArrowDown' })).toBe('down');
    expect(keyIntent({ key: 'ArrowRight' })).toBe('expand');
    expect(keyIntent({ key: 'ArrowLeft' })).toBe('collapse');
  });

  it('plain Enter is a graceful kill', () => {
    expect(keyIntent({ key: 'Enter' })).toBe('kill');
  });

  it('Enter with meta or ctrl is a force kill', () => {
    expect(keyIntent({ key: 'Enter', meta: true })).toBe('force-kill');
    expect(keyIntent({ key: 'Enter', ctrl: true })).toBe('force-kill');
  });

  it('r with meta or ctrl is refresh', () => {
    expect(keyIntent({ key: 'r', meta: true })).toBe('refresh');
    expect(keyIntent({ key: 'r', ctrl: true })).toBe('refresh');
    expect(keyIntent({ key: 'R', meta: true })).toBe('refresh');
  });

  it('plain r (no modifier) is not refresh — it types in the filter', () => {
    expect(keyIntent({ key: 'r' })).toBeNull();
  });

  it('unhandled keys return null', () => {
    expect(keyIntent({ key: 'a' })).toBeNull();
    expect(keyIntent({ key: 'Tab' })).toBeNull();
    expect(keyIntent({ key: 'Escape' })).toBeNull();
  });
});

describe('resolveKeyAction (confirm overlay routing)', () => {
  it('when no confirm overlay is open, passes the intent through unchanged', () => {
    expect(resolveKeyAction('kill', false)).toBe('kill');
    expect(resolveKeyAction('force-kill', false)).toBe('force-kill');
    expect(resolveKeyAction('up', false)).toBe('up');
    expect(resolveKeyAction('refresh', false)).toBe('refresh');
    expect(resolveKeyAction(null, false)).toBeNull();
  });

  it('when the overlay is open, Enter (kill/force-kill) confirms the dialog', () => {
    expect(resolveKeyAction('kill', true)).toBe('confirm');
    expect(resolveKeyAction('force-kill', true)).toBe('confirm');
  });

  it('when the overlay is open, navigation and refresh are ignored (no-op)', () => {
    expect(resolveKeyAction('up', true)).toBeNull();
    expect(resolveKeyAction('down', true)).toBeNull();
    expect(resolveKeyAction('expand', true)).toBeNull();
    expect(resolveKeyAction('collapse', true)).toBeNull();
    expect(resolveKeyAction('refresh', true)).toBeNull();
    expect(resolveKeyAction(null, true)).toBeNull();
  });
});

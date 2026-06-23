import { describe, it, expect } from 'vitest';
import { VIEW_ACTION_NAMES, viewActionId } from './actions';

describe('view action ids', () => {
  it('builds `${extensionId}.view.<name>` ids (EXTENSION_VIEW registration scheme)', () => {
    expect(viewActionId('org.asyar.kill-process', 'kill')).toBe('org.asyar.kill-process.view.kill');
    expect(viewActionId('org.asyar.kill-process', 'force-kill')).toBe(
      'org.asyar.kill-process.view.force-kill',
    );
  });

  it('are not act_-prefixed (not the manifest/registerActionHandler scheme)', () => {
    for (const name of VIEW_ACTION_NAMES) {
      const id = viewActionId('ext', name);
      expect(id.startsWith('act_')).toBe(false);
      expect(id).toBe(`ext.view.${name}`);
    }
  });

  it('register and unregister use the SAME id (symmetric) for every action', () => {
    const extensionId = 'org.asyar.kill-process';
    for (const name of VIEW_ACTION_NAMES) {
      const registerId = viewActionId(extensionId, name);
      const unregisterId = viewActionId(extensionId, name);
      expect(registerId).toBe(unregisterId);
    }
  });

  it('covers the four documented view actions', () => {
    expect([...VIEW_ACTION_NAMES].sort()).toEqual(['force-kill', 'kill', 'refresh', 'toggle-expand']);
  });
});

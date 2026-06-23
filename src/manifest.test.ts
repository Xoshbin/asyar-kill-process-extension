import { describe, it, expect } from 'vitest';
import manifest from '../manifest.json';

const VALID_PREF_TYPES = ['textfield', 'password', 'number', 'checkbox', 'dropdown', 'appPicker', 'file', 'directory'];

describe('kill-process manifest', () => {
  it('declares the process permissions', () => {
    expect(manifest.permissions).toEqual(expect.arrayContaining(['process:read', 'process:kill']));
  });

  it('has a single view command named "Kill Process"', () => {
    expect(manifest.commands).toHaveLength(1);
    expect(manifest.commands[0]).toMatchObject({ id: 'kill-process', name: 'Kill Process', mode: 'view' });
  });

  it('is searchable so the launcher forwards main-search-bar input as asyar:view:search', () => {
    // Without `searchable: true` the host's viewManager never calls
    // sendViewSearchToExtension, so typing in the main search bar would not
    // filter the process list (it gates on manifest.searchable).
    expect(manifest.searchable).toBe(true);
  });

  it('every preference uses a valid PreferenceType', () => {
    for (const p of manifest.preferences) {
      expect(VALID_PREF_TYPES).toContain(p.type);
    }
  });

  it('declares the sort dropdown as a ⌘P searchbar accessory on the view command', () => {
    // Sort lives in the launcher's native ⌘P accessory dropdown — not an
    // in-view <select> — so the chrome stays consistent with other extensions.
    const acc = (manifest.commands[0] as any).searchBarAccessory;
    expect(acc?.type).toBe('dropdown');
    const values = acc.options.map((o: any) => o.value);
    expect(values).toEqual(['cpu', 'memory', 'name']);
    expect(values).toContain(acc.default);
  });
});

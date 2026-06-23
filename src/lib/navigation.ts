import type { AppGroup, ProcessInfo } from 'asyar-sdk/contracts';

/**
 * A single visible row in the flattened list. Group rows are always present;
 * child rows appear only when their parent group is expanded, immediately
 * after the group row.
 */
export type FlatRow =
  | { kind: 'group'; group: AppGroup; child?: undefined }
  | { kind: 'child'; group: AppGroup; child: ProcessInfo };

/**
 * Flatten the grouped list into the linear sequence of rows the keyboard
 * navigates over: each group, followed by its children when expanded.
 */
export function buildFlatRows(groups: AppGroup[], expanded: Set<string>): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const group of groups) {
    rows.push({ kind: 'group', group });
    if (expanded.has(group.appName)) {
      for (const child of group.children) {
        rows.push({ kind: 'child', group, child });
      }
    }
  }
  return rows;
}

/** Pure ArrowUp/ArrowDown reducer over a flat row list. Other keys are no-ops. */
export function nextIndex(length: number, current: number, key: string): number {
  if (length <= 0) return 0;
  const max = length - 1;
  if (key === 'ArrowDown') return Math.min(max, current + 1);
  if (key === 'ArrowUp') return Math.max(0, current - 1);
  return clampIndex(current, length);
}

/** Clamp an index into [0, length-1]; returns 0 for an empty list. */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(0, index), length - 1);
}

export type KeyIntent =
  | 'up'
  | 'down'
  | 'expand'
  | 'collapse'
  | 'kill'
  | 'force-kill'
  | 'refresh';

/**
 * Map a keystroke to a view intent. `registerAction`'s `shortcut` field is
 * display-only (a ⌘K label, not a binding), so the actual key handling lives
 * here and is shared by BOTH keydown sources (host-forwarded `asyar:view:keydown`
 * and the local iframe `window` keydown). Returns null for keys we don't own
 * (so they keep typing into the filter input).
 *
 * Note: ⌃R/⌘R only fires via the LOCAL source — the host's forwardKeys does not
 * include 'r' — which is fine (the ⌘K panel covers refresh when the host has
 * focus).
 */
export function keyIntent(e: { key: string; meta?: boolean; ctrl?: boolean }): KeyIntent | null {
  const mod = e.meta === true || e.ctrl === true;
  switch (e.key) {
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'ArrowRight':
      return 'expand';
    case 'ArrowLeft':
      return 'collapse';
    case 'Enter':
      return mod ? 'force-kill' : 'kill';
  }
  if ((e.key === 'r' || e.key === 'R') && mod) return 'refresh';
  return null;
}

export type KeyAction = KeyIntent | 'confirm';

/**
 * Decide what a key intent should do given whether the confirm overlay is open.
 * When it's open, Enter (kill/force-kill) confirms the dialog instead of
 * re-opening it, and all other intents (navigation/refresh) are swallowed so
 * the list can't move under the dialog. When it's closed, the intent passes
 * through unchanged. Pure — testable without mounting Svelte.
 */
export function resolveKeyAction(intent: KeyIntent | null, pendingOpen: boolean): KeyAction | null {
  if (!pendingOpen) return intent;
  if (intent === 'kill' || intent === 'force-kill') return 'confirm';
  return null;
}

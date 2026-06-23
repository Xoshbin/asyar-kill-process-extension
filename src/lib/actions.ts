/**
 * In-view action names for the Kill Process view.
 *
 * These are registered via `actions.registerAction({ id, ..., context:
 * ActionContext.EXTENSION_VIEW, execute })` so they appear in the launcher's
 * ⌘K drawer *while the view is mounted* (the panel filters to
 * `context === EXTENSION_VIEW` inside a Tier 2 view). The host dispatches
 * `asyar:action:execute` back to the iframe to run the local `execute`.
 *
 * The registry id is `viewActionId(extensionId, name)` and the SAME id must be
 * passed to `unregisterAction` on teardown — registration and unregistration
 * are symmetric here (unlike `registerActionHandler`, which is NOT used).
 */
export const VIEW_ACTION_NAMES = ['kill', 'force-kill', 'toggle-expand', 'refresh'] as const;

export type ViewActionName = (typeof VIEW_ACTION_NAMES)[number];

/** The id used both to register and unregister an in-view action. */
export function viewActionId(extensionId: string, name: ViewActionName): string {
  return `${extensionId}.view.${name}`;
}

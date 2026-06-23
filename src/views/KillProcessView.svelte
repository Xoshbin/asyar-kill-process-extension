<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type {
    IProcessService,
    IActionService,
    ISearchBarAccessoryService,
    AppGroup,
    ProcessInfo,
  } from 'asyar-sdk/contracts';
  import { ActionContext } from 'asyar-sdk/contracts';
  import { formatBytes, formatCpu } from '../lib/format';
  import { shouldConfirm } from '../lib/confirm';
  import { VIEW_ACTION_NAMES, viewActionId } from '../lib/actions';
  import {
    buildFlatRows,
    nextIndex,
    clampIndex,
    keyIntent,
    resolveKeyAction,
    type FlatRow,
  } from '../lib/navigation';

  type SortBy = 'cpu' | 'memory' | 'name';

  interface Props {
    context: {
      getService: <T>(name: string) => T;
      preferences: { values?: Record<string, unknown> };
      hideLauncher(): void;
    };
    actions: IActionService;
    searchBarAccessory: ISearchBarAccessoryService;
    extensionId: string;
  }
  let { context, actions, searchBarAccessory, extensionId }: Props = $props();

  const processSvc = $derived(context.getService<IProcessService>('process'));

  const SORT_VALUES: SortBy[] = ['cpu', 'memory', 'name'];
  const isSortBy = (v: string): v is SortBy => (SORT_VALUES as string[]).includes(v);

  let query = $state('');
  // Sort is owned by the launcher's ⌘P accessory dropdown (declared in the
  // manifest). The launcher persists the pick across reopens and re-seeds it
  // via the onChange handler on mount; 'cpu' is just the pre-seed fallback.
  let sortBy = $state<SortBy>('cpu');
  let groups = $state<AppGroup[]>([]);
  let expanded = $state<Set<string>>(new Set());
  let selectedIndex = $state(0);
  let pending = $state<{ group: AppGroup; force: boolean } | null>(null);
  let error = $state<string | null>(null);
  let listEl = $state<HTMLUListElement | null>(null);
  let accessoryDispose: (() => void) | null = null;

  // The flat, keyboard-navigable sequence of rows: each group followed by its
  // children when expanded. All navigation runs over this index space.
  const flatRows = $derived(buildFlatRows(groups, expanded));

  const skipConfirm = () => context.preferences?.values?.skipConfirmation === true;
  const autoRefreshMs = () => Number(context.preferences?.values?.autoRefreshMs ?? 3000);
  const showPid = () => context.preferences?.values?.showPid === true;
  const closeAfterKill = () => context.preferences?.values?.closeAfterKill !== false;

  async function reload() {
    try {
      groups = await processSvc.list({ query: query.trim() || undefined, sortBy });
      error = null;
      // Keep the selection valid as the list grows/shrinks across reloads.
      selectedIndex = clampIndex(selectedIndex, buildFlatRows(groups, expanded).length);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  // Initial load + query/sort changes re-query Rust (rust-first: no client filtering/sorting).
  $effect(() => {
    query;
    sortBy;
    void reload();
  });

  // Auto-refresh poll — interval comes from a user preference (display cadence,
  // not continuous Rust-push data), so a timer here is intentional, not banned polling.
  $effect(() => {
    const ms = autoRefreshMs();
    if (!Number.isFinite(ms) || ms <= 0) return;
    const t = setInterval(() => void reload(), ms);
    return () => clearInterval(t);
  });

  function toggle(name: string) {
    const next = new Set(expanded);
    next.has(name) ? next.delete(name) : next.add(name);
    expanded = next;
  }

  function selectedRow(): FlatRow | null {
    return flatRows[selectedIndex] ?? null;
  }

  function scrollSelectedIntoView() {
    // Defer to next frame so the DOM reflects the new selectedIndex first.
    requestAnimationFrame(() => {
      const el = listEl?.querySelector<HTMLElement>(`[data-row-index="${selectedIndex}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    });
  }

  function moveSelection(key: string) {
    selectedIndex = nextIndex(flatRows.length, selectedIndex, key);
    scrollSelectedIntoView();
  }

  // ArrowRight expands a collapsed group; ArrowLeft collapses an expanded group
  // or, on a child row, jumps selection up to its parent group. Idempotent.
  function expandSelected() {
    const row = selectedRow();
    if (row?.kind === 'group' && !expanded.has(row.group.appName)) {
      toggle(row.group.appName);
      scrollSelectedIntoView();
    }
  }

  function collapseSelected() {
    const row = selectedRow();
    if (!row) return;
    if (row.kind === 'group' && expanded.has(row.group.appName)) {
      toggle(row.group.appName);
    } else if (row.kind === 'child') {
      const parentIdx = flatRows.findIndex(
        (r) => r.kind === 'group' && r.group.appName === row.group.appName,
      );
      if (parentIdx >= 0) selectedIndex = parentIdx;
    }
    scrollSelectedIntoView();
  }

  /** A single child rendered as a one-process group, so kill routes through the
   * same guardrail (the child carries its own `protected` flag). */
  function childAsGroup(group: AppGroup, child: ProcessInfo): AppGroup {
    return {
      ...group,
      totalCpu: child.cpuPercent,
      totalMemoryBytes: child.memoryBytes,
      processCount: 1,
      protected: child.protected,
      children: [child],
    };
  }

  function killSelected(force: boolean) {
    const row = selectedRow();
    if (!row) return;
    if (row.kind === 'child') {
      requestKill(childAsGroup(row.group, row.child), force);
    } else {
      requestKill(row.group, force);
    }
  }

  function toggleSelected() {
    const row = selectedRow();
    if (row) toggle(row.group.appName);
  }

  function requestKill(group: AppGroup, force: boolean) {
    if (shouldConfirm(group, skipConfirm())) {
      pending = { group, force }; // protected ALWAYS confirms, ignoring skipConfirm
    } else {
      void doKill(group, force, false);
    }
  }

  async function doKill(group: AppGroup, force: boolean, confirmedProtected: boolean) {
    pending = null;
    const pids = group.children.map((c) => c.pid);
    try {
      const res = await processSvc.kill({
        pids,
        force,
        confirmedProtected,
      });
      if (res.failed.length) {
        error = `Failed to kill ${res.failed.length} process(es): ${res.failed[0].error}`;
        await reload();
      } else if (closeAfterKill()) {
        context.hideLauncher();
      } else {
        await reload();
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  // Keys arrive from two mutually-exclusive sources depending on focus:
  // (1) the host forwards arrows/Enter/Tab as an `asyar:view:keydown`
  // postMessage when the launcher window has focus; (2) when our own filter
  // input has focus the keys fire as native keydown inside the iframe. Both
  // drive the SAME state through the shared `keyIntent` → `dispatchIntent`
  // path (registerAction `shortcut` is display-only and does NOT bind keys).
  // ⌘K-open is safe: when the panel is open it lives in the parent document,
  // takes focus out of the iframe, and the launcher consumes Enter for the
  // panel — neither source fires here.
  // Confirm the open dialog using the SAME call its "Kill" / "Kill anyway"
  // button uses — same confirmedProtected (the group's protected flag), so the
  // guardrail is unchanged; this just lets ⏎ press the confirm button.
  function confirmPending() {
    if (pending) doKill(pending.group, pending.force, pending.group.protected);
  }

  // Routes a key intent to an effect. When the confirm overlay is open,
  // `resolveKeyAction` rewrites Enter → 'confirm' and swallows everything else
  // (so arrows can't move the list under the dialog).
  function dispatchIntent(intent: ReturnType<typeof keyIntent>): boolean {
    const action = resolveKeyAction(intent, pending !== null);
    switch (action) {
      case 'up':
        moveSelection('ArrowUp');
        return true;
      case 'down':
        moveSelection('ArrowDown');
        return true;
      case 'expand':
        expandSelected();
        return true;
      case 'collapse':
        collapseSelected();
        return true;
      case 'kill':
        killSelected(false); // routes through requestKill → shouldConfirm guardrail
        return true;
      case 'force-kill':
        killSelected(true);
        return true;
      case 'refresh':
        void reload();
        return true;
      case 'confirm':
        confirmPending();
        return true;
      default:
        return false;
    }
  }

  function onHostMessage(event: MessageEvent) {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'asyar:view:search') {
      // Filtering is driven by the launcher's main search bar (searchable: true),
      // forwarded here as `asyar:view:search` — same pattern as tauri-docs.
      query = data.payload?.query ?? '';
      selectedIndex = 0;
      return;
    }
    if (data.type !== 'asyar:view:keydown') return;
    const p = data.payload ?? {};
    dispatchIntent(keyIntent({ key: p.key, meta: p.metaKey, ctrl: p.ctrlKey }));
  }

  function onLocalKeydown(e: KeyboardEvent) {
    // The host doesn't forward Escape; if our filter input has focus the local
    // source may see it — let it cancel an open dialog (otherwise Esc pops the
    // whole view by launcher contract, which is the desired fallback).
    if (e.key === 'Escape' && pending !== null) {
      pending = null;
      e.preventDefault();
      return;
    }
    const handled = dispatchIntent(keyIntent({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey }));
    // Stop arrows from moving the filter cursor and Enter from submitting.
    if (handled) e.preventDefault();
  }

  onMount(() => {
    window.addEventListener('message', onHostMessage);
    window.addEventListener('keydown', onLocalKeydown);

    // Register EXTENSION_VIEW-context actions so they appear in the launcher's
    // ⌘K drawer while this view is mounted. registerAction keeps `execute`
    // locally and the host dispatches asyar:action:execute back to run it.
    // (registerActionHandler — used earlier — only wires a handler for a
    // manifest CORE action that shows when the command is selected in SEARCH,
    // never in-view, so it was the wrong mechanism.)
    actions.registerAction({
      id: viewActionId(extensionId, 'kill'),
      title: 'Kill Process',
      icon: '💀',
      shortcut: '↵',
      category: 'Process',
      extensionId,
      context: ActionContext.EXTENSION_VIEW,
      destructive: true,
      execute: () => killSelected(false),
    });
    actions.registerAction({
      id: viewActionId(extensionId, 'force-kill'),
      title: 'Force Kill Process',
      icon: '⚠️',
      shortcut: '⌘↵',
      category: 'Process',
      extensionId,
      context: ActionContext.EXTENSION_VIEW,
      destructive: true,
      execute: () => killSelected(true),
    });
    actions.registerAction({
      id: viewActionId(extensionId, 'toggle-expand'),
      title: 'Expand / Collapse',
      icon: '▶',
      shortcut: '→',
      category: 'Process',
      extensionId,
      context: ActionContext.EXTENSION_VIEW,
      execute: () => toggleSelected(),
    });
    actions.registerAction({
      id: viewActionId(extensionId, 'refresh'),
      title: 'Refresh',
      icon: '🔄',
      shortcut: '⌃R',
      category: 'Process',
      extensionId,
      context: ActionContext.EXTENSION_VIEW,
      execute: () => void reload(),
    });

    // Sort is driven by the launcher's native ⌘P searchbar accessory dropdown
    // (declared in the manifest). onChange fires with the persisted/seed value
    // on subscribe, then on every pick — the launcher owns the value, so the
    // view only listens (no set(): translate doesn't call it, and a mount-time
    // set races the launcher's own seed + can reject on persistence).
    accessoryDispose = searchBarAccessory.onChange((value) => {
      if (isSortBy(value)) sortBy = value;
    });
  });

  onDestroy(() => {
    window.removeEventListener('message', onHostMessage);
    window.removeEventListener('keydown', onLocalKeydown);
    accessoryDispose?.();
    for (const name of VIEW_ACTION_NAMES) {
      actions.unregisterAction(viewActionId(extensionId, name));
    }
  });
</script>

<div class="kp">
  {#if error}<p class="kp-error">{error}</p>{/if}

  <ul class="kp-list custom-scrollbar" bind:this={listEl}>
    {#each flatRows as row, i (row.kind === 'group' ? `g:${row.group.appName}` : `c:${row.child.pid}`)}
      {#if row.kind === 'group'}
        <li
          class="kp-row"
          class:protected={row.group.protected}
          class:selected={selectedIndex === i}
          data-row-index={i}
        >
          <button
            class="kp-main"
            onclick={() => {
              selectedIndex = i;
              toggle(row.group.appName);
            }}
          >
            <span class="kp-name">{row.group.protected ? '⚠ ' : ''}{row.group.appName}</span>
            <span class="kp-stat">{formatCpu(row.group.totalCpu)}</span>
            <span class="kp-stat">{formatBytes(row.group.totalMemoryBytes)}</span>
            <span class="kp-count"
              >{row.group.processCount} {row.group.processCount === 1 ? 'proc' : 'procs'}</span
            >
          </button>
        </li>
      {:else}
        <li
          class="kp-row kp-child-row"
          class:protected={row.child.protected}
          class:selected={selectedIndex === i}
          data-row-index={i}
        >
          <button class="kp-main kp-child" onclick={() => (selectedIndex = i)}>
            <span class="kp-name">{row.child.protected ? '⚠ ' : ''}{row.child.name}</span>
            {#if showPid()}<span class="kp-pid">{row.child.pid}</span>{/if}
            <span class="kp-stat">{formatCpu(row.child.cpuPercent)}</span>
            <span class="kp-stat">{formatBytes(row.child.memoryBytes)}</span>
          </button>
        </li>
      {/if}
    {/each}
  </ul>

  {#if pending}
    <div class="kp-confirm">
      <div class="kp-confirm-card" role="dialog" aria-modal="true">
        <p class="kp-confirm-msg">
          {pending.group.protected
            ? `⚠ "${pending.group.appName}" is a protected system process. Killing it can crash your session.`
            : `Kill "${pending.group.appName}" (${pending.group.processCount} process${pending.group.processCount === 1 ? '' : 'es'})?`}
        </p>
        <div class="kp-confirm-actions">
          <button class="kp-btn kp-btn-danger" onclick={() => confirmPending()}>
            {pending.group.protected ? 'Kill anyway' : 'Kill'}
          </button>
          <button class="kp-btn" onclick={() => (pending = null)}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .kp {
    display: flex;
    flex-direction: column;
    height: 100%;
    color: var(--text-primary);
    position: relative;
  }
  .kp-list {
    list-style: none;
    margin: 0;
    padding: var(--space-2);
    overflow-y: auto;
    flex: 1;
  }
  .kp-main {
    display: grid;
    grid-template-columns: 1fr auto auto auto;
    gap: var(--space-3);
    align-items: center;
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: var(--transition-normal);
  }
  .kp-main:hover {
    background: var(--bg-hover);
  }
  .kp-row.selected .kp-main {
    background: var(--bg-selected);
  }
  .kp-row.protected .kp-name {
    color: var(--accent-warning);
  }
  .kp-stat {
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
  }
  .kp-count {
    color: var(--text-tertiary);
    font-size: var(--font-size-xs);
  }
  .kp-child {
    padding-left: var(--space-5);
    color: var(--text-secondary);
  }
  .kp-child-row .kp-name {
    color: var(--text-secondary);
  }
  .kp-pid {
    font-variant-numeric: tabular-nums;
    color: var(--text-tertiary);
  }
  .kp-error {
    color: var(--accent-danger);
    padding: 0 var(--space-3);
    margin: var(--space-1) 0;
  }
  .kp-confirm {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-6);
    background: color-mix(in srgb, var(--bg-primary) 80%, transparent);
  }
  .kp-confirm-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    width: 100%;
    max-width: 320px;
    padding: var(--space-6);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-xl);
    background: var(--bg-popup);
    box-shadow: var(--shadow-popup);
    text-align: center;
  }
  .kp-confirm-msg {
    margin: 0;
    color: var(--text-primary);
    font-size: var(--font-size-md);
  }
  .kp-confirm-actions {
    display: flex;
    justify-content: center;
    gap: var(--space-3);
  }
  .kp-btn {
    padding: var(--space-2) var(--space-5);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-color);
    background: var(--bg-tertiary);
    color: var(--text-primary);
    cursor: pointer;
    font: inherit;
    font-weight: 500;
    transition: var(--transition-fast);
  }
  .kp-btn:hover {
    background: var(--bg-hover);
  }
  .kp-btn:active {
    transform: scale(0.98);
  }
  .kp-btn:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }
  .kp-btn-danger {
    border-color: var(--accent-danger);
    color: var(--accent-danger);
  }
</style>

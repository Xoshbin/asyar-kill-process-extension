<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type {
    IProcessService,
    IActionService,
    ISearchBarAccessoryService,
    IFeedbackService,
    AppGroup,
    ProcessInfo,
  } from 'asyar-sdk/contracts';
  import { ActionContext } from 'asyar-sdk/contracts';
  import { formatBytes, formatCpu } from '../lib/format';
  import { shouldConfirm } from '../lib/confirm';
  import { viewActionId } from '../lib/actions';
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
  const feedback = $derived(context.getService<IFeedbackService>('feedback'));
  const extensionManager = $derived(context.getService<any>('extensions'));

  const SORT_VALUES: SortBy[] = ['cpu', 'memory', 'name'];
  const isSortBy = (v: string): v is SortBy => (SORT_VALUES as string[]).includes(v);

  // A process is "heavy" when it alone can explain a frozen desktop: it burns
  // more than half a core, or holds more than 2 GB resident. Only the metric
  // that crossed its own threshold is tinted, so the scan stays quiet.
  const HOT_CPU_PERCENT = 50;
  const HOT_MEMORY_BYTES = 2 * 1024 ** 3;

  let query = $state('');
  let sortBy = $state<SortBy>('cpu');
  let groups = $state<AppGroup[]>([]);
  let expanded = $state<Set<string>>(new Set());
  let appGrouping = $state(true);
  let selectedIndex = $state(0);
  let pending = $state<{ group: AppGroup; force: boolean } | null>(null);
  let error = $state<string | null>(null);
  let listEl = $state<HTMLUListElement | null>(null);
  let dialogEl = $state<HTMLDivElement | null>(null);
  let accessoryDispose: (() => void) | null = null;

  // The flat, keyboard-navigable sequence of rows: each group followed by its
  // children when expanded. When appGrouping is false, all children are flat.
  const flatRows = $derived(buildFlatRows(groups, expanded, appGrouping));

  const totalProcessCount = $derived(groups.reduce((acc, g) => acc + g.processCount, 0));

  const emptyMessage = $derived(
    query.trim()
      ? `No running processes match "${query.trim()}"`
      : 'No running processes',
  );

  const skipConfirm = () => context.preferences?.values?.skipConfirmation === true;
  const autoRefreshMs = () => Number(context.preferences?.values?.autoRefreshMs ?? 3000);
  const showPid = () => context.preferences?.values?.showPid === true;
  const showPath = () => context.preferences?.values?.showPath === true;
  const closeAfterKill = () => context.preferences?.values?.closeAfterKill !== false;

  async function copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fallback */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  async function reload() {
    try {
      groups = await processSvc.list({ query: query.trim() || undefined, sortBy });
      error = null;
      selectedIndex = clampIndex(selectedIndex, flatRows.length);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  // Initial load + query/sort changes re-query Rust
  $effect(() => {
    query;
    sortBy;
    void reload();
  });

  // Auto-refresh poll
  $effect(() => {
    const ms = autoRefreshMs();
    if (!Number.isFinite(ms) || ms <= 0) return;
    const t = setInterval(() => void reload(), ms);
    return () => clearInterval(t);
  });

  // Move keyboard focus into dialog
  $effect(() => {
    if (pending) dialogEl?.focus({ preventScroll: true });
  });

  // Dynamic bottom bar action pill in launcher
  $effect(() => {
    if (pending) {
      extensionManager?.setActiveViewActionLabel?.(pending.force ? 'Force Kill' : 'Kill');
      return;
    }
    const row = selectedRow();
    if (!row) {
      extensionManager?.setActiveViewActionLabel?.('Kill');
      return;
    }
    const name = row.kind === 'group' ? row.group.appName : row.child.name;
    extensionManager?.setActiveViewActionLabel?.(`Kill ${name}`);
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
    requestAnimationFrame(() => {
      const el = listEl?.querySelector<HTMLElement>(`[data-row-index="${selectedIndex}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    });
  }

  function moveSelection(key: string) {
    selectedIndex = nextIndex(flatRows.length, selectedIndex, key);
    scrollSelectedIntoView();
  }

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

  function killGroupAll(force: boolean) {
    const row = selectedRow();
    if (!row) return;
    requestKill(row.group, force);
  }

  function toggleSelected() {
    const row = selectedRow();
    if (row) toggle(row.group.appName);
  }

  function requestKill(group: AppGroup, force: boolean) {
    if (shouldConfirm(group, skipConfirm())) {
      pending = { group, force };
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

  function confirmPending() {
    if (pending) doKill(pending.group, pending.force, pending.group.protected);
  }

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
        killSelected(false);
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
      query = data.payload?.query ?? '';
      selectedIndex = 0;
      return;
    }
    if (data.type !== 'asyar:view:keydown') return;
    const p = data.payload ?? {};
    dispatchIntent(
      keyIntent({ key: p.key, meta: p.metaKey, ctrl: p.ctrlKey, alt: p.altKey }),
    );
  }

  function onLocalKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && pending !== null) {
      pending = null;
      e.preventDefault();
      return;
    }
    if (pending !== null && e.key === 'Enter' && e.target instanceof Element) {
      if (e.target.closest('.kp-btn')) return;
    }
    const handled = dispatchIntent(
      keyIntent({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey }),
    );
    if (handled) e.preventDefault();
  }

  function appInitial(name: string): string {
    const first = name.trim()[0];
    return first ? first.toUpperCase() : '?';
  }

  const isHeavyCpu = (percent: number) => percent > HOT_CPU_PERCENT;
  const isHeavyMemory = (bytes: number) => bytes > HOT_MEMORY_BYTES;

  function groupPidLabel(group: AppGroup): string {
    const first = group.children[0]?.pid;
    if (first === undefined) return '';
    const rest = group.children.length - 1;
    return rest > 0 ? `PID ${first} +${rest}` : `PID ${first}`;
  }

  function confirmTitle(group: AppGroup): string {
    return group.protected
      ? `Kill system process ${group.appName}?`
      : `Kill ${group.appName}?`;
  }

  function confirmBody(group: AppGroup, force: boolean): string {
    if (group.protected) {
      return 'Terminating this system process may destabilize your system or cause data loss.';
    }
    const count = group.processCount;
    const scope = `This will terminate ${count} ${count === 1 ? 'process' : 'processes'}.`;
    return force ? `${scope} It will be killed immediately.` : scope;
  }

  onMount(() => {
    window.addEventListener('message', onHostMessage);
    window.addEventListener('keydown', onLocalKeydown);

    actions.registerAction({
      id: viewActionId(extensionId, 'kill'),
      title: 'Kill',
      icon: '⊗',
      shortcut: '↵',
      category: 'Process',
      extensionId,
      context: ActionContext.EXTENSION_VIEW,
      destructive: true,
      execute: () => killSelected(false),
    });

    actions.registerAction({
      id: viewActionId(extensionId, 'force-kill'),
      title: 'Force Kill',
      icon: '⊗',
      shortcut: '⌘↵',
      category: 'Process',
      extensionId,
      context: ActionContext.EXTENSION_VIEW,
      destructive: true,
      execute: () => killSelected(true),
    });

    actions.registerAction({
      id: viewActionId(extensionId, 'kill-all'),
      title: 'Kill All',
      icon: '⊗',
      shortcut: '⌥↵',
      category: 'Process',
      extensionId,
      context: ActionContext.EXTENSION_VIEW,
      destructive: true,
      execute: () => killGroupAll(false),
    });

    actions.registerAction({
      id: viewActionId(extensionId, 'force-kill-all'),
      title: 'Force Kill All',
      icon: '⊗',
      shortcut: '⌥⌘↵',
      category: 'Process',
      extensionId,
      context: ActionContext.EXTENSION_VIEW,
      destructive: true,
      execute: () => killGroupAll(true),
    });

    actions.registerAction({
      id: viewActionId(extensionId, 'copy-path'),
      title: 'Copy Path',
      icon: '📋',
      shortcut: '⌃⌘C',
      category: 'Process',
      extensionId,
      context: ActionContext.EXTENSION_VIEW,
      execute: async () => {
        const row = selectedRow();
        if (!row) return;
        const path = row.kind === 'child' ? row.child.path : (row.group.children[0]?.path || '');
        if (!path) {
          await feedback?.showHUD('No path available');
          return;
        }
        await feedback?.showHUD((await copyText(path)) ? 'Copied path' : 'Copy failed');
      },
    });

    actions.registerAction({
      id: viewActionId(extensionId, 'copy-name'),
      title: 'Copy Process Name',
      icon: '📋',
      shortcut: '⌥⌘C',
      category: 'Process',
      extensionId,
      context: ActionContext.EXTENSION_VIEW,
      execute: async () => {
        const row = selectedRow();
        if (!row) return;
        const name = row.kind === 'child' ? row.child.name : row.group.appName;
        await feedback?.showHUD((await copyText(name)) ? 'Copied process name' : 'Copy failed');
      },
    });

    actions.registerAction({
      id: viewActionId(extensionId, 'copy-pid'),
      title: 'Copy PID',
      icon: '📋',
      shortcut: '⌥⌘P',
      category: 'Process',
      extensionId,
      context: ActionContext.EXTENSION_VIEW,
      execute: async () => {
        const row = selectedRow();
        if (!row) return;
        const pid = row.kind === 'child' ? String(row.child.pid) : row.group.children.map((c) => c.pid).join(', ');
        if (!pid) {
          await feedback?.showHUD('No PID available');
          return;
        }
        await feedback?.showHUD((await copyText(pid)) ? 'Copied PID' : 'Copy failed');
      },
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
      id: viewActionId(extensionId, 'toggle-grouping'),
      title: appGrouping ? 'Disable App Grouping' : 'Enable App Grouping',
      icon: '🗖',
      shortcut: '⇧⌘G',
      category: 'Process',
      extensionId,
      context: ActionContext.EXTENSION_VIEW,
      execute: () => {
        appGrouping = !appGrouping;
        selectedIndex = 0;
      },
    });

    actions.registerAction({
      id: viewActionId(extensionId, 'refresh'),
      title: 'Reload',
      icon: '🔄',
      shortcut: '⌘R',
      category: 'Process',
      extensionId,
      context: ActionContext.EXTENSION_VIEW,
      execute: () => void reload(),
    });

    accessoryDispose = searchBarAccessory.onChange((value) => {
      if (!isSortBy(value) || value === sortBy) return;
      sortBy = value;
      selectedIndex = 0;
    });
  });

  onDestroy(() => {
    window.removeEventListener('message', onHostMessage);
    window.removeEventListener('keydown', onLocalKeydown);
    accessoryDispose?.();
    extensionManager?.setActiveViewActionLabel?.(null);
  });
</script>

<div class="kp">
  {#if error}<p class="kp-error" role="alert">{error}</p>{/if}

  {#if flatRows.length === 0 && !error}
    <div class="kp-empty">
      <p>{emptyMessage}</p>
    </div>
  {:else}
    <div class="kp-section-header">
      <span class="section-title">Processes</span>
      <span class="section-count">{totalProcessCount} running</span>
    </div>

    <ul class="kp-list custom-scrollbar" bind:this={listEl} aria-label="Running processes">
      {#each flatRows as row, i (row.kind === 'group' ? `g:${row.group.appName}` : `c:${row.child.pid}`)}
        {#if row.kind === 'group'}
          {@const group = row.group}
          {@const open = expanded.has(group.appName)}
          {@const grouped = group.processCount > 1 && appGrouping}
          <li class="kp-row" class:selected={selectedIndex === i} data-row-index={i}>
            <button
              class="kp-main"
              title={group.appName}
              aria-expanded={grouped ? open : undefined}
              onclick={() => {
                selectedIndex = i;
                if (grouped) toggle(group.appName);
              }}
            >
              <span class="kp-lead" aria-hidden="true">
                <span class="kp-chev" class:open>{grouped ? (open ? '⌄' : '›') : ''}</span>
                <span class="kp-tile" class:warn={group.protected} class:exec={!group.icon}>
                  {#if group.icon}
                    <img
                      src={group.icon}
                      alt=""
                      class="kp-app-icon"
                      onerror={(e) => {
                        const target = e.currentTarget as HTMLElement;
                        target.style.display = 'none';
                        const fallback = target.nextElementSibling as HTMLElement;
                        if (fallback) fallback.style.display = 'flex';
                      }}
                    />
                    <span class="kp-initial-fallback" style="display: none;">
                      {appInitial(group.appName)}
                    </span>
                  {:else}
                    <span class="exec-badge">exec</span>
                  {/if}
                </span>
              </span>

              <span class="kp-name">
                <span class="kp-name-text">{group.appName}</span>
                {#if grouped}
                  <span class="kp-subtitle">
                    {#if group.children[0]?.name && group.children[0].name.toLowerCase() !== group.appName.toLowerCase()}
                      {group.children[0].name} - {group.processCount} processes
                    {:else}
                      {group.processCount} processes
                    {/if}
                  </span>
                {:else if showPath() && group.children[0]?.path}
                  <span class="kp-subtitle kp-path">{group.children[0].path}</span>
                {/if}
              </span>

              <span class="kp-metric" class:hot={isHeavyCpu(group.totalCpu)} title="CPU">
                <svg
                  class="metric-icon"
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.75"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                  <rect x="9" y="9" width="6" height="6" />
                  <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                  <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                  <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                  <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
                </svg>
                <span>{formatCpu(group.totalCpu)}</span>
              </span>

              <span
                class="kp-metric mem"
                class:warm={isHeavyMemory(group.totalMemoryBytes)}
                title="Memory"
              >
                <svg
                  class="metric-icon"
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.75"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <rect x="2" y="6" width="20" height="12" rx="2" />
                  <line x1="6" y1="18" x2="6" y2="21" /><line x1="10" y1="18" x2="10" y2="21" />
                  <line x1="14" y1="18" x2="14" y2="21" /><line x1="18" y1="18" x2="18" y2="21" />
                  <circle cx="7" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" />
                  <circle cx="17" cy="12" r="1.5" />
                </svg>
                <span>{formatBytes(group.totalMemoryBytes)}</span>
              </span>

              <span class="kp-meta">
                {#if group.protected}<span class="kp-chip warn">Protected</span>{/if}
                {#if showPid()}<span class="kp-pid">{groupPidLabel(group)}</span>{/if}
              </span>
            </button>
          </li>
        {:else}
          <li
            class="kp-row kp-child-row"
            class:selected={selectedIndex === i}
            data-row-index={i}
          >
            <button
              class="kp-main"
              title={row.child.name}
              onclick={() => (selectedIndex = i)}
            >
              <span class="kp-lead" aria-hidden="true">
                <span class="kp-chev"></span>
                <span class="kp-tile exec">
                  <span class="exec-badge">exec</span>
                </span>
              </span>

              <span class="kp-name">
                <span class="kp-name-text">{row.child.name}</span>
                {#if showPath() && row.child.path}
                  <span class="kp-subtitle kp-path">{row.child.path}</span>
                {/if}
              </span>

              <span class="kp-metric" class:hot={isHeavyCpu(row.child.cpuPercent)} title="CPU">
                <svg
                  class="metric-icon"
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.75"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                  <rect x="9" y="9" width="6" height="6" />
                  <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                  <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                  <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                  <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
                </svg>
                <span>{formatCpu(row.child.cpuPercent)}</span>
              </span>

              <span
                class="kp-metric mem"
                class:warm={isHeavyMemory(row.child.memoryBytes)}
                title="Memory"
              >
                <svg
                  class="metric-icon"
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.75"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <rect x="2" y="6" width="20" height="12" rx="2" />
                  <line x1="6" y1="18" x2="6" y2="21" /><line x1="10" y1="18" x2="10" y2="21" />
                  <line x1="14" y1="18" x2="14" y2="21" /><line x1="18" y1="18" x2="18" y2="21" />
                  <circle cx="7" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" />
                  <circle cx="17" cy="12" r="1.5" />
                </svg>
                <span>{formatBytes(row.child.memoryBytes)}</span>
              </span>

              <span class="kp-meta">
                {#if row.child.protected}<span class="kp-chip warn">Protected</span>{/if}
                <span class="kp-pid">PID {row.child.pid}</span>
              </span>
            </button>
          </li>
        {/if}
      {/each}
    </ul>
  {/if}

  {#if pending}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="kp-scrim" role="presentation" onclick={() => (pending = null)}>
      <div
        class="kp-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kp-confirm-title"
        tabindex="-1"
        bind:this={dialogEl}
        onclick={(e) => e.stopPropagation()}
      >
        <h2 id="kp-confirm-title">{confirmTitle(pending.group)}</h2>
        <p class="kp-dialog-body">{confirmBody(pending.group, pending.force)}</p>
        <div class="kp-dialog-actions">
          <button class="kp-btn secondary" onclick={() => (pending = null)}>Cancel</button>
          <button class="kp-btn danger" onclick={confirmPending}>
            {pending.force ? 'Force kill' : 'Kill process'}
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .kp {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    color: var(--text-primary);
    font-family: var(--font-ui);
    font-size: var(--font-size-base);
  }

  .kp-section-header {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4) var(--space-1);
    flex-shrink: 0;
  }

  .section-title {
    color: var(--text-secondary);
    font-size: var(--font-size-xs);
    font-weight: 600;
    letter-spacing: var(--tracking-wide, 0.02em);
  }

  .section-count {
    color: var(--text-tertiary);
    font-size: var(--font-size-xs);
  }

  .kp-list {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: var(--space-1) var(--space-2);
    overflow-y: auto;
    list-style: none;
  }

  .kp-row {
    position: relative;
  }

  /* One row = one 38px band */
  .kp-main {
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr) 72px 88px auto;
    column-gap: var(--space-3);
    align-items: center;
    width: 100%;
    height: var(--shell-row-h);
    margin: 0;
    padding: 0 var(--space-3);
    border: none;
    border-radius: var(--radius-md);
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: default;
    box-sizing: border-box;
    transition: none;
  }

  .kp-main:focus,
  .kp-main:focus-visible {
    outline: none;
  }

  .kp-row:not(.selected) .kp-main:hover {
    background: var(--bg-hover);
  }

  .kp-row.selected .kp-main {
    background: var(--bg-selected);
  }

  /* ── Leading slot: chevron affordance + 22px icon tile ───────────── */
  .kp-lead {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 22px;
  }

  .kp-chev {
    flex: 0 0 8px;
    width: 8px;
    color: var(--text-tertiary);
    font-size: var(--font-size-sm);
    line-height: 1;
  }

  .kp-chev.open {
    color: var(--text-secondary);
  }

  .kp-tile {
    display: grid;
    place-items: center;
    flex: 0 0 22px;
    width: 22px;
    height: 22px;
    overflow: hidden;
    border-radius: var(--radius-xs);
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    font-size: var(--font-size-xs);
    font-weight: 600;
  }

  .kp-tile.exec {
    background: var(--bg-tertiary);
    border: 1px solid var(--separator);
  }

  .exec-badge {
    font-family: var(--font-mono);
    font-size: 8px;
    font-weight: 700;
    color: var(--accent-success, #10b981);
    letter-spacing: -0.5px;
    line-height: 1;
  }

  .kp-app-icon {
    width: 100%;
    height: 100%;
    object-fit: contain;
    border-radius: var(--radius-xs);
  }

  .kp-tile.warn {
    background: color-mix(in srgb, var(--accent-warning) 16%, transparent);
    color: var(--accent-warning);
  }

  /* ── Name column ──────────────────────────────────────────────────────── */
  .kp-name {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    min-width: 0;
    overflow: hidden;
  }

  .kp-name-text {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--text-primary);
    font-size: var(--font-size-base);
    font-weight: 500;
    letter-spacing: var(--tracking-tight);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .kp-subtitle {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--text-tertiary);
    font-size: var(--font-size-sm);
  }

  .kp-path {
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
  }

  /* ── Metrics: mono, tabular, right-aligned, with inline icon ────────── */
  .kp-metric {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-1);
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;
  }

  .metric-icon {
    flex-shrink: 0;
    color: var(--text-tertiary);
  }

  .kp-metric.hot {
    color: var(--accent-warning);
  }

  .kp-metric.hot .metric-icon {
    color: var(--accent-warning);
  }

  .kp-metric.warm {
    color: color-mix(in srgb, var(--accent-warning) 70%, var(--text-secondary));
  }

  .kp-metric.warm .metric-icon {
    color: color-mix(in srgb, var(--accent-warning) 70%, var(--text-secondary));
  }

  /* ── Trailing meta: PID pill + protected chip ─────────────────────────── */
  .kp-meta {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
    min-width: 0;
  }

  .kp-pid {
    padding: 1px var(--space-2);
    border-radius: var(--radius-full);
    background: color-mix(in srgb, var(--text-tertiary) 10%, transparent);
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .kp-chip {
    padding: 1px var(--space-2);
    border-radius: var(--radius-full);
    font-size: var(--font-size-xs);
    font-weight: 500;
    white-space: nowrap;
  }

  .kp-chip.warn {
    background: color-mix(in srgb, var(--accent-warning) 12%, transparent);
    color: var(--accent-warning);
  }

  /* ── Child rows: guide line ───────────────────────────────────────────── */
  .kp-child-row::before {
    position: absolute;
    top: 0;
    bottom: 0;
    left: calc(var(--space-3) + 19px);
    z-index: 1;
    border-left: 1px solid var(--separator);
    content: '';
    pointer-events: none;
  }

  .kp-child-row .kp-name-text {
    color: var(--text-secondary);
    font-weight: 400;
  }

  /* ── Empty + error ────────────────────────────────────────────────────── */
  .kp-empty {
    display: grid;
    flex: 1;
    place-items: center;
    padding: var(--space-8);
  }

  .kp-empty p {
    margin: 0;
    color: var(--text-tertiary);
    font-size: var(--font-size-md);
    text-align: center;
  }

  .kp-error {
    margin: 0;
    padding: var(--space-3) var(--space-6);
    color: var(--accent-danger);
    font-size: var(--font-size-sm);
  }

  /* ── Confirmation ─────────────────────────────────────────────────────── */
  .kp-scrim {
    position: absolute;
    inset: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-6);
    background: var(--scrim, rgba(0, 0, 0, 0.4));
    backdrop-filter: blur(8px);
  }

  .kp-dialog {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: 100%;
    max-width: 340px;
    padding: var(--space-6);
    border-radius: var(--radius-xl);
    background: var(--bg-popup);
    box-shadow: var(--shadow-popup);
    animation: kp-dialog-in var(--dur-quick) var(--ease-emerge);
  }

  .kp-dialog:focus {
    outline: none;
  }

  .kp-dialog h2 {
    margin: 0;
    color: var(--text-primary);
    font-size: var(--font-size-lg);
    font-weight: 600;
    letter-spacing: var(--tracking-tight);
  }

  .kp-dialog-body {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--font-size-md);
    line-height: 1.45;
  }

  .kp-dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-3);
    margin-top: var(--space-4);
  }

  .kp-btn {
    height: 28px;
    padding: 0 var(--space-5);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: var(--font-size-md);
    font-weight: 500;
    cursor: pointer;
    transition: var(--transition-fast);
  }

  .kp-btn:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .kp-btn.secondary {
    border-color: var(--border-color);
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .kp-btn.secondary:hover {
    background: var(--bg-hover);
  }

  .kp-btn.danger {
    background: var(--accent-danger-fill);
    color: var(--text-on-accent);
  }

  .kp-btn.danger:hover {
    background: color-mix(in srgb, var(--accent-danger-fill) 86%, var(--text-on-accent));
  }

  @keyframes kp-dialog-in {
    from {
      opacity: 0;
      transform: scale(0.96);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .kp-dialog {
      animation: none;
    }
  }
</style>

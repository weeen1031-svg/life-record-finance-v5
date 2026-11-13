import { moveOverviewItem, OVERVIEW_DEFAULT_FOCUS_COUNT } from './overview-preferences.js';

export function attachOverviewInteractions(root, { getConfig, saveConfig, onFocusOrder = () => true, document = globalThis.document }) {
  let drag = null;
  let pointerDrag = null;
  let pressTimer = 0;
  let frame = 0;
  let settling = false;
  let suppressClick = false;
  const environment = document.defaultView || globalThis.window;
  const reduced = () => environment?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const items = (kind) => [...(root.querySelectorAll?.('[data-overview-item]') || [])].filter((row) => row.dataset.overviewKind === kind);
  const ids = (kind) => kind === 'block' ? getConfig().blocks : items('focus').map((row) => row.dataset.overviewItem);
  const focusMonth = (key) => items('focus').find((row) => row.dataset.overviewItem === key)?.closest?.('[data-overview-budget-month]')?.dataset.overviewBudgetMonth || '';
  const reorder = (kind, key, destination) => {
    const config = structuredClone(getConfig()); const result = moveOverviewItem(ids(kind), key, destination);
    if (kind === 'block') config.blocks = result; else config.focus = result;
    if (kind === 'focus' && onFocusOrder(result, focusMonth(key)) === false) return;
    saveConfig(config);
    const handleSelector = kind === 'block' ? '[data-overview-block-handle]' : '[data-overview-focus-sort]';
    const handle = items(kind).find((row) => row.dataset.overviewItem === key)?.querySelector(handleSelector);
    handle?.focus?.({ preventScroll: true });
  };
  const blockRows = () => [...(root.querySelectorAll?.('.overview-block[data-overview-kind="block"]') || [])];
  const sortableRows = (kind) => kind === 'block' ? blockRows() : items('focus');
  const orderFor = (kind) => sortableRows(kind).map((row) => row.dataset.overviewItem);
  const setOrder = (kind, order, month = '', initialOrder = []) => {
    if (kind === 'focus' && onFocusOrder(order, month) === false) {
      for (const id of initialOrder) { const row = sortableRows(kind).find((item) => item.dataset.overviewItem === id); if (row) row.parentElement.append(row); }
      return false;
    }
    const config = structuredClone(getConfig()); config[kind === 'block' ? 'blocks' : 'focus'] = order; saveConfig(config); return true;
  };
  const placeGhost = (active) => {
    if (active.ghost) active.ghost.style.transform = `translate3d(${active.x - active.offsetX}px,${active.y - active.offsetY}px,0)`;
  };
  const flipRows = (kind, before, skip) => {
    if (reduced()) return;
    for (const row of sortableRows(kind)) {
      if (row === skip) continue;
      const prior = before.get(row); if (!prior) continue;
      for (const animation of row.getAnimations?.() || []) animation.cancel();
      const next = row.getBoundingClientRect(); const x = prior.left - next.left; const y = prior.top - next.top;
      if (x || y) row.animate([{ transform: `translate3d(${x}px,${y}px,0)` }, { transform: 'translate3d(0,0,0)' }], { duration: 155, easing: 'cubic-bezier(.2,.7,.3,1)' });
    }
  };
  const previewPosition = (active) => {
    const selector = active.kind === 'block' ? '.overview-block[data-overview-kind="block"]' : '[data-overview-focus-sort][data-overview-kind="focus"]';
    const under = document.elementFromPoint?.(active.x, active.y)?.closest?.(selector);
    if (!under || under === active.source || under.parentElement !== active.source.parentElement) return;
    const rect = under.getBoundingClientRect(); const before = new Map(sortableRows(active.kind).map((row) => [row, row.getBoundingClientRect()]));
    const after = active.y >= rect.top + rect.height / 2;
    const reference = after ? under.nextElementSibling : under;
    if (reference === active.source || (!reference && active.source === under.nextElementSibling)) return;
    active.source.parentElement.insertBefore(active.source, reference);
    flipRows(active.kind, before, active.source);
  };
  const beginPointerDrag = (active) => {
    if (pointerDrag !== active || active.started) return;
    active.started = true; settling = false;
    root.setPointerCapture?.(active.pointerId);
    const rect = active.source.getBoundingClientRect();
    const ghost = active.source.cloneNode(true);
    ghost.classList.add('overview-drag-ghost'); ghost.setAttribute('aria-hidden', 'true');
    for (const node of [ghost, ...ghost.querySelectorAll('*')]) {
      node.removeAttribute('id'); node.removeAttribute('data-overview-item'); node.removeAttribute('data-overview-kind'); node.removeAttribute('data-overview-focus-sort');
      if (node.matches?.('button,input,select,a,summary')) node.setAttribute('tabindex', '-1');
    }
    ghost.style.width = `${rect.width}px`; ghost.style.height = `${rect.height}px`;
    document.body.append(ghost); active.ghost = ghost;
    active.source.classList.add('is-overview-placeholder');
    document.body.classList.add('is-overview-pointer-dragging');
    placeGhost(active);
  };
  const clearPointerDrag = (active) => {
    if (frame) environment?.cancelAnimationFrame?.(frame); frame = 0;
    active.ghost?.remove(); active.source.classList.remove('is-overview-placeholder', 'is-overview-drop');
    document.body.classList.remove('is-overview-pointer-dragging');
    if (root.hasPointerCapture?.(active.pointerId)) root.releasePointerCapture(active.pointerId);
  };
  const restorePointerDrag = () => {
    if (!pointerDrag) return;
    const active = pointerDrag; pointerDrag = null;
    if (pressTimer) environment?.clearTimeout?.(pressTimer); pressTimer = 0;
    if (active.started) {
      const before = new Map(sortableRows(active.kind).map((row) => [row, row.getBoundingClientRect()]));
      const parent = active.source.parentElement;
      for (const id of active.initialOrder) { const row = sortableRows(active.kind).find((item) => item.dataset.overviewItem === id); if (row) parent.append(row); }
      active.source.classList.remove('is-overview-placeholder', 'is-overview-drop');
      flipRows(active.kind, before, null);
      clearPointerDrag(active);
    }
  };
  const finishPointerDrag = async (event) => {
    const active = pointerDrag;
    if (!active || event.pointerId !== active.pointerId) return;
    pointerDrag = null;
    if (pressTimer) environment?.clearTimeout?.(pressTimer); pressTimer = 0;
    if (!active.started) return;
    active.x = event.clientX; active.y = event.clientY; placeGhost(active); previewPosition(active);
    settling = true; suppressClick = true;
    if (frame) environment?.cancelAnimationFrame?.(frame); frame = 0;
    const target = active.source.getBoundingClientRect();
    if (!reduced() && active.ghost?.animate) {
      try { await active.ghost.animate([{ transform: active.ghost.style.transform }, { transform: `translate3d(${target.left}px,${target.top}px,0)` }], { duration: 135, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' }).finished; } catch { /* Final DOM order remains authoritative. */ }
    }
    const nextOrder = orderFor(active.kind); const changed = nextOrder.some((id, index) => id !== active.initialOrder[index]);
    clearPointerDrag(active);
    if (changed) setOrder(active.kind, nextOrder, active.source.closest?.('[data-overview-budget-month]')?.dataset.overviewBudgetMonth || '', active.initialOrder);
    settling = false; environment?.setTimeout?.(() => { suppressClick = false; }, 0);
  };
  root.addEventListener?.('pointerdown', (event) => {
    const block = event.target.closest?.('.overview-block[data-overview-kind="block"]');
    const focus = event.target.closest?.('[data-overview-focus-sort][data-overview-kind="focus"]');
    const source = block || focus; const kind = block ? 'block' : focus ? 'focus' : '';
    const handle = event.target.closest?.('[data-overview-block-handle]');
    if (!source || (kind === 'block' && !handle) || (!handle && event.target.closest?.('button,a,input,select,textarea,summary,label,[contenteditable="true"],[data-overview-no-drag]'))) return;
    if (event.button !== 0 || pointerDrag || settling) return;
    const rect = source.getBoundingClientRect();
    if (kind === 'focus') {
      const onCardEdge = event.clientX <= rect.left + 16 || event.clientX >= rect.right - 16 || event.clientY <= rect.top + 14 || event.clientY >= rect.bottom - 14;
      const onLabel = Boolean(event.target.closest?.('.budget-focus-label'));
      if (!onCardEdge && !onLabel) return;
    }
    const active = pointerDrag = { source, kind, pointerId: event.pointerId, pointerType: event.pointerType, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, initialOrder: orderFor(kind) };
    if (event.pointerType === 'touch') pressTimer = environment?.setTimeout?.(() => beginPointerDrag(active), 360) || 0;
  });
  root.addEventListener?.('pointermove', (event) => {
    const active = pointerDrag; if (!active || event.pointerId !== active.pointerId) return;
    active.x = event.clientX; active.y = event.clientY;
    if (!active.started) {
      if (active.pointerType === 'touch') {
        if (Math.hypot(active.x - active.startX, active.y - active.startY) > 9) { if (pressTimer) environment?.clearTimeout?.(pressTimer); pressTimer = 0; pointerDrag = null; }
        return;
      }
      if (Math.hypot(active.x - active.startX, active.y - active.startY) < 5) return;
      beginPointerDrag(active);
    }
    event.preventDefault(); placeGhost(active);
    if (!frame) frame = environment.requestAnimationFrame(() => { frame = 0; if (pointerDrag === active) previewPosition(active); });
  }, { passive: false });
  root.addEventListener?.('pointerup', (event) => { void finishPointerDrag(event); });
  root.addEventListener?.('pointercancel', restorePointerDrag);
  root.addEventListener?.('lostpointercapture', (event) => { if (pointerDrag?.pointerId === event.pointerId) restorePointerDrag(); });
  document.addEventListener?.('keydown', (event) => { if (event.key === 'Escape' && pointerDrag?.started) { event.preventDefault(); restorePointerDrag(); } });
  environment?.addEventListener?.('blur', restorePointerDrag);
  document.addEventListener?.('click', (event) => { if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  document.addEventListener('click', (event) => {
    const toggle = event.target.closest?.('[data-action="toggle-budget-summary"], [data-action="toggle-recent-records"], [data-action="toggle-subscription-summary"]');
    if (!toggle) return;
    const block = toggle.dataset.action === 'toggle-budget-summary' ? 'budget' : toggle.dataset.action === 'toggle-recent-records' ? 'recent' : 'subscriptions';
    const content = block === 'subscriptions'
      ? toggle.closest('.workbench-subscription-card')?.querySelector('.overview-collapsible-content')
      : toggle.closest('.overview-block')?.querySelector('.overview-collapsible-content');
    const fromHeight = content?.getBoundingClientRect?.().height ?? 0;
    const config = structuredClone(getConfig());
    if (toggle.dataset.action === 'toggle-budget-summary') config.budgetCollapsed = !config.budgetCollapsed;
    else if (toggle.dataset.action === 'toggle-recent-records') config.recentCollapsed = !config.recentCollapsed;
    else config.subscriptionsCollapsed = !config.subscriptionsCollapsed;
    saveConfig(config, { collapseTransition: { block, fromHeight } });
  });
  document.addEventListener('change', (event) => {
    if (event.target.dataset?.overviewFocusVisibleCount !== undefined) {
      const visibleCount = Number(event.target.dataset.overviewFocusVisibleCount);
      if (![1, 2, 3].includes(visibleCount)) return;
      const config = structuredClone(getConfig());
      config.focusVisibleCount = visibleCount;
      saveConfig(config);
      return;
    }
    if (event.target.dataset?.overviewFocusFilter !== undefined) {
      const config = structuredClone(getConfig());
      config.focusFilterEnabled = event.target.checked;
      saveConfig(config);
      return;
    }
    const key = event.target.dataset?.overviewFocus;
    if (!key) return;
    const config = structuredClone(getConfig());
    const selected = config.focus === null ? ids('focus').slice(0, OVERVIEW_DEFAULT_FOCUS_COUNT) : config.focus;
    config.focus = selected.filter((id) => id !== key);
    if (event.target.checked) config.focus.push(key);
    saveConfig(config);
  });
  document.addEventListener('keydown', (event) => {
    const blockHandle = event.target.closest?.('[data-overview-block-handle]');
    if (blockHandle && typeof blockHandle.closest === 'function' && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
      const row = blockHandle.closest('[data-overview-item]'); if (!row) return;
      const order = ids('block'); const from = order.indexOf(row.dataset.overviewItem); const next = from + (event.key === 'ArrowUp' ? -1 : 1);
      event.preventDefault(); if (next >= 0 && next < order.length) reorder('block', order[from], order[next]);
      return;
    }
    const handle = event.target.closest?.('[data-overview-focus-sort]');
    if (!handle || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const row = handle.closest('[data-overview-item]'); if (!row) return;
    const order = ids(row.dataset.overviewKind); const from = order.indexOf(row.dataset.overviewItem);
    const next = from + (event.key === 'ArrowUp' ? -1 : 1);
    event.preventDefault(); if (next >= 0 && next < order.length) reorder(row.dataset.overviewKind, order[from], order[next]);
  });
  document.addEventListener('dragstart', (event) => {
    const handle = event.target.closest?.('[data-overview-handle]'); const row = handle?.closest('[data-overview-item]');
    if (!row) return;
    drag = { kind: row.dataset.overviewKind, key: row.dataset.overviewItem };
    event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', `LifeRecordOverview:${drag.key}`);
    event.dataTransfer.setDragImage?.(row, 20, 12); row.classList.add('is-overview-dragging');
  });
  const clear = () => { for (const row of root.querySelectorAll?.('.is-overview-drop,.is-overview-dragging') || []) row.classList.remove('is-overview-drop', 'is-overview-dragging'); };
  document.addEventListener('dragover', (event) => {
    const row = event.target.closest?.(drag?.kind === 'block' ? '[data-overview-kind="block"]' : '[data-overview-item]');
    if (!drag || row?.dataset.overviewKind !== drag.kind) return;
    event.preventDefault();
    for (const item of root.querySelectorAll?.('.is-overview-drop') || []) item.classList.remove('is-overview-drop');
    row.classList.add('is-overview-drop');
  });
  document.addEventListener('drop', (event) => {
    const row = event.target.closest?.(drag?.kind === 'block' ? '[data-overview-kind="block"]' : '[data-overview-item]'); const active = drag; drag = null; clear();
    if (!active || row?.dataset.overviewKind !== active.kind) return;
    event.preventDefault(); reorder(active.kind, active.key, row.dataset.overviewItem);
  });
  document.addEventListener('dragend', () => { drag = null; clear(); });
}

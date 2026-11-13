import { isFinanceAppLocation } from './app-location.js';

export const BUDGET_ORDER_KEY = 'LifeRecord_UI_BudgetOrder_v1';
export const budgetOrderKey = (item) => typeof item === 'string' ? item : `${item?.categoryId || ''}::${item?.subcategoryId || ''}`;

const storageKey = (mode, month) => `${BUDGET_ORDER_KEY}_${mode}_${month}`;

function storageFor(environment, mode, month) {
  if (!['official', 'acceptance'].includes(mode)
    || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)
    || !isFinanceAppLocation(environment)
    || !environment.localStorage) throw new Error('預算排列偏好只允許在 Life Record 本機主頁保存。');
  return environment.localStorage;
}

export function normalizeBudgetOrder(budgets, preferredIds = []) {
  const rows = budgets.map((item) => typeof item === 'string' ? { id: item, key: item } : { id: item?.id, key: budgetOrderKey(item) });
  const available = rows.map((item) => item.key)
    .filter((id) => typeof id === 'string' && id.length > 0);
  const alias = new Map(rows.filter((item) => typeof item.id === 'string').map((item) => [item.id, item.key]));
  const availableSet = new Set(available); const seen = new Set(); const result = [];
  for (const priorId of preferredIds) {
    const id = alias.get(priorId) || priorId;
    if (availableSet.has(id) && !seen.has(id)) { result.push(id); seen.add(id); }
  }
  for (const id of available) if (!seen.has(id)) result.push(id);
  return result;
}

export function loadBudgetOrder(environment = globalThis, mode = 'official', month) {
  try {
    const storage = storageFor(environment, mode, month);
    const raw = storage.getItem(storageKey(mode, month));
    if (raw === null) return { ids: [], error: '' };
    if (raw.length > 100000) throw new Error('偏好內容過大');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || Object.keys(parsed).sort().join(',') !== 'ids,version'
      || !Array.isArray(parsed.ids) || parsed.ids.length > 500
      || parsed.ids.some((id) => typeof id !== 'string' || !id || id.length > 200)
      || new Set(parsed.ids).size !== parsed.ids.length) throw new Error('偏好格式不正確');
    return { ids: parsed.ids, error: '' };
  } catch {
    return { ids: [], error: '預算卡片排列偏好無法讀取，已使用預設順序。' };
  }
}

export function saveBudgetOrder(ids, month, environment = globalThis, mode = 'official') {
  if (!Array.isArray(ids) || ids.length > 500 || ids.some((id) => typeof id !== 'string' || !id || id.length > 200)
    || new Set(ids).size !== ids.length) throw new Error('預算排列內容不正確。');
  const storage = storageFor(environment, mode, month);
  const key = storageKey(mode, month); const raw = JSON.stringify({ version: 1, ids });
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new Error('預算排列偏好未能確認保存。');
}

export function moveBudgetOrder(ids, id, direction) {
  const next = [...ids]; const from = next.indexOf(id);
  const to = from + (direction === 'up' ? -1 : direction === 'down' ? 1 : 0);
  if (from < 0 || to < 0 || to >= next.length || from === to) return next;
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export function attachBudgetOrderInteractions(root, { environment = globalThis, mode = 'official', onSaved = () => {} } = {}) {
  const document = environment.document || globalThis.document;
  if (!root?.addEventListener || !document?.elementFromPoint) return () => {};
  let active = null; let timer = 0; let frame = 0; let suppressClick = false; let settling = false;
  const reducedMotion = () => Boolean(environment.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  const requestFrame = (callback) => environment.requestAnimationFrame ? environment.requestAnimationFrame(callback) : environment.setTimeout(callback, 16);
  const cancelFrame = (id) => environment.cancelAnimationFrame ? environment.cancelAnimationFrame(id) : environment.clearTimeout(id);
  const listFor = (item) => item?.closest?.('.finance-budget-card-list[data-budget-sortable]');
  const rows = (list) => [...(list?.querySelectorAll?.(':scope > [data-budget-sort-item]') || [])];
  const order = (list) => rows(list).map((item) => item.dataset.budgetSortItem);
  const status = (list, message, error = false) => {
    const node = list?.querySelector?.('[data-budget-order-status]');
    if (node) { node.textContent = message; node.dataset.state = error ? 'error' : 'ok'; }
  };
  const flip = (before, skip = null) => {
    if (reducedMotion()) return;
    for (const row of before.keys()) {
      if (row === skip || !row.isConnected) continue;
      for (const animation of row.getAnimations?.() || []) animation.cancel();
      const prior = before.get(row); const next = row.getBoundingClientRect();
      const x = prior.left - next.left; const y = prior.top - next.top;
      if (x || y) row.animate?.([{ transform: `translate3d(${x}px,${y}px,0)` }, { transform: 'translate3d(0,0,0)' }], { duration: 155, easing: 'cubic-bezier(.2,.7,.3,1)' });
    }
  };
  const placeGhost = (drag) => { if (drag.ghost) drag.ghost.style.transform = `translate3d(${drag.x - drag.offsetX}px,${drag.y - drag.offsetY}px,0)`; };
  const preview = (drag) => {
    const under = document.elementFromPoint(drag.x, drag.y)?.closest?.('[data-budget-sort-item]');
    if (!under || under === drag.source || listFor(under) !== drag.list || under.parentElement !== drag.source.parentElement) return;
    const rect = under.getBoundingClientRect();
    const after = Math.abs(drag.x - (rect.left + rect.width / 2)) > Math.abs(drag.y - (rect.top + rect.height / 2))
      ? drag.x >= rect.left + rect.width / 2 : drag.y >= rect.top + rect.height / 2;
    const reference = after ? under.nextElementSibling : under;
    if (reference === drag.source || (!reference && drag.source === under.nextElementSibling)) return;
    const before = new Map(rows(drag.list).map((row) => [row, row.getBoundingClientRect()]));
    drag.source.parentElement.insertBefore(drag.source, reference);
    flip(before, drag.source);
  };
  const clear = (drag) => {
    if (frame) cancelFrame(frame); frame = 0;
    drag.ghost?.remove(); drag.source.classList.remove('is-budget-sort-placeholder');
    document.body?.classList.remove('is-budget-pointer-dragging');
    if (root.hasPointerCapture?.(drag.pointerId)) root.releasePointerCapture(drag.pointerId);
  };
  const restore = () => {
    if (!active) return;
    const drag = active; active = null;
    if (timer) environment.clearTimeout(timer); timer = 0;
    if (drag.started && drag.source.isConnected) {
      const before = new Map(rows(drag.list).map((row) => [row, row.getBoundingClientRect()]));
      for (const id of drag.initialOrder) { const row = rows(drag.list).find((item) => item.dataset.budgetSortItem === id); if (row) drag.list.append(row); }
      flip(before);
    }
    clear(drag);
  };
  const keyboardMove = (event) => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key) || event.target !== event.target.closest?.('[data-budget-sort-item]')) return;
    const source = event.target; const list = listFor(source); if (!list) return;
    const current = order(list); const direction = event.key === 'ArrowUp' ? 'up' : 'down';
    const next = moveBudgetOrder(current, source.dataset.budgetSortItem, direction);
    if (next.every((id, index) => id === current[index])) return;
    event.preventDefault();
    const sibling = direction === 'up' ? source.previousElementSibling : source.nextElementSibling;
    if (!sibling) return;
    const before = new Map(rows(list).map((row) => [row, row.getBoundingClientRect()]));
    try {
      saveBudgetOrder(next, list.dataset.budgetMonth, environment, mode);
      if (direction === 'up') list.insertBefore(source, sibling); else list.insertBefore(source, sibling.nextElementSibling);
      flip(before); onSaved(list.dataset.budgetMonth, next); status(list, '預算卡片排列已保存。');
    } catch (error) { status(list, `排列未保存：${error.message}；順序未改變。`, true); }
  };
  const start = (drag) => {
    if (active !== drag || drag.started) return;
    drag.started = true; settling = false; root.setPointerCapture?.(drag.pointerId);
    const rect = drag.source.getBoundingClientRect(); const ghost = drag.source.cloneNode(true);
    ghost.classList.add('finance-budget-drag-ghost'); ghost.setAttribute('aria-hidden', 'true');
    for (const node of [ghost, ...(ghost.querySelectorAll?.('*') || [])]) {
      node.removeAttribute('id'); node.removeAttribute('data-budget-sort-item');
      if (node.matches?.('button,input,select,a,summary')) node.setAttribute('tabindex', '-1');
    }
    ghost.style.width = `${rect.width}px`; ghost.style.height = `${rect.height}px`; document.body.append(ghost); drag.ghost = ghost;
    drag.source.classList.add('is-budget-sort-placeholder'); document.body.classList.add('is-budget-pointer-dragging'); placeGhost(drag);
  };
  const finish = async (event) => {
    const drag = active; if (!drag || event.pointerId !== drag.pointerId) return;
    active = null; if (timer) environment.clearTimeout(timer); timer = 0;
    if (!drag.started) return;
    drag.x = event.clientX; drag.y = event.clientY; placeGhost(drag); preview(drag); settling = true; suppressClick = true;
    if (frame) cancelFrame(frame); frame = 0;
    const rect = drag.source.getBoundingClientRect();
    if (!reducedMotion() && drag.ghost?.animate) {
      try { await drag.ghost.animate([{ transform: drag.ghost.style.transform }, { transform: `translate3d(${rect.left}px,${rect.top}px,0)` }], { duration: 135, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' }).finished; } catch { /* DOM order remains authoritative. */ }
    }
    const next = order(drag.list); const changed = next.some((id, index) => id !== drag.initialOrder[index]);
    try {
      if (changed) { saveBudgetOrder(next, drag.list.dataset.budgetMonth, environment, mode); onSaved(drag.list.dataset.budgetMonth, next); status(drag.list, '預算卡片排列已保存。'); }
    } catch (error) {
      const before = new Map(rows(drag.list).map((row) => [row, row.getBoundingClientRect()]));
      for (const id of drag.initialOrder) { const row = rows(drag.list).find((item) => item.dataset.budgetSortItem === id); if (row) drag.list.append(row); }
      flip(before); status(drag.list, `排列未保存：${error.message}；已恢復原順序。`, true);
    }
    clear(drag); settling = false; environment.setTimeout(() => { suppressClick = false; }, 0);
  };
  const onPointerDown = (event) => {
    const source = event.target.closest?.('[data-budget-sort-item]'); const list = listFor(source);
    if (!source || !list || event.button !== 0 || active || settling
      || event.target.closest?.('button,a,input,select,textarea,summary,label,[contenteditable="true"]')) return;
    const rect = source.getBoundingClientRect();
    active = { source, list, pointerId: event.pointerId, pointerType: event.pointerType, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, initialOrder: order(list) };
    if (event.pointerType === 'touch') timer = environment.setTimeout(() => start(active), 360);
  };
  const onPointerMove = (event) => {
    const drag = active; if (!drag || event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX; drag.y = event.clientY;
    if (!drag.started) {
      if (drag.pointerType === 'touch') { if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 9) { environment.clearTimeout(timer); timer = 0; active = null; } return; }
      if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 5) return;
      start(drag);
    }
    event.preventDefault(); placeGhost(drag);
    if (!frame) frame = requestFrame(() => { frame = 0; if (active === drag) preview(drag); });
  };
  const onPointerCancel = () => restore();
  const onClickCapture = (event) => { if (suppressClick) { event.preventDefault(); event.stopPropagation(); suppressClick = false; } };
  root.addEventListener('pointerdown', onPointerDown); root.addEventListener('pointermove', onPointerMove, { passive: false });
  root.addEventListener('pointerup', finish); root.addEventListener('pointercancel', onPointerCancel);
  root.addEventListener('keydown', keyboardMove); root.addEventListener('click', onClickCapture, true);
  return () => {
    restore(); root.removeEventListener('pointerdown', onPointerDown); root.removeEventListener('pointermove', onPointerMove);
    root.removeEventListener('pointerup', finish); root.removeEventListener('pointercancel', onPointerCancel);
    root.removeEventListener('keydown', keyboardMove); root.removeEventListener('click', onClickCapture, true);
  };
}

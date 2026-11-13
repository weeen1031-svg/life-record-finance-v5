import { isFinanceAppLocation } from './app-location.js';

export const ACCOUNT_ORDER_KEY = 'LifeRecord_UI_AccountOrder_v1';

function getStorage(environment, mode) {
  if (!['official', 'acceptance'].includes(mode)
    || !isFinanceAppLocation(environment)
    || !environment.localStorage) throw new Error('目前無法保存帳戶卡片排列。');
  return environment.localStorage;
}

const keyForMode = (mode) => `${ACCOUNT_ORDER_KEY}_${mode}`;

export function normalizeAccountOrder(accounts, preferredIds = []) {
  const available = accounts.map((item) => item.id).filter((id) => typeof id === 'string' && id.length > 0);
  const availableSet = new Set(available);
  const seen = new Set();
  const result = [];
  for (const id of preferredIds) {
    if (availableSet.has(id) && !seen.has(id)) { result.push(id); seen.add(id); }
  }
  for (const id of available) if (!seen.has(id)) result.push(id);
  return result;
}

export function loadAccountOrder(environment = globalThis, mode = 'acceptance') {
  try {
    const text = getStorage(environment, mode).getItem(keyForMode(mode));
    if (text === null) return { ids: [], error: '' };
    if (text.length > 100000) throw new Error('排列偏好過大');
    const parsed = JSON.parse(text);
    if (!parsed || parsed.version !== 1 || Object.keys(parsed).sort().join(',') !== 'ids,version'
      || !Array.isArray(parsed.ids) || parsed.ids.length > 500
      || parsed.ids.some((id) => typeof id !== 'string' || !id || id.length > 200)
      || new Set(parsed.ids).size !== parsed.ids.length) throw new Error('排列偏好格式無效');
    return { ids: parsed.ids, error: '' };
  } catch {
    return { ids: [], error: '帳戶排列偏好無法讀取，先使用原有順序。' };
  }
}

export function saveAccountOrder(ids, environment = globalThis, mode = 'acceptance') {
  if (!Array.isArray(ids) || ids.length > 500 || ids.some((id) => typeof id !== 'string' || !id || id.length > 200)
    || new Set(ids).size !== ids.length) throw new Error('帳戶排列資料無效。');
  const storage = getStorage(environment, mode);
  const text = JSON.stringify({ version: 1, ids });
  storage.setItem(keyForMode(mode), text);
  if (storage.getItem(keyForMode(mode)) !== text) throw new Error('無法確認帳戶排列已保存。');
}

export function moveAccountOrder(ids, id, direction) {
  const result = [...ids];
  const from = result.indexOf(id);
  const to = from + (direction === 'up' ? -1 : direction === 'down' ? 1 : 0);
  if (from < 0 || to < 0 || to >= result.length || from === to) return result;
  [result[from], result[to]] = [result[to], result[from]];
  return result;
}

export function attachAccountOrderInteractions(root, { environment = globalThis, mode = 'acceptance', onSaved = () => {} } = {}) {
  const document = environment.document || globalThis.document;
  if (!root?.addEventListener || !document?.elementFromPoint) return () => {};
  let active = null;
  let timer = 0;
  let frame = 0;
  let suppressClick = false;
  let settling = false;

  const reducedMotion = () => Boolean(environment.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  const requestFrame = (callback) => environment.requestAnimationFrame ? environment.requestAnimationFrame(callback) : (environment.setTimeout ? environment.setTimeout(callback, 16) : setTimeout(callback, 16));
  const cancelFrame = (id) => { if (environment.cancelAnimationFrame) environment.cancelAnimationFrame(id); else (environment.clearTimeout || clearTimeout)(id); };
  const rows = () => [...(root.querySelectorAll?.('.finance-account-grid[data-account-sortable] [data-account-sort-item]') || [])];
  const order = () => rows().map((row) => row.dataset.accountSortItem);
  const status = (message, error = false) => {
    const node = root.querySelector?.('[data-account-order-status]');
    if (node) { node.textContent = message; node.dataset.state = error ? 'error' : 'ok'; }
  };
  const placeGhost = (drag) => { if (drag.ghost) drag.ghost.style.transform = `translate3d(${drag.x - drag.offsetX}px,${drag.y - drag.offsetY}px,0)`; };
  const flip = (before, skip = null) => {
    if (reducedMotion()) return;
    for (const row of rows()) {
      if (row === skip || !before.has(row)) continue;
      for (const animation of row.getAnimations?.() || []) animation.cancel();
      const prior = before.get(row); const next = row.getBoundingClientRect();
      const x = prior.left - next.left; const y = prior.top - next.top;
      if (x || y) row.animate?.([{ transform: `translate3d(${x}px,${y}px,0)` }, { transform: 'translate3d(0,0,0)' }], { duration: 155, easing: 'cubic-bezier(.2,.7,.3,1)' });
    }
  };
  const preview = (drag) => {
    const under = document.elementFromPoint(drag.x, drag.y)?.closest?.('[data-account-sort-item]');
    if (!under || under === drag.source || !under.closest('.finance-account-grid[data-account-sortable]')
      || under.parentElement !== drag.source.parentElement) return;
    const rect = under.getBoundingClientRect();
    const before = new Map(rows().map((row) => [row, row.getBoundingClientRect()]));
    const reference = drag.y >= rect.top + rect.height / 2 ? under.nextElementSibling : under;
    if (reference === drag.source || (!reference && drag.source === under.nextElementSibling)) return;
    drag.source.parentElement.insertBefore(drag.source, reference);
    flip(before, drag.source);
  };
  const clear = (drag) => {
    if (frame) cancelFrame(frame);
    frame = 0;
    drag.ghost?.remove();
    drag.source.classList.remove('is-account-sort-placeholder');
    document.body?.classList.remove('is-account-pointer-dragging');
    if (root.hasPointerCapture?.(drag.pointerId)) root.releasePointerCapture(drag.pointerId);
  };
  const restore = () => {
    if (!active) return;
    const drag = active; active = null;
    if (timer) (environment.clearTimeout || clearTimeout)(timer);
    timer = 0;
    if (!drag.started || !drag.source.isConnected) { clear(drag); return; }
    const before = new Map(rows().map((row) => [row, row.getBoundingClientRect()]));
    const parent = drag.source.parentElement;
    for (const id of drag.initialOrder) {
      const row = rows().find((item) => item.dataset.accountSortItem === id);
      if (row) parent.append(row);
    }
    flip(before);
    clear(drag);
  };
  const keyboardMove = (event) => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key) || event.target !== event.target.closest?.('[data-account-sort-item]')) return;
    const source = event.target;
    if (!source?.closest?.('.finance-account-grid[data-account-sortable]')) return;
    const direction = event.key === 'ArrowUp' ? 'up' : 'down';
    const current = order();
    const next = moveAccountOrder(current, source.dataset.accountSortItem, direction);
    if (next.every((id, index) => id === current[index])) return;
    event.preventDefault();
    const sibling = direction === 'up' ? source.previousElementSibling : source.nextElementSibling;
    if (!sibling) return;
    const before = new Map(rows().map((row) => [row, row.getBoundingClientRect()]));
    try {
      saveAccountOrder(next, environment, mode);
      if (direction === 'up') source.parentElement.insertBefore(source, sibling);
      else source.parentElement.insertBefore(source, sibling.nextElementSibling);
      flip(before);
      onSaved(next);
      status(`${source.querySelector?.('.finance-account-identity h3')?.textContent || '帳戶'}已${direction === 'up' ? '上移' : '下移'}；排列已保存。`);
    } catch (error) {
      status(`排列未保存：${error.message}；順序未改變。`, true);
    }
  };
  const start = (drag) => {
    if (active !== drag || drag.started) return;
    drag.started = true; settling = false;
    root.setPointerCapture?.(drag.pointerId);
    const rect = drag.source.getBoundingClientRect();
    const ghost = drag.source.cloneNode(true);
    ghost.classList.add('finance-account-drag-ghost'); ghost.setAttribute('aria-hidden', 'true');
    for (const node of [ghost, ...(ghost.querySelectorAll?.('*') || [])]) {
      node.removeAttribute('id'); node.removeAttribute('data-account-sort-item');
      if (node.matches?.('button,input,select,a,summary')) node.setAttribute('tabindex', '-1');
    }
    ghost.style.width = `${rect.width}px`; ghost.style.height = `${rect.height}px`;
    document.body.append(ghost); drag.ghost = ghost;
    drag.source.classList.add('is-account-sort-placeholder');
    document.body.classList.add('is-account-pointer-dragging');
    placeGhost(drag);
  };
  const finish = async (event) => {
    const drag = active;
    if (!drag || event.pointerId !== drag.pointerId) return;
    active = null;
    if (timer) (environment.clearTimeout || clearTimeout)(timer);
    timer = 0;
    if (!drag.started) return;
    drag.x = event.clientX; drag.y = event.clientY; placeGhost(drag); preview(drag);
    settling = true; suppressClick = true;
    if (frame) cancelFrame(frame);
    frame = 0;
    const rect = drag.source.getBoundingClientRect();
    if (!reducedMotion() && drag.ghost?.animate) {
      try { await drag.ghost.animate([{ transform: drag.ghost.style.transform }, { transform: `translate3d(${rect.left}px,${rect.top}px,0)` }], { duration: 135, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' }).finished; } catch { /* The DOM order remains authoritative. */ }
    }
    const next = order();
    const changed = next.some((id, index) => id !== drag.initialOrder[index]);
    try {
      if (changed) {
        saveAccountOrder(next, environment, mode);
        onSaved(next);
        status('帳戶卡片排列已保存。');
      }
    } catch (error) {
      const before = new Map(rows().map((row) => [row, row.getBoundingClientRect()]));
      for (const id of drag.initialOrder) { const row = rows().find((item) => item.dataset.accountSortItem === id); if (row) drag.source.parentElement.append(row); }
      flip(before);
      status(`排列未保存：${error.message}；已恢復原順序。`, true);
    }
    clear(drag); settling = false;
    (environment.setTimeout || setTimeout)(() => { suppressClick = false; }, 0);
  };

  root.addEventListener('pointerdown', (event) => {
    const source = event.target.closest?.('[data-account-sort-item]');
    if (!source || !source.closest('.finance-account-grid[data-account-sortable]')
      || event.button !== 0 || active || settling
      || event.target.closest?.('button,a,input,select,textarea,summary,label,[contenteditable="true"]')) return;
    const rect = source.getBoundingClientRect();
    const atEdge = event.clientX <= rect.left + 15 || event.clientX >= rect.right - 15
      || event.clientY <= rect.top + 13 || event.clientY >= rect.bottom - 13;
    if (!atEdge && !event.target.closest?.('.finance-account-heading')) return;
    const drag = active = { source, pointerId: event.pointerId, pointerType: event.pointerType, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, initialOrder: order() };
    if (event.pointerType === 'touch') timer = (environment.setTimeout || setTimeout)(() => start(drag), 360);
  });
  root.addEventListener('pointermove', (event) => {
    const drag = active; if (!drag || event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX; drag.y = event.clientY;
    if (!drag.started) {
      if (drag.pointerType === 'touch') {
        if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 9) { if (timer) (environment.clearTimeout || clearTimeout)(timer); timer = 0; active = null; }
        return;
      }
      if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 5) return;
      start(drag);
    }
    event.preventDefault(); placeGhost(drag);
    if (!frame) frame = requestFrame(() => { frame = 0; if (active === drag) preview(drag); });
  }, { passive: false });
  root.addEventListener('pointerup', (event) => { void finish(event); });
  root.addEventListener('pointercancel', restore);
  root.addEventListener('keydown', keyboardMove);
  root.addEventListener('click', (event) => {
    if (!suppressClick) return;
    event.preventDefault(); event.stopPropagation(); suppressClick = false;
  }, true);

  return () => { restore(); root.removeEventListener('pointercancel', restore); root.removeEventListener('keydown', keyboardMove); };
}

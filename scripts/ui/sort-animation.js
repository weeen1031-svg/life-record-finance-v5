const identity = (item) => `${item.dataset.sortKind}:${item.dataset.sortParent}:${item.dataset.sortId}`;

export function resolveSortDropIndex(rows, drag, targetId) {
  const from = rows.findIndex((row) => row.id === drag.id);
  const destination = drag.preview || { targetId, after: false };
  const index = rows.findIndex((row) => row.id === destination.targetId);
  if (from < 0 || index < 0) return null;
  const insertion = index + (destination.after ? 1 : 0);
  return insertion - (from < insertion ? 1 : 0);
}

export function captureSortPositions(root, kind, parent) {
  const positions = new Map();
  for (const item of root.querySelectorAll?.('[data-sort-item]') || []) {
    if (item.dataset.sortKind === kind && item.dataset.sortParent === parent) positions.set(identity(item), item.getBoundingClientRect());
  }
  return positions;
}

export function animateSortPositions(root, positions, environment = globalThis) {
  if (environment.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 0;
  let count = 0;
  for (const item of root.querySelectorAll?.('[data-sort-item]') || []) {
    const before = positions.get(identity(item));
    if (!before || typeof item.animate !== 'function') continue;
    for (const animation of item.getAnimations?.() || []) if (animation.id === 'life-record-sort') animation.cancel();
    const after = item.getBoundingClientRect(); const x = before.left - after.left; const y = before.top - after.top;
    if (Math.abs(x) < 1 && Math.abs(y) < 1) continue;
    try {
      const animation = item.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' }], { duration: 200, easing: 'cubic-bezier(.2,.7,.3,1)' });
      if (animation) animation.id = 'life-record-sort';
      count += 1;
    } catch { /* A visual effect must not turn a committed reorder into an error. */ }
  }
  return count;
}

// Only moves DOM while dragging. The category store is changed once, on drop.
export function previewSortMove(root, drag, target, point, environment = globalThis) {
  if (!drag || target?.dataset.sortKind !== drag.kind || target.dataset.sortParent !== drag.parent || target.dataset.sortId === drag.id) return null;
  const source = [...root.querySelectorAll('[data-sort-item]')].find((item) => item.dataset.sortId === drag.id && item.dataset.sortKind === drag.kind && item.dataset.sortParent === drag.parent);
  if (!source || source.parentElement !== target.parentElement) return null;
  if (drag.lastPoint && Math.abs(point.clientX - drag.lastPoint.x) + Math.abs(point.clientY - drag.lastPoint.y) < 4) return null;
  drag.lastPoint = { x: point.clientX, y: point.clientY };
  const rect = target.getBoundingClientRect(); const from = source.getBoundingClientRect();
  const horizontal = drag.kind === 'category' && Math.abs(rect.top - from.top) < rect.height / 2;
  const after = horizontal ? point.clientX > rect.left + rect.width / 2 : point.clientY > rect.top + rect.height / 2;
  const reference = after ? target.nextSibling : target;
  if (reference === source || source.nextSibling === reference) return null;
  const positions = captureSortPositions(root, drag.kind, drag.parent);
  source.parentElement.insertBefore(source, reference);
  animateSortPositions(root, positions, environment);
  return { targetId: target.dataset.sortId, after };
}

export function restoreSortPreview(root, drag, environment = globalThis, animate = true) {
  if (!drag?.initialIds) return;
  const rows = [...root.querySelectorAll('[data-sort-item]')].filter((item) => item.dataset.sortKind === drag.kind && item.dataset.sortParent === drag.parent);
  const positions = captureSortPositions(root, drag.kind, drag.parent);
  const parent = rows[0]?.parentElement;
  if (!parent) return;
  for (const id of drag.initialIds) { const row = rows.find((item) => item.dataset.sortId === id); if (row) parent.appendChild(row); }
  if (animate) animateSortPositions(root, positions, environment);
}

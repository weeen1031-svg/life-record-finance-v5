import { previewSortMove, restoreSortPreview } from './sort-animation.js';

// Pointer capture stays on the stable view root, never on a row being moved.
export function attachCategoryPointerSort(root, { onDrop, isBusy, onError = () => {}, environment = globalThis.window, document = globalThis.document }) {
  let active = null; let frame = 0; let suppressClick = false; let settling = false;
  const reduced = () => environment.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const placeGhost = (drag) => {
    if (!drag.ghost) return;
    const scale = drag.kind === 'category' || reduced() ? 1 : 1.025;
    drag.ghost.style.transform = `translate3d(${drag.x - drag.offsetX}px,${drag.y - drag.offsetY}px,0) scale(${scale})`;
  };
  const cleanup = (drag) => {
    if (frame) environment.cancelAnimationFrame(frame); frame = 0;
    drag.ghost?.remove(); drag.source.classList.remove('is-sorting', 'sort-drop-slot');
    document.body.classList.remove('is-category-dragging');
    if (root.hasPointerCapture?.(drag.pointerId)) root.releasePointerCapture(drag.pointerId);
  };
  const cancel = () => {
    if (!active) return;
    const drag = active; active = null;
    restoreSortPreview(root, drag, environment); cleanup(drag);
  };
  const draw = () => {
    frame = 0; const drag = active; if (!drag?.started) return;
    placeGhost(drag);
    const target = (document.elementsFromPoint?.(drag.x, drag.y) || []).map((node) => node.closest?.('[data-sort-item]')).find((node) => node && node !== drag.source && node.dataset.sortKind === drag.kind && node.dataset.sortParent === drag.parent);
    if (target) {
      const preview = previewSortMove(root, drag, target, { clientX: drag.x, clientY: drag.y }, environment);
      if (preview) drag.preview = preview;
    }
    const list = drag.source.closest('.assigned-subcategory-list');
    if (list && list.scrollHeight > list.clientHeight) {
      const bounds = list.getBoundingClientRect();
      if (drag.y < bounds.top + 36) list.scrollTop -= 8;
      else if (drag.y > bounds.bottom - 36) list.scrollTop += 8;
    } else if (drag.y < 60) environment.scrollBy?.(0, -8);
    else if (drag.y > environment.innerHeight - 60) environment.scrollBy?.(0, 8);
    frame = environment.requestAnimationFrame(draw);
  };
  document.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest?.('[data-sort-handle]'); const source = handle?.closest('[data-sort-item]');
    if (!source || event.button !== 0 || active || settling || isBusy()) return;
    event.preventDefault(); handle.focus?.({ preventScroll: true });
    const rect = source.getBoundingClientRect();
    active = { source, sourceRect: source.dataset.sortKind === 'category' ? rect : null, pointerId: event.pointerId, kind: source.dataset.sortKind, parent: source.dataset.sortParent, id: source.dataset.sortId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top,
      initialIds: [...root.querySelectorAll('[data-sort-item]')].filter((row) => row.dataset.sortKind === source.dataset.sortKind && row.dataset.sortParent === source.dataset.sortParent).map((row) => row.dataset.sortId) };
    root.setPointerCapture?.(event.pointerId);
  });
  document.addEventListener('pointermove', (event) => {
    const drag = active; if (!drag || event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX; drag.y = event.clientY;
    if (!drag.started && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 5) return;
    event.preventDefault();
    if (drag.kind === 'category' && drag.started) placeGhost(drag);
    if (!drag.started) {
      drag.started = true; const rect = drag.sourceRect || drag.source.getBoundingClientRect();
      const ghost = drag.source.cloneNode(true); ghost.classList.add('category-drag-ghost');
      if (drag.kind === 'category') ghost.classList.add('category-drag-ghost-category');
      ghost.setAttribute('aria-hidden', 'true');
      for (const node of [ghost, ...ghost.querySelectorAll('*')]) { node.removeAttribute('id'); node.removeAttribute('data-sort-item'); node.removeAttribute('data-sort-handle'); if (node.matches?.('button,input,select,a')) node.setAttribute('tabindex', '-1'); }
      ghost.style.width = `${rect.width}px`; ghost.style.minHeight = `${rect.height}px`;
      const scale = drag.kind === 'category' || reduced() ? 1 : 1.025;
      ghost.style.transform = `translate3d(${drag.x - drag.offsetX}px,${drag.y - drag.offsetY}px,0) scale(${scale})`;
      document.body.append(ghost); drag.ghost = ghost; drag.source.classList.add('is-sorting', 'sort-drop-slot'); document.body.classList.add('is-category-dragging');
      frame = environment.requestAnimationFrame(draw);
    }
  }, { passive: false });
  document.addEventListener('pointerup', async (event) => {
    const drag = active; if (!drag || event.pointerId !== drag.pointerId) return;
    active = null; if (frame) environment.cancelAnimationFrame(frame); frame = 0;
    if (!drag.started) { cleanup(drag); return; }
    suppressClick = true; settling = true;
    for (const animation of drag.source.getAnimations?.() || []) if (animation.id === 'life-record-sort') animation.cancel();
    const target = drag.source.getBoundingClientRect();
    if (!reduced() && drag.ghost?.animate) {
      try { await drag.ghost.animate([{ transform: drag.ghost.style.transform }, { transform: `translate3d(${target.left}px,${target.top}px,0) scale(1)` }], { duration: 140, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' }).finished; } catch { /* Animation does not decide data order. */ }
    }
    cleanup(drag);
    try { if (drag.preview) await onDrop(drag); else restoreSortPreview(root, drag, environment); }
    catch (error) { restoreSortPreview(root, drag, environment); onError(error); }
    finally { settling = false; environment.setTimeout(() => { suppressClick = false; }, 0); }
  });
  document.addEventListener('pointercancel', cancel);
  root.addEventListener?.('lostpointercapture', (event) => { if (active?.pointerId === event.pointerId) cancel(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && active) { event.preventDefault(); cancel(); } });
  document.addEventListener('click', (event) => { if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  environment.addEventListener?.('blur', cancel);
  return cancel;
}

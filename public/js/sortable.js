// Pointer-based drag & drop (mouse + touch) that can move items between several lists.

let dragging = false;
export const isDragging = () => dragging;

/**
 * @param root     element that contains the lists (and receives pointer events)
 * @param item     selector of draggable items (need data-id)
 * @param handle   selector of the drag handle inside an item
 * @param list     selector of the lists inside root; omit when root itself is the only list
 * @param onSort   called with [{ list, ids }] for every list when the order changed
 */
export function makeSortable(root, { item, handle, list, onSort }) {
  const lists = () => (list ? [...root.querySelectorAll(list)] : [root]);
  const itemsOf = (parent) => [...parent.children].filter((n) => n.matches(item));
  const snapshot = () => lists().map((l) => ({ list: l, ids: itemsOf(l).map((n) => n.dataset.id) }));

  root.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest(handle);
    if (!grip || !root.contains(grip) || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const el = grip.closest(item);
    if (!el || !lists().includes(el.parentElement)) return;
    e.preventDefault();

    const before = JSON.stringify(snapshot().map((s) => s.ids));
    const rect = el.getBoundingClientRect();
    const dx = e.clientX - rect.left;
    const dy = e.clientY - rect.top;
    const ghost = el.cloneNode(true);
    ghost.classList.add('drag-ghost');
    Object.assign(ghost.style, { width: `${rect.width}px`, height: `${rect.height}px`, left: `${rect.left}px`, top: `${rect.top}px` });
    // Inside a popover the ghost must live in it too, or it renders underneath (top layer).
    (el.closest('[popover]') || document.body).append(ghost);
    el.classList.add('drag-placeholder');
    dragging = true;

    // Scroll the page while dragging near the top/bottom edge.
    let pointerY = e.clientY;
    let raf = 0;
    const autoScroll = () => {
      if (pointerY < 80) window.scrollBy(0, -12);
      else if (pointerY > innerHeight - 80) window.scrollBy(0, 12);
      raf = requestAnimationFrame(autoScroll);
    };
    raf = requestAnimationFrame(autoScroll);

    const move = (ev) => {
      pointerY = ev.clientY;
      ghost.style.left = `${ev.clientX - dx}px`;
      ghost.style.top = `${ev.clientY - dy}px`;
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const valid = lists();
      const target = under?.closest(item);
      if (target && target !== el && valid.includes(target.parentElement)) {
        const parent = target.parentElement;
        const siblings = itemsOf(parent);
        const after = parent === el.parentElement && siblings.indexOf(el) < siblings.indexOf(target);
        parent.insertBefore(el, after ? target.nextSibling : target);
        return;
      }
      // Over an empty part of another list: append to it (before any trailing non-item, e.g. "Add" card).
      const area = list && under?.closest(list);
      if (area && area !== el.parentElement && valid.includes(area)) {
        const items = itemsOf(area);
        area.insertBefore(el, items.length ? items[items.length - 1].nextSibling : area.firstChild);
      }
    };

    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      cancelAnimationFrame(raf);
      ghost.remove();
      el.classList.remove('drag-placeholder');
      dragging = false;
      const after = snapshot();
      if (JSON.stringify(after.map((s) => s.ids)) !== before) onSort(after);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  });
}

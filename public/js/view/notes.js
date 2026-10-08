// Service notes: a small popover opened from the note button on a card.

import { $, h, fill, external } from '../dom.js';

// Trailing punctuation is left out of the link ("see http://x.lan." -> "http://x.lan").
const URL_RE = /(https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]])/g;

/** Text with http(s) links made clickable - built from text nodes, so nothing is parsed as HTML. */
const linkify = (text) => text.split(URL_RE).map((part, i) => (i % 2 ? h('a', { href: part, ...external }, part) : part));

let openFor = null;
let closedAt = 0;

export function openNote(svc, btn) {
  const pop = $('#notePop');
  // Clicking the same button again closes it: light dismiss already did that on pointerdown.
  if (openFor === svc.id && performance.now() - closedAt < 300) return;
  openFor = svc.id;
  $('#noteTitle').textContent = svc.name;
  fill($('#noteText'), linkify(svc.notes));
  if (pop.matches(':popover-open')) pop.hidePopover(); // e.g. opened from the keyboard
  pop.showPopover();

  // Under the button, right-aligned to it; above it when there is no room below.
  const r = btn.getBoundingClientRect();
  const below = r.bottom + 8 + pop.offsetHeight < innerHeight;
  pop.style.top = `${below ? r.bottom + 8 : Math.max(8, r.top - 8 - pop.offsetHeight)}px`;
  pop.style.left = `${Math.max(8, Math.min(r.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 8))}px`;
}

export function initNotes() {
  $('#notePop').addEventListener('toggle', (e) => {
    if (e.newState === 'closed') closedAt = performance.now();
  });
}

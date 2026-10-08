// Loading panel: which server is loading, what is happening, and a progress bar
// (a real percentage only where the steps are known; otherwise it just animates).

import { state } from '../state.js';
import { $, h, fill, svg } from '../dom.js';
import { retryLoad } from '../loading.js';

const MESSAGES = {
  connecting: 'Connecting to remote dashboard',
  info: 'Loading server information',
  services: 'Loading services and containers',
};

export function renderLoading() {
  const box = $('#loadState');
  const loading = state.loading;
  box.hidden = !loading;
  if (!loading) {
    box.dataset.key = '';
    return;
  }
  const failed = loading.stage === 'failed';
  const remote = loading.kind === 'remote';
  const message = failed
    ? `Connection failed: ${loading.error || 'no response'}${loading.blocking ? '' : ' — showing the last known data'}`
    : MESSAGES[loading.stage];

  // Rebuild only when the picture changes, so the animations aren't restarted by every refresh render.
  const key = [loading.serverId, loading.name, remote, loading.blocking, failed].join('|');
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    // Blocking panels replace the page and appear at once (an empty page with just the top bar would show for a moment otherwise);
    // the compact strip of a known server fades in only if it takes a moment.
    box.className = ['load-state', loading.blocking ? '' : 'compact', failed ? 'failed' : '', loading.blocking ? 'instant' : ''].join(' ').trim();
    fill(
      box,
      h(
        'div',
        { class: 'load-main' },
        failed ? svg('warn') : h('span', { class: 'load-spinner', 'aria-hidden': 'true' }),
        h(
          'div',
          { class: 'load-text' },
          h('h3', {}, failed ? `Could not reach ${loading.name}` : remote ? `Connecting to ${loading.name}` : `Loading ${loading.name}`),
          h('p', { class: 'load-msg' })
        ),
        failed ? h('button', { type: 'button', class: 'btn sm', onclick: retryLoad }, 'Retry') : null
      ),
      failed ? null : h('div', { class: `load-bar${remote ? ' indeterminate' : ''}`, role: 'progressbar', 'aria-label': 'Loading' }, h('span'))
    );
  }
  $('.load-msg', box).textContent = message;
  const bar = $('.load-bar', box);
  if (bar && loading.progress != null) {
    const pct = Math.round(Math.max(0.08, loading.progress) * 100);
    bar.firstChild.style.width = `${pct}%`;
    bar.setAttribute('aria-valuenow', String(pct));
  }
}

// Small modal replacing prompt()/confirm().

import { $ } from '../dom.js';
import { field } from './common.js';

/**
 * With `label` it asks for text and resolves to the trimmed text; otherwise it resolves to true.
 * Cancel resolves to null.
 */
export function ask({ title, message = '', label = '', value: initial = '', placeholder = '', okLabel = 'OK', danger = false }) {
  const dialog = $('#askDialog');
  const form = $('#askForm');
  const input = field(form, 'value');
  $('#askTitle').textContent = title;
  $('#askMessage').textContent = message;
  $('#askMessage').hidden = !message;
  $('#askField').hidden = !label;
  $('#askLabel').textContent = label;
  input.value = initial;
  input.placeholder = placeholder;
  input.required = Boolean(label);
  const ok = $('#askOk');
  ok.textContent = okLabel;
  ok.classList.toggle('danger-fill', danger);

  return new Promise((resolve) => {
    let result = null;
    form.onsubmit = (e) => {
      e.preventDefault();
      result = label ? input.value.trim() || null : true;
      dialog.close();
    };
    dialog.addEventListener('close', () => resolve(result), { once: true });
    dialog.showModal();
    if (label) {
      input.focus();
      input.select();
    } else ok.focus();
  });
}

// Password prompt used before editing.

import { state } from '../state.js';
import { $ } from '../dom.js';
import { login } from '../api.js';
import { render } from '../view/render.js';
import { field } from './common.js';

/** Resolves to true when logged in. */
export function promptLogin() {
  const dialog = $('#loginDialog');
  const form = $('#loginForm');
  const error = $('#loginError');
  form.reset();
  error.hidden = true;
  return new Promise((resolve) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const msg = await login(field(form, 'password').value);
      if (!msg) return dialog.close();
      error.textContent = msg;
      error.hidden = false;
    };
    dialog.addEventListener(
      'close',
      () => {
        render();
        resolve(state.auth.authenticated);
      },
      { once: true }
    );
    dialog.showModal();
  });
}

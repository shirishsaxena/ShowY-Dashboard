// Password prompt used before editing.

import { state } from "../state.js";
import { $ } from "../dom.js";
import { login } from "../api.js";
import { render } from "../render-interface.js";
import { field } from "./common.js";

let pendingLogin = null;

/** Resolves to true when logged in. */
export function promptLogin() {
  if (pendingLogin) return pendingLogin;
  const dialog = $("#loginDialog");
  const form = $("#loginForm");
  const error = $("#loginError");
  form.reset();
  error.hidden = true;
  const button = form.querySelector('button[type="submit"]');
  pendingLogin = new Promise((resolve) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (button.disabled) return;
      button.disabled = true;
      try {
        const msg = await login(field(form, "password").value);
        if (!msg) return dialog.close();
        error.textContent = msg;
        error.hidden = false;
      } catch {
        error.textContent = "Unable to connect. Please try again.";
        error.hidden = false;
      } finally {
        button.disabled = false;
      }
    };
    dialog.addEventListener(
      "close",
      () => {
        render();
        resolve(state.auth.authenticated);
      },
      { once: true },
    );
    dialog.showModal();
  }).finally(() => {
    pendingLogin = null;
  });
  return pendingLogin;
}

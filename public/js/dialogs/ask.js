// Small modal replacing prompt()/confirm().

import { $ } from "../dom.js";
import { field } from "./common.js";

/**
 * With `label` it asks for text and resolves to the trimmed text; otherwise it resolves to true.
 * Cancel resolves to null.
 */
export function ask({
  title,
  message = "",
  label = "",
  value: initial = "",
  placeholder = "",
  okLabel = "OK",
  danger = false,
}) {
  const dialog = $("#askDialog");
  const opener = document.activeElement;
  const form = $("#askForm");
  const input = field(form, "value");
  $("#askTitle").textContent = title;
  $("#askMessage").textContent = message;
  $("#askMessage").hidden = !message;
  $("#askField").hidden = !label;
  $("#askLabel").textContent = label;
  input.value = initial;
  input.placeholder = placeholder;
  input.required = Boolean(label);
  const ok = $("#askOk");
  ok.textContent = okLabel;
  ok.classList.toggle("danger-fill", danger);

  return new Promise((resolve) => {
    let result = null;
    form.onsubmit = (e) => {
      e.preventDefault();
      result = label ? input.value.trim() || null : true;
      dialog.close();
    };
    dialog.addEventListener(
      "close",
      () => {
        resolve(result);
        // Callers may disable the opener while awaiting this prompt. Give their
        // cleanup a chance to re-enable it before restoring keyboard focus.
        requestAnimationFrame(() => {
          if (!opener?.isConnected || opener.disabled || dialog.open) return;
          const active = document.activeElement;
          const parent = opener.closest("dialog");
          if (parent && !parent.open) return;
          if (document.querySelector("dialog:modal") !== parent) return;
          if (active === document.body || dialog.contains(active))
            opener.focus({ preventScroll: true });
        });
      },
      { once: true },
    );
    dialog.showModal();
    if (label) {
      input.focus();
      input.select();
    } else if (danger) $("#askCancel").focus();
    else ok.focus();
  });
}

// Shared dialog bits: form field helpers and close-on-backdrop for every <dialog>.

export const field = (form, name) => form.elements.namedItem(name);
export const value = (form, name) => field(form, name).value.trim();

/** Share the settings/login disabled-button pattern across edit dialogs. */
export async function pendingForm(form, action) {
  if (form.dataset.saving) return;
  form.dataset.saving = "true";
  const buttons = [...form.querySelectorAll('button[type="submit"], button.danger')];
  const disabled = buttons.map((button) => button.disabled);
  buttons.forEach((button) => (button.disabled = true));
  try {
    return await action();
  } finally {
    delete form.dataset.saving;
    buttons.forEach((button, i) => (button.disabled = disabled[i]));
  }
}

export function initDialogs() {
  for (const dialog of document.querySelectorAll("dialog")) {
    // Close on backdrop click - but not when a text selection drag merely ends outside the dialog.
    let pressedBackdrop = false;
    dialog.addEventListener(
      "pointerdown",
      (e) => (pressedBackdrop = e.target === dialog),
    );
    dialog.addEventListener("click", (e) => {
      if (
        (e.target === dialog && pressedBackdrop) ||
        e.target.closest("[data-close]")
      )
        dialog.close();
    });
  }
}

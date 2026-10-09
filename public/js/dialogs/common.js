// Shared dialog bits: form field helpers and close-on-backdrop for every <dialog>.

export const field = (form, name) => form.elements.namedItem(name);
export const value = (form, name) => field(form, name).value.trim();

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

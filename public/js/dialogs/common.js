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

/** Keep editor sections mounted so switching tabs never discards draft values. */
export function initEditorTabs(form) {
  const tablist = form.querySelector('[role="tablist"]');
  if (!tablist) return;
  const tabs = [...tablist.querySelectorAll('[role="tab"]')];
  const panels = [...form.querySelectorAll('[role="tabpanel"]')];
  const body = form.querySelector(".dialog-body");
  const feedback = form.querySelector(".editor-feedback");
  const reviewed = new Set();
  const errors = new Map();
  const names = tabs.map((tab) => tab.textContent.trim());
  const badges = tabs.map((tab) => {
    const badge = document.createElement("span");
    badge.className = "tab-error-badge";
    badge.textContent = "!";
    badge.hidden = true;
    badge.setAttribute("aria-hidden", "true");
    tab.append(badge);
    return badge;
  });
  let errorId = 0;
  function clearError(control, error) {
    control.removeAttribute("aria-invalid");
    const describedBy = (control.getAttribute("aria-describedby") || "")
      .split(/\s+/).filter((id) => id && id !== error.id).join(" ");
    if (describedBy) control.setAttribute("aria-describedby", describedBy);
    else control.removeAttribute("aria-describedby");
    error.remove();
    errors.delete(control);
  }
  function refreshErrors() {
    const invalid = [...form.elements].filter((control) =>
      control.willValidate && !control.validity.valid &&
      reviewed.has(control.closest('[role="tabpanel"]')));
    for (const [control, error] of errors)
      if (!invalid.includes(control)) clearError(control, error);
    for (const control of invalid) {
      let error = errors.get(control);
      if (!error) {
        error = document.createElement("small");
        error.id = `${form.id}-error-${++errorId}`;
        error.className = "field-error";
        control.insertAdjacentElement("afterend", error);
        errors.set(control, error);
        control.setAttribute("aria-describedby",
          [control.getAttribute("aria-describedby"), error.id].filter(Boolean).join(" "));
      }
      control.setAttribute("aria-invalid", "true");
      error.textContent = control.validationMessage || "Please complete this field.";
    }
    const sections = [];
    tabs.forEach((tab, index) => {
      const count = invalid.filter((control) =>
        control.closest('[role="tabpanel"]')?.id === tab.getAttribute("aria-controls")).length;
      tab.dataset.hasErrors = String(count > 0);
      badges[index].hidden = !count;
      if (count) {
        tab.setAttribute("aria-label", `${names[index]} — ${count} ${count === 1 ? "error" : "errors"}`);
        sections.push(names[index]);
      } else tab.removeAttribute("aria-label");
    });
    feedback.hidden = !invalid.length;
    feedback.textContent = invalid.length
      ? `Check ${invalid.length} ${invalid.length === 1 ? "field" : "fields"} in ${sections.join(" and ")} before saving.` : "";
    return invalid;
  }
  function select(tab, focus = false) {
    const id = tab.getAttribute("aria-controls");
    for (const item of tabs) {
      item.setAttribute("aria-selected", String(item === tab));
      item.tabIndex = item === tab ? 0 : -1;
    }
    for (const panel of panels) panel.hidden = panel.id !== id;
    body.scrollTop = 0;
    if (focus) tab.focus();
  }
  function navigate(tab, focus = false) {
    const current = panels.find((panel) => !panel.hidden);
    if (current && current.id !== tab.getAttribute("aria-controls")) {
      reviewed.add(current);
      refreshErrors();
    }
    select(tab, focus);
  }
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => navigate(tab));
    tab.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      navigate(tabs[next], true);
    });
  }
  form.addEventListener("reset", () => {
    reviewed.clear();
    refreshErrors();
    select(tabs[0]);
  });
  // Run after field-specific handlers update custom validity or rebuild URL rows.
  for (const event of ["input", "change", "click"])
    form.addEventListener(event, () => queueMicrotask(refreshErrors));
  // Native submission cannot focus invalid controls in a hidden panel. Reveal
  // the first invalid control before showing its native validation message.
  form.noValidate = true;
  form.addEventListener("submit", (event) => {
    panels.forEach((panel) => reviewed.add(panel));
    const invalid = refreshErrors()[0];
    if (!invalid) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const panel = invalid.closest('[role="tabpanel"]');
    const tab = tabs.find((item) => item.getAttribute("aria-controls") === panel?.id);
    if (tab) select(tab);
    invalid.focus();
    invalid.reportValidity();
  }, true);
  select(tabs[0]);
}

export function initDialogs() {
  for (const dialog of document.querySelectorAll("dialog")) {
    const form = dialog.querySelector("form");
    if (form) initEditorTabs(form);
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

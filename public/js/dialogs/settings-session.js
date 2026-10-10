// Settings-only request ownership. A closed/reopened dialog cannot inherit an
// old load, confirmation, save response, or control unlock.
import { editApi } from "../edit-api.js";
import { toast } from "../dom.js";

let generation = 0;
let active = false;
const pending = new Map();
const versions = new Map();
const ready = new Map();

export function endSettingsSession() {
  active = false;
  generation++;
  for (const operation of pending.values()) {
    operation.release();
    operation.controller.abort();
  }
  pending.clear();
  ready.clear();
}

export function beginSettingsSession() {
  endSettingsSession();
  active = true;
}

/** Storage rows are rebuilt by a separate read; enroll their buttons in the owner lock. */
export function protectSettingsControl(key, control) {
  const operation = pending.get(key);
  if (operation) operation.protect(control);
  else if (ready.get(key) === false) control.disabled = true;
  return control;
}

/** Lock a settings resource before any prompt/await; release before applying data. */
export async function settingsOperation(key, selectors, work, { loading = false, replace = false } = {}) {
  if (!active) return null;
  if (!loading && ready.get(key) === false) return null;
  if (pending.has(key)) {
    if (!replace) return null;
    pending.get(key).release();
    pending.get(key).controller.abort();
  }
  const session = generation;
  if (loading) ready.set(key, false);
  const version = (versions.get(key) || 0) + 1;
  versions.set(key, version);
  const controller = new AbortController();
  const controls = selectors.flatMap((selector) =>
    typeof selector === "string" ? [...document.querySelectorAll(selector)] : [selector],
  ).map((control) => [control, control.disabled]);
  const focused = controls.some(([control]) => control === document.activeElement)
    ? document.activeElement : null;
  let released = false;
  const release = (disabledOverride, restoreFocus = false) => {
    if (released) return;
    released = true;
    for (const [control, disabled] of controls)
      control.disabled = disabledOverride ?? disabled;
    // Disabling an input can move focus to the dialog/body. Do not steal it
    // from a different control, or restore it when ending an old session.
    if (restoreFocus && focused?.isConnected && !focused.disabled &&
        (!document.activeElement || document.activeElement === document.body ||
         document.activeElement.id === "settingsDialog")) focused.focus();
  };
  const current = () => active && session === generation && versions.get(key) === version;
  const scope = {
    current,
    release: (disabledOverride) => {
      if (!current()) return;
      if (loading) ready.set(key, true);
      release(disabledOverride, true);
    },
    signal: controller.signal,
  };
  pending.set(key, {
    controller, release,
    protect: (control) => {
      if (released) return;
      controls.push([control, control.disabled]);
      control.disabled = true;
    },
  });
  for (const [control] of controls) control.disabled = true;
  try {
    return await work(scope);
  } catch (err) {
    if (current()) toast(err.message || "Dashboard server unreachable", true);
    return null;
  } finally {
    if (current()) {
      release(loading ? true : undefined, true);
      pending.delete(key);
    }
  }
}

/** All Settings endpoints, including the binary log download, share edit recovery. */
export async function settingsRequest(scope, method, url, body, responseType = "json") {
  const result = await editApi(method, url, body, { ...scope, responseType });
  if (!result || !scope.current()) return null;
  if (!result.res.ok) throw new Error(result.data.error || `Failed (${result.res.status})`);
  return result.data;
}

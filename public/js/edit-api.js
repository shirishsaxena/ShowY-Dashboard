// Requests that may prompt for editing access, without coupling the base API to dialogs.

import { api } from "./api.js";
import { state } from "./state.js";
import { promptLogin } from "./dialogs/login.js";

/** Retry after authentication; null means cancelled access or an obsolete caller. */
export async function editApi(method, url, body, options = {}) {
  const { signal, current = () => true, responseType = "json" } = options;
  for (;;) {
    if (signal?.aborted || !current()) return null;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, options.timeout ?? (state.tunables?.loadTimeout || 75) * 1000);
    let result;
    try {
      result = await api(method, url, body, controller.signal, responseType);
    } catch (err) {
      if (signal?.aborted || !current()) return null;
      if (controller.signal.aborted) throw new Error("Request timed out. Try again.");
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    if (signal?.aborted || !current()) return null;
    if (result.res.status !== 401) return result;
    state.auth.authenticated = false;
    if (!(await promptLogin())) return null;
  }
}

// Requests that may prompt for editing access, without coupling the base API to dialogs.

import { api } from "./api.js";
import { state } from "./state.js";
import { promptLogin } from "./dialogs/login.js";

/** Retry after authentication; null means the user cancelled the password prompt. */
export async function editApi(method, url, body) {
  for (;;) {
    const result = await api(method, url, body);
    if (result.res.status !== 401) return result;
    state.auth.authenticated = false;
    if (!(await promptLogin())) return null;
  }
}

// Icon preview + suggestions from dashboard-icons (used by the service and server editors).

import { h, fill, iconNode, iconSlugUrl, ICON_INDEX_URL } from "../dom.js";
import { debounce } from "../utils.js";
import { field } from "./common.js";

let iconIndex = null;

/** All dashboard-icons names, fetched once from jsDelivr. */
function loadIconIndex() {
  iconIndex ??= fetch(ICON_INDEX_URL)
    .then((r) =>
      r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
    )
    .then((tree) => (tree.png || []).map((file) => file.replace(/\.png$/, "")))
    .catch(() => {
      iconIndex = null; // retry next time
      return [];
    });
  return iconIndex;
}

function rankIcons(slugs, query, limit = 12) {
  const q = query.toLowerCase().trim().replace(/\s+/g, "-");
  const flatQ = q.replace(/[^a-z0-9]/g, "");
  if (flatQ.length < 2) return [];
  const scored = [];
  for (const slug of slugs) {
    const flat = slug.replace(/-/g, "");
    let score =
      slug === q || flat === flatQ
        ? 0
        : slug.startsWith(q) || flat.startsWith(flatQ)
          ? 1
          : flat.includes(flatQ)
            ? 2
            : -1;
    if (score < 0) continue;
    if (/-(light|dark)$/.test(slug)) score += 0.5; // prefer the default variant
    scored.push([score, slug]);
  }
  scored.sort(
    (a, b) =>
      a[0] - b[0] || a[1].length - b[1].length || a[1].localeCompare(b[1]),
  );
  return scored.slice(0, limit).map(([, slug]) => slug);
}

/**
 * Live preview + clickable suggestions for a form with "icon" and "name" inputs.
 * Suggestions use the icon text (when it looks like a name) or else the service/server name.
 */
export function iconPicker(form, preview, list) {
  const iconInput = field(form, "icon");
  const nameInput = field(form, "name");
  let seq = 0;

  const suggest = debounce(async () => {
    const raw = iconInput.value.trim();
    const query = !raw
      ? nameInput.value
      : /^[a-z0-9 -]+$/i.test(raw)
        ? raw
        : "";
    const run = ++seq;
    const matches = query ? rankIcons(await loadIconIndex(), query) : [];
    if (run !== seq) return; // a newer keystroke won
    fill(
      list,
      matches.map((slug) =>
        h(
          "button",
          {
            type: "button",
            class: "icon-option",
            title: slug,
            "aria-label": `Use the ${slug} icon`,
            "aria-pressed": String(slug === raw),
            onclick: () => {
              iconInput.value = slug;
              update();
            },
          },
          h("img", {
            src: iconSlugUrl(slug),
            alt: "",
            loading: "lazy",
            referrerpolicy: "no-referrer",
          }),
        ),
      ),
    );
    list.hidden = !matches.length;
  }, 150);

  function update() {
    preview.replaceChildren(iconNode(iconInput.value, nameInput.value || "?"));
    suggest();
  }
  iconInput.addEventListener("input", update);
  nameInput.addEventListener("input", update);

  return {
    /** Call after filling the form. */
    reset() {
      list.hidden = true;
      list.replaceChildren();
      update();
    },
  };
}

// One shared popover survives card replacement during background refreshes.
import { $, h, fill, svg, toast } from "../dom.js";
import { openContainerLogs } from "../dialogs/docker-logs.js";

let opener = null;
let rebuild = null;

function currentOpener() {
  if (opener?.isConnected) return opener;
  return [...document.querySelectorAll("[data-card-menu-key]")].find(
    (button) => button.dataset.cardMenuKey === opener?.dataset.cardMenuKey,
  );
}

function closeMenu(restoreFocus = false) {
  const menu = $("#cardMenu");
  if (menu.matches(":popover-open")) menu.hidePopover();
  opener?.setAttribute("aria-expanded", "false");
  if (restoreFocus) currentOpener()?.focus();
}

export function containerLogItem(container) {
  const available = /^[a-f0-9]{64}$/.test(container?.id || "");
  return {
    label: "Show logs",
    icon: "logs",
    disabled: !available,
    hint: available ? "" : "Container unavailable — refresh the dashboard",
    run: () => openContainerLogs(container),
  };
}

export function cardMenuButton(name, key, items) {
  return h(
    "button",
    {
      type: "button",
      class: "icon-btn card-menu-btn",
      title: `Actions for ${name}`,
      "aria-label": `Actions for ${name}`,
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      "aria-controls": "cardMenu",
      "data-card-menu-key": key,
      onclick: (event) => {
        event.preventDefault();
        event.stopPropagation();
        const button = event.currentTarget;
        const menu = $("#cardMenu");
        const same =
          menu.matches(":popover-open") && currentOpener() === button;
        closeMenu();
        if (same) return;
        opener = button;
        menu.setAttribute("aria-label", `Actions for ${name}`);
        rebuild = () =>
          fill(
            menu,
            (typeof items === "function" ? items() : items).map((item) =>
              h(
                "button",
                {
                  type: "button",
                  class: `card-menu-item${item.danger ? " danger" : ""}`,
                  role: "menuitem",
                  tabindex: "-1",
                  disabled: item.disabled,
                  title: item.hint || null,
                  onclick: async () => {
                    closeMenu(true);
                    try {
                      await item.run();
                    } catch (err) {
                      toast(err.message || "Action unavailable", true);
                    }
                  },
                },
                svg(item.icon),
                h(
                  "span",
                  {},
                  item.label,
                  item.hint ? h("small", {}, item.hint) : null,
                ),
              ),
            ),
          );
        rebuild();
        menu.showPopover();
        button.setAttribute("aria-expanded", "true");
        const rect = button.getBoundingClientRect();
        const top = rect.bottom + 6;
        menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(top, innerHeight - menu.offsetHeight - 8))}px`;
        menu.querySelector("button:not(:disabled)")?.focus();
      },
    },
    svg("more"),
  );
}

export function initCardMenu() {
  const menu = $("#cardMenu");
  menu.addEventListener("toggle", () => {
    if (!menu.matches(":popover-open"))
      opener?.setAttribute("aria-expanded", "false");
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape" || event.key === "Tab") {
      closeMenu(true);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    const buttons = [...menu.querySelectorAll("button:not(:disabled)")];
    const index = buttons.indexOf(document.activeElement);
    const next =
      event.key === "ArrowDown"
        ? (index + 1) % buttons.length
        : event.key === "ArrowUp"
          ? (index - 1 + buttons.length) % buttons.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    buttons[next]?.focus();
  });
  window.addEventListener("resize", () => closeMenu());
  document.addEventListener(
    "scroll",
    (event) => {
      if (!menu.contains(event.target)) closeMenu();
    },
    true,
  );
  document.addEventListener("docker-control-changed", () => {
    if (!menu.matches(":popover-open")) return;
    const focused = menu.contains(document.activeElement);
    rebuild?.();
    if (focused) menu.querySelector("button:not(:disabled)")?.focus();
  });
}

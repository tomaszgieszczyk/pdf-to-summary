import "./navigation.css";

type Module = { name: string; path: string } | { name: string; path: null };

export const modules: readonly Module[] = [
  { name: "Documents", path: "/documents/" },
  { name: "Reports", path: "/reports/" },
  { name: "Access Control", path: null },
  { name: "AI Chat", path: null },
  { name: "Configuration", path: null },
];

// Both React applications use this DOM-only navigation and keep independent builds.
export function mountNavigation(host: HTMLElement | null) {
  if (!host) return;
  const menu = document.createElement("details");
  menu.className = "workspace-modules";
  const trigger = document.createElement("summary");
  trigger.textContent = "Modules";
  menu.append(trigger);
  const nav = document.createElement("nav");
  nav.setAttribute("aria-label", "Workspace modules");
  for (const module of modules) {
    if (module.path) {
      const link = document.createElement("a");
      link.href = module.path;
      link.textContent = module.name;
      if (location.pathname.startsWith(module.path))
        link.setAttribute("aria-current", "page");
      nav.append(link);
    } else {
      const row = document.createElement("span");
      row.className = "module-unavailable";
      row.textContent = module.name;
      const status = document.createElement("small");
      status.textContent = "Unavailable in demo";
      row.append(status);
      nav.append(row);
    }
  }
  menu.append(nav);
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      menu.open = false;
      trigger.focus();
    }
  });
  menu.addEventListener("focusout", (event) => {
    if (!menu.contains(event.relatedTarget as Node | null)) menu.open = false;
  });
  host.replaceChildren(menu);
}

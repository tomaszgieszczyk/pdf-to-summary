export const modules = [
  { name: "Documents", path: "/documents/" },
  { name: "Reports", path: "/reports/" },
  { name: "Access Control", path: null },
  { name: "AI Chat", path: null },
  { name: "Configuration", path: null },
];

export function mountNavigation(nav) {
  for (const module of modules) {
    if (module.path) {
      const link = document.createElement("a");
      link.href = module.path;
      link.textContent = module.name;
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
}

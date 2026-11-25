import { modules, mountNavigation } from "./navigation.js";
const nav = document.querySelector("nav");
const content = document.querySelector("main");
const panels = new Map();
mountNavigation(nav);

function showModule() {
  const active = modules.find((module) => module.path === location.pathname);
  if (!active) return;
  for (const link of nav.querySelectorAll("a")) {
    if (link.pathname === active.path)
      link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  for (const [path, frame] of panels) frame.hidden = path !== active.path;
  if (!panels.has(active.path)) {
    const frame = document.createElement("iframe");
    frame.title = active.name;
    frame.src = active.path + "index.html";
    panels.set(active.path, frame);
    content.append(frame);
  }
  document.title = active.name + " · PDF to Summary";
}
nav.addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (
    !link ||
    event.button !== 0 ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  if (link.pathname === location.pathname) return;
  history.pushState(null, "", link.href);
  showModule();
});
window.addEventListener("message", (event) => {
  const frame = panels.get("/documents/");
  if (
    !frame ||
    event.origin !== location.origin ||
    event.source !== frame.contentWindow ||
    event.data?.type !== "document-drawer"
  )
    return;
  frame.classList.toggle("document-open", event.data.open === true);
});
window.addEventListener("popstate", showModule);
showModule();

import { expect, test } from "vitest";
import { mountNavigation } from "../../shared/modules";
import {
  readLanguage,
  saveLanguage,
  subscribeLanguage,
} from "../../shared/preferences";

test("the demo exposes links only for available modules", () => {
  const host = document.createElement("div");
  mountNavigation(host);
  expect(
    Array.from(host.querySelectorAll("a"), (link) => link.pathname),
  ).toEqual(["/documents/", "/reports/"]);
  expect(
    Array.from(
      host.querySelectorAll(".module-unavailable"),
      (row) => row.firstChild?.textContent,
    ),
  ).toEqual(["Access Control", "AI Chat", "Configuration"]);
});

test("both local and cross-tab changes update the shared language preference", () => {
  const changes: string[] = [];
  const stop = subscribeLanguage(() => changes.push(readLanguage()));
  try {
    saveLanguage("pl");
    const key = "pdf-to-summary.preferences.summary-language";
    localStorage.setItem(key, "es");
    window.dispatchEvent(new StorageEvent("storage", { key }));
    expect(changes).toEqual(["pl", "es"]);
  } finally {
    stop();
    localStorage.removeItem("pdf-to-summary.preferences.summary-language");
  }
});

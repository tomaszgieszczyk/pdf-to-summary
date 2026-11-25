const languageKey = "pdf-to-summary.preferences.summary-language";
const changeEvent = "pdf-to-summary:language-changed";
let fallbackLanguage = "en";

export function readLanguage(): string {
  try {
    return localStorage.getItem(languageKey) || "en";
  } catch {
    return fallbackLanguage;
  }
}

export function saveLanguage(language: string) {
  fallbackLanguage = language;
  try {
    localStorage.setItem(languageKey, language);
  } catch {
    // Keep the current page usable when the browser disables storage.
  }
  window.dispatchEvent(new Event(changeEvent));
}

export function subscribeLanguage(notify: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === languageKey || event.key === null) notify();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(changeEvent, notify);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(changeEvent, notify);
  };
}

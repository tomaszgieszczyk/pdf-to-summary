import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import {
  readLanguage,
  saveLanguage,
  subscribeLanguage,
} from "../../shared/preferences";
import "./style.css";
import { mountNavigation } from "../../shared/modules";

function Reports() {
  const language = useSyncExternalStore(subscribeLanguage, readLanguage);
  const [languages, setLanguages] = useState<Record<string, string>>({});
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      const options = { signal: controller.signal };
      const [list, health] = await Promise.all([
        fetch("/api/documents?limit=1", options),
        fetch("/api/health", options),
      ]);
      if (!list.ok || !health.ok)
        throw new Error("Could not load the workspace report.");
      const [documents, settings] = await Promise.all([
        list.json(),
        health.json(),
      ]);
      setTotal(documents.total);
      setLanguages(settings.summary_languages);
    }
    load().catch((err) => {
      if (!controller.signal.aborted) setError(err.message);
    });
    return () => controller.abort();
  }, []);
  return (
    <>
      <header>
        <div ref={mountNavigation} />
      </header>
      <main>
        <h1>Reports</h1>
        {error && <p role="alert">{error}</p>}
        <section>
          <h2>Documents in your library</h2>
          <strong>{total ?? "…"}</strong>
        </section>
        <label>
          Default summary language
          <select
            value={language}
            disabled={!Object.keys(languages).length}
            onChange={(e) => saveLanguage(e.target.value)}
          >
            {Object.entries(languages).map(([code, name]) => (
              <option value={code} key={code}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </main>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Reports />);

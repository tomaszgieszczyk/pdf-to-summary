import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import {
  readLanguage,
  saveLanguage,
  subscribeLanguage,
} from "../../shared/preferences";
import "./style.css";
import { mountNavigation } from "../../shared/modules";

import { observe } from "../../shared/events";

function Reports() {
  const language = useSyncExternalStore(subscribeLanguage, readLanguage);
  const [languages, setLanguages] = useState<Record<string, string>>({});
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const onFailure = (err: unknown) => setError((err as Error).message);
    const stopCount = observe(
      async (signal) => {
        const res = await fetch("/api/documents?limit=1", { signal });
        if (!res.ok) throw new Error("Could not load the workspace report.");
        return (await res.json()).total as number;
      },
      (value) => {
        setTotal(value);
        setError("");
      },
      onFailure,
      (event) => event.type !== "updated",
    );
    const stopLanguages = observe(
      async (signal) => {
        const res = await fetch("/api/health", { signal });
        if (!res.ok) throw new Error("Could not load summary languages.");
        return (await res.json()).summary_languages as Record<string, string>;
      },
      setLanguages,
      onFailure,
      (event) => event.type === "sync",
    );
    return () => {
      stopCount();
      stopLanguages();
    };
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

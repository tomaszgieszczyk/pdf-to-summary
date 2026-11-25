import { WorkspaceReport } from "./WorkspaceReport";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import {
  readLanguage,
  saveLanguage,
  subscribeLanguage,
} from "../../shared/preferences";
import "./style.css";

import { observe } from "../../shared/events";

function Reports() {
  const language = useSyncExternalStore(subscribeLanguage, readLanguage);
  const [languages, setLanguages] = useState<Record<string, string>>({});

  const [error, setError] = useState("");
  useEffect(() => {
    const onFailure = (err: unknown) => setError((err as Error).message);
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
      stopLanguages();
    };
  }, []);
  return (
    <>
      <main>
        <h1>Reports</h1>
        {error && <p role="alert">{error}</p>}
        <WorkspaceReport />
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

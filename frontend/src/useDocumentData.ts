import { useEffect, useState } from "react";
import { poll, latestDocument } from "./polling";
import { api } from "./api";
import type { DocItem, Document, Page, Health } from "./types";

export function useDocumentData(refresh: number) {
  const [documents, setDocuments] = useState<DocItem[]>([]);
  const [total, setTotal] = useState(0);
  const [listOffset, setListOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [document, setDocument] = useState<Document | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [pageOffset, setPageOffset] = useState(0);
  const [tab, setTab] = useState<"summary" | "pages">("summary");
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState("");
  const [selectedVersions, setSelectedVersions] = useState<
    Record<string, string>
  >({});
  const selectedVersion = selected ? selectedVersions[selected] || "" : "";
  useEffect(
    () =>
      poll(
        (signal) => api<Health>("/health", signal),
        setHealth,
        (error) => setError((error as Error).message),
        60000,
      ),
    [],
  );

  useEffect(
    () =>
      poll(
        (signal) =>
          api<{ items: DocItem[]; total: number }>(
            `/documents?offset=${listOffset}&limit=20`,
            signal,
          ),
        (list) => {
          setDocuments(list.items);
          setTotal(list.total);
          setSelected((current) => current || list.items[0]?.id || null);
        },
        (error) => setError((error as Error).message),
        2500,
      ),
    [refresh, listOffset],
  );

  useEffect(() => {
    setDocument((current) =>
      current?.id === selected &&
      (!selectedVersion || current.summary_version_id === selectedVersion)
        ? current
        : null,
    );
    if (!selected) return;
    return poll(
      (signal) =>
        api<Document>(
          `/documents/${selected}${selectedVersion ? `?summary_version=${encodeURIComponent(selectedVersion)}` : ""}`,
          signal,
        ),
      (doc) => setDocument((current) => latestDocument(current, doc)),
      (error) => setError((error as Error).message),
      2000,
    );
  }, [selected, selectedVersion, refresh]);

  useEffect(() => {
    setPages([]);
    if (!selected || tab !== "pages") return;
    return poll(
      (signal) =>
        api<{ items: Page[] }>(
          `/documents/${selected}/pages?offset=${pageOffset}&limit=5`,
          signal,
        ),
      (content) => setPages(content.items),
      (error) => setError((error as Error).message),
      2500,
    );
  }, [selected, tab, pageOffset, refresh]);

  return {
    documents,
    total,
    listOffset,
    setListOffset,
    selected,
    setSelected,
    document,
    setDocument,
    pages,
    pageOffset,
    setPageOffset,
    tab,
    setTab,
    health,
    error,
    setError,
    setSelectedVersions,
  };
}

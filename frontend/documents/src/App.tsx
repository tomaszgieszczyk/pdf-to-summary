import { DocumentDrawer } from "./DocumentDrawer";
import { lazy, Suspense } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  readLanguage,
  saveLanguage,
  subscribeLanguage,
} from "../../shared/preferences";
import {
  AlertCircle,
  ArrowDownToLine,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  FolderOpen,
  LoaderCircle,
  Plus,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { Markdown } from "./Markdown";
import { SearchableSelect } from "./SearchableSelect";

import type { Document } from "./types";
import { useDocumentData } from "./useDocumentData";

import { SummaryEditor, type SummaryDraft } from "./SummaryEditor";
const PdfPreview = lazy(() => import("./PdfPreview"));
const stateLabels: Record<string, string> = {
  queued: "Queued",
  preparing: "Preparing",
  processing: "Reading pages",
  summarizing: "Writing summary",
  completed: "Ready",
  partial: "Partial result",
  failed: "Needs attention",
};

function size(bytes: number) {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
function Badge({ state }: { state: string }) {
  return (
    <span className={`badge ${state}`}>
      <span />
      {stateLabels[state] || state}
    </span>
  );
}

export default function App() {
  const [previewPage, setPreviewPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const {
    documents,
    total,
    pageSize,
    setPageSize,
    sort,
    setSort,
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
  } = useDocumentData(refresh);
  const [upload, setUpload] = useState<{
    name: string;
    percent: number;
    index: number;
    total: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  const [parser, setParser] = useState("poppler");
  const summaryLanguage = useSyncExternalStore(subscribeLanguage, readLanguage);
  const [drafts, setDrafts] = useState<Record<string, SummaryDraft>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [regeneration, setRegeneration] = useState<{
    id: string;
    language: string;
    error?: string;
  } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const uploading = useRef(false);
  const retryKeys = useRef(new Map<string, string>());

  useEffect(() => {
    if (!Object.keys(drafts).length) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [drafts]);

  function openDocument(id: string) {
    setPreviewPage(1);
    setPageOffset(0);
    setTab("summary");
    setSelected(id);
  }

  function discardDraft(id: string) {
    setDrafts((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  async function saveSummary(id: string) {
    const versionId = document?.summary_version_id;
    const key = `${id}:${versionId}`;
    const draft = drafts[key];
    if (!draft || !versionId || savingId) return;
    setSavingId(id);
    try {
      const response = await fetch(`/api/documents/${id}/summary`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          markdown: draft.text,
          revision: draft.revision,
          version_id: versionId,
        }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(
          typeof data.detail === "string"
            ? data.detail
            : `Save failed (${response.status}).`,
        );
      }
      const updated: Document = await response.json();
      setDocument((current) =>
        current?.id === id &&
        current.summary_version_id === versionId &&
        current.summary_revision <= updated.summary_revision
          ? updated
          : current,
      );
      discardDraft(key);
      setRefresh((value) => value + 1);
    } catch (error) {
      setDrafts((current) => ({
        ...current,
        [key]: { ...draft, error: (error as Error).message },
      }));
    } finally {
      setSavingId(null);
    }
  }

  async function regenerateSummary() {
    if (
      !regeneration ||
      !document ||
      regeneration.id !== document.id ||
      savingId
    )
      return;
    const id = document.id;
    setSavingId(id);
    try {
      const response = await fetch(`/api/documents/${id}/summary/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language: regeneration.language,
          revision: document.summary_revision,
        }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(
          typeof data.detail === "string"
            ? data.detail
            : `Regeneration failed (${response.status}).`,
        );
      }
      const updated: Document = await response.json();
      setDocument((current) =>
        current?.id === id &&
        current.summary_revision <= updated.summary_revision
          ? updated
          : current,
      );
      setSelectedVersions((current) => ({ ...current, [id]: "" }));
      setRegeneration(null);
      setRefresh((value) => value + 1);
    } catch (error) {
      setRegeneration({ ...regeneration, error: (error as Error).message });
    } finally {
      setSavingId(null);
    }
  }

  async function uploadFiles(files: FileList | File[]) {
    if (uploading.current) return;
    const queue = Array.from(files);
    if (!queue.length) return;
    if (queue.length > 5) {
      setError("Please select up to five PDFs at a time.");
      return;
    }
    if (queue.some((file) => !file.name.toLowerCase().endsWith(".pdf"))) {
      setError("Please select PDF files.");
      return;
    }
    if (health && queue.some((file) => file.size > health.max_upload_bytes)) {
      setError(
        `Each file must be smaller than ${size(health.max_upload_bytes)}.`,
      );
      return;
    }
    uploading.current = true;
    setError("");
    try {
      for (const [index, file] of queue.entries()) {
        // A cloud placeholder can expose a filename and size before its bytes are available.
        try {
          await file.slice(0, 1).arrayBuffer();
        } catch {
          throw new Error(
            `Cannot read "${file.name}" on this device. For a OneDrive file, choose “Always keep on this device”, wait for the download, then select it again.`,
          );
        }
        setUpload({
          name: file.name,
          percent: 0,
          index: index + 1,
          total: queue.length,
        });
        const fingerprint = `${file.name}:${file.size}:${file.lastModified}:${summaryLanguage}:${parser}`;
        const key = retryKeys.current.get(fingerprint) || crypto.randomUUID();
        retryKeys.current.set(fingerprint, key);
        const result = await new Promise<{ id: string }>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open(
            "POST",
            `/api/documents?filename=${encodeURIComponent(file.name)}&summary_language=${encodeURIComponent(summaryLanguage)}&parser=${parser}`,
          );
          xhr.setRequestHeader("Content-Type", "application/pdf");
          xhr.setRequestHeader("Idempotency-Key", key);
          xhr.timeout = 3600000;
          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable)
              setUpload({
                name: file.name,
                percent: Math.round((event.loaded / event.total) * 100),
                index: index + 1,
                total: queue.length,
              });
          };
          xhr.onload = () => {
            let data: { id?: string; detail?: string };
            try {
              data = JSON.parse(xhr.responseText);
            } catch {
              reject(new Error(`Upload failed (${xhr.status}).`));
              return;
            }
            if (xhr.status === 202 && data.id) resolve({ id: data.id });
            else
              reject(
                new Error(data.detail || `Upload failed (${xhr.status}).`),
              );
          };
          xhr.onerror = () =>
            reject(
              new Error(
                "Upload interrupted. Select the same file to retry safely.",
              ),
            );
          xhr.ontimeout = () =>
            reject(
              new Error("Upload timed out. Select the same file to retry."),
            );
          xhr.send(file);
        });
        retryKeys.current.delete(fingerprint);
        openDocument(result.id);
        setPageOffset(0);
        setListOffset(0);
        setRefresh((x) => x + 1);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      uploading.current = false;
      setUpload(null);
      if (input.current) input.current.value = "";
    }
  }

  function downloadSummary() {
    if (!document?.summary) return;
    const warnings = document.warnings.map((text) => `> ${text}`).join("\n\n");
    const blob = new Blob(
      [`# ${document.filename}\n\n${warnings}\n\n${document.summary}`],
      { type: "text/markdown;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    link.href = url;
    link.download = `${document.filename.replace(/\.pdf$/i, "")}-${document.summary_language}-${document.summary_model || "legacy"}-${document.summary_version_id}-summary.md`;
    link.click();
    URL.revokeObjectURL(url);
  }
  const pageCount = document?.page_count || 0;
  const draftKey = document
    ? `${document.id}:${document.summary_version_id}`
    : "";
  const draft = drafts[draftKey];
  const languageOptions = Object.entries(
    health?.summary_languages || {
      en: "English",
      pl: "Polish",
      auto: "Document language",
    },
  ).map(([value, label]) => {
    let search = "";
    try {
      search =
        new Intl.DisplayNames(["pl"], { type: "language" }).of(value) || "";
    } catch {
      /* non-BCP47 provider codes */
    }
    return { value, label, search };
  });
  const progress =
    document && pageCount
      ? Math.min(
          100,
          Math.round((document.progress.summarized_pages / pageCount) * 100),
        )
      : 0;

  return (
    <div className="documents-panel">
      <input
        ref={input}
        className="visually-hidden"
        type="file"
        multiple
        accept=".pdf,application/pdf"
        onChange={(event) =>
          event.target.files && void uploadFiles(event.target.files)
        }
        aria-label="Select PDF files"
      />
      <main>
        <div className="page-heading">
          <h1>Documents</h1>
        </div>
        {error && (
          <div role="alert" className="notice error">
            <AlertCircle size={18} />
            <span>{error}</span>
            <button onClick={() => setError("")} aria-label="Dismiss error">
              <X size={17} />
            </button>
          </div>
        )}
        {health && !health.provider_configured && (
          <div className="notice warning">
            <AlertCircle size={18} />
            <span>
              Document analysis is not connected yet. Configure the Gemini API
              key in the service environment to enable it.
            </span>
          </div>
        )}
        <section
          className={`upload-zone ${dragging ? "dragging" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void uploadFiles(event.dataTransfer.files);
          }}
        >
          <div className="upload-heading">
            <div className="upload-icon">
              {upload ? (
                <LoaderCircle size={24} className="spin" />
              ) : (
                <Upload size={24} />
              )}
            </div>
            <div className="upload-copy">
              <h2>
                {upload
                  ? `Uploading ${upload.index} of ${upload.total}`
                  : "Upload PDFs"}
              </h2>
              <p>
                {upload
                  ? upload.name
                  : `Drop files here or choose up to 5 PDFs, ${health ? size(health.max_upload_bytes) : "1 GB"} per file.`}
              </p>
              {upload && (
                <progress
                  max={100}
                  value={upload.percent}
                  aria-label="Upload progress"
                />
              )}
            </div>
            <button
              className="primary choose-pdf"
              disabled={!!upload}
              onClick={() => input.current?.click()}
            >
              {upload ? `${upload.percent}%` : "Choose files"}
              {!upload && <Plus size={16} />}
            </button>
          </div>
          <div className="upload-settings">
            <div>
              {" "}
              <SearchableSelect
                label="PDF parser"
                value={parser}
                options={[
                  { value: "poppler", label: "Poppler — embedded text" },
                  { value: "gemini", label: "Gemini — text and images" },
                ]}
                disabled={!!upload}
                onChange={setParser}
              />
              <p className="muted">
                Use Poppler for text and Gemini for scanned pages.
              </p>
            </div>
            <div>
              {" "}
              <SearchableSelect
                label="Summary language"
                value={summaryLanguage}
                options={languageOptions}
                disabled={!!upload}
                onChange={saveLanguage}
              />
              <p className="language-hint">
                Applies to summaries of all selected files.
              </p>
            </div>
          </div>
        </section>
        <details className="workspace-library" open>
          <summary>Your library ({total})</summary>
          <div
            className="library-sort"
            role="group"
            aria-label="Sort documents"
          >
            <span>Sort by</span>
            {Object.entries({
              created_at: "Created",
              last_regenerated_at: "Last regenerated",
              status: "Status",
            }).map(([field, label]) => (
              <button
                key={field}
                aria-pressed={sort.field === field}
                aria-label={
                  sort.field === field
                    ? `${label}, ${sort.order === "asc" ? "ascending" : "descending"}`
                    : label
                }
                onClick={() => {
                  setSort({
                    field,
                    order:
                      sort.field === field
                        ? sort.order === "asc"
                          ? "desc"
                          : "asc"
                        : field === "status"
                          ? "asc"
                          : "desc",
                  });
                  setListOffset(0);
                }}
              >
                {label}{" "}
                {sort.field === field && (sort.order === "asc" ? "↑" : "↓")}
              </button>
            ))}
          </div>
          <nav className="document-list" aria-label="Documents">
            {documents.map((doc) => (
              <button
                key={doc.id}
                aria-haspopup="dialog"
                className={`document-link ${doc.id === selected ? "selected" : ""}`}
                onClick={() => {
                  openDocument(doc.id);
                }}
              >
                <FileText size={19} />
                <span>
                  <strong>{doc.filename}</strong>
                  <small>
                    {doc.page_count ? `${doc.page_count} pages · ` : ""}
                    {stateLabels[doc.state] || doc.state}
                    {sort.field === "created_at" &&
                      Number(doc.created_at) > 0 &&
                      ` · Created ${new Date(Number(doc.created_at) * 1000).toLocaleDateString()}`}
                    {sort.field === "last_regenerated_at" &&
                      (doc.last_regenerated_at
                        ? ` · Regenerated ${new Date(doc.last_regenerated_at * 1000).toLocaleString()}`
                        : " · Not regenerated")}
                  </small>
                </span>
                <i className={`document-dot ${doc.state}`} />
              </button>
            ))}
            {!documents.length && (
              <div className="library-empty">
                <FolderOpen size={27} />
                <p>Your documents will appear here.</p>
              </div>
            )}
          </nav>
          <div className="library-pagination">
            <fieldset className="page-size">
              <legend className="visually-hidden">Documents per page</legend>
              <span aria-hidden="true">Per page</span>
              <div className="page-size-options">
                {[5, 10, 20, 50].map((size) => (
                  <label key={size}>
                    <input
                      className="visually-hidden"
                      type="radio"
                      name="library-page-size"
                      value={size}
                      checked={size === pageSize}
                      onChange={() => {
                        setPageSize(size);
                        setListOffset(0);
                      }}
                    />
                    <span>{size}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <span aria-live="polite">
              {total ? listOffset + 1 : 0}–
              {Math.min(listOffset + pageSize, total)} of {total}
            </span>
            <button
              className="secondary"
              aria-label="Previous documents"
              disabled={listOffset === 0}
              onClick={() => setListOffset((x) => Math.max(0, x - pageSize))}
            >
              <ChevronLeft size={16} />
            </button>
            <button
              className="secondary"
              aria-label="Next documents"
              disabled={listOffset + pageSize >= total}
              onClick={() => setListOffset((x) => x + pageSize)}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </details>
        {!selected && total === 0 && (
          <section className="welcome">
            <div className="welcome-illustration">
              <div className="paper back" />
              <div className="paper front">
                <span />
                <span />
                <span />
                <span />
                <div>
                  <Sparkles size={24} />
                </div>
              </div>
            </div>
            <h2>A little clarity goes a long way.</h2>
            <p>
              Add a report, research paper, or scanned document.
              <br />
              We’ll help you find what matters, one section at a time.
            </p>
            <div className="welcome-features">
              <span>
                <Check size={15} /> Text & scanned PDFs
              </span>
              <span>
                <Check size={15} /> Page references
              </span>
              <span>
                <Check size={15} /> Clear coverage
              </span>
            </div>
          </section>
        )}
        {selected && (
          <DocumentDrawer
            filename={
              document?.id === selected
                ? document.filename
                : documents.find((row) => row.id === selected)?.filename ||
                  "Document"
            }
            onDismiss={() => setSelected(null)}
          >
            {document?.id !== selected ? (
              <p role="status">{error || "Loading document…"}</p>
            ) : (
              <section className="reader">
                <div className="document-metadata">
                  <span>
                    {size(document.size_bytes)} ·{" "}
                    {pageCount ? `${pageCount} pages` : "Counting pages"}
                  </span>
                  <Badge state={document.state} />
                </div>
                {!document.terminal && (
                  <div className="processing-strip" aria-live="polite">
                    <LoaderCircle size={16} className="spin" />
                    <div>
                      <strong>{stateLabels[document.state]}</strong>
                      <span>
                        {document.progress.extracted_pages} pages read ·{" "}
                        {document.progress.summarized_pages} pages summarized
                      </span>
                      {document.pending_summary_language && (
                        <span>
                          Generating in{" "}
                          {health?.summary_languages?.[
                            document.pending_summary_language
                          ] || document.pending_summary_language}
                          . Your saved summary remains available below.
                        </span>
                      )}
                    </div>
                    <progress
                      max={100}
                      value={progress}
                      aria-label="Document processing progress"
                    />
                  </div>
                )}
                <div
                  className="reader-tabs"
                  role="tablist"
                  aria-label="Document views"
                >
                  <button
                    role="tab"
                    aria-selected={tab === "summary"}
                    onClick={() => setTab("summary")}
                  >
                    <Sparkles size={16} /> Summary
                  </button>
                  <button
                    role="tab"
                    aria-selected={tab === "pages"}
                    onClick={() => setTab("pages")}
                  >
                    <BookOpen size={16} /> Page content
                  </button>
                  <button
                    role="tab"
                    aria-selected={tab === "pdf"}
                    onClick={() => setTab("pdf")}
                  >
                    <FileText size={16} /> Original PDF
                  </button>
                  <button
                    role="tab"
                    aria-selected={tab === "processing"}
                    onClick={() => setTab("processing")}
                  >
                    Processing
                  </button>
                  <button
                    className="download"
                    disabled={!document.summary || !!draft}
                    onClick={downloadSummary}
                    aria-label="Download summary"
                  >
                    <ArrowDownToLine size={16} /> Export
                  </button>
                </div>
                <div className="reader-body">
                  {tab === "summary" &&
                    document.summary_versions.length > 0 && (
                      <div className="saved-versions">
                        <SearchableSelect
                          label="Saved summary version"
                          value={document.summary_version_id || ""}
                          options={document.summary_versions.map((version) => ({
                            value: version.id,
                            label: `${health?.summary_languages?.[version.language] || "Language not recorded"} · ${version.model || "Model not recorded (legacy)"} · ${version.created_at ? new Date(version.created_at * 1000).toLocaleString() : "Date not recorded"} · ${version.id}${version.edited_at ? " · Edited" : ""}`,
                            search: `${version.language} ${languageOptions.find((option) => option.value === version.language)?.search || ""}`,
                          }))}
                          disabled={!!savingId}
                          onChange={(version) =>
                            setSelectedVersions((current) => ({
                              ...current,
                              [document.id]: version,
                            }))
                          }
                        />
                        <p className="muted">
                          Choose a saved language and model version. Switching
                          versions does not generate new content.
                        </p>
                      </div>
                    )}
                  {tab === "summary" &&
                    document.terminal &&
                    document.progress.extracted_pages > 0 &&
                    !draft && (
                      <div className="regeneration-panel">
                        {regeneration?.id === document.id ? (
                          <>
                            <SearchableSelect
                              label="New summary language"
                              value={regeneration.language}
                              options={languageOptions}
                              disabled={!!savingId}
                              onChange={(language) =>
                                setRegeneration({
                                  ...regeneration,
                                  language,
                                  error: undefined,
                                })
                              }
                            />
                            <p>
                              Generate a new summary from saved page content.
                              This uses Gemini and saves a new version. Existing
                              versions and their edits remain available.
                            </p>
                            <div className="editor-actions">
                              <button
                                className="secondary"
                                disabled={!!savingId}
                                onClick={() => setRegeneration(null)}
                              >
                                Cancel
                              </button>
                              <button
                                className="primary"
                                disabled={!!savingId}
                                onClick={() => void regenerateSummary()}
                              >
                                {savingId
                                  ? "Starting…"
                                  : "Generate new summary"}
                              </button>
                            </div>
                            {regeneration.error && (
                              <div className="notice error" role="alert">
                                {regeneration.error}
                              </div>
                            )}
                          </>
                        ) : (
                          <button
                            className="secondary"
                            disabled={!!savingId}
                            onClick={() =>
                              setRegeneration({
                                id: document.id,
                                language:
                                  document.summary_language === "unknown"
                                    ? "en"
                                    : document.summary_language,
                              })
                            }
                          >
                            <Sparkles size={15} /> Regenerate summary
                          </button>
                        )}
                      </div>
                    )}
                  {document.warnings.map((warning, i) => (
                    <div className="notice warning" key={i}>
                      <AlertCircle size={18} />
                      <span>{warning}</span>
                    </div>
                  ))}
                  {tab === "pdf" ? (
                    <Suspense fallback={<p>Loading PDF…</p>}>
                      <PdfPreview
                        key={document.id}
                        id={document.id}
                        initialPage={previewPage}
                      />
                    </Suspense>
                  ) : tab === "processing" ? (
                    <section aria-label="Processing details">
                      <h3>Processing details</h3>
                      <p role="status">
                        {stateLabels[document.state] || document.state}
                      </p>
                      <dl className="processing-counts">
                        <div>
                          <dt>Available until</dt>
                          <dd>
                            {document.expires_at
                              ? new Date(
                                  document.expires_at * 1000,
                                ).toLocaleString()
                              : "After processing finishes"}
                          </dd>
                        </div>
                        <div>
                          <dt>Pages prepared</dt>
                          <dd>{document.progress.prepared_pages}</dd>
                        </div>
                        <div>
                          <dt>Pages read</dt>
                          <dd>{document.progress.extracted_pages}</dd>
                        </div>
                        <div>
                          <dt>Pages summarized</dt>
                          <dd>{document.progress.summarized_pages}</dd>
                        </div>
                      </dl>
                    </section>
                  ) : tab === "summary" ? (
                    document.summary ? (
                      <SummaryEditor
                        text={document.summary}
                        caption={`Summary language: ${health?.summary_languages?.[document.summary_language] || "Language not recorded"} · ${document.summary_model || "Model not recorded (legacy)"}${document.summary_edited_at ? " · Edited and saved" : ""}`}
                        canEdit={document.terminal}
                        draft={draft}
                        saving={!!savingId}
                        onStart={() =>
                          setDrafts((current) => ({
                            ...current,
                            [draftKey]: {
                              text: document.summary || "",
                              revision: document.summary_version_revision,
                            },
                          }))
                        }
                        onChange={(text) =>
                          setDrafts((current) => ({
                            ...current,
                            [draftKey]: { ...draft!, text, error: undefined },
                          }))
                        }
                        onCancel={() => discardDraft(draftKey)}
                        onSave={() => void saveSummary(document.id)}
                      />
                    ) : (
                      <div className="pending-summary">
                        <Sparkles size={29} />
                        <h3>
                          {document.state === "failed"
                            ? "A summary could not be completed."
                            : "The big picture is on its way."}
                        </h3>
                        <p>
                          {document.state === "failed"
                            ? "Open Processing for details. Any successfully read pages remain available in Page content."
                            : "Your document is being read in small sections. You can explore available pages while the summary is prepared."}
                        </p>
                      </div>
                    )
                  ) : (
                    <div>
                      <div className="page-navigation">
                        <span>
                          Pages {pageCount ? pageOffset + 1 : 0}–
                          {Math.min(pageOffset + 5, pageCount)} of{" "}
                          {pageCount || "…"}
                        </span>
                        <div>
                          <button
                            aria-label="Previous pages"
                            disabled={!pageOffset}
                            onClick={() =>
                              setPageOffset((x) => Math.max(0, x - 5))
                            }
                          >
                            <ChevronLeft size={18} />
                          </button>
                          <button
                            aria-label="Next pages"
                            disabled={pageOffset + 5 >= pageCount}
                            onClick={() => setPageOffset((x) => x + 5)}
                          >
                            <ChevronRight size={18} />
                          </button>
                        </div>
                      </div>
                      {pages.map((page) => (
                        <article className="page-content" key={page.page}>
                          <div className="page-label">
                            PAGE {String(page.page).padStart(2, "0")}
                            <span>
                              {page.extraction_state === "completed"
                                ? "Extracted"
                                : page.extraction_state}
                            </span>
                          </div>
                          {page.markdown ? (
                            document.parser === "gemini" ? (
                              <Markdown text={page.markdown} />
                            ) : (
                              <pre className="extracted-text" dir="auto">
                                {page.markdown}
                              </pre>
                            )
                          ) : (
                            <p className="muted">
                              {page.blank
                                ? "This page is blank."
                                : page.extraction_state === "failed" ||
                                    page.extraction_state === "unavailable"
                                  ? "Content could not be extracted for this page."
                                  : page.extraction_state === "completed"
                                    ? "No extractable text layer. Choose Gemini for scanned pages."
                                    : "This page is waiting to be processed."}
                            </p>
                          )}
                          <button
                            className="secondary"
                            onClick={() => {
                              setPreviewPage(page.page);
                              setTab("pdf");
                            }}
                          >
                            View original page {page.page}
                          </button>
                        </article>
                      ))}
                    </div>
                  )}
                  {tab === "processing" && !!document.errors.length && (
                    <details className="error-details">
                      <summary>Errors ({document.errors.length})</summary>
                      {document.errors.map((item) => (
                        <p key={item.task_id}>
                          <strong>{item.stage}</strong> · {item.message}{" "}
                          <small>{item.attempts} attempt(s)</small>
                        </p>
                      ))}
                    </details>
                  )}
                </div>
                <footer className="reader-footer">
                  <Sparkles size={13} /> AI-generated content. Check the source
                  pages for important decisions.
                </footer>
              </section>
            )}
          </DocumentDrawer>
        )}
        <footer className="page-footer">
          PDF to Summary <span>Built for the details that matter.</span>
        </footer>
      </main>
    </div>
  );
}

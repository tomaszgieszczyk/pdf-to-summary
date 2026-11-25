import { useEffect, useState } from "react";
import { observe } from "../../shared/events";
type Row = {
  id: string;
  filename: string;
  state: string;
  page_count: number;
  size_bytes: number;
  created_at: number;
  last_regenerated_at?: number;
  expires_at: number;
};
type Report = {
  as_of: number;
  total: number;
  states: Record<string, number>;
  pages: number;
  extracted_pages: number;
  bytes: number;
  scheduled: number;
  due_in_24h: number;
  next_change_at?: number;
  items: Row[];
};
const date = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const pageSize = 10;

export function WorkspaceReport() {
  const [report, setReport] = useState<Report | null>(null);
  const [sort, setSort] = useState({ field: "expires_at", order: "asc" });
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  useEffect(
    () =>
      observe(
        async (signal) => {
          const res = await fetch(
            `/api/reports?offset=${offset}&limit=${pageSize}&sort=${sort.field}&order=${sort.order}`,
            { signal },
          );
          if (!res.ok) throw Error("Could not load the workspace report.");
          return (await res.json()) as Report;
        },
        (data) => {
          if (offset > 0 && offset >= data.scheduled)
            setOffset(
              Math.max(
                0,
                Math.floor((data.scheduled - 1) / pageSize) * pageSize,
              ),
            );
          setReport(data);
          setError("");
        },
        (err) => setError((err as Error).message),
        () => true,
      ),
    [offset, revision, sort],
  );
  useEffect(() => {
    if (!report?.next_change_at) return;
    const delay = Math.min(
      2147483647,
      Math.max(100, (report.next_change_at - report.as_of) * 1000 + 100),
    );
    const t = setTimeout(() => setRevision((x) => x + 1), delay);
    return () => clearTimeout(t);
  }, [report]);
  if (!report) return <p role="status">{error || "Loading reports…"}</p>;
  const ready = report.states.completed ?? 0;
  const partial = report.states.partial ?? 0;
  const failed = report.states.failed ?? 0;
  const groups = [
    ["Processing", report.total - ready - partial - failed],
    ["Completed", ready],
    ["Partial", partial],
    ["Failed", failed],
  ] as const;
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <div className="metrics">
        {(
          [
            ["Documents", report.total],
            ["Expiring within 24 hours", report.due_in_24h],
            ["Pages extracted", `${report.extracted_pages} / ${report.pages}`],
            [
              "Uploaded PDFs",
              `${(report.bytes / 1048576).toLocaleString(undefined, { maximumFractionDigits: 2 })} MiB`,
            ],
          ] as const
        ).map(([title, value]) => (
          <div key={title}>
            <span>{title}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <section>
        <h2>Processing status</h2>
        <ul className="state-grid">
          {groups.map(([label, count]) => (
            <li key={label}>
              <span>{label}</span>
              <b>{count}</b>
              <progress
                value={count}
                max={Math.max(1, report.total)}
                aria-label={label}
              />
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>Document expiry</h2>
        <p>
          Deadlines use your local time ({date.resolvedOptions().timeZone}).
          Cleanup removes the PDF, extracted pages and saved summaries.
        </p>
        <p>
          <b>{report.scheduled}</b> scheduled ·{" "}
          <b>{report.total - report.scheduled}</b> awaiting a deadline
        </p>
        {report.scheduled > 0 ? (
          <>
            <div className="report-table">
              <table>
                <thead>
                  <tr>
                    <th>Document</th>
                    {Object.entries({
                      status: "Status",
                      created_at: "Created",
                      last_regenerated_at: "Last regenerated",
                      expires_at: "Expires at",
                    }).map(([field, label]) => (
                      <th
                        key={field}
                        scope="col"
                        aria-sort={
                          sort.field === field
                            ? sort.order === "asc"
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                      >
                        <button
                          onClick={() => {
                            setSort({
                              field,
                              order:
                                sort.field === field && sort.order === "asc"
                                  ? "desc"
                                  : "asc",
                            });
                            setOffset(0);
                          }}
                        >
                          {label}{" "}
                          {sort.field === field &&
                            (sort.order === "asc" ? "↑" : "↓")}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.items.map((row) => (
                    <tr key={row.id}>
                      <td>{row.filename}</td>
                      <td>{row.state}</td>
                      <td>{date.format(row.created_at * 1000)}</td>
                      <td>
                        {row.last_regenerated_at
                          ? date.format(row.last_regenerated_at * 1000)
                          : "Not regenerated"}
                      </td>
                      <td>
                        <time
                          dateTime={new Date(
                            row.expires_at * 1000,
                          ).toISOString()}
                        >
                          {date.format(row.expires_at * 1000)}
                        </time>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="report-pagination">
              <button
                disabled={offset === 0}
                onClick={() => setOffset((x) => Math.max(0, x - pageSize))}
              >
                Previous
              </button>
              <span>
                {offset + 1}–{Math.min(offset + pageSize, report.scheduled)} of{" "}
                {report.scheduled}
              </span>
              <button
                disabled={offset + pageSize >= report.scheduled}
                onClick={() => setOffset((x) => x + pageSize)}
              >
                Next
              </button>
            </div>
          </>
        ) : (
          <p>No documents have a scheduled expiry.</p>
        )}
      </section>
    </>
  );
}

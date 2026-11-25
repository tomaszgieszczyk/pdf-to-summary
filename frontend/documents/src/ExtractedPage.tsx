import type { Page } from "./types";

function blocks(text: string, positioned: boolean) {
  const result: string[][][] = [];
  let rows: string[][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      rows = [];
      continue;
    }
    const cells = line
      .split(positioned ? /\t+/ : /\t+| {3,}/)
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (!rows.length || cells.length !== rows[0].length) {
      rows = [];
      result.push(rows);
    }
    rows.push(cells);
  }
  return result;
}

export function ExtractedPage({ page }: { page: Page }) {
  return (
    <div className="extracted-text" dir="auto">
      {blocks(page.markdown ?? "", page.text_format === "rows").map(
        (rows, index) => {
          const first = rows[0];
          if (first.length === 1)
            return (
              <p key={index}>
                {rows.map(([line], i) => (
                  <span className="source-line" key={i}>
                    {line}
                  </span>
                ))}
              </p>
            );
          if (
            rows.length === 1 &&
            first.length % 2 === 0 &&
            first.every((cell, i) => i % 2 !== 0 || cell.endsWith(":"))
          ) {
            return (
              <dl className="source-fields" key={index}>
                {first.map(
                  (label, i) =>
                    i % 2 === 0 && (
                      <div key={i}>
                        <dt>{label}</dt>
                        <dd>{first[i + 1]}</dd>
                      </div>
                    ),
                )}
              </dl>
            );
          }
          return (
            <div className="source-table" key={index}>
              <table aria-label={`Text columns on page ${page.page}`}>
                <tbody>
                  {rows.map((cells, i) => (
                    <tr key={i}>
                      {cells.map((cell, j) => (
                        <td key={j}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        },
      )}
      {page.margin_notes && (
        <details className="source-notes">
          <summary>Margin notes</summary>
          {page.margin_notes.split(/\n\n/).map((note, i) => (
            <p key={i}>{note}</p>
          ))}
        </details>
      )}
    </div>
  );
}

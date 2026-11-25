import { Pencil } from "lucide-react";
import { Markdown } from "./Markdown";

export type SummaryDraft = { text: string; revision: number; error?: string };

type Props = {
  text: string;
  caption: string;
  canEdit: boolean;
  draft?: SummaryDraft;
  saving: boolean;
  onStart: () => void;
  onChange: (text: string) => void;
  onCancel: () => void;
  onSave: () => void;
};

export function SummaryEditor({
  text,
  caption,
  canEdit,
  draft,
  saving,
  onStart,
  onChange,
  onCancel,
  onSave,
}: Props) {
  return (
    <div>
      <div className="summary-toolbar">
        <span className="muted" role="status">
          {caption}
        </span>
        {!draft && canEdit && (
          <button className="secondary" onClick={onStart}>
            <Pencil size={15} /> Edit summary
          </button>
        )}
      </div>
      {draft ? (
        <div className="summary-editor">
          <label htmlFor="summary-draft">Edit summary (Markdown)</label>
          <textarea
            id="summary-draft"
            dir="auto"
            value={draft.text}
            maxLength={10000}
            disabled={saving}
            onChange={(event) => onChange(event.target.value)}
          />
          <div className="editor-actions">
            <span className="muted">
              {draft.text.length.toLocaleString()} / 10,000 characters · Unsaved
              draft
            </span>
            <button className="secondary" disabled={saving} onClick={onCancel}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={saving || !draft.text.trim()}
              onClick={onSave}
            >
              {saving ? "Saving…" : "Save summary"}
            </button>
          </div>
          {draft.error && (
            <div className="notice error" role="alert">
              {draft.error}
            </div>
          )}
          <details className="summary-preview">
            <summary>Preview</summary>
            <Markdown text={draft.text} />
          </details>
        </div>
      ) : (
        <Markdown text={text} />
      )}
    </div>
  );
}

export type DocItem = {
  id: string;
  filename: string;
  state: string;
  created_at: string;
  last_regenerated_at?: number;
  page_count: string | null;
  size_bytes: string;
};
export type SummaryVersion = {
  id: string;
  language: string;
  model: string | null;
  created_at: number | null;
  edited_at: number | null;
  revision: number;
};

export type Document = {
  parser: string;
  id: string;
  filename: string;
  state: string;
  summary: string | null;
  summary_language: string;
  summary_model: string | null;
  summary_version_id: string | null;
  summary_version_revision: number;
  summary_versions: SummaryVersion[];
  summary_revision: number;
  summary_edited_at: number | null;
  pending_summary_language: string | null;
  terminal: boolean;
  expires_at?: number;
  size_bytes: number;
  page_count: number | null;
  warnings: string[];
  errors: {
    task_id: string;
    stage: string;
    message: string;
    attempts: number;
  }[];
  progress: {
    prepared_pages: number;
    extracted_pages: number;
    summarized_pages: number;
  };
};
export type Page = {
  page: number;
  markdown: string | null;
  blank: boolean | null;
  extraction_state: string;
  summary_state: string;
};
export type Health = {
  provider_configured: boolean;
  max_upload_bytes: number;
  model: string;
  summary_languages: Record<string, string>;
};

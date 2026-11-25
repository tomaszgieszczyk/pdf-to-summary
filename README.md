# PDF to Summary

Upload PDFs, read the extracted text page by page and generate editable Markdown summaries in a chosen language. The Go API and worker live in `backend/`. Documents and Reports are separate React and Vite applications with their own package manifests, lockfiles and production builds.

## Run locally with Docker Compose

Install Docker with the Compose plugin. From the repository root, create your local settings file.

```powershell
Copy-Item .env.example .env
```

On macOS or Linux, use `cp .env.example .env`. Set `GEMINI_API_KEY` in `.env`. This key stays on the backend. Both parsing modes use Gemini to write summaries.

```sh
docker compose up -d --build
```

Open [the document workspace](http://localhost:8080). Choose a PDF parser and summary language, then select or drop one or more files. Open a document to follow its progress, inspect individual pages, edit a saved version, regenerate in another language or export Markdown.

- **Poppler** extracts embedded text locally. Only extracted text and summary material are sent to Gemini. Use this mode for PDFs with a text layer.
- **Gemini** receives a one-page PDF at a time and can transcribe scanned pages and images. Extracted pages stay in the source language.

The [interactive API docs](http://localhost:8000/docs) describe the endpoints. [Health](http://localhost:8000/health) reports the model and whether a key is configured. [Readiness](http://localhost:8000/ready) also checks Redis and the storage directory. A successful readiness check does not validate Gemini credentials or quota.

```sh
docker compose logs -f api worker
docker compose down
```

Compose binds the UI, API and Redis to loopback. The service has no authentication. Named volumes preserve PDFs, results and revisions across restarts. Terminal documents expire after 24 hours by default. Configure the model, upload limit, retention, capacity and shared Gemini request rate in `.env`. After changing settings, run `docker compose up -d`. Nginx also enforces a 1 GiB upload limit.

## Development

Install Go **1.27.4**, Node.js **22.12+** (or a newer supported LTS) and Poppler utilities. Put `pdfinfo`, `pdftotext` and `pdfseparate` on PATH. The Docker images already contain the required tools.

Start just Redis from the repository root.

```sh
docker compose up -d redis
```

In a terminal, start the Go API and its background worker. For native Go runs, set `GEMINI_API_KEY` in the process environment. Compose reads the root `.env` automatically. Set `REDIS_URL` or `STORAGE_DIR` to override the native defaults of `redis://127.0.0.1:6389/0` and `./data`.

```sh
cd backend
go run .
```

For frontend development under the shared origin, start the Compose development configuration. It runs Vite for both applications, mounts their source directories and forwards hot reload through the gateway.

```sh
docker compose -f compose.yaml -f compose.dev.yaml up -d --build
```

Open [Documents](http://localhost:8080/documents/) or [Reports](http://localhost:8080/reports/). Switch back to production builds with `docker compose up -d --build`. Stop any native Go process on port 8000 before starting the Compose API.

## Workspace modules

| Browser path on localhost:8080 | Gateway destination |
| --- | --- |
| `/documents/` | Documents on port 5174 |
| `/reports/` | Reports on port 5175 |
| `/api/` | Go API on port 8000 |

The root opens Documents. Use the **Modules** menu to switch applications. Reports shows the current library size and the default summary language. Changing the language in either application updates the other, including an already-open tab on the same origin. The preference is stored under `pdf-to-summary.preferences.summary-language`. PDFs, summaries and provider credentials stay on the backend. Opening the application ports directly creates separate browser storage.

The shared registry in `frontend/shared/modules.ts` controls navigation. A module with a path is accessible from the menu. A null path displays **Unavailable in demo**. Access Control, AI Chat and Configuration are placeholders. This registry describes UI availability. Future protected operations also require authorization in the API.

To add a working module, create its Vite application under `frontend/`, assign its URL base and service port, add the Compose service and gateway location, then set its path in the registry. The common Dockerfile accepts `APP` and `APP_PORT`. For an existing module, rebuild and deploy it independently, for example with `docker compose up -d --build --no-deps reports`. Rebuild both applications after editing shared navigation or preferences.

## API example

```sh
curl --fail-with-body -X POST "http://localhost:8000/documents?filename=report.pdf&parser=poppler&summary_language=pl" -H "Content-Type: application/pdf" --data-binary "@report.pdf"
```

On Windows use `curl.exe`. The response contains a document ID and a status URL. Poll the status URL until `terminal` is true. Read pages from `/documents/{id}/pages`. Pass an `Idempotency-Key` header to safely retry an upload with the same settings. The API accepts the earlier `pypdf` selector as an alias for local extraction.

## Processing and persistence

The API streams the input to disk, then registers the document and its Redis Streams job in one transaction. Workers acquire a renewable document lease. Redis stores extracted pages, per-generation summaries and reduction checkpoints. A replacement worker can resume from the last published checkpoint. Provider calls interrupted before a checkpoint is saved may be repeated. Multiple workers can process different documents concurrently.

Regeneration reads saved pages. Earlier summary versions and edits remain available. Revisions protect edits from concurrent overwrites. A partial result lists missing pages and warnings. Generated and manually edited text are stored separately. This repository uses its own Redis keys and Compose volumes.

## Verification

```sh
cd backend
go test ./...
go vet ./...
```

The lifecycle integration test uses real Poppler, an isolated Redis-compatible test server and a local Gemini HTTP stub. Install Poppler to include both extraction paths in this test. A Gemini key is unnecessary for the tests.

```sh
cd frontend/documents
npm ci
npm test
npm run build
```

Build Reports separately with `npm ci` and `npm run build` from `frontend/reports`.

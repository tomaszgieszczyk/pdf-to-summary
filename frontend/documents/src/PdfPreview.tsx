import { useEffect, useRef, useState } from "react";
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfPreview({
  id,
  initialPage = 1,
}: {
  id: string;
  initialPage?: number;
}) {
  const url = "/api/documents/" + id + "/source";
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [number, setNumber] = useState(initialPage);
  const [error, setError] = useState("");
  const [width, setWidth] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let active = true;
    const base = import.meta.env.BASE_URL + "pdfjs/";
    const task = getDocument({
      url,
      cMapUrl: base + "cmaps/",
      standardFontDataUrl: base + "standard_fonts/",
      iccUrl: base + "iccs/",
      wasmUrl: base + "wasm/",
      disableAutoFetch: true,
      disableStream: true,
    });
    task.promise
      .then((doc) => {
        if (active) setPdf(doc);
      })
      .catch(() => {
        if (active) setError("Could not open the original PDF.");
      });
    return () => {
      active = false;
      void task.destroy();
    };
  }, [url]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.floor(entry.contentRect.width)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const el = canvas.current;
    if (!pdf || !width || !el) return;
    let active = true,
      render: RenderTask | undefined;
    setError("");
    async function draw(doc: PDFDocumentProxy, target: HTMLCanvasElement) {
      const page = await doc.getPage(number);
      if (!active) return;
      const original = page.getViewport({ scale: 1 });
      const ratio = Math.min(devicePixelRatio || 1, 2);
      const scale = Math.min(
        (width * ratio) / original.width,
        4096 / original.height,
        4096 / original.width,
      );
      const viewport = page.getViewport({ scale });
      target.width = Math.ceil(viewport.width);
      target.height = Math.ceil(viewport.height);
      render = page.render({ canvas: target, viewport });
      await render.promise;
    }
    draw(pdf, el).catch(() => {
      if (active) setError("Could not display this page.");
    });
    return () => {
      active = false;
      render?.cancel();
    };
  }, [number, pdf, width]);
  return (
    <section aria-label="Original PDF">
      <div className="pdf-controls">
        <button
          className="secondary"
          disabled={!pdf || number <= 1}
          onClick={() => setNumber((n) => n - 1)}
        >
          Previous
        </button>
        <span>
          {pdf ? `Page ${number} of ${pdf.numPages}` : "Loading PDF…"}
        </span>
        <button
          className="secondary"
          disabled={!pdf || number >= pdf.numPages}
          onClick={() => setNumber((n) => n + 1)}
        >
          Next
        </button>
        <a href={url} target="_blank" rel="noreferrer">
          Open original PDF ↗
        </a>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="pdf-sheet" ref={container}>
        <canvas
          ref={canvas}
          role="img"
          aria-label={`Original PDF page ${number}`}
        />
      </div>
    </section>
  );
}

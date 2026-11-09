import { useEffect, useRef, useState } from 'react';

// Same local worker setup as src/lib/documentOCR.ts, loaded on first use so pdf.js
// stays out of the startup chunk.
async function loadPdfjs() {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

// Zeroing the backing store frees canvas memory at once (iOS Safari holds it otherwise).
function releaseCanvases(canvases: HTMLCanvasElement[]) {
  for (const c of canvases) { c.width = 0; c.height = 0; }
}

/** Shows each page of a PDF as a canvas sized to the pane (crisp on high-DPI screens). */
export default function PdfPagePreview({ blob, title }: { blob: Blob; title: string }) {
  const pagesRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    const host = pagesRef.current;
    if (!host) return;
    let cancelled = false;
    let loadingTask: { destroy: () => Promise<void> } | null = null;
    const renderTasks: { cancel: () => void }[] = [];
    const drawn: HTMLCanvasElement[] = [];
    // The skeleton shows on first load only; a new blob keeps the old pages until its own are drawn.
    if (!host.hasChildNodes()) setStatus('loading');
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        const data = new Uint8Array(await blob.arrayBuffer());
        if (cancelled) return;
        const task = pdfjs.getDocument({ data });
        loadingTask = task;
        const pdf = await task.promise;
        // ponytail: sized once per PDF; a resized window scales the bitmap until the next render.
        const cssWidth = host.parentElement?.clientWidth || 612;
        const dpr = window.devicePixelRatio || 1;
        for (let n = 1; n <= pdf.numPages; n++) {
          const page = await pdf.getPage(n);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: (cssWidth / page.getViewport({ scale: 1 }).width) * dpr });
          const canvas = document.createElement('canvas');
          drawn.push(canvas);
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.setAttribute('role', 'img');
          canvas.setAttribute('aria-label', `${title}, page ${n} of ${pdf.numPages}`);
          canvas.className = 'block h-auto w-full bg-white shadow-md';
          const renderTask = page.render({ canvas, viewport });
          renderTasks.push(renderTask);
          await renderTask.promise;
          if (cancelled) return;
        }
        const old = [...host.children] as HTMLCanvasElement[];
        host.replaceChildren(...drawn);
        releaseCanvases(old);
        setStatus('ready');
      } catch {
        if (cancelled) return;
        releaseCanvases([...host.children] as HTMLCanvasElement[]);
        host.replaceChildren();
        releaseCanvases(drawn);
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
      renderTasks.forEach((t) => t.cancel());
      loadingTask?.destroy().catch(() => {});
      // Pages not yet shown are dropped; shown pages stay until the next blob's pages replace them.
      releaseCanvases(drawn.filter((c) => c.parentNode !== host));
    };
  }, [blob, title]);

  // Unmount: free the shown pages too.
  useEffect(() => {
    const host = pagesRef.current;
    return () => {
      if (!host) return;
      releaseCanvases([...host.children] as HTMLCanvasElement[]);
      host.replaceChildren();
    };
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-[816px] flex-col gap-6">
      <div ref={pagesRef} className="contents" />
      {status === 'loading' && (
        <div role="status">
          <span className="sr-only">Loading preview…</span>
          <div aria-hidden="true" className="aspect-[17/22] w-full animate-pulse rounded bg-white shadow-md" />
        </div>
      )}
      {status === 'error' && (
        <p role="alert" className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-secondary">
          The preview could not be shown. Download the PDF to view it.
        </p>
      )}
    </div>
  );
}

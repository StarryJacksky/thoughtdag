import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Pdfjs } from '../../lib/pdfjs';

// One page of a PDF: the page drawn on a canvas, with the library's own
// text layer over it so that the words can be selected. Drawn when it comes
// near the view, not before. Shared by the reading overlay (which adds its
// own marks and clipping) and the reading surfaces.

export default function PdfPage({ doc, pdfjs, pageNo, width, anchors, activeThreadId, onAnchorClick, clipMode, onClipped }: {
  doc: PDFDocumentProxy; pdfjs: Pdfjs; pageNo: number; width: number;
  anchors?: { id: string; question: string; rects: [number, number, number, number][] }[];
  activeThreadId?: string | null;
  onAnchorClick?: (id: string) => void;
  clipMode?: boolean;
  onClipped?: (pageNo: number, rect: [number, number, number, number], dataUrl: string, screenRect?: { left: number; top: number; width: number; height: number }) => void;
}) {
  const holderRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  // clip-mode rubber band, in page-fraction space (same space as anchors)
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const frac = (e: React.MouseEvent) => {
    const pb = holderRef.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - pb.left) / pb.width)), y: Math.min(1, Math.max(0, (e.clientY - pb.top) / pb.height)) };
  };
  const finishClip = () => {
    if (!band || !canvasRef.current || !onClipped) { setBand(null); return; }
    const x = Math.min(band.x0, band.x1), y = Math.min(band.y0, band.y1);
    const w = Math.abs(band.x1 - band.x0), h = Math.abs(band.y1 - band.y0);
    setBand(null);
    if (w < 0.02 || h < 0.01) return; // a stray click, not a capture
    const src = canvasRef.current;
    const sx = Math.floor(x * src.width), sy = Math.floor(y * src.height);
    const sw = Math.max(1, Math.floor(w * src.width)), sh = Math.max(1, Math.floor(h * src.height));
    const out = document.createElement('canvas');
    out.width = sw; out.height = sh;
    out.getContext('2d')!.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
    const pb = holderRef.current!.getBoundingClientRect();
    const screenRect = { left: pb.left + x * pb.width, top: pb.top + y * pb.height, width: w * pb.width, height: h * pb.height };
    onClipped(pageNo, [x, y, w, h], out.toDataURL('image/png'), screenRect);
  };
  const [visible, setVisible] = useState(pageNo <= 2);
  const [height, setHeight] = useState(Math.round(width * 1.4142));

  useEffect(() => {
    if (visible) return;
    const el = holderRef.current;
    if (!el) return;
    const ob = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) { setVisible(true); ob.disconnect(); }
      },
      { rootMargin: '900px' },
    );
    ob.observe(el);
    return () => ob.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let dead = false;
    (async () => {
      const page = await doc.getPage(pageNo);
      if (dead) return;
      const scale = width / page.getViewport({ scale: 1 }).width;
      const viewport = page.getViewport({ scale });
      setHeight(Math.round(viewport.height));
      const canvas = canvasRef.current;
      const textDiv = textRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !textDiv || !ctx) return;
      const out = Math.min(window.devicePixelRatio || 1, 1.75);
      canvas.width = Math.floor(viewport.width * out);
      canvas.height = Math.floor(viewport.height * out);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      await page.render({
        canvasContext: ctx,
        viewport,
        ...(out !== 1 ? { transform: [out, 0, 0, out, 0, 0] } : {}),
      }).promise;
      if (dead) return;
      textDiv.innerHTML = '';
      textDiv.style.setProperty('--scale-factor', String(scale));
      const layer = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent(),
        container: textDiv,
        viewport,
      });
      await layer.render();
    })().catch(() => { /* a cancelled render mid-close is fine */ });
    return () => { dead = true; };
  }, [visible, width, doc, pdfjs, pageNo]);

  return (
    <div ref={holderRef} data-page={pageNo} className="relative bg-white shadow-md rounded-sm shrink-0" style={{ width, height }}>
      <canvas ref={canvasRef} className="absolute inset-0" />
      <div ref={textRef} className="tdag-textlayer" />
      {/* interaction marks: a wash over the asked passage (never blocks
          re-selection) plus one clickable bubble that reopens the thread */}
      {anchors?.map((a) => (
        <div key={a.id}>
          {a.rects.map((r, i) => (
            <div
              key={i}
              className={`absolute rounded-sm pointer-events-none ${activeThreadId === a.id ? 'bg-accent/25' : 'bg-accent/10'}`}
              style={{ left: `${r[0] * 100}%`, top: `${r[1] * 100}%`, width: `${r[2] * 100}%`, height: `${r[3] * 100}%`, zIndex: 3 }}
            />
          ))}
          <button
            onClick={() => onAnchorClick?.(a.id)}
            title={a.question}
            className={`absolute w-6 h-6 rounded-full shadow-md border flex items-center justify-center text-xs transition-transform hover:scale-110 ${
              activeThreadId === a.id ? 'bg-accent text-white border-accent' : 'bg-card text-accent border-accent/40'
            }`}
            style={{ left: `calc(${(a.rects[0][0] + a.rects[0][2]) * 100}% + 6px)`, top: `${a.rects[0][1] * 100}%`, zIndex: 4 }}
            data-anchor-bubble={a.id}
          >
            💬
          </button>
        </div>
      ))}
      <span className="absolute -left-9 top-1 text-2xs text-ink-faint font-mono select-none">p.{pageNo}</span>
      {clipMode && (
        <div
          className="absolute inset-0 cursor-crosshair"
          style={{ zIndex: 6 }}
          data-clip-overlay={pageNo}
          onMouseDown={(e) => { e.preventDefault(); const p = frac(e); setBand({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }); }}
          onMouseMove={(e) => { if (band) { const p = frac(e); setBand({ ...band, x1: p.x, y1: p.y }); } }}
          onMouseUp={finishClip}
          onMouseLeave={() => { if (band) finishClip(); }}
        >
          {band && (
            <div
              className="absolute border-2 border-warm bg-warm/10 rounded-sm pointer-events-none"
              style={{
                left: `${Math.min(band.x0, band.x1) * 100}%`,
                top: `${Math.min(band.y0, band.y1) * 100}%`,
                width: `${Math.abs(band.x1 - band.x0) * 100}%`,
                height: `${Math.abs(band.y1 - band.y0) * 100}%`,
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

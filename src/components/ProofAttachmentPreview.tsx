import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Download,
  FileText,
  Maximize2,
  Minimize2,
  RotateCw,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

interface ProofAttachmentPreviewProps {
  dataUrl: string;
  orderNumber: string;
  maxHeightClass?: string;
  title?: string;
  clickable?: boolean;
}

export interface FullscreenImageLightboxProps {
  isOpen: boolean;
  src: string;
  title: string;
  downloadFilename?: string;
  onClose: () => void;
}

export function isPdfProofDataUrl(url?: string): boolean {
  return Boolean(url && url.startsWith('data:application/pdf;base64,'));
}

export function FullscreenImageLightbox({
  isOpen,
  src,
  title,
  downloadFilename,
  onClose,
}: FullscreenImageLightboxProps) {
  const [zoom, setZoom] = useState<1 | 1.75 | 2.5>(1);
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);

  useEffect(() => {
    if (!isOpen) {
      setZoom(1);
      setRotation(0);
      return;
    }

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen || !src || typeof document === 'undefined') return null;

  const isQuarterTurn = rotation === 90 || rotation === 270;
  const cycleZoom = () => {
    setZoom((prev) => (prev === 1 ? 1.75 : prev === 1.75 ? 2.5 : 1));
  };
  const rotateClockwise = () => {
    setRotation((prev) => (((prev + 90) % 360) as 0 | 90 | 180 | 270));
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[120] w-screen h-[100dvh] bg-slate-950/95 backdrop-blur-xs flex flex-col select-none no-print"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      {/* Top toolbar */}
      <div
        className="shrink-0 flex items-center justify-between gap-2 px-3 sm:px-5 py-2.5 bg-slate-950/85 border-b border-white/10 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-w-0">
          <p className="text-xs sm:text-sm font-semibold text-white truncate">
            {title}
          </p>
          <p className="text-[11px] text-slate-400">
            {zoom === 1
              ? 'Mode Sesuai Layar · Ketuk gambar untuk perbesar'
              : `Zoom ${zoom}x · Ketuk gambar atau tombol Sesuai Layar`}
          </p>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={cycleZoom}
            title={zoom === 1 ? 'Perbesar Gambar' : 'Sesuaikan Layar'}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-white bg-white/10 hover:bg-white/20 border border-white/15 rounded-lg transition-colors cursor-pointer"
          >
            {zoom === 1 ? (
              <>
                <ZoomIn className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Perbesar</span>
              </>
            ) : zoom === 1.75 ? (
              <>
                <ZoomIn className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">2.5x</span>
              </>
            ) : (
              <>
                <ZoomOut className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Sesuai Layar</span>
              </>
            )}
          </button>

          {zoom !== 1 && (
            <button
              type="button"
              onClick={() => setZoom(1)}
              title="Sesuai Layar"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-white bg-white/10 hover:bg-white/20 border border-white/15 rounded-lg transition-colors cursor-pointer"
            >
              <Minimize2 className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Fit</span>
            </button>
          )}

          <button
            type="button"
            onClick={rotateClockwise}
            title="Putar 90°"
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-white bg-white/10 hover:bg-white/20 border border-white/15 rounded-lg transition-colors cursor-pointer"
          >
            <RotateCw className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Putar</span>
          </button>

          <a
            href={src}
            download={downloadFilename || 'bukti-pengiriman.jpg'}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Unduh</span>
          </a>

          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup tampilan gambar"
            className="p-2 text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Responsive full-screen viewport stage */}
      <div
        className={`flex-1 min-h-0 w-full flex items-center justify-center p-2 sm:p-5 ${
          zoom > 1 ? 'overflow-auto' : 'overflow-hidden'
        }`}
      >
        <img
          src={src}
          alt={title}
          onClick={(e) => {
            e.stopPropagation();
            cycleZoom();
          }}
          style={{
            transform: `rotate(${rotation}deg) scale(${zoom})`,
            transformOrigin: 'center center',
          }}
          className={`transition-transform duration-200 rounded-lg shadow-2xl object-contain ${
            zoom === 1 ? 'cursor-zoom-in' : 'cursor-zoom-out'
          } ${
            isQuarterTurn
              ? 'max-w-[calc(100dvh-5.5rem)] max-h-[calc(100vw-1.5rem)]'
              : 'max-w-full max-h-full w-auto h-auto'
          }`}
        />
      </div>
    </div>,
    document.body
  );
}

export function ProofAttachmentPreview({
  dataUrl,
  orderNumber,
  maxHeightClass = 'max-h-60',
  title,
  clickable = true,
}: ProofAttachmentPreviewProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);

  if (!dataUrl) return null;

  if (isPdfProofDataUrl(dataUrl)) {
    return (
      <div className="p-3.5 bg-white border border-emerald-200 rounded-lg flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-10 h-10 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-center shrink-0">
            <FileText className="w-5 h-5 text-emerald-700" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-bold text-slate-900 truncate">
              File Bukti Pengiriman (PDF)
            </p>
            <p className="font-mono text-[11px] text-slate-500 truncate">
              {orderNumber}.pdf
            </p>
          </div>
        </div>
        <a
          href={dataUrl}
          download={`bukti-${orderNumber}.pdf`}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors whitespace-nowrap"
        >
          <Download className="w-3.5 h-3.5 shrink-0" />
          <span>Unduh / Lihat PDF</span>
        </a>
      </div>
    );
  }

  const label = title || `Bukti Pengiriman · ${orderNumber}`;

  if (!clickable) {
    return (
      <img
        src={dataUrl}
        alt={label}
        className={`w-full max-w-md ${maxHeightClass} object-contain rounded-lg border border-emerald-200 bg-white`}
      />
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setLightboxOpen(true)}
        className="group relative block w-full max-w-md rounded-lg overflow-hidden border border-emerald-200 bg-slate-950/5 hover:border-emerald-400 transition-all cursor-zoom-in text-left"
        title="Klik untuk membuka gambar sesuai ukuran layar"
      >
        <img
          src={dataUrl}
          alt={label}
          className={`w-full ${maxHeightClass} object-contain bg-white`}
        />
        <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-white bg-slate-900/80 group-hover:bg-blue-700 rounded-md shadow-xs transition-colors">
          <Maximize2 className="w-3 h-3" />
          <span>Klik · Sesuai Layar</span>
        </span>
      </button>

      <FullscreenImageLightbox
        isOpen={lightboxOpen}
        src={dataUrl}
        title={label}
        downloadFilename={`bukti-${orderNumber}.jpg`}
        onClose={() => setLightboxOpen(false)}
      />
    </>
  );
}

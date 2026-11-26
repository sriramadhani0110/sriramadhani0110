import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Camera,
  CheckCircle2,
  ImagePlus,
  Plus,
  ScanBarcode,
  Search,
  X,
} from 'lucide-react';
import type { Product, StoreMasterConfig } from '../types/marketplace';
import { normalizeProductUnit } from '../lib/catalogSeed';
import { formatPrimaryAmount } from '../lib/storeDefaults';
import { ProductImage } from './ProductImage';

interface ProductBarcodeScannerProps {
  products: Product[];
  selectedProductId: string;
  masterConfig: StoreMasterConfig;
  onSelectProduct: (product: Product) => void;
  title?: string;
  subtitle?: string;
  autoFocusInput?: boolean;
  primaryActionLabel?: string;
  onPrimaryAction?: (product: Product) => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: (product: Product) => void;
  getItemExtraLabel?: (product: Product) => string | null;
}

function normalizeCode(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '');
}

function stripLeadingZeros(code: string): string {
  return code.replace(/^0+/, '') || code;
}

function playScanSuccessBeep(): void {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1046.5, ctx.currentTime);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.13);
    window.setTimeout(() => {
      void ctx.close().catch(() => undefined);
    }, 220);
  } catch {
    // Ignore audio context restrictions
  }
}

export function findProductByScanCode(
  products: Product[],
  rawCode: string
): Product | null {
  const clean = normalizeCode(rawCode);
  if (!clean) return null;
  const noZero = stripLeadingZeros(clean);

  // 1. Exact barcode match
  for (const p of products) {
    const bc = normalizeCode(p.barcode || '');
    if (bc && (bc === clean || stripLeadingZeros(bc) === noZero)) {
      return p;
    }
  }

  // 2. Exact SKU or ID match
  for (const p of products) {
    const sku = normalizeCode(p.sku || '');
    const id = normalizeCode(p.id || '');
    if ((sku && sku === clean) || id === clean) {
      return p;
    }
  }

  // 3. Substring match on barcode or SKU
  for (const p of products) {
    const bc = normalizeCode(p.barcode || '');
    const sku = normalizeCode(p.sku || '');
    if ((bc && bc.includes(clean)) || (sku && sku.includes(clean))) {
      return p;
    }
  }

  // 4. Exact name match
  for (const p of products) {
    if (p.name.trim().toLowerCase() === rawCode.trim().toLowerCase()) {
      return p;
    }
  }

  return null;
}

export function ProductBarcodeScanner({
  products,
  selectedProductId,
  masterConfig,
  onSelectProduct,
  title = 'Scanner Barcode & Cari Cepat Produk Promosi',
  subtitle,
  autoFocusInput = false,
  primaryActionLabel,
  onPrimaryAction,
  secondaryActionLabel,
  onSecondaryAction,
  getItemExtraLabel,
}: ProductBarcodeScannerProps) {
  const reactId = useId();
  const scannerRegionId = useMemo(
    () => `promo-barcode-scanner-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`,
    [reactId]
  );
  const fileScanRegionId = useMemo(
    () => `promo-barcode-file-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`,
    [reactId]
  );

  const [queryText, setQueryText] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [scanningFile, setScanningFile] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [scanFeedback, setScanFeedback] = useState<{
    tone: 'ok' | 'err';
    text: string;
  } | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scannerInstanceRef = useRef<{
    stop: () => Promise<void>;
    clear: () => void;
  } | null>(null);
  const onSelectRef = useRef(onSelectProduct);
  const productsRef = useRef(products);

  useEffect(() => {
    onSelectRef.current = onSelectProduct;
    productsRef.current = products;
  }, [onSelectProduct, products]);

  useEffect(() => {
    if (autoFocusInput) {
      window.setTimeout(() => {
        inputRef.current?.focus();
      }, 60);
    }
  }, [autoFocusInput]);

  const stopCamera = async () => {
    const inst = scannerInstanceRef.current;
    scannerInstanceRef.current = null;
    if (inst) {
      try {
        await inst.stop();
      } catch {
        // ignore if already stopped
      }
      try {
        inst.clear();
      } catch {
        // ignore clear error
      }
    }
    setCameraOpen(false);
    setCameraStarting(false);
  };

  useEffect(() => {
    return () => {
      const inst = scannerInstanceRef.current;
      scannerInstanceRef.current = null;
      if (inst) {
        void inst.stop().catch(() => undefined);
      }
    };
  }, []);

  const handleResolvedCode = (
    rawCode: string,
    source: 'camera' | 'photo' | 'manual'
  ) => {
    const code = rawCode.trim();
    if (!code) return;
    const match = findProductByScanCode(productsRef.current, code);
    const sourceLabel =
      source === 'camera'
        ? 'Scan kamera'
        : source === 'photo'
          ? 'Scan foto barcode'
          : 'Scan';

    if (match) {
      playScanSuccessBeep();
      onSelectRef.current(match);
      setQueryText('');
      setScanFeedback({
        tone: 'ok',
        text: `${sourceLabel} berhasil: ${match.name}${
          match.barcode ? ` (BC: ${match.barcode})` : ''
        }`,
      });
      if (source === 'camera') {
        void stopCamera();
      }
    } else {
      setScanFeedback({
        tone: 'err',
        text: `Kode "${code}" tidak ditemukan di katalog. Pastikan barcode/SKU sudah terdaftar atau ketik nama produk.`,
      });
      if (source === 'camera') {
        void stopCamera();
      }
    }
  };

  const startCamera = async () => {
    setCameraError(null);
    setScanFeedback(null);
    setCameraOpen(true);
    setCameraStarting(true);

    // Wait one tick so the target container mounts in the DOM
    await new Promise((r) => window.setTimeout(r, 90));

    try {
      const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import(
        'html5-qrcode'
      );
      const scanner = new Html5Qrcode(scannerRegionId, {
        verbose: false,
        formatsToSupport: [
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A,
          Html5QrcodeSupportedFormats.UPC_E,
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39,
          Html5QrcodeSupportedFormats.CODE_93,
          Html5QrcodeSupportedFormats.ITF,
          Html5QrcodeSupportedFormats.QR_CODE,
        ],
      });
      scannerInstanceRef.current = scanner;

      const scanConfig = {
        fps: 10,
        qrbox: { width: 250, height: 130 },
        aspectRatio: 1.6,
      };
      const onSuccess = (decodedText: string) => {
        if (decodedText && decodedText.trim()) {
          handleResolvedCode(decodedText, 'camera');
        }
      };
      const onMiss = () => {
        // Ignore per-frame decode misses
      };

      try {
        // Prefer rear camera on mobile devices
        await scanner.start(
          { facingMode: 'environment' },
          scanConfig,
          onSuccess,
          onMiss
        );
      } catch {
        // Fallback to first enumerated camera (desktop webcams / front camera)
        const cameras = await Html5Qrcode.getCameras();
        if (!cameras || cameras.length === 0) {
          throw new Error('Kamera tidak ditemukan pada perangkat ini.');
        }
        const backCam =
          cameras.find((c) => /back|rear|environment/i.test(c.label)) ||
          cameras[0];
        await scanner.start(backCam.id, scanConfig, onSuccess, onMiss);
      }

      setCameraStarting(false);
    } catch (err) {
      scannerInstanceRef.current = null;
      setCameraStarting(false);
      const msg =
        err instanceof Error ? err.message : 'Gagal membuka kamera scanner.';
      if (
        msg.toLowerCase().includes('permission') ||
        msg.toLowerCase().includes('notallowed')
      ) {
        setCameraError(
          'Izin kamera ditolak browser. Aktifkan izin Kamera di Chrome/Safari, pakai tombol "Scan Foto Barcode", atau gunakan alat scan USB/Bluetooth.'
        );
      } else {
        setCameraError(
          'Kamera live tidak tersedia di browser/preview ini. Anda tetap bisa pakai tombol "Scan Foto Barcode", alat scan USB/Bluetooth, atau ketik nama/barcode.'
        );
      }
    }
  };

  const handleScanBarcodePhoto = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setScanningFile(true);
    setCameraError(null);
    setScanFeedback(null);

    try {
      const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import(
        'html5-qrcode'
      );
      const fileScanner = new Html5Qrcode(fileScanRegionId, {
        verbose: false,
        formatsToSupport: [
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A,
          Html5QrcodeSupportedFormats.UPC_E,
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39,
          Html5QrcodeSupportedFormats.CODE_93,
          Html5QrcodeSupportedFormats.ITF,
          Html5QrcodeSupportedFormats.QR_CODE,
        ],
      });
      const decodedText = await fileScanner.scanFile(file, false);
      try {
        fileScanner.clear();
      } catch {
        // ignore clear error
      }
      if (decodedText && decodedText.trim()) {
        handleResolvedCode(decodedText, 'photo');
      } else {
        setScanFeedback({
          tone: 'err',
          text: 'Barcode tidak terbaca dari foto. Pastikan foto barcode jelas & tidak buram.',
        });
      }
    } catch {
      setScanFeedback({
        tone: 'err',
        text: 'Barcode tidak terdeteksi di foto tersebut. Coba foto lebih dekat/terang atau ketik kode barcode langsung.',
      });
    } finally {
      setScanningFile(false);
    }
  };

  const filteredMatches = useMemo(() => {
    const q = queryText.trim().toLowerCase();
    if (!q) return [];
    return products
      .filter((p) => {
        const name = (p.name || '').toLowerCase();
        const barcode = (p.barcode || '').toLowerCase();
        const sku = (p.sku || '').toLowerCase();
        const cat = (p.category || '').toLowerCase();
        return (
          name.includes(q) ||
          barcode.includes(q) ||
          sku.includes(q) ||
          cat.includes(q)
        );
      })
      .slice(0, 8);
  }, [products, queryText]);

  const selectedProduct = useMemo(
    () => products.find((p) => p.id === selectedProductId) || null,
    [products, selectedProductId]
  );

  const selectedExtraLabel = selectedProduct
    ? getItemExtraLabel?.(selectedProduct) ?? null
    : null;

  return (
    <div className="p-4 bg-blue-50/70 border border-blue-200 rounded-xl space-y-3">
      {/* Hidden mount node for photo barcode scanning */}
      <div id={fileScanRegionId} className="hidden" aria-hidden="true" />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleScanBarcodePhoto}
        className="hidden"
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-0.5 min-w-0">
          <span className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-bold text-blue-950">
            <ScanBarcode className="w-4 h-4 text-blue-700 shrink-0" />
            <span>{title}</span>
          </span>
          {subtitle && (
            <p className="text-xs text-slate-600 leading-relaxed">{subtitle}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={scanningFile}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-800 bg-white hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
          >
            <ImagePlus className="w-3.5 h-3.5 shrink-0" />
            <span>{scanningFile ? 'Membaca Foto...' : 'Scan Foto Barcode'}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              if (cameraOpen) {
                void stopCamera();
              } else {
                void startCamera();
              }
            }}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
              cameraOpen
                ? 'bg-rose-600 hover:bg-rose-700 text-white'
                : 'bg-blue-700 hover:bg-blue-800 text-white'
            }`}
          >
            {cameraOpen ? (
              <>
                <X className="w-3.5 h-3.5 shrink-0" />
                <span>Tutup Kamera</span>
              </>
            ) : (
              <>
                <Camera className="w-3.5 h-3.5 shrink-0" />
                <span>Scan Kamera</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* USB / Bluetooth Barcode Scanner Input & Instant Product Search */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            ref={inputRef}
            type="text"
            value={queryText}
            onChange={(e) => {
              setQueryText(e.target.value);
              if (scanFeedback) setScanFeedback(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (queryText.trim()) {
                  const direct = findProductByScanCode(products, queryText);
                  if (direct) {
                    handleResolvedCode(queryText, 'manual');
                  } else if (filteredMatches.length === 1) {
                    playScanSuccessBeep();
                    onSelectProduct(filteredMatches[0]);
                    setQueryText('');
                    setScanFeedback({
                      tone: 'ok',
                      text: `Produk dipilih: ${filteredMatches[0].name}`,
                    });
                  } else {
                    handleResolvedCode(queryText, 'manual');
                  }
                }
              }
            }}
            placeholder="Scan barcode USB/Bluetooth (tekan Enter) atau ketik nama / barcode / SKU item..."
            className="w-full pl-9 pr-3 py-2 text-xs sm:text-sm bg-white border border-blue-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
          />
        </div>
        {queryText.trim() && (
          <button
            type="button"
            onClick={() => handleResolvedCode(queryText, 'manual')}
            className="px-3 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg cursor-pointer whitespace-nowrap shrink-0"
          >
            Cari / Pilih
          </button>
        )}
      </div>

      {/* Live Camera Viewport */}
      {cameraOpen && (
        <div className="space-y-2">
          <div className="relative overflow-hidden rounded-lg border border-blue-300 bg-slate-950 min-h-[190px]">
            <div id={scannerRegionId} className="w-full" />
            {cameraStarting && !cameraError && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80 text-white text-xs font-medium">
                Menghidupkan kamera scanner...
              </div>
            )}
          </div>
          {cameraError ? (
            <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
              <span>{cameraError}</span>
            </div>
          ) : (
            <p className="text-[11px] text-blue-900">
              Arahkan kamera ke barcode kemasan produk (EAN-13, EAN-8, UPC, Code-128, atau QR). Produk otomatis terpilih begitu barcode terbaca.
            </p>
          )}
        </div>
      )}

      {/* Instant Search Match List */}
      {filteredMatches.length > 0 && (
        <div className="bg-white border border-blue-200 rounded-lg divide-y divide-slate-100 max-h-56 overflow-y-auto shadow-sm">
          {filteredMatches.map((item) => {
            const isChosen = item.id === selectedProductId;
            const extra = getItemExtraLabel?.(item) ?? null;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onSelectProduct(item);
                  setQueryText('');
                  setScanFeedback({
                    tone: 'ok',
                    text: `Produk dipilih: ${item.name}${
                      item.barcode ? ` (BC: ${item.barcode})` : ''
                    }`,
                  });
                }}
                className={`w-full px-3 py-2 flex items-center justify-between gap-2.5 text-left hover:bg-blue-50 transition-colors cursor-pointer ${
                  isChosen ? 'bg-emerald-50/70' : ''
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-md bg-slate-100 border border-slate-200 overflow-hidden shrink-0 flex items-center justify-center">
                    <ProductImage
                      src={item.imageUrl}
                      alt={item.name}
                      className="w-full h-full object-contain"
                    />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-slate-900 truncate">
                      {item.name}
                    </p>
                    <p className="text-[11px] font-mono text-slate-500 truncate">
                      {item.barcode ? `BC: ${item.barcode} · ` : ''}
                      {formatPrimaryAmount(item.price, masterConfig)} · Stok {item.stock}{' '}
                      {normalizeProductUnit(item.unit)}
                      {extra ? ` · ${extra}` : ''}
                    </p>
                  </div>
                </div>
                <span className="text-[11px] font-semibold text-blue-700 shrink-0">
                  {isChosen ? 'Terpilih' : 'Pilih'}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Scan Feedback Message */}
      {scanFeedback && (
        <div
          className={`p-2.5 rounded-lg border text-xs font-medium flex items-start gap-2 ${
            scanFeedback.tone === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-rose-50 border-rose-200 text-rose-700'
          }`}
        >
          {scanFeedback.tone === 'ok' ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
          )}
          <span>{scanFeedback.text}</span>
        </div>
      )}

      {/* Selected Product Quick Preview + Optional 1-Click Promote CTA */}
      {selectedProduct && (
        <div className="p-3 bg-white border border-slate-200 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div className="w-11 h-11 rounded-md bg-slate-50 border border-slate-200 overflow-hidden shrink-0 flex items-center justify-center">
              <ProductImage
                src={selectedProduct.imageUrl}
                alt={selectedProduct.name}
                className="w-full h-full object-contain"
              />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs sm:text-sm font-bold text-slate-900 truncate">
                {selectedProduct.name}
              </p>
              <p className="text-[11px] font-mono text-slate-600 truncate">
                {selectedProduct.barcode
                  ? `Barcode: ${selectedProduct.barcode} · `
                  : ''}
                {formatPrimaryAmount(selectedProduct.price, masterConfig)} · Stok{' '}
                {selectedProduct.stock} {normalizeProductUnit(selectedProduct.unit)}
                {selectedExtraLabel ? ` · ${selectedExtraLabel}` : ''}
              </p>
            </div>
          </div>

          {(onPrimaryAction || onSecondaryAction) && (
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {onSecondaryAction && secondaryActionLabel && (
                <button
                  type="button"
                  onClick={() => onSecondaryAction(selectedProduct)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg cursor-pointer whitespace-nowrap"
                >
                  <span>{secondaryActionLabel}</span>
                </button>
              )}
              {onPrimaryAction && primaryActionLabel && (
                <button
                  type="button"
                  onClick={() => onPrimaryAction(selectedProduct)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg cursor-pointer whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5 shrink-0" />
                  <span>{primaryActionLabel}</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

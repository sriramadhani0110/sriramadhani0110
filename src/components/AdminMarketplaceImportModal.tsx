import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  FileSpreadsheet,
  Image as ImageIcon,
  RefreshCw,
  Upload,
  X,
} from 'lucide-react';
import type { Product, StoreCategory } from '../types/marketplace';
import { convertUsdToKhr, formatKHR, formatUSD } from '../lib/catalogSeed';
import {
  buildMarketplaceImportTemplateCsv,
  DEFAULT_CURRENCY_TO_USD_RATES,
  mergeExternalProductsToFirestore,
  parseExternalMarketplaceDatabase,
  type BulkMergeResult,
  type DuplicateImportStrategy,
  type ImportSourceCurrency,
  type ParseMarketplaceDatabaseResult,
} from '../lib/marketplaceBulkImport';

interface AdminMarketplaceImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  existingProducts: Product[];
  existingCategories: StoreCategory[];
  exchangeRateKhr?: number;
  onImportComplete: (result: BulkMergeResult, filterNeedsImage: boolean) => void;
}

const CURRENCY_LABELS: Record<ImportSourceCurrency, string> = {
  USD: 'USD ($) — Harga sudah dalam Dolar AS',
  IDR: 'IDR (Rp) — Rupiah Indonesia (Shopee/Tokopedia/Lazada ID)',
  KHR: 'KHR (Riel) — Riel Kamboja',
  THB: 'THB (฿) — Baht Thailand',
  MYR: 'MYR (RM) — Ringgit Malaysia',
};

export function AdminMarketplaceImportModal({
  isOpen,
  onClose,
  existingProducts,
  existingCategories,
  exchangeRateKhr,
  onImportComplete,
}: AdminMarketplaceImportModalProps) {
  const [rawText, setRawText] = useState('');
  const [fileName, setFileName] = useState('');
  const [sourceCurrency, setSourceCurrency] = useState<ImportSourceCurrency>('IDR');
  const [conversionRate, setConversionRate] = useState<string>(
    String(DEFAULT_CURRENCY_TO_USD_RATES.IDR)
  );
  const [duplicateStrategy, setDuplicateStrategy] =
    useState<DuplicateImportStrategy>('price_stock_only');
  const [preserveExistingPhotos, setPreserveExistingPhotos] = useState(true);
  const [defaultCategory, setDefaultCategory] = useState<string>(
    existingCategories[0]?.name || 'Kebutuhan Harian'
  );
  const [parseError, setParseError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [mergeResult, setMergeResult] = useState<BulkMergeResult | null>(null);

  const parsedResult: ParseMarketplaceDatabaseResult | null = useMemo(() => {
    if (!rawText.trim()) return null;
    try {
      const rateNum = Number.parseFloat(conversionRate.replace(',', '.'));
      return parseExternalMarketplaceDatabase({
        rawText,
        existingProducts,
        sourceCurrency,
        conversionRateToUsd: Number.isFinite(rateNum) && rateNum > 0 ? rateNum : 1,
        defaultCategory,
        preserveExistingPhotos,
      });
    } catch {
      return null;
    }
  }, [rawText, existingProducts, sourceCurrency, conversionRate, defaultCategory, preserveExistingPhotos]);

  if (!isOpen) return null;

  const handleCurrencyChange = (nextCurrency: ImportSourceCurrency) => {
    setSourceCurrency(nextCurrency);
    setConversionRate(String(DEFAULT_CURRENCY_TO_USD_RATES[nextCurrency]));
  };

  const handleFileSelected = (file: File | null) => {
    if (!file) return;
    setParseError(null);
    setMergeResult(null);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      if (!text.trim()) {
        setParseError('File kosong atau tidak dapat dibaca. Gunakan file .CSV, .TSV, atau .JSON.');
        return;
      }
      try {
        const rateNum = Number.parseFloat(conversionRate.replace(',', '.'));
        const testParse = parseExternalMarketplaceDatabase({
          rawText: text,
          existingProducts,
          sourceCurrency,
          conversionRateToUsd: Number.isFinite(rateNum) && rateNum > 0 ? rateNum : 1,
          defaultCategory,
          preserveExistingPhotos,
        });
        if (testParse.detectedAlpamartExport && sourceCurrency !== 'USD') {
          setSourceCurrency('USD');
          setConversionRate('1');
        }
        if (testParse.items.length === 0) {
          setParseError(
            'Tidak ditemukan baris produk yang valid. Pastikan ada kolom Nama Produk / Title / Name di baris header file Anda.'
          );
        }
        setRawText(text);
      } catch (err) {
        setParseError(
          err instanceof Error
            ? `Gagal membaca format file: ${err.message}`
            : 'Format file tidak valid. Pastikan memakai ekspor CSV/TSV/JSON.'
        );
      }
    };
    reader.onerror = () => {
      setParseError('Gagal membaca file dari perangkat Anda.');
    };
    reader.readAsText(file, 'utf-8');
  };

  const handleDownloadTemplate = () => {
    const csv = buildMarketplaceImportTemplateCsv();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'template_database_marketplace_alpamart.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExecuteImport = async () => {
    if (!parsedResult || parsedResult.items.length === 0) return;
    setImporting(true);
    setParseError(null);
    setProgress({ done: 0, total: parsedResult.items.length });

    try {
      const result = await mergeExternalProductsToFirestore({
        items: parsedResult.items,
        existingCategories,
        duplicateStrategy,
        exchangeRateKhr,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setMergeResult(result);
    } catch (err) {
      setParseError(
        err instanceof Error
          ? `Gagal menggabungkan database ke Firestore: ${err.message}`
          : 'Gagal menggabungkan database produk.'
      );
    } finally {
      setImporting(false);
    }
  };

  const insertCount = parsedResult
    ? parsedResult.items.filter((i) => i.action === 'insert').length
    : 0;
  const updateCount = parsedResult
    ? parsedResult.items.filter((i) => i.action === 'update').length
    : 0;
  const needsPhotoCount = parsedResult
    ? parsedResult.items.filter((i) => i.needsImage).length
    : 0;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 no-print"
      role="dialog"
      aria-modal="true"
      aria-label="Gabungkan Database Marketplace Lain"
    >
      <div className="bg-white border border-slate-200 rounded-xl max-w-4xl w-full max-h-[92dvh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4 bg-slate-50/70">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-blue-700 text-white flex items-center justify-center shrink-0">
              <Database className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="font-display text-base sm:text-lg font-bold text-slate-900 truncate">
                Gabungkan Database Marketplace Lain (Otomatis)
              </h3>
              <p className="text-xs text-slate-600 truncate">
                Impor massal dari Shopee, Tokopedia, Lazada, TikTok Shop, Excel CSV, atau JSON — tanpa daftar satu per satu, tinggal edit gambar.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup modal impor"
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-200/70 cursor-pointer shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {mergeResult ? (
            <div className="p-5 bg-emerald-50 border border-emerald-200 rounded-xl space-y-4">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="w-6 h-6 text-emerald-600 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <h4 className="text-base font-bold text-emerald-950">
                    Database Marketplace Berhasil Digabungkan!
                  </h4>
                  <p className="text-xs text-emerald-900 leading-relaxed">
                    Seluruh produk otomatis tersimpan permanen di katalog ALPAMART TRIMULIA ONLINE.
                    Sekarang Anda cukup klik tombol <strong>Edit Gambar</strong> pada produk yang membutuhkan foto.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3 bg-white border border-emerald-200 rounded-lg">
                  <p className="text-[11px] font-semibold text-slate-500">Produk Baru</p>
                  <p className="font-mono text-xl font-bold text-emerald-700">
                    +{mergeResult.insertedCount}
                  </p>
                </div>
                <div className="p-3 bg-white border border-emerald-200 rounded-lg">
                  <p className="text-[11px] font-semibold text-slate-500">Diperbarui</p>
                  <p className="font-mono text-xl font-bold text-blue-700">
                    {mergeResult.updatedCount}
                  </p>
                </div>
                <div className="p-3 bg-white border border-emerald-200 rounded-lg">
                  <p className="text-[11px] font-semibold text-slate-500">Kategori Baru</p>
                  <p className="font-mono text-xl font-bold text-slate-800">
                    +{mergeResult.createdCategories.length}
                  </p>
                </div>
                <div className="p-3 bg-white border border-amber-200 rounded-lg">
                  <p className="text-[11px] font-semibold text-amber-700">Siap Edit Gambar</p>
                  <p className="font-mono text-xl font-bold text-amber-700">
                    {mergeResult.needsImageCount}
                  </p>
                </div>
              </div>

              {mergeResult.preservedPhotoCount > 0 && (
                <div className="p-3 bg-white border border-emerald-200 rounded-lg text-xs text-emerald-900">
                  <strong>Perlindungan Foto Aktif:</strong> Sebanyak{' '}
                  <strong className="font-mono">{mergeResult.preservedPhotoCount}</strong> foto produk yang sudah terdaftar di katalog Anda tetap aman dan tidak terhapus.
                </div>
              )}

              <div className="flex flex-wrap items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    onImportComplete(mergeResult, false);
                    onClose();
                  }}
                  className="px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  Lihat Semua Katalog
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onImportComplete(mergeResult, true);
                    onClose();
                  }}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-red-600 rounded-lg cursor-pointer"
                >
                  <ImageIcon className="w-4 h-4" />
                  <span>Langsung Edit Gambar Produk ({mergeResult.needsImageCount})</span>
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Step 1: Upload File or Paste */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="p-4 border-2 border-dashed border-blue-200 bg-blue-50/40 rounded-xl space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                      <FileSpreadsheet className="w-4 h-4 text-blue-700" />
                      1. Unggah File Database (.CSV / .TSV / .JSON)
                    </span>
                    <button
                      type="button"
                      onClick={handleDownloadTemplate}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 hover:underline cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Template CSV
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-600 leading-relaxed">
                    Ekspor daftar produk dari Shopee, Tokopedia, Lazada, TikTok Shop, atau Excel (Simpan sebagai <strong>CSV UTF-8</strong> / <strong>JSON</strong>). Kolom gambar boleh kosong — nanti tinggal edit gambarnya saja!
                  </p>
                  <label className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 text-xs font-semibold text-white bg-blue-700 hover:bg-red-600 rounded-lg transition-colors cursor-pointer">
                    <Upload className="w-4 h-4" />
                    <span>
                      {fileName ? `Ganti File (${fileName})` : 'Pilih File Database Marketplace'}
                    </span>
                    <input
                      type="file"
                      accept=".csv,.tsv,.txt,.json,text/csv,application/json"
                      className="sr-only"
                      onChange={(e) => handleFileSelected(e.target.files?.[0] || null)}
                    />
                  </label>
                </div>

                {/* Settings */}
                <div className="p-4 border border-slate-200 bg-slate-50/70 rounded-xl space-y-3">
                  <span className="text-xs font-bold text-slate-900 block">
                    2. Pengaturan Konversi Harga &amp; Penggabungan
                  </span>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Mata Uang di File Sumber
                      </label>
                      <select
                        value={sourceCurrency}
                        onChange={(e) =>
                          handleCurrencyChange(e.target.value as ImportSourceCurrency)
                        }
                        className="w-full px-2.5 py-2 text-xs bg-white border border-slate-300 rounded-lg text-slate-900"
                      >
                        {(Object.keys(CURRENCY_LABELS) as ImportSourceCurrency[]).map((code) => (
                          <option key={code} value={code}>
                            {CURRENCY_LABELS[code]}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        {sourceCurrency === 'USD'
                          ? 'Kurs (1 USD = 1 USD)'
                          : `Kurs Konversi (1 USD = ... ${sourceCurrency})`}
                      </label>
                      <input
                        type="number"
                        step="any"
                        min={0.01}
                        disabled={sourceCurrency === 'USD'}
                        value={conversionRate}
                        onChange={(e) => setConversionRate(e.target.value)}
                        className="w-full px-2.5 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg text-slate-900 disabled:bg-slate-100"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Jika Produk / SKU / Nama Sudah Ada
                      </label>
                      <select
                        value={duplicateStrategy}
                        onChange={(e) =>
                          setDuplicateStrategy(e.target.value as DuplicateImportStrategy)
                        }
                        className="w-full px-2.5 py-2 text-xs bg-white border border-slate-300 rounded-lg text-slate-900"
                      >
                        <option value="price_stock_only">
                          Jangan Double · Update Harga &amp; Stok Saja (Sesuai CSV)
                        </option>
                        <option value="update">
                          Update Semua Data (Pertahankan Foto Lama)
                        </option>
                        <option value="skip">
                          Lewati Produk yang Sudah Ada
                        </option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Kategori Default (jika kosong)
                      </label>
                      <input
                        type="text"
                        maxLength={60}
                        value={defaultCategory}
                        onChange={(e) => setDefaultCategory(e.target.value)}
                        className="w-full px-2.5 py-2 text-xs bg-white border border-slate-300 rounded-lg text-slate-900"
                      />
                    </div>
                  </div>

                  <div className="p-2.5 bg-blue-50 border border-blue-200 rounded-lg text-[11px] text-blue-950 leading-relaxed">
                    <strong>Anti-Double &amp; Stok Persis File Excel/CSV:</strong> Item yang sudah terdaftar di katalog <strong>tidak akan dimasukkan ulang (tidak double)</strong> — hanya <strong>Harga &amp; Stok</strong> yang diperbarui. Stok mengikuti angka persis dari file impor (contoh: stok lama 20, file CSV 50 → otomatis jadi <strong>50</strong>, bukan ditambah jadi 70).
                  </div>

                  <label className="flex items-start gap-2 p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-[11px] text-emerald-950 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={preserveExistingPhotos}
                      onChange={(e) => setPreserveExistingPhotos(e.target.checked)}
                      className="mt-0.5 accent-emerald-700"
                    />
                    <span>
                      <strong>Lindungi Foto Terdaftar:</strong> Jangan hapus atau timpa foto produk yang sudah ada di katalog Anda saat impor database.
                    </span>
                  </label>
                </div>
              </div>

              {/* Optional Paste Box */}
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-slate-700">
                  Atau Tempel Langsung Data CSV / Tab dari Excel / JSON Marketplace:
                </label>
                <textarea
                  rows={3}
                  value={rawText}
                  onChange={(e) => {
                    setParseError(null);
                    setRawText(e.target.value);
                  }}
                  placeholder={`Contoh CSV:\nSKU,Nama Produk,Kategori,Harga,Stok,Satuan\nSP-001,Kopi Susu Kaleng,Minuman,16000,50,PCS`}
                  className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-700"
                />
              </div>

              {parseError && (
                <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2 text-xs text-red-800">
                  <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                  <p>{parseError}</p>
                </div>
              )}

              {/* Preview Table */}
              {parsedResult && parsedResult.items.length > 0 && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="font-bold text-slate-900">
                        Pratinjau: {parsedResult.items.length} Produk Terdeteksi (
                        {parsedResult.detectedFormat.toUpperCase()})
                      </span>
                      <span className="font-mono font-semibold text-emerald-700">
                        +{insertCount} Baru
                      </span>
                      <span className="font-mono font-semibold text-blue-700">
                        {updateCount}{' '}
                        {duplicateStrategy === 'price_stock_only'
                          ? 'Update Harga & Stok (Tidak Double)'
                          : duplicateStrategy === 'skip'
                            ? 'Dilewati'
                            : 'Update'}
                      </span>
                      {parsedResult.duplicateRowsInFileCount > 0 && (
                        <span className="font-mono font-semibold text-amber-700">
                          {parsedResult.duplicateRowsInFileCount} Baris Dobel di File Digabung
                        </span>
                      )}
                      <span className="font-mono font-semibold text-amber-700">
                        {needsPhotoCount} Siap Edit Gambar
                      </span>
                      {parsedResult.preservedPhotoCount > 0 && (
                        <span className="font-mono font-semibold text-emerald-700">
                          {parsedResult.preservedPhotoCount} Foto Terdaftar Dilindungi
                        </span>
                      )}
                    </div>
                    {parsedResult.skippedRows.length > 0 && (
                      <span className="text-[11px] text-amber-700 font-medium">
                        {parsedResult.skippedRows.length} baris kosong dilewati
                      </span>
                    )}
                  </div>

                  <div className="overflow-x-auto border border-slate-200 rounded-lg max-h-64">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead className="bg-slate-50 border-b border-slate-200 sticky top-0 text-slate-600">
                        <tr>
                          <th className="py-2 px-3">Aksi</th>
                          <th className="py-2 px-3">Nama Produk</th>
                          <th className="py-2 px-3">SKU</th>
                          <th className="py-2 px-3">Kategori</th>
                          <th className="py-2 px-3 text-right">Harga (USD / KHR)</th>
                          <th className="py-2 px-3 text-right">Stok (Ganti Persis)</th>
                          <th className="py-2 px-3">Foto</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {parsedResult.items.slice(0, 60).map((item) => (
                          <tr key={`${item.sku}_${item.rowIndex}`} className="hover:bg-slate-50">
                            <td className="py-2 px-3 whitespace-nowrap">
                              <span
                                className={`px-1.5 py-0.5 rounded font-mono text-[10px] font-bold ${
                                  item.action === 'insert'
                                    ? 'bg-emerald-100 text-emerald-800'
                                    : duplicateStrategy === 'skip'
                                      ? 'bg-slate-100 text-slate-500'
                                      : 'bg-blue-100 text-blue-800'
                                }`}
                              >
                                {item.action === 'insert'
                                  ? 'BARU'
                                  : duplicateStrategy === 'skip'
                                    ? 'LEWATI'
                                    : duplicateStrategy === 'price_stock_only'
                                      ? 'HARGA & STOK'
                                      : 'UPDATE'}
                              </span>
                            </td>
                            <td className="py-2 px-3 font-medium text-slate-900 max-w-[200px] truncate">
                              {item.name}
                            </td>
                            <td className="py-2 px-3 font-mono text-slate-600">{item.sku}</td>
                            <td className="py-2 px-3 text-slate-600">{item.category}</td>
                            <td className="py-2 px-3 text-right font-mono whitespace-nowrap">
                              {item.existingMatchId &&
                                item.existingPriceUsd !== undefined &&
                                item.existingPriceUsd !== item.priceUsd && (
                                  <span className="text-[10px] text-slate-400 line-through block">
                                    {formatUSD(item.existingPriceUsd)}
                                  </span>
                                )}
                              <span className="font-bold text-blue-700">
                                {formatUSD(item.priceUsd)}
                              </span>
                              <span className="text-[10px] text-slate-500 block">
                                {formatKHR(
                                  Math.round(item.priceUsd * (exchangeRateKhr || convertUsdToKhr(1)))
                                )}
                              </span>
                            </td>
                            <td className="py-2 px-3 text-right font-mono whitespace-nowrap">
                              {item.existingMatchId &&
                              item.existingStock !== undefined &&
                              item.existingStock !== item.stock ? (
                                <span>
                                  <span className="text-slate-400 line-through mr-1">
                                    {item.existingStock}
                                  </span>
                                  <span className="font-bold text-emerald-700">
                                    → {item.stock}
                                  </span>{' '}
                                  <span className="text-slate-500">{item.unit}</span>
                                </span>
                              ) : (
                                <span>
                                  {item.stock} {item.unit}
                                </span>
                              )}
                            </td>
                            <td className="py-2 px-3 whitespace-nowrap">
                              {item.existingMatchId && duplicateStrategy === 'price_stock_only' ? (
                                <span className="text-[11px] font-semibold text-emerald-700">
                                  Data &amp; Foto Tetap
                                </span>
                              ) : item.preservedExistingPhoto ? (
                                <span className="text-[11px] font-semibold text-emerald-700">
                                  Foto Lama Aman
                                </span>
                              ) : item.needsImage ? (
                                <span className="text-[11px] font-semibold text-amber-700">
                                  Siap Edit Gambar
                                </span>
                              ) : (
                                <span className="text-[11px] font-semibold text-blue-700">
                                  Foto dari File
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {parsedResult.items.length > 60 && (
                      <p className="p-2 text-center text-[11px] text-slate-500 bg-slate-50 border-t border-slate-200">
                        Menampilkan 60 dari {parsedResult.items.length} produk yang siap digabungkan.
                      </p>
                    )}
                  </div>
                </div>
              )}

              {importing && progress && (
                <div className="p-3.5 bg-blue-50 border border-blue-200 rounded-lg space-y-2">
                  <div className="flex items-center justify-between text-xs font-semibold text-blue-900">
                    <span className="inline-flex items-center gap-1.5">
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      Menggabungkan database produk ke Firestore...
                    </span>
                    <span className="font-mono">
                      {progress.done} / {progress.total}
                    </span>
                  </div>
                  <div className="w-full h-2 bg-blue-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-700 transition-all duration-300"
                      style={{
                        width: `${Math.min(100, Math.round((progress.done / Math.max(1, progress.total)) * 100))}%`,
                      }}
                    />
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {!mergeResult && (
          <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-3">
            <p className="text-[11px] text-slate-500">
              Data transaksi &amp; pesanan pelanggan tidak akan terpengaruh saat penggabungan katalog.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={importing}
                onClick={onClose}
                className="px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 cursor-pointer disabled:opacity-50"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={importing || !parsedResult || parsedResult.items.length === 0}
                onClick={() => void handleExecuteImport()}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-bold text-white bg-blue-700 hover:bg-red-600 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
              >
                <Database className="w-4 h-4" />
                <span>
                  {importing
                    ? 'Menggabungkan...'
                    : `Gabungkan ${parsedResult?.items.length || 0} Produk Sekarang`}
                </span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

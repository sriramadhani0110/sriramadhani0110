import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Eye,
  EyeOff,
  Grid2x2,
  Image as ImageIcon,
  Layers,
  Link2,
  Maximize2,
  RotateCcw,
  Save,
  Sparkles,
  Upload,
} from 'lucide-react';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import type {
  BackgroundDisplayMode,
  StoreBackgroundConfig,
} from '../types/marketplace';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import {
  BACKGROUND_IMAGE_PRESETS,
  clampBackgroundOpacity,
  compressImageFileToDataUrl,
  DEFAULT_BACKGROUND_IMAGE_URL,
  DEFAULT_STORE_BACKGROUND_CONFIG,
} from '../lib/storeDefaults';
import { broadcastCrossTabEvent } from '../lib/crossAccountSync';
import { PortalBackgroundLayer } from './PortalBackgroundLayer';

interface AdminBackgroundSettingsPanelProps {
  backgroundConfig: StoreBackgroundConfig;
  adminEmail: string;
  baseThemeClassName?: string;
  onNotify?: (message: string) => void;
}

const DISPLAY_MODE_OPTIONS: ReadonlyArray<{
  mode: BackgroundDisplayMode;
  label: string;
  description: string;
  icon: typeof ImageIcon;
}> = [
  {
    mode: 'watermark_center',
    label: 'Logo Tengah (Watermark)',
    description: 'Menampilkan gambar rapi di tengah layar agar tulisan tetap tajam & mudah dibaca.',
    icon: Sparkles,
  },
  {
    mode: 'watermark_tile',
    label: 'Pola Berulang (Tile)',
    description: 'Menyusun gambar berulang secara simetris di seluruh layar semua akun.',
    icon: Grid2x2,
  },
  {
    mode: 'cover',
    label: 'Penuh Layar (Full Cover)',
    description: 'Mengisi seluruh latar belakang layar penuh dari ujung ke ujung.',
    icon: Maximize2,
  },
];

const QUICK_OPACITY_STEPS = [10, 15, 20, 30, 45, 65] as const;

export function AdminBackgroundSettingsPanel({
  backgroundConfig,
  adminEmail,
  baseThemeClassName,
  onNotify,
}: AdminBackgroundSettingsPanelProps) {
  const [draft, setDraft] = useState<StoreBackgroundConfig>(() => ({
    ...backgroundConfig,
  }));
  const [urlInput, setUrlInput] = useState<string>(
    backgroundConfig.imageUrl.startsWith('data:') ? '' : backgroundConfig.imageUrl
  );
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDraft({ ...backgroundConfig });
    setUrlInput(
      backgroundConfig.imageUrl.startsWith('data:') ? '' : backgroundConfig.imageUrl
    );
  }, [
    backgroundConfig.imageUrl,
    backgroundConfig.displayMode,
    backgroundConfig.opacity,
    backgroundConfig.enabled,
  ]);

  const handleUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setUploading(true);
    setFeedback(null);
    try {
      const dataUrl = await compressImageFileToDataUrl(file, {
        maxWidth: 1280,
        maxHeight: 1280,
        maxChars: 235000,
        initialQuality: 0.84,
      });
      setDraft((prev) => ({
        ...prev,
        imageUrl: dataUrl,
        enabled: true,
      }));
      setUrlInput('');
      setFeedback({
        type: 'success',
        text: 'Gambar latar berhasil dimuat. Klik "Simpan & Terapkan ke Semua Akun" agar langsung tampil di semua portal.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Gagal memproses gambar latar. Coba pilih file JPG/PNG/WebP lain.',
      });
    } finally {
      setUploading(false);
    }
  };

  const handleApplyUrl = () => {
    const trimmed = urlInput.trim();
    if (!trimmed) {
      setFeedback({
        type: 'error',
        text: 'Masukkan alamat URL gambar (diawali https:// atau /) terlebih dahulu.',
      });
      return;
    }
    if (!trimmed.startsWith('https://') && !trimmed.startsWith('/')) {
      setFeedback({
        type: 'error',
        text: 'URL gambar harus diawali https:// atau path lokal /assets/...',
      });
      return;
    }
    if (trimmed.length > 1000) {
      setFeedback({
        type: 'error',
        text: 'URL gambar terlalu panjang (maksimal 1000 karakter). Gunakan tombol Unggah Gambar dari HP/PC.',
      });
      return;
    }
    setDraft((prev) => ({
      ...prev,
      imageUrl: trimmed,
      enabled: true,
    }));
    setFeedback({
      type: 'success',
      text: 'URL gambar diterapkan ke pratinjau. Klik "Simpan & Terapkan ke Semua Akun" untuk menyimpan.',
    });
  };

  const handleSaveBackground = async (overrideDraft?: StoreBackgroundConfig) => {
    const target = overrideDraft ?? draft;
    const safeImageUrl = target.imageUrl.trim();
    const safeOpacity = clampBackgroundOpacity(target.opacity, 20);
    const safeUpdater = (adminEmail || 'admin@alpamart.local').trim().slice(0, 128);

    if (
      safeImageUrl &&
      !safeImageUrl.startsWith('https://') &&
      !safeImageUrl.startsWith('/') &&
      !/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(safeImageUrl)
    ) {
      setFeedback({
        type: 'error',
        text: 'Format gambar tidak didukung. Gunakan file unggahan JPG/PNG/WebP atau URL https://.',
      });
      return;
    }

    if (safeImageUrl.length > 249000) {
      setFeedback({
        type: 'error',
        text: 'Ukuran data gambar melebihi batas database. Unggah ulang melalui tombol "Pilih Gambar dari HP / PC".',
      });
      return;
    }

    setSaving(true);
    setFeedback(null);
    try {
      await setDoc(doc(db, 'storeConfig', 'background'), {
        id: 'background',
        imageUrl: safeImageUrl,
        displayMode: target.displayMode,
        opacity: safeOpacity,
        enabled: Boolean(target.enabled),
        updatedBy: safeUpdater.length >= 2 ? safeUpdater : 'admin',
        updatedAt: serverTimestamp(),
      });

      broadcastCrossTabEvent({
        type: 'revision_broadcast',
        source: 'background_config_updated',
      });

      const msg =
        'Background latar berhasil disimpan & otomatis diperbarui di semua akun (Pelanggan, Delivery, Admin & Master Data).';
      setFeedback({ type: 'success', text: msg });
      onNotify?.(msg);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'storeConfig/background');
      setFeedback({
        type: 'error',
        text: 'Gagal menyimpan background ke database. Pastikan akun Anda sudah login sebagai Admin terverifikasi.',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleResetDefault = async () => {
    const resetConfig: StoreBackgroundConfig = {
      ...DEFAULT_STORE_BACKGROUND_CONFIG,
      updatedBy: adminEmail || DEFAULT_STORE_BACKGROUND_CONFIG.updatedBy,
    };
    setDraft(resetConfig);
    setUrlInput(DEFAULT_BACKGROUND_IMAGE_URL);
    await handleSaveBackground(resetConfig);
  };

  const safeOpacity = clampBackgroundOpacity(draft.opacity, 20);
  const isDirty =
    draft.imageUrl !== backgroundConfig.imageUrl ||
    draft.displayMode !== backgroundConfig.displayMode ||
    safeOpacity !== clampBackgroundOpacity(backgroundConfig.opacity, 20) ||
    draft.enabled !== backgroundConfig.enabled;

  return (
    <div className="space-y-6">
      {/* Feedback Alert */}
      {feedback && (
        <div
          role="status"
          className={`rounded-xl border px-4 py-3 text-xs sm:text-sm font-medium flex items-start gap-2.5 ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-rose-50 border-rose-200 text-rose-900'
          }`}
        >
          <CheckCircle2
            className={`w-4 h-4 shrink-0 mt-0.5 ${
              feedback.type === 'success' ? 'text-emerald-600' : 'text-rose-600'
            }`}
          />
          <span>{feedback.text}</span>
        </div>
      )}

      {/* Top Info + Live Preview */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Left: Controls */}
        <div className="xl:col-span-7 bg-white/95 backdrop-blur-xs border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-6 shadow-xs">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4">
            <div>
              <p className="text-xs font-semibold text-blue-700 uppercase tracking-wider flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5" />
                <span>Pengaturan Khusus Background Semua Akun</span>
              </p>
              <h2 className="font-display text-lg font-bold text-slate-900 mt-1">
                Ganti Gambar Background Latar Belakang
              </h2>
              <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                Gambar latar yang disimpan di sini akan langsung tampil otomatis di <strong>4 akun sekaligus</strong>: Situs Pelanggan, Portal Delivery, Akun Admin, dan Portal Master Data.
              </p>
            </div>

            <button
              type="button"
              onClick={() =>
                setDraft((prev) => ({ ...prev, enabled: !prev.enabled }))
              }
              className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold border transition-colors cursor-pointer ${
                draft.enabled
                  ? 'bg-emerald-50 border-emerald-300 text-emerald-800 hover:bg-emerald-100'
                  : 'bg-slate-100 border-slate-300 text-slate-700 hover:bg-slate-200'
              }`}
            >
              {draft.enabled ? (
                <>
                  <Eye className="w-3.5 h-3.5" />
                  <span>Background Aktif</span>
                </>
              ) : (
                <>
                  <EyeOff className="w-3.5 h-3.5" />
                  <span>Background Nonaktif</span>
                </>
              )}
            </button>
          </div>

          {/* 1. Upload or URL */}
          <div className="space-y-3">
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-700">
              1. Pilih atau Unggah Gambar Background Baru
            </label>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleUploadFile}
              className="hidden"
            />

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                disabled={uploading || saving}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs sm:text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-xl transition-colors cursor-pointer disabled:opacity-60 shadow-xs"
              >
                <Upload className="w-4 h-4" />
                <span>
                  {uploading
                    ? 'Memproses Gambar...'
                    : 'Pilih Gambar dari HP / PC'}
                </span>
              </button>

              <button
                type="button"
                disabled={saving}
                onClick={handleResetDefault}
                className="inline-flex items-center justify-center gap-2 px-3.5 py-2.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-xl transition-colors cursor-pointer disabled:opacity-60"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Kembalikan Default AlpaMart TriMulia</span>
              </button>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1">
                <Link2 className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  placeholder="Atau tempel URL gambar https://... lalu klik Pakai URL"
                  className="w-full pl-9 pr-3 py-2 text-xs sm:text-sm bg-slate-50 border border-slate-300 rounded-xl text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:bg-white"
                />
              </div>
              <button
                type="button"
                onClick={handleApplyUrl}
                className="px-4 py-2 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-xl transition-colors cursor-pointer whitespace-nowrap"
              >
                Pakai URL
              </button>
            </div>
            <p className="text-[11px] text-slate-500">
              Mendukung JPG, PNG, WebP dari Galeri HP (iPhone/Android) maupun Laptop. Gambar dikompresi otomatis agar tetap ringan dan cepat dibuka pelanggan.
            </p>
          </div>

          {/* 2. Quick Presets */}
          <div className="space-y-2.5">
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-700">
              2. Pilihan Cepat Template Background
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {BACKGROUND_IMAGE_PRESETS.map((preset) => {
                const selected = draft.imageUrl === preset.imageUrl;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => {
                      setDraft((prev) => ({
                        ...prev,
                        imageUrl: preset.imageUrl,
                        displayMode: preset.recommendedMode,
                        opacity: preset.recommendedOpacity,
                        enabled: true,
                      }));
                      setUrlInput(preset.imageUrl);
                      setFeedback(null);
                    }}
                    className={`group text-left rounded-xl border p-2.5 transition-all cursor-pointer ${
                      selected
                        ? 'border-blue-600 bg-blue-50/70 ring-2 ring-blue-600/20'
                        : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    <div className="h-20 rounded-lg bg-slate-100 border border-slate-200 overflow-hidden flex items-center justify-center p-2 mb-2">
                      <img
                        src={preset.imageUrl}
                        alt={preset.label}
                        referrerPolicy="no-referrer"
                        className="max-h-full max-w-full object-contain"
                      />
                    </div>
                    <p className="text-xs font-bold text-slate-900 leading-snug">
                      {preset.label}
                    </p>
                    <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
                      {preset.description}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 3. Display Mode */}
          <div className="space-y-2.5">
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-700">
              3. Gaya Tampilan Background
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              {DISPLAY_MODE_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const active = draft.displayMode === opt.mode;
                return (
                  <button
                    key={opt.mode}
                    type="button"
                    onClick={() =>
                      setDraft((prev) => ({ ...prev, displayMode: opt.mode }))
                    }
                    className={`text-left p-3 rounded-xl border transition-all cursor-pointer ${
                      active
                        ? 'border-blue-600 bg-blue-50 text-blue-950 ring-2 ring-blue-600/15'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center gap-2 font-semibold text-xs">
                      <Icon
                        className={`w-4 h-4 shrink-0 ${
                          active ? 'text-blue-700' : 'text-slate-500'
                        }`}
                      />
                      <span>{opt.label}</span>
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                      {opt.description}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 4. Opacity Control */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="bg-opacity-range"
                className="text-xs font-bold uppercase tracking-wider text-slate-700"
              >
                4. Tingkat Kecerahan / Transparansi Gambar
              </label>
              <span className="font-mono text-xs font-bold text-blue-700 bg-blue-50 border border-blue-200 px-2.5 py-0.5 rounded-md">
                {safeOpacity}%
              </span>
            </div>
            <input
              id="bg-opacity-range"
              type="range"
              min={5}
              max={85}
              step={5}
              value={safeOpacity}
              onChange={(e) =>
                setDraft((prev) => ({
                  ...prev,
                  opacity: clampBackgroundOpacity(Number(e.target.value), 20),
                }))
              }
              className="w-full accent-blue-700 cursor-pointer"
            />
            <div className="flex flex-wrap items-center gap-1.5">
              {QUICK_OPACITY_STEPS.map((step) => (
                <button
                  key={step}
                  type="button"
                  onClick={() => setDraft((prev) => ({ ...prev, opacity: step }))}
                  className={`px-2.5 py-1 text-[11px] font-mono font-semibold rounded-lg border transition-colors cursor-pointer ${
                    safeOpacity === step
                      ? 'bg-blue-700 border-blue-700 text-white'
                      : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  {step}%
                </button>
              ))}
              <span className="text-[11px] text-slate-500 ml-1">
                Saran 15%–25% agar teks toko tetap kontras & nyaman dibaca.
              </span>
            </div>
          </div>

          {/* Save Button Bar */}
          <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-slate-500">
              {isDirty
                ? 'Ada perubahan yang belum disimpan.'
                : 'Background saat ini sudah tersinkron ke semua akun.'}
            </p>
            <button
              type="button"
              disabled={saving || uploading}
              onClick={() => handleSaveBackground()}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl transition-colors cursor-pointer disabled:opacity-60 shadow-sm"
            >
              <Save className="w-4 h-4" />
              <span>
                {saving
                  ? 'Menyimpan ke Semua Akun...'
                  : 'Simpan & Terapkan ke Semua Akun'}
              </span>
            </button>
          </div>
        </div>

        {/* Right: Live Preview Card */}
        <div className="xl:col-span-5 bg-white/95 backdrop-blur-xs border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-4 shadow-xs flex flex-col">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Pratinjau Langsung (Live Preview)
              </p>
              <h3 className="font-display text-base font-bold text-slate-900 mt-0.5">
                Tampilan di Semua Portal
              </h3>
            </div>
            <span className="text-[11px] font-mono font-semibold text-slate-600 bg-slate-100 border border-slate-200 px-2 py-1 rounded-md">
              4 Akun Sinkron
            </span>
          </div>

          {/* Interactive Mini Portal Preview */}
          <div className="relative rounded-2xl border border-slate-200 overflow-hidden min-h-[340px] flex-1 flex flex-col">
            <PortalBackgroundLayer
              config={draft}
              baseClassName={baseThemeClassName}
              previewMode={true}
            />

            {/* Mock foreground UI over the live background */}
            <div className="relative z-10 p-4 flex-1 flex flex-col justify-between gap-3">
              <div className="bg-white/90 backdrop-blur-xs border border-slate-200/90 rounded-xl px-3.5 py-2.5 flex items-center justify-between shadow-xs">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-md bg-red-600 text-white font-bold text-xs flex items-center justify-center">
                    A
                  </div>
                  <div>
                    <p className="text-xs font-bold text-slate-900 leading-none">
                      ALPAMART TRIMUIA
                    </p>
                    <p className="text-[10px] text-slate-500 mt-0.5">
                      Pelanggan · Delivery · Admin · Master
                    </p>
                  </div>
                </div>
                <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-md">
                  BUKA
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2.5 my-auto">
                <div className="bg-white/85 backdrop-blur-xs border border-slate-200/80 rounded-xl p-3 shadow-xs">
                  <p className="text-[10px] font-semibold text-blue-700 uppercase">
                    Kartu Katalog
                  </p>
                  <p className="text-xs font-bold text-slate-900 mt-1">
                    Produk &amp; Harga
                  </p>
                  <p className="text-[11px] text-slate-600 mt-0.5">
                    Latar terlihat halus di belakang kartu.
                  </p>
                </div>
                <div className="bg-white/85 backdrop-blur-xs border border-slate-200/80 rounded-xl p-3 shadow-xs">
                  <p className="text-[10px] font-semibold text-red-600 uppercase">
                    Portal Operasi
                  </p>
                  <p className="text-xs font-bold text-slate-900 mt-1">
                    Admin &amp; Kurir
                  </p>
                  <p className="text-[11px] text-slate-600 mt-0.5">
                    Kontras teks tetap tajam &amp; jelas.
                  </p>
                </div>
              </div>

              <div className="bg-slate-900/90 text-white rounded-xl px-3.5 py-2 text-[11px] flex items-center justify-between">
                <span>
                  Mode:{' '}
                  <strong>
                    {draft.displayMode === 'watermark_center'
                      ? 'Logo Tengah'
                      : draft.displayMode === 'watermark_tile'
                        ? 'Pola Berulang'
                        : 'Penuh Layar'}
                  </strong>
                </span>
                <span className="font-mono">
                  {draft.enabled ? `Transparansi ${safeOpacity}%` : 'Nonaktif'}
                </span>
              </div>
            </div>
          </div>

          <div className="rounded-xl bg-slate-50 border border-slate-200 p-3.5 space-y-1.5 text-xs text-slate-600">
            <p className="font-semibold text-slate-800 flex items-center gap-1.5">
              <ImageIcon className="w-3.5 h-3.5 text-blue-700" />
              <span>Cakupan Pembaruan Otomatis</span>
            </p>
            <ul className="space-y-1 text-[11px] list-disc list-inside text-slate-600">
              <li>Akun Pelanggan (Halaman Depan, Katalog, Promo &amp; Lacak Pesanan)</li>
              <li>Akun Kurir Delivery (Portal Pengantaran 1-Klik)</li>
              <li>Akun Admin (Login &amp; Dashboard Pengelola)</li>
              <li>Akun Master Data (Login &amp; Dashboard Super Control)</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

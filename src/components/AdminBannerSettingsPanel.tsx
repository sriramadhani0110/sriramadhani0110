import { useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Edit3,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  deleteDoc,
  doc,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import type { BannerCtaTarget, StoreBanner } from '../types/marketplace';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import {
  BANNER_IMAGE_PRESETS,
  compressImageFileToDataUrl,
  DEFAULT_STORE_BANNERS,
} from '../lib/storeDefaults';
import { HeroBannerCarousel } from './HeroBannerCarousel';

interface AdminBannerSettingsPanelProps {
  banners: StoreBanner[];
  onNotify: (msg: string) => void;
}

const CTA_TARGET_OPTIONS: { value: BannerCtaTarget; label: string }[] = [
  { value: 'promo', label: 'Halaman Promo & Diskon' },
  { value: 'catalog', label: 'Halaman Katalog Produk' },
  { value: 'search', label: 'Halaman Pencarian' },
  { value: 'orders', label: 'Halaman Lacak Pesanan' },
  { value: 'none', label: 'Tanpa Tombol Aksi' },
];

export function AdminBannerSettingsPanel({
  banners,
  onNotify,
}: AdminBannerSettingsPanelProps) {
  const [editingBanner, setEditingBanner] = useState<StoreBanner | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const [kicker, setKicker] = useState('');
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [ctaLabel, setCtaLabel] = useState('');
  const [ctaTarget, setCtaTarget] = useState<BannerCtaTarget>('promo');
  const [isActive, setIsActive] = useState(true);

  const [uploadingImage, setUploadingImage] = useState(false);
  const [saving, setSaving] = useState(false);
  const [seedingDefaults, setSeedingDefaults] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const sortedBanners = [...banners].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
  );
  const activePreviewSlides =
    sortedBanners.filter((b) => b.isActive).length > 0
      ? sortedBanners.filter((b) => b.isActive)
      : DEFAULT_STORE_BANNERS;

  const openCreateForm = () => {
    setEditingBanner(null);
    setIsCreating(true);
    setKicker('Promo Terbaru');
    setTitle('');
    setSubtitle('');
    setImageUrl(BANNER_IMAGE_PRESETS[0].imageUrl);
    setCtaLabel('Belanja Sekarang');
    setCtaTarget('catalog');
    setIsActive(true);
    setFormError(null);
  };

  const openEditForm = (banner: StoreBanner) => {
    setIsCreating(false);
    setEditingBanner(banner);
    setKicker(banner.kicker || '');
    setTitle(banner.title || '');
    setSubtitle(banner.subtitle || '');
    setImageUrl(banner.imageUrl || '');
    setCtaLabel(banner.ctaLabel || '');
    setCtaTarget(banner.ctaTarget || 'none');
    setIsActive(banner.isActive !== false);
    setFormError(null);
  };

  const closeForm = () => {
    setEditingBanner(null);
    setIsCreating(false);
    setFormError(null);
  };

  const handleUploadBannerPhoto = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFormError(null);
    setUploadingImage(true);
    try {
      const compressed = await compressImageFileToDataUrl(file, {
        maxWidth: 1280,
        maxHeight: 680,
        maxChars: 235000,
        initialQuality: 0.8,
      });
      setImageUrl(compressed);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : 'Gagal memproses gambar banner.'
      );
    } finally {
      setUploadingImage(false);
    }
  };

  const handleSaveBanner = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const cleanTitle = title.trim().slice(0, 120);
    const cleanKicker = kicker.trim().slice(0, 60);
    const cleanSubtitle = subtitle.trim().slice(0, 240);
    const cleanCtaLabel = ctaTarget === 'none' ? '' : ctaLabel.trim().slice(0, 40);
    const cleanImageUrl = imageUrl.trim();

    if (cleanTitle.length < 2) {
      setFormError('Judul banner minimal 2 karakter.');
      return;
    }

    if (
      cleanImageUrl &&
      !cleanImageUrl.startsWith('data:image/') &&
      !cleanImageUrl.startsWith('https://') &&
      !cleanImageUrl.startsWith('/')
    ) {
      setFormError(
        'URL gambar harus diawali https:// atau unggah foto langsung dari galeri perangkat Anda.'
      );
      return;
    }

    setSaving(true);
    try {
      if (editingBanner) {
        await updateDoc(doc(db, 'storeBanners', editingBanner.id), {
          kicker: cleanKicker,
          title: cleanTitle,
          subtitle: cleanSubtitle,
          imageUrl: cleanImageUrl,
          ctaLabel: cleanCtaLabel,
          ctaTarget,
          isActive,
          updatedAt: serverTimestamp(),
        });
        onNotify(`Banner "${cleanTitle}" berhasil diperbarui di halaman depan.`);
      } else {
        const newId = `banner_${Date.now().toString(36)}_${Math.random()
          .toString(36)
          .slice(2, 6)}`;
        const nextOrder =
          sortedBanners.length > 0
            ? Math.min(99, Math.max(...sortedBanners.map((b) => b.sortOrder ?? 0)) + 1)
            : 0;
        await setDoc(doc(db, 'storeBanners', newId), {
          id: newId,
          kicker: cleanKicker,
          title: cleanTitle,
          subtitle: cleanSubtitle,
          imageUrl: cleanImageUrl,
          ctaLabel: cleanCtaLabel,
          ctaTarget,
          sortOrder: nextOrder,
          isActive,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        onNotify(`Banner baru "${cleanTitle}" berhasil ditambahkan ke slider depan.`);
      }
      closeForm();
    } catch (err) {
      try {
        handleFirestoreError(err, OperationType.WRITE, 'storeBanners');
      } catch (wrapped) {
        setFormError(
          wrapped instanceof Error ? wrapped.message : 'Gagal menyimpan banner.'
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const handleToggleBanner = async (banner: StoreBanner) => {
    try {
      await updateDoc(doc(db, 'storeBanners', banner.id), {
        isActive: !banner.isActive,
        updatedAt: serverTimestamp(),
      });
      onNotify(
        !banner.isActive
          ? `Banner "${banner.title}" diaktifkan di halaman depan.`
          : `Banner "${banner.title}" disembunyikan sementara.`
      );
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `storeBanners/${banner.id}`);
    }
  };

  const handleMoveBanner = async (index: number, direction: -1 | 1) => {
    const targetIdx = index + direction;
    if (targetIdx < 0 || targetIdx >= sortedBanners.length) return;
    const current = sortedBanners[index];
    const swapWith = sortedBanners[targetIdx];
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'storeBanners', current.id), {
        sortOrder: targetIdx,
        updatedAt: serverTimestamp(),
      });
      batch.update(doc(db, 'storeBanners', swapWith.id), {
        sortOrder: index,
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
      onNotify('Urutan slide banner berhasil diperbarui.');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'storeBanners');
    }
  };

  const handleDeleteBanner = async (banner: StoreBanner) => {
    try {
      await deleteDoc(doc(db, 'storeBanners', banner.id));
      onNotify(`Banner "${banner.title}" dihapus.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `storeBanners/${banner.id}`);
    }
  };

  const handleSeedDefaultBanners = async () => {
    setSeedingDefaults(true);
    try {
      const batch = writeBatch(db);
      for (const item of DEFAULT_STORE_BANNERS) {
        batch.set(doc(db, 'storeBanners', item.id), {
          ...item,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
      onNotify(
        '3 template banner bawaan berhasil dimuat ke database. Sekarang Anda bisa langsung mengganti gambar atau teksnya.'
      );
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'storeBanners');
    } finally {
      setSeedingDefaults(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Live Preview of Homepage Carousel */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-slate-900">
              Preview Langsung Slider Halaman Depan
            </h2>
            <p className="text-xs text-slate-600 mt-0.5">
              Tampilan ini langsung muncul di bagian paling atas situs pelanggan secara otomatis.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {sortedBanners.length === 0 && (
              <button
                type="button"
                disabled={seedingDefaults}
                onClick={handleSeedDefaultBanners}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors cursor-pointer disabled:opacity-50"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>
                  {seedingDefaults ? 'Memuat Template...' : 'Muat 3 Template Bawaan'}
                </span>
              </button>
            )}
            <button
              type="button"
              onClick={openCreateForm}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-red-600 rounded-lg transition-colors cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Tambah Slide Banner</span>
            </button>
          </div>
        </div>

        <HeroBannerCarousel banners={activePreviewSlides} compactPreview />
      </div>

      {/* Add / Edit Banner Template Form */}
      {(isCreating || editingBanner) && (
        <form
          onSubmit={handleSaveBanner}
          className="bg-white border border-blue-200 rounded-xl p-5 sm:p-6 space-y-5 shadow-sm"
        >
          <div className="flex items-center justify-between gap-3 pb-3 border-b border-slate-100">
            <div>
              <h3 className="text-base font-bold text-slate-900">
                {editingBanner
                  ? `Edit Banner: ${editingBanner.title}`
                  : 'Template Tambah Banner Promo / Pengumuman'}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Unggah gambar dari HP/Komputer, pilih template bawaan, atau masukkan tautan gambar https://.
              </p>
            </div>
            <button
              type="button"
              onClick={closeForm}
              aria-label="Tutup form banner"
              className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {formError && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-700">
              {formError}
            </div>
          )}

          {/* Image Upload & Template Picker */}
          <div className="space-y-3">
            <label className="block text-xs font-semibold text-slate-800">
              Gambar Banner (Rasio 16:9 disarankan)
            </label>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
              <div className="relative aspect-[16/9] rounded-xl overflow-hidden border border-slate-200 bg-slate-900">
                {imageUrl ? (
                  <img
                    src={imageUrl}
                    alt="Preview gambar banner"
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center text-slate-400 gap-2">
                    <ImageIcon className="w-8 h-8" />
                    <span className="text-xs">Belum ada gambar dipilih</span>
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors cursor-pointer">
                    <Upload className="w-4 h-4" />
                    <span>
                      {uploadingImage
                        ? 'Memproses & Kompres Gambar...'
                        : 'Upload / Ganti Gambar dari HP / PC'}
                    </span>
                    <input
                      type="file"
                      accept="image/*"
                      disabled={uploadingImage}
                      onChange={handleUploadBannerPhoto}
                      className="sr-only"
                    />
                  </label>

                  {imageUrl && (
                    <button
                      type="button"
                      onClick={() => setImageUrl('')}
                      className="inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Hapus Gambar</span>
                    </button>
                  )}
                </div>

                <div className="space-y-1.5">
                  <p className="text-[11px] font-medium text-slate-600">
                    Atau pilih cepat dari Template Gambar Toko:
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    {BANNER_IMAGE_PRESETS.map((preset) => {
                      const selected = imageUrl === preset.imageUrl;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => setImageUrl(preset.imageUrl)}
                          className={`group relative rounded-lg overflow-hidden border text-left transition-all cursor-pointer ${
                            selected
                              ? 'border-blue-700 ring-2 ring-blue-700/30'
                              : 'border-slate-200 hover:border-slate-400'
                          }`}
                        >
                          <img
                            src={preset.imageUrl}
                            alt={preset.label}
                            className="w-full aspect-[16/9] object-cover"
                          />
                          <div className="p-1.5 bg-white">
                            <p className="text-[10px] font-semibold text-slate-800 truncate">
                              {preset.label}
                            </p>
                          </div>
                          {selected && (
                            <span className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-blue-700 text-white flex items-center justify-center">
                              <Check className="w-3 h-3" />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    Atau tempel URL gambar eksternal (opsional)
                  </label>
                  <input
                    type="text"
                    value={imageUrl.startsWith('data:image/') ? '' : imageUrl}
                    onChange={(e) => setImageUrl(e.target.value)}
                    placeholder="https://contoh.com/banner-promo.jpg"
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Text & Action Settings */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Label Atas (Kicker · Opsional)
              </label>
              <input
                type="text"
                maxLength={60}
                value={kicker}
                onChange={(e) => setKicker(e.target.value)}
                placeholder="Contoh: Promo Minggu Ini / Pengumuman Penting"
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Judul Utama Banner <span className="text-red-600">*</span>
              </label>
              <input
                type="text"
                required
                minLength={2}
                maxLength={120}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Contoh: Diskon Akhir Pekan & Gratis Ongkir"
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Deskripsi / Isi Pengumuman (Opsional)
              </label>
              <textarea
                rows={2}
                maxLength={240}
                value={subtitle}
                onChange={(e) => setSubtitle(e.target.value)}
                placeholder="Tulis info promo menarik, jam operasional, atau pengumuman penting bagi pelanggan..."
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Tujuan Tombol Banner
              </label>
              <select
                value={ctaTarget}
                onChange={(e) => setCtaTarget(e.target.value as BannerCtaTarget)}
                className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
              >
                {CTA_TARGET_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Teks Tombol Banner
              </label>
              <input
                type="text"
                maxLength={40}
                disabled={ctaTarget === 'none'}
                value={ctaLabel}
                onChange={(e) => setCtaLabel(e.target.value)}
                placeholder="Contoh: Lihat Promo"
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700 disabled:bg-slate-100 disabled:text-slate-400"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 pt-3 border-t border-slate-100">
            <label className="inline-flex items-center gap-2.5 text-sm font-medium text-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-blue-700 focus:ring-blue-700"
              />
              <span>Tampilkan slide ini di halaman depan toko</span>
            </label>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={closeForm}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
              >
                Batal
              </button>
              <button
                type="submit"
                disabled={saving || uploadingImage}
                className="inline-flex items-center gap-2 px-5 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-red-600 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
              >
                <Save className="w-4 h-4" />
                <span>{saving ? 'Menyimpan...' : 'Simpan Banner'}</span>
              </button>
            </div>
          </div>
        </form>
      )}

      {/* List of Managed Banners */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-bold text-slate-900">
              Daftar Slide Banner Tersimpan ({sortedBanners.length})
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Atur urutan slide, ganti gambar, atau sembunyikan pengumuman kapan saja.
            </p>
          </div>
          {sortedBanners.length > 0 && (
            <button
              type="button"
              disabled={seedingDefaults}
              onClick={handleSeedDefaultBanners}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer disabled:opacity-50"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Pulihkan Template Bawaan</span>
            </button>
          )}
        </div>

        {sortedBanners.length === 0 ? (
          <div className="p-8 border border-dashed border-slate-300 rounded-xl text-center space-y-3 bg-slate-50/70">
            <ImageIcon className="w-8 h-8 text-slate-400 mx-auto" />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-slate-900">
                Saat ini menampilkan 3 Banner Template Bawaan
              </p>
              <p className="text-xs text-slate-600 max-w-md mx-auto">
                Klik <strong>Muat 3 Template Bawaan</strong> untuk mulai mengedit gambar/teks bawaan, atau klik <strong>Tambah Slide Banner</strong> untuk membuat slide baru sendiri.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
              <button
                type="button"
                disabled={seedingDefaults}
                onClick={handleSeedDefaultBanners}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-blue-700 bg-white border border-blue-300 rounded-lg hover:bg-blue-50 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Muat 3 Template Bawaan</span>
              </button>
              <button
                type="button"
                onClick={openCreateForm}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-red-600 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Tambah Slide Baru</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {sortedBanners.map((banner, idx) => (
              <div
                key={banner.id}
                className="flex flex-col md:flex-row gap-4 p-4 border border-slate-200 rounded-xl bg-slate-50/50 items-start md:items-center"
              >
                <div className="w-full md:w-44 aspect-[16/9] rounded-lg overflow-hidden bg-slate-900 shrink-0 border border-slate-200">
                  {banner.imageUrl ? (
                    <img
                      src={banner.imageUrl}
                      alt={banner.title}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-slate-400">
                      <ImageIcon className="w-6 h-6" />
                    </div>
                  )}
                </div>

                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className="font-mono font-semibold text-slate-700">
                      Slide #{idx + 1}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span
                      className={`font-semibold ${
                        banner.isActive ? 'text-emerald-700' : 'text-slate-500'
                      }`}
                    >
                      {banner.isActive ? 'Aktif di Depan' : 'Disembunyikan'}
                    </span>
                    {banner.kicker && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-red-600 font-medium">{banner.kicker}</span>
                      </>
                    )}
                  </div>
                  <p className="text-sm font-bold text-slate-900 line-clamp-1">
                    {banner.title}
                  </p>
                  {banner.subtitle && (
                    <p className="text-xs text-slate-600 line-clamp-2">
                      {banner.subtitle}
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    disabled={idx === 0}
                    onClick={() => handleMoveBanner(idx, -1)}
                    aria-label="Naikkan urutan"
                    className="p-2 text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 disabled:opacity-35 cursor-pointer"
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={idx === sortedBanners.length - 1}
                    onClick={() => handleMoveBanner(idx, 1)}
                    aria-label="Turunkan urutan"
                    className="p-2 text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 disabled:opacity-35 cursor-pointer"
                  >
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleToggleBanner(banner)}
                    className="inline-flex items-center gap-1 px-2.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 cursor-pointer"
                  >
                    {banner.isActive ? (
                      <>
                        <EyeOff className="w-3.5 h-3.5" />
                        <span>Sembunyikan</span>
                      </>
                    ) : (
                      <>
                        <Eye className="w-3.5 h-3.5 text-emerald-600" />
                        <span>Tampilkan</span>
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => openEditForm(banner)}
                    className="inline-flex items-center gap-1 px-3 py-2 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 cursor-pointer"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    <span>Ganti Gambar / Edit</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteBanner(banner)}
                    aria-label={`Hapus ${banner.title}`}
                    className="p-2 text-rose-600 bg-white border border-rose-200 rounded-lg hover:bg-rose-50 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

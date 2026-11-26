import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  Lock,
  Power,
  Save,
  Sparkles,
  Store,
  Unlock,
} from 'lucide-react';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import type { StoreHoursConfig, StoreHoursMode } from '../types/marketplace';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import {
  DEFAULT_STORE_HOURS_CONFIG,
  evaluateStoreOpenStatus,
  mergeStoreHoursConfig,
  STORE_HOURS_TEMPLATES,
  type StoreHoursTemplatePreset,
} from '../lib/storeDefaults';

interface AdminStoreHoursPanelProps {
  hoursConfig: StoreHoursConfig;
  adminEmail: string;
}

const TIMEZONE_OPTIONS = ['WIB', 'WITA', 'WIT', 'ICT', 'SGT'] as const;

export function AdminStoreHoursPanel({
  hoursConfig,
  adminEmail,
}: AdminStoreHoursPanelProps) {
  const [form, setForm] = useState<StoreHoursConfig>(() =>
    mergeStoreHoursConfig(hoursConfig)
  );
  const [selectedPresetId, setSelectedPresetId] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const lastRemoteRef = useRef<string>(JSON.stringify(mergeStoreHoursConfig(hoursConfig)));

  useEffect(() => {
    const merged = mergeStoreHoursConfig(hoursConfig);
    lastRemoteRef.current = JSON.stringify(merged);
    setForm(merged);
  }, [hoursConfig]);

  // Debounced Auto-Save Permanen ke Firestore (2 detik setelah selesai mengubah)
  useEffect(() => {
    const currentSnapshot = JSON.stringify(form);
    if (currentSnapshot === lastRemoteRef.current) return;
    const timePattern = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timePattern.test(form.openTime) || !timePattern.test(form.closeTime)) return;

    const timer = setTimeout(() => {
      const payload = {
        id: 'hours' as const,
        enabled: Boolean(form.enabled),
        mode: form.mode,
        openTime: form.openTime.trim(),
        closeTime: form.closeTime.trim(),
        timezoneLabel: (form.timezoneLabel.trim() || 'WIB').slice(0, 16),
        openDaysText: (
          form.openDaysText.trim() || DEFAULT_STORE_HOURS_CONFIG.openDaysText
        ).slice(0, 60),
        blockCheckoutWhenClosed: Boolean(form.blockCheckoutWhenClosed),
        closedTitle: (
          form.closedTitle.trim() || DEFAULT_STORE_HOURS_CONFIG.closedTitle
        ).slice(0, 80),
        closedMessage: form.closedMessage.trim().slice(0, 240),
        openNotice: form.openNotice.trim().slice(0, 160),
        updatedBy: (adminEmail || 'admin@alpamart').slice(0, 128),
        updatedAt: serverTimestamp(),
      };
      void setDoc(doc(db, 'storeConfig', 'hours'), payload)
        .then(() => {
          lastRemoteRef.current = currentSnapshot;
          setSavedNotice('Perubahan Jam Buka & Tutup tersimpan otomatis permanen.');
        })
        .catch(() => undefined);
    }, 2000);

    return () => clearTimeout(timer);
  }, [form, adminEmail]);

  const liveStatus = evaluateStoreOpenStatus(form);

  const handleApplyTemplate = (preset: StoreHoursTemplatePreset) => {
    setSelectedPresetId(preset.id);
    setForm((prev) => ({
      ...prev,
      ...preset.values,
    }));
    setSavedNotice(null);
    setErrorMsg(null);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSavedNotice(null);
    setErrorMsg(null);

    const timePattern = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timePattern.test(form.openTime) || !timePattern.test(form.closeTime)) {
      setErrorMsg('Format jam buka dan jam tutup harus HH:MM (contoh: 08:00 dan 22:00).');
      setSaving(false);
      return;
    }

    const payload = {
      id: 'hours' as const,
      enabled: Boolean(form.enabled),
      mode: form.mode,
      openTime: form.openTime.trim(),
      closeTime: form.closeTime.trim(),
      timezoneLabel: (form.timezoneLabel.trim() || 'WIB').slice(0, 16),
      openDaysText: (
        form.openDaysText.trim() || DEFAULT_STORE_HOURS_CONFIG.openDaysText
      ).slice(0, 60),
      blockCheckoutWhenClosed: Boolean(form.blockCheckoutWhenClosed),
      closedTitle: (
        form.closedTitle.trim() || DEFAULT_STORE_HOURS_CONFIG.closedTitle
      ).slice(0, 80),
      closedMessage: form.closedMessage.trim().slice(0, 240),
      openNotice: form.openNotice.trim().slice(0, 160),
      updatedBy: (adminEmail || 'admin@alpamart').slice(0, 128),
      updatedAt: serverTimestamp(),
    };

    try {
      await setDoc(doc(db, 'storeConfig', 'hours'), payload);
      setSavedNotice(
        'Template Jam Buka & Tutup berhasil disimpan dan langsung aktif di halaman Pelanggan.'
      );
    } catch (err) {
      try {
        handleFirestoreError(err, OperationType.WRITE, 'storeConfig/hours');
      } catch (wrapped) {
        setErrorMsg(
          wrapped instanceof Error
            ? wrapped.message
            : 'Gagal menyimpan pengaturan jam operasional.'
        );
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 flex items-start gap-3 text-xs text-emerald-950">
        <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
        <div className="space-y-0.5">
          <p className="font-bold text-sm text-emerald-950">
            Toko Aktif Buka 24 Jam Nonstop Tanpa Tutup
          </p>
          <p className="leading-relaxed">
            Seluruh pelanggan dapat melihat katalog dan melakukan checkout 24 jam penuh setiap hari tanpa pernah terkunci atau tutup otomatis.
          </p>
        </div>
      </div>

      {/* Live Status Preview Banner */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-start gap-3.5">
          <div
            className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 border ${
              liveStatus.isOpen
                ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                : 'bg-red-50 border-red-200 text-red-600'
            }`}
          >
            <Store className="w-5 h-5" />
          </div>
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-bold rounded-md ${
                  liveStatus.isOpen
                    ? 'bg-emerald-600 text-white'
                    : 'bg-red-600 text-white'
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-white" />
                {liveStatus.statusLabel}
              </span>
              <span className="font-mono text-xs font-semibold text-slate-700">
                {liveStatus.scheduleSummary}
              </span>
            </div>
            <p className="text-xs text-slate-600">
              {form.openDaysText} ·{' '}
              {liveStatus.isOpen
                ? form.openNotice || 'Siap menerima pesanan pelanggan'
                : form.closedMessage || form.closedTitle}
            </p>
          </div>
        </div>

        {/* Quick 1-click Open / Close / Auto status switch */}
        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
          {(
            [
              { id: 'auto', label: 'Otomatis Jam', icon: Clock },
              { id: 'force_open', label: 'Buka Sekarang', icon: Unlock },
              { id: 'force_closed', label: 'Tutup Sekarang', icon: Lock },
            ] as Array<{ id: StoreHoursMode; label: string; icon: typeof Clock }>
          ).map((opt) => {
            const Icon = opt.icon;
            const active = form.mode === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => {
                  setForm((prev) => ({ ...prev, mode: opt.id, enabled: true }));
                  setSavedNotice(null);
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors cursor-pointer ${
                  active
                    ? opt.id === 'force_closed'
                      ? 'bg-red-600 text-white border-red-600'
                      : opt.id === 'force_open'
                        ? 'bg-emerald-600 text-white border-emerald-600'
                        : 'bg-blue-700 text-white border-blue-700'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{opt.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 1-Click Ready-Made Templates */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-slate-900 inline-flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-blue-700" />
              <span>Template Cepat Jam Buka &amp; Tutup</span>
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Klik salah satu template di bawah untuk langsung mengisi jam buka, jam tutup, dan pesan pelanggan, lalu klik Simpan.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {STORE_HOURS_TEMPLATES.map((preset) => {
            const isSelected = selectedPresetId === preset.id;
            const isClosedPreset = preset.values.mode === 'force_closed';
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => handleApplyTemplate(preset)}
                className={`text-left p-4 rounded-xl border transition-all cursor-pointer space-y-1.5 ${
                  isSelected
                    ? 'border-blue-600 bg-blue-50/70 ring-2 ring-blue-600/20'
                    : 'border-slate-200 bg-slate-50/50 hover:bg-white hover:border-blue-300'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-slate-900">
                    {preset.name}
                  </span>
                  <span
                    className={`font-mono text-[11px] font-bold px-2 py-0.5 rounded ${
                      isClosedPreset
                        ? 'bg-red-100 text-red-700'
                        : 'bg-blue-100 text-blue-800'
                    }`}
                  >
                    {preset.badge}
                  </span>
                </div>
                <p className="text-[11px] text-slate-600 leading-relaxed">
                  {preset.description}
                </p>
                <p className="text-[11px] font-medium text-slate-500">
                  {preset.values.openDaysText}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Detailed Schedule Editor Form */}
      <form
        onSubmit={handleSave}
        className="bg-white border border-slate-200 rounded-xl p-5 space-y-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-100">
          <div>
            <h3 className="text-sm font-bold text-slate-900">
              Atur Jam Buka &amp; Jam Tutup Toko
            </h3>
            <p className="text-xs text-slate-500">
              Sesuaikan jam buka, jam tutup, zona waktu, dan tampilan pesan untuk pelanggan.
            </p>
          </div>
          <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, enabled: e.target.checked }))
              }
              className="w-4 h-4 rounded border-slate-300 text-blue-700 focus:ring-blue-700"
            />
            <span>Tampilkan Status Buka/Tutup di Toko</span>
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label
              htmlFor="store-open-time"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Jam Buka (Open)
            </label>
            <input
              id="store-open-time"
              type="time"
              required
              value={form.openTime}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, openTime: e.target.value }))
              }
              className="w-full px-3 py-2 text-sm font-mono font-semibold text-slate-900 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
            />
          </div>

          <div>
            <label
              htmlFor="store-close-time"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Jam Tutup (Close)
            </label>
            <input
              id="store-close-time"
              type="time"
              required
              value={form.closeTime}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, closeTime: e.target.value }))
              }
              className="w-full px-3 py-2 text-sm font-mono font-semibold text-slate-900 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
            />
          </div>

          <div>
            <label
              htmlFor="store-timezone"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Zona Waktu
            </label>
            <select
              id="store-timezone"
              value={form.timezoneLabel}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, timezoneLabel: e.target.value }))
              }
              className="w-full px-3 py-2 text-sm font-medium text-slate-900 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
            >
              {TIMEZONE_OPTIONS.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="store-open-days"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Hari Operasional
            </label>
            <input
              id="store-open-days"
              type="text"
              maxLength={60}
              required
              value={form.openDaysText}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, openDaysText: e.target.value }))
              }
              placeholder="Contoh: Setiap Hari (Senin - Minggu)"
              className="w-full px-3 py-2 text-sm text-slate-900 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="store-open-notice"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Pesan Saat Toko Buka
            </label>
            <input
              id="store-open-notice"
              type="text"
              maxLength={160}
              value={form.openNotice}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, openNotice: e.target.value }))
              }
              placeholder="Buka Setiap Hari · Siap Antar Cepat (Free Delivery)"
              className="w-full px-3 py-2 text-sm text-slate-900 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
            />
          </div>

          <div>
            <label
              htmlFor="store-closed-title"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Judul Saat Toko Tutup
            </label>
            <input
              id="store-closed-title"
              type="text"
              maxLength={80}
              required
              value={form.closedTitle}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, closedTitle: e.target.value }))
              }
              placeholder="Toko Sedang Tutup"
              className="w-full px-3 py-2 text-sm text-slate-900 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="store-closed-message"
            className="block text-xs font-semibold text-slate-700 mb-1"
          >
            Pesan Informasi Saat Toko Tutup
          </label>
          <textarea
            id="store-closed-message"
            rows={2}
            maxLength={240}
            value={form.closedMessage}
            onChange={(e) =>
              setForm((prev) => ({ ...prev, closedMessage: e.target.value }))
            }
            placeholder="Terima kasih sudah berkunjung. Pesanan akan kami proses saat toko buka kembali."
            className="w-full px-3 py-2 text-sm text-slate-900 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
          />
        </div>

        <label className="flex items-start gap-3 p-3.5 rounded-xl bg-slate-50 border border-slate-200 cursor-pointer">
          <input
            type="checkbox"
            checked={form.blockCheckoutWhenClosed}
            onChange={(e) =>
              setForm((prev) => ({
                ...prev,
                blockCheckoutWhenClosed: e.target.checked,
              }))
            }
            className="mt-0.5 w-4 h-4 rounded border-slate-300 text-red-600 focus:ring-red-600"
          />
          <div className="text-xs">
            <p className="font-semibold text-slate-900 inline-flex items-center gap-1.5">
              <Power className="w-3.5 h-3.5 text-red-600" />
              <span>Kunci Tombol Checkout Saat Toko Tutup</span>
            </p>
            <p className="text-slate-600 mt-0.5">
              Jika dicentang, pelanggan tetap bisa melihat katalog tetapi tidak dapat mengirim pesanan hingga jam buka tiba. Jika tidak dicentang, pelanggan tetap bisa checkout dengan pemberitahuan pesanan diproses saat buka.
            </p>
          </div>
        </label>

        {errorMsg && (
          <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs font-medium text-red-700">
            {errorMsg}
          </div>
        )}

        {savedNotice && (
          <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs font-semibold text-emerald-800 inline-flex items-center gap-2 w-full">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
            <span>{savedNotice}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-lg transition-colors cursor-pointer"
          >
            <Save className="w-4 h-4" />
            <span>{saving ? 'Menyimpan...' : 'Simpan Jam Buka & Tutup'}</span>
          </button>
        </div>
      </form>
    </div>
  );
}

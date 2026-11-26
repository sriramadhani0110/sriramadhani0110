import { useMemo, useState } from 'react';
import {
  ArrowRight,
  Check,
  Copy,
  Crown,
  Download,
  ExternalLink,
  Globe,
  ShieldCheck,
  ShoppingBag,
  Smartphone,
  Truck,
  X,
} from 'lucide-react';
import type { SiteMode } from '../App';
import {
  copyTextToClipboard,
  getShareableOrigin,
  getShareablePortalUrl,
  isPrivateDevPreviewOrigin,
  PORTAL_PATHS,
  STORE_NAME,
} from '../lib/catalogSeed';
import { FIREBASE_AUTH_SETTINGS_URL } from '../lib/firebase';
import {
  downloadSinglePortalDomainZip,
  type PortalZipTarget,
} from '../lib/portalZipExport';

interface PortalGuideModalProps {
  isOpen: boolean;
  currentSiteMode: SiteMode;
  onClose: () => void;
  onNavigatePortal: (mode: SiteMode) => void;
  storeName?: string;
  permanentStoreUrl?: string;
}

export function PortalGuideModal({
  isOpen,
  currentSiteMode,
  onClose,
  onNavigatePortal,
  storeName,
  permanentStoreUrl,
}: PortalGuideModalProps) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [zipDownloadedMsg, setZipDownloadedMsg] = useState<string | null>(null);

  const origin = useMemo(() => {
    const cleanPerm = (permanentStoreUrl || '').trim().replace(/\/+$/, '');
    if (cleanPerm && /^https?:\/\//i.test(cleanPerm)) {
      return cleanPerm;
    }
    return getShareableOrigin();
  }, [permanentStoreUrl]);
  const isPrivatePreview = useMemo(() => isPrivateDevPreviewOrigin(), []);
  const activeStoreName = (storeName || STORE_NAME).trim() || STORE_NAME;

  if (!isOpen) return null;

  const handleDownloadPortalZip = (portal: PortalZipTarget) => {
    const res = downloadSinglePortalDomainZip(portal, {
      storeName: activeStoreName,
      customBaseOrigin: permanentStoreUrl,
    });
    setZipDownloadedMsg(
      `${res.portalLabel} berhasil diunduh terpisah (1 website = 1 file ZIP): ${res.filename}`
    );
    setTimeout(() => setZipDownloadedMsg(null), 4500);
  };

  const handleCopy = async (key: string, value: string) => {
    await copyTextToClipboard(value);
    setCopiedKey(key);
    setTimeout(
      () => setCopiedKey((prev) => (prev === key ? null : prev)),
      1800
    );
  };

  const portals: {
    mode: SiteMode;
    path: string;
    fullUrl: string;
    directUrl?: string;
    title: string;
    badge: string;
    steps: string;
    accentBorder: string;
    accentText: string;
    buttonClass: string;
  }[] = [
    {
      mode: 'customer',
      path: PORTAL_PATHS.customer,
      fullUrl: getShareablePortalUrl('customer', origin),
      directUrl: getShareablePortalUrl('customer', origin),
      title: '1. Situs Pelanggan (Toko Online)',
      badge: 'Belanja & Checkout Tanpa Login',
      steps:
        'Langsung terbuka di semua Android & iPhone tanpa login. Pelanggan memilih produk, mengisi lokasi GPS & Telegram, lalu checkout.',
      accentBorder: 'border-slate-200',
      accentText: 'text-red-600',
      buttonClass: 'bg-red-600 hover:bg-red-700 text-white',
    },
    {
      mode: 'delivery',
      path: PORTAL_PATHS.delivery,
      fullUrl: getShareablePortalUrl('delivery', origin),
      directUrl: getShareablePortalUrl('delivery', origin),
      title: '2. Situs Kurir Deliveri',
      badge: '1-Klik Tanpa Login · Bisa Offline',
      steps:
        'Langsung terbuka di semua Android & iPhone tanpa perlu login email. Unggah foto/file bukti secara offline & klik Sudah Diterima untuk update Admin + kirim Telegram pelanggan.',
      accentBorder: 'border-slate-200',
      accentText: 'text-blue-700',
      buttonClass: 'bg-blue-700 hover:bg-blue-800 text-white',
    },
    {
      mode: 'admin',
      path: PORTAL_PATHS.admin,
      fullUrl: getShareablePortalUrl('admin', origin),
      title: '3. Situs Admin',
      badge: 'Pengelola Pesanan, Produk & Checkout',
      steps:
        'Masuk dengan Google atau Email & Password. Cukup login 1 kali di browser ini — sesi otomatis aktif bersamaan untuk Admin dan Master Data.',
      accentBorder: 'border-slate-200',
      accentText: 'text-slate-900',
      buttonClass: 'bg-slate-900 hover:bg-slate-800 text-white',
    },
    {
      mode: 'master',
      path: PORTAL_PATHS.master,
      fullUrl: getShareablePortalUrl('master', origin),
      title: '4. Portal Master Data',
      badge: 'Kontrol Penuh Nama, Logo, Mata Uang & Tema',
      steps:
        'Khusus Master Data (Hananbintang30@gmail.com / tmalpamartt@gmail.com). Ubah nama toko, logo, mata uang, kurs, tema, banner depan & barcode checkout.',
      accentBorder: 'border-amber-200',
      accentText: 'text-amber-700',
      buttonClass: 'bg-amber-600 hover:bg-amber-700 text-white',
    },
  ];

  const activeLabel =
    currentSiteMode === 'master'
      ? `Portal Master Data (${PORTAL_PATHS.master})`
      : currentSiteMode === 'admin'
        ? `Situs Admin (${PORTAL_PATHS.admin})`
        : currentSiteMode === 'delivery'
          ? `Situs Kurir Deliveri (${PORTAL_PATHS.delivery})`
          : `Situs Pelanggan (${PORTAL_PATHS.customer})`;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 no-print"
      role="dialog"
      aria-modal="true"
      aria-label="Pusat Semua Link Situs"
    >
      <div className="bg-white border border-slate-200 rounded-2xl max-w-3xl w-full max-h-[90dvh] overflow-y-auto shadow-2xl">
        <div className="h-1.5 w-full bg-gradient-to-r from-red-600 via-white to-blue-700" />

        {/* Header */}
        <div className="px-6 py-5 border-b border-slate-200 flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs font-semibold text-blue-700">
              <Globe className="w-4 h-4 shrink-0" />
              <span>Pusat Semua Link Situs · {activeStoreName}</span>
            </div>
            <h2 className="font-display text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">
              Buka Semua Portal Sekaligus dalam 1 Browser
            </h2>
            <p className="text-xs sm:text-sm text-slate-600">
              Anda bisa membuka <strong>Toko, Delivery, Admin, dan Master Data secara bersamaan</strong> di tab berbeda dalam 1 browser (Android, iPhone, maupun Laptop) tanpa saling memutus koneksi. Posisi saat ini:{' '}
              <span className="font-semibold text-slate-900">{activeLabel}</span>.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup pusat portal"
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 cursor-pointer shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 4 Portal Cards */}
        <div className="p-6 space-y-4">
          {/* Download ZIP Terpisah: 1 Website = 1 File ZIP */}
          <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl space-y-3">
            <div className="space-y-1">
              <p className="text-xs sm:text-sm font-bold text-slate-900">
                Download Berkas ZIP Terpisah (Masing-Masing Website = 1 File ZIP)
              </p>
              <p className="text-xs text-slate-600 leading-relaxed">
                Setiap website diunduh dalam <strong>file .zip tersendiri (tidak digabungkan)</strong> dan otomatis ter-update saat data atau fitur berubah.
              </p>
              {zipDownloadedMsg && (
                <p className="text-xs font-semibold text-emerald-700">
                  {zipDownloadedMsg}
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <button
                type="button"
                onClick={() => handleDownloadPortalZip('customer')}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 shrink-0" />
                <span>ZIP Pelanggan</span>
              </button>
              <button
                type="button"
                onClick={() => handleDownloadPortalZip('delivery')}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 shrink-0" />
                <span>ZIP Deliveri</span>
              </button>
              <button
                type="button"
                onClick={() => handleDownloadPortalZip('admin')}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 shrink-0" />
                <span>ZIP Admin</span>
              </button>
              <button
                type="button"
                onClick={() => handleDownloadPortalZip('master')}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded-lg transition-colors cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 shrink-0" />
                <span>ZIP Master</span>
              </button>
            </div>
          </div>

          {isPrivatePreview && (
            <div className="p-4 bg-amber-50 border border-amber-300 rounded-xl text-xs text-amber-950 space-y-2 leading-relaxed">
              <p className="font-bold text-amber-950">
                Penting: Link di Bawah Sudah Diubah Otomatis dari Preview Pribadi (ais-dev) ke Link Berbagi (ais-pre)
              </p>
              <p className="text-amber-900">
                Link berawalan <code className="font-mono bg-amber-100 px-1 rounded">ais-dev-...</code> dikunci khusus pembuat aplikasi sehingga <strong>teman tidak akan bisa membukanya</strong>. Agar teman bisa langsung membuka link di HP Android &amp; iPhone:
              </p>
              <ol className="list-decimal list-inside space-y-1 text-amber-900">
                <li>
                  Pastikan Anda sudah mengaktifkan tombol <strong>Share App</strong> di pojok kanan atas AI Studio agar link <code className="font-mono bg-amber-100 px-1 rounded">ais-pre-...</code> bisa dibuka teman, <strong>ATAU</strong> klik <strong>Deploy App (Cloud Run)</strong> untuk link publik permanen tanpa login Google.
                </li>
                <li>
                  Bagikan link dari daftar di bawah (atau lewat tombol <strong>Download Berkas ZIP</strong>) — format <code className="font-mono bg-amber-100 px-1 rounded">/?portal=...</code> langsung terbuka di semua HP.
                </li>
                <li>
                  Tambahkan domain publik Anda ke{' '}
                  <a
                    href={FIREBASE_AUTH_SETTINGS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold text-blue-700 underline"
                  >
                    Firebase Console → Authentication → Settings → Authorized domains
                  </a>{' '}
                  supaya tombol Login Google di portal Admin &amp; Master Data aktif di semua HP.
                </li>
              </ol>
            </div>
          )}

          {portals.map((item) => {
            const isCurrent = currentSiteMode === item.mode;
            return (
              <div
                key={item.mode}
                className={`p-4 sm:p-5 rounded-xl border transition-colors ${
                  isCurrent
                    ? 'bg-blue-50/40 border-blue-300'
                    : `bg-white ${item.accentBorder}`
                }`}
              >
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                  <div className="space-y-2 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      {item.mode === 'customer' && (
                        <ShoppingBag className="w-4 h-4 text-red-600 shrink-0" />
                      )}
                      {item.mode === 'delivery' && (
                        <Truck className="w-4 h-4 text-blue-700 shrink-0" />
                      )}
                      {item.mode === 'admin' && (
                        <ShieldCheck className="w-4 h-4 text-slate-900 shrink-0" />
                      )}
                      {item.mode === 'master' && (
                        <Crown className="w-4 h-4 text-amber-600 shrink-0" />
                      )}
                      <h3 className="text-sm sm:text-base font-bold text-slate-900">
                        {item.title}
                      </h3>
                      <span aria-hidden="true" className="text-slate-300">
                        ·
                      </span>
                      <span className={`font-semibold ${item.accentText}`}>
                        {item.badge}
                      </span>
                      {isCurrent && (
                        <>
                          <span aria-hidden="true" className="text-slate-300">
                            ·
                          </span>
                          <span className="font-semibold text-emerald-700">
                            Aktif di Tab Ini
                          </span>
                        </>
                      )}
                    </div>

                    <p className="text-xs text-slate-600 leading-relaxed">
                      {item.steps}
                    </p>

                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-slate-500">Link HP:</span>
                      <code className="font-mono text-slate-900 bg-slate-100 px-2 py-0.5 rounded break-all">
                        {item.fullUrl}
                      </code>
                      <button
                        type="button"
                        onClick={() => handleCopy(item.mode, item.fullUrl)}
                        className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100 cursor-pointer"
                      >
                        {copiedKey === item.mode ? (
                          <>
                            <Check className="w-3 h-3 text-emerald-600" />
                            <span>Disalin</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3 h-3" />
                            <span>Salin</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleDownloadPortalZip(item.mode)}
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>ZIP (1 File)</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        if (isCurrent) {
                          onClose();
                        } else {
                          onNavigatePortal(item.mode);
                          onClose();
                        }
                      }}
                      className={`inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap ${item.buttonClass}`}
                    >
                      <span>{isCurrent ? 'Tetap di Sini' : 'Buka di Tab Ini'}</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>

                    <a
                      href={item.mode === 'customer' ? '/' : `/?portal=${item.mode}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-lg transition-colors whitespace-nowrap"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>Tab Baru</span>
                    </a>
                  </div>
                </div>
              </div>
            );
          })}

          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-700 leading-relaxed space-y-2">
            <p className="font-bold text-slate-900 flex items-center gap-1.5">
              <Smartphone className="w-4 h-4 text-blue-700 shrink-0" />
              <span>Panduan Wajib Agar Lancar di Android &amp; iPhone:</span>
            </p>
            <ul className="list-disc list-inside space-y-1 text-slate-600">
              <li>
                Gunakan <strong>link publik hasil Deploy</strong> (bukan link preview pribadi <code className="font-mono text-slate-900">ais-dev-...</code>) saat membagikan ke HP Android atau iPhone lain.
              </li>
              <li>
                Buka langsung di <strong>Google Chrome (Android)</strong> atau <strong>Safari asli (iPhone)</strong> — hindari login Google di dalam browser bawaan Telegram/WhatsApp karena Google memblokir login di browser dalam aplikasi.
              </li>
              <li>
                <strong>Login 1 Kali untuk Semua Portal:</strong> Setelah login di <strong>/admin</strong> atau <strong>/master</strong>, Anda bisa membuka tab baru untuk <strong>Toko, Delivery, Admin, dan Master Data</strong> sekaligus di 1 browser tanpa perlu login ulang.
              </li>
            </ul>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <p className="text-xs text-slate-500">
            Semua tab tersinkronisasi secara real-time dalam 1 browser.
          </p>
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            Tutup
          </button>
        </div>
      </div>
    </div>
  );
}

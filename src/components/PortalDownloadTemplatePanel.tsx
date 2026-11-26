import { useMemo, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Crown,
  Download,
  FileArchive,
  FileCode2,
  Globe,
  RotateCcw,
  Save,
  ShieldCheck,
  ShoppingBag,
  Truck,
} from 'lucide-react';
import type { SiteMode } from '../App';
import {
  copyTextToClipboard,
  getShareableOrigin,
  getShareablePortalUrl,
  STORE_NAME,
} from '../lib/catalogSeed';
import {
  buildPortalZipDownloadUrl,
  downloadSinglePortalDomainZip,
  type PortalZipTarget,
} from '../lib/portalZipExport';

interface PortalDownloadTemplatePanelProps {
  storeName?: string;
  storeTagline?: string;
  permanentStoreUrl?: string;
  onSavePermanentUrl?: (
    nextUrl: string
  ) => Promise<{ ok: boolean; error?: string }>;
  onNavigatePortal?: (mode: SiteMode) => void;
  onNotify?: (message: string) => void;
  extraBackupActions?: React.ReactNode;
}

interface PortalTemplateSpec {
  id: PortalZipTarget;
  indexLabel: string;
  title: string;
  subtitle: string;
  audience: string;
  isolationNote: string;
  fileSlug: string;
  guideFilename: string;
  topBarClass: string;
  iconTextClass: string;
  buttonClass: string;
  ctaLabel: string;
}

const PORTAL_TEMPLATES: PortalTemplateSpec[] = [
  {
    id: 'customer',
    indexLabel: '01',
    title: 'Website Pelanggan (Toko Online)',
    subtitle: 'Belanja katalog, promo combo, keranjang & checkout tanpa login',
    audience: 'Publik · Android, iPhone & Desktop',
    isolationNote:
      'Hanya memuat portal Pelanggan (/). Tidak menyertakan halaman Admin, Master, atau Kurir Deliveri.',
    fileSlug: 'Website_Pelanggan',
    guideFilename: 'PANDUAN_PASANG_WEBSITE_PELANGGAN.txt',
    topBarClass: 'bg-red-600',
    iconTextClass: 'text-red-600',
    buttonClass: 'bg-red-600 hover:bg-red-700 text-white',
    ctaLabel: 'Download ZIP Pelanggan',
  },
  {
    id: 'delivery',
    indexLabel: '02',
    title: 'Website Kurir Deliveri',
    subtitle: 'Lihat pesanan siap kirim, GPS lokasi & unggah foto bukti sampai',
    audience: 'Kurir Lapangan · 1-Klik Tanpa Login Email',
    isolationNote:
      'Hanya memuat portal Deliveri (/?portal=delivery). Terpisah penuh dari Pelanggan, Admin & Master.',
    fileSlug: 'Website_Deliveri',
    guideFilename: 'PANDUAN_PASANG_WEBSITE_DELIVERI.txt',
    topBarClass: 'bg-blue-700',
    iconTextClass: 'text-blue-700',
    buttonClass: 'bg-blue-700 hover:bg-blue-800 text-white',
    ctaLabel: 'Download ZIP Deliveri',
  },
  {
    id: 'admin',
    indexLabel: '03',
    title: 'Website Admin Toko',
    subtitle: 'Kelola antrean pesanan, katalog, barcode promo, CSV & printer struk',
    audience: 'Staf Admin · Login Google / Email',
    isolationNote:
      'Hanya memuat portal Admin (/?portal=admin). Tidak digabungkan dengan file Pelanggan, Deliveri, atau Master.',
    fileSlug: 'Website_Admin',
    guideFilename: 'PANDUAN_PASANG_WEBSITE_ADMIN.txt',
    topBarClass: 'bg-slate-900',
    iconTextClass: 'text-slate-900',
    buttonClass: 'bg-slate-900 hover:bg-slate-800 text-white',
    ctaLabel: 'Download ZIP Admin',
  },
  {
    id: 'master',
    indexLabel: '04',
    title: 'Website Master Data',
    subtitle: 'Kontrol nama toko, logo, kurs mata uang, tema, jam buka & backup',
    audience: 'Pemilik Toko · Akses Master',
    isolationNote:
      'Hanya memuat portal Master Data (/?portal=master). Diunduh sebagai arsip mandiri khusus pemilik.',
    fileSlug: 'Website_Master',
    guideFilename: 'PANDUAN_PASANG_WEBSITE_MASTER.txt',
    topBarClass: 'bg-amber-600',
    iconTextClass: 'text-amber-700',
    buttonClass: 'bg-amber-600 hover:bg-amber-700 text-white',
    ctaLabel: 'Download ZIP Master',
  },
];

function buildPreviewZipFilename(storeName: string, fileSlug: string): string {
  const safeStoreSlug =
    storeName
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'TOKO';
  const dateStamp = new Date().toISOString().slice(0, 10);
  return `${safeStoreSlug}_${fileSlug}_AutoUpdate_${dateStamp}.zip`;
}

export function PortalDownloadTemplatePanel({
  storeName,
  storeTagline,
  permanentStoreUrl,
  onSavePermanentUrl,
  onNavigatePortal,
  onNotify,
  extraBackupActions,
}: PortalDownloadTemplatePanelProps) {
  const activeStoreName = (storeName || STORE_NAME).trim() || STORE_NAME;

  const defaultOrigin = useMemo(() => {
    const cleanPerm = (permanentStoreUrl || '').trim().replace(/\/+$/, '');
    if (cleanPerm && /^https?:\/\//i.test(cleanPerm)) {
      return cleanPerm;
    }
    return getShareableOrigin();
  }, [permanentStoreUrl]);

  const [customOriginInput, setCustomOriginInput] = useState<string>('');
  const [savingOrigin, setSavingOrigin] = useState(false);
  const [expandedPortal, setExpandedPortal] = useState<PortalZipTarget | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [lastDownloaded, setLastDownloaded] = useState<{
    portal: PortalZipTarget;
    label: string;
    filename: string;
  } | null>(null);

  const effectiveOrigin = useMemo(() => {
    const cleanCustom = customOriginInput.trim().replace(/\/+$/, '');
    if (cleanCustom && /^https?:\/\//i.test(cleanCustom)) {
      return cleanCustom;
    }
    return defaultOrigin;
  }, [customOriginInput, defaultOrigin]);

  const handleDownload = (spec: PortalTemplateSpec) => {
    const res = downloadSinglePortalDomainZip(spec.id, {
      storeName: activeStoreName,
      storeTagline,
      customBaseOrigin: effectiveOrigin,
    });
    setLastDownloaded({
      portal: spec.id,
      label: res.portalLabel,
      filename: res.filename,
    });
    onNotify?.(
      `${res.portalLabel} berhasil diunduh terpisah (1 file ZIP): ${res.filename}`
    );
  };

  const handleCopyUrl = async (key: string, url: string) => {
    await copyTextToClipboard(url);
    setCopiedKey(key);
    window.setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 1800);
  };

  return (
    <div className="space-y-6">
      {/* Top Overview & Domain Server Target */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div className="space-y-1.5 max-w-2xl">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <FileArchive className="w-4 h-4 text-blue-700 shrink-0" />
              <span>Template Distribusi Mandiri</span>
              <span aria-hidden="true">·</span>
              <span>1 Portal = 1 File ZIP Terpisah</span>
              <span aria-hidden="true">·</span>
              <span>Auto-Update Real-Time</span>
            </div>
            <h2 className="font-display text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
              Template Download Masing-Masing Portal (Tidak Digabungkan)
            </h2>
            <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
              Pilih dan unduh file <code className="font-mono text-slate-900">.zip</code> sesuai portal yang ingin dipasang ke domain tersendiri. Setiap file ZIP hanya berisi 1 portal yang dipilih dan otomatis tersambung ke alamat publik (<code className="font-mono text-slate-800">ais-pre-...</code>). Data database (produk, foto, logo, harga, promo) langsung berubah real-time; untuk perubahan tata letak/tampilan baru, cukup klik <strong>Share / Deploy</strong> sekali di AI Studio dan file ZIP otomatis ikut menampilkan versi terbaru tanpa perlu upload ulang.
            </p>
          </div>
          {extraBackupActions && (
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {extraBackupActions}
            </div>
          )}
        </div>

        {/* Target Origin Server Control */}
        <div className="pt-4 border-t border-slate-100 grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-3 items-end">
          <div>
            <label
              htmlFor="portal-zip-origin-input"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              URL Server Sumber Auto-Update (otomatis terisi — opsional ubah jika pakai domain custom)
            </label>
            <div className="relative">
              <Globe className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="portal-zip-origin-input"
                type="url"
                value={customOriginInput}
                onChange={(e) => setCustomOriginInput(e.target.value)}
                placeholder={defaultOrigin}
                className="w-full pl-9 pr-3 py-2 text-xs sm:text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {onSavePermanentUrl &&
              customOriginInput.trim() &&
              /^https:\/\//i.test(customOriginInput.trim()) && (
                <button
                  type="button"
                  disabled={savingOrigin}
                  onClick={async () => {
                    setSavingOrigin(true);
                    try {
                      const res = await onSavePermanentUrl(
                        customOriginInput.trim().replace(/\/+$/, '')
                      );
                      if (res.ok) {
                        setCustomOriginInput('');
                      } else if (res.error) {
                        onNotify?.(res.error);
                      }
                    } finally {
                      setSavingOrigin(false);
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer whitespace-nowrap disabled:opacity-50"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>
                    {savingOrigin ? 'Menyimpan...' : 'Simpan Permanen Online'}
                  </span>
                </button>
              )}
            {customOriginInput.trim() && (
              <button
                type="button"
                onClick={() => setCustomOriginInput('')}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer whitespace-nowrap"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Pakai Default</span>
              </button>
            )}
            <span className="text-xs text-slate-500 font-mono tabular-nums whitespace-nowrap">
              4 Paket Terpisah Siap Unduh
            </span>
          </div>
        </div>

        {lastDownloaded && (
          <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-emerald-900">
            <div className="flex items-start gap-2 min-w-0">
              <Check className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="font-semibold">
                  Berhasil mengunduh {lastDownloaded.label} (terpisah, tidak digabung)
                </p>
                <p className="font-mono text-[11px] text-emerald-800 truncate">
                  {lastDownloaded.filename}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setLastDownloaded(null)}
              className="text-emerald-700 hover:text-emerald-900 font-semibold self-end sm:self-center cursor-pointer whitespace-nowrap"
            >
              Tutup
            </button>
          </div>
        )}
      </section>

      {/* 4 Isolated Portal Template Cards */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        {PORTAL_TEMPLATES.map((spec) => {
          const portalUrl = getShareablePortalUrl(spec.id, effectiveOrigin);
          const zipFilename = buildPreviewZipFilename(activeStoreName, spec.fileSlug);
          const isExpanded = expandedPortal === spec.id;
          const isJustDownloaded = lastDownloaded?.portal === spec.id;
          const manifestFiles = [
            'BUKA_WEBSITE_DISINI.txt',
            'index.html',
            'manifest.json',
            '_redirects',
            'vercel.json',
            'netlify.toml',
            'htaccess_cpanel.txt',
            spec.guideFilename,
          ];

          return (
            <article
              key={spec.id}
              className={`bg-white border rounded-xl overflow-hidden flex flex-col transition-colors ${
                isJustDownloaded ? 'border-emerald-400' : 'border-slate-200'
              }`}
            >
              <div className={`h-1.5 w-full ${spec.topBarClass}`} />

              <div className="p-5 flex-1 flex flex-col justify-between gap-4">
                <div className="space-y-3.5">
                  {/* Card Header */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <span className="font-mono font-semibold text-slate-700">
                          {spec.indexLabel}.
                        </span>
                        <span>{spec.audience}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {spec.id === 'customer' && (
                          <ShoppingBag className={`w-4 h-4 shrink-0 ${spec.iconTextClass}`} />
                        )}
                        {spec.id === 'delivery' && (
                          <Truck className={`w-4 h-4 shrink-0 ${spec.iconTextClass}`} />
                        )}
                        {spec.id === 'admin' && (
                          <ShieldCheck className={`w-4 h-4 shrink-0 ${spec.iconTextClass}`} />
                        )}
                        {spec.id === 'master' && (
                          <Crown className={`w-4 h-4 shrink-0 ${spec.iconTextClass}`} />
                        )}
                        <h3 className="font-display text-base font-bold text-slate-900">
                          {spec.title}
                        </h3>
                      </div>
                      <p className="text-xs text-slate-600 leading-relaxed">
                        {spec.subtitle}
                      </p>
                    </div>
                  </div>

                  {/* Isolation Note */}
                  <p className="text-xs text-slate-600 bg-slate-50 border border-slate-100 rounded-lg px-3 py-2 leading-relaxed">
                    <strong className="text-slate-900">Isolasi File:</strong>{' '}
                    {spec.isolationNote}
                  </p>

                  {/* File & URL Spec Table */}
                  <div className="space-y-2 text-xs border-t border-slate-100 pt-3">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[11px] font-medium text-slate-500">
                        Nama File ZIP Terpisah
                      </span>
                      <code className="font-mono text-[11px] text-slate-900 bg-slate-50 border border-slate-200 px-2.5 py-1.5 rounded-md break-all">
                        {zipFilename}
                      </code>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[11px] font-medium text-slate-500">
                        Link Portal Tujuan
                      </span>
                      <code className="font-mono text-[11px] text-blue-800 bg-blue-50/50 border border-blue-100 px-2.5 py-1.5 rounded-md break-all">
                        {portalUrl}
                      </code>
                    </div>
                  </div>

                  {/* Expandable 7-File ZIP Contents Inspector */}
                  <div>
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedPortal((prev) => (prev === spec.id ? null : spec.id))
                      }
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                    >
                      <FileCode2 className="w-3.5 h-3.5 text-slate-500" />
                      <span>
                        Lihat isi paket ({manifestFiles.length} berkas khusus portal ini)
                      </span>
                      {isExpanded ? (
                        <ChevronUp className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronDown className="w-3.5 h-3.5" />
                      )}
                    </button>

                    {isExpanded && (
                      <ul className="mt-2 p-3 bg-slate-50 border border-slate-200 rounded-lg grid grid-cols-1 sm:grid-cols-2 gap-1.5 font-mono text-[11px] text-slate-700">
                        {manifestFiles.map((fname) => (
                          <li key={fname} className="truncate">
                            · {fname}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>

                {/* Action Footer */}
                <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center gap-2">
                  {typeof window !== 'undefined' &&
                  !(window as Window & { __ALPAMART_LOCKED_PORTAL__?: string })
                    .__ALPAMART_LOCKED_PORTAL__ ? (
                    <a
                      href={buildPortalZipDownloadUrl(spec.id, {
                        storeName: activeStoreName,
                        storeTagline,
                        customBaseOrigin: effectiveOrigin,
                      })}
                      download
                      onClick={() => {
                        setLastDownloaded({
                          portal: spec.id,
                          label: spec.title,
                          filename: zipFilename,
                        });
                        onNotify?.(
                          `${spec.title} sedang diunduh (Full Website Mandiri ±1,7 MB). Ekstrak menjadi 1 folder lalu upload ke Netlify / cPanel.`
                        );
                      }}
                      className={`flex-1 min-w-[175px] inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${spec.buttonClass}`}
                    >
                      <Download className="w-4 h-4 shrink-0" />
                      <span>{spec.ctaLabel}</span>
                    </a>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleDownload(spec)}
                      className={`flex-1 min-w-[175px] inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap ${spec.buttonClass}`}
                    >
                      <Download className="w-4 h-4 shrink-0" />
                      <span>{spec.ctaLabel}</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => handleCopyUrl(spec.id, portalUrl)}
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    {copiedKey === spec.id ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                        <span>Disalin</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Salin Link</span>
                      </>
                    )}
                  </button>

                  {onNavigatePortal ? (
                    <button
                      type="button"
                      onClick={() => onNavigatePortal(spec.id)}
                      className="inline-flex items-center justify-center gap-1 px-3 py-2.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0"
                    >
                      <span>Buka</span>
                      <ArrowUpRight className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <a
                      href={spec.id === 'customer' ? '/' : `/?portal=${spec.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center gap-1 px-3 py-2.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
                    >
                      <span>Buka</span>
                      <ArrowUpRight className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {/* Compact Usage Steps */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="p-3.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-950 leading-relaxed">
          <strong>Catatan Penting untuk Handphone (Android / iPhone):</strong> File <code className="font-mono">.zip</code> dibuat untuk di-upload ke hosting domain sendiri (Netlify / Vercel / cPanel). Jika dibuka langsung dari File Manager HP, keamanan Android/iOS memblokir file <code className="font-mono">index.html</code> lokal. Untuk membuka langsung di HP, klik tombol <strong>Buka</strong> atau <strong>Salin Link</strong> lalu buka di Chrome/Safari — atau buka file <code className="font-mono">BUKA_WEBSITE_DISINI.txt</code> di dalam ZIP.
        </div>
        <h3 className="text-xs font-bold text-slate-900">
          Cara Pakai File ZIP Masing-Masing Portal
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs text-slate-600 leading-relaxed">
          <div className="space-y-1">
            <p className="font-semibold text-slate-900">1. Ekstrak 1 File Sesuai Tujuan</p>
            <p>
              Setiap file ZIP sudah terpisah penuh (Pelanggan, Deliveri, Admin, Master) dengan format PKZIP universal tanpa file tersembunyi. Di dalamnya terdapat <code className="font-mono text-slate-800">BUKA_WEBSITE_DISINI.txt</code>, <code className="font-mono text-slate-800">index.html</code>, dan konfigurasi hosting siap pakai.
            </p>
          </div>
          <div className="space-y-1">
            <p className="font-semibold text-slate-900">2. Pasang ke Domain Sendiri (Ganti URL)</p>
            <p>
              Upload langsung ke Netlify Drop, Vercel, Cloudflare Pages, atau cPanel (<code className="font-mono text-slate-800">public_html</code>) untuk memakai alamat domain custom milik Anda sendiri.
            </p>
          </div>
          <div className="space-y-1">
            <p className="font-semibold text-slate-900">3. Otomatis Ter-Update Real-Time</p>
            <p>
              Tidak perlu unduh ulang setiap kali ubah harga, produk, stok, kurs, atau promo. Website yang terpasang otomatis menarik data terbaru dari server toko.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

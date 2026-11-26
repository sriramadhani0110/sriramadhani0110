import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Copy,
  Crown,
  Download,
  ExternalLink,
  Globe,
  Link2,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  ShoppingBag,
  Truck,
  Wifi,
} from 'lucide-react';
import type { SiteMode } from '../App';
import {
  copyTextToClipboard,
  getShareableOrigin,
  getShareablePortalUrl,
  normalizePureOrigin,
  STORE_NAME,
} from '../lib/catalogSeed';
import {
  buildPortalZipDownloadUrl,
  downloadSinglePortalDomainZip,
  type PortalZipTarget,
} from '../lib/portalZipExport';

interface MasterWebsiteUrlPanelProps {
  storeName?: string;
  storeTagline?: string;
  permanentStoreUrl?: string;
  saving?: boolean;
  onSavePermanentUrl: (
    nextUrl: string
  ) => Promise<{ ok: boolean; error?: string }>;
  onNavigatePortal?: (mode: SiteMode) => void;
  onNotify?: (message: string) => void;
}

interface DomainCheckResult {
  url: string;
  reachable: boolean;
  reason: string;
  message: string;
}

const PORTAL_PREVIEW_SPECS: {
  id: PortalZipTarget;
  index: string;
  title: string;
  audience: string;
  topAccent: string;
  iconColor: string;
  zipButtonClass: string;
}[] = [
  {
    id: 'customer',
    index: '01',
    title: 'Website Pelanggan (Toko Online)',
    audience: 'Publik · Tanpa Login',
    topAccent: 'bg-red-600',
    iconColor: 'text-red-600',
    zipButtonClass: 'bg-red-600 hover:bg-red-700 text-white',
  },
  {
    id: 'delivery',
    index: '02',
    title: 'Website Kurir Deliveri',
    audience: 'Kurir Lapangan · 1-Klik',
    topAccent: 'bg-blue-700',
    iconColor: 'text-blue-700',
    zipButtonClass: 'bg-blue-700 hover:bg-blue-800 text-white',
  },
  {
    id: 'admin',
    index: '03',
    title: 'Website Pengelola Admin',
    audience: 'Staf Admin · Login Terdaftar',
    topAccent: 'bg-slate-900',
    iconColor: 'text-slate-900',
    zipButtonClass: 'bg-slate-900 hover:bg-slate-800 text-white',
  },
  {
    id: 'master',
    index: '04',
    title: 'Website Master Data',
    audience: 'Pemilik Toko · Kontrol Penuh',
    topAccent: 'bg-amber-600',
    iconColor: 'text-amber-700',
    zipButtonClass: 'bg-amber-600 hover:bg-amber-700 text-white',
  },
];

function sanitizeCandidateUrl(raw: string): {
  normalized: string;
  error: string | null;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { normalized: '', error: null };
  }

  let candidate = trimmed;
  if (/^http:\/\//i.test(candidate)) {
    return {
      normalized: '',
      error: 'Link website wajib memakai https:// agar aman di semua HP & browser.',
    };
  }
  if (!/^https:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:') {
      return {
        normalized: '',
        error: 'Protokol URL harus https:// (contoh: https://nama-toko.netlify.app).',
      };
    }
    const host = parsed.hostname.toLowerCase();
    if (!host || !host.includes('.') || host.startsWith('.') || host.endsWith('.')) {
      return {
        normalized: '',
        error: 'Nama domain belum lengkap. Sertakan ekstensi domain seperti .netlify.app, .vercel.app, .com, atau .store.',
      };
    }
    const pureOrigin = normalizePureOrigin(parsed.origin)
      .replace(/^https:\/\/ais-dev-/i, 'https://ais-pre-')
      .slice(0, 240);
    return { normalized: pureOrigin, error: null };
  } catch {
    return {
      normalized: '',
      error: 'Format URL tidak valid. Contoh yang benar: https://nama-toko.netlify.app',
    };
  }
}

function getNetlifyDeploysUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith('.netlify.app')) {
      const siteSlug = host.slice(0, -'.netlify.app'.length);
      if (siteSlug && !siteSlug.includes('.')) {
        return `https://app.netlify.com/sites/${encodeURIComponent(siteSlug)}/deploys`;
      }
    }
  } catch {
    // ignore invalid url
  }
  return null;
}

async function probeDomainLiveStatus(url: string): Promise<DomainCheckResult> {
  try {
    const res = await fetch(
      `/api/check-domain-live?url=${encodeURIComponent(url)}`,
      { cache: 'no-store' }
    );
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    // On static hosts (Netlify / Cloudflare Pages / Vercel), /api/check-domain-live is not present
    // and SPA redirects return HTML. Allow direct online save without false unreachable warning.
    if (!contentType.includes('application/json')) {
      return {
        url,
        reachable: true,
        reason: 'STATIC_HOST_DIRECT',
        message: `Link ${url} siap disimpan langsung ke database toko dan otomatis tersinkron ke semua akun & link tanpa mulai dari 0.`,
      };
    }
    const data = (await res.json()) as {
      reachable?: boolean;
      reason?: string;
      message?: string;
    };
    return {
      url,
      reachable: Boolean(data.reachable),
      reason: data.reason || (data.reachable ? 'ONLINE' : 'UNREACHABLE'),
      message:
        data.message ||
        (data.reachable
          ? `Domain ${url} aktif dan bisa dibuka di browser.`
          : `Domain ${url} belum aktif di internet.`),
    };
  } catch {
    return {
      url,
      reachable: true,
      reason: 'STATIC_HOST_DIRECT',
      message: `Link ${url} siap disimpan ke database toko dan langsung tersinkron ke semua akun tanpa mereset data.`,
    };
  }
}

export function MasterWebsiteUrlPanel({
  storeName,
  storeTagline,
  permanentStoreUrl,
  saving = false,
  onSavePermanentUrl,
  onNavigatePortal,
  onNotify,
}: MasterWebsiteUrlPanelProps) {
  const activeStoreName = (storeName || STORE_NAME).trim() || STORE_NAME;
  const defaultOrigin = useMemo(() => getShareableOrigin(), []);

  const savedCustomUrl = useMemo(() => {
    const clean = (permanentStoreUrl || '').trim().replace(/\/+$/, '');
    return clean && /^https:\/\//i.test(clean) ? clean : '';
  }, [permanentStoreUrl]);

  const [urlInput, setUrlInput] = useState<string>(savedCustomUrl);
  const [submitting, setSubmitting] = useState(false);
  const [checkingLive, setCheckingLive] = useState(false);
  const [checkResult, setCheckResult] = useState<DomainCheckResult | null>(null);
  const [savedUrlCheck, setSavedUrlCheck] = useState<DomainCheckResult | null>(null);
  const [pendingUnreachableUrl, setPendingUnreachableUrl] = useState<string | null>(
    null
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const [localSuccess, setLocalSuccess] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    setUrlInput(savedCustomUrl);
  }, [savedCustomUrl]);

  // Automatically verify whether the currently saved custom URL is actually live on the internet
  useEffect(() => {
    if (!savedCustomUrl || savedCustomUrl === defaultOrigin) {
      setSavedUrlCheck(null);
      return;
    }
    let cancelled = false;
    void probeDomainLiveStatus(savedCustomUrl).then((result) => {
      if (!cancelled) {
        setSavedUrlCheck(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [savedCustomUrl, defaultOrigin]);

  const validation = useMemo(() => sanitizeCandidateUrl(urlInput), [urlInput]);

  const activeSavedOrigin = savedCustomUrl || defaultOrigin;
  const previewOrigin = useMemo(() => {
    if (!urlInput.trim()) return defaultOrigin;
    if (validation.normalized) return validation.normalized;
    return activeSavedOrigin;
  }, [urlInput, validation.normalized, defaultOrigin, activeSavedOrigin]);

  const hasUnsavedChanges = useMemo(() => {
    const target =
      urlInput.trim() === '' ? '' : validation.normalized || urlInput.trim();
    return target !== savedCustomUrl;
  }, [urlInput, validation.normalized, savedCustomUrl]);

  const handleCheckInputUrl = useCallback(async () => {
    setLocalError(null);
    setLocalSuccess(null);
    setPendingUnreachableUrl(null);
    const { normalized, error } = sanitizeCandidateUrl(urlInput);
    if (error) {
      setLocalError(error);
      return;
    }
    const target = normalized || defaultOrigin;
    setCheckingLive(true);
    try {
      const result = await probeDomainLiveStatus(target);
      setCheckResult(result);
    } finally {
      setCheckingLive(false);
    }
  }, [urlInput, defaultOrigin]);

  const commitSaveUrl = async (finalToSave: string) => {
    setSubmitting(true);
    setLocalError(null);
    setLocalSuccess(null);
    setPendingUnreachableUrl(null);
    try {
      const res = await onSavePermanentUrl(finalToSave);
      if (!res.ok) {
        setLocalError(res.error || 'Gagal menyimpan link URL website secara online.');
        return;
      }
      setUrlInput(finalToSave);
      setLocalSuccess(
        finalToSave
          ? `Link URL website berhasil diganti online ke ${finalToSave} dan langsung tersinkron ke semua akun.`
          : `Link URL website berhasil dikembalikan ke URL Server Aktif (${defaultOrigin}) di semua akun.`
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setLocalSuccess(null);
    setPendingUnreachableUrl(null);

    const { normalized, error } = sanitizeCandidateUrl(urlInput);
    if (error) {
      setLocalError(error);
      return;
    }

    const finalToSave = normalized === defaultOrigin ? '' : normalized;
    if (!finalToSave) {
      await commitSaveUrl('');
      return;
    }

    // Verify that the custom domain actually exists & responds on the internet before replacing live links
    setCheckingLive(true);
    const probe = await probeDomainLiveStatus(finalToSave);
    setCheckingLive(false);
    setCheckResult(probe);

    if (!probe.reachable) {
      setPendingUnreachableUrl(finalToSave);
      return;
    }

    await commitSaveUrl(finalToSave);
  };

  const handleResetDefault = async () => {
    setCheckResult(null);
    setSavedUrlCheck(null);
    await commitSaveUrl('');
  };

  const handleCopy = async (key: string, value: string) => {
    await copyTextToClipboard(value);
    setCopiedKey(key);
    window.setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 1800);
  };

  const handleDownloadPortalZip = (portal: PortalZipTarget) => {
    // Always wire ZIP iframe to the real live backend server (defaultOrigin) so uploading to
    // Netlify / Vercel / Cloudflare / cPanel works immediately without self-loop or DNS error.
    const res = downloadSinglePortalDomainZip(portal, {
      storeName: activeStoreName,
      storeTagline,
      customBaseOrigin: defaultOrigin,
    });
    onNotify?.(
      `${res.portalLabel} siap upload ke hosting (${res.filename}) — tersambung otomatis ke server aktif.`
    );
  };

  const isStandaloneStaticHost =
    typeof window !== 'undefined' &&
    Boolean(
      (window as Window & { __ALPAMART_LOCKED_PORTAL__?: string })
        .__ALPAMART_LOCKED_PORTAL__
    );

  const getDirectZipHref = (portal: PortalZipTarget): string =>
    buildPortalZipDownloadUrl(portal, {
      storeName: activeStoreName,
      storeTagline,
      customBaseOrigin: defaultOrigin,
    });

  const netlifyDeploysUrl = useMemo(
    () => getNetlifyDeploysUrl(savedCustomUrl || validation.normalized),
    [savedCustomUrl, validation.normalized]
  );

  const isBusy = submitting || saving || checkingLive;

  return (
    <div className="space-y-6">
      {/* Live Warning if Currently Saved Custom URL is NOT Active on the Internet */}
      {savedCustomUrl && savedUrlCheck && !savedUrlCheck.reachable && (
        <section className="bg-amber-50 border border-amber-300 rounded-xl p-5 space-y-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
            <div className="space-y-1.5">
              <h2 className="font-display text-sm sm:text-base font-bold text-amber-950">
                Link Custom <span className="font-mono">{savedCustomUrl}</span> Belum Bisa Dibuka di Browser
              </h2>
              <p className="text-xs sm:text-sm text-amber-900 leading-relaxed">
                {savedUrlCheck.message}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 pt-1">
            {!isStandaloneStaticHost ? (
              <a
                href={getDirectZipHref('customer')}
                download
                onClick={() =>
                  onNotify?.(
                    'Mengunduh ZIP Full Website Pelanggan terbaru (±1,7 MB). Ekstrak menjadi 1 folder lalu upload ke tab Deploys Netlify.'
                  )
                }
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5 shrink-0" />
                <span>1. Download ZIP Full Website Terbaru</span>
              </a>
            ) : (
              <button
                type="button"
                onClick={() => handleDownloadPortalZip('customer')}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5 shrink-0" />
                <span>1. Download ZIP Full Website Terbaru</span>
              </button>
            )}

            <a
              href={netlifyDeploysUrl || 'https://app.netlify.com/drop'}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap"
            >
              <span>
                {netlifyDeploysUrl
                  ? '2. Buka Tab Deploys Netlify'
                  : '2. Buka Netlify Drop'}
              </span>
              <ArrowUpRight className="w-3.5 h-3.5 shrink-0" />
            </a>

            <button
              type="button"
              disabled={isBusy}
              onClick={handleResetDefault}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-amber-950 bg-white border border-amber-400 hover:bg-amber-100 rounded-lg transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
            >
              <RotateCcw className="w-3.5 h-3.5 shrink-0" />
              <span>Pakai URL Server Aktif Sekarang</span>
            </button>
          </div>
        </section>
      )}

      {/* Main Template Card: Online URL Replacement */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4 border-b border-slate-100 pb-4">
          <div className="space-y-1.5 max-w-3xl">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <Globe className="w-4 h-4 text-blue-700 shrink-0" />
              <span>Template Master Online</span>
              <span aria-hidden="true">·</span>
              <span>
                {savedCustomUrl
                  ? savedUrlCheck && !savedUrlCheck.reachable
                    ? 'Domain Custom Belum Terpasang di Hosting'
                    : 'Domain Custom Aktif di Semua Akun'
                  : 'URL Server Aktif Siap Dibuka'}
              </span>
              <span aria-hidden="true">·</span>
              <span>Sinkron Real-Time 4 Portal</span>
            </div>
            <h2 className="font-display text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
              Template Ganti Link URL Website Secara Online (Tanpa Ulang dari 0)
            </h2>
            <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
              Saat Anda mengganti link URL di sini, <strong>seluruh produk, stok, kategori, harga, logo, jam buka, dan akun tetap 100% utuh (tidak pernah reset dari 0)</strong>. Semua link lama maupun link baru yang terhubung ke database toko ini otomatis langsung mengikuti data &amp; URL terbaru secara real-time. Untuk update tampilan/fitur otomatis ke semua link tanpa upload ZIP ulang, hubungkan semua situs hosting Anda (Netlify / Cloudflare Pages / Vercel) ke <strong>repository GitHub yang sama</strong>.
            </p>
          </div>

          <a
            href={
              savedUrlCheck && !savedUrlCheck.reachable
                ? defaultOrigin
                : activeSavedOrigin
            }
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 self-start"
          >
            <ExternalLink className="w-3.5 h-3.5 shrink-0" />
            <span>Buka Website Aktif</span>
          </a>
        </div>

        {/* Active vs Backup URL Readout */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-slate-700">
                Link URL Website Tersimpan Saat Ini
              </span>
              <span
                className={`font-semibold ${
                  savedUrlCheck && !savedUrlCheck.reachable
                    ? 'text-amber-700'
                    : 'text-emerald-700'
                }`}
              >
                {savedCustomUrl
                  ? savedUrlCheck && !savedUrlCheck.reachable
                    ? 'Belum Aktif di Internet'
                    : 'Domain Custom Online'
                  : 'Aktif Siap Dibuka'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <code className="font-mono text-xs sm:text-sm font-semibold text-blue-800 break-all">
                {activeSavedOrigin}
              </code>
              <button
                type="button"
                onClick={() => handleCopy('active-origin', activeSavedOrigin)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-md cursor-pointer whitespace-nowrap shrink-0"
              >
                {copiedKey === 'active-origin' ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                    <span>Disalin</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Salin</span>
                  </>
                )}
              </button>
            </div>
          </div>

          <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-slate-700">
                URL Server Publik Bawaan (100% Langsung Bisa Dibuka)
              </span>
              <span className="font-semibold text-emerald-700">Online</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <code className="font-mono text-xs text-slate-700 break-all">
                {defaultOrigin}
              </code>
              <button
                type="button"
                onClick={() => handleCopy('default-origin', defaultOrigin)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-md cursor-pointer whitespace-nowrap shrink-0"
              >
                {copiedKey === 'default-origin' ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                    <span>Disalin</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Salin</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Form Input for Replacing Online Website URL */}
        <form onSubmit={handleSubmit} className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <label
              htmlFor="master-online-website-url"
              className="block text-xs sm:text-sm font-semibold text-slate-800"
            >
              Tempel Link URL Website yang Sudah Aktif di Hosting (HTTPS)
            </label>
            <div className="flex flex-col lg:flex-row gap-2.5">
              <div className="relative flex-1">
                <Link2 className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="master-online-website-url"
                  type="text"
                  inputMode="url"
                  autoComplete="url"
                  maxLength={240}
                  value={urlInput}
                  onChange={(e) => {
                    setUrlInput(e.target.value);
                    setLocalError(null);
                    setLocalSuccess(null);
                    setCheckResult(null);
                    setPendingUnreachableUrl(null);
                  }}
                  placeholder="Tempel link aktif dari Netlify / Vercel / cPanel (contoh: https://nama-toko.netlify.app)"
                  className="w-full pl-10 pr-4 py-2.5 text-sm font-mono bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-700 focus:border-blue-700"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  disabled={isBusy || Boolean(validation.error)}
                  onClick={handleCheckInputUrl}
                  className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 text-xs sm:text-sm font-semibold text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
                >
                  <Wifi className="w-4 h-4 text-blue-700 shrink-0" />
                  <span>{checkingLive ? 'Mengecek...' : 'Cek Status URL'}</span>
                </button>

                <button
                  type="submit"
                  disabled={isBusy || Boolean(validation.error)}
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-xs sm:text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
                >
                  {isBusy ? (
                    <RefreshCw className="w-4 h-4 animate-spin shrink-0" />
                  ) : (
                    <Save className="w-4 h-4 shrink-0" />
                  )}
                  <span>
                    {checkingLive
                      ? 'Memverifikasi...'
                      : submitting
                        ? 'Menyimpan...'
                        : 'Cek & Simpan Online'}
                  </span>
                </button>

                {savedCustomUrl && (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={handleResetDefault}
                    className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 text-xs sm:text-sm font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
                  >
                    <RotateCcw className="w-4 h-4 shrink-0" />
                    <span>Pakai Default Aktif</span>
                  </button>
                )}
              </div>
            </div>

            {/* Live Normalized URL Feedback */}
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs pt-0.5">
              {validation.error ? (
                <p className="text-rose-700 font-medium">{validation.error}</p>
              ) : urlInput.trim() ? (
                <p className="text-slate-600">
                  Alamat tujuan:{' '}
                  <code className="font-mono font-semibold text-blue-800">
                    {validation.normalized}
                  </code>
                  {hasUnsavedChanges && (
                    <span className="text-amber-700 font-medium">
                      {' '}
                      · Belum disimpan
                    </span>
                  )}
                </p>
              ) : (
                <p className="text-slate-500">
                  Kosongkan kolom lalu simpan jika ingin memakai URL Server Aktif (
                  <span className="font-mono">{defaultOrigin}</span>).
                </p>
              )}
            </div>
          </div>

          {/* Live Domain Probe Result */}
          {checkResult && (
            <div
              className={`p-4 rounded-lg border text-xs sm:text-sm space-y-2.5 ${
                checkResult.reachable
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-950'
                  : 'bg-rose-50 border-rose-200 text-rose-950'
              }`}
            >
              <div className="flex items-start gap-2.5">
                {checkResult.reachable ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-rose-700 shrink-0 mt-0.5" />
                )}
                <div className="space-y-1">
                  <p className="font-bold">
                    {checkResult.reachable
                      ? 'Domain Terverifikasi Aktif di Internet'
                      : 'Domain Belum Bisa Dibuka di Browser'}
                  </p>
                  <p className="leading-relaxed">{checkResult.message}</p>
                </div>
              </div>

              {pendingUnreachableUrl && (
                <div className="pt-2 border-t border-rose-200 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-rose-800">
                    Disarankan upload file ZIP ke hosting terlebih dahulu agar link langsung bisa dibuka pelanggan.
                  </p>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => commitSaveUrl(pendingUnreachableUrl)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-rose-900 bg-white border border-rose-300 hover:bg-rose-100 rounded-md cursor-pointer whitespace-nowrap"
                  >
                    <span>Tetap Simpan URL Ini</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {localError && (
            <div className="p-3.5 rounded-lg bg-rose-50 border border-rose-200 text-xs sm:text-sm font-medium text-rose-800">
              {localError}
            </div>
          )}

          {localSuccess && (
            <div className="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs sm:text-sm font-medium text-emerald-900 flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
              <span>{localSuccess}</span>
            </div>
          )}
        </form>
      </section>

      {/* 3-Step Real Activation Guide (So Custom URL Actually Opens in Every Browser) */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-base font-bold text-slate-900">
              Hosting Gratis 100% Bersih Tanpa Watermark &quot;Powered by&quot; (Rekomendasi: Cloudflare Pages)
            </h3>
            <p className="text-xs text-slate-600 mt-0.5">
              Netlify paket gratis otomatis menampilkan lencana <em>&quot;Powered by Netlify&quot;</em>. Gunakan <strong>Cloudflare Pages</strong> (gratis &amp; 100% bersih tanpa badge apapun) atau cPanel/Vercel:
            </p>
          </div>
          <a
            href="https://dash.cloudflare.com/?to=/:account/workers-and-pages/create/pages"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <span>Buka Cloudflare Pages (Gratis &amp; Bersih)</span>
            <ArrowUpRight className="w-3.5 h-3.5 shrink-0" />
          </a>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs text-slate-600 leading-relaxed pt-1 border-t border-slate-100">
          <div className="space-y-1">
            <p className="font-bold text-slate-900">
              1. Unduh File ZIP Full Website Mandiri di Bawah
            </p>
            <p>
              Klik <strong>Download ZIP Hosting</strong> pada portal yang diinginkan (misal Pelanggan). File ZIP berisi <strong>aplikasi website lengkap (tanpa iframe &amp; anti blokir browser)</strong> yang langsung tersambung real-time ke database toko Anda.
            </p>
          </div>
          <div className="space-y-1">
            <p className="font-bold text-slate-900">
              2. Upload Langsung ke Cloudflare Pages / cPanel
            </p>
            <p>
              Di <strong>Cloudflare Pages → Direct Upload</strong>, Anda bisa <strong>langsung upload file .zip tanpa ekstrak</strong> (hasilnya 100% bersih tanpa watermark <em>Powered by</em>). Untuk cPanel, upload file ZIP ke <code className="font-mono text-slate-800">public_html</code> lalu klik <strong>Extract</strong>.
            </p>
          </div>
          <div className="space-y-1">
            <p className="font-bold text-slate-900">
              3. Tempel Link Baru di Atas &amp; Simpan Online
            </p>
            <p>
              Setelah link <code className="font-mono text-slate-800">.pages.dev</code> atau domain pribadi Anda aktif, tempel ke kolom di atas lalu klik <strong>Cek &amp; Simpan Online</strong> agar semua 4 akun otomatis memakai link bersih tersebut.
            </p>
          </div>
        </div>
      </section>

      {/* Live Preview of All 4 Portal Links + Ready-to-Upload Hosting ZIPs */}
      <section className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h3 className="font-display text-base sm:text-lg font-bold text-slate-900">
              Link 4 Website Portal &amp; File ZIP Siap Upload Hosting
            </h3>
            <p className="text-xs text-slate-500">
              Tombol Download ZIP selalu mengarah ke server aktif (<span className="font-mono">{defaultOrigin}</span>) agar aman saat di-upload ke domain custom Anda.
            </p>
          </div>
          <span className="font-mono text-xs text-slate-600 tabular-nums whitespace-nowrap">
            4 Portal Tersinkron
          </span>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {PORTAL_PREVIEW_SPECS.map((spec) => {
            const generatedUrl = getShareablePortalUrl(spec.id, previewOrigin);
            const copyId = `portal-url-${spec.id}`;
            return (
              <article
                key={spec.id}
                className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col justify-between"
              >
                <div className={`h-1.5 w-full ${spec.topAccent}`} />
                <div className="p-5 space-y-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <span className="font-mono font-semibold text-slate-700">
                        {spec.index}.
                      </span>
                      <span>{spec.audience}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {spec.id === 'customer' && (
                        <ShoppingBag className={`w-4 h-4 shrink-0 ${spec.iconColor}`} />
                      )}
                      {spec.id === 'delivery' && (
                        <Truck className={`w-4 h-4 shrink-0 ${spec.iconColor}`} />
                      )}
                      {spec.id === 'admin' && (
                        <ShieldCheck className={`w-4 h-4 shrink-0 ${spec.iconColor}`} />
                      )}
                      {spec.id === 'master' && (
                        <Crown className={`w-4 h-4 shrink-0 ${spec.iconColor}`} />
                      )}
                      <h4 className="font-display text-base font-bold text-slate-900">
                        {spec.title}
                      </h4>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <span className="text-[11px] font-medium text-slate-500">
                      Alamat URL Portal
                    </span>
                    <code className="block font-mono text-xs text-blue-800 bg-blue-50/60 border border-blue-100 px-3 py-2 rounded-lg break-all">
                      {generatedUrl}
                    </code>
                  </div>

                  <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleCopy(copyId, generatedUrl)}
                      className="flex-1 min-w-[125px] inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                    >
                      {copiedKey === copyId ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-600" />
                          <span>Link Disalin</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span>Salin Link</span>
                        </>
                      )}
                    </button>

                    {!isStandaloneStaticHost ? (
                      <a
                        href={getDirectZipHref(spec.id)}
                        download
                        onClick={() =>
                          onNotify?.(
                            `${spec.title}: mengunduh ZIP Full Website Mandiri (±1,7 MB). Ekstrak menjadi 1 folder lalu upload ke Netlify Deploys / Cloudflare Pages / cPanel.`
                          )
                        }
                        className={`inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${spec.zipButtonClass}`}
                      >
                        <Download className="w-3.5 h-3.5 shrink-0" />
                        <span>Download ZIP Hosting</span>
                      </a>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleDownloadPortalZip(spec.id)}
                        className={`inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0 ${spec.zipButtonClass}`}
                      >
                        <Download className="w-3.5 h-3.5 shrink-0" />
                        <span>Download ZIP Hosting</span>
                      </button>
                    )}

                    <a
                      href={generatedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center gap-1 px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
                    >
                      <span>Buka URL</span>
                      <ArrowUpRight className="w-3.5 h-3.5" />
                    </a>

                    {onNavigatePortal && (
                      <button
                        type="button"
                        onClick={() => onNavigatePortal(spec.id)}
                        className="inline-flex items-center justify-center gap-1 px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 rounded-lg cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <span>Pratinjau</span>
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

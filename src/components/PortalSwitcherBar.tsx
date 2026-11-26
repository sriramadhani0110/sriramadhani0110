import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  Crown,
  Download,
  ExternalLink,
  LayoutGrid,
  RefreshCw,
  ShieldCheck,
  ShoppingBag,
  Truck,
} from 'lucide-react';
import type { SiteMode } from '../App';
import {
  downloadSinglePortalDomainZip,
  type PortalZipTarget,
} from '../lib/portalZipExport';
import { broadcastCrossTabEvent } from '../lib/crossAccountSync';
import { DEFAULT_STORE_LOGO_URL } from '../lib/storeDefaults';

interface PortalSwitcherBarProps {
  currentSiteMode: SiteMode;
  onNavigatePortal: (mode: SiteMode) => void;
  onOpenPortalGuide?: () => void;
  signedInEmail?: string | null;
  storeName?: string;
  storeLogoUrl?: string;
  permanentStoreUrl?: string;
}

const PORTAL_ITEMS: {
  mode: SiteMode;
  label: string;
  href: string;
  activeClass: string;
}[] = [
  {
    mode: 'customer',
    label: 'Pelanggan',
    href: '/',
    activeClass: 'bg-red-600 text-white border-red-600',
  },
  {
    mode: 'delivery',
    label: 'Kurir',
    href: '/kurir',
    activeClass: 'bg-blue-700 text-white border-blue-700',
  },
  {
    mode: 'admin',
    label: 'Admin',
    href: '/admin',
    activeClass: 'bg-slate-900 text-white border-slate-900',
  },
  {
    mode: 'master',
    label: 'Master Data',
    href: '/master',
    activeClass: 'bg-amber-600 text-white border-amber-600',
  },
];

const ZIP_MENU_ITEMS: {
  portal: PortalZipTarget;
  label: string;
  desc: string;
  iconColor: string;
}[] = [
  {
    portal: 'customer',
    label: 'ZIP Website Pelanggan (1 File)',
    desc: 'Khusus toko online pelanggan',
    iconColor: 'text-red-600',
  },
  {
    portal: 'delivery',
    label: 'ZIP Website Deliveri (1 File)',
    desc: 'Khusus portal kurir pengantaran',
    iconColor: 'text-blue-700',
  },
  {
    portal: 'admin',
    label: 'ZIP Website Admin (1 File)',
    desc: 'Khusus dashboard admin toko',
    iconColor: 'text-slate-900',
  },
  {
    portal: 'master',
    label: 'ZIP Website Master (1 File)',
    desc: 'Khusus portal Master Data',
    iconColor: 'text-amber-600',
  },
];

export function PortalSwitcherBar({
  currentSiteMode,
  onNavigatePortal,
  onOpenPortalGuide,
  signedInEmail,
  storeName,
  storeLogoUrl,
  permanentStoreUrl,
}: PortalSwitcherBarProps) {
  const brandLogo = storeLogoUrl?.trim() || DEFAULT_STORE_LOGO_URL;
  const [zipMenuOpen, setZipMenuOpen] = useState(false);
  const [downloadedLabel, setDownloadedLabel] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const zipMenuRef = useRef<HTMLDivElement | null>(null);

  const handleSyncAllAccounts = () => {
    if (syncingAll) return;
    setSyncingAll(true);
    broadcastCrossTabEvent({ type: 'revision_broadcast', source: 'portal_switcher_sync' });
    window.dispatchEvent(new Event('alpamart_manual_sync_all'));
    setDownloadedLabel('Sinkronisasi semua akun dijalankan');
    window.setTimeout(() => {
      setSyncingAll(false);
    }, 900);
    window.setTimeout(() => {
      setDownloadedLabel((prev) =>
        prev === 'Sinkronisasi semua akun dijalankan' ? null : prev
      );
    }, 3000);
  };

  useEffect(() => {
    if (!zipMenuOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (zipMenuRef.current && !zipMenuRef.current.contains(e.target as Node)) {
        setZipMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [zipMenuOpen]);

  const handleDownloadPortalZip = (portal: PortalZipTarget) => {
    const res = downloadSinglePortalDomainZip(portal, {
      storeName,
      customBaseOrigin: permanentStoreUrl,
    });
    setZipMenuOpen(false);
    setDownloadedLabel(`Terunduh: ${res.portalLabel}`);
    window.setTimeout(() => setDownloadedLabel(null), 3000);
  };

  return (
    <div className="bg-slate-950 text-white border-b border-slate-800 no-print">
      <div className="max-w-[1520px] mx-auto px-3 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-2">
        {/* 1-Browser Multi-Portal Tabs (Click = switch here, Icon = open in new tab of same browser) */}
        <div className="flex items-center gap-1.5 overflow-x-auto max-w-full py-0.5">
          <div className="inline-flex items-center gap-2 pr-2 mr-1 border-r border-slate-800 shrink-0">
            <img
              src={brandLogo}
              alt={storeName || 'ALPAMART'}
              referrerPolicy="no-referrer"
              onError={(e) => {
                const img = e.currentTarget;
                if (!img.dataset.fallbackApplied) {
                  img.dataset.fallbackApplied = '1';
                  img.src = DEFAULT_STORE_LOGO_URL;
                }
              }}
              className="w-7 h-7 rounded-md object-contain bg-white p-0.5 shrink-0"
            />
            <span className="hidden xl:inline-block font-display text-xs font-bold tracking-tight text-white max-w-[140px] truncate">
              {storeName || 'ALPAMART'}
            </span>
          </div>
          {PORTAL_ITEMS.map((item) => {
            const isActive = currentSiteMode === item.mode;
            return (
              <div
                key={item.mode}
                className={`inline-flex items-center rounded-lg border text-xs font-semibold transition-colors shrink-0 ${
                  isActive
                    ? item.activeClass
                    : 'bg-slate-900 text-slate-200 border-slate-700 hover:border-slate-500'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onNavigatePortal(item.mode)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 cursor-pointer whitespace-nowrap"
                >
                  {item.mode === 'customer' && <ShoppingBag className="w-3.5 h-3.5 shrink-0" />}
                  {item.mode === 'delivery' && <Truck className="w-3.5 h-3.5 shrink-0" />}
                  {item.mode === 'admin' && <ShieldCheck className="w-3.5 h-3.5 shrink-0" />}
                  {item.mode === 'master' && <Crown className="w-3.5 h-3.5 shrink-0" />}
                  <span>{item.label}</span>
                </button>
                <a
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Buka ${item.label} di tab baru`}
                  aria-label={`Buka ${item.label} di tab baru`}
                  className={`pr-2 pl-1 py-1.5 border-l transition-opacity ${
                    isActive
                      ? 'border-white/25 text-white/85 hover:text-white'
                      : 'border-slate-700 text-slate-400 hover:text-white'
                  }`}
                >
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            );
          })}
        </div>

        {/* Right Side: Signed-in Email + Separate 1-Website-1-File ZIP Menu + All Links Modal */}
        <div className="flex items-center gap-2 shrink-0">
          {downloadedLabel && (
            <span className="hidden lg:inline-block text-[11px] font-semibold text-emerald-300 whitespace-nowrap">
              {downloadedLabel}
            </span>
          )}
          {signedInEmail && !downloadedLabel && (
            <span className="hidden md:inline-block font-mono text-[11px] text-emerald-300 truncate max-w-[200px]">
              {signedInEmail}
            </span>
          )}

          {/* Separate 1-Website = 1-ZIP Dropdown */}
          <div className="relative" ref={zipMenuRef}>
            <button
              type="button"
              onClick={() => setZipMenuOpen((prev) => !prev)}
              aria-expanded={zipMenuOpen}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold text-white bg-blue-700 hover:bg-blue-600 border border-blue-600 rounded-lg cursor-pointer whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5 shrink-0" />
              <span>Download ZIP (1 Web = 1 File)</span>
              <ChevronDown className="w-3 h-3 shrink-0" />
            </button>

            {zipMenuOpen && (
              <div className="absolute right-0 mt-1.5 w-64 bg-white text-slate-900 border border-slate-200 rounded-xl shadow-xl z-50 overflow-hidden">
                <div className="px-3 py-2 bg-slate-50 border-b border-slate-200">
                  <p className="text-[11px] font-bold text-slate-800">
                    Pilih Website (Terpisah 1 File / Web)
                  </p>
                  <p className="text-[10px] text-slate-500">
                    Masing-masing file ZIP hanya berisi 1 website &amp; auto-update.
                  </p>
                </div>
                <div className="divide-y divide-slate-100">
                  {ZIP_MENU_ITEMS.map((item) => (
                    <button
                      key={item.portal}
                      type="button"
                      onClick={() => handleDownloadPortalZip(item.portal)}
                      className="w-full px-3 py-2.5 flex items-start gap-2.5 text-left hover:bg-blue-50 transition-colors cursor-pointer"
                    >
                      <Download className={`w-4 h-4 mt-0.5 shrink-0 ${item.iconColor}`} />
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-slate-900">
                          {item.label}
                        </p>
                        <p className="text-[11px] text-slate-500">{item.desc}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            disabled={syncingAll}
            onClick={handleSyncAllAccounts}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-100 bg-emerald-800 hover:bg-emerald-700 border border-emerald-700 rounded-lg cursor-pointer whitespace-nowrap disabled:opacity-60"
          >
            <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${syncingAll ? 'animate-spin' : ''}`} />
            <span>{syncingAll ? 'Menyinkronkan...' : 'Sinkron Semua Akun'}</span>
          </button>

          {onOpenPortalGuide && (
            <button
              type="button"
              onClick={onOpenPortalGuide}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold text-slate-100 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg cursor-pointer whitespace-nowrap"
            >
              <LayoutGrid className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              <span>Semua Link Situs</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

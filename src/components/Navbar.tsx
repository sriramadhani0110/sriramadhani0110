import { ShoppingBag } from 'lucide-react';
import type { StoreMasterConfig } from '../types/marketplace';
import { DEFAULT_MASTER_CONFIG, THEME_ACCENT_STYLES } from '../lib/storeDefaults';

export type ActivePage =
  | 'storefront'
  | 'catalog'
  | 'promo'
  | 'search'
  | 'orders';

interface NavbarProps {
  activePage: ActivePage;
  onNavigate: (page: ActivePage, sectionId?: string) => void;
  cartCount: number;
  onOpenCart: () => void;
  masterConfig?: StoreMasterConfig;
}

export function Navbar({
  activePage,
  onNavigate,
  cartCount,
  onOpenCart,
  masterConfig,
}: NavbarProps) {
  const master = masterConfig || DEFAULT_MASTER_CONFIG;
  const theme = THEME_ACCENT_STYLES[master.themeAccent] || THEME_ACCENT_STYLES.blue_red;
  const announcement = master.announcementBarText?.trim() || '';

  return (
    <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-sm border-b border-slate-200 no-print">
      {announcement && (
        <div className="bg-slate-900 text-white text-center text-[11px] sm:text-xs font-medium px-4 py-1.5 leading-snug">
          {announcement}
        </div>
      )}
      {/* Theme top hairline */}
      <div className={`h-1 w-full ${theme.topBar}`} />
      <div className="max-w-[1520px] mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4 sm:gap-8">
        {/* Zone 1: Dynamic Store Logo + Wordmark */}
        <button
          type="button"
          onClick={() => onNavigate('storefront')}
          className="inline-flex items-center gap-2.5 min-w-0 text-left hover:opacity-90 transition-opacity cursor-pointer"
        >
          <img
            src={master.storeLogoUrl || DEFAULT_MASTER_CONFIG.storeLogoUrl}
            alt={master.storeName}
            referrerPolicy="no-referrer"
            onError={(e) => {
              const img = e.currentTarget;
              if (!img.dataset.fallbackApplied) {
                img.dataset.fallbackApplied = '1';
                img.src = DEFAULT_MASTER_CONFIG.storeLogoUrl;
              }
            }}
            className="w-10 h-10 rounded-lg object-contain bg-white border border-slate-200 p-0.5 shrink-0 shadow-xs"
          />
          <span className="font-display text-base sm:text-lg font-bold tracking-tight text-slate-900 truncate">
            {master.storeName}
          </span>
        </button>

        {/* Zone 2: Concise single-line customer navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
          <button
            type="button"
            onClick={() => onNavigate('catalog')}
            className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors cursor-pointer ${
              activePage === 'catalog'
                ? 'text-blue-700 border-blue-700 font-semibold'
                : 'border-transparent hover:text-slate-900 hover:border-slate-300'
            }`}
          >
            Catalog
          </button>
          <button
            type="button"
            onClick={() => onNavigate('promo')}
            className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors cursor-pointer ${
              activePage === 'promo'
                ? 'text-red-600 border-red-600 font-semibold'
                : 'border-transparent hover:text-slate-900 hover:border-slate-300'
            }`}
          >
            Promo & Diskon
          </button>
          <button
            type="button"
            onClick={() => onNavigate('search')}
            className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors cursor-pointer ${
              activePage === 'search'
                ? 'text-red-600 border-red-600 font-semibold'
                : 'border-transparent hover:text-slate-900 hover:border-slate-300'
            }`}
          >
            Pencarian
          </button>
          <button
            type="button"
            onClick={() => onNavigate('orders')}
            className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors cursor-pointer ${
              activePage === 'orders'
                ? 'text-blue-700 border-blue-700 font-semibold'
                : 'border-transparent hover:text-slate-900 hover:border-slate-300'
            }`}
          >
            Lacak Pesanan
          </button>
        </nav>

        {/* Zone 3: Primary Cart action */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onOpenCart}
            className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${theme.primaryBtn}`}
          >
            <ShoppingBag className="w-4 h-4 shrink-0" />
            <span>Keranjang</span>
            <span className="font-mono tabular-nums text-xs bg-white/20 px-1.5 py-0.5 rounded">
              {cartCount}
            </span>
          </button>
        </div>
      </div>

      {/* Mobile secondary nav row kept compact */}
      <div className="md:hidden border-t border-slate-100 px-4 py-2 flex items-center justify-between gap-4 overflow-x-auto text-xs font-medium text-slate-600">
        <button
          type="button"
          onClick={() => onNavigate('catalog')}
          className={`whitespace-nowrap shrink-0 py-1 ${
            activePage === 'catalog' ? 'text-blue-700 font-semibold' : ''
          }`}
        >
          Catalog
        </button>
        <button
          type="button"
          onClick={() => onNavigate('promo')}
          className={`whitespace-nowrap shrink-0 py-1 ${
            activePage === 'promo' ? 'text-red-600 font-semibold' : ''
          }`}
        >
          Promo & Diskon
        </button>
        <button
          type="button"
          onClick={() => onNavigate('search')}
          className={`whitespace-nowrap shrink-0 py-1 ${
            activePage === 'search' ? 'text-red-600 font-semibold' : ''
          }`}
        >
          Pencarian
        </button>
        <button
          type="button"
          onClick={() => onNavigate('orders')}
          className={`whitespace-nowrap shrink-0 py-1 ${
            activePage === 'orders' ? 'text-blue-700 font-semibold' : ''
          }`}
        >
          Lacak Pesanan
        </button>
      </div>
    </header>
  );
}

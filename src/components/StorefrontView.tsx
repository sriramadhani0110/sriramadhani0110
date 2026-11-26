import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Check,
  Clock,
  Download,
  PackageCheck,
  PackageX,
  Plus,
  RefreshCw,
  Search,
  ShoppingBag,
  WifiOff,
} from 'lucide-react';
import type { User } from 'firebase/auth';
import type {
  Product,
  ProductCategory,
  Promotion,
  StoreBanner,
  StoreCheckoutConfig,
  StoreHoursConfig,
  StoreMasterConfig,
} from '../types/marketplace';
import {
  computePromoForProduct,
  normalizeProductUnit,
  PRODUCT_CATEGORIES,
} from '../lib/catalogSeed';
import {
  DEFAULT_CHECKOUT_CONFIG,
  DEFAULT_MASTER_CONFIG,
  DEFAULT_STORE_HOURS_CONFIG,
  evaluateStoreOpenStatus,
  formatPrimaryAmount,
  formatSecondaryAmount,
  THEME_ACCENT_STYLES,
} from '../lib/storeDefaults';
import { downloadCustomerDomainZip } from '../lib/portalZipExport';
import { HeroBannerCarousel } from './HeroBannerCarousel';
import { ProductImage } from './ProductImage';
import { ProductPromoNotice } from './ProductPromoNotice';
import { ProductSlideNavigator } from './ProductSlideNavigator';
import type { ActivePage } from './Navbar';

interface StorefrontViewProps {
  products: Product[];
  promotions?: Promotion[];
  categories?: string[];
  banners?: StoreBanner[];
  checkoutConfig?: StoreCheckoutConfig;
  masterConfig?: StoreMasterConfig;
  storeHoursConfig?: StoreHoursConfig;
  loadingProducts: boolean;
  productsStatus?: 'loading' | 'ready' | 'error';
  productsError?: string | null;
  onRetryLoadProducts?: () => void;
  onAddToCart: (product: Product, quantity?: number) => void;
  onSelectProduct: (product: Product) => void;
  onNavigate: (page: ActivePage, sectionId?: string) => void;
  user: User | null;
}

export function StorefrontView({
  products,
  promotions = [],
  categories,
  banners = [],
  checkoutConfig,
  masterConfig,
  storeHoursConfig,
  loadingProducts,
  productsStatus,
  productsError,
  onRetryLoadProducts,
  onAddToCart,
  onSelectProduct,
  onNavigate,
}: StorefrontViewProps) {
  const activeConfig = checkoutConfig || DEFAULT_CHECKOUT_CONFIG;
  const master = masterConfig || DEFAULT_MASTER_CONFIG;
  const hours = storeHoursConfig || DEFAULT_STORE_HOURS_CONFIG;
  const storeOpenStatus = evaluateStoreOpenStatus(hours);
  const theme = THEME_ACCENT_STYLES[master.themeAccent] || THEME_ACCENT_STYLES.blue_red;
  const effectiveMaster: StoreMasterConfig = {
    ...master,
    exchangeRate:
      master.exchangeRate > 0
        ? master.exchangeRate
        : activeConfig.exchangeRateKhr || DEFAULT_MASTER_CONFIG.exchangeRate,
  };
  const categoryList = categories && categories.length > 0 ? categories : PRODUCT_CATEGORIES;
  const [selectedCategory, setSelectedCategory] = useState<'Semua' | ProductCategory>('Semua');
  const [stockFilter, setStockFilter] = useState<'all' | 'ready' | 'empty'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'default' | 'price-asc' | 'price-desc'>('default');
  const [addedId, setAddedId] = useState<string | null>(null);
  const [downloadingZip, setDownloadingZip] = useState(false);

  const isCatalogLoading = loadingProducts || productsStatus === 'loading';
  const isCatalogError =
    !isCatalogLoading &&
    (productsStatus === 'error' || (Boolean(productsError) && products.length === 0));
  const isCatalogReady = !isCatalogLoading && !isCatalogError;

  useEffect(() => {
    if (selectedCategory !== 'Semua' && !categoryList.includes(selectedCategory)) {
      setSelectedCategory('Semua');
    }
  }, [categoryList, selectedCategory]);

  const handleQuickAdd = (product: Product) => {
    if (product.stock <= 0) return;
    onAddToCart(product, 1);
    setAddedId(product.id);
    setTimeout(() => setAddedId((prev) => (prev === product.id ? null : prev)), 1200);
  };

  const categoryScopedProducts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return products.filter((item) => {
      if (!item.isActive) return false;
      const matchesCat = selectedCategory === 'Semua' || item.category === selectedCategory;
      const matchesQuery =
        !q ||
        item.name.toLowerCase().includes(q) ||
        item.sku.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q);
      return matchesCat && matchesQuery;
    });
  }, [products, selectedCategory, searchQuery]);

  const stockCounts = useMemo(() => {
    let ready = 0;
    let empty = 0;
    for (const item of categoryScopedProducts) {
      if (item.stock > 0) ready += 1;
      else empty += 1;
    }
    return {
      all: categoryScopedProducts.length,
      ready,
      empty,
    };
  }, [categoryScopedProducts]);

  const filteredProducts = useMemo(() => {
    const list = categoryScopedProducts.filter((item) => {
      if (stockFilter === 'ready') return item.stock > 0;
      if (stockFilter === 'empty') return item.stock <= 0;
      return true;
    });

    if (sortBy === 'price-asc') {
      return [...list].sort((a, b) => a.price - b.price);
    }
    if (sortBy === 'price-desc') {
      return [...list].sort((a, b) => b.price - a.price);
    }
    return list;
  }, [categoryScopedProducts, stockFilter, sortBy]);

  return (
    <div className="min-h-screen flex flex-col bg-transparent">
      {/* Section 1: Promotional Banner Carousel + Store Welcome */}
      <section className="bg-white/75 backdrop-blur-xs border-b border-slate-200">
        <div className="max-w-[1520px] mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-10 lg:pt-8 lg:pb-12 space-y-8">
          {/* Top Image Carousel / Slider for Promos & Important Announcements */}
          <HeroBannerCarousel banners={banners} onNavigate={onNavigate} />

          {/* Live Store Open/Closed Hours Strip (configured in Admin) */}
          {hours.enabled && !storeOpenStatus.isOpen && (
            <div className="p-4 rounded-xl bg-red-50 border border-red-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
              <div className="flex items-start gap-2.5">
                <Clock className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-bold text-red-900">
                    {hours.closedTitle} · {storeOpenStatus.scheduleSummary}
                  </p>
                  {hours.closedMessage && (
                    <p className="text-xs text-red-800 mt-0.5 leading-relaxed">
                      {hours.closedMessage}
                    </p>
                  )}
                </div>
              </div>
              <span className="font-mono text-[11px] font-bold px-2.5 py-1 rounded bg-red-600 text-white self-start sm:self-center shrink-0">
                {storeOpenStatus.statusLabel}
              </span>
            </div>
          )}

          {/* Quick Actions & Store Intro */}
          <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6">
            <div className="max-w-2xl space-y-2.5">
              <div className="flex items-center gap-3">
                <img
                  src={effectiveMaster.storeLogoUrl || DEFAULT_MASTER_CONFIG.storeLogoUrl}
                  alt={effectiveMaster.storeName}
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    const img = e.currentTarget;
                    if (!img.dataset.fallbackApplied) {
                      img.dataset.fallbackApplied = '1';
                      img.src = DEFAULT_MASTER_CONFIG.storeLogoUrl;
                    }
                  }}
                  className="w-12 h-12 rounded-xl object-contain bg-white border border-slate-200 p-1 shrink-0 shadow-xs"
                />
                <h1 className="font-display text-2xl sm:text-3xl lg:text-4xl font-bold tracking-tight text-slate-900 leading-[1.15] [text-wrap:balance]">
                  Belanja online mudah dan terpercaya di {effectiveMaster.storeName}.
                </h1>
              </div>

              <p className="text-sm sm:text-base text-slate-700 leading-relaxed">
                {effectiveMaster.storeTagline ? (
                  <>
                    {effectiveMaster.storeTagline}.{' '}
                  </>
                ) : null}
                Pilihan bayar{' '}
                <span className="font-semibold text-red-600">
                  {activeConfig.cashTitle} ({effectiveMaster.secondaryCurrencyCode})
                </span>{' '}
                atau{' '}
                <span className="font-semibold text-blue-700">
                  {activeConfig.qrTitle} ({effectiveMaster.primaryCurrencyCode})
                </span>
                . Pengiriman{' '}
                <span className="font-semibold text-emerald-700">
                  {activeConfig.shippingCostUsd === 0
                    ? 'Free Delivery'
                    : formatPrimaryAmount(activeConfig.shippingCostUsd, effectiveMaster)}
                </span>{' '}
                langsung ke titik lokasi Anda saat checkout.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={() => onNavigate('catalog')}
                className={`inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${theme.primaryBtn}`}
              >
                <span>Buka Menu Catalog</span>
                <ArrowRight className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => onNavigate('search')}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Search className="w-4 h-4" />
                <span>Cari Produk</span>
              </button>
              <button
                type="button"
                onClick={() => onNavigate('orders')}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-800 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <span>Lacak Pesanan</span>
              </button>
              <button
                type="button"
                disabled={downloadingZip}
                onClick={() => {
                  setDownloadingZip(true);
                  try {
                    downloadCustomerDomainZip({
                      storeName: effectiveMaster.storeName,
                      storeTagline: effectiveMaster.storeTagline,
                      customBaseOrigin: effectiveMaster.permanentStoreUrl,
                    });
                  } finally {
                    window.setTimeout(() => setDownloadingZip(false), 1000);
                  }
                }}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-blue-800 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
              >
                <Download className="w-4 h-4 shrink-0" />
                <span>{downloadingZip ? 'Menyiapkan ZIP...' : 'Download ZIP Domain'}</span>
              </button>
            </div>
          </div>

          {/* 4-Column Full-Width Summary Strip below Hero */}
          <div className="pt-6 border-t border-slate-200/80 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white/95 border border-slate-200 rounded-lg p-4">
              <p className="font-mono text-xs font-semibold text-red-600">
                01 · Pembayaran {activeConfig.cashTitle}
              </p>
              <p className="mt-1 text-sm font-semibold text-slate-900">
                Mata Uang {effectiveMaster.secondaryCurrencyCode} (1{' '}
                {effectiveMaster.primaryCurrencyCode} ={' '}
                {formatSecondaryAmount(1, effectiveMaster)})
              </p>
            </div>
            <div className="bg-white/95 border border-slate-200 rounded-lg p-4">
              <p className="font-mono text-xs font-semibold text-blue-700">
                02 · Pembayaran {activeConfig.qrTitle}
              </p>
              <p className="mt-1 text-sm font-semibold text-slate-900">
                Mata Uang {effectiveMaster.primaryCurrencyCode} &amp; Barcode QR Instan
              </p>
            </div>
            <div className="bg-white/95 border border-slate-200 rounded-lg p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="font-mono text-xs font-semibold text-red-600">
                  03 · Jam Buka &amp; Tutup
                </p>
                {hours.enabled && (
                  <span
                    className={`font-mono text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      storeOpenStatus.isOpen
                        ? 'bg-emerald-100 text-emerald-800'
                        : 'bg-red-100 text-red-700'
                    }`}
                  >
                    {storeOpenStatus.isOpen ? 'BUKA' : 'TUTUP'}
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm font-semibold text-slate-900">
                {hours.enabled
                  ? storeOpenStatus.scheduleSummary
                  : effectiveMaster.storeHours || 'Checkout Cepat Tanpa Email'}
              </p>
              {hours.enabled && hours.openDaysText && (
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {hours.openDaysText}
                </p>
              )}
            </div>
            <div className="bg-white/95 border border-slate-200 rounded-lg p-4">
              <p className="font-mono text-xs font-semibold text-blue-700">
                04 · {activeConfig.shippingCostUsd === 0 ? 'Free Delivery' : 'Pengiriman'}
              </p>
              <p className="mt-1 text-sm font-semibold text-slate-900">
                {activeConfig.shippingCostUsd === 0
                  ? 'Semua Layanan Pengiriman Gratis Ongkir'
                  : `${activeConfig.shippingLabel} (${formatPrimaryAmount(activeConfig.shippingCostUsd, effectiveMaster)})`}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Section 2: Featured Product Catalog */}
      <section id="katalog" className="max-w-[1520px] w-full mx-auto px-4 sm:px-6 lg:px-8 py-14 space-y-8">
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6">
          <div className="space-y-1.5">
            <h2 className="font-display text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
              Katalog Produk Pilihan
            </h2>
            <p className="text-sm text-slate-600">
              Harga ditampilkan dalam {effectiveMaster.primaryCurrencyCode} (untuk bayar QR) dan{' '}
              {effectiveMaster.secondaryCurrencyCode} (untuk bayar CASH).
            </p>
          </div>

          {/* Search & Sort Controls */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Cari cepat produk atau SKU..."
                aria-label="Cari produk"
                className="w-full sm:w-64 pl-9 pr-3 py-2 text-sm bg-white border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-700 focus:border-transparent"
              />
            </div>
            <select
              value={sortBy}
              onChange={(e) =>
                setSortBy(e.target.value as 'default' | 'price-asc' | 'price-desc')
              }
              aria-label="Urutkan produk"
              className="px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-700"
            >
              <option value="default">Urutan Kurasi</option>
              <option value="price-asc">Harga Terendah</option>
              <option value="price-desc">Harga Tertinggi</option>
            </select>
          </div>
        </div>

        {/* Category Filter & Per-Category Stock Filter Controls */}
        <div className="space-y-3">
          <div className="flex items-center gap-1.5 p-1 bg-white border border-slate-200 rounded-lg overflow-x-auto w-fit max-w-full">
            {categoryList.map((category) => {
              const active = selectedCategory === category;
              return (
                <button
                  key={category}
                  type="button"
                  onClick={() => setSelectedCategory(category)}
                  className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    active
                      ? 'bg-blue-700 text-white'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                  }`}
                >
                  {category}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div
              role="group"
              aria-label={`Filter stok untuk kategori ${selectedCategory}`}
              className="flex flex-wrap items-center gap-1.5 p-1 bg-white border border-slate-200 rounded-lg w-fit max-w-full"
            >
              <button
                type="button"
                onClick={() => setStockFilter('all')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  stockFilter === 'all'
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                <span>Semua Stok</span>
                {isCatalogReady && (
                  <span className="font-mono tabular-nums opacity-85">({stockCounts.all})</span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setStockFilter('ready')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  stockFilter === 'ready'
                    ? 'bg-emerald-600 text-white'
                    : 'text-emerald-800 hover:bg-emerald-50'
                }`}
              >
                <PackageCheck className="w-3.5 h-3.5 shrink-0" />
                <span>Stok Ready</span>
                {isCatalogReady && (
                  <span className="font-mono tabular-nums opacity-90">({stockCounts.ready})</span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setStockFilter('empty')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  stockFilter === 'empty'
                    ? 'bg-red-600 text-white'
                    : 'text-red-700 hover:bg-red-50'
                }`}
              >
                <PackageX className="w-3.5 h-3.5 shrink-0" />
                <span>Stok Kosong</span>
                {isCatalogReady && (
                  <span className="font-mono tabular-nums opacity-90">({stockCounts.empty})</span>
                )}
              </button>
            </div>

            {isCatalogReady && (
              <p className="text-xs text-slate-600 tabular-nums">
                Kategori <span className="font-semibold text-slate-900">{selectedCategory}</span>:{' '}
                <span className="font-semibold text-emerald-700">{stockCounts.ready} ready</span>
                {' · '}
                <span className="font-semibold text-red-600">{stockCounts.empty} kosong</span>
              </p>
            )}
          </div>
        </div>

        {/* Product Grid: Strictly distinguish Loading, Connection Error, and Truly Empty */}
        {isCatalogLoading ? (
          <div className="space-y-4">
            <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 flex items-center gap-2.5 text-xs sm:text-sm text-blue-900">
              <RefreshCw className="w-4 h-4 animate-spin text-blue-700 shrink-0" />
              <span>Memuat katalog produk dan stok terbaru dari server toko...</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 sm:gap-5">
              {Array.from({ length: 10 }).map((_, idx) => (
                <div
                  key={idx}
                  className="bg-white border border-slate-200 rounded-xl overflow-hidden animate-pulse"
                >
                  <div className="aspect-[4/3] bg-slate-200" />
                  <div className="p-4 space-y-3">
                    <div className="h-3 w-24 bg-slate-200 rounded" />
                    <div className="h-4 w-36 bg-slate-200 rounded" />
                    <div className="h-4 w-20 bg-slate-200 rounded" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : isCatalogError ? (
          <div className="bg-white border border-amber-300 rounded-xl p-8 sm:p-10 text-center space-y-4">
            <WifiOff className="w-9 h-9 text-amber-600 mx-auto" />
            <div className="space-y-1.5 max-w-lg mx-auto">
              <h3 className="text-base sm:text-lg font-bold text-slate-900">
                Gagal Terhubung ke Server Katalog
              </h3>
              <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
                {productsError ||
                  'Koneksi ke server produk sedang terganggu. Data produk & stok belum dimuat — silakan tekan tombol di bawah untuk mencoba lagi.'}
              </p>
            </div>
            {onRetryLoadProducts && (
              <button
                type="button"
                onClick={onRetryLoadProducts}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-xs sm:text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors cursor-pointer"
              >
                <RefreshCw className="w-4 h-4 shrink-0" />
                <span>Muat Ulang Katalog</span>
              </button>
            )}
          </div>
        ) : filteredProducts.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-10 sm:p-12 text-center space-y-3">
            <ShoppingBag className="w-8 h-8 text-slate-400 mx-auto" />
            <h3 className="text-base font-semibold text-slate-900">
              {products.length === 0
                ? 'Katalog toko belum memiliki produk aktif'
                : stockFilter === 'ready' && stockCounts.all > 0
                  ? `Belum ada produk Stok Ready di kategori "${selectedCategory}"`
                  : stockFilter === 'empty' && stockCounts.all > 0
                    ? `Semua produk di kategori "${selectedCategory}" sedang Stok Ready`
                    : 'Produk tidak ditemukan'}
            </h3>
            <p className="text-sm text-slate-600 max-w-md mx-auto">
              {stockFilter === 'ready' && stockCounts.empty > 0
                ? `Tersedia ${stockCounts.empty} produk dengan status stok kosong di kategori ini.`
                : stockFilter === 'empty' && stockCounts.ready > 0
                  ? `Tersedia ${stockCounts.ready} produk siap pesan di kategori ini.`
                  : 'Ubah kata kunci pencarian, pilihan stok, atau kategori lain untuk melihat produk yang tersedia.'}
            </p>
            <div className="pt-2 flex flex-wrap items-center justify-center gap-2">
              {stockFilter !== 'all' && (
                <button
                  type="button"
                  onClick={() => setStockFilter('all')}
                  className="inline-flex items-center px-4 py-2 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
                >
                  Tampilkan Semua Stok
                </button>
              )}
              {stockFilter === 'empty' && stockCounts.ready > 0 && (
                <button
                  type="button"
                  onClick={() => setStockFilter('ready')}
                  className="inline-flex items-center px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors cursor-pointer"
                >
                  Lihat Stok Ready ({stockCounts.ready})
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setSelectedCategory('Semua');
                  setStockFilter('all');
                  setSearchQuery('');
                }}
                className="inline-flex items-center px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 transition-colors cursor-pointer"
              >
                Reset Filter
              </button>
            </div>
          </div>
        ) : (
          <ProductSlideNavigator
            items={filteredProducts}
            itemsPerSlide={30}
            mobileItemsPerSlide={30}
            resetKey={`${selectedCategory}|${stockFilter}|${searchQuery}|${sortBy}`}
            label="Produk"
            renderGrid={(slideProducts) => (
              <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 sm:gap-5">
                {slideProducts.map((product) => {
                  const outOfStock = product.stock <= 0;
                  const justAdded = addedId === product.id;
                  const unit = normalizeProductUnit(product.unit);
                  const promoSummary = computePromoForProduct(product, 1, promotions);
                  const displayUsd = promoSummary.effectiveUnitUsd;
                  const hasPriceDiscount = displayUsd < product.price;
                  const secondaryLabel = formatSecondaryAmount(displayUsd, effectiveMaster);

                  return (
                    <article
                      key={product.id}
                      className="group bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
                    >
                      <button
                        type="button"
                        onClick={() => onSelectProduct(product)}
                        className="relative w-full min-h-[145px] sm:min-h-[196px] bg-white border-b border-slate-100 flex items-center justify-center overflow-hidden text-left cursor-pointer p-3"
                      >
                        <ProductImage
                          src={product.imageUrl}
                          alt={product.name}
                          className="w-auto max-w-full h-auto max-h-40 sm:max-h-56 object-contain transition-transform duration-300 group-hover:scale-[1.02]"
                        />
                        {promoSummary.promoBadgeText && (
                          <span
                            className={`absolute top-2 left-2 sm:top-3 sm:left-3 px-2 py-0.5 sm:px-2.5 sm:py-1 text-[10px] sm:text-xs font-mono font-bold uppercase tracking-wider text-white rounded-md shadow-sm ${
                              promoSummary.comboPromo ? 'bg-emerald-700' : 'bg-red-600'
                            }`}
                          >
                            {promoSummary.promoBadgeText}
                          </span>
                        )}
                      </button>

                      <div className="p-3.5 sm:p-5 flex-1 flex flex-col justify-between gap-3 sm:gap-4">
                        <div className="space-y-1.5 sm:space-y-2">
                          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 text-xs text-slate-600">
                            <span className="font-medium text-blue-700 truncate max-w-[115px] sm:max-w-none">
                              {product.category}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono font-bold text-slate-700">
                              {unit}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span
                              className={`tabular-nums ${
                                outOfStock ? 'text-red-600 font-semibold' : ''
                              }`}
                            >
                              {outOfStock ? 'Habis' : `Stok ${product.stock}`}
                            </span>
                          </div>

                          <button
                            type="button"
                            onClick={() => onSelectProduct(product)}
                            className="text-left block w-full cursor-pointer"
                          >
                            <h3 className="text-sm sm:text-base font-semibold text-slate-900 leading-snug group-hover:text-blue-700 transition-colors line-clamp-2">
                              {product.name}
                            </h3>
                          </button>

                          <p className="hidden sm:block text-sm text-slate-600 line-clamp-2">
                            {product.description}
                          </p>

                          <ProductPromoNotice
                            product={product}
                            promotions={promotions}
                            compact
                          />
                        </div>

                        <div className="pt-3 border-t border-slate-100 flex flex-col gap-2.5">
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex items-baseline gap-1.5 flex-wrap">
                              <p className="font-mono tabular-nums text-base sm:text-lg font-bold text-blue-700">
                                {formatPrimaryAmount(displayUsd, effectiveMaster)}{' '}
                                <span className="text-xs font-medium text-slate-500">
                                  /{unit}
                                </span>
                              </p>
                              {hasPriceDiscount && (
                                <span className="font-mono tabular-nums text-xs text-slate-400 line-through">
                                  {formatPrimaryAmount(product.price, effectiveMaster)}
                                </span>
                              )}
                            </div>
                            <p className="font-mono tabular-nums text-xs sm:text-sm font-semibold text-red-600 truncate">
                              {secondaryLabel}{' '}
                              <span className="text-xs font-medium text-slate-500">
                                (CASH)
                              </span>
                            </p>
                          </div>

                          <button
                            type="button"
                            disabled={outOfStock}
                            onClick={() => handleQuickAdd(product)}
                            className={`w-full inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 text-xs sm:text-sm font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                              justAdded
                                ? 'bg-emerald-600 text-white'
                                : `${theme.primaryBtn} text-white`
                            }`}
                          >
                            {justAdded ? (
                              <>
                                <Check className="w-4 h-4" />
                                <span>Ditambahkan</span>
                              </>
                            ) : (
                              <>
                                <Plus className="w-4 h-4" />
                                <span>{outOfStock ? 'Habis' : 'Tambah'}</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          />
        )}
      </section>

      {/* Section 3: How Customer Shopping Works */}
      <section id="cara-kerja" className="bg-white/95 border-t border-slate-200">
        <div className="max-w-[1520px] mx-auto px-4 sm:px-6 lg:px-8 py-14 space-y-8">
          <div className="max-w-2xl space-y-2">
            <h2 className="font-display text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
              Cara Belanja di {effectiveMaster.storeName}
            </h2>
            <p className="text-sm sm:text-base text-slate-600">
              Proses belanja cepat mulai dari pemilihan produk, klik lokasi GPS, hingga gratis ongkir ke titik Anda.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="p-6 bg-red-50/60 border border-red-200/80 rounded-xl space-y-2.5">
              <p className="font-mono text-xs font-semibold text-red-700">
                01. Checkout CASH ({effectiveMaster.secondaryCurrencyCode}) atau QR (
                {effectiveMaster.primaryCurrencyCode})
              </p>
              <h3 className="text-base font-semibold text-slate-900">
                Pilihan Mata Uang Fleksibel
              </h3>
              <p className="text-sm text-slate-600 leading-relaxed">
                Pelanggan dapat memilih metode CASH dalam mata uang{' '}
                {effectiveMaster.secondaryCurrencyCode} atau kode QR instan dalam mata uang{' '}
                {effectiveMaster.primaryCurrencyCode} saat checkout.
              </p>
            </div>

            <div className="p-6 bg-white border border-slate-200 rounded-xl space-y-2.5">
              <p className="font-mono text-xs font-semibold text-blue-700">
                02. Lokasi GPS &amp; FREE DELIVERY
              </p>
              <h3 className="text-base font-semibold text-slate-900">
                Klik GPS Otomatis ke Admin &amp; Delivery
              </h3>
              <p className="text-sm text-slate-600 leading-relaxed">
                Cukup klik tombol lokasi GPS saat checkout. Pesanan &amp; lokasi otomatis masuk ke Admin dan kurir Delivery dengan layanan FREE DELIVERY.
              </p>
            </div>

            <div className="p-6 bg-blue-50/60 border border-blue-200/80 rounded-xl space-y-2.5">
              <p className="font-mono text-xs font-semibold text-blue-700">
                03. Lacak Pengiriman Real-Time
              </p>
              <h3 className="text-base font-semibold text-slate-900">
                Resi & Status Pesanan Transparan
              </h3>
              <p className="text-sm text-slate-600 leading-relaxed">
                Pantau progres pesanan Anda mulai dari verifikasi, pengemasan, nomor resi kurir, hingga paket tiba di tujuan.
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Download,
  PackageCheck,
  PackageX,
  Plus,
  RefreshCw,
  Search,
  ShoppingBag,
  WifiOff,
} from 'lucide-react';
import type {
  Product,
  ProductCategory,
  Promotion,
  StoreMasterConfig,
} from '../types/marketplace';
import {
  computePromoForProduct,
  normalizeProductUnit,
  PRODUCT_CATEGORIES,
} from '../lib/catalogSeed';
import {
  DEFAULT_MASTER_CONFIG,
  formatPrimaryAmount,
  formatSecondaryAmount,
} from '../lib/storeDefaults';
import { downloadCustomerDomainZip } from '../lib/portalZipExport';
import { ProductImage } from './ProductImage';
import { ProductPromoNotice } from './ProductPromoNotice';
import { ProductSlideNavigator } from './ProductSlideNavigator';
import type { ActivePage } from './Navbar';

interface CatalogViewProps {
  products: Product[];
  promotions?: Promotion[];
  categories?: string[];
  masterConfig?: StoreMasterConfig;
  loadingProducts: boolean;
  productsStatus?: 'loading' | 'ready' | 'error';
  productsError?: string | null;
  onRetryLoadProducts?: () => void;
  onAddToCart: (product: Product, quantity?: number) => void;
  onSelectProduct: (product: Product) => void;
  onNavigate: (page: ActivePage) => void;
}

export function CatalogView({
  products,
  promotions = [],
  categories,
  masterConfig,
  loadingProducts,
  productsStatus,
  productsError,
  onRetryLoadProducts,
  onAddToCart,
  onSelectProduct,
  onNavigate,
}: CatalogViewProps) {
  const master = masterConfig || DEFAULT_MASTER_CONFIG;
  const categoryList = categories && categories.length > 0 ? categories : PRODUCT_CATEGORIES;
  const [selectedCategory, setSelectedCategory] = useState<'Semua' | ProductCategory>('Semua');
  const [stockFilter, setStockFilter] = useState<'all' | 'ready' | 'empty'>('all');
  const [sortBy, setSortBy] = useState<'default' | 'price-asc' | 'price-desc' | 'stock-desc'>('default');
  const [currencyPreview, setCurrencyPreview] = useState<'both' | 'primary' | 'secondary'>('both');
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
    return products.filter(
      (item) =>
        item.isActive &&
        (selectedCategory === 'Semua' || item.category === selectedCategory)
    );
  }, [products, selectedCategory]);

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
    if (sortBy === 'price-asc') return [...list].sort((a, b) => a.price - b.price);
    if (sortBy === 'price-desc') return [...list].sort((a, b) => b.price - a.price);
    if (sortBy === 'stock-desc') return [...list].sort((a, b) => b.stock - a.stock);
    return list;
  }, [categoryScopedProducts, stockFilter, sortBy]);

  return (
    <div className="min-h-screen bg-transparent py-10">
      <div className="max-w-[1520px] mx-auto px-4 sm:px-6 lg:px-8 space-y-8">
        {/* Catalog Header */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className="font-semibold text-blue-700">Menu Catalog</span>
              <span aria-hidden="true">·</span>
              <span>{master.storeName}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                Kurs 1 {master.primaryCurrencyCode} = {formatSecondaryAmount(1, master)}
              </span>
            </div>
            <h1 className="font-display text-2xl sm:text-3xl font-bold text-slate-900">
              Catalog Produk Lengkap
            </h1>
            <p className="text-sm text-slate-600 max-w-2xl">
              Terbuka untuk seluruh pelanggan. Pembayaran CASH diproses dalam mata uang{' '}
              {master.secondaryCurrencyCode}, sedangkan pembayaran QR diproses dalam mata uang{' '}
              {master.primaryCurrencyCode}.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => onNavigate('search')}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Search className="w-4 h-4 text-red-600" />
              <span>Buka Menu Pencarian</span>
            </button>

            <button
              type="button"
              disabled={downloadingZip}
              onClick={() => {
                setDownloadingZip(true);
                try {
                  downloadCustomerDomainZip({
                    storeName: master.storeName,
                    storeTagline: master.storeTagline,
                    customBaseOrigin: master.permanentStoreUrl,
                  });
                } finally {
                  window.setTimeout(() => setDownloadingZip(false), 1000);
                }
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-blue-800 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
            >
              <Download className="w-3.5 h-3.5 shrink-0" />
              <span>{downloadingZip ? 'Menyiapkan ZIP...' : 'Download ZIP Domain'}</span>
            </button>

            <select
              value={sortBy}
              onChange={(e) =>
                setSortBy(
                  e.target.value as 'default' | 'price-asc' | 'price-desc' | 'stock-desc'
                )
              }
              aria-label="Urutkan catalog"
              className="px-3 py-2 text-xs font-medium bg-white border border-slate-200 rounded-lg text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-700"
            >
              <option value="default">Urutan Kurasi</option>
              <option value="price-asc">Harga Terendah</option>
              <option value="price-desc">Harga Tertinggi</option>
              <option value="stock-desc">Stok Terbanyak</option>
            </select>
          </div>
        </div>

        {/* Category, Per-Category Stock Filter & Currency View Filter Bar */}
        <div className="space-y-3">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
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

            <div className="flex items-center gap-1 p-1 bg-white border border-slate-200 rounded-lg w-fit">
              {(
                [
                  ['both', `${master.primaryCurrencyCode} & ${master.secondaryCurrencyCode}`],
                  ['primary', `QR (${master.primaryCurrencyCode})`],
                  ['secondary', `CASH (${master.secondaryCurrencyCode})`],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setCurrencyPreview(key)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    currencyPreview === key
                      ? key === 'secondary'
                        ? 'bg-red-600 text-white'
                        : 'bg-blue-700 text-white'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div
              role="group"
              aria-label={`Filter stok kategori ${selectedCategory}`}
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
              <h2 className="text-base sm:text-lg font-bold text-slate-900">
                Gagal Terhubung ke Server Katalog
              </h2>
              <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
                {productsError ||
                  'Koneksi ke server katalog produk sedang terganggu. Data produk & stok belum berhasil dimuat — tekan tombol di bawah untuk memuat ulang.'}
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
            <h2 className="text-base font-semibold text-slate-900">
              {products.length === 0
                ? 'Katalog toko belum memiliki produk aktif'
                : stockFilter === 'ready' && stockCounts.all > 0
                  ? `Belum ada produk Stok Ready di kategori "${selectedCategory}"`
                  : stockFilter === 'empty' && stockCounts.all > 0
                    ? `Semua produk di kategori "${selectedCategory}" sedang Stok Ready`
                    : 'Belum ada produk di kategori ini'}
            </h2>
            {stockFilter === 'ready' && stockCounts.empty > 0 && (
              <p className="text-sm text-slate-600 max-w-md mx-auto">
                Tersedia {stockCounts.empty} produk dengan status stok kosong di kategori ini.
              </p>
            )}
            {stockFilter === 'empty' && stockCounts.ready > 0 && (
              <p className="text-sm text-slate-600 max-w-md mx-auto">
                Tersedia {stockCounts.ready} produk siap pesan di kategori ini.
              </p>
            )}
            <div className="pt-2 flex flex-wrap items-center justify-center gap-2">
              {stockFilter !== 'all' && (
                <button
                  type="button"
                  onClick={() => setStockFilter('all')}
                  className="px-4 py-2 text-xs font-semibold text-slate-800 bg-slate-100 rounded-lg hover:bg-slate-200 cursor-pointer"
                >
                  Tampilkan Semua Stok
                </button>
              )}
              {stockFilter === 'empty' && stockCounts.ready > 0 && (
                <button
                  type="button"
                  onClick={() => setStockFilter('ready')}
                  className="px-4 py-2 text-xs font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 cursor-pointer"
                >
                  Lihat Stok Ready ({stockCounts.ready})
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setSelectedCategory('Semua');
                  setStockFilter('all');
                }}
                className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 cursor-pointer"
              >
                Tampilkan Semua Kategori
              </button>
            </div>
          </div>
        ) : (
          <ProductSlideNavigator
            items={filteredProducts}
            itemsPerSlide={30}
            mobileItemsPerSlide={30}
            resetKey={`${selectedCategory}|${stockFilter}|${sortBy}`}
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
                          <div className="space-y-0.5 min-w-0">
                            {(currencyPreview === 'both' || currencyPreview === 'primary') && (
                              <div className="flex items-baseline gap-1.5 flex-wrap">
                                <p className="font-mono tabular-nums text-base sm:text-lg font-bold text-blue-700">
                                  {formatPrimaryAmount(displayUsd, master)}{' '}
                                  <span className="text-xs font-medium text-slate-500">
                                    (QR)
                                  </span>
                                </p>
                                {hasPriceDiscount && (
                                  <span className="font-mono tabular-nums text-xs text-slate-400 line-through">
                                    {formatPrimaryAmount(product.price, master)}
                                  </span>
                                )}
                              </div>
                            )}
                            {(currencyPreview === 'both' || currencyPreview === 'secondary') && (
                              <p
                                className={`font-mono tabular-nums font-semibold truncate ${
                                  currencyPreview === 'secondary'
                                    ? 'text-base sm:text-lg text-red-600 font-bold'
                                    : 'text-xs sm:text-sm text-red-600'
                                }`}
                              >
                                {formatSecondaryAmount(displayUsd, master)}{' '}
                                <span className="text-xs font-medium text-slate-500">
                                  (CASH)
                                </span>
                              </p>
                            )}
                          </div>

                          <button
                            type="button"
                            disabled={outOfStock}
                            onClick={() => handleQuickAdd(product)}
                            className={`w-full inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 text-xs sm:text-sm font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                              justAdded
                                ? 'bg-emerald-600 text-white'
                                : 'bg-blue-700 text-white hover:bg-red-600'
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
      </div>
    </div>
  );
}

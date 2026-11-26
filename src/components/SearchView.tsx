import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  PackageCheck,
  PackageX,
  Plus,
  RefreshCw,
  Search,
  WifiOff,
  X,
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
import { ProductImage } from './ProductImage';
import { ProductPromoNotice } from './ProductPromoNotice';
import { ProductSlideNavigator } from './ProductSlideNavigator';
import type { ActivePage } from './Navbar';

interface SearchViewProps {
  products: Product[];
  promotions?: Promotion[];
  categories?: string[];
  masterConfig?: StoreMasterConfig;
  loadingProducts?: boolean;
  productsStatus?: 'loading' | 'ready' | 'error';
  productsError?: string | null;
  onRetryLoadProducts?: () => void;
  onAddToCart: (product: Product, quantity?: number) => void;
  onSelectProduct: (product: Product) => void;
  onNavigate: (page: ActivePage) => void;
}

export function SearchView({
  products,
  promotions = [],
  categories,
  masterConfig,
  loadingProducts = false,
  productsStatus,
  productsError,
  onRetryLoadProducts,
  onAddToCart,
  onSelectProduct,
  onNavigate,
}: SearchViewProps) {
  const master = masterConfig || DEFAULT_MASTER_CONFIG;
  const categoryList = categories && categories.length > 0 ? categories : PRODUCT_CATEGORIES;
  const [queryText, setQueryText] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<'Semua' | ProductCategory>('Semua');
  const [stockFilter, setStockFilter] = useState<'all' | 'ready' | 'empty'>('all');
  const [maxUsd, setMaxUsd] = useState<number>(200);
  const [addedId, setAddedId] = useState<string | null>(null);

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

  const baseMatches = useMemo(() => {
    const q = queryText.trim().toLowerCase();
    return products.filter((item) => {
      if (!item.isActive) return false;
      if (selectedCategory !== 'Semua' && item.category !== selectedCategory) {
        return false;
      }
      const effectiveUsd = computePromoForProduct(item, 1, promotions).effectiveUnitUsd;
      if (effectiveUsd > maxUsd) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.sku.toLowerCase().includes(q) ||
        (item.barcode || '').toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q)
      );
    });
  }, [products, promotions, queryText, selectedCategory, maxUsd]);

  const stockCounts = useMemo(() => {
    let ready = 0;
    let empty = 0;
    for (const item of baseMatches) {
      if (item.stock > 0) ready += 1;
      else empty += 1;
    }
    return { all: baseMatches.length, ready, empty };
  }, [baseMatches]);

  const results = useMemo(() => {
    return baseMatches.filter((item) => {
      if (stockFilter === 'ready') return item.stock > 0;
      if (stockFilter === 'empty') return item.stock <= 0;
      return true;
    });
  }, [baseMatches, stockFilter]);

  return (
    <div className="min-h-screen bg-transparent py-10">
      <div className="max-w-[1520px] mx-auto px-4 sm:px-6 lg:px-8 space-y-8">
        {/* Dedicated Search Box */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <p className="text-xs font-semibold text-red-600">Menu Pencarian</p>
              <h1 className="font-display text-2xl sm:text-3xl font-bold text-slate-900">
                Cari Produk di Toko
              </h1>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('catalog')}
              className="px-4 py-2 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Lihat Semua Catalog
            </button>
          </div>

          {/* Search Input */}
          <div className="relative">
            <Search className="w-5 h-5 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              autoFocus
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
              placeholder="Ketik nama barang, barcode, kategori, atau kode SKU..."
              aria-label="Kata kunci pencarian produk"
              className="w-full pl-12 pr-12 py-3.5 text-sm sm:text-base bg-slate-50 border border-slate-300 rounded-xl text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-700 focus:border-transparent"
            />
            {queryText && (
              <button
                type="button"
                onClick={() => setQueryText('')}
                aria-label="Bersihkan pencarian"
                className="p-1.5 text-slate-400 hover:text-slate-900 absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-slate-100 text-xs text-slate-700">
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2">
                <span>Maks Harga:</span>
                <span className="font-mono tabular-nums font-semibold text-blue-700">
                  {formatPrimaryAmount(maxUsd, master)}
                </span>
                <input
                  type="range"
                  min={10}
                  max={250}
                  step={5}
                  value={maxUsd}
                  onChange={(e) => setMaxUsd(Number(e.target.value))}
                  className="accent-blue-700"
                />
              </label>

              <div
                role="group"
                aria-label="Filter ketersediaan stok"
                className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg"
              >
                <button
                  type="button"
                  onClick={() => setStockFilter('all')}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                    stockFilter === 'all'
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:text-slate-900'
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
                  className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
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
                  className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
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
            </div>
          </div>

          {/* Category Filter Row */}
          <div className="flex items-center gap-1.5 p-1 bg-slate-100 rounded-lg overflow-x-auto w-fit max-w-full">
            {categoryList.map((category) => (
              <button
                key={category}
                type="button"
                onClick={() => setSelectedCategory(category)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  selectedCategory === category
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {category}
              </button>
            ))}
          </div>
        </div>

        {/* Result Count (only display counts once catalog has successfully loaded) */}
        {isCatalogReady && (
          <div className="flex items-center justify-between text-xs text-slate-600">
            <p className="tabular-nums">
              Menampilkan <span className="font-semibold text-slate-900">{results.length}</span> produk
              {queryText ? ` untuk "${queryText}"` : ''}
            </p>
            {(queryText || selectedCategory !== 'Semua' || maxUsd < 200 || stockFilter !== 'all') && (
              <button
                type="button"
                onClick={() => {
                  setQueryText('');
                  setSelectedCategory('Semua');
                  setMaxUsd(200);
                  setStockFilter('all');
                }}
                className="font-medium text-red-600 hover:underline cursor-pointer"
              >
                Reset Pencarian
              </button>
            )}
          </div>
        )}

        {/* Search Results Grid */}
        {isCatalogLoading ? (
          <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 flex items-center gap-2.5 text-xs sm:text-sm text-blue-900">
            <RefreshCw className="w-4 h-4 animate-spin text-blue-700 shrink-0" />
            <span>Memuat katalog produk dan stok terbaru dari server toko...</span>
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
                  'Koneksi ke server katalog produk sedang terganggu. Tekan tombol di bawah untuk memuat ulang.'}
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
        ) : results.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-12 text-center space-y-3">
            <Search className="w-8 h-8 text-slate-300 mx-auto" />
            <h2 className="text-base font-semibold text-slate-900">
              {stockFilter === 'ready' && stockCounts.all > 0
                ? 'Tidak ada produk Stok Ready yang cocok'
                : stockFilter === 'empty' && stockCounts.all > 0
                  ? 'Tidak ada produk Stok Kosong yang cocok'
                  : 'Tidak ada produk yang cocok'}
            </h2>
            <p className="text-sm text-slate-600 max-w-md mx-auto">
              Coba kata kunci lain, ubah pilihan stok, atau naikkan batas maksimum harga untuk melihat lebih banyak produk.
            </p>
          </div>
        ) : (
          <ProductSlideNavigator
            items={results}
            itemsPerSlide={30}
            mobileItemsPerSlide={30}
            resetKey={`${queryText}|${selectedCategory}|${stockFilter}|${maxUsd}`}
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
                            <span className="tabular-nums">
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
                            <div className="flex flex-wrap items-baseline gap-1.5">
                              <p className="font-mono tabular-nums text-base sm:text-lg font-bold text-blue-700">
                                {formatPrimaryAmount(displayUsd, master)}{' '}
                                <span className="text-xs font-medium text-slate-500">
                                  / {unit} (QR)
                                </span>
                              </p>
                              {hasPriceDiscount && (
                                <span className="font-mono tabular-nums text-xs text-slate-400 line-through">
                                  {formatPrimaryAmount(product.price, master)}
                                </span>
                              )}
                            </div>
                            <p className="font-mono tabular-nums text-xs sm:text-sm font-semibold text-red-600">
                              {formatSecondaryAmount(displayUsd, master)}{' '}
                              <span className="text-xs font-medium text-slate-500">
                                / {unit} (CASH)
                              </span>
                            </p>
                          </div>

                          <button
                            type="button"
                            disabled={outOfStock}
                            onClick={() => handleQuickAdd(product)}
                            className={`inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 text-xs sm:text-sm font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 w-full cursor-pointer disabled:opacity-50 ${
                              justAdded
                                ? 'bg-emerald-600 text-white'
                                : 'bg-blue-700 text-white hover:bg-red-600'
                            }`}
                          >
                            {justAdded ? (
                              <>
                                <Check className="w-3.5 h-3.5" />
                                <span>Ditambahkan</span>
                              </>
                            ) : (
                              <>
                                <Plus className="w-3.5 h-3.5" />
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

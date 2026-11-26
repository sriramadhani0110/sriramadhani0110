import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Check, Gift, Layers, Percent, Plus, Tag } from 'lucide-react';
import type {
  Product,
  Promotion,
  StoreMasterConfig,
} from '../types/marketplace';
import {
  formatComboInstruction,
  getEffectiveProductStock,
  getPromotionScheduleInfo,
  isPromotionCurrentlyActive,
  normalizeProductUnit,
} from '../lib/catalogSeed';
import {
  DEFAULT_MASTER_CONFIG,
  formatPrimaryAmount,
  formatSecondaryAmount,
} from '../lib/storeDefaults';
import { ProductImage } from './ProductImage';
import { ProductSlideNavigator } from './ProductSlideNavigator';
import type { ActivePage } from './Navbar';

interface PromoDiscountViewProps {
  products: Product[];
  promotions: Promotion[];
  masterConfig?: StoreMasterConfig;
  loadingPromotions: boolean;
  onAddToCart: (product: Product, quantity?: number) => void;
  onSelectProduct: (product: Product) => void;
  onNavigate: (page: ActivePage) => void;
}

export function PromoDiscountView({
  products,
  promotions,
  masterConfig,
  loadingPromotions,
  onAddToCart,
  onSelectProduct,
  onNavigate,
}: PromoDiscountViewProps) {
  const master = masterConfig || DEFAULT_MASTER_CONFIG;
  const [filterType, setFilterType] = useState<'all' | 'combo' | 'buy_x_get_y' | 'discount'>('all');
  const [addedPromoId, setAddedPromoId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const productMap = useMemo(
    () => new Map(products.map((p) => [p.id, p])),
    [products]
  );

  const activePromotions = useMemo(() => {
    return promotions.filter((promo) => {
      if (!isPromotionCurrentlyActive(promo, nowMs)) return false;
      const targetProduct = productMap.get(promo.productId);
      if (!targetProduct || !targetProduct.isActive) return false;
      if (filterType === 'all') return true;
      return promo.promoType === filterType;
    });
  }, [promotions, productMap, filterType, nowMs]);

  const handleClaimPromo = (promo: Promotion, product: Product, effectiveStock: number) => {
    if (effectiveStock <= 0) return;
    let qtyToAdd = 1;
    if (promo.promoType === 'combo') {
      const bundleSize = promo.buyQty + promo.getQty;
      if (effectiveStock < bundleSize) return;
      qtyToAdd = bundleSize;
    } else if (promo.promoType === 'buy_x_get_y') {
      qtyToAdd = Math.min(effectiveStock, promo.buyQty);
    }
    onAddToCart(product, qtyToAdd);
    setAddedPromoId(promo.id);
    setTimeout(
      () => setAddedPromoId((prev) => (prev === promo.id ? null : prev)),
      1400
    );
  };

  return (
    <div className="min-h-screen bg-transparent py-10">
      <div className="max-w-[1520px] mx-auto px-4 sm:px-6 lg:px-8 space-y-8">
        {/* Dedicated Promo & Discount Header */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className="font-semibold text-red-600">Halaman Khusus Promo &amp; Diskon</span>
              <span aria-hidden="true">·</span>
              <span>{master.storeName}</span>
            </div>
            <h1 className="font-display text-2xl sm:text-3xl font-bold text-slate-900">
              Promo Combo, Buy X Get Y &amp; Diskon Spesial
            </h1>
            <p className="text-sm text-slate-600 max-w-2xl">
              Nikmati paket <strong>Combo (Beli X Free Y)</strong>, bonus beli gratis, dan diskon persentase otomatis untuk pembayaran CASH maupun QR. Pada promo Combo, masukkan jumlah total paket (mis. Beli 1 Free 2 = masukkan 3 pcs) dan harga otomatis dihitung sesuai jumlah bayar saja.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => onNavigate('catalog')}
              className="px-4 py-2 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Lihat Catalog Normal
            </button>
          </div>
        </div>

        {/* Promo Type Filter Bar */}
        <div className="flex items-center gap-1.5 p-1 bg-white border border-slate-200 rounded-lg overflow-x-auto w-fit max-w-full">
          {(
            [
              ['all', 'Semua Promo Aktif'],
              ['combo', 'Paket Combo (Beli X Free Y)'],
              ['buy_x_get_y', 'Buy X Get Y Bonus'],
              ['discount', 'Diskon Harga (%)'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilterType(key)}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                filterType === key
                  ? key === 'combo'
                    ? 'bg-emerald-700 text-white'
                    : key === 'buy_x_get_y'
                      ? 'bg-red-600 text-white'
                      : 'bg-blue-700 text-white'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Promotions Grid */}
        {loadingPromotions ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {Array.from({ length: 3 }).map((_, idx) => (
              <div
                key={idx}
                className="bg-white border border-slate-200 rounded-xl overflow-hidden animate-pulse"
              >
                <div className="aspect-[4/3] bg-slate-200" />
                <div className="p-5 space-y-3">
                  <div className="h-4 w-36 bg-slate-200 rounded" />
                  <div className="h-5 w-52 bg-slate-200 rounded" />
                  <div className="h-4 w-28 bg-slate-200 rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : activePromotions.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-12 text-center space-y-3">
            <Tag className="w-8 h-8 text-slate-400 mx-auto" />
            <h2 className="text-base font-semibold text-slate-900">
              Belum ada promo aktif pada kategori ini
            </h2>
            <p className="text-sm text-slate-600 max-w-md mx-auto">
              Promo Combo, diskon, dan Buy X Get Y yang sedang dalam periode aktif akan langsung muncul di sini.
            </p>
            <button
              type="button"
              onClick={() => setFilterType('all')}
              className="px-4 py-2 text-xs font-medium text-white bg-blue-700 rounded-lg hover:bg-blue-800 cursor-pointer"
            >
              Tampilkan Semua Promo
            </button>
          </div>
        ) : (
          <ProductSlideNavigator
            items={activePromotions}
            itemsPerSlide={30}
            mobileItemsPerSlide={30}
            resetKey={filterType}
            label="Promo"
            renderGrid={(slidePromotions) => (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-5">
                {slidePromotions.map((promo) => {
                  const product = productMap.get(promo.productId);
                  if (!product) return null;

              const effectiveStock = getEffectiveProductStock(product, promotions, nowMs);
              const unit = normalizeProductUnit(product.unit);
              const isDiscount = promo.promoType === 'discount';
              const isCombo = promo.promoType === 'combo';
              const comboBundleSize = isCombo ? promo.buyQty + promo.getQty : 0;
              const insufficientForCombo = isCombo && effectiveStock < comboBundleSize;
              const outOfStock = effectiveStock <= 0 || insufficientForCombo;
              const schedule = getPromotionScheduleInfo(promo, nowMs);

              const discountedUsd = isDiscount
                ? Math.max(
                    0.01,
                    Number(
                      (
                        product.price *
                        (1 - promo.discountPercent / 100)
                      ).toFixed(2)
                    )
                  )
                : product.price;
              const comboPackagePayUsd = isCombo
                ? Number((product.price * promo.buyQty).toFixed(2))
                : product.price;
              const comboPackageNormalUsd = isCombo
                ? Number((product.price * comboBundleSize).toFixed(2))
                : product.price;
              const justAdded = addedPromoId === promo.id;

              return (
                <article
                  key={promo.id}
                  className="group bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
                >
                  <button
                    type="button"
                    onClick={() => onSelectProduct(product)}
                    className="relative w-full min-h-[180px] bg-white border-b border-slate-100 flex items-center justify-center overflow-hidden text-left cursor-pointer p-2"
                  >
                    <ProductImage
                      src={product.imageUrl}
                      alt={product.name}
                      className="w-auto max-w-full h-auto max-h-64 object-contain transition-transform duration-300 group-hover:scale-[1.02]"
                    />
                    {isCombo && (
                      <span className="absolute top-3 left-3 inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-mono font-bold uppercase tracking-wider bg-emerald-700 text-white rounded-md shadow-sm">
                        <Layers className="w-3 h-3" />
                        <span>
                          COMBO · BELI {promo.buyQty} FREE {promo.getQty}
                        </span>
                      </span>
                    )}
                  </button>

                  <div className="p-5 flex-1 flex flex-col justify-between gap-4">
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span
                          className={`inline-flex items-center gap-1 font-semibold ${
                            isCombo
                              ? 'text-emerald-700'
                              : isDiscount
                                ? 'text-blue-700'
                                : 'text-red-600'
                          }`}
                        >
                          {isCombo ? (
                            <Layers className="w-3.5 h-3.5" />
                          ) : isDiscount ? (
                            <Percent className="w-3.5 h-3.5" />
                          ) : (
                            <Gift className="w-3.5 h-3.5" />
                          )}
                          <span>
                            {isCombo
                              ? `COMBO BELI ${promo.buyQty} FREE ${promo.getQty}`
                              : isDiscount
                                ? `DISKON ${promo.discountPercent}%`
                                : `BUY ${promo.buyQty} GET ${promo.getQty}`}
                          </span>
                        </span>
                        <span
                          className={`font-mono ${
                            effectiveStock <= 0 ? 'text-red-600 font-semibold' : 'text-slate-500'
                          }`}
                        >
                          Stok {effectiveStock} {unit}
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={() => onSelectProduct(product)}
                        className="text-left block w-full cursor-pointer"
                      >
                        <h3 className="text-base font-bold text-slate-900 group-hover:text-blue-700 transition-colors">
                          {promo.title}
                        </h3>
                      </button>

                      <p className="text-xs font-medium text-slate-700">
                        Produk: {product.name} ({product.sku} · {unit})
                      </p>

                      <p className="text-sm text-slate-600 line-clamp-2">
                        {promo.description}
                      </p>

                      {/* Keterangan Promo — Customer Input Guidance Box */}
                      {isCombo && (
                        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg space-y-1 text-xs">
                          <p className="font-bold text-emerald-950 uppercase tracking-wide text-[10px]">
                            Keterangan Promo · Wajib Input {comboBundleSize} {unit} / Paket
                          </p>
                          <p className="text-emerald-900 leading-relaxed font-medium">
                            Wajib input {comboBundleSize} {unit} untuk mendapatkan harga Beli{' '}
                            {promo.buyQty} Free {promo.getQty} — {formatComboInstruction(promo.buyQty, promo.getQty, unit)}
                          </p>
                          <div className="pt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] font-semibold text-emerald-800">
                            <span>Input: {comboBundleSize} {unit}</span>
                            <span>·</span>
                            <span>Bayar: {promo.buyQty} {unit}</span>
                            <span>·</span>
                            <span>Gratis: {promo.getQty} {unit}</span>
                          </div>
                        </div>
                      )}

                      {!isCombo && !isDiscount && (
                        <div className="p-2.5 bg-red-50/70 border border-red-200 rounded-lg text-xs text-red-900 leading-relaxed">
                          <p className="font-bold uppercase tracking-wide text-[10px] text-red-800 mb-0.5">
                            Keterangan Promo
                          </p>
                          Masukkan minimal <strong>{promo.buyQty} {unit}</strong> (kelipatan {promo.buyQty}{' '}
                          {unit}) untuk mendapatkan bonus gratis{' '}
                          <strong>+{promo.getQty} {unit}</strong>.
                        </div>
                      )}

                      {isDiscount && (
                        <div className="p-2.5 bg-blue-50/80 border border-blue-200 rounded-lg text-xs text-blue-950 leading-relaxed">
                          <p className="font-bold uppercase tracking-wide text-[10px] text-blue-800 mb-0.5">
                            Keterangan Promo
                          </p>
                          Diskon <strong>{promo.discountPercent}%</strong> otomatis berlaku mulai dari input{' '}
                          <strong>1 {unit}</strong>.
                        </div>
                      )}

                      {/* Promo Period & Expiry Display */}
                      {(promo.startDate || promo.endDate) && (
                        <div className="flex items-start gap-1.5 px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-[11px] text-slate-700">
                          <CalendarClock className="w-3.5 h-3.5 text-blue-700 shrink-0 mt-0.5" />
                          <div className="space-y-0.5">
                            <p className="font-medium text-slate-800">
                              Periode: {schedule.periodLabel}
                            </p>
                            {schedule.remainingLabel && (
                              <p className="font-mono font-semibold text-amber-700">
                                {schedule.remainingLabel}
                              </p>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-3">
                      <div className="space-y-0.5">
                        {isCombo ? (
                          <>
                            <p className="text-[11px] font-semibold text-emerald-700">
                              1 Paket ({comboBundleSize} {unit}) · Bayar {promo.buyQty} {unit}:
                            </p>
                            <div className="flex items-center gap-2">
                              <span className="font-mono tabular-nums text-xs text-slate-400 line-through">
                                {formatPrimaryAmount(comboPackageNormalUsd, master)}
                              </span>
                              <span className="font-mono tabular-nums text-base font-bold text-blue-700">
                                {formatPrimaryAmount(comboPackagePayUsd, master)} (QR)
                              </span>
                            </div>
                            <p className="font-mono tabular-nums text-xs font-semibold text-red-600">
                              {formatSecondaryAmount(comboPackagePayUsd, master)} (CASH)
                            </p>
                          </>
                        ) : isDiscount ? (
                          <>
                            <div className="flex items-center gap-2">
                              <span className="font-mono tabular-nums text-xs text-slate-400 line-through">
                                {formatPrimaryAmount(product.price, master)}
                              </span>
                              <span className="font-mono tabular-nums text-base font-bold text-blue-700">
                                {formatPrimaryAmount(discountedUsd, master)} / {unit} (QR)
                              </span>
                            </div>
                            <p className="font-mono tabular-nums text-xs font-semibold text-red-600">
                              {formatSecondaryAmount(discountedUsd, master)} / {unit} (CASH)
                            </p>
                          </>
                        ) : (
                          <>
                            <p className="font-mono tabular-nums text-base font-bold text-blue-700">
                              {formatPrimaryAmount(product.price, master)} / {unit} (QR)
                            </p>
                            <p className="font-mono tabular-nums text-xs font-semibold text-red-600">
                              {formatSecondaryAmount(product.price, master)} / {unit} (CASH)
                            </p>
                            <p className="text-[11px] font-semibold text-emerald-700">
                              Beli {promo.buyQty} · Gratis {promo.getQty} {unit}
                            </p>
                          </>
                        )}
                      </div>

                      <button
                        type="button"
                        disabled={outOfStock}
                        onClick={() => handleClaimPromo(promo, product, effectiveStock)}
                        className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 ${
                          justAdded
                            ? 'bg-emerald-600 text-white'
                            : isCombo
                              ? 'bg-emerald-700 text-white hover:bg-emerald-800'
                              : isDiscount
                                ? 'bg-blue-700 text-white hover:bg-blue-800'
                                : 'bg-red-600 text-white hover:bg-red-700'
                        }`}
                      >
                        {justAdded ? (
                          <>
                            <Check className="w-3.5 h-3.5" />
                            <span>Masuk Keranjang</span>
                          </>
                        ) : (
                          <>
                            <Plus className="w-3.5 h-3.5" />
                            <span>
                              {effectiveStock <= 0
                                ? 'Stok Habis'
                                : insufficientForCombo
                                  ? `Stok < ${comboBundleSize} ${unit}`
                                  : isCombo
                                    ? `Ambil ${comboBundleSize} ${unit} (Bayar ${promo.buyQty})`
                                    : isDiscount
                                      ? 'Ambil Diskon'
                                      : `Beli ${promo.buyQty} + ${promo.getQty}`}
                            </span>
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

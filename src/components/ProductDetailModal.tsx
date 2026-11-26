import { useEffect, useState } from 'react';
import { CalendarClock, Layers, Minus, Plus, ShoppingBag, Tag, X } from 'lucide-react';
import type { Product, Promotion, StoreMasterConfig } from '../types/marketplace';
import {
  computePromoForProduct,
  getEffectiveProductStock,
  getPromotionScheduleInfo,
  isProductSyncedPromoActive,
  normalizeProductUnit,
} from '../lib/catalogSeed';
import {
  DEFAULT_MASTER_CONFIG,
  formatPrimaryAmount,
  formatSecondaryAmount,
} from '../lib/storeDefaults';
import { ProductImage } from './ProductImage';
import { ProductPromoNotice } from './ProductPromoNotice';

interface ProductDetailModalProps {
  product: Product | null;
  promotions?: Promotion[];
  masterConfig?: StoreMasterConfig;
  onClose: () => void;
  onAddToCart: (product: Product, quantity: number) => void;
}

export function ProductDetailModal({
  product,
  promotions = [],
  masterConfig,
  onClose,
  onAddToCart,
}: ProductDetailModalProps) {
  const master = masterConfig || DEFAULT_MASTER_CONFIG;
  const [quantity, setQuantity] = useState(1);

  const effectiveStock = product
    ? getEffectiveProductStock(product, promotions)
    : 0;

  useEffect(() => {
    if (product && effectiveStock > 0) {
      const initialPromo = computePromoForProduct(product, 1, promotions);
      if (
        initialPromo.comboPromo &&
        initialPromo.comboBundleSize > 1 &&
        effectiveStock >= initialPromo.comboBundleSize
      ) {
        setQuantity(initialPromo.comboBundleSize);
      } else {
        setQuantity((q) => Math.min(Math.max(1, q), effectiveStock));
      }
    }
  }, [product, effectiveStock, promotions]);

  if (!product) return null;

  const outOfStock = effectiveStock <= 0;
  const unit = normalizeProductUnit(product.unit);
  const promoInfo = computePromoForProduct(product, outOfStock ? 0 : quantity, promotions);
  const hasSyncedPromo = isProductSyncedPromoActive(product);
  const activePromo =
    promoInfo.comboPromo || promoInfo.discountPromo || promoInfo.bogoPromo;
  const activePromoSchedule = activePromo
    ? getPromotionScheduleInfo(activePromo)
    : null;

  const effectiveUnitUsd = promoInfo.effectiveUnitUsd;
  const totalUsd = promoInfo.lineTotalUsd;

  const handleConfirm = () => {
    if (outOfStock) return;
    const safeQty = Math.min(Math.max(1, quantity), effectiveStock);
    onAddToCart(product, safeQty);
    setQuantity(1);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={product.name}
    >
      <div className="bg-white border border-slate-200 rounded-xl max-w-3xl w-full max-h-[92dvh] overflow-y-auto shadow-xl">
        <div className="h-1 w-full bg-gradient-to-r from-red-600 via-white to-blue-700" />
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span className="font-medium text-blue-700">{product.category}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">{product.sku}</span>
            {product.barcode && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono text-slate-500">BC: {product.barcode}</span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span className="font-mono font-bold text-slate-700">{unit}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup detail produk"
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2">
          <div className="relative bg-slate-50 flex items-center justify-center p-4 min-h-[220px]">
            <ProductImage
              src={product.imageUrl}
              alt={product.name}
              className="w-auto max-w-full h-auto max-h-[420px] object-contain rounded-lg"
            />
            {promoInfo.comboPromo ? (
              <span className="absolute top-3 left-3 inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-mono font-bold uppercase tracking-wider bg-emerald-700 text-white rounded-md shadow">
                <Layers className="w-3 h-3" />
                COMBO · BELI {promoInfo.comboPromo.buyQty} FREE {promoInfo.comboPromo.getQty}
              </span>
            ) : (hasSyncedPromo || promoInfo.discountPromo || promoInfo.bogoPromo) ? (
              <span className="absolute top-3 left-3 inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-mono font-bold uppercase tracking-wider bg-red-600 text-white rounded-md shadow">
                <Tag className="w-3 h-3" />
                {promoInfo.promoBadgeText ||
                  product.promoLabel ||
                  (product.promoDiscountPercent
                    ? `DISCOUNT ${product.promoDiscountPercent}%`
                    : 'PROMOTION')}
              </span>
            ) : null}
          </div>

          <div className="p-6 flex flex-col justify-between gap-6">
            <div className="space-y-3">
              <h2 className="font-display text-xl font-bold text-slate-900">
                {product.name}
              </h2>
              <div className="space-y-1">
                <div className="flex items-baseline gap-2.5">
                  <p className="font-mono tabular-nums text-2xl font-bold text-blue-700">
                    {formatPrimaryAmount(effectiveUnitUsd, master)}{' '}
                    <span className="text-xs font-semibold text-slate-500">
                      / {unit} (QR · {master.primaryCurrencyCode})
                    </span>
                  </p>
                  {(hasSyncedPromo || promoInfo.discountPromo) &&
                    effectiveUnitUsd < product.price && (
                      <span className="font-mono tabular-nums text-sm text-slate-400 line-through">
                        {formatPrimaryAmount(product.price, master)}
                      </span>
                    )}
                </div>
                <p className="font-mono tabular-nums text-base font-semibold text-red-600">
                  {formatSecondaryAmount(effectiveUnitUsd, master)}{' '}
                  <span className="text-xs font-medium text-slate-500">
                    / {unit} (CASH · {master.secondaryCurrencyCode})
                  </span>
                </p>

                <div className="pt-1.5 space-y-2">
                  <ProductPromoNotice
                    product={product}
                    promotions={promotions}
                    compact={false}
                  />
                  {promoInfo.comboPromo &&
                    effectiveStock >= promoInfo.comboBundleSize &&
                    quantity !== promoInfo.comboBundleSize && (
                      <button
                        type="button"
                        onClick={() => setQuantity(promoInfo.comboBundleSize)}
                        className="px-3 py-1.5 text-xs font-bold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg cursor-pointer"
                      >
                        Set 1 Paket ({promoInfo.comboBundleSize} {unit} · Bayar{' '}
                        {promoInfo.comboPromo.buyQty} {unit})
                      </button>
                    )}
                </div>

                {activePromo &&
                  activePromoSchedule &&
                  (activePromo.startDate || activePromo.endDate) && (
                    <div className="mt-1.5 flex items-center gap-1.5 text-[11px] font-medium text-blue-800 bg-blue-50 border border-blue-200 rounded px-2.5 py-1.5">
                      <CalendarClock className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        Periode Promo: {activePromoSchedule.periodLabel}
                        {activePromoSchedule.remainingLabel
                          ? ` (${activePromoSchedule.remainingLabel})`
                          : ''}
                      </span>
                    </div>
                  )}

                {hasSyncedPromo &&
                  !activePromo &&
                  (product.promoStartDate || product.promoEndDate) && (
                    <p className="text-[11px] font-medium text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1 w-fit">
                      Periode Promosi: {product.promoStartDate || 'Sekarang'} s/d{' '}
                      {product.promoEndDate || 'Berlaku'}
                    </p>
                  )}
              </div>
              <p className="text-xs text-slate-600 tabular-nums">
                {outOfStock
                  ? 'Stok saat ini kosong'
                  : `Tersedia ${effectiveStock} ${unit} siap dikirim`}
              </p>
              <p className="text-sm text-slate-600 leading-relaxed pt-2 border-t border-slate-100">
                {product.description}
              </p>
            </div>

            <div className="space-y-3 pt-4 border-t border-slate-200">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-700">
                  Jumlah Input ({unit})
                </span>
                <div className="inline-flex items-center border border-slate-200 rounded-lg">
                  <button
                    type="button"
                    disabled={quantity <= 1 || outOfStock}
                    onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                    aria-label="Kurangi jumlah"
                    className="p-2 text-slate-600 hover:text-slate-900 disabled:opacity-40 cursor-pointer"
                  >
                    <Minus className="w-4 h-4" />
                  </button>
                  <span className="px-4 font-mono tabular-nums text-sm font-medium text-slate-900">
                    {outOfStock ? 0 : quantity} {unit}
                  </span>
                  <button
                    type="button"
                    disabled={quantity >= effectiveStock || outOfStock}
                    onClick={() => setQuantity((q) => Math.min(effectiveStock, q + 1))}
                    aria-label="Tambah jumlah"
                    className="p-2 text-slate-600 hover:text-slate-900 disabled:opacity-40 cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {promoInfo.comboPromo && !outOfStock && (
                <p className="text-xs font-medium text-emerald-800 bg-emerald-50/80 border border-emerald-200 rounded-lg px-3 py-2">
                  {promoInfo.comboFreeQty > 0 ? (
                    <>
                      Input <strong>{quantity} {unit}</strong> (stok -{quantity}) ·{' '}
                      <strong>Bayar {promoInfo.paidQty} {unit}</strong> ·{' '}
                      <strong>Gratis {promoInfo.comboFreeQty} {unit}</strong>
                    </>
                  ) : (
                    <>
                      Masukkan <strong>{promoInfo.comboBundleSize} {unit}</strong>{' '}
                      (kurang {promoInfo.comboShortfallQty} {unit}) agar cukup bayar{' '}
                      <strong>{promoInfo.comboPromo.buyQty} {unit}</strong>!
                    </>
                  )}
                </p>
              )}

              <button
                type="button"
                disabled={outOfStock}
                onClick={handleConfirm}
                className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-semibold text-white bg-blue-700 rounded-lg hover:bg-red-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                <ShoppingBag className="w-4 h-4" />
                <span>
                  {outOfStock
                    ? 'Stok Habis'
                    : `Tambah ${quantity} ${unit} · ${formatPrimaryAmount(totalUsd, master)} / ${formatSecondaryAmount(totalUsd, master)}`}
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

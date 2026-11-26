import { Clock, Gift, Info, Sparkles, Tag } from 'lucide-react';
import type { Product, Promotion } from '../types/marketplace';
import {
  computePromoForProduct,
  getPromotionScheduleInfo,
  normalizeProductUnit,
} from '../lib/catalogSeed';

interface ProductPromoNoticeProps {
  product: Product;
  promotions: Promotion[];
  compact?: boolean;
}

export function ProductPromoNotice({
  product,
  promotions,
  compact = true,
}: ProductPromoNoticeProps) {
  const promoSummary = computePromoForProduct(product, 1, promotions);
  const { comboPromo, bogoPromo, discountPromo, comboBundleSize, effectiveUnitUsd } =
    promoSummary;

  const hasSyncedDiscount =
    !discountPromo &&
    Boolean(product.promoActive) &&
    (effectiveUnitUsd < product.price || Boolean(product.promoLabel?.trim()));

  if (!comboPromo && !bogoPromo && !discountPromo && !hasSyncedDiscount) {
    return null;
  }

  const unit = normalizeProductUnit(product.unit);
  const activePromoObj = comboPromo || bogoPromo || discountPromo;
  const scheduleInfo = activePromoObj
    ? getPromotionScheduleInfo(activePromoObj)
    : null;

  let toneClasses =
    'bg-amber-50 border-amber-300 text-amber-950';
  let headerIcon = <Info className="w-3.5 h-3.5 text-amber-700 shrink-0" />;
  let guidanceText = '';

  if (comboPromo) {
    toneClasses = 'bg-amber-50 border-amber-300 text-amber-950';
    headerIcon = <Sparkles className="w-3.5 h-3.5 text-amber-700 shrink-0" />;
    guidanceText = `Wajib input ${comboBundleSize} ${unit} untuk mendapatkan harga Beli ${comboPromo.buyQty} Free ${comboPromo.getQty} (stok -${comboBundleSize} ${unit}, bayar ${comboPromo.buyQty} ${unit}).`;
  } else if (bogoPromo) {
    toneClasses = 'bg-emerald-50 border-emerald-300 text-emerald-950';
    headerIcon = <Gift className="w-3.5 h-3.5 text-emerald-700 shrink-0" />;
    guidanceText = `Input minimal ${bogoPromo.buyQty} ${unit} untuk mendapatkan bonus gratis ${bogoPromo.getQty} ${unit} (berlaku kelipatan).`;
  } else if (discountPromo || effectiveUnitUsd < product.price) {
    toneClasses = 'bg-red-50 border-red-200 text-red-950';
    headerIcon = <Tag className="w-3.5 h-3.5 text-red-600 shrink-0" />;
    const discountPct = discountPromo
      ? discountPromo.discountPercent
      : Math.max(
          1,
          Math.round(((product.price - effectiveUnitUsd) / Math.max(0.01, product.price)) * 100)
        );
    guidanceText = `Diskon ${discountPct}% otomatis berlaku mulai dari input 1 ${unit}.`;
  } else {
    toneClasses = 'bg-red-50 border-red-200 text-red-950';
    headerIcon = <Tag className="w-3.5 h-3.5 text-red-600 shrink-0" />;
    guidanceText = `${product.promoLabel?.trim() || 'Promo aktif'} — berlaku otomatis mulai dari input 1 ${unit}.`;
  }

  if (compact) {
    return (
      <div
        className={`rounded-lg border px-2.5 py-2 text-[11px] leading-snug ${toneClasses}`}
      >
        <div className="flex items-center gap-1 font-bold uppercase tracking-wide text-[10px]">
          {headerIcon}
          <span>Keterangan Promo</span>
        </div>
        <p className="mt-0.5 font-medium">{guidanceText}</p>
        {scheduleInfo && (scheduleInfo.startLabel || scheduleInfo.endLabel) && (
          <p className="mt-1 inline-flex items-center gap-1 text-[10px] opacity-85 font-mono">
            <Clock className="w-3 h-3 shrink-0" />
            <span>
              {scheduleInfo.remainingLabel
                ? `${scheduleInfo.periodLabel} · ${scheduleInfo.remainingLabel}`
                : scheduleInfo.periodLabel}
            </span>
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={`rounded-xl border p-3.5 space-y-1.5 ${toneClasses}`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 font-bold text-xs uppercase tracking-wider">
          {headerIcon}
          <span>Keterangan Promo</span>
        </div>
        {scheduleInfo?.remainingLabel && (
          <span className="font-mono text-[11px] font-semibold px-2 py-0.5 rounded bg-white/80 border border-current/20">
            {scheduleInfo.remainingLabel}
          </span>
        )}
      </div>
      <p className="text-xs sm:text-sm font-semibold leading-relaxed">
        {guidanceText}
      </p>
      {comboPromo && (
        <p className="text-xs opacity-90 leading-relaxed">
          Berlaku kelipatan: input {comboBundleSize * 2} {unit} cukup bayar{' '}
          {comboPromo.buyQty * 2} {unit}, input {comboBundleSize * 3} {unit}{' '}
          cukup bayar {comboPromo.buyQty * 3} {unit}.
        </p>
      )}
      {scheduleInfo && (scheduleInfo.startLabel || scheduleInfo.endLabel) && (
        <p className="text-[11px] opacity-85 flex items-center gap-1.5 pt-0.5">
          <Clock className="w-3.5 h-3.5 shrink-0" />
          <span>Periode Promo: {scheduleInfo.periodLabel}</span>
        </p>
      )}
    </div>
  );
}

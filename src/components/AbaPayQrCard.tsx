import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import type { StoreCheckoutConfig, StoreMasterConfig } from '../types/marketplace';
import { ABA_MERCHANT, copyTextToClipboard } from '../lib/catalogSeed';
import { DEFAULT_MASTER_CONFIG, formatPrimaryAmount } from '../lib/storeDefaults';

interface AbaPayQrCardProps {
  amountUsd: number;
  qrPayload: string;
  referenceLabel?: string;
  compact?: boolean;
  checkoutConfig?: StoreCheckoutConfig;
  masterConfig?: StoreMasterConfig;
}

export function AbaPayQrCard({
  amountUsd,
  qrPayload,
  referenceLabel,
  compact = false,
  checkoutConfig,
  masterConfig,
}: AbaPayQrCardProps) {
  const master = masterConfig || DEFAULT_MASTER_CONFIG;
  const formattedPrimary = formatPrimaryAmount(amountUsd, master);
  const [copiedAccount, setCopiedAccount] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [customImgError, setCustomImgError] = useState(false);

  const providerName = checkoutConfig?.paymentProviderName || "ABA' PAY";
  const tagline = checkoutConfig?.paymentTagline || ABA_MERCHANT.tagline;
  const merchantName = checkoutConfig?.merchantName || ABA_MERCHANT.merchantName;
  const accountHolder = checkoutConfig?.accountHolder || ABA_MERCHANT.accountHolder;
  const accountNumber = checkoutConfig?.accountNumber || ABA_MERCHANT.accountNumber;
  const paymentNetwork = checkoutConfig?.paymentNetwork || ABA_MERCHANT.network;
  const customQrImageUrl = checkoutConfig?.paymentQrImageUrl?.trim() || '';
  const qrInstructionText = checkoutConfig?.qrInstructionText?.trim() || '';

  useEffect(() => {
    setCustomImgError(false);
  }, [customQrImageUrl]);

  const showCustomQrImage = Boolean(customQrImageUrl) && !customImgError;

  const handleCopyAccount = async () => {
    await copyTextToClipboard(accountNumber);
    setCopiedAccount(true);
    setTimeout(() => setCopiedAccount(false), 1800);
  };

  const handleCopyPayload = async () => {
    await copyTextToClipboard(qrPayload);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 1800);
  };

  return (
    <div className="relative bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
      {/* Top ABA Deep Teal Bar */}
      <div className="h-2.5 w-full bg-[#00526B]" />

      <div className={compact ? 'p-4 space-y-3' : 'p-5 space-y-4'}>
        {/* Payment Provider Header */}
        <div className="text-center space-y-1">
          {providerName.toUpperCase() === "ABA' PAY" ? (
            <div className="inline-flex items-baseline justify-center gap-1.5 font-display text-2xl font-extrabold tracking-tight">
              <span className="text-[#00526B]">
                ABA<span className="text-[#D9232E]">&apos;</span>
              </span>
              <span className="text-[#1AA6B7]">PAY</span>
            </div>
          ) : (
            <p className="font-display text-xl font-extrabold tracking-tight text-[#00526B]">
              {providerName}
            </p>
          )}
          {tagline && (
            <p className="text-xs italic font-medium text-slate-600">
              {tagline}
            </p>
          )}
        </div>

        {/* Custom Uploaded Barcode/QR Image OR Auto-Generated Framed KHQR */}
        <div className="flex flex-col items-center">
          {showCustomQrImage ? (
            <div className="w-full max-w-[260px] rounded-xl overflow-hidden border border-slate-200 bg-white p-2 flex items-center justify-center">
              <img
                src={customQrImageUrl}
                alt={`Barcode Pembayaran ${merchantName}`}
                referrerPolicy="no-referrer"
                onError={() => setCustomImgError(true)}
                className="w-full max-h-72 object-contain rounded-lg"
              />
            </div>
          ) : (
            <div className="relative p-3 bg-white">
              {/* Corner brackets */}
              <span className="absolute top-0 left-0 w-6 h-6 border-t-2 border-l-2 border-slate-300 rounded-tl-lg" />
              <span className="absolute top-0 right-0 w-6 h-6 border-t-2 border-r-2 border-slate-300 rounded-tr-lg" />
              <span className="absolute bottom-0 left-0 w-6 h-6 border-b-2 border-l-2 border-slate-300 rounded-bl-lg" />
              <span className="absolute bottom-0 right-0 w-6 h-6 border-b-2 border-r-2 border-slate-300 rounded-br-lg" />

              <div className="relative inline-flex items-center justify-center bg-white p-1">
                <QRCodeSVG
                  value={qrPayload}
                  size={compact ? 148 : 172}
                  level="H"
                  bgColor="#FFFFFF"
                  fgColor="#0F172A"
                  marginSize={1}
                  title={`${providerName} ${merchantName} ${formattedPrimary}`}
                />
                {/* Center Currency Symbol Circle Emblem */}
                <div
                  aria-hidden="true"
                  className="absolute w-8 h-8 rounded-full bg-white flex items-center justify-center shadow-xs"
                >
                  <span className="w-6 h-6 rounded-full bg-slate-900 text-white font-mono text-[11px] font-bold flex items-center justify-center">
                    {master.primaryCurrencySymbol.slice(0, 2)}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Merchant Info */}
          <div className="mt-2 text-center space-y-0.5">
            <p className="text-sm font-extrabold tracking-wide text-slate-900">
              {merchantName}
            </p>
            <p className="text-xs font-semibold text-slate-700">
              {accountHolder}
            </p>
            <p className="font-mono text-xs font-semibold text-slate-600 tabular-nums">
              {accountNumber}
            </p>
          </div>

          {/* Total Primary Currency & Reference */}
          <div className="mt-3 w-full rounded-lg bg-[#00526B]/5 border border-[#00526B]/20 px-3 py-2 text-center space-y-0.5">
            <p className="text-[11px] font-medium text-slate-600">
              Total Tagihan QR ({master.primaryCurrencyCode})
            </p>
            <p className="font-mono tabular-nums text-base font-bold text-[#00526B]">
              {formattedPrimary} {master.primaryCurrencyCode}
            </p>
            {referenceLabel && (
              <p className="font-mono text-[11px] text-slate-500">
                {referenceLabel}
              </p>
            )}
          </div>

          {qrInstructionText && (
            <p className="mt-2 text-[11px] text-slate-600 text-center leading-relaxed">
              {qrInstructionText}
            </p>
          )}
        </div>

        {/* Action Copy Buttons */}
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={handleCopyAccount}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#00526B] bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
          >
            {copiedAccount ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-600" />
                <span>Rekening Tersalin</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Salin No. {accountNumber}</span>
              </>
            )}
          </button>

          {!showCustomQrImage && (
            <button
              type="button"
              onClick={handleCopyPayload}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-800 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors cursor-pointer"
            >
              {copiedLink ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Kode QR Tersalin</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Salin Kode Bayar</span>
                </>
              )}
            </button>
          )}
        </div>

        {/* Network Member Footer */}
        <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-[11px]">
          <div>
            <span className="block text-slate-500 italic text-[10px]">
              Member of
            </span>
            <span className="font-display font-black tracking-wider text-sm text-[#D9232E]">
              {paymentNetwork}
            </span>
          </div>
          <span className="font-mono text-[11px] font-semibold text-[#00526B]">
            {master.primaryCurrencyCode} ({master.primaryCurrencySymbol})
          </span>
        </div>
      </div>

      {/* Bottom ABA Accent Bar */}
      <div className="h-2 w-full bg-gradient-to-r from-[#00526B] via-[#00526B] to-[#D9232E]" />
    </div>
  );
}

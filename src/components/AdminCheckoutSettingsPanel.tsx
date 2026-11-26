import { useEffect, useRef, useState } from 'react';
import {
  Banknote,
  CheckCircle2,
  QrCode,
  RotateCcw,
  Save,
  ShoppingBag,
  Sliders,
  Trash2,
  Truck,
  Upload,
} from 'lucide-react';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import type { StoreCheckoutConfig, StoreMasterConfig } from '../types/marketplace';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import {
  compressImageFileToDataUrl,
  DEFAULT_CHECKOUT_CONFIG,
  DEFAULT_MASTER_CONFIG,
  mergeCheckoutConfig,
  mergeMasterConfig,
} from '../lib/storeDefaults';
import { BOOTSTRAPPED_ADMIN_EMAIL, formatKHR } from '../lib/catalogSeed';
import { broadcastCrossTabEvent } from '../lib/crossAccountSync';
import { AbaPayQrCard } from './AbaPayQrCard';

interface AdminCheckoutSettingsPanelProps {
  config: StoreCheckoutConfig;
  masterConfig?: StoreMasterConfig;
  adminEmail: string;
  onNotify: (msg: string) => void;
}

type CheckoutSectionTab = 'payment_qr' | 'cart' | 'checkout_form' | 'success';

export function AdminCheckoutSettingsPanel({
  config,
  masterConfig,
  adminEmail,
  onNotify,
}: AdminCheckoutSettingsPanelProps) {
  const [draft, setDraft] = useState<StoreCheckoutConfig>(() =>
    mergeCheckoutConfig(config)
  );
  const [section, setSection] = useState<CheckoutSectionTab>('payment_qr');
  const [uploadingQr, setUploadingQr] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const lastRemoteSnapshotRef = useRef<string>(JSON.stringify(mergeCheckoutConfig(config)));

  useEffect(() => {
    const merged = mergeCheckoutConfig(config);
    lastRemoteSnapshotRef.current = JSON.stringify(merged);
    setDraft(merged);
  }, [config]);

  // Debounced Auto-Save Permanen ke Firestore (2 detik setelah selesai mengubah)
  useEffect(() => {
    const currentSnapshot = JSON.stringify(draft);
    if (currentSnapshot === lastRemoteSnapshotRef.current) return;
    if (!draft.enableCashPayment && !draft.enableQrPayment) return;
    const rate = Math.round(Number(draft.exchangeRateKhr));
    const minOrder = Number(draft.minOrderUsd);
    const shippingCost = Number(draft.shippingCostUsd);
    if (
      !Number.isFinite(rate) || rate < 1000 || rate > 10000 ||
      !Number.isFinite(minOrder) || minOrder < 0 || minOrder > 10000 ||
      !Number.isFinite(shippingCost) || shippingCost < 0 || shippingCost > 500
    ) {
      return;
    }

    const timer = setTimeout(() => {
      const payload = {
        id: 'checkout' as const,
        cartTitle: draft.cartTitle.trim().slice(0, 60) || DEFAULT_CHECKOUT_CONFIG.cartTitle,
        cartNotice: draft.cartNotice.trim().slice(0, 240),
        minOrderUsd: Number(minOrder.toFixed(2)),
        checkoutButtonLabel:
          draft.checkoutButtonLabel.trim().slice(0, 40) ||
          DEFAULT_CHECKOUT_CONFIG.checkoutButtonLabel,
        checkoutHeading:
          draft.checkoutHeading.trim().slice(0, 80) ||
          DEFAULT_CHECKOUT_CONFIG.checkoutHeading,
        checkoutIntro: draft.checkoutIntro.trim().slice(0, 300),
        shippingLabel:
          draft.shippingLabel.trim().slice(0, 60) || DEFAULT_CHECKOUT_CONFIG.shippingLabel,
        shippingEta: draft.shippingEta.trim().slice(0, 80),
        shippingCostUsd: Number(shippingCost.toFixed(2)),
        requireGpsLocation: Boolean(draft.requireGpsLocation),
        allowLocationPhoto: Boolean(draft.allowLocationPhoto),
        showNotesField: Boolean(draft.showNotesField),
        contactFieldLabel:
          draft.contactFieldLabel.trim().slice(0, 60) ||
          DEFAULT_CHECKOUT_CONFIG.contactFieldLabel,
        contactFieldPlaceholder: draft.contactFieldPlaceholder.trim().slice(0, 80),
        submitButtonLabel:
          draft.submitButtonLabel.trim().slice(0, 40) ||
          DEFAULT_CHECKOUT_CONFIG.submitButtonLabel,
        enableCashPayment: Boolean(draft.enableCashPayment),
        cashTitle: draft.cashTitle.trim().slice(0, 40) || DEFAULT_CHECKOUT_CONFIG.cashTitle,
        cashDescription: draft.cashDescription.trim().slice(0, 160),
        enableQrPayment: Boolean(draft.enableQrPayment),
        qrTitle: draft.qrTitle.trim().slice(0, 40) || DEFAULT_CHECKOUT_CONFIG.qrTitle,
        qrDescription: draft.qrDescription.trim().slice(0, 160),
        exchangeRateKhr: rate,
        paymentProviderName:
          draft.paymentProviderName.trim().slice(0, 40) ||
          DEFAULT_CHECKOUT_CONFIG.paymentProviderName,
        paymentTagline: draft.paymentTagline.trim().slice(0, 80),
        merchantName:
          draft.merchantName.trim().slice(0, 80) || DEFAULT_CHECKOUT_CONFIG.merchantName,
        accountHolder:
          draft.accountHolder.trim().slice(0, 80) || DEFAULT_CHECKOUT_CONFIG.accountHolder,
        accountNumber:
          draft.accountNumber.trim().slice(0, 60) || DEFAULT_CHECKOUT_CONFIG.accountNumber,
        paymentNetwork:
          draft.paymentNetwork.trim().slice(0, 30) ||
          DEFAULT_CHECKOUT_CONFIG.paymentNetwork,
        paymentQrImageUrl: draft.paymentQrImageUrl.trim(),
        qrInstructionText: draft.qrInstructionText.trim().slice(0, 240),
        successTitle:
          draft.successTitle.trim().slice(0, 80) || DEFAULT_CHECKOUT_CONFIG.successTitle,
        successMessage: draft.successMessage.trim().slice(0, 300),
        updatedBy: (adminEmail || BOOTSTRAPPED_ADMIN_EMAIL).slice(0, 128),
        updatedAt: serverTimestamp(),
      };
      void setDoc(doc(db, 'storeConfig', 'checkout'), payload)
        .then(() => {
          lastRemoteSnapshotRef.current = currentSnapshot;
          const activeMaster = mergeMasterConfig(masterConfig || DEFAULT_MASTER_CONFIG);
          if (
            activeMaster.primaryCurrencyCode === 'USD' &&
            activeMaster.secondaryCurrencyCode === 'KHR' &&
            Math.round(activeMaster.exchangeRate) !== rate
          ) {
            void setDoc(doc(db, 'storeConfig', 'master'), {
              id: 'master' as const,
              storeName: activeMaster.storeName,
              storeTagline: activeMaster.storeTagline,
              storeLogoUrl: activeMaster.storeLogoUrl,
              footerText: activeMaster.footerText,
              primaryCurrencyCode: activeMaster.primaryCurrencyCode,
              primaryCurrencySymbol: activeMaster.primaryCurrencySymbol,
              secondaryCurrencyCode: activeMaster.secondaryCurrencyCode,
              secondaryCurrencySymbol: activeMaster.secondaryCurrencySymbol,
              exchangeRate: rate,
              themeAccent: activeMaster.themeAccent,
              storeAddress: activeMaster.storeAddress,
              storeHours: activeMaster.storeHours,
              telegramOrderUrl: activeMaster.telegramOrderUrl,
              permanentStoreUrl: activeMaster.permanentStoreUrl || '',
              announcementBarText: activeMaster.announcementBarText,
              maintenanceMode: Boolean(activeMaster.maintenanceMode),
              updatedBy: (adminEmail || BOOTSTRAPPED_ADMIN_EMAIL).slice(0, 128),
              updatedAt: serverTimestamp(),
            }).catch(() => undefined);
          }
          onNotify('Perubahan Setting Checkout & Kurs tersimpan otomatis permanen di semua akun.');
        })
        .catch(() => undefined);
    }, 2000);

    return () => clearTimeout(timer);
  }, [draft, adminEmail, onNotify, masterConfig]);

  const handleUploadQrImage = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setErrorMsg(null);
    setUploadingQr(true);
    try {
      const dataUrl = await compressImageFileToDataUrl(file, {
        maxWidth: 720,
        maxHeight: 960,
        maxChars: 225000,
        initialQuality: 0.85,
      });
      setDraft((prev) => ({ ...prev, paymentQrImageUrl: dataUrl }));
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Gagal memproses gambar barcode pembayaran.'
      );
    } finally {
      setUploadingQr(false);
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!draft.enableCashPayment && !draft.enableQrPayment) {
      setErrorMsg(
        'Minimal satu metode pembayaran (CASH atau QR / Barcode) harus diaktifkan.'
      );
      return;
    }

    const rate = Math.round(Number(draft.exchangeRateKhr));
    if (!Number.isFinite(rate) || rate < 1000 || rate > 10000) {
      setErrorMsg('Kurs tukar 1 USD harus antara 1.000 sampai 10.000 KHR.');
      return;
    }

    const minOrder = Number(draft.minOrderUsd);
    if (!Number.isFinite(minOrder) || minOrder < 0 || minOrder > 10000) {
      setErrorMsg('Minimal belanja harus antara $0 sampai $10.000.');
      return;
    }

    const shippingCost = Number(draft.shippingCostUsd);
    if (!Number.isFinite(shippingCost) || shippingCost < 0 || shippingCost > 500) {
      setErrorMsg('Ongkos kirim harus antara $0 (Gratis) sampai $500.');
      return;
    }

    const payload = {
      id: 'checkout' as const,
      cartTitle: draft.cartTitle.trim().slice(0, 60) || DEFAULT_CHECKOUT_CONFIG.cartTitle,
      cartNotice: draft.cartNotice.trim().slice(0, 240),
      minOrderUsd: Number(minOrder.toFixed(2)),
      checkoutButtonLabel:
        draft.checkoutButtonLabel.trim().slice(0, 40) ||
        DEFAULT_CHECKOUT_CONFIG.checkoutButtonLabel,
      checkoutHeading:
        draft.checkoutHeading.trim().slice(0, 80) ||
        DEFAULT_CHECKOUT_CONFIG.checkoutHeading,
      checkoutIntro: draft.checkoutIntro.trim().slice(0, 300),
      shippingLabel:
        draft.shippingLabel.trim().slice(0, 60) || DEFAULT_CHECKOUT_CONFIG.shippingLabel,
      shippingEta: draft.shippingEta.trim().slice(0, 80),
      shippingCostUsd: Number(shippingCost.toFixed(2)),
      requireGpsLocation: Boolean(draft.requireGpsLocation),
      allowLocationPhoto: Boolean(draft.allowLocationPhoto),
      showNotesField: Boolean(draft.showNotesField),
      contactFieldLabel:
        draft.contactFieldLabel.trim().slice(0, 60) ||
        DEFAULT_CHECKOUT_CONFIG.contactFieldLabel,
      contactFieldPlaceholder: draft.contactFieldPlaceholder.trim().slice(0, 80),
      submitButtonLabel:
        draft.submitButtonLabel.trim().slice(0, 40) ||
        DEFAULT_CHECKOUT_CONFIG.submitButtonLabel,
      enableCashPayment: Boolean(draft.enableCashPayment),
      cashTitle: draft.cashTitle.trim().slice(0, 40) || DEFAULT_CHECKOUT_CONFIG.cashTitle,
      cashDescription: draft.cashDescription.trim().slice(0, 160),
      enableQrPayment: Boolean(draft.enableQrPayment),
      qrTitle: draft.qrTitle.trim().slice(0, 40) || DEFAULT_CHECKOUT_CONFIG.qrTitle,
      qrDescription: draft.qrDescription.trim().slice(0, 160),
      exchangeRateKhr: rate,
      paymentProviderName:
        draft.paymentProviderName.trim().slice(0, 40) ||
        DEFAULT_CHECKOUT_CONFIG.paymentProviderName,
      paymentTagline: draft.paymentTagline.trim().slice(0, 80),
      merchantName:
        draft.merchantName.trim().slice(0, 80) || DEFAULT_CHECKOUT_CONFIG.merchantName,
      accountHolder:
        draft.accountHolder.trim().slice(0, 80) || DEFAULT_CHECKOUT_CONFIG.accountHolder,
      accountNumber:
        draft.accountNumber.trim().slice(0, 60) || DEFAULT_CHECKOUT_CONFIG.accountNumber,
      paymentNetwork:
        draft.paymentNetwork.trim().slice(0, 30) ||
        DEFAULT_CHECKOUT_CONFIG.paymentNetwork,
      paymentQrImageUrl: draft.paymentQrImageUrl.trim(),
      qrInstructionText: draft.qrInstructionText.trim().slice(0, 240),
      successTitle:
        draft.successTitle.trim().slice(0, 80) || DEFAULT_CHECKOUT_CONFIG.successTitle,
      successMessage: draft.successMessage.trim().slice(0, 300),
      updatedBy: (adminEmail || BOOTSTRAPPED_ADMIN_EMAIL).slice(0, 128),
      updatedAt: serverTimestamp(),
    };

    setSaving(true);
    try {
      await setDoc(doc(db, 'storeConfig', 'checkout'), payload);
      const activeMaster = mergeMasterConfig(masterConfig || DEFAULT_MASTER_CONFIG);
      if (
        activeMaster.primaryCurrencyCode === 'USD' &&
        activeMaster.secondaryCurrencyCode === 'KHR' &&
        Math.round(activeMaster.exchangeRate) !== rate
      ) {
        await setDoc(doc(db, 'storeConfig', 'master'), {
          id: 'master' as const,
          storeName: activeMaster.storeName,
          storeTagline: activeMaster.storeTagline,
          storeLogoUrl: activeMaster.storeLogoUrl,
          footerText: activeMaster.footerText,
          primaryCurrencyCode: activeMaster.primaryCurrencyCode,
          primaryCurrencySymbol: activeMaster.primaryCurrencySymbol,
          secondaryCurrencyCode: activeMaster.secondaryCurrencyCode,
          secondaryCurrencySymbol: activeMaster.secondaryCurrencySymbol,
          exchangeRate: rate,
          themeAccent: activeMaster.themeAccent,
          storeAddress: activeMaster.storeAddress,
          storeHours: activeMaster.storeHours,
          telegramOrderUrl: activeMaster.telegramOrderUrl,
          permanentStoreUrl: activeMaster.permanentStoreUrl || '',
          announcementBarText: activeMaster.announcementBarText,
          maintenanceMode: Boolean(activeMaster.maintenanceMode),
          updatedBy: (adminEmail || BOOTSTRAPPED_ADMIN_EMAIL).slice(0, 128),
          updatedAt: serverTimestamp(),
        }).catch(() => undefined);
      }
      broadcastCrossTabEvent({ type: 'revision_broadcast', source: 'checkout_settings' });
      onNotify(
        'Pengaturan Keranjang, Checkout, Kurs & Barcode Pembayaran berhasil disimpan dan langsung aktif di seluruh toko!'
      );
    } catch (err) {
      try {
        handleFirestoreError(err, OperationType.WRITE, 'storeConfig/checkout');
      } catch (wrapped) {
        setErrorMsg(
          wrapped instanceof Error
            ? wrapped.message
            : 'Gagal menyimpan pengaturan checkout.'
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const handleResetDefaults = () => {
    setDraft({
      ...DEFAULT_CHECKOUT_CONFIG,
      updatedBy: adminEmail || BOOTSTRAPPED_ADMIN_EMAIL,
    });
    setErrorMsg(null);
  };

  const previewPayload = `https://pay.ababank.com/khqr?merchant=${encodeURIComponent(
    draft.merchantName
  )}&account=${encodeURIComponent(draft.accountNumber)}&amount=10.00&currency=USD`;

  return (
    <form onSubmit={handleSaveConfig} className="space-y-6">
      {/* Top Action & Section Switcher */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-slate-900">
              Template Pengaturan Keranjang, Checkout &amp; Barcode Pembayaran
            </h2>
            <p className="text-xs text-slate-600 mt-0.5">
              Semua perubahan di sini langsung berlaku real-time saat pelanggan membuka Keranjang hingga menyelesaikan pembayaran.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleResetDefaults}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset Awal</span>
            </button>
            <button
              type="submit"
              disabled={saving || uploadingQr}
              className="inline-flex items-center gap-1.5 px-5 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-red-600 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              <span>{saving ? 'Menyimpan...' : 'Simpan Semua Setting'}</span>
            </button>
          </div>
        </div>

        {/* 4 Segmented Template Sections */}
        <div className="flex items-center gap-1.5 p-1 bg-slate-100 rounded-lg overflow-x-auto w-fit max-w-full">
          <button
            type="button"
            onClick={() => setSection('payment_qr')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              section === 'payment_qr'
                ? 'bg-white text-blue-700 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <QrCode className="w-3.5 h-3.5" />
            <span>Barcode QR &amp; Pembayaran</span>
          </button>
          <button
            type="button"
            onClick={() => setSection('cart')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              section === 'cart'
                ? 'bg-white text-blue-700 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <ShoppingBag className="w-3.5 h-3.5" />
            <span>Keranjang Belanja</span>
          </button>
          <button
            type="button"
            onClick={() => setSection('checkout_form')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              section === 'checkout_form'
                ? 'bg-white text-blue-700 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Sliders className="w-3.5 h-3.5" />
            <span>Form Checkout &amp; Ongkir</span>
          </button>
          <button
            type="button"
            onClick={() => setSection('success')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              section === 'success'
                ? 'bg-white text-blue-700 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>Pesan Berhasil</span>
          </button>
        </div>

        {errorMsg && (
          <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-700">
            {errorMsg}
          </div>
        )}
      </div>

      {/* SECTION 1: PAYMENT METHODS & BARCODE / QR REPLACEMENT */}
      {section === 'payment_qr' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-7 space-y-5">
            {/* Upload Custom QR / Barcode Image */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-100">
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    Ganti Gambar Barcode / QR Pembayaran
                  </h3>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Unggah foto/screenshot QR Bank Anda (ABA, ACLEDA, Wing, QRIS, dll.) agar tampil langsung saat pelanggan memilih bayar QR.
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <label className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors cursor-pointer">
                  <Upload className="w-4 h-4" />
                  <span>
                    {uploadingQr
                      ? 'Memproses Barcode QR...'
                      : draft.paymentQrImageUrl
                        ? 'Ganti Gambar Barcode QR'
                        : 'Upload Gambar Barcode QR'}
                  </span>
                  <input
                    type="file"
                    accept="image/*"
                    disabled={uploadingQr}
                    onChange={handleUploadQrImage}
                    className="sr-only"
                  />
                </label>

                {draft.paymentQrImageUrl && (
                  <button
                    type="button"
                    onClick={() =>
                      setDraft((prev) => ({ ...prev, paymentQrImageUrl: '' }))
                    }
                    className="inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 hover:bg-rose-100 rounded-lg cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Kembali ke QR Otomatis</span>
                  </button>
                )}
              </div>

              <p className="text-[11px] text-slate-500">
                {draft.paymentQrImageUrl
                  ? 'Mode aktif: Menggunakan Gambar Barcode / QR khusus yang Anda unggah.'
                  : 'Mode aktif: Menggunakan QR Otomatis KHQR berdasarkan info rekening di bawah.'}
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Nama Bank / Provider QR
                  </label>
                  <input
                    type="text"
                    maxLength={40}
                    value={draft.paymentProviderName}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        paymentProviderName: e.target.value,
                      }))
                    }
                    placeholder="ABA' PAY"
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Jaringan Pembayaran
                  </label>
                  <input
                    type="text"
                    maxLength={30}
                    value={draft.paymentNetwork}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        paymentNetwork: e.target.value,
                      }))
                    }
                    placeholder="KHQR / QRIS"
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Nama Merchant / Toko
                  </label>
                  <input
                    type="text"
                    maxLength={80}
                    value={draft.merchantName}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, merchantName: e.target.value }))
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Nama Pemilik Rekening
                  </label>
                  <input
                    type="text"
                    maxLength={80}
                    value={draft.accountHolder}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, accountHolder: e.target.value }))
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Nomor Rekening
                  </label>
                  <input
                    type="text"
                    maxLength={60}
                    value={draft.accountNumber}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, accountNumber: e.target.value }))
                    }
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Tagline Singkat Kartu QR
                  </label>
                  <input
                    type="text"
                    maxLength={80}
                    value={draft.paymentTagline}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, paymentTagline: e.target.value }))
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Instruksi Pembayaran QR untuk Pelanggan
                  </label>
                  <textarea
                    rows={2}
                    maxLength={240}
                    value={draft.qrInstructionText}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        qrInstructionText: e.target.value,
                      }))
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>
              </div>
            </div>

            {/* Payment Method Toggles & Kurs KHR */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <h3 className="text-sm font-bold text-slate-900">
                Pilihan Metode Pembayaran &amp; Kurs Tukar
              </h3>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="p-4 border border-slate-200 rounded-xl space-y-3 bg-red-50/30">
                  <label className="flex items-center justify-between gap-2 cursor-pointer">
                    <span className="inline-flex items-center gap-1.5 text-sm font-bold text-red-700">
                      <Banknote className="w-4 h-4" />
                      Aktifkan Bayar CASH (KHR)
                    </span>
                    <input
                      type="checkbox"
                      checked={draft.enableCashPayment}
                      onChange={(e) =>
                        setDraft((prev) => ({
                          ...prev,
                          enableCashPayment: e.target.checked,
                        }))
                      }
                      className="w-4 h-4 rounded border-slate-300 text-red-600 focus:ring-red-600"
                    />
                  </label>
                  <input
                    type="text"
                    maxLength={40}
                    value={draft.cashTitle}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, cashTitle: e.target.value }))
                    }
                    placeholder="Judul tombol CASH"
                    className="w-full px-3 py-1.5 text-xs border border-slate-200 bg-white rounded-lg"
                  />
                  <input
                    type="text"
                    maxLength={160}
                    value={draft.cashDescription}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        cashDescription: e.target.value,
                      }))
                    }
                    placeholder="Deskripsi metode CASH"
                    className="w-full px-3 py-1.5 text-xs border border-slate-200 bg-white rounded-lg"
                  />
                </div>

                <div className="p-4 border border-slate-200 rounded-xl space-y-3 bg-blue-50/30">
                  <label className="flex items-center justify-between gap-2 cursor-pointer">
                    <span className="inline-flex items-center gap-1.5 text-sm font-bold text-blue-700">
                      <QrCode className="w-4 h-4" />
                      Aktifkan Bayar QR (USD)
                    </span>
                    <input
                      type="checkbox"
                      checked={draft.enableQrPayment}
                      onChange={(e) =>
                        setDraft((prev) => ({
                          ...prev,
                          enableQrPayment: e.target.checked,
                        }))
                      }
                      className="w-4 h-4 rounded border-slate-300 text-blue-700 focus:ring-blue-700"
                    />
                  </label>
                  <input
                    type="text"
                    maxLength={40}
                    value={draft.qrTitle}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, qrTitle: e.target.value }))
                    }
                    placeholder="Judul tombol QR"
                    className="w-full px-3 py-1.5 text-xs border border-slate-200 bg-white rounded-lg"
                  />
                  <input
                    type="text"
                    maxLength={160}
                    value={draft.qrDescription}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, qrDescription: e.target.value }))
                    }
                    placeholder="Deskripsi metode QR"
                    className="w-full px-3 py-1.5 text-xs border border-slate-200 bg-white rounded-lg"
                  />
                </div>
              </div>

              <div className="max-w-xs">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Kurs Tukar 1 USD ke KHR (Riel)
                </label>
                <input
                  type="number"
                  min={1000}
                  max={10000}
                  step={50}
                  value={draft.exchangeRateKhr}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      exchangeRateKhr: Number(e.target.value),
                    }))
                  }
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  Contoh: $1.00 = {formatKHR(draft.exchangeRateKhr || 4000)}
                </p>
              </div>
            </div>
          </div>

          {/* Live Customer QR Preview Column */}
          <div className="lg:col-span-5 space-y-3">
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <div>
                <p className="text-xs font-semibold text-blue-700">
                  Preview Tampilan Pelanggan
                </p>
                <h3 className="text-sm font-bold text-slate-900">
                  Kartu Barcode / QR saat Checkout
                </h3>
              </div>

              <AbaPayQrCard
                amountUsd={10}
                qrPayload={previewPayload}
                referenceLabel="Ref: PREVIEW-100001"
                checkoutConfig={draft}
              />
            </div>
          </div>
        </div>
      )}

      {/* SECTION 2: CART SETTINGS */}
      {section === 'cart' && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5 max-w-3xl">
          <div>
            <h3 className="text-sm font-bold text-slate-900">
              Pengaturan Tampilan &amp; Aturan Keranjang Belanja
            </h3>
            <p className="text-xs text-slate-600 mt-0.5">
              Atur judul keranjang, pengumuman khusus di dalam keranjang, minimal order, dan tombol lanjut checkout.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Judul Panel Keranjang
              </label>
              <input
                type="text"
                maxLength={60}
                value={draft.cartTitle}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, cartTitle: e.target.value }))
                }
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Teks Tombol Lanjut Checkout
              </label>
              <input
                type="text"
                maxLength={40}
                value={draft.checkoutButtonLabel}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    checkoutButtonLabel: e.target.value,
                  }))
                }
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Minimal Belanja (USD · isi 0 jika tanpa minimal)
              </label>
              <input
                type="number"
                min={0}
                max={10000}
                step="0.5"
                value={draft.minOrderUsd}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    minOrderUsd: Number(e.target.value),
                  }))
                }
                className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Jika lebih dari $0, pelanggan tidak bisa lanjut checkout sebelum subtotal mencapai minimal.
              </p>
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Info / Pengumuman di Keranjang (Opsional)
              </label>
              <textarea
                rows={2}
                maxLength={240}
                value={draft.cartNotice}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, cartNotice: e.target.value }))
                }
                placeholder="Contoh: Pesanan di atas jam 21.00 akan diproses keesokan paginya. Terima kasih!"
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
            </div>
          </div>
        </div>
      )}

      {/* SECTION 3: CHECKOUT FORM & SHIPPING */}
      {section === 'checkout_form' && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-6 max-w-3xl">
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-bold text-slate-900">
                Pengaturan Formulir Checkout
              </h3>
              <p className="text-xs text-slate-600 mt-0.5">
                Sesuaikan teks panduan, kolom wajib/opsional, foto lokasi, dan teks tombol kirim pesanan.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Judul Kotak Info Checkout
                </label>
                <input
                  type="text"
                  maxLength={80}
                  value={draft.checkoutHeading}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      checkoutHeading: e.target.value,
                    }))
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Teks Tombol Kirim Pesanan
                </label>
                <input
                  type="text"
                  maxLength={40}
                  value={draft.submitButtonLabel}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      submitButtonLabel: e.target.value,
                    }))
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Pesan Panduan Checkout
                </label>
                <textarea
                  rows={2}
                  maxLength={300}
                  value={draft.checkoutIntro}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, checkoutIntro: e.target.value }))
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Label Kolom Kontak Pelanggan
                </label>
                <input
                  type="text"
                  maxLength={60}
                  value={draft.contactFieldLabel}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      contactFieldLabel: e.target.value,
                    }))
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Contoh Isian (Placeholder) Kontak
                </label>
                <input
                  type="text"
                  maxLength={80}
                  value={draft.contactFieldPlaceholder}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      contactFieldPlaceholder: e.target.value,
                    }))
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
            </div>

            {/* Field Feature Toggles */}
            <div className="pt-2 space-y-2.5">
              <label className="flex items-start justify-between gap-4 p-3.5 border border-slate-200 rounded-xl cursor-pointer hover:bg-slate-50">
                <div>
                  <p className="text-xs font-semibold text-slate-900">
                    Wajibkan Lokasi GPS saat Checkout
                  </p>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Jika dimatikan, pelanggan bisa mengisi alamat/patokan secara manual tanpa wajib mengaktifkan GPS.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={draft.requireGpsLocation}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      requireGpsLocation: e.target.checked,
                    }))
                  }
                  className="mt-0.5 w-4 h-4 rounded border-slate-300 text-blue-700"
                />
              </label>

              <label className="flex items-start justify-between gap-4 p-3.5 border border-slate-200 rounded-xl cursor-pointer hover:bg-slate-50">
                <div>
                  <p className="text-xs font-semibold text-slate-900">
                    Tampilkan Fitur Upload Foto Lokasi / Rumah (Opsional)
                  </p>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Pelanggan dapat melampirkan foto patokan lokasi, dan tetap bisa checkout meski tidak diisi.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={draft.allowLocationPhoto}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      allowLocationPhoto: e.target.checked,
                    }))
                  }
                  className="mt-0.5 w-4 h-4 rounded border-slate-300 text-blue-700"
                />
              </label>

              <label className="flex items-start justify-between gap-4 p-3.5 border border-slate-200 rounded-xl cursor-pointer hover:bg-slate-50">
                <div>
                  <p className="text-xs font-semibold text-slate-900">
                    Tampilkan Kolom Catatan Pesanan
                  </p>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Izinkan pelanggan menulis catatan tambahan seperti rasa, ukuran, atau patokan kurir.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={draft.showNotesField}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      showNotesField: e.target.checked,
                    }))
                  }
                  className="mt-0.5 w-4 h-4 rounded border-slate-300 text-blue-700"
                />
              </label>
            </div>
          </div>

          {/* Shipping Config */}
          <div className="pt-5 border-t border-slate-200 space-y-4">
            <div className="flex items-center gap-2">
              <Truck className="w-4 h-4 text-emerald-700" />
              <h3 className="text-sm font-bold text-slate-900">
                Pengaturan Pengiriman &amp; Ongkos Kirim
              </h3>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Nama Layanan Pengiriman
                </label>
                <input
                  type="text"
                  maxLength={60}
                  value={draft.shippingLabel}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, shippingLabel: e.target.value }))
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Ongkir (USD · 0 = Gratis)
                </label>
                <input
                  type="number"
                  min={0}
                  max={500}
                  step="0.25"
                  value={draft.shippingCostUsd}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      shippingCostUsd: Number(e.target.value),
                    }))
                  }
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-200 rounded-lg"
                />
              </div>

              <div className="sm:col-span-3">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Estimasi Waktu Tiba
                </label>
                <input
                  type="text"
                  maxLength={80}
                  value={draft.shippingEta}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, shippingEta: e.target.value }))
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SECTION 4: ORDER SUCCESS MESSAGE */}
      {section === 'success' && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4 max-w-3xl">
          <div>
            <h3 className="text-sm font-bold text-slate-900">
              Pesan Konfirmasi Setelah Pesanan Berhasil Dikirim
            </h3>
            <p className="text-xs text-slate-600 mt-0.5">
              Pesan ini muncul tepat setelah pelanggan menekan tombol kirim pesanan.
            </p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Judul Pesanan Berhasil
              </label>
              <input
                type="text"
                maxLength={80}
                value={draft.successTitle}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, successTitle: e.target.value }))
                }
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Isi Pesan Konfirmasi
              </label>
              <textarea
                rows={3}
                maxLength={300}
                value={draft.successMessage}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, successMessage: e.target.value }))
                }
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              />
            </div>
          </div>
        </div>
      )}
    </form>
  );
}

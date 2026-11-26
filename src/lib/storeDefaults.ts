import bannerPromoBelanjaImg from '../assets/images/banner_promo_belanja_1795343864288.jpg';
import bannerFreeDeliveryImg from '../assets/images/banner_free_delivery_1795343865085.jpg';
import bannerCashQrPayImg from '../assets/images/banner_cash_qr_pay_1795343863591.jpg';
import type {
  BackgroundDisplayMode,
  CurrencyCode,
  StoreBackgroundConfig,
  StoreBanner,
  StoreCheckoutConfig,
  StoreHoursConfig,
  StoreHoursMode,
  StoreMasterConfig,
  ThemeAccent,
} from '../types/marketplace';
import {
  ABA_MERCHANT,
  BOOTSTRAPPED_ADMIN_EMAIL,
  formatAmountByCurrency,
  MASTER_DATA_EMAIL,
  STORE_NAME,
  USD_TO_KHR_RATE,
} from './catalogSeed';

export interface BannerPresetOption {
  id: string;
  label: string;
  imageUrl: string;
}

export const BANNER_IMAGE_PRESETS: BannerPresetOption[] = [
  {
    id: 'preset_minimarket',
    label: 'Template Rak Minimarket',
    imageUrl: bannerPromoBelanjaImg,
  },
  {
    id: 'preset_delivery',
    label: 'Template Free Delivery',
    imageUrl: bannerFreeDeliveryImg,
  },
  {
    id: 'preset_payment',
    label: 'Template Bayar QR & Cash',
    imageUrl: bannerCashQrPayImg,
  },
];

export const DEFAULT_STORE_BANNERS: StoreBanner[] = [
  {
    id: 'banner_promo_utama',
    kicker: 'Promo Spesial Toko',
    title: `Belanja Harian Lebih Hemat di ${STORE_NAME}`,
    subtitle:
      'Pilihan minuman dingin, snack favorit, mie instan, hingga kebutuhan harian lengkap dalam satuan PCS, PACK, RENTENG, COMBO, dan BKS.',
    imageUrl: bannerPromoBelanjaImg,
    ctaLabel: 'Lihat Promo & Diskon',
    ctaTarget: 'promo',
    sortOrder: 0,
    isActive: true,
  },
  {
    id: 'banner_free_delivery',
    kicker: 'Pengumuman Penting · Free Delivery',
    title: 'Gratis Ongkir Langsung ke Titik Lokasi GPS Anda',
    subtitle:
      'Cukup klik lokasi GPS saat checkout tanpa perlu masukkan email. Pesanan otomatis diteruskan ke kurir untuk pengantaran cepat.',
    imageUrl: bannerFreeDeliveryImg,
    ctaLabel: 'Buka Katalog Produk',
    ctaTarget: 'catalog',
    sortOrder: 1,
    isActive: true,
  },
  {
    id: 'banner_pembayaran_fleksibel',
    kicker: 'Pembayaran Praktis',
    title: "Bayar Fleksibel dengan CASH (KHR) atau QR ABA' PAY (USD)",
    subtitle:
      'Pilih bayar tunai saat barang tiba atau scan QR instan dalam USD. Lacak status pesanan Anda secara langsung kapan saja.',
    imageUrl: bannerCashQrPayImg,
    ctaLabel: 'Lacak Pesanan',
    ctaTarget: 'orders',
    sortOrder: 2,
    isActive: true,
  },
];

export const DEFAULT_CHECKOUT_CONFIG: StoreCheckoutConfig = {
  id: 'checkout',
  cartTitle: 'Keranjang Belanja',
  cartNotice: '',
  minOrderUsd: 0,
  checkoutButtonLabel: 'Lanjut ke Checkout',
  checkoutHeading: 'Checkout Cepat Tanpa Email',
  checkoutIntro:
    'Langsung isi Nama Penerima, Username / Nomor Telepon Telegram, dan klik Lokasi GPS Anda. Pesanan otomatis masuk ke Admin & Kurir Delivery tanpa perlu memasukkan email.',
  shippingLabel: 'FREE DELIVERY · Pengantaran Langsung',
  shippingEta: 'Estimasi tiba 30-90 menit setelah pesanan dikonfirmasi',
  shippingCostUsd: 0,
  requireGpsLocation: true,
  allowLocationPhoto: true,
  showNotesField: true,
  contactFieldLabel: 'Username / Nomor Telepon Telegram',
  contactFieldPlaceholder: '@username_telegram atau +855 / 0812...',
  submitButtonLabel: 'Kirim Pesanan',
  enableCashPayment: true,
  cashTitle: 'CASH',
  cashDescription: 'Bayar tunai menggunakan mata uang Riel Kamboja (KHR).',
  enableQrPayment: true,
  qrTitle: "ABA' PAY QR",
  qrDescription: "Scan KHQR ABA' PAY dalam mata uang USD ($).",
  exchangeRateKhr: USD_TO_KHR_RATE,
  paymentProviderName: "ABA' PAY",
  paymentTagline: ABA_MERCHANT.tagline,
  merchantName: ABA_MERCHANT.merchantName,
  accountHolder: ABA_MERCHANT.accountHolder,
  accountNumber: ABA_MERCHANT.accountNumber,
  paymentNetwork: ABA_MERCHANT.network,
  paymentQrImageUrl: '',
  qrInstructionText:
    'Scan barcode/QR di atas sesuai nominal total USD. Simpan bukti pembayaran jika diperlukan saat konfirmasi.',
  successTitle: 'TERIMAKASIH SUDAH ORDER DI ALPAMART TRIMUIA',
  successMessage:
    'TERIMAKASIH SUDAH ORDER DI ALPAMART TRIMUIA, UNTUK PESANAN SILAHKAN KIRIM BUKTI PESANAN ANDA DI TELEGRAM TERSEBUT : https://t.me/AlpamartTM03',
  updatedBy: BOOTSTRAPPED_ADMIN_EMAIL,
  updatedAt: null,
};

export function mergeCheckoutConfig(
  raw?: Partial<StoreCheckoutConfig> | null
): StoreCheckoutConfig {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_CHECKOUT_CONFIG };
  }
  const rate = Math.round(Number(raw.exchangeRateKhr ?? DEFAULT_CHECKOUT_CONFIG.exchangeRateKhr));
  const safeRate =
    Number.isFinite(rate) && rate >= 1000 && rate <= 10000
      ? rate
      : DEFAULT_CHECKOUT_CONFIG.exchangeRateKhr;
  const minOrder = Number(raw.minOrderUsd ?? 0);
  const safeMinOrder = Number.isFinite(minOrder) && minOrder >= 0 ? minOrder : 0;
  const shippingCost = Number(raw.shippingCostUsd ?? 0);
  const safeShippingCost =
    Number.isFinite(shippingCost) && shippingCost >= 0 ? shippingCost : 0;

  const enableCash =
    typeof raw.enableCashPayment === 'boolean'
      ? raw.enableCashPayment
      : DEFAULT_CHECKOUT_CONFIG.enableCashPayment;
  const enableQr =
    typeof raw.enableQrPayment === 'boolean'
      ? raw.enableQrPayment
      : DEFAULT_CHECKOUT_CONFIG.enableQrPayment;

  return {
    ...DEFAULT_CHECKOUT_CONFIG,
    ...raw,
    id: 'checkout',
    minOrderUsd: safeMinOrder,
    shippingCostUsd: safeShippingCost,
    exchangeRateKhr: safeRate,
    enableCashPayment: enableCash || !enableQr ? enableCash : true,
    enableQrPayment: enableQr,
    paymentQrImageUrl:
      typeof raw.paymentQrImageUrl === 'string' ? raw.paymentQrImageUrl : '',
  };
}

export function convertUsdToKhrWithRate(usd: number, rateKhr: number): number {
  const safeRate =
    Number.isFinite(rateKhr) && rateKhr >= 1000 && rateKhr <= 10000
      ? rateKhr
      : USD_TO_KHR_RATE;
  return Math.round(usd * safeRate);
}

export const DEFAULT_STORE_LOGO_URL = '/assets/aistudio/ALPA_17db3f6e.jpg';

export const DEFAULT_MASTER_CONFIG: StoreMasterConfig = {
  id: 'master',
  storeName: STORE_NAME,
  storeTagline: 'Belanja online mudah dan terpercaya dengan pengantaran langsung ke titik GPS Anda.',
  storeLogoUrl: DEFAULT_STORE_LOGO_URL,
  footerText: `${STORE_NAME} · Marketplace Online Resmi`,
  primaryCurrencyCode: 'USD',
  primaryCurrencySymbol: '$',
  secondaryCurrencyCode: 'KHR',
  secondaryCurrencySymbol: 'KHR',
  exchangeRate: USD_TO_KHR_RATE,
  themeAccent: 'blue_red',
  storeAddress: '',
  storeHours: 'Buka 24 Jam Nonstop · Tanpa Tutup',
  telegramOrderUrl: 'https://t.me/AlpamartTM03',
  announcementBarText: '',
  maintenanceMode: false,
  updatedBy: MASTER_DATA_EMAIL,
  updatedAt: null,
};

export interface CurrencyPreset {
  id: string;
  label: string;
  primaryCode: CurrencyCode;
  primarySymbol: string;
  secondaryCode: CurrencyCode;
  secondarySymbol: string;
  exchangeRate: number;
}

export const CURRENCY_PRESETS: CurrencyPreset[] = [
  {
    id: 'usd_khr',
    label: 'USD ($) & KHR (Riel Kamboja)',
    primaryCode: 'USD',
    primarySymbol: '$',
    secondaryCode: 'KHR',
    secondarySymbol: 'KHR',
    exchangeRate: 4100,
  },
  {
    id: 'idr_idr',
    label: 'IDR (Rupiah Indonesia Penuh)',
    primaryCode: 'IDR',
    primarySymbol: 'Rp',
    secondaryCode: 'IDR',
    secondarySymbol: 'Rp',
    exchangeRate: 1,
  },
  {
    id: 'usd_idr',
    label: 'USD ($) & IDR (Rupiah)',
    primaryCode: 'USD',
    primarySymbol: '$',
    secondaryCode: 'IDR',
    secondarySymbol: 'Rp',
    exchangeRate: 16000,
  },
  {
    id: 'thb_usd',
    label: 'THB (Baht) & USD ($)',
    primaryCode: 'THB',
    primarySymbol: '฿',
    secondaryCode: 'USD',
    secondarySymbol: '$',
    exchangeRate: 0.029,
  },
  {
    id: 'myr_usd',
    label: 'MYR (Ringgit) & USD ($)',
    primaryCode: 'MYR',
    primarySymbol: 'RM',
    secondaryCode: 'USD',
    secondarySymbol: '$',
    exchangeRate: 0.22,
  },
  {
    id: 'sgd_idr',
    label: 'SGD (S$) & IDR (Rupiah)',
    primaryCode: 'SGD',
    primarySymbol: 'S$',
    secondaryCode: 'IDR',
    secondarySymbol: 'Rp',
    exchangeRate: 12000,
  },
];

export const CURRENCY_OPTIONS: { code: CurrencyCode; label: string; symbol: string }[] = [
  { code: 'USD', label: 'USD — US Dollar ($)', symbol: '$' },
  { code: 'KHR', label: 'KHR — Riel Kamboja (KHR)', symbol: 'KHR' },
  { code: 'IDR', label: 'IDR — Rupiah Indonesia (Rp)', symbol: 'Rp' },
  { code: 'THB', label: 'THB — Baht Thailand (฿)', symbol: '฿' },
  { code: 'MYR', label: 'MYR — Ringgit Malaysia (RM)', symbol: 'RM' },
  { code: 'SGD', label: 'SGD — Dolar Singapura (S$)', symbol: 'S$' },
  { code: 'VND', label: 'VND — Dong Vietnam (₫)', symbol: '₫' },
];

export const THEME_ACCENT_STYLES: Record<
  ThemeAccent,
  {
    label: string;
    topBar: string;
    primaryBtn: string;
    secondaryBtn: string;
    primaryText: string;
    secondaryText: string;
    pageBg: string;
    footerBg: string;
  }
> = {
  blue_red: {
    label: 'Merah-Biru Klasik',
    topBar: 'bg-gradient-to-r from-red-600 via-white to-blue-700',
    primaryBtn: 'bg-blue-700 hover:bg-red-600 text-white',
    secondaryBtn: 'bg-red-600 hover:bg-red-700 text-white',
    primaryText: 'text-blue-700',
    secondaryText: 'text-red-600',
    pageBg: 'bg-[linear-gradient(135deg,#fee2e2_0%,#ffffff_42%,#ffffff_58%,#dbeafe_100%)]',
    footerBg: 'bg-blue-950 border-red-600',
  },
  emerald: {
    label: 'Hijau Emerald Modern',
    topBar: 'bg-gradient-to-r from-emerald-600 via-teal-400 to-emerald-700',
    primaryBtn: 'bg-emerald-700 hover:bg-emerald-800 text-white',
    secondaryBtn: 'bg-teal-600 hover:bg-teal-700 text-white',
    primaryText: 'text-emerald-700',
    secondaryText: 'text-teal-700',
    pageBg: 'bg-[linear-gradient(135deg,#d1fae5_0%,#ffffff_42%,#ffffff_58%,#ccfbf1_100%)]',
    footerBg: 'bg-emerald-950 border-teal-500',
  },
  indigo: {
    label: 'Biru Indigo Elegan',
    topBar: 'bg-gradient-to-r from-indigo-700 via-sky-400 to-indigo-600',
    primaryBtn: 'bg-indigo-700 hover:bg-indigo-800 text-white',
    secondaryBtn: 'bg-sky-600 hover:bg-sky-700 text-white',
    primaryText: 'text-indigo-700',
    secondaryText: 'text-sky-700',
    pageBg: 'bg-[linear-gradient(135deg,#e0e7ff_0%,#ffffff_42%,#ffffff_58%,#e0f2fe_100%)]',
    footerBg: 'bg-indigo-950 border-sky-500',
  },
  amber: {
    label: 'Emas Amber Hangat',
    topBar: 'bg-gradient-to-r from-amber-500 via-orange-400 to-amber-600',
    primaryBtn: 'bg-amber-600 hover:bg-amber-700 text-white',
    secondaryBtn: 'bg-orange-600 hover:bg-orange-700 text-white',
    primaryText: 'text-amber-700',
    secondaryText: 'text-orange-700',
    pageBg: 'bg-[linear-gradient(135deg,#fef3c7_0%,#ffffff_42%,#ffffff_58%,#ffedd5_100%)]',
    footerBg: 'bg-stone-950 border-amber-500',
  },
  rose: {
    label: 'Merah Rose Premium',
    topBar: 'bg-gradient-to-r from-rose-600 via-pink-400 to-rose-700',
    primaryBtn: 'bg-rose-600 hover:bg-rose-700 text-white',
    secondaryBtn: 'bg-slate-900 hover:bg-slate-800 text-white',
    primaryText: 'text-rose-600',
    secondaryText: 'text-slate-900',
    pageBg: 'bg-[linear-gradient(135deg,#ffe4e6_0%,#ffffff_42%,#ffffff_58%,#fce7f3_100%)]',
    footerBg: 'bg-rose-950 border-rose-500',
  },
  slate: {
    label: 'Monokrom Slate Profesional',
    topBar: 'bg-gradient-to-r from-slate-900 via-slate-500 to-slate-900',
    primaryBtn: 'bg-slate-900 hover:bg-slate-800 text-white',
    secondaryBtn: 'bg-blue-700 hover:bg-blue-800 text-white',
    primaryText: 'text-slate-900',
    secondaryText: 'text-blue-700',
    pageBg: 'bg-[linear-gradient(135deg,#e2e8f0_0%,#ffffff_42%,#ffffff_58%,#f1f5f9_100%)]',
    footerBg: 'bg-slate-950 border-slate-500',
  },
};

const NON_DIRECT_IMAGE_HOSTS = new Set([
  'prnt.sc',
  'www.prnt.sc',
  'prntscr.com',
  'www.prntscr.com',
  'lightshot.com',
  'www.lightshot.com',
  'drive.google.com',
  'docs.google.com',
  'dropbox.com',
  'www.dropbox.com',
  't.me',
  'telegram.me',
  'wa.me',
  'facebook.com',
  'www.facebook.com',
  'm.facebook.com',
  'instagram.com',
  'www.instagram.com',
  'youtube.com',
  'www.youtube.com',
  'youtu.be',
  'tiktok.com',
  'www.tiktok.com',
  'ibb.co',
  'imgur.com',
  'www.imgur.com',
]);

const KNOWN_DIRECT_IMAGE_HOSTS = new Set([
  'firebasestorage.googleapis.com',
  'storage.googleapis.com',
  'lh3.googleusercontent.com',
  'i.ibb.co',
  'i.imgur.com',
  'alpamartkps.store',
  'www.alpamartkps.store',
  'images.openfoodfacts.org',
  'images.openbeautyfacts.org',
  'images.openproductsfacts.org',
]);

export function isUsableDirectLogoUrl(raw?: string | null): boolean {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '/assets/alpamart-logo.svg') return false;
  if (/^data:image\/(?:jpeg|jpg|png|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/i.test(trimmed)) {
    return trimmed.length <= 250000;
  }
  if (trimmed.startsWith('/assets/')) {
    return /\.(?:jpg|jpeg|png|webp|gif|svg|avif)(?:[?#].*)?$/i.test(trimmed);
  }
  if (trimmed.startsWith('https://')) {
    try {
      const parsed = new URL(trimmed);
      const host = parsed.hostname.toLowerCase();
      if (NON_DIRECT_IMAGE_HOSTS.has(host)) return false;
      if (KNOWN_DIRECT_IMAGE_HOSTS.has(host)) return true;
      return /\.(?:jpg|jpeg|png|webp|gif|svg|avif)$/i.test(parsed.pathname);
    } catch {
      return false;
    }
  }
  return false;
}

export function mergeMasterConfig(
  raw?: Partial<StoreMasterConfig> | null
): StoreMasterConfig {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_MASTER_CONFIG };
  }
  const validCurrencies: CurrencyCode[] = [
    'USD',
    'KHR',
    'IDR',
    'THB',
    'MYR',
    'SGD',
    'VND',
  ];
  const validThemes: ThemeAccent[] = [
    'blue_red',
    'emerald',
    'indigo',
    'amber',
    'rose',
    'slate',
  ];
  const primaryCode = validCurrencies.includes(raw.primaryCurrencyCode as CurrencyCode)
    ? (raw.primaryCurrencyCode as CurrencyCode)
    : DEFAULT_MASTER_CONFIG.primaryCurrencyCode;
  const secondaryCode = validCurrencies.includes(
    raw.secondaryCurrencyCode as CurrencyCode
  )
    ? (raw.secondaryCurrencyCode as CurrencyCode)
    : DEFAULT_MASTER_CONFIG.secondaryCurrencyCode;
  const themeAccent = validThemes.includes(raw.themeAccent as ThemeAccent)
    ? (raw.themeAccent as ThemeAccent)
    : DEFAULT_MASTER_CONFIG.themeAccent;
  const parsedRate = Number(raw.exchangeRate ?? DEFAULT_MASTER_CONFIG.exchangeRate);
  const safeRate =
    Number.isFinite(parsedRate) && parsedRate >= 0.0001 && parsedRate <= 1000000
      ? parsedRate
      : DEFAULT_MASTER_CONFIG.exchangeRate;

  return {
    ...DEFAULT_MASTER_CONFIG,
    ...raw,
    id: 'master',
    storeName:
      typeof raw.storeName === 'string' && raw.storeName.trim().length >= 2
        ? raw.storeName.trim()
        : DEFAULT_MASTER_CONFIG.storeName,
    storeLogoUrl: isUsableDirectLogoUrl(raw.storeLogoUrl)
      ? raw.storeLogoUrl!.trim()
      : DEFAULT_STORE_LOGO_URL,
    primaryCurrencyCode: primaryCode,
    primaryCurrencySymbol:
      typeof raw.primaryCurrencySymbol === 'string' &&
      raw.primaryCurrencySymbol.trim().length >= 1
        ? raw.primaryCurrencySymbol.trim()
        : DEFAULT_MASTER_CONFIG.primaryCurrencySymbol,
    secondaryCurrencyCode: secondaryCode,
    secondaryCurrencySymbol:
      typeof raw.secondaryCurrencySymbol === 'string' &&
      raw.secondaryCurrencySymbol.trim().length >= 1
        ? raw.secondaryCurrencySymbol.trim()
        : DEFAULT_MASTER_CONFIG.secondaryCurrencySymbol,
    exchangeRate: safeRate,
    themeAccent,
    storeHours:
      typeof raw.storeHours === 'string' &&
      raw.storeHours.trim().length > 0 &&
      raw.storeHours.trim() !== 'Buka Setiap Hari · 08:00 - 22:00'
        ? raw.storeHours.trim()
        : DEFAULT_MASTER_CONFIG.storeHours,
    maintenanceMode: Boolean(raw.maintenanceMode),
  };
}

export function convertPrimaryToSecondary(
  primaryAmount: number,
  master: StoreMasterConfig
): number {
  const converted = primaryAmount * master.exchangeRate;
  if (
    master.secondaryCurrencyCode === 'KHR' ||
    master.secondaryCurrencyCode === 'IDR' ||
    master.secondaryCurrencyCode === 'VND'
  ) {
    return Math.round(converted);
  }
  return Number(converted.toFixed(2));
}

export function formatPrimaryAmount(
  amount: number,
  master: StoreMasterConfig
): string {
  return formatAmountByCurrency(
    amount,
    master.primaryCurrencyCode,
    master.primaryCurrencySymbol
  );
}

export function formatSecondaryAmount(
  primaryAmount: number,
  master: StoreMasterConfig
): string {
  return formatAmountByCurrency(
    convertPrimaryToSecondary(primaryAmount, master),
    master.secondaryCurrencyCode,
    master.secondaryCurrencySymbol
  );
}

/**
 * Compresses an uploaded File (from iPhone Safari, Android, or PC) into a compact JPEG Data URL
 * that fits safely inside Firestore's document validation limit (<= 240,000 chars).
 * Uses URL.createObjectURL first to prevent Safari iOS memory crashes on 12MP-48MP iPhone photos.
 */
export function compressImageFileToDataUrl(
  file: File,
  options?: {
    maxWidth?: number;
    maxHeight?: number;
    maxChars?: number;
    initialQuality?: number;
  }
): Promise<string> {
  const maxWidth = options?.maxWidth ?? 1280;
  const maxHeight = options?.maxHeight ?? 720;
  const maxChars = options?.maxChars ?? 235000;
  const initialQuality = options?.initialQuality ?? 0.82;

  return new Promise((resolve, reject) => {
    const looksLikeImage =
      !file.type ||
      file.type.startsWith('image/') ||
      /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name || '');

    if (!looksLikeImage) {
      reject(new Error('File harus berupa gambar (JPG, PNG, atau WebP).'));
      return;
    }

    const decodeImageSource = (src: string, revokeAfter?: string) => {
      const cleanup = () => {
        if (revokeAfter) {
          try {
            URL.revokeObjectURL(revokeAfter);
          } catch {
            // ignore
          }
        }
      };

      const img = new window.Image();
      img.onload = () => {
        try {
          let w = img.naturalWidth || img.width;
          let h = img.naturalHeight || img.height;
          const ratio = Math.min(1, maxWidth / w, maxHeight / h);
          w = Math.max(1, Math.round(w * ratio));
          h = Math.max(1, Math.round(h * ratio));

          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            cleanup();
            reject(new Error('Browser tidak mendukung pemrosesan gambar.'));
            return;
          }

          let quality = initialQuality;
          let scale = 1;
          let dataUrl = '';

          for (let attempt = 0; attempt < 6; attempt++) {
            canvas.width = Math.max(1, Math.round(w * scale));
            canvas.height = Math.max(1, Math.round(h * scale));
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

            dataUrl = canvas.toDataURL('image/jpeg', quality);
            if (dataUrl.length <= maxChars) {
              cleanup();
              resolve(dataUrl);
              return;
            }
            quality = Math.max(0.42, quality - 0.12);
            scale = scale * 0.82;
          }

          cleanup();
          reject(
            new Error(
              'Ukuran gambar masih terlalu besar setelah dikompres. Pilih gambar lain yang lebih ringan.'
            )
          );
        } catch {
          cleanup();
          reject(new Error('Gagal memproses gambar. Silakan coba gambar lain.'));
        }
      };
      img.onerror = () => {
        cleanup();
        reject(new Error('Format gambar tidak dapat dibaca. Gunakan JPG atau PNG.'));
      };
      img.src = src;
    };

    const readViaFileReader = () => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        if (!result) {
          reject(new Error('Gagal membaca file gambar.'));
          return;
        }
        decodeImageSource(result);
      };
      reader.onerror = () => reject(new Error('Gagal membaca file gambar.'));
      reader.readAsDataURL(file);
    };

    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      try {
        const objectUrl = URL.createObjectURL(file);
        const fallbackImg = new window.Image();
        fallbackImg.onload = () => {
          URL.revokeObjectURL(objectUrl);
          const freshUrl = URL.createObjectURL(file);
          decodeImageSource(freshUrl, freshUrl);
        };
        fallbackImg.onerror = () => {
          try {
            URL.revokeObjectURL(objectUrl);
          } catch {
            // ignore
          }
          readViaFileReader();
        };
        fallbackImg.src = objectUrl;
        return;
      } catch {
        // Fall back to FileReader below
      }
    }

    readViaFileReader();
  });
}

export interface PreparedProductImageResult {
  dataUrl: string;
  originalWidth: number;
  originalHeight: number;
  savedWidth: number;
  savedHeight: number;
  sizeKb: number;
}

/**
 * Prepares an admin product catalog photo while preserving its EXACT original dimensions
 * and aspect ratio (zero cropping). If the original file already fits within Firestore's
 * 240 KB data-image limit, it is saved verbatim without altering pixel dimensions;
 * otherwise quality is lowered first at the original dimensions before any proportional scaling.
 */
export function prepareProductImagePreservingDimensions(
  file: File,
  maxChars = 240000
): Promise<PreparedProductImageResult> {
  return new Promise((resolve, reject) => {
    const looksLikeImage =
      !file.type ||
      file.type.startsWith('image/') ||
      /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name || '');

    if (!looksLikeImage) {
      reject(new Error('File harus berupa gambar (JPG, PNG, WebP, atau GIF).'));
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const rawDataUrl = String(reader.result || '');
      if (!rawDataUrl) {
        reject(new Error('Gagal membaca file gambar.'));
        return;
      }

      const img = new window.Image();
      img.onload = () => {
        const origW = img.naturalWidth || img.width || 1;
        const origH = img.naturalHeight || img.height || 1;

        // 1. If the original image already fits Firestore's validated limit, keep it 100% untouched!
        if (
          rawDataUrl.length <= maxChars &&
          /^data:image\/(jpeg|jpg|png|webp|gif);base64,/.test(rawDataUrl)
        ) {
          resolve({
            dataUrl: rawDataUrl,
            originalWidth: origW,
            originalHeight: origH,
            savedWidth: origW,
            savedHeight: origH,
            sizeKb: Math.max(1, Math.round((rawDataUrl.length * 3) / 4 / 1024)),
          });
          return;
        }

        // 2. Otherwise keep EXACT original width & height first and reduce JPEG quality
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Browser tidak mendukung pemrosesan gambar.'));
          return;
        }

        const tryEncode = (targetW: number, targetH: number, quality: number): string => {
          canvas.width = Math.max(1, Math.round(targetW));
          canvas.height = Math.max(1, Math.round(targetH));
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL('image/jpeg', quality);
        };

        for (const q of [0.88, 0.78, 0.68, 0.58, 0.48]) {
          const encoded = tryEncode(origW, origH, q);
          if (encoded.length <= maxChars) {
            resolve({
              dataUrl: encoded,
              originalWidth: origW,
              originalHeight: origH,
              savedWidth: origW,
              savedHeight: origH,
              sizeKb: Math.max(1, Math.round((encoded.length * 3) / 4 / 1024)),
            });
            return;
          }
        }

        // 3. Only if huge photo (e.g. 12MP+) still exceeds limit, scale proportionally (never crop)
        let scale = Math.min(0.85, 1600 / Math.max(origW, origH));
        for (let attempt = 0; attempt < 6; attempt++) {
          const w = Math.max(1, Math.round(origW * scale));
          const h = Math.max(1, Math.round(origH * scale));
          const encoded = tryEncode(w, h, Math.max(0.5, 0.78 - attempt * 0.06));
          if (encoded.length <= maxChars) {
            resolve({
              dataUrl: encoded,
              originalWidth: origW,
              originalHeight: origH,
              savedWidth: w,
              savedHeight: h,
              sizeKb: Math.max(1, Math.round((encoded.length * 3) / 4 / 1024)),
            });
            return;
          }
          scale *= 0.78;
        }

        reject(
          new Error(
            'Ukuran file gambar terlalu besar untuk disimpan. Silakan pilih gambar lain yang lebih ringan.'
          )
        );
      };
      img.onerror = () => {
        reject(new Error('Format gambar tidak dapat dibaca. Gunakan JPG, PNG, atau WebP.'));
      };
      img.src = rawDataUrl;
    };
    reader.onerror = () => reject(new Error('Gagal membaca file gambar.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Prepares a delivery proof attachment (photo OR PDF file) 100% locally on the device
 * without requiring any internet connection.
 */
export async function prepareProofAttachmentFile(file: File): Promise<{
  dataUrl: string;
  mimeType: string;
  fileName: string;
}> {
  const fileName = file.name || 'bukti-pengiriman';
  const isPdf =
    file.type === 'application/pdf' || /\.pdf$/i.test(fileName);

  if (isPdf) {
    const rawDataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Gagal membaca file PDF dari perangkat.'));
      reader.readAsDataURL(file);
    });
    if (!rawDataUrl.startsWith('data:application/pdf;base64,')) {
      throw new Error('File PDF tidak valid. Silakan pilih file PDF lain atau foto.');
    }
    if (rawDataUrl.length > 345000) {
      throw new Error(
        'Ukuran file PDF terlalu besar (maksimal sekitar 250 KB). Kompres PDF atau unggah foto/screenshot bukti.'
      );
    }
    return {
      dataUrl: rawDataUrl,
      mimeType: 'application/pdf',
      fileName,
    };
  }

  const looksLikeImage =
    !file.type ||
    file.type.startsWith('image/') ||
    /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(fileName);

  if (!looksLikeImage) {
    throw new Error(
      'Format file belum didukung. Gunakan foto (JPG, PNG, WebP, HEIC) atau file PDF (maks. 250 KB).'
    );
  }

  try {
    const compressed = await compressImageFileToDataUrl(file, {
      maxWidth: 720,
      maxHeight: 720,
      maxChars: 240000,
      initialQuality: 0.72,
    });
    return {
      dataUrl: compressed,
      mimeType: 'image/jpeg',
      fileName,
    };
  } catch (firstErr) {
    // Fallback for browsers where createImageBitmap succeeds when Image() fails
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(file);
        const ratio = Math.min(1, 720 / bitmap.width, 720 / bitmap.height);
        const w = Math.max(1, Math.round(bitmap.width * ratio));
        const h = Math.max(1, Math.round(bitmap.height * ratio));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(bitmap, 0, 0, w, h);
          bitmap.close?.();
          for (const q of [0.72, 0.58, 0.45]) {
            const url = canvas.toDataURL('image/jpeg', q);
            if (url.length <= 240000) {
              return { dataUrl: url, mimeType: 'image/jpeg', fileName };
            }
          }
        }
      } catch {
        // Fall through to raw small-image fallback
      }
    }

    // Final fallback if raw file is already a small JPEG/PNG/WebP/GIF under 240k chars
    const rawUrl = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    });
    if (
      rawUrl.length >= 30 &&
      rawUrl.length <= 345000 &&
      /^data:image\/(jpeg|jpg|png|webp|gif);base64,/.test(rawUrl)
    ) {
      return {
        dataUrl: rawUrl,
        mimeType: file.type || 'image/jpeg',
        fileName,
      };
    }

    throw firstErr instanceof Error
      ? firstErr
      : new Error('Gagal memproses foto/file. Coba ambil foto sekali lagi.');
  }
}

export interface StoreHoursTemplatePreset {
  id: string;
  name: string;
  badge: string;
  description: string;
  values: Pick<
    StoreHoursConfig,
    | 'enabled'
    | 'mode'
    | 'openTime'
    | 'closeTime'
    | 'openDaysText'
    | 'openNotice'
    | 'closedTitle'
    | 'closedMessage'
    | 'blockCheckoutWhenClosed'
  >;
}

export const DEFAULT_STORE_HOURS_CONFIG: StoreHoursConfig = {
  id: 'hours',
  enabled: true,
  mode: 'force_open',
  openTime: '00:00',
  closeTime: '23:59',
  timezoneLabel: 'WIB',
  openDaysText: 'Setiap Hari · Buka 24 Jam Tanpa Tutup',
  blockCheckoutWhenClosed: false,
  closedTitle: 'Toko Buka 24 Jam Nonstop',
  closedMessage:
    'Toko melayani pesanan 24 jam nonstop setiap hari tanpa tutup.',
  openNotice: 'Buka 24 Jam Nonstop Tanpa Tutup · Siap Antar Cepat (Free Delivery)',
  updatedBy: BOOTSTRAPPED_ADMIN_EMAIL,
};

export const STORE_HOURS_TEMPLATES: StoreHoursTemplatePreset[] = [
  {
    id: 'open_24h',
    name: 'Buka 24 Jam Tanpa Tutup (Aktif)',
    badge: '24 JAM',
    description: 'Toko selalu buka 24 jam nonstop setiap hari tanpa pernah tutup.',
    values: {
      enabled: true,
      mode: 'force_open',
      openTime: '00:00',
      closeTime: '23:59',
      openDaysText: 'Setiap Hari · Buka 24 Jam Tanpa Tutup',
      openNotice: 'Buka 24 Jam Nonstop Tanpa Tutup · Pesan Kapan Saja!',
      closedTitle: 'Toko Buka 24 Jam Nonstop',
      closedMessage: 'Toko melayani pesanan 24 jam nonstop setiap hari tanpa tutup.',
      blockCheckoutWhenClosed: false,
    },
  },
  {
    id: 'minimarket_standard',
    name: 'Minimarket Standar',
    badge: '07:00 – 22:00',
    description: 'Buka pagi sampai malam setiap hari, cocok untuk toko harian.',
    values: {
      enabled: true,
      mode: 'auto',
      openTime: '07:00',
      closeTime: '22:00',
      openDaysText: 'Setiap Hari (Senin - Minggu)',
      openNotice: 'Buka Setiap Hari 07:00 – 22:00 · Free Delivery',
      closedTitle: 'Toko Sedang Tutup',
      closedMessage:
        'Kami buka kembali pukul 07:00. Terima kasih sudah berbelanja!',
      blockCheckoutWhenClosed: false,
    },
  },
  {
    id: 'morning_midnight',
    name: 'Pagi – Tengah Malam',
    badge: '08:00 – 00:00',
    description: 'Jam operasional panjang dari pagi hingga tengah malam.',
    values: {
      enabled: true,
      mode: 'auto',
      openTime: '08:00',
      closeTime: '00:00',
      openDaysText: 'Setiap Hari (Senin - Minggu)',
      openNotice: 'Buka 08:00 – 00:00 · Pengiriman Cepat ke Lokasi Anda',
      closedTitle: 'Toko Sedang Tutup (Buka Pukul 08:00)',
      closedMessage:
        'Layanan pengantaran malam telah berakhir. Kami siap melayani kembali mulai pukul 08:00.',
      blockCheckoutWhenClosed: false,
    },
  },
  {
    id: 'late_night_shift',
    name: 'Siang – Larut Malam',
    badge: '10:00 – 02:00',
    description: 'Cocok untuk layanan pesan antar hingga dini hari.',
    values: {
      enabled: true,
      mode: 'auto',
      openTime: '10:00',
      closeTime: '02:00',
      openDaysText: 'Setiap Hari (10:00 - 02:00)',
      openNotice: 'Buka Siang hingga Dini Hari (10:00 – 02:00)',
      closedTitle: 'Toko Tutup · Buka Pukul 10:00',
      closedMessage:
        'Jam operasional kami pukul 10:00 – 02:00. Silakan kunjungi kami kembali saat buka.',
      blockCheckoutWhenClosed: false,
    },
  },
  {
    id: 'weekday_schedule',
    name: 'Senin – Sabtu (Reguler)',
    badge: '08:00 – 21:00',
    description: 'Jadwal standar toko harian Senin sampai Sabtu.',
    values: {
      enabled: true,
      mode: 'auto',
      openTime: '08:00',
      closeTime: '21:00',
      openDaysText: 'Senin - Sabtu (Minggu Libur)',
      openNotice: 'Buka Senin – Sabtu pukul 08:00 – 21:00',
      closedTitle: 'Toko Sedang Tutup',
      closedMessage:
        'Kami melayani setiap Senin – Sabtu pukul 08:00 – 21:00. Pesanan di luar jam operasional diproses saat buka.',
      blockCheckoutWhenClosed: false,
    },
  },
  {
    id: 'temporary_closed',
    name: 'Tutup Sementara / Libur',
    badge: 'TUTUP',
    description: 'Aktifkan status tutup langsung (misal saat libur atau istirahat).',
    values: {
      enabled: true,
      mode: 'force_closed',
      openTime: '08:00',
      closeTime: '22:00',
      openDaysText: 'Sedang Tutup Sementara',
      openNotice: 'Toko sedang tutup sementara',
      closedTitle: 'Toko Sedang Tutup Sementara',
      closedMessage:
        'Mohon maaf, saat ini toko sedang tutup sementara / libur. Kami akan segera buka kembali.',
      blockCheckoutWhenClosed: true,
    },
  },
];

const TIME_HHMM_REGEX = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export function mergeStoreHoursConfig(
  raw?: Partial<StoreHoursConfig> | null
): StoreHoursConfig {
  const mode: StoreHoursMode =
    raw?.mode === 'auto' ||
    raw?.mode === 'force_open' ||
    raw?.mode === 'force_closed'
      ? raw.mode
      : DEFAULT_STORE_HOURS_CONFIG.mode;

  return {
    ...DEFAULT_STORE_HOURS_CONFIG,
    enabled:
      typeof raw?.enabled === 'boolean'
        ? raw.enabled
        : DEFAULT_STORE_HOURS_CONFIG.enabled,
    mode,
    openTime:
      typeof raw?.openTime === 'string' && TIME_HHMM_REGEX.test(raw.openTime)
        ? raw.openTime
        : DEFAULT_STORE_HOURS_CONFIG.openTime,
    closeTime:
      typeof raw?.closeTime === 'string' && TIME_HHMM_REGEX.test(raw.closeTime)
        ? raw.closeTime
        : DEFAULT_STORE_HOURS_CONFIG.closeTime,
    timezoneLabel:
      typeof raw?.timezoneLabel === 'string' && raw.timezoneLabel.trim().length >= 2
        ? raw.timezoneLabel.trim().slice(0, 16)
        : DEFAULT_STORE_HOURS_CONFIG.timezoneLabel,
    openDaysText:
      typeof raw?.openDaysText === 'string' && raw.openDaysText.trim().length >= 2
        ? raw.openDaysText.trim().slice(0, 60)
        : DEFAULT_STORE_HOURS_CONFIG.openDaysText,
    blockCheckoutWhenClosed:
      typeof raw?.blockCheckoutWhenClosed === 'boolean'
        ? raw.blockCheckoutWhenClosed
        : DEFAULT_STORE_HOURS_CONFIG.blockCheckoutWhenClosed,
    closedTitle:
      typeof raw?.closedTitle === 'string' && raw.closedTitle.trim().length >= 2
        ? raw.closedTitle.trim().slice(0, 80)
        : DEFAULT_STORE_HOURS_CONFIG.closedTitle,
    closedMessage:
      typeof raw?.closedMessage === 'string'
        ? raw.closedMessage.trim().slice(0, 240)
        : DEFAULT_STORE_HOURS_CONFIG.closedMessage,
    openNotice:
      typeof raw?.openNotice === 'string'
        ? raw.openNotice.trim().slice(0, 160)
        : DEFAULT_STORE_HOURS_CONFIG.openNotice,
    updatedBy:
      typeof raw?.updatedBy === 'string' && raw.updatedBy.trim().length >= 2
        ? raw.updatedBy.trim()
        : DEFAULT_STORE_HOURS_CONFIG.updatedBy,
    updatedAt: raw?.updatedAt ?? null,
  };
}

export function formatStoreHoursLabel(_hours?: StoreHoursConfig): string {
  return 'Buka 24 Jam Nonstop · Tanpa Tutup';
}

export function evaluateStoreOpenStatus(
  _hours?: StoreHoursConfig,
  _now: Date = new Date()
): {
  isOpen: boolean;
  statusLabel: string;
  scheduleSummary: string;
} {
  // Store operates 24/7 nonstop without closing or blocking checkout
  return {
    isOpen: true,
    statusLabel: 'BUKA 24 JAM',
    scheduleSummary: 'Buka 24 Jam Nonstop · Tanpa Tutup',
  };
}

export const DEFAULT_BACKGROUND_IMAGE_URL = '/assets/aistudio/ALPA_17db3f6e.jpg';

export interface BackgroundPresetOption {
  id: string;
  label: string;
  description: string;
  imageUrl: string;
  recommendedMode: BackgroundDisplayMode;
  recommendedOpacity: number;
}

export const BACKGROUND_IMAGE_PRESETS: BackgroundPresetOption[] = [
  {
    id: 'preset_alpamart_trimulia',
    label: 'AlpaMart TriMulia (Default)',
    description: 'Logo resmi AlpaMart TriMulia (Khmer & Latin)',
    imageUrl: DEFAULT_BACKGROUND_IMAGE_URL,
    recommendedMode: 'watermark_center',
    recommendedOpacity: 20,
  },
  {
    id: 'preset_alpamart_classic',
    label: 'Logo ALPAMART Klasik',
    description: 'Logo emblem ALPAMART merah & biru',
    imageUrl: DEFAULT_STORE_LOGO_URL,
    recommendedMode: 'watermark_center',
    recommendedOpacity: 15,
  },
  {
    id: 'preset_minimarket_rak',
    label: 'Suasana Toko Minimarket',
    description: 'Latar belakang foto rak belanja minimarket',
    imageUrl: bannerPromoBelanjaImg,
    recommendedMode: 'cover',
    recommendedOpacity: 15,
  },
];

export const DEFAULT_STORE_BACKGROUND_CONFIG: StoreBackgroundConfig = {
  id: 'background',
  imageUrl: DEFAULT_BACKGROUND_IMAGE_URL,
  displayMode: 'watermark_center',
  opacity: 20,
  enabled: true,
  updatedBy: BOOTSTRAPPED_ADMIN_EMAIL,
  updatedAt: null,
};

export function clampBackgroundOpacity(value: unknown, fallback = 20): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const clamped = Math.min(85, Math.max(5, Math.round(num / 5) * 5));
  return clamped;
}

export function mergeStoreBackgroundConfig(
  raw?: Partial<StoreBackgroundConfig> | null
): StoreBackgroundConfig {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_STORE_BACKGROUND_CONFIG };
  }

  const displayMode: BackgroundDisplayMode =
    raw.displayMode === 'watermark_center' ||
    raw.displayMode === 'watermark_tile' ||
    raw.displayMode === 'cover'
      ? raw.displayMode
      : DEFAULT_STORE_BACKGROUND_CONFIG.displayMode;

  const rawImg = typeof raw.imageUrl === 'string' ? raw.imageUrl.trim() : undefined;
  const safeImageUrl =
    rawImg === undefined
      ? DEFAULT_STORE_BACKGROUND_CONFIG.imageUrl
      : rawImg === '' ||
          rawImg.startsWith('https://') ||
          rawImg.startsWith('/') ||
          /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(rawImg)
        ? rawImg
        : DEFAULT_STORE_BACKGROUND_CONFIG.imageUrl;

  return {
    ...DEFAULT_STORE_BACKGROUND_CONFIG,
    id: 'background',
    imageUrl: safeImageUrl,
    displayMode,
    opacity: clampBackgroundOpacity(
      raw.opacity,
      DEFAULT_STORE_BACKGROUND_CONFIG.opacity
    ),
    enabled:
      typeof raw.enabled === 'boolean'
        ? raw.enabled
        : DEFAULT_STORE_BACKGROUND_CONFIG.enabled,
    updatedBy:
      typeof raw.updatedBy === 'string' && raw.updatedBy.trim().length >= 2
        ? raw.updatedBy.trim().slice(0, 128)
        : DEFAULT_STORE_BACKGROUND_CONFIG.updatedBy,
    updatedAt: raw.updatedAt ?? null,
  };
}




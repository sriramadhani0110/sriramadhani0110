import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Banknote,
  Camera,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  ExternalLink,
  Image as ImageIcon,
  LocateFixed,
  MapPin,
  Minus,
  Plus,
  QrCode,
  Send,
  Share2,
  ShoppingBag,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { User } from 'firebase/auth';
import {
  doc,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore';
import type {
  CartItem,
  CurrencyCode,
  Order,
  PaymentMethod,
  Promotion,
  ShippingMethod,
  StoreCheckoutConfig,
  StoreHoursConfig,
  StoreMasterConfig,
} from '../types/marketplace';
import { FIELD_LIMITS } from '../types/marketplace';
import {
  db,
  isQuotaOrResourceExhaustedError,
} from '../lib/firebase';
import {
  computePromoForProduct,
  DEFAULT_DELIVERY_FEED_KEY,
  formatAmountByCurrency,
  generateGuestOrderId,
  generateOrderNumber,
  getEffectiveProductStock,
  getGuestProfileDraft,
  getOrCreateGuestCustomerId,
  isProductExpiredByPromo,
  normalizeProductUnit,
  saveGuestOrderRef,
  saveGuestProfileDraft,
  STORE_LINK,
} from '../lib/catalogSeed';
import {
  compressImageFileToDataUrl,
  convertPrimaryToSecondary,
  DEFAULT_CHECKOUT_CONFIG,
  DEFAULT_MASTER_CONFIG,
  DEFAULT_STORE_HOURS_CONFIG,
  evaluateStoreOpenStatus,
  formatPrimaryAmount,
  formatSecondaryAmount,
  THEME_ACCENT_STYLES,
} from '../lib/storeDefaults';
import { AbaPayQrCard } from './AbaPayQrCard';
import { ProductImage } from './ProductImage';
import type { ActivePage } from './Navbar';

interface CartCheckoutDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  cart: CartItem[];
  promotions: Promotion[];
  checkoutConfig?: StoreCheckoutConfig;
  masterConfig?: StoreMasterConfig;
  storeHoursConfig?: StoreHoursConfig;
  onUpdateQty: (productId: string, qty: number) => void;
  onRemoveItem: (productId: string) => void;
  onClearCart: () => void;
  user: User | null;
  isAdmin?: boolean;
  isDelivery?: boolean;
  onNavigate: (page: ActivePage) => void;
}

interface TelegramContactValidation {
  valid: boolean;
  normalized: string;
  kind: 'username' | 'phone' | 'empty' | 'invalid';
  message: string;
  directLink?: string;
}

const FAKE_TELEGRAM_HANDLES = new Set([
  'admin',
  'test1',
  'testing',
  'aaaaa',
  '12345',
  'qwerty',
  'asdfg',
  'telegram',
  'username',
  'namaanda',
  'contoh',
  'tidakada',
  'kosong',
]);

function validateCustomerTelegramContact(raw: string): TelegramContactValidation {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      valid: false,
      normalized: '',
      kind: 'empty',
      message:
        'Masukkan @username Telegram aktif (minimal 5 huruf/angka, contoh: @budi_santoso) atau nomor HP yang terdaftar di Telegram (contoh: +85512345678 / 081234567890).',
    };
  }

  // Reject email addresses mistakenly typed as Telegram
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return {
      valid: false,
      normalized: trimmed,
      kind: 'invalid',
      message:
        'Ini terlihat seperti alamat email, bukan akun Telegram. Masukkan @username Telegram (contoh: @budi_santoso) atau nomor HP Telegram Anda.',
    };
  }

  // 1. Check Telegram URL (https://t.me/username or t.me/username) or @username
  const urlMatch = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/([a-zA-Z0-9_]+)\/?$/i
  );
  const rawHandle = urlMatch
    ? urlMatch[1]
    : trimmed.startsWith('@')
      ? trimmed.slice(1).trim()
      : '';

  if (urlMatch || trimmed.startsWith('@')) {
    const validHandle =
      /^[a-zA-Z][a-zA-Z0-9_]{3,30}[a-zA-Z0-9]$/.test(rawHandle) &&
      !rawHandle.includes('__') &&
      !FAKE_TELEGRAM_HANDLES.has(rawHandle.toLowerCase());

    if (!validHandle) {
      return {
        valid: false,
        normalized: trimmed,
        kind: 'invalid',
        message:
          'Username Telegram belum valid. Harus diawali huruf, minimal 5–32 karakter (hanya huruf, angka, atau garis bawah _), tanpa spasi. Contoh: @budi_santoso',
      };
    }

    const normalized = `@${rawHandle}`;
    return {
      valid: true,
      normalized,
      kind: 'username',
      message: `Telegram valid (${normalized}) — Admin & kurir dapat langsung menghubungi Anda di Telegram.`,
      directLink: `https://t.me/${rawHandle}`,
    };
  }

  // 2. Check phone number registered on Telegram (digits only, optional leading +, spaces/dashes/parens)
  if (/^\+?[\d\s().-]+$/.test(trimmed)) {
    const hasPlus = trimmed.startsWith('+');
    const digits = trimmed.replace(/\D/g, '');
    const allSameDigit = /^(\d)\1+$/.test(digits);
    const isTrivialSequence =
      digits === '12345678' ||
      digits === '123456789' ||
      digits === '1234567890' ||
      digits === '0123456789';

    if (digits.length < 8 || digits.length > 15 || allSameDigit || isTrivialSequence) {
      return {
        valid: false,
        normalized: trimmed,
        kind: 'invalid',
        message:
          'Nomor HP Telegram belum valid (harus 8–15 angka aktif, bukan angka acak/berulang). Contoh: +85512345678 atau 081234567890.',
      };
    }

    const normalized = hasPlus ? `+${digits}` : digits;
    return {
      valid: true,
      normalized,
      kind: 'phone',
      message: `Nomor Telegram valid (${normalized}) — Admin & kurir dapat langsung konfirmasi ke Telegram Anda.`,
    };
  }

  // 3. Bare handle without @ (if it clearly looks like a real Telegram username with 5–32 valid chars)
  if (
    /^[a-zA-Z][a-zA-Z0-9_]{3,30}[a-zA-Z0-9]$/.test(trimmed) &&
    !trimmed.includes('__') &&
    !FAKE_TELEGRAM_HANDLES.has(trimmed.toLowerCase())
  ) {
    const normalized = `@${trimmed}`;
    return {
      valid: true,
      normalized,
      kind: 'username',
      message: `Telegram valid (otomatis disimpan sebagai ${normalized}) — Admin dapat langsung chat di Telegram.`,
      directLink: `https://t.me/${trimmed}`,
    };
  }

  return {
    valid: false,
    normalized: trimmed,
    kind: 'invalid',
    message:
      'Format Telegram tidak valid! Masukkan @username Telegram (minimal 5 huruf/angka, contoh: @budi_santoso) atau nomor HP aktif Telegram (8–15 angka, contoh: +85512345678).',
  };
}

export function CartCheckoutDrawer({
  isOpen,
  onClose,
  cart,
  promotions,
  checkoutConfig,
  masterConfig,
  storeHoursConfig,
  onUpdateQty,
  onRemoveItem,
  onClearCart,
  user,
  isAdmin = false,
  isDelivery = false,
  onNavigate,
}: CartCheckoutDrawerProps) {
  const activeConfig = checkoutConfig || DEFAULT_CHECKOUT_CONFIG;
  const master = masterConfig || DEFAULT_MASTER_CONFIG;
  const activeHours = storeHoursConfig || DEFAULT_STORE_HOURS_CONFIG;
  const storeOpenStatus = evaluateStoreOpenStatus(activeHours);
  const checkoutBlockedByHours =
    activeHours.enabled &&
    !storeOpenStatus.isOpen &&
    activeHours.blockCheckoutWhenClosed;
  const effectiveMaster: StoreMasterConfig = {
    ...master,
    exchangeRate:
      master.exchangeRate > 0
        ? master.exchangeRate
        : activeConfig.exchangeRateKhr || DEFAULT_MASTER_CONFIG.exchangeRate,
  };
  const theme =
    THEME_ACCENT_STYLES[effectiveMaster.themeAccent] || THEME_ACCENT_STYLES.blue_red;
  const primaryCurrency: CurrencyCode = effectiveMaster.primaryCurrencyCode;
  const secondaryCurrency: CurrencyCode = effectiveMaster.secondaryCurrencyCode;
  const primarySymbol = effectiveMaster.primaryCurrencySymbol;
  const secondarySymbol = effectiveMaster.secondaryCurrencySymbol;

  const [step, setStep] = useState<'cart' | 'checkout' | 'success'>('cart');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [manualAddress, setManualAddress] = useState('');
  const [manualMapLink, setManualMapLink] = useState('');
  const [locationCoords, setLocationCoords] = useState('');
  const [locationUrl, setLocationUrl] = useState('');
  const [locationImageUrl, setLocationImageUrl] = useState('');
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoFeedback, setPhotoFeedback] = useState<string | null>(null);
  const [locatingGps, setLocatingGps] = useState(false);
  const [autoLocatingNetwork, setAutoLocatingNetwork] = useState(false);
  const [autoLocationLabel, setAutoLocationLabel] = useState('');
  const [autoLocationSource, setAutoLocationSource] = useState<'none' | 'network' | 'gps' | 'manual'>('none');
  const [geoFeedback, setGeoFeedback] = useState<string | null>(null);
  const [gpsFailedOrDenied, setGpsFailedOrDenied] = useState(false);
  const [telegramInvalidHighlight, setTelegramInvalidHighlight] = useState(false);
  const telegramInputRef = useRef<HTMLInputElement | null>(null);
  const autoLocationAttemptedRef = useRef(false);
  const [shippingMethod] = useState<ShippingMethod>('FREE DELIVERY');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>(null);
  const [paymentMissingHighlight, setPaymentMissingHighlight] = useState(false);
  const [notes, setNotes] = useState('');
  const [transferProofImageUrl, setTransferProofImageUrl] = useState('');
  const [transferProofFile, setTransferProofFile] = useState<File | null>(null);
  const [uploadingTransferProof, setUploadingTransferProof] = useState(false);
  const [transferProofError, setTransferProofError] = useState<string | null>(null);
  const [transferProofFeedback, setTransferProofFeedback] = useState<string | null>(null);
  const [transferProofMissingHighlight, setTransferProofMissingHighlight] = useState(false);
  const [autoCheckoutOnProof, setAutoCheckoutOnProof] = useState(true);
  const [botProofStatus, setBotProofStatus] = useState<
    'idle' | 'sending' | 'sent' | 'manual_needed'
  >('idle');
  const [sharingProof, setSharingProof] = useState(false);
  const [proofActionFeedback, setProofActionFeedback] = useState<string | null>(null);
  const transferProofBoxRef = useRef<HTMLDivElement | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const drawerBodyRef = useRef<HTMLDivElement | null>(null);
  const [quotaFallbackActive, setQuotaFallbackActive] = useState(false);
  const [copiedFallbackMsg, setCopiedFallbackMsg] = useState(false);
  const [completedOrder, setCompletedOrder] = useState<
    (Pick<
      Order,
      | 'id'
      | 'orderNumber'
      | 'totalAmount'
      | 'paymentMethod'
      | 'currency'
      | 'shippingMethod'
      | 'locationCoords'
      | 'locationUrl'
      | 'notes'
    > & {
      customerName: string;
      customerPhone: string;
      manualAddress?: string;
      transferProofImageUrl?: string;
      transferProofFile?: File | null;
      itemsSummary: Array<{ name: string; quantity: number; unit: string }>;
    }) | null
  >(null);
  const [telegramRedirectTriggered, setTelegramRedirectTriggered] = useState(false);
  const [copiedTelegramMsg, setCopiedTelegramMsg] = useState(false);
  const telegramAutoLinkRef = useRef<HTMLAnchorElement | null>(null);
  const [draftPaymentRef, setDraftPaymentRef] = useState<string>(() =>
    `PAY-USD-${Math.floor(100000 + Math.random() * 900000)}`
  );

  useEffect(() => {
    if (!isOpen) return;
    if (cart.length === 0 && step === 'checkout') {
      setStep('cart');
    }
    if (cart.length > 0 && step === 'success') {
      setStep('cart');
      setCompletedOrder(null);
      setPaymentMethod(null);
      setPaymentMissingHighlight(false);
    }
  }, [isOpen, cart.length, step]);

  useEffect(() => {
    if (isOpen && step === 'checkout') {
      setDraftPaymentRef(`PAY-USD-${Math.floor(100000 + Math.random() * 900000)}`);
    }
  }, [isOpen, step]);

  // Automatically trigger mandatory Telegram confirmation link right after checkout completes
  useEffect(() => {
    if (step !== 'success' || !completedOrder || telegramRedirectTriggered) return;
    setTelegramRedirectTriggered(true);
    const timer = window.setTimeout(() => {
      telegramAutoLinkRef.current?.click();
    }, 350);
    return () => window.clearTimeout(timer);
  }, [step, completedOrder, telegramRedirectTriggered]);

  // Load saved local customer draft (no email/login needed)
  useEffect(() => {
    if (!isOpen) return;
    const draft = getGuestProfileDraft();
    if (draft) {
      if (draft.name) setCustomerName((prev) => prev || draft.name);
      if (draft.phone) setCustomerPhone((prev) => prev || draft.phone);
      if (draft.locationCoords) {
        setLocationCoords((prev) => prev || draft.locationCoords);
        setAutoLocationSource((prev) => (prev === 'none' ? 'gps' : prev));
      }
      if (draft.locationUrl)
        setLocationUrl((prev) => prev || draft.locationUrl);
    }
  }, [isOpen]);

  // Zero-permission automatic customer location detection on checkout open:
  // 1) If browser GPS permission was ALREADY granted previously, silently grab exact GPS (zero popup).
  // 2) Simultaneously detect approximate network/IP coordinates + Maps link with ZERO permission prompt
  //    so iPhone, Android & PC customers immediately have a valid location ready for checkout.
  useEffect(() => {
    if (!isOpen || step !== 'checkout') return;
    if (locationCoords || locationUrl) return;
    if (autoLocationAttemptedRef.current) return;
    autoLocationAttemptedRef.current = true;

    let cancelled = false;
    setAutoLocatingNetwork(true);

    const applyDetectedCoords = (
      lat: string,
      lng: string,
      source: 'network' | 'gps',
      label = ''
    ) => {
      if (cancelled) return;
      const coords = `${lat}, ${lng}`;
      const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;
      setLocationCoords((prev) => (source === 'gps' || !prev ? coords : prev));
      setLocationUrl((prev) => (source === 'gps' || !prev ? mapsUrl : prev));
      setAutoLocationSource((prev) => (prev === 'gps' ? 'gps' : source));
      if (label) {
        setAutoLocationLabel(label);
      }
      setGpsFailedOrDenied(false);
    };

    const runSilentAutoLocation = async () => {
      // A. Silent GPS ONLY if permission is already 'granted' (never triggers popup!)
      try {
        if (
          typeof navigator !== 'undefined' &&
          navigator.permissions &&
          typeof navigator.permissions.query === 'function' &&
          navigator.geolocation
        ) {
          const perm = await navigator.permissions.query({
            name: 'geolocation' as PermissionName,
          });
          if (perm.state === 'granted' && !cancelled) {
            navigator.geolocation.getCurrentPosition(
              (pos) => {
                applyDetectedCoords(
                  pos.coords.latitude.toFixed(6),
                  pos.coords.longitude.toFixed(6),
                  'gps',
                  'Titik GPS Akurat'
                );
              },
              () => {
                // Silent ignore — network location below handles fallback
              },
              { enableHighAccuracy: false, timeout: 4500, maximumAge: 300000 }
            );
          }
        }
      } catch {
        // Permissions API unsupported (e.g. older iOS Safari) — proceed to zero-permission network location
      }

      // B. Zero-permission automatic network location (server route -> static Netlify GeoJS fallback)
      const tryFetchJson = async (url: string): Promise<Record<string, unknown> | null> => {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = window.setTimeout(() => controller?.abort(), 4500);
        try {
          const res = await fetch(url, {
            cache: 'no-store',
            headers: { Accept: 'application/json' },
            signal: controller?.signal,
          });
          if (!res.ok) return null;
          const ct = (res.headers.get('content-type') || '').toLowerCase();
          if (!ct.includes('application/json')) return null;
          return (await res.json()) as Record<string, unknown>;
        } catch {
          return null;
        } finally {
          window.clearTimeout(timer);
        }
      };

      try {
        const serverGeo = await tryFetchJson('/api/location/approx');
        if (
          serverGeo &&
          serverGeo.ok === true &&
          typeof serverGeo.lat === 'string' &&
          typeof serverGeo.lng === 'string'
        ) {
          applyDetectedCoords(
            serverGeo.lat,
            serverGeo.lng,
            'network',
            typeof serverGeo.label === 'string' ? serverGeo.label : ''
          );
          return;
        }

        // Static Netlify / direct browser fallback (HTTPS GeoJS, no API key, zero popup)
        const directGeo = await tryFetchJson('https://get.geojs.io/v1/ip/geo.json');
        if (directGeo) {
          const latNum = Number(directGeo.latitude);
          const lngNum = Number(directGeo.longitude);
          if (Number.isFinite(latNum) && Number.isFinite(lngNum)) {
            const label = [directGeo.city, directGeo.region, directGeo.country]
              .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
              .slice(0, 3)
              .join(', ');
            applyDetectedCoords(
              latNum.toFixed(6),
              lngNum.toFixed(6),
              'network',
              label
            );
          }
        }
      } finally {
        if (!cancelled) {
          setAutoLocatingNetwork(false);
        }
      }
    };

    void runSilentAutoLocation();

    return () => {
      cancelled = true;
    };
  }, [isOpen, step, locationCoords, locationUrl]);

  const telegramValidation = useMemo(
    () => validateCustomerTelegramContact(customerPhone),
    [customerPhone]
  );

  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!isOpen) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [isOpen]);

  const activeCurrency: CurrencyCode =
    paymentMethod === 'CASH' ? secondaryCurrency : primaryCurrency;
  const activeCurrencySymbol =
    paymentMethod === 'CASH' ? secondarySymbol : primarySymbol;
  const isUsingSecondary = paymentMethod === 'CASH';

  const subtotalUsd = cart.reduce((sum, item) => {
    const promoInfo = computePromoForProduct(item.product, item.quantity, promotions, nowMs);
    return sum + promoInfo.lineTotalUsd;
  }, 0);
  const minOrderUsd = activeConfig.minOrderUsd || 0;
  const belowMinOrder = minOrderUsd > 0 && subtotalUsd + 0.001 < minOrderUsd;
  const shippingUsd = cart.length > 0 ? activeConfig.shippingCostUsd || 0 : 0;
  const totalUsd = subtotalUsd + shippingUsd;

  const displaySubtotal = isUsingSecondary
    ? convertPrimaryToSecondary(subtotalUsd, effectiveMaster)
    : subtotalUsd;
  const displayShipping = isUsingSecondary
    ? convertPrimaryToSecondary(shippingUsd, effectiveMaster)
    : shippingUsd;
  const displayTotal = isUsingSecondary
    ? convertPrimaryToSecondary(totalUsd, effectiveMaster)
    : totalUsd;

  const activeStoreLink =
    effectiveMaster.permanentStoreUrl?.trim()
      ? effectiveMaster.permanentStoreUrl.trim().replace(/^https?:\/\//i, '')
      : STORE_LINK;

  const usdQrPayload = useMemo(() => {
    const params = new URLSearchParams({
      bank: activeConfig.paymentProviderName,
      network: activeConfig.paymentNetwork,
      merchant: activeConfig.merchantName,
      holder: activeConfig.accountHolder,
      account: activeConfig.accountNumber,
      store: activeStoreLink,
      currency: primaryCurrency,
      amount: totalUsd.toFixed(2),
      shipping: shippingMethod,
      items: String(cart.reduce((sum, item) => sum + item.quantity, 0)),
      ref: draftPaymentRef,
    });
    return `https://pay.ababank.com/khqr?${params.toString()}`;
  }, [totalUsd, shippingMethod, cart, draftPaymentRef, activeConfig, primaryCurrency, activeStoreLink]);

  const confirmedQrPayload = useMemo(() => {
    if (!completedOrder || completedOrder.paymentMethod !== 'QR') return '';
    const params = new URLSearchParams({
      bank: activeConfig.paymentProviderName,
      network: activeConfig.paymentNetwork,
      merchant: activeConfig.merchantName,
      holder: activeConfig.accountHolder,
      account: activeConfig.accountNumber,
      store: activeStoreLink,
      currency: completedOrder.currency,
      amount: completedOrder.totalAmount.toFixed(2),
      order: completedOrder.orderNumber,
      shipping: completedOrder.shippingMethod,
    });
    return `https://pay.ababank.com/khqr?${params.toString()}`;
  }, [completedOrder, activeConfig, activeStoreLink]);

  if (!isOpen) return null;

  const extractCoordsFromMapInput = (raw: string): string => {
    const m1 = raw.match(/@(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)/);
    if (m1) return `${Number(m1[1]).toFixed(6)}, ${Number(m1[2]).toFixed(6)}`;
    const m2 = raw.match(/[?&](?:q|query|ll)=(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)/i);
    if (m2) return `${Number(m2[1]).toFixed(6)}, ${Number(m2[2]).toFixed(6)}`;
    const m3 = raw.match(/^\s*(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/);
    if (m3) return `${Number(m3[1]).toFixed(6)}, ${Number(m3[2]).toFixed(6)}`;
    return '';
  };

  const handleManualMapLinkChange = (val: string) => {
    setManualMapLink(val);
    const trimmed = val.trim();
    const parsedCoords = extractCoordsFromMapInput(trimmed);
    if (parsedCoords) {
      setLocationCoords(parsedCoords);
      if (trimmed.startsWith('https://')) {
        setLocationUrl(trimmed.slice(0, FIELD_LIMITS.LOCATION_URL_MAX));
      } else {
        const [lat, lng] = parsedCoords.split(',').map((s) => s.trim());
        setLocationUrl(`https://www.google.com/maps?q=${lat},${lng}`);
      }
      setErrorMsg(null);
      return;
    }
    if (/^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|www\.google\.com\/maps|maps\.google\.com)\//i.test(trimmed)) {
      setLocationUrl(trimmed.slice(0, FIELD_LIMITS.LOCATION_URL_MAX));
      setErrorMsg(null);
    } else if (!trimmed) {
      setLocationUrl('');
    }
  };

  const handleDetectLocation = () => {
    setGeoFeedback(null);
    setErrorMsg(null);

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsFailedOrDenied(true);
      setGeoFeedback(
        'Browser ini tidak mendukung deteksi GPS otomatis. Silakan isi Alamat / Patokan atau tempel link Google Maps di bawah agar tetap bisa langsung checkout.'
      );
      return;
    }

    const ua = navigator.userAgent || '';
    const isIos =
      /iPhone|iPad|iPod/i.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/i.test(ua);
    const isMobile = isIos || isAndroid;
    let isEmbeddedIframe = false;
    try {
      isEmbeddedIframe = window.self !== window.top;
    } catch {
      isEmbeddedIframe = true;
    }

    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      window.clearTimeout(hardTimeoutId);
      setLocatingGps(false);
      return true;
    };

    const onSuccess = (pos: GeolocationPosition) => {
      if (!finish()) return;
      const lat = pos.coords.latitude.toFixed(6);
      const lng = pos.coords.longitude.toFixed(6);
      const coords = `${lat}, ${lng}`;
      const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;
      setLocationCoords(coords);
      setLocationUrl(mapsUrl);
      setAutoLocationSource('gps');
      setAutoLocationLabel('Titik GPS Akurat');
      setGpsFailedOrDenied(false);
      setGeoFeedback(
        'Lokasi GPS akurat berhasil ditangkap dan akan otomatis masuk ke akun Admin serta akun Delivery.'
      );
    };

    const onFinalError = (err: { code?: number; message?: string }) => {
      if (!finish()) return;
      setGpsFailedOrDenied(true);
      const isPermissionDenied = err?.code === 1;
      const isPolicyBlocked =
        isPermissionDenied &&
        /permissions policy|disallowed|origin|secure/i.test(err?.message || '');

      if (isPolicyBlocked || (isPermissionDenied && isEmbeddedIframe)) {
        setGeoFeedback(
          'Browser memblokir izin lokasi karena halaman dibuka di dalam jendela pratinjau (iframe). Buka langsung link website di tab browser baru, atau langsung isi Alamat / tempel link Google Maps di bawah untuk melanjutkan checkout.'
        );
      } else if (isPermissionDenied) {
        if (isIos) {
          setGeoFeedback(
            'Izin lokasi belum aktif di iPhone/iPad. Buka Pengaturan → Privasi & Keamanan → Layanan Lokasi → Situs Web Safari → pilih "Saat Digunakan", atau langsung isi Alamat / link Google Maps di bawah.'
          );
        } else if (isAndroid) {
          setGeoFeedback(
            'Izin lokasi belum aktif di Android. Ketuk ikon gembok / pengaturan di kiri alamat URL Chrome → Izin → Lokasi → Izinkan, lalu coba lagi — atau langsung isi Alamat / link Google Maps di bawah.'
          );
        } else {
          setGeoFeedback(
            'Izin lokasi di browser PC belum diizinkan. Klik ikon pengaturan/gembok di sebelah kiri alamat URL browser (Chrome/Edge) → Lokasi → Izinkan (Allow) dan pastikan Location Services Windows/Mac aktif — atau langsung isi Alamat / tempel link Google Maps di bawah.'
          );
        }
      } else {
        setGeoFeedback(
          isMobile
            ? 'Sinyal GPS belum tertangkap. Pastikan GPS aktif lalu coba lagi, atau isi Alamat / tempel link Google Maps di bawah agar tetap bisa langsung checkout.'
            : 'Lokasi otomatis di PC belum berhasil terdeteksi. Anda dapat langsung mengisi Alamat / Patokan atau menempelkan link Google Maps di bawah untuk melanjutkan checkout.'
        );
      }
    };

    setLocatingGps(true);
    const hardTimeoutId = window.setTimeout(() => {
      onFinalError({ code: 3, message: 'timeout' });
    }, 14000);

    try {
      // On PC/laptop, network/Wi-Fi geolocation (enableHighAccuracy: false) resolves in ~1s instead of timing out waiting for a GPS chip.
      navigator.geolocation.getCurrentPosition(
        onSuccess,
        (err) => {
          if (settled) return;
          if (err.code === err.PERMISSION_DENIED) {
            onFinalError(err);
            return;
          }
          try {
            navigator.geolocation.getCurrentPosition(onSuccess, onFinalError, {
              enableHighAccuracy: !isMobile,
              timeout: 7000,
              maximumAge: 300000,
            });
          } catch (innerErr) {
            onFinalError({
              code: 1,
              message: innerErr instanceof Error ? innerErr.message : '',
            });
          }
        },
        {
          enableHighAccuracy: isMobile,
          timeout: 6500,
          maximumAge: 120000,
        }
      );
    } catch (syncErr) {
      onFinalError({
        code: 1,
        message: syncErr instanceof Error ? syncErr.message : '',
      });
    }
  };

  const handleSelectLocationPhoto = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setPhotoFeedback(null);
    setUploadingPhoto(true);
    try {
      const dataUrl = await compressImageFileToDataUrl(file, {
        maxWidth: 640,
        maxHeight: 640,
        maxChars: 235000,
        initialQuality: 0.7,
      });
      setLocationImageUrl(dataUrl);
      setPhotoFeedback(
        'Foto lokasi berhasil dilampirkan dan akan otomatis tampil di Admin & Kurir Delivery.'
      );
    } catch (err) {
      setPhotoFeedback(
        err instanceof Error
          ? `${err.message} (Anda tetap dapat checkout tanpa foto.)`
          : 'Gagal memproses foto lokasi. Anda tetap dapat checkout tanpa foto.'
      );
    } finally {
      setUploadingPhoto(false);
    }
  };



  const handleTransferProofUpload = async (file: File | null) => {
    if (!file) return;
    setUploadingTransferProof(true);
    setTransferProofError(null);
    setTransferProofFeedback(null);
    setTransferProofMissingHighlight(false);
    setErrorMsg(null);
    try {
      const compressed = await compressImageFileToDataUrl(file, {
        maxWidth: 960,
        maxHeight: 1280,
        maxChars: 650000,
        initialQuality: 0.8,
      });
      setTransferProofImageUrl(compressed);
      setTransferProofFile(file);

      const cleanNameCheck = customerName.trim();
      const tgCheck = validateCustomerTelegramContact(customerPhone);
      const hasLocationCheck =
        Boolean(locationCoords.trim()) ||
        locationUrl.trim().startsWith('https://') ||
        manualAddress.trim().length >= 4;

      if (
        autoCheckoutOnProof &&
        paymentMethod === 'QR' &&
        !submitting &&
        !checkoutBlockedByHours &&
        !belowMinOrder &&
        cart.length > 0 &&
        cleanNameCheck.length >= FIELD_LIMITS.NAME_MIN &&
        tgCheck.valid &&
        hasLocationCheck
      ) {
        setTransferProofFeedback(
          'Bukti transfer ABA/QR diterima ✓ — otomatis langsung checkout & kirim ke Telegram Pemilik...'
        );
        setUploadingTransferProof(false);
        await executeCheckout({ proofDataUrl: compressed, proofFile: file });
        return;
      }

      setTransferProofFeedback(
        'Bukti transfer ABA/QR terpasang ✓. Pastikan Nama, Telegram valid & Lokasi di bawah sudah terisi lalu klik tombol Checkout.'
      );
    } catch (err) {
      setTransferProofError(
        err instanceof Error
          ? err.message
          : 'Gagal membaca gambar bukti transfer. Pilih file foto/screenshot JPG atau PNG.'
      );
    } finally {
      setUploadingTransferProof(false);
    }
  };

  const executeCheckout = async (override?: {
    proofDataUrl?: string;
    proofFile?: File | null;
  }) => {
    if (submitting) return;
    setErrorMsg(null);
    setQuotaFallbackActive(false);
    setPaymentMissingHighlight(false);
    setTransferProofError(null);
    setTransferProofMissingHighlight(false);

    const failValidation = (msg: string) => {
      setErrorMsg(msg);
      drawerBodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    };

    if (checkoutBlockedByHours) {
      failValidation(
        `${activeHours.closedTitle}. Jam operasional: ${storeOpenStatus.scheduleSummary}. Silakan order kembali saat toko buka.`
      );
      return;
    }

    if (!paymentMethod) {
      setPaymentMissingHighlight(true);
      failValidation(
        `Silakan pilih metode pembayaran terlebih dahulu: klik ${activeConfig.cashTitle} (${secondaryCurrency}) atau ${activeConfig.qrTitle} (${primaryCurrency}).`
      );
      return;
    }

    const effectiveProofUrl = (override?.proofDataUrl ?? transferProofImageUrl).trim();
    const effectiveProofFile =
      override && 'proofFile' in override ? override.proofFile ?? null : transferProofFile;

    if (paymentMethod === 'QR' && !effectiveProofUrl) {
      setTransferProofMissingHighlight(true);
      setTransferProofError(
        'Pembayaran ABA/QR wajib transfer dahulu, lalu unggah foto/screenshot bukti transfer di sini agar pesanan otomatis diproses.'
      );
      setErrorMsg(
        'Wajib transfer ABA/QR dahulu dan unggah bukti transfer sebelum checkout pesanan.'
      );
      window.setTimeout(() => {
        transferProofBoxRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      }, 60);
      return;
    }

    if (belowMinOrder) {
      failValidation(
        `Minimal belanja adalah ${formatPrimaryAmount(minOrderUsd, effectiveMaster)}. Tambahkan produk lagi untuk melanjutkan checkout.`
      );
      return;
    }

    const cleanName = customerName.trim().slice(0, FIELD_LIMITS.NAME_MAX);
    const tgValidation = validateCustomerTelegramContact(customerPhone);
    const cleanPhone = tgValidation.normalized.slice(0, FIELD_LIMITS.PHONE_MAX);
    const cleanManualAddress = (
      manualAddress.trim() ||
      (autoLocationSource === 'network' && autoLocationLabel
        ? `Area otomatis: ${autoLocationLabel}`
        : '')
    ).slice(0, FIELD_LIMITS.ADDRESS_MAX);
    const cleanLocationCoords = locationCoords
      .trim()
      .slice(0, FIELD_LIMITS.LOCATION_COORDS_MAX);
    const cleanLocationUrl = locationUrl.trim().startsWith('https://')
      ? locationUrl.trim().slice(0, FIELD_LIMITS.LOCATION_URL_MAX)
      : '';
    const cleanNotes = notes.trim().slice(0, FIELD_LIMITS.NOTES_MAX);

    if (cleanName.length < FIELD_LIMITS.NAME_MIN) {
      failValidation('Nama penerima wajib diisi (minimal 2 karakter).');
      return;
    }
    if (!tgValidation.valid || cleanPhone.length < FIELD_LIMITS.PHONE_MIN) {
      setTelegramInvalidHighlight(true);
      failValidation(tgValidation.message);
      window.setTimeout(() => {
        telegramInputRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
        telegramInputRef.current?.focus();
      }, 60);
      return;
    }
    setTelegramInvalidHighlight(false);
    if (!cleanLocationCoords && !cleanLocationUrl && cleanManualAddress.length < 4) {
      setGpsFailedOrDenied(true);
      failValidation(
        'Lokasi pengiriman belum terisi. Isi Alamat / Patokan (minimal 4 huruf) atau klik "Perbarui GPS Akurat" agar kurir dapat mengantar pesanan Anda.'
      );
      return;
    }
    if (cart.length === 0 || cart.length > FIELD_LIMITS.MAX_ORDER_ITEMS) {
      failValidation('Jumlah jenis produk dalam keranjang harus antara 1 sampai 20 item.');
      return;
    }

    // Customer checkout NEVER asks for email or Google sign-in — always uses isolated device customer ID
    const effectiveCustomerId = getOrCreateGuestCustomerId();
    const effectiveCustomerEmail = 'tanpa-email@pelanggan.alpamart';
    void isAdmin;
    void isDelivery;

    setSubmitting(true);
    const orderId = generateGuestOrderId();
    const orderNumber = generateOrderNumber();
    const chosenPaymentMethod: PaymentMethod = paymentMethod;
    const orderCurrency: CurrencyCode =
      chosenPaymentMethod === 'CASH' ? secondaryCurrency : primaryCurrency;

    try {
      void user;
      let finalTotal = 0;

      await runTransaction(db, async (tx) => {
        const rosterSnap = await tx.get(doc(db, 'storeMeta', 'deliveryRoster'));
        const activeDeliveryHashes: string[] =
          rosterSnap.exists() && Array.isArray(rosterSnap.data().activeEmailHashes)
            ? rosterSnap
                .data()
                .activeEmailHashes.filter(
                  (h: unknown): h is string =>
                    typeof h === 'string' && h.length === 64
                )
                .slice(0, 20)
            : [];
        const rawFeedKey =
          rosterSnap.exists() && typeof rosterSnap.data().directAccessKey === 'string'
            ? rosterSnap.data().directAccessKey.trim()
            : '';
        const deliveryFeedKey =
          rawFeedKey.length >= 24 ? rawFeedKey : DEFAULT_DELIVERY_FEED_KEY;

        const productDocs: {
          id: string;
          nextStock: number;
          unitPriceUsd: number;
          lineTotalUsd: number;
          unit: ReturnType<typeof normalizeProductUnit>;
          name: string;
          sku: string;
          imageUrl: string;
          qty: number;
        }[] = [];

        const promoAppliedNotes: string[] = [];
        const txNowMs = Date.now();

        for (const item of cart) {
          const safeQty = Math.max(1, Math.trunc(Number(item.quantity)));
          const pRef = doc(db, 'products', item.product.id);
          const pSnap = await tx.get(pRef);
          if (!pSnap.exists()) {
            throw new Error(
              `Produk "${item.product.name}" sedang disiapkan oleh toko. Silakan coba beberapa saat lagi.`
            );
          }
          const pData = pSnap.data();
          if (isProductExpiredByPromo(item.product.id, promotions, txNowMs)) {
            throw new Error(
              `Periode promosi "${pData.name}" telah berakhir sehingga stok otomatis menjadi 0.`
            );
          }

          const currentStock = Math.trunc(Number(pData.stock ?? 0));
          const basePriceUsd = Number(pData.price);
          const itemUnit = normalizeProductUnit(pData.unit || item.product.unit);
          const promoInfo = computePromoForProduct(
            { id: item.product.id, price: basePriceUsd, unit: itemUnit },
            safeQty,
            promotions,
            txNowMs
          );

          if (promoInfo.discountPromo) {
            promoAppliedNotes.push(
              `${pData.name}: Diskon ${promoInfo.discountPromo.discountPercent}%`
            );
          }
          if (promoInfo.comboPromo && promoInfo.comboFreeQty > 0) {
            promoAppliedNotes.push(
              `${pData.name}: Combo Beli ${promoInfo.comboPromo.buyQty} Free ${promoInfo.comboPromo.getQty} (Input ${safeQty} ${itemUnit}, Bayar ${promoInfo.paidQty} ${itemUnit}, Gratis ${promoInfo.comboFreeQty} ${itemUnit})`
            );
          } else if (promoInfo.bogoPromo && promoInfo.bonusFreeQty > 0) {
            promoAppliedNotes.push(
              `${pData.name}: Bonus Gratis ${promoInfo.bonusFreeQty} ${itemUnit} (Buy ${promoInfo.bogoPromo.buyQty} Get ${promoInfo.bogoPromo.getQty})`
            );
          }

          const totalDeductUnits = promoInfo.comboPromo
            ? safeQty
            : currentStock >= safeQty + promoInfo.bonusFreeQty
              ? safeQty + promoInfo.bonusFreeQty
              : safeQty;

          if (currentStock < safeQty) {
            throw new Error(
              `Stok "${pData.name}" tidak mencukupi (tersisa ${currentStock} ${itemUnit}).`
            );
          }

          const effectiveItemUnitUsd =
            promoInfo.comboPromo && promoInfo.comboFreeQty > 0
              ? Math.max(0.01, Number((promoInfo.lineTotalUsd / safeQty).toFixed(2)))
              : promoInfo.effectiveUnitUsd;

          productDocs.push({
            id: item.product.id,
            nextStock: currentStock - totalDeductUnits,
            unitPriceUsd: effectiveItemUnitUsd,
            lineTotalUsd: promoInfo.lineTotalUsd,
            unit: itemUnit,
            name: String(pData.name),
            sku: String(pData.sku),
            imageUrl: String(pData.imageUrl),
            qty: safeQty,
          });
        }

        const verifiedSubtotalUsd = productDocs.reduce(
          (acc, p) => acc + p.lineTotalUsd,
          0
        );

        const useSecondaryForOrder = chosenPaymentMethod === 'CASH';
        const orderSubtotal = useSecondaryForOrder
          ? convertPrimaryToSecondary(verifiedSubtotalUsd, effectiveMaster)
          : Number(verifiedSubtotalUsd.toFixed(2));
        const orderShippingCost = useSecondaryForOrder
          ? convertPrimaryToSecondary(shippingUsd, effectiveMaster)
          : Number(shippingUsd.toFixed(2));
        const orderTotal = Number((orderSubtotal + orderShippingCost).toFixed(2));

        finalTotal = orderTotal;

        const combinedNotes = [
          chosenPaymentMethod === 'QR' && effectiveProofUrl
            ? '[ABA/QR SUDAH TRANSFER · Bukti Terlampir]'
            : '',
          cleanNotes,
          promoAppliedNotes.length > 0
            ? `Promo: ${promoAppliedNotes.join('; ')}`
            : '',
        ]
          .filter(Boolean)
          .join(' | ')
          .slice(0, FIELD_LIMITS.NOTES_MAX);

        const orderItemsPayload = productDocs.map((p) => ({
          productId: p.id,
          name: p.name.slice(0, 120),
          sku: p.sku.slice(0, 40),
          price: useSecondaryForOrder
            ? Math.max(
                1,
                Math.round(
                  convertPrimaryToSecondary(p.lineTotalUsd, effectiveMaster) / p.qty
                )
              )
            : Number(p.unitPriceUsd.toFixed(2)),
          unit: p.unit,
          quantity: p.qty,
          imageUrl: p.imageUrl.startsWith('data:')
            ? '/assets/placeholder-product.svg'
            : p.imageUrl.slice(0, 950),
        }));

        const orderRef = doc(db, 'orders', orderId);
        tx.set(orderRef, {
          id: orderId,
          orderNumber,
          customerId: effectiveCustomerId,
          customerName: cleanName,
          customerEmail: effectiveCustomerEmail,
          customerPhone: cleanPhone,
          shippingAddress: cleanManualAddress,
          city: '',
          postalCode: '',
          locationDetail: '',
          locationCoords: cleanLocationCoords,
          locationUrl: cleanLocationUrl,
          locationImageUrl: activeConfig.allowLocationPhoto
            ? locationImageUrl || ''
            : '',
          paymentMethod: chosenPaymentMethod,
          currency: orderCurrency,
          shippingMethod,
          notes: combinedNotes,
          items: orderItemsPayload,
          subtotal: orderSubtotal,
          shippingCost: orderShippingCost,
          totalAmount: orderTotal,
          trackingNumber: '',
          status: 'pending',
          autoProcessed: false,
          deliveryEmailHashes: activeDeliveryHashes,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        // Automatically publish to 1-Click Delivery Feed (no-email courier view)
        const deliveryFeedRef = doc(
          db,
          'deliveryFeeds',
          deliveryFeedKey,
          'orders',
          orderId
        );
        tx.set(deliveryFeedRef, {
          id: orderId,
          orderNumber,
          customerName: cleanName,
          customerPhone: cleanPhone,
          shippingAddress: cleanManualAddress,
          city: '',
          postalCode: '',
          locationDetail: '',
          locationCoords: cleanLocationCoords,
          locationUrl: cleanLocationUrl,
          locationImageUrl: activeConfig.allowLocationPhoto
            ? locationImageUrl || ''
            : '',
          paymentMethod: chosenPaymentMethod,
          currency: orderCurrency,
          shippingMethod,
          notes: combinedNotes,
          items: orderItemsPayload,
          totalAmount: orderTotal,
          trackingNumber: '',
          status: 'pending',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        for (const p of productDocs) {
          const pRef = doc(db, 'products', p.id);
          tx.update(pRef, {
            stock: p.nextStock,
            lastOrderId: orderId,
            updatedAt: serverTimestamp(),
          });
        }
      });

      // Persist locally so customer can track order & ask via Telegram without email/login
      saveGuestOrderRef(orderId, orderNumber);
      saveGuestProfileDraft({
        name: cleanName,
        phone: cleanPhone,
        locationCoords: cleanLocationCoords,
        locationUrl: cleanLocationUrl,
      });

      const itemsSummary = cart.map(({ product, quantity }) => ({
        name: product.name,
        quantity,
        unit: normalizeProductUnit(product.unit),
      }));

      setTelegramRedirectTriggered(false);
      setCopiedTelegramMsg(false);
      setProofActionFeedback(null);
      setBotProofStatus(
        chosenPaymentMethod === 'QR' && effectiveProofUrl ? 'sending' : 'idle'
      );
      setCompletedOrder({
        id: orderId,
        orderNumber,
        totalAmount: finalTotal,
        paymentMethod: chosenPaymentMethod,
        currency: orderCurrency,
        shippingMethod,
        locationCoords: cleanLocationCoords,
        locationUrl: cleanLocationUrl,
        notes: cleanNotes,
        customerName: cleanName,
        customerPhone: cleanPhone,
        manualAddress: cleanManualAddress,
        transferProofImageUrl:
          chosenPaymentMethod === 'QR' ? effectiveProofUrl : '',
        transferProofFile:
          chosenPaymentMethod === 'QR' ? effectiveProofFile : null,
        itemsSummary,
      });

      // Automatically forward ABA/QR proof image + order details directly to Owner Telegram Bot if configured on backend
      if (chosenPaymentMethod === 'QR' && effectiveProofUrl) {
        const formattedFinalTotal = formatAmountByCurrency(finalTotal, orderCurrency);
        const itemsTextSummary = itemsSummary
          .map((it) => `- ${it.name} x${it.quantity} ${it.unit}`)
          .join('\n');
        void fetch('/api/telegram/send-payment-proof', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderId,
            orderNumber,
            customerName: cleanName,
            customerPhone: cleanPhone,
            totalLabel: formattedFinalTotal,
            itemsText: itemsTextSummary,
            locationUrl: cleanLocationUrl,
            manualAddress: cleanManualAddress,
            notes: cleanNotes,
            storeName: effectiveMaster.storeName,
            proofDataUrl: effectiveProofUrl,
          }),
        })
          .then(async (res) => {
            const ct = (res.headers.get('content-type') || '').toLowerCase();
            if (!res.ok || !ct.includes('application/json')) {
              setBotProofStatus('manual_needed');
              return;
            }
            const data = (await res.json()) as { sentToOwner?: boolean };
            setBotProofStatus(data?.sentToOwner ? 'sent' : 'manual_needed');
          })
          .catch(() => {
            setBotProofStatus('manual_needed');
          });
      }

      setNotes('');
      setTransferProofImageUrl('');
      setTransferProofFile(null);
      setTransferProofError(null);
      setTransferProofFeedback(null);
      setTransferProofMissingHighlight(false);
      setPaymentMethod(null);
      setPaymentMissingHighlight(false);
      onClearCart();
      setStep('success');
    } catch (error) {
      drawerBodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      if (isQuotaOrResourceExhaustedError(error)) {
        setQuotaFallbackActive(true);
        setErrorMsg(
          'Website ini 100% GRATIS tanpa kuota pelanggan. Saat ini batas harian server database cloud gratis sedang penuh sementara — Anda tetap bisa langsung Checkout GRATIS lewat Telegram dengan 1 klik di bawah ini!'
        );
      } else if (
        error instanceof Error &&
        (error.message.includes('belum diaktifkan') ||
          error.message.includes('tidak mencukupi') ||
          error.message.includes('telah berakhir') ||
          error.message.includes('sedang disiapkan'))
      ) {
        setErrorMsg(error.message);
      } else {
        console.error('Checkout error:', error);
        setQuotaFallbackActive(true);
        setErrorMsg(
          'Koneksi ke server pesanan sedang sibuk. Anda dapat mencoba kirim ulang atau langsung selesaikan pesanan 100% GRATIS melalui tombol Checkout Telegram di bawah.'
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    await executeCheckout();
  };

  const resetAndClose = () => {
    setStep('cart');
    setPaymentMethod(null);
    setPaymentMissingHighlight(false);
    setTransferProofImageUrl('');
    setTransferProofFile(null);
    setTransferProofError(null);
    setTransferProofFeedback(null);
    setTransferProofMissingHighlight(false);
    setBotProofStatus('idle');
    setProofActionFeedback(null);
    setCompletedOrder(null);
    setErrorMsg(null);
    setQuotaFallbackActive(false);
    setCopiedFallbackMsg(false);
    onClose();
  };

  const buildFreeTelegramFallbackMessage = () => {
    const chosenMethod = paymentMethod === 'CASH' ? `CASH (${secondaryCurrency})` : `QR ABA (${primaryCurrency})`;
    const formattedTotal = formatAmountByCurrency(
      paymentMethod ? displayTotal : totalUsd,
      paymentMethod ? activeCurrency : primaryCurrency,
      paymentMethod ? activeCurrencySymbol : primarySymbol
    );
    const itemsLines = cart
      .map(
        ({ product, quantity }) =>
          `- ${product.name} x${quantity} ${normalizeProductUnit(product.unit)}`
      )
      .join('\n');
    return [
      `PESANAN BARU (CHECKOUT GRATIS) - ${effectiveMaster.storeName}`,
      `Nama Penerima: ${customerName.trim() || '-'}`,
      `Kontak Telegram: ${customerPhone.trim() || '-'}`,
      `Metode Bayar: ${chosenMethod}`,
      `Total Tagihan: ${formattedTotal}`,
      `Daftar Produk:\n${itemsLines}`,
      locationUrl ? `Lokasi GPS: ${locationUrl}` : locationCoords ? `Koordinat GPS: ${locationCoords}` : '',
      manualAddress.trim() ? `Alamat / Patokan: ${manualAddress.trim()}` : '',
      notes.trim() ? `Catatan: ${notes.trim()}` : '',
      '',
      'Mohon proses pesanan saya sekarang. Terima kasih!',
    ]
      .filter(Boolean)
      .join('\n');
  };

  const freeTelegramBaseUrl =
    effectiveMaster.telegramOrderUrl &&
    effectiveMaster.telegramOrderUrl.startsWith('https://')
      ? effectiveMaster.telegramOrderUrl
      : 'https://t.me/AlpamartTM03';

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex justify-end no-print"
      role="dialog"
      aria-modal="true"
      aria-label="Keranjang dan Checkout"
    >
      <div className="bg-white w-full max-w-lg h-full h-[100dvh] flex flex-col border-l border-slate-200 shadow-2xl pb-[env(safe-area-inset-bottom)]">
        <div className={`h-1 w-full ${theme.topBar}`} />
        {/* Drawer Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {step === 'checkout' && (
              <button
                type="button"
                onClick={() => setStep('cart')}
                aria-label="Kembali ke keranjang"
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 cursor-pointer"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            )}
            <h2 className="font-display text-lg font-bold text-slate-900">
              {step === 'cart'
                ? activeConfig.cartTitle
                : step === 'checkout'
                  ? 'Checkout Pesanan'
                  : activeConfig.successTitle}
            </h2>
          </div>

          <button
            type="button"
            onClick={resetAndClose}
            aria-label="Tutup panel"
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Drawer Body */}
        <div ref={drawerBodyRef} className="flex-1 overflow-y-auto p-6">
          {activeHours.enabled && !storeOpenStatus.isOpen && step !== 'success' && (
            <div className="mb-4 p-3.5 bg-red-50 border border-red-200 rounded-xl flex items-start gap-2.5 text-xs text-red-900">
              <Clock className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <p className="font-bold">
                  {activeHours.closedTitle} ({storeOpenStatus.scheduleSummary})
                </p>
                {activeHours.closedMessage && (
                  <p className="text-red-800 leading-relaxed">
                    {activeHours.closedMessage}
                  </p>
                )}
              </div>
            </div>
          )}

          {step === 'cart' && (
            <>
              {activeConfig.cartNotice && (
                <div className="mb-4 p-3.5 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-900 leading-relaxed">
                  {activeConfig.cartNotice}
                </div>
              )}

              {cart.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center py-12 space-y-4">
                  <ShoppingBag className="w-10 h-10 text-slate-300" />
                  <div className="space-y-1">
                    <p className="text-base font-semibold text-slate-900">
                      Keranjang masih kosong
                    </p>
                    <p className="text-sm text-slate-500 max-w-xs">
                      Tambahkan produk dari {effectiveMaster.storeName} lalu lanjutkan checkout.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={resetAndClose}
                    className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors cursor-pointer ${theme.primaryBtn}`}
                  >
                    Lihat Katalog
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  {cart.map(({ product, quantity }) => {
                    const promoInfo = computePromoForProduct(
                      product,
                      quantity,
                      promotions,
                      nowMs
                    );
                    const unit = normalizeProductUnit(product.unit);
                    const effectiveStock = getEffectiveProductStock(product, promotions, nowMs);
                    const lineUsd = promoInfo.lineTotalUsd;
                    const normalLineUsd = Number((promoInfo.effectiveUnitUsd * quantity).toFixed(2));
                    const nextComboTargetQty = quantity + promoInfo.comboShortfallQty;
                    const canCompleteCombo =
                      Boolean(promoInfo.comboPromo) &&
                      promoInfo.comboShortfallQty > 0 &&
                      nextComboTargetQty <= effectiveStock;

                    return (
                      <div
                        key={product.id}
                        className="p-3 border border-slate-200 rounded-xl bg-slate-50/50 space-y-2.5"
                      >
                        <div className="flex gap-4">
                          <div className="w-20 h-16 rounded-lg overflow-hidden bg-slate-100 shrink-0">
                            <ProductImage
                              src={product.imageUrl}
                              alt={product.name}
                              className="w-full h-full object-cover"
                            />
                          </div>

                          <div className="flex-1 min-w-0 flex flex-col justify-between">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <h3 className="text-sm font-semibold text-slate-900 truncate">
                                  {product.name}{' '}
                                  <span className="font-mono text-[11px] font-semibold text-slate-500">
                                    ({unit})
                                  </span>
                                </h3>
                                {promoInfo.promoBadgeText && (
                                  <p className="text-[11px] font-semibold text-emerald-700 mt-0.5">
                                    {promoInfo.promoBadgeText}
                                    {promoInfo.bonusFreeQty > 0
                                      ? ` · Bonus +${promoInfo.bonusFreeQty} ${unit} gratis`
                                      : ''}
                                  </p>
                                )}
                                {promoInfo.comboPromo && promoInfo.comboFreeQty > 0 && (
                                  <p className="text-[11px] font-semibold text-emerald-800 mt-0.5">
                                    Input {quantity} {unit} (Stok -{quantity}) · Bayar{' '}
                                    {promoInfo.paidQty} {unit} · Gratis {promoInfo.comboFreeQty}{' '}
                                    {unit}
                                  </p>
                                )}
                              </div>
                              <button
                                type="button"
                                onClick={() => onRemoveItem(product.id)}
                                aria-label={`Hapus ${product.name}`}
                                className="text-slate-400 hover:text-red-600 p-1 cursor-pointer"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>

                            <div className="flex items-center justify-between gap-2 mt-2">
                              <div>
                                {promoInfo.comboPromo && promoInfo.comboFreeQty > 0 && (
                                  <span className="font-mono tabular-nums text-[11px] text-slate-400 line-through block">
                                    {formatPrimaryAmount(normalLineUsd, effectiveMaster)}
                                  </span>
                                )}
                                <span className="font-mono tabular-nums text-sm font-bold text-blue-700 block">
                                  {formatPrimaryAmount(lineUsd, effectiveMaster)} (QR)
                                </span>
                                <span className="font-mono tabular-nums text-xs font-medium text-red-600 block">
                                  {formatSecondaryAmount(lineUsd, effectiveMaster)} (CASH)
                                </span>
                              </div>

                              <div className="inline-flex items-center border border-slate-200 bg-white rounded-lg">
                                <button
                                  type="button"
                                  onClick={() => onUpdateQty(product.id, quantity - 1)}
                                  aria-label="Kurangi"
                                  className="p-1.5 text-slate-600 hover:text-slate-900 cursor-pointer"
                                >
                                  <Minus className="w-3.5 h-3.5" />
                                </button>
                                <span className="px-2.5 font-mono tabular-nums text-xs font-medium text-slate-900">
                                  {quantity} {unit}
                                </span>
                                <button
                                  type="button"
                                  disabled={quantity >= effectiveStock}
                                  onClick={() => onUpdateQty(product.id, quantity + 1)}
                                  aria-label="Tambah"
                                  className="p-1.5 text-slate-600 hover:text-slate-900 disabled:opacity-40 cursor-pointer"
                                >
                                  <Plus className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>

                        {promoInfo.comboPromo && promoInfo.comboShortfallQty > 0 && (
                          <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg flex flex-wrap items-center justify-between gap-2 text-[11px] text-amber-950">
                            <p className="leading-relaxed">
                              <strong>Promo Combo Beli {promoInfo.comboPromo.buyQty} Free {promoInfo.comboPromo.getQty}:</strong>{' '}
                              Masukkan <strong>{promoInfo.comboShortfallQty} {unit}</strong> lagi (total{' '}
                              <strong>{nextComboTargetQty} {unit}</strong>) agar cukup bayar{' '}
                              <strong>
                                {Math.floor(nextComboTargetQty / promoInfo.comboBundleSize) *
                                  promoInfo.comboPromo.buyQty}{' '}
                                {unit}
                              </strong>!
                            </p>
                            {canCompleteCombo && (
                              <button
                                type="button"
                                onClick={() => onUpdateQty(product.id, nextComboTargetQty)}
                                className="px-2.5 py-1 text-[11px] font-bold text-white bg-emerald-700 hover:bg-emerald-800 rounded-md cursor-pointer whitespace-nowrap shrink-0"
                              >
                                Lengkapi ke {nextComboTargetQty} {unit}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {step === 'checkout' && (
            <form id="checkout-form" noValidate onSubmit={handleSubmitOrder} className="space-y-5">
              <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-emerald-950">
                    {activeConfig.checkoutHeading}
                  </p>
                  <span className="font-mono text-[11px] font-bold text-emerald-700">
                    {shippingUsd === 0
                      ? 'FREE DELIVERY'
                      : formatPrimaryAmount(shippingUsd, effectiveMaster)}
                  </span>
                </div>
                {activeConfig.checkoutIntro && (
                  <p className="text-xs text-emerald-800 leading-relaxed">
                    {activeConfig.checkoutIntro}
                  </p>
                )}
              </div>

              {errorMsg && (
                <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800 space-y-2.5">
                  <p className="leading-relaxed font-medium">{errorMsg}</p>
                  {quotaFallbackActive && (
                    <div className="pt-1 flex flex-col gap-2">
                      <a
                        href={`${freeTelegramBaseUrl}?text=${encodeURIComponent(
                          buildFreeTelegramFallbackMessage()
                        )}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-3.5 text-xs font-extrabold text-white bg-[#0088cc] hover:bg-[#006fa6] rounded-lg shadow-xs transition-colors"
                      >
                        <Send className="w-3.5 h-3.5 shrink-0" />
                        <span>Checkout Gratis via Telegram Sekarang</span>
                        <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                      </a>
                      <button
                        type="button"
                        onClick={() => {
                          void navigator.clipboard.writeText(
                            buildFreeTelegramFallbackMessage()
                          );
                          setCopiedFallbackMsg(true);
                          window.setTimeout(() => setCopiedFallbackMsg(false), 2500);
                        }}
                        className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-3 text-[11px] font-semibold text-slate-800 bg-white hover:bg-slate-50 border border-slate-300 rounded-lg cursor-pointer"
                      >
                        {copiedFallbackMsg ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-600" />
                            <span>Detail Pesanan Disalin!</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            <span>Salin Rincian Pesanan</span>
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Payment Method Selector — MUST BE EXPLICITLY CHOSEN */}
              <div
                className={`space-y-2 rounded-xl transition-colors ${
                  paymentMissingHighlight
                    ? 'p-3 bg-rose-50/70 border border-rose-300'
                    : ''
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <label className="block text-xs font-semibold text-slate-800">
                    Pilih Metode &amp; Mata Uang Pembayaran{' '}
                    <span className="text-red-600">*</span>
                  </label>
                  <span
                    className={`text-[11px] font-semibold ${
                      paymentMethod ? 'text-emerald-700' : 'text-red-600'
                    }`}
                  >
                    {paymentMethod
                      ? `Terpilih: ${paymentMethod === 'CASH' ? `${activeConfig.cashTitle} (${secondaryCurrency})` : `${activeConfig.qrTitle} (${primaryCurrency})`}`
                      : 'Wajib dipilih'}
                  </span>
                </div>
                <div
                  className={`grid grid-cols-1 ${
                    activeConfig.enableCashPayment && activeConfig.enableQrPayment
                      ? 'sm:grid-cols-2'
                      : ''
                  } gap-3`}
                >
                  {activeConfig.enableCashPayment && (
                    <button
                      type="button"
                      onClick={() => {
                        setPaymentMethod('CASH');
                        setPaymentMissingHighlight(false);
                        setErrorMsg(null);
                      }}
                      className={`p-3.5 border rounded-xl text-left transition-colors cursor-pointer ${
                        paymentMethod === 'CASH'
                          ? 'border-red-600 bg-red-50/70 ring-1 ring-red-600'
                          : 'border-slate-200 bg-white hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="inline-flex items-center gap-1.5 text-sm font-bold text-red-700">
                          <Banknote className="w-4 h-4" />
                          {activeConfig.cashTitle}
                        </span>
                        <span className="font-mono text-xs font-bold text-red-700">
                          {secondaryCurrency}
                        </span>
                      </div>
                      {activeConfig.cashDescription && (
                        <p className="text-xs text-slate-600 mt-1">
                          {activeConfig.cashDescription}
                        </p>
                      )}
                    </button>
                  )}

                  {activeConfig.enableQrPayment && (
                    <button
                      type="button"
                      onClick={() => {
                        setPaymentMethod('QR');
                        setPaymentMissingHighlight(false);
                        setErrorMsg(null);
                      }}
                      className={`p-3.5 border rounded-xl text-left transition-colors cursor-pointer ${
                        paymentMethod === 'QR'
                          ? 'border-blue-700 bg-blue-50/70 ring-1 ring-blue-700'
                          : 'border-slate-200 bg-white hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="inline-flex items-center gap-1.5 text-sm font-bold text-blue-700">
                          <QrCode className="w-4 h-4" />
                          {activeConfig.qrTitle}
                        </span>
                        <span className="font-mono text-xs font-bold text-blue-700">
                          {primaryCurrency}
                        </span>
                      </div>
                      {activeConfig.qrDescription && (
                        <p className="text-xs text-slate-600 mt-1">
                          {activeConfig.qrDescription}
                        </p>
                      )}
                    </button>
                  )}
                </div>

                {!paymentMethod && (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900">
                    Silakan pilih metode pembayaran di atas sebelum mengirim pesanan.
                  </div>
                )}

                {paymentMethod === 'QR' && (
                  <div className="space-y-3">
                    <AbaPayQrCard
                      amountUsd={totalUsd}
                      qrPayload={usdQrPayload}
                      referenceLabel={`Ref: ${draftPaymentRef}`}
                      checkoutConfig={activeConfig}
                      masterConfig={effectiveMaster}
                      compact
                    />

                    {/* Mandatory ABA/QR Transfer-First + Auto-Checkout Proof Upload Box */}
                    <div
                      ref={transferProofBoxRef}
                      className={`p-4 rounded-xl border-2 space-y-3 transition-colors ${
                        transferProofMissingHighlight
                          ? 'bg-rose-50 border-rose-500 ring-2 ring-rose-200'
                          : transferProofImageUrl
                            ? 'bg-emerald-50/70 border-emerald-500'
                            : 'bg-blue-50/70 border-blue-400'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="space-y-0.5">
                          <span className="inline-block px-2 py-0.5 text-[10px] font-mono font-extrabold uppercase tracking-wider bg-blue-700 text-white rounded">
                            WAJIB TRANSFER ABA/QR DAHULU
                          </span>
                          <h4 className="text-xs sm:text-sm font-extrabold text-slate-900">
                            Unggah Bukti Transfer ABA/QR → Otomatis Checkout &amp; Kirim Telegram Pemilik
                          </h4>
                        </div>
                        {transferProofImageUrl && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-600 text-white text-[10px] font-bold shrink-0">
                            <CheckCircle2 className="w-3 h-3" />
                            Terlampir
                          </span>
                        )}
                      </div>

                      <ol className="text-[11px] text-slate-700 space-y-1 list-decimal list-inside leading-relaxed">
                        <li>
                          Transfer nominal pas{' '}
                          <strong className="font-mono text-blue-800">
                            {formatAmountByCurrency(
                              displayTotal,
                              primaryCurrency,
                              primarySymbol
                            )}
                          </strong>{' '}
                          melalui QR ABA di atas terlebih dahulu.
                        </li>
                        <li>
                          Unggah screenshot / foto bukti transfer ABA di bawah ini. Jika data penerima &amp; lokasi sudah terisi, pesanan{' '}
                          <strong>otomatis langsung checkout</strong> dan mengirim bukti ke Telegram pemilik.
                        </li>
                      </ol>

                      {transferProofImageUrl ? (
                        <div className="space-y-2">
                          <div className="relative rounded-lg overflow-hidden border border-emerald-300 bg-white">
                            <img
                              src={transferProofImageUrl}
                              alt="Bukti Transfer ABA/QR"
                              className="w-full max-h-48 object-contain bg-slate-50"
                            />
                          </div>
                          <div className="flex items-center gap-2">
                            <label className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-blue-800 bg-white hover:bg-blue-50 border border-blue-300 rounded-lg cursor-pointer transition-colors">
                              <Upload className="w-3.5 h-3.5" />
                              <span>
                                {uploadingTransferProof
                                  ? 'Memproses foto...'
                                  : 'Ganti Foto Bukti'}
                              </span>
                              <input
                                type="file"
                                accept="image/*"
                                disabled={uploadingTransferProof || submitting}
                                onChange={(e) => {
                                  const f = e.target.files?.[0] || null;
                                  e.target.value = '';
                                  void handleTransferProofUpload(f);
                                }}
                                className="hidden"
                              />
                            </label>
                            <button
                              type="button"
                              disabled={submitting}
                              onClick={() => {
                                setTransferProofImageUrl('');
                                setTransferProofFile(null);
                                setTransferProofFeedback(null);
                                setTransferProofError(null);
                              }}
                              className="px-3 py-2 text-xs font-semibold text-rose-700 bg-white hover:bg-rose-50 border border-rose-200 rounded-lg cursor-pointer"
                            >
                              Hapus
                            </button>
                          </div>
                        </div>
                      ) : (
                        <label className="w-full flex flex-col items-center justify-center gap-1.5 px-4 py-4 text-center bg-white hover:bg-blue-50/60 border-2 border-dashed border-blue-400 rounded-xl cursor-pointer transition-colors">
                          <Upload className="w-5 h-5 text-blue-700" />
                          <span className="text-xs font-bold text-blue-900">
                            {uploadingTransferProof
                              ? 'Memproses bukti transfer...'
                              : 'Klik untuk Unggah Screenshot / Foto Bukti Transfer ABA'}
                          </span>
                          <span className="text-[11px] text-slate-500">
                            Format JPG / PNG / Screenshot ABA Pay
                          </span>
                          <input
                            type="file"
                            accept="image/*"
                            disabled={uploadingTransferProof || submitting}
                            onChange={(e) => {
                              const f = e.target.files?.[0] || null;
                              e.target.value = '';
                              void handleTransferProofUpload(f);
                            }}
                            className="hidden"
                          />
                        </label>
                      )}

                      <label className="flex items-start gap-2 text-[11px] text-slate-700 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={autoCheckoutOnProof}
                          onChange={(e) => setAutoCheckoutOnProof(e.target.checked)}
                          className="mt-0.5 rounded border-slate-300 text-blue-700 focus:ring-blue-700"
                        />
                        <span>
                          <strong>Otomatis langsung checkout</strong> begitu bukti transfer diunggah (jika Nama, Kontak Telegram &amp; Lokasi sudah terisi).
                        </span>
                      </label>

                      {transferProofError && (
                        <p className="text-xs font-semibold text-rose-700 leading-relaxed">
                          {transferProofError}
                        </p>
                      )}
                      {transferProofFeedback && !transferProofError && (
                        <p className="text-xs font-semibold text-emerald-800 leading-relaxed">
                          {transferProofFeedback}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {paymentMethod === 'CASH' && (
                  <div className="p-3 bg-red-50/60 border border-red-200 rounded-xl text-xs text-red-900">
                    Total tagihan tunai ({activeConfig.cashTitle}):{' '}
                    <span className="font-mono font-bold">
                      {formatAmountByCurrency(
                        displayTotal,
                        secondaryCurrency,
                        secondarySymbol
                      )}
                    </span>{' '}
                    (Kurs 1 {primaryCurrency} ={' '}
                    {formatSecondaryAmount(1, effectiveMaster)})
                  </div>
                )}

                {paymentMethod && (
                  <div className="p-3.5 bg-[#e8f6fd] border border-[#0088cc]/30 rounded-xl flex items-start gap-2.5 text-xs text-slate-900">
                    <Send className="w-4 h-4 text-[#0088cc] shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <p className="font-bold text-[#005f8f]">
                        Wajib Konfirmasi Bukti Pembayaran via Telegram ({paymentMethod === 'QR' ? 'QR ABA' : 'CASH'})
                      </p>
                      <p className="text-slate-700 leading-relaxed">
                        Setelah menekan tombol kirim pesanan di bawah, Anda{' '}
                        <strong>wajib dialihkan otomatis ke Telegram resmi toko</strong> untuk
                        mengirimkan konfirmasi &amp; bukti pembayaran{' '}
                        <strong>{paymentMethod === 'QR' ? 'transfer QR ABA' : 'CASH (Tunai)'}</strong>{' '}
                        agar pesanan segera diproses kurir.
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Nama Penerima
                  </label>
                  <input
                    type="text"
                    required
                    minLength={FIELD_LIMITS.NAME_MIN}
                    maxLength={FIELD_LIMITS.NAME_MAX}
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    placeholder="Contoh: Budi Santoso"
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>

                <div
                  className={
                    telegramInvalidHighlight
                      ? 'p-3 bg-rose-50/70 border border-rose-300 rounded-xl'
                      : ''
                  }
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <label className="block text-xs font-medium text-slate-700">
                      {activeConfig.contactFieldLabel}{' '}
                      <span className="text-red-600">*</span>
                    </label>
                    {customerPhone.trim().length > 0 && (
                      <span
                        className={`text-[11px] font-bold ${
                          telegramValidation.valid
                            ? 'text-emerald-700'
                            : 'text-rose-600'
                        }`}
                      >
                        {telegramValidation.valid ? '✓ Telegram Valid' : '✗ Belum Valid'}
                      </span>
                    )}
                  </div>
                  <input
                    ref={telegramInputRef}
                    type="text"
                    required
                    minLength={FIELD_LIMITS.PHONE_MIN}
                    maxLength={FIELD_LIMITS.PHONE_MAX}
                    value={customerPhone}
                    onChange={(e) => {
                      setCustomerPhone(e.target.value);
                      setTelegramInvalidHighlight(false);
                      setErrorMsg(null);
                    }}
                    placeholder="Contoh: @budi_santoso atau +85512345678"
                    className={`w-full px-3 py-2 text-sm font-mono border rounded-lg focus:outline-none focus:ring-2 ${
                      customerPhone.trim().length === 0
                        ? 'border-slate-200 focus:ring-blue-700'
                        : telegramValidation.valid
                          ? 'border-emerald-400 bg-emerald-50/40 focus:ring-emerald-600'
                          : 'border-rose-400 bg-rose-50/40 focus:ring-rose-500'
                    }`}
                  />
                  <p
                    className={`text-[11px] mt-1 leading-relaxed ${
                      customerPhone.trim().length === 0
                        ? 'text-slate-500'
                        : telegramValidation.valid
                          ? 'text-emerald-700 font-medium'
                          : 'text-rose-700 font-medium'
                    }`}
                  >
                    {telegramValidation.message}
                  </p>
                </div>

                <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <MapPin className="w-4 h-4 text-red-600 shrink-0" />
                      <span className="text-xs font-bold text-slate-900">
                        Lokasi Pengiriman Otomatis
                      </span>
                    </div>
                    <button
                      type="button"
                      disabled={locatingGps}
                      onClick={handleDetectLocation}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-red-600 transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <LocateFixed className="w-3.5 h-3.5" />
                      <span>
                        {locatingGps
                          ? 'Mendeteksi GPS...'
                          : autoLocationSource === 'gps'
                            ? 'Perbarui GPS Akurat'
                            : 'Perbarui Titik GPS (Opsional)'}
                      </span>
                    </button>
                  </div>

                  {locationCoords || locationUrl ? (
                    <div className="flex items-start gap-2 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                      <div className="space-y-0.5">
                        <p>
                          {autoLocationSource === 'gps'
                            ? 'Lokasi GPS akurat aktif & siap dikirim otomatis ke Admin serta Kurir.'
                            : `Lokasi pelanggan otomatis terdeteksi${autoLocationLabel ? ` (${autoLocationLabel})` : ''} tanpa perlu izin pop-up — langsung siap checkout!`}
                        </p>
                        {autoLocationSource === 'network' && (
                          <p className="text-[11px] font-normal text-emerald-700">
                            Tambahkan nama gedung/nomor rumah di kolom patokan bawah jika perlu agar kurir makin cepat sampai.
                          </p>
                        )}
                      </div>
                    </div>
                  ) : autoLocatingNetwork ? (
                    <p className="text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                      Mendeteksi lokasi pelanggan secara otomatis tanpa perlu persetujuan...
                    </p>
                  ) : (
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Lokasi otomatis sedang disiapkan. Anda juga bisa langsung isi Alamat / Patokan di bawah atau tekan <strong>Perbarui Titik GPS (Opsional)</strong>.
                    </p>
                  )}

                  {geoFeedback && !(locationCoords || locationUrl) && (
                    <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 leading-relaxed">
                      {geoFeedback}
                    </p>
                  )}

                  {/* Always-available manual address & Google Maps fallback so PC or blocked-GPS browsers can always checkout */}
                  <div className="space-y-2.5 pt-1">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Alamat / Patokan Pengiriman{' '}
                        <span className="font-normal text-slate-500">
                          {locationCoords || locationUrl
                            ? '(Opsional · GPS sudah aktif)'
                            : gpsFailedOrDenied || !activeConfig.requireGpsLocation
                              ? '(Wajib diisi jika GPS tidak aktif)'
                              : '(Atau isi manual jika GPS di PC/HP tidak aktif)'}
                        </span>
                      </label>
                      <input
                        type="text"
                        maxLength={FIELD_LIMITS.ADDRESS_MAX}
                        value={manualAddress}
                        onChange={(e) => {
                          setManualAddress(e.target.value);
                          setErrorMsg(null);
                        }}
                        placeholder="Nama jalan, nomor rumah, gedung, lantai, atau patokan..."
                        className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                      />
                    </div>

                    {!(locationCoords || locationUrl) || manualMapLink ? (
                      <div>
                        <label className="block text-[11px] font-medium text-slate-600 mb-1">
                          Link Google Maps / Koordinat (Opsional · cocok untuk PC)
                        </label>
                        <input
                          type="text"
                          maxLength={FIELD_LIMITS.LOCATION_URL_MAX}
                          value={manualMapLink}
                          onChange={(e) => handleManualMapLinkChange(e.target.value)}
                          placeholder="Tempel link https://maps.app.goo.gl/... atau koordinat 11.5564, 104.9282"
                          className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                        />
                      </div>
                    ) : null}
                  </div>

                  {/* Optional Location Photo Upload (Camera / Gallery) */}
                  {activeConfig.allowLocationPhoto && (
                    <div className="pt-2.5 border-t border-slate-200/80 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <ImageIcon className="w-3.5 h-3.5 text-slate-600 shrink-0" />
                          <span className="text-xs font-semibold text-slate-800">
                            Foto Lokasi / Rumah (Opsional)
                          </span>
                        </div>
                        <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 cursor-pointer">
                          <Camera className="w-3.5 h-3.5 text-blue-700" />
                          <span>
                            {uploadingPhoto
                              ? 'Memproses Foto...'
                              : locationImageUrl
                                ? 'Ganti Foto Lokasi'
                                : 'Upload / Ambil Foto'}
                          </span>
                          <input
                            type="file"
                            accept="image/*"
                            onChange={handleSelectLocationPhoto}
                            className="sr-only"
                          />
                        </label>
                      </div>

                      {locationImageUrl ? (
                        <div className="relative rounded-lg overflow-hidden border border-slate-200 bg-white">
                          <img
                            src={locationImageUrl}
                            alt="Preview foto lokasi pengiriman"
                            className="w-full max-h-44 object-cover"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              setLocationImageUrl('');
                              setPhotoFeedback(null);
                            }}
                            className="absolute top-2 right-2 inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-white bg-slate-900/80 hover:bg-red-600 rounded-md cursor-pointer"
                          >
                            <Trash2 className="w-3 h-3" />
                            <span>Hapus Foto</span>
                          </button>
                        </div>
                      ) : (
                        <p className="text-[11px] text-slate-500 leading-relaxed">
                          Opsional: Lampirkan foto depan rumah, gerbang, atau patokan agar kurir lebih cepat menemukan lokasi. Jika tidak diisi, tetap bisa langsung checkout.
                        </p>
                      )}

                      {photoFeedback && (
                        <p
                          className={`text-[11px] leading-relaxed ${
                            locationImageUrl ? 'text-emerald-700' : 'text-rose-700'
                          }`}
                        >
                          {photoFeedback}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Layanan Pengiriman
                  </label>
                  <div className="flex items-center justify-between p-3.5 border border-emerald-200 bg-emerald-50/70 rounded-lg">
                    <div>
                      <p className="text-xs font-bold text-slate-900">
                        {activeConfig.shippingLabel}
                      </p>
                      {activeConfig.shippingEta && (
                        <p className="text-xs text-slate-600">
                          {activeConfig.shippingEta}
                        </p>
                      )}
                    </div>
                    <span className="font-mono text-xs font-bold text-emerald-700 bg-white border border-emerald-200 px-2.5 py-1 rounded">
                      {shippingUsd === 0
                        ? 'FREE DELIVERY'
                        : formatPrimaryAmount(shippingUsd, effectiveMaster)}
                    </span>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <label
                      htmlFor="checkout-order-notes"
                      className="block text-xs font-medium text-slate-700"
                    >
                      Catatan Tambahan{' '}
                      <span className="font-normal text-slate-400">(Opsional)</span>
                    </label>
                    <span className="font-mono tabular-nums text-[11px] text-slate-400">
                      {notes.length}/{FIELD_LIMITS.NOTES_MAX}
                    </span>
                  </div>
                  <textarea
                    id="checkout-order-notes"
                    rows={3}
                    maxLength={FIELD_LIMITS.NOTES_MAX}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Contoh: Titip di resepsionis/satpam, minta minuman dingin, atau permintaan khusus produk & patokan kurir..."
                    className="w-full px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 bg-white border border-slate-200 rounded-lg resize-y min-h-[80px] focus:outline-none focus:ring-2 focus:ring-blue-700 focus:border-transparent"
                  />
                  <p className="mt-1 text-[11px] text-slate-500">
                    Instruksi pengiriman atau permintaan produk Anda akan otomatis diteruskan ke Admin &amp; Kurir.
                  </p>
                </div>
              </div>
            </form>
          )}

          {step === 'success' && completedOrder && (() => {
            const rawMasterTg = effectiveMaster.telegramOrderUrl?.trim() || '';
            const fallbackTelegramUrl = /^https:\/\/(t\.me|telegram\.me)\/[a-zA-Z0-9_+/=-]+/i.test(
              rawMasterTg
            )
              ? rawMasterTg
              : 'https://t.me/AlpamartTM03';
            const rawSuccessMsg =
              activeConfig.successMessage?.trim() ||
              `TERIMAKASIH SUDAH ORDER DI ${effectiveMaster.storeName}, UNTUK PESANAN SILAHKAN KIRIM BUKTI PESANAN ANDA DI TELEGRAM TERSEBUT : ${fallbackTelegramUrl}`;
            const telegramLinkMatch = rawSuccessMsg.match(
              /https?:\/\/(?:t\.me|telegram\.me)\/[a-zA-Z0-9_+/=-]+/i
            );
            const baseTelegramUrl = (telegramLinkMatch?.[0] || fallbackTelegramUrl).replace(
              /\?.*$/,
              ''
            );
            const messageWithoutUrl = rawSuccessMsg
              .replace(telegramLinkMatch?.[0] || fallbackTelegramUrl, '')
              .replace(/:\s*$/, '')
              .trim();

            const paymentLabel =
              completedOrder.paymentMethod === 'QR'
                ? `QR ABA (${completedOrder.currency})`
                : `CASH / TUNAI (${completedOrder.currency})`;
            const formattedOrderTotal = formatAmountByCurrency(
              completedOrder.totalAmount,
              completedOrder.currency
            );
            const itemsText = completedOrder.itemsSummary
              .map((it) => `- ${it.name} x${it.quantity} ${it.unit}`)
              .join('\n');
            const telegramPrefillMessage = [
              `KONFIRMASI BUKTI PEMBAYARAN - ${effectiveMaster.storeName}`,
              `No. Pesanan: ${completedOrder.orderNumber}`,
              `Metode Bayar: ${paymentLabel}`,
              `Total Tagihan: ${formattedOrderTotal}`,
              `Nama Penerima: ${completedOrder.customerName}`,
              `Kontak Telegram: ${completedOrder.customerPhone}`,
              itemsText ? `Daftar Pesanan:\n${itemsText}` : '',
              completedOrder.locationUrl ? `Lokasi GPS: ${completedOrder.locationUrl}` : '',
              completedOrder.notes ? `Catatan: ${completedOrder.notes}` : '',
              '',
              completedOrder.paymentMethod === 'QR'
                ? 'Saya sudah melakukan pembayaran via QR ABA. Berikut saya lampirkan bukti transfer/screenshot pembayaran.'
                : 'Saya memilih pembayaran CASH (Tunai). Mohon konfirmasi pesanan saya untuk segera diantar.',
            ]
              .filter(Boolean)
              .join('\n');

            const telegramConfirmUrl = `${baseTelegramUrl}?text=${encodeURIComponent(
              telegramPrefillMessage
            )}`;

            const handleCopyConfirmationText = () => {
              void navigator.clipboard.writeText(telegramPrefillMessage);
              setCopiedTelegramMsg(true);
              window.setTimeout(() => setCopiedTelegramMsg(false), 2500);
            };

            const resolveProofFileForShare = async (): Promise<File | null> => {
              if (completedOrder.transferProofFile) {
                return completedOrder.transferProofFile;
              }
              if (!completedOrder.transferProofImageUrl) return null;
              try {
                const res = await fetch(completedOrder.transferProofImageUrl);
                const blob = await res.blob();
                const ext = blob.type.includes('png') ? 'png' : 'jpg';
                return new File(
                  [blob],
                  `bukti-transfer-${completedOrder.orderNumber}.${ext}`,
                  { type: blob.type || 'image/jpeg' }
                );
              } catch {
                return null;
              }
            };

            const handleShareProofToOwnerTelegram = async () => {
              setSharingProof(true);
              setProofActionFeedback(null);
              try {
                // Best-effort copy confirmation text so customer can paste directly in Telegram chat
                try {
                  await navigator.clipboard.writeText(telegramPrefillMessage);
                } catch {
                  // Ignore clipboard restrictions
                }

                const proofFile = await resolveProofFileForShare();
                if (
                  proofFile &&
                  typeof navigator !== 'undefined' &&
                  typeof navigator.share === 'function' &&
                  typeof navigator.canShare === 'function' &&
                  navigator.canShare({ files: [proofFile] })
                ) {
                  await navigator.share({
                    files: [proofFile],
                    title: `Bukti Transfer ${completedOrder.orderNumber}`,
                    text: telegramPrefillMessage,
                  });
                  setProofActionFeedback(
                    'Menu kirim foto dibuka! Pilih Telegram Pemilik untuk mengirim bukti transfer + teks pesanan sekaligus.'
                  );
                  return;
                }

                // Desktop / fallback: open Owner Telegram chat directly with prefilled text + guide to paste/attach
                telegramAutoLinkRef.current?.click();
                setProofActionFeedback(
                  'Chat Telegram Pemilik dibuka & teks pesanan sudah disalin. Lampirkan foto bukti transfer di chat Telegram tersebut.'
                );
              } catch {
                // User cancelled share sheet or browser blocked share — fallback to direct Telegram link
                telegramAutoLinkRef.current?.click();
              } finally {
                setSharingProof(false);
              }
            };

            return (
              <div className="py-5 space-y-5">
                {/* Safe auto-navigation anchor (never uses window.open/alert) */}
                <a
                  ref={telegramAutoLinkRef}
                  href={telegramConfirmUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hidden"
                  aria-hidden="true"
                >
                  Redirect Telegram
                </a>

                <div className="p-5 bg-[#e8f6fd] border-2 border-[#0088cc] rounded-xl space-y-3.5 shadow-sm">
                  <div className="flex items-start gap-2.5 text-[#005f8f]">
                    <Send className="w-5 h-5 shrink-0 mt-0.5 text-[#0088cc]" />
                    <div className="space-y-1">
                      <span className="inline-block px-2 py-0.5 text-[10px] font-mono font-extrabold uppercase tracking-wider bg-[#0088cc] text-white rounded">
                        {completedOrder.paymentMethod === 'QR' && botProofStatus === 'sent'
                          ? 'BUKTI TRANSFER OTOMATIS TERKIRIM KE PEMILIK'
                          : 'KONFIRMASI BUKTI KE TELEGRAM PEMILIK'}
                      </span>
                      <h3 className="text-sm sm:text-base font-extrabold tracking-tight leading-snug text-slate-900 uppercase">
                        {activeConfig.successTitle}
                      </h3>
                    </div>
                  </div>

                  {completedOrder.paymentMethod === 'QR' && botProofStatus === 'sent' && (
                    <div className="p-3 rounded-lg bg-emerald-100 border border-emerald-300 flex items-center gap-2 text-xs font-bold text-emerald-900">
                      <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                      <span>
                        Foto bukti transfer ABA/QR &amp; rincian pesanan Anda sudah otomatis dikirim ke Telegram Pemilik!
                      </span>
                    </div>
                  )}

                  {completedOrder.paymentMethod === 'QR' && botProofStatus === 'sending' && (
                    <div className="p-3 rounded-lg bg-white border border-blue-200 text-xs font-semibold text-blue-800">
                      Sedang mengirim foto bukti transfer ke Telegram Pemilik...
                    </div>
                  )}

                  {completedOrder.paymentMethod === 'QR' &&
                    completedOrder.transferProofImageUrl && (
                      <div className="p-2.5 bg-white border border-[#0088cc]/30 rounded-xl space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-bold text-slate-800">
                            Bukti Transfer ABA/QR Anda
                          </span>
                          <a
                            href={completedOrder.transferProofImageUrl}
                            download={`bukti-transfer-${completedOrder.orderNumber}.jpg`}
                            className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#0088cc] hover:underline"
                          >
                            <Download className="w-3 h-3" />
                            <span>Simpan Foto</span>
                          </a>
                        </div>
                        <img
                          src={completedOrder.transferProofImageUrl}
                          alt="Bukti Transfer ABA/QR"
                          className="w-full max-h-44 object-contain rounded-lg bg-slate-50 border border-slate-100"
                        />
                      </div>
                    )}

                  <p className="text-xs sm:text-sm font-semibold text-slate-900 leading-relaxed">
                    {completedOrder.paymentMethod === 'QR'
                      ? 'Pesanan otomatis ter-checkout! Kirim langsung foto bukti transfer ABA/QR Anda ke Telegram resmi pemilik agar segera diverifikasi & diantar:'
                      : 'Wajib konfirmasi pesanan pembayaran CASH Anda ke Telegram resmi toko sekarang agar pesanan segera diproses kurir:'}{' '}
                    <a
                      href={telegramConfirmUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-[#0088cc] underline underline-offset-2 break-all hover:text-[#006699]"
                    >
                      {baseTelegramUrl}
                    </a>
                  </p>

                  {messageWithoutUrl && (
                    <p className="text-[11px] text-slate-700 leading-relaxed">
                      {messageWithoutUrl}
                    </p>
                  )}

                  {completedOrder.paymentMethod === 'QR' &&
                    completedOrder.transferProofImageUrl && (
                      <button
                        type="button"
                        disabled={sharingProof}
                        onClick={() => void handleShareProofToOwnerTelegram()}
                        className="w-full inline-flex items-center justify-center gap-2 py-3.5 px-4 text-xs sm:text-sm font-extrabold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg shadow-sm transition-colors cursor-pointer disabled:opacity-60"
                      >
                        <Share2 className="w-4 h-4 shrink-0" />
                        <span>
                          {sharingProof
                            ? 'Menyiapkan Foto Bukti...'
                            : 'Kirim Foto Bukti + Pesanan ke Telegram Pemilik'}
                        </span>
                      </button>
                    )}

                  <a
                    href={telegramConfirmUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full inline-flex items-center justify-center gap-2 py-3.5 px-4 text-xs sm:text-sm font-extrabold text-white bg-[#0088cc] hover:bg-[#006fa6] rounded-lg shadow-sm transition-colors"
                  >
                    <Send className="w-4 h-4 shrink-0" />
                    <span>
                      Buka Chat Telegram Pemilik ({completedOrder.paymentMethod === 'QR' ? 'QR ABA' : 'CASH'})
                    </span>
                    <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                  </a>

                  {proofActionFeedback && (
                    <p className="text-[11px] font-semibold text-emerald-800 leading-relaxed">
                      {proofActionFeedback}
                    </p>
                  )}

                  <button
                    type="button"
                    onClick={handleCopyConfirmationText}
                    className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-3 text-xs font-semibold text-[#005f8f] bg-white hover:bg-slate-50 border border-[#0088cc]/40 rounded-lg transition-colors cursor-pointer"
                  >
                    {copiedTelegramMsg ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                        <span>Teks Konfirmasi Disalin — Tempel di Telegram</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Salin Teks Konfirmasi Pesanan</span>
                      </>
                    )}
                  </button>

                  <p className="text-[11px] text-slate-700">
                    Metode Pembayaran:{' '}
                    <strong>{paymentLabel}</strong>
                    {' · '}No. Order:{' '}
                    <strong className="font-mono">{completedOrder.orderNumber}</strong>
                  </p>
                </div>

                <div className="border border-slate-200 rounded-xl p-5 space-y-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Nomor Pesanan</span>
                    <span className="font-mono font-semibold text-slate-900">
                      {completedOrder.orderNumber}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Pengiriman</span>
                    <span className="font-mono font-bold text-emerald-700">
                      {shippingUsd === 0 ? 'FREE DELIVERY' : activeConfig.shippingLabel}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Metode &amp; Mata Uang</span>
                    <span className="font-mono font-semibold text-slate-900">
                      {completedOrder.paymentMethod} · {completedOrder.currency}
                    </span>
                  </div>
                  <div className="pt-3 border-t border-slate-100 space-y-1 text-xs text-slate-600">
                    <p className="font-semibold text-slate-900">
                      Lokasi Pengiriman
                    </p>
                    <p className="text-emerald-700 font-medium">
                      Otomatis terkirim ke akun Admin &amp; akun Delivery
                    </p>
                  </div>
                  {completedOrder.notes && (
                    <div className="pt-3 border-t border-slate-100 space-y-1 text-xs text-slate-600">
                      <p className="font-semibold text-slate-900">
                        Catatan Tambahan
                      </p>
                      <p className="text-slate-700 whitespace-pre-wrap break-words">
                        {completedOrder.notes}
                      </p>
                    </div>
                  )}
                  <div className="pt-2 border-t border-slate-100 flex justify-between">
                    <span className="font-semibold text-slate-900">Total Tagihan</span>
                    <span className="font-mono tabular-nums font-bold text-slate-900">
                      {formatAmountByCurrency(
                        completedOrder.totalAmount,
                        completedOrder.currency
                      )}
                    </span>
                  </div>
                  <p className="pt-2 text-xs font-mono text-slate-400">
                    {effectiveMaster.storeName}
                  </p>
                </div>

                {completedOrder.paymentMethod === 'QR' && confirmedQrPayload && (
                  <AbaPayQrCard
                    amountUsd={completedOrder.totalAmount}
                    qrPayload={confirmedQrPayload}
                    referenceLabel={`Pesanan: ${completedOrder.orderNumber}`}
                    checkoutConfig={activeConfig}
                    masterConfig={effectiveMaster}
                  />
                )}

                <div className="flex flex-col gap-2.5">
                  <button
                    type="button"
                    onClick={() => {
                      resetAndClose();
                      onNavigate('orders');
                    }}
                    className="w-full py-2.5 px-4 text-sm font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 transition-colors cursor-pointer"
                  >
                    Lacak Status Pesanan
                  </button>
                </div>
              </div>
            );
          })()}
        </div>

        {/* Drawer Footer */}
        {step !== 'success' && cart.length > 0 && (
          <div className="p-6 border-t border-slate-200 bg-slate-50 space-y-4">
            {step === 'cart' ? (
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between text-slate-600">
                  <span>Subtotal QR ({primaryCurrency})</span>
                  <span className="font-mono tabular-nums font-semibold text-blue-700">
                    {formatPrimaryAmount(subtotalUsd, effectiveMaster)}
                  </span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>Subtotal CASH ({secondaryCurrency})</span>
                  <span className="font-mono tabular-nums font-semibold text-red-600">
                    {formatSecondaryAmount(subtotalUsd, effectiveMaster)}
                  </span>
                </div>
                {belowMinOrder && (
                  <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">
                    Minimal belanja {formatPrimaryAmount(minOrderUsd, effectiveMaster)}{' '}
                    (kurang{' '}
                    <span className="font-mono font-bold">
                      {formatPrimaryAmount(
                        Math.max(0, minOrderUsd - subtotalUsd),
                        effectiveMaster
                      )}
                    </span>
                    ).
                  </p>
                )}
              </div>
            ) : paymentMethod ? (
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between text-slate-600">
                  <span>Subtotal ({activeCurrency})</span>
                  <span className="font-mono tabular-nums">
                    {formatAmountByCurrency(
                      displaySubtotal,
                      activeCurrency,
                      activeCurrencySymbol
                    )}
                  </span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>Ongkos Kirim</span>
                  <span className="font-mono font-bold text-emerald-700">
                    {displayShipping === 0
                      ? 'FREE DELIVERY'
                      : formatAmountByCurrency(
                          displayShipping,
                          activeCurrency,
                          activeCurrencySymbol
                        )}
                  </span>
                </div>
                <div className="pt-2 border-t border-slate-200 flex justify-between font-bold text-slate-900">
                  <span>
                    Total {paymentMethod} ({activeCurrency})
                  </span>
                  <span
                    className={`font-mono tabular-nums text-base ${
                      isUsingSecondary ? 'text-red-600' : 'text-blue-700'
                    }`}
                  >
                    {formatAmountByCurrency(
                      displayTotal,
                      activeCurrency,
                      activeCurrencySymbol
                    )}
                  </span>
                </div>
              </div>
            ) : (
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between text-slate-600">
                  <span>Estimasi QR ({primaryCurrency})</span>
                  <span className="font-mono tabular-nums font-semibold text-blue-700">
                    {formatPrimaryAmount(totalUsd, effectiveMaster)}
                  </span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>Estimasi CASH ({secondaryCurrency})</span>
                  <span className="font-mono tabular-nums font-semibold text-red-600">
                    {formatSecondaryAmount(totalUsd, effectiveMaster)}
                  </span>
                </div>
              </div>
            )}

            {step === 'checkout' && errorMsg && (
              <p className="text-xs font-medium text-rose-800 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 leading-relaxed">
                {errorMsg}
              </p>
            )}

            {step === 'cart' ? (
              <button
                type="button"
                disabled={belowMinOrder}
                onClick={() => {
                  setPaymentMethod(null);
                  setPaymentMissingHighlight(false);
                  setErrorMsg(null);
                  setStep('checkout');
                }}
                className={`w-full py-3 px-4 text-sm font-semibold text-white rounded-lg transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${theme.primaryBtn}`}
              >
                {activeConfig.checkoutButtonLabel}
              </button>
            ) : (
              <button
                type="submit"
                form="checkout-form"
                disabled={submitting || uploadingTransferProof}
                className={`w-full py-3 px-4 text-sm font-semibold text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer ${
                  !paymentMethod
                    ? 'bg-slate-600 hover:bg-slate-700'
                    : paymentMethod === 'CASH'
                      ? 'bg-red-600 hover:bg-red-700'
                      : !transferProofImageUrl
                        ? 'bg-amber-600 hover:bg-amber-700'
                        : 'bg-emerald-600 hover:bg-emerald-700'
                }`}
              >
                {submitting
                  ? 'Memproses Pesanan...'
                  : !paymentMethod
                    ? 'Pilih Pembayaran Dulu (CASH / QR)'
                    : paymentMethod === 'QR' && !transferProofImageUrl
                      ? 'Unggah Bukti Transfer ABA/QR Dulu untuk Checkout'
                      : paymentMethod === 'QR'
                        ? `Bukti Transfer Siap ✓ · Checkout & Kirim ke Telegram · ${formatAmountByCurrency(
                            displayTotal,
                            activeCurrency,
                            activeCurrencySymbol
                          )}`
                        : `${activeConfig.submitButtonLabel} & Konfirmasi Telegram (CASH) · ${formatAmountByCurrency(
                            displayTotal,
                            activeCurrency,
                            activeCurrencySymbol
                          )}`}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

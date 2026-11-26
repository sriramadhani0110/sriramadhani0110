import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  BarChart3,
  Bluetooth,
  Box,
  Calendar,
  Check,
  CheckCircle2,
  ClipboardList,
  Clock,
  Coins,
  Copy,
  Crown,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  FolderKanban,
  Globe,
  Image as ImageIcon,
  KeyRound,
  Layers,
  LayoutGrid,
  LogIn,
  LogOut,
  MailCheck,
  Palette,
  RefreshCw,
  RotateCcw,
  Save,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Store,
  Tag,
  Trash2,
  Truck,
  Upload,
} from 'lucide-react';
import { signOut, type User } from 'firebase/auth';
import {
  collection,
  doc,
  getDocFromServer,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import type {
  CurrencyCode,
  StoreBackgroundConfig,
  StoreBanner,
  StoreCheckoutConfig,
  StoreHoursConfig,
  StoreMasterConfig,
  ThemeAccent,
} from '../types/marketplace';
import type { SiteMode } from '../App';
import {
  auth,
  db,
  FIREBASE_AUTH_PROVIDERS_URL,
  FIREBASE_AUTH_SETTINGS_URL,
  getAndroidChromeIntentUrl,
  handleFirestoreError,
  isAndroidDevice,
  isInAppMobileBrowser,
  isIosDevice,
  OperationType,
  registerMasterEmailPasswordSafe,
  resendVerificationEmailSafe,
  sendMasterPasswordResetSafe,
  signInWithEmailPasswordSafe,
  signInWithGoogleRedirectSafe,
  signInWithGoogleSafe,
} from '../lib/firebase';
import {
  copyTextToClipboard,
  getShareableOrigin,
  getShareablePortalUrl,
  isMasterEmail,
  MASTER_DATA_EMAIL,
} from '../lib/catalogSeed';
import {
  downloadSinglePortalDomainZip,
  type PortalZipTarget,
} from '../lib/portalZipExport';
import { broadcastCrossTabEvent } from '../lib/crossAccountSync';
import { exportMasterFirestoreBackup } from '../lib/masterBackupExport';
import {
  compressImageFileToDataUrl,
  CURRENCY_OPTIONS,
  CURRENCY_PRESETS,
  DEFAULT_CHECKOUT_CONFIG,
  DEFAULT_MASTER_CONFIG,
  DEFAULT_STORE_HOURS_CONFIG,
  formatPrimaryAmount,
  formatSecondaryAmount,
  isUsableDirectLogoUrl,
  mergeCheckoutConfig,
  mergeMasterConfig,
  THEME_ACCENT_STYLES,
} from '../lib/storeDefaults';
import { AdminBannerSettingsPanel } from './AdminBannerSettingsPanel';
import { AdminCheckoutSettingsPanel } from './AdminCheckoutSettingsPanel';
import { AdminStoreHoursPanel } from './AdminStoreHoursPanel';
import { AdminDashboardView, type AdminTab } from './AdminDashboardView';
import { PortalDownloadTemplatePanel } from './PortalDownloadTemplatePanel';
import { MasterWebsiteUrlPanel } from './MasterWebsiteUrlPanel';

interface MasterDashboardViewProps {
  user: User | null;
  isMaster: boolean;
  masterConfig: StoreMasterConfig;
  storeHoursConfig?: StoreHoursConfig;
  backgroundConfig?: StoreBackgroundConfig;
  initialAuthError?: string | null;
  onNavigatePortal: (mode: SiteMode) => void;
  onOpenPortalGuide?: () => void;
  onUserReloaded?: () => void;
}

type MasterOnlyTab =
  | 'branding'
  | 'website_url'
  | 'currency'
  | 'theme'
  | 'banners'
  | 'checkout'
  | 'hours'
  | 'portals';

type MasterEmbeddedAdminTab = Exclude<
  AdminTab,
  'banners' | 'checkout' | 'hours' | 'portal_templates'
>;

type MasterTab = MasterOnlyTab | MasterEmbeddedAdminTab;

const EMBEDDED_ADMIN_TABS: ReadonlySet<MasterTab> = new Set<MasterEmbeddedAdminTab>([
  'orders',
  'daily_history',
  'stats',
  'background',
  'products',
  'categories',
  'promotions',
  'journal_pos',
  'deliveries',
  'automation',
  'printer',
  'logs',
  'account',
]);

export function MasterDashboardView({
  user,
  isMaster,
  masterConfig,
  storeHoursConfig,
  backgroundConfig,
  initialAuthError,
  onNavigatePortal,
  onOpenPortalGuide,
  onUserReloaded,
}: MasterDashboardViewProps) {
  const [activeTab, setActiveTab] = useState<MasterTab>('branding');
  const [authMode, setAuthMode] = useState<'login' | 'activate'>('login');
  const [emailInput, setEmailInput] = useState<string>('Hananbintang30@gmail.com');
  const [passwordInput, setPasswordInput] = useState<string>('');
  const [showPassword, setShowPassword] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [redirectLoading, setRedirectLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(initialAuthError ?? null);
  const [authInfo, setAuthInfo] = useState<string | null>(null);
  const [showConsoleGuide, setShowConsoleGuide] = useState(false);
  const [unauthorizedHost, setUnauthorizedHost] = useState<string | null>(null);
  const [checkingVerify, setCheckingVerify] = useState(false);

  // Master Data Config Draft State
  const [draft, setDraft] = useState<StoreMasterConfig>(() =>
    mergeMasterConfig(masterConfig)
  );
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [savingMaster, setSavingMaster] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Embedded Banners & Checkout Config for complete Master control
  const [storeBanners, setStoreBanners] = useState<StoreBanner[]>([]);
  const [checkoutConfig, setCheckoutConfig] = useState<StoreCheckoutConfig>(() => ({
    ...DEFAULT_CHECKOUT_CONFIG,
  }));

  const liveOrigin = useMemo(() => {
    const cleanPerm = (draft.permanentStoreUrl || '').trim().replace(/\/+$/, '');
    if (cleanPerm && /^https:\/\//i.test(cleanPerm)) {
      return cleanPerm;
    }
    return getShareableOrigin();
  }, [draft.permanentStoreUrl]);
  const iosDevice = useMemo(() => isIosDevice(), []);
  const androidDevice = useMemo(() => isAndroidDevice(), []);
  const inAppBrowser = useMemo(() => isInAppMobileBrowser(), []);

  const [backingUp, setBackingUp] = useState<'json' | 'zip' | null>(null);
  const lastRemoteMasterRef = useRef<string>(JSON.stringify(mergeMasterConfig(masterConfig)));

  useEffect(() => {
    if (initialAuthError) {
      setAuthError(initialAuthError);
    }
  }, [initialAuthError]);

  useEffect(() => {
    const merged = mergeMasterConfig(masterConfig);
    lastRemoteMasterRef.current = JSON.stringify(merged);
    setDraft(merged);
  }, [masterConfig]);

  // Debounced Auto-Save Permanen ke Firestore untuk Master Data (2 detik setelah selesai mengubah)
  useEffect(() => {
    if (!user || !isMaster) return;
    const currentSnapshot = JSON.stringify(draft);
    if (currentSnapshot === lastRemoteMasterRef.current) return;
    const rate = Number(draft.exchangeRate);
    if (!draft.storeName.trim() || draft.storeName.trim().length < 2) return;
    if (!Number.isFinite(rate) || rate < 0.0001 || rate > 1000000) return;

    const timer = setTimeout(() => {
      const payload = {
        id: 'master' as const,
        storeName: draft.storeName.trim().slice(0, 80),
        storeTagline: draft.storeTagline.trim().slice(0, 140),
        storeLogoUrl: draft.storeLogoUrl.trim(),
        footerText: draft.footerText.trim().slice(0, 200),
        primaryCurrencyCode: draft.primaryCurrencyCode,
        primaryCurrencySymbol: (draft.primaryCurrencySymbol.trim() || '$').slice(0, 8),
        secondaryCurrencyCode: draft.secondaryCurrencyCode,
        secondaryCurrencySymbol: (draft.secondaryCurrencySymbol.trim() || 'KHR').slice(0, 8),
        exchangeRate: rate,
        themeAccent: draft.themeAccent,
        storeAddress: draft.storeAddress.trim().slice(0, 200),
        storeHours: draft.storeHours.trim().slice(0, 80),
        telegramOrderUrl:
          draft.telegramOrderUrl.trim().startsWith('https://')
            ? draft.telegramOrderUrl.trim().slice(0, 200)
            : '',
        permanentStoreUrl:
          (draft.permanentStoreUrl || '').trim().startsWith('https://')
            ? (draft.permanentStoreUrl || '').trim().slice(0, 240)
            : '',
        announcementBarText: draft.announcementBarText.trim().slice(0, 160),
        maintenanceMode: Boolean(draft.maintenanceMode),
        updatedBy: (user.email || MASTER_DATA_EMAIL).slice(0, 128),
        updatedAt: serverTimestamp(),
      };
      void setDoc(doc(db, 'storeConfig', 'master'), payload)
        .then(() => {
          lastRemoteMasterRef.current = currentSnapshot;
          // Auto-sync USD/KHR exchange rate to storeConfig/checkout so all 4 accounts stay unified
          if (
            draft.primaryCurrencyCode === 'USD' &&
            draft.secondaryCurrencyCode === 'KHR' &&
            rate >= 1000 &&
            rate <= 10000 &&
            Math.round(rate) !== checkoutConfig.exchangeRateKhr
          ) {
            void setDoc(doc(db, 'storeConfig', 'checkout'), {
              ...checkoutConfig,
              id: 'checkout',
              exchangeRateKhr: Math.round(rate),
              updatedBy: (user.email || MASTER_DATA_EMAIL).slice(0, 128),
              updatedAt: serverTimestamp(),
            }).catch(() => undefined);
          }
          broadcastCrossTabEvent({ type: 'revision_broadcast', source: 'master_autosave' });
          setToastMsg('Perubahan Master Data tersimpan otomatis permanen & langsung aktif di semua akun.');
          setTimeout(() => setToastMsg(null), 2800);
        })
        .catch(() => undefined);
    }, 2000);

    return () => clearTimeout(timer);
  }, [draft, user, isMaster, checkoutConfig]);

  useEffect(() => {
    if (!user || !isMaster) return;

    const unsubBanners = onSnapshot(
      collection(db, 'storeBanners'),
      (snap) => {
        const list = snap.docs
          .map((d) => d.data() as StoreBanner)
          .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
        setStoreBanners(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'storeBanners')
    );

    const unsubCheckout = onSnapshot(
      doc(db, 'storeConfig', 'checkout'),
      (snap) => {
        if (snap.exists()) {
          setCheckoutConfig(
            mergeCheckoutConfig(snap.data() as Partial<StoreCheckoutConfig>)
          );
        } else {
          setCheckoutConfig({ ...DEFAULT_CHECKOUT_CONFIG });
        }
      },
      (err) => handleFirestoreError(err, OperationType.GET, 'storeConfig/checkout')
    );

    return () => {
      unsubBanners();
      unsubCheckout();
    };
  }, [user, isMaster]);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg((prev) => (prev === msg ? null : prev)), 4000);
  };

  const handleCopyLink = async (key: string, url: string) => {
    await copyTextToClipboard(url);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 1800);
  };

  const handleEmailPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthInfo(null);
    setShowConsoleGuide(false);

    const cleanEmail = emailInput.trim().toLowerCase();
    if (!isMasterEmail(cleanEmail)) {
      setAuthError(
        `Email "${emailInput.trim()}" tidak terdaftar sebagai Akun Master Data. Gunakan email Master resmi: ${MASTER_DATA_EMAIL}.`
      );
      return;
    }
    if (passwordInput.length < 6) {
      setAuthError('Password minimal 6 karakter.');
      return;
    }

    setAuthLoading(true);
    if (authMode === 'login') {
      const res = await signInWithEmailPasswordSafe(cleanEmail, passwordInput);
      setAuthLoading(false);
      if (res.errorMessage) {
        setAuthError(res.errorMessage);
        if (res.providerNotEnabled) setShowConsoleGuide(true);
        if (res.userNotFound) setAuthMode('activate');
      }
    } else {
      const res = await registerMasterEmailPasswordSafe(cleanEmail, passwordInput);
      setAuthLoading(false);
      if (res.errorMessage) {
        setAuthError(res.errorMessage);
        if (res.providerNotEnabled) setShowConsoleGuide(true);
      } else if (res.verificationSent) {
        setAuthInfo(
          `Akun Master Data berhasil diaktivasi! Link verifikasi telah dikirim ke ${cleanEmail}.`
        );
      }
    }
  };

  const handleForgotPassword = async () => {
    setAuthError(null);
    setAuthInfo(null);
    const cleanEmail = emailInput.trim().toLowerCase();
    if (!isMasterEmail(cleanEmail)) {
      setAuthError(`Masukkan email Master resmi (${MASTER_DATA_EMAIL}) terlebih dahulu.`);
      return;
    }
    setAuthLoading(true);
    const res = await sendMasterPasswordResetSafe(cleanEmail);
    setAuthLoading(false);
    if (res.ok) {
      setAuthInfo(res.message);
    } else {
      setAuthError(res.message);
      if (res.message.includes('Firebase Console')) setShowConsoleGuide(true);
    }
  };

  const handleGoogleSignIn = async () => {
    setAuthError(null);
    setAuthInfo(null);
    setUnauthorizedHost(null);
    setGoogleLoading(true);
    const { errorMessage, unauthorizedDomain } = await signInWithGoogleSafe();
    setGoogleLoading(false);
    if (unauthorizedDomain) {
      setUnauthorizedHost(unauthorizedDomain);
    }
    if (errorMessage) {
      setAuthError(errorMessage);
    }
  };

  const handleGoogleRedirectSignIn = async () => {
    setAuthError(null);
    setAuthInfo(null);
    setRedirectLoading(true);
    const { errorMessage } = await signInWithGoogleRedirectSafe();
    setRedirectLoading(false);
    if (errorMessage) {
      setAuthError(errorMessage);
    }
  };

  const handleCheckVerification = async () => {
    if (!user) return;
    setCheckingVerify(true);
    setAuthError(null);
    setAuthInfo(null);
    try {
      await user.reload();
      if (auth.currentUser?.emailVerified) {
        onUserReloaded?.();
      } else {
        setAuthError(
          'Email belum terverifikasi. Buka inbox/spam di Hananbintang30@gmail.com, klik tautan verifikasi dari Firebase, lalu tekan tombol ini lagi.'
        );
      }
    } catch {
      setAuthError('Gagal memeriksa status verifikasi. Coba muat ulang halaman.');
    } finally {
      setCheckingVerify(false);
    }
  };

  const handleResendVerification = async () => {
    if (!user) return;
    setCheckingVerify(true);
    setAuthError(null);
    const res = await resendVerificationEmailSafe(user);
    setCheckingVerify(false);
    if (res.ok) setAuthInfo(res.message);
    else setAuthError(res.message);
  };

  const handleUploadLogo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFormError(null);
    setUploadingLogo(true);
    try {
      const dataUrl = await compressImageFileToDataUrl(file, {
        maxWidth: 420,
        maxHeight: 420,
        maxChars: 220000,
        initialQuality: 0.85,
      });
      setDraft((prev) => ({ ...prev, storeLogoUrl: dataUrl }));
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : 'Gagal memproses file logo.'
      );
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleSaveMasterConfig = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setFormError(null);

    const cleanName = draft.storeName.trim().slice(0, 80);
    if (cleanName.length < 2) {
      setFormError('Nama toko minimal 2 karakter.');
      return;
    }

    const parsedRate = Number(draft.exchangeRate);
    if (!Number.isFinite(parsedRate) || parsedRate < 0.0001 || parsedRate > 1000000) {
      setFormError('Kurs konversi harus angka valid antara 0.0001 sampai 1.000.000.');
      return;
    }

    const cleanTelegramUrl = draft.telegramOrderUrl.trim().slice(0, 200);
    if (cleanTelegramUrl && !cleanTelegramUrl.startsWith('https://')) {
      setFormError('Link Telegram harus diawali https:// (contoh: https://t.me/AlpamartTM03).');
      return;
    }

    const rawLogo = draft.storeLogoUrl.trim();
    const cleanLogo = rawLogo || DEFAULT_MASTER_CONFIG.storeLogoUrl;
    if (rawLogo && !isUsableDirectLogoUrl(rawLogo)) {
      setFormError(
        'Logo harus berupa unggahan file gambar atau link langsung file gambar (.jpg/.png/.webp), bukan link halaman seperti prnt.sc.'
      );
      return;
    }

    setSavingMaster(true);
    try {
      const payload = {
        id: 'master' as const,
        storeName: cleanName,
        storeTagline: draft.storeTagline.trim().slice(0, 140),
        storeLogoUrl: cleanLogo,
        footerText: draft.footerText.trim().slice(0, 200),
        primaryCurrencyCode: draft.primaryCurrencyCode,
        primaryCurrencySymbol:
          draft.primaryCurrencySymbol.trim().slice(0, 8) || draft.primaryCurrencyCode,
        secondaryCurrencyCode: draft.secondaryCurrencyCode,
        secondaryCurrencySymbol:
          draft.secondaryCurrencySymbol.trim().slice(0, 8) ||
          draft.secondaryCurrencyCode,
        exchangeRate: Number(parsedRate.toFixed(4)),
        themeAccent: draft.themeAccent,
        storeAddress: draft.storeAddress.trim().slice(0, 200),
        storeHours: draft.storeHours.trim().slice(0, 80),
        telegramOrderUrl: cleanTelegramUrl,
        permanentStoreUrl:
          (draft.permanentStoreUrl || '').trim().startsWith('https://')
            ? (draft.permanentStoreUrl || '').trim().slice(0, 240)
            : '',
        announcementBarText: draft.announcementBarText.trim().slice(0, 160),
        maintenanceMode: Boolean(draft.maintenanceMode),
        updatedBy: (user?.email || MASTER_DATA_EMAIL).slice(0, 128),
        updatedAt: serverTimestamp(),
      };

      await setDoc(doc(db, 'storeConfig', 'master'), payload);
      if (
        draft.primaryCurrencyCode === 'USD' &&
        draft.secondaryCurrencyCode === 'KHR' &&
        parsedRate >= 1000 &&
        parsedRate <= 10000 &&
        Math.round(parsedRate) !== checkoutConfig.exchangeRateKhr
      ) {
        await setDoc(doc(db, 'storeConfig', 'checkout'), {
          ...checkoutConfig,
          id: 'checkout',
          exchangeRateKhr: Math.round(parsedRate),
          updatedBy: (user?.email || MASTER_DATA_EMAIL).slice(0, 128),
          updatedAt: serverTimestamp(),
        }).catch(() => undefined);
      }
      broadcastCrossTabEvent({ type: 'revision_broadcast', source: 'master_manual_save' });
      showToast(
        'Pengaturan Master Data (Nama, Logo, Mata Uang & Tema) berhasil disimpan dan langsung aktif di seluruh akun!'
      );
    } catch (err) {
      try {
        handleFirestoreError(err, OperationType.WRITE, 'storeConfig/master');
      } catch (wrapped) {
        setFormError(
          wrapped instanceof Error
            ? wrapped.message
            : 'Gagal menyimpan konfigurasi Master Data.'
        );
      }
    } finally {
      setSavingMaster(false);
    }
  };

  const handleSavePermanentUrl = async (
    nextUrl: string
  ): Promise<{ ok: boolean; error?: string }> => {
    const trimmed = nextUrl.trim().replace(/\/+$/, '').slice(0, 240);
    if (trimmed && !trimmed.startsWith('https://')) {
      return {
        ok: false,
        error: 'Link URL website wajib diawali https:// (contoh: https://alpamarttrimulia.store).',
      };
    }

    setSavingMaster(true);
    setFormError(null);
    try {
      // Read the latest live server Master config first so replacing the URL NEVER resets
      // storeName, logo, currency, hours, or any other setting back to defaults/0.
      let baseConfig: StoreMasterConfig = { ...draft };
      try {
        const liveSnap = await getDocFromServer(doc(db, 'storeConfig', 'master'));
        if (liveSnap.exists()) {
          baseConfig = mergeMasterConfig(liveSnap.data() as Partial<StoreMasterConfig>);
        }
      } catch {
        // Fall back to current live masterConfig prop / draft
        baseConfig = mergeMasterConfig(masterConfig || draft);
      }

      const cleanName = baseConfig.storeName.trim().slice(0, 80) || DEFAULT_MASTER_CONFIG.storeName;
      const parsedRate = Number(baseConfig.exchangeRate);
      const safeRate =
        Number.isFinite(parsedRate) && parsedRate >= 0.0001 && parsedRate <= 1000000
          ? Number(parsedRate.toFixed(4))
          : DEFAULT_MASTER_CONFIG.exchangeRate;
      const rawLogo = baseConfig.storeLogoUrl.trim();
      const cleanLogo =
        rawLogo && isUsableDirectLogoUrl(rawLogo)
          ? rawLogo
          : DEFAULT_MASTER_CONFIG.storeLogoUrl;
      const cleanTelegramUrl = baseConfig.telegramOrderUrl.trim().startsWith('https://')
        ? baseConfig.telegramOrderUrl.trim().slice(0, 200)
        : '';

      const nextDraft: StoreMasterConfig = {
        ...baseConfig,
        storeName: cleanName,
        storeLogoUrl: cleanLogo,
        exchangeRate: safeRate,
        telegramOrderUrl: cleanTelegramUrl,
        permanentStoreUrl: trimmed,
      };

      const payload = {
        id: 'master' as const,
        storeName: cleanName,
        storeTagline: nextDraft.storeTagline.trim().slice(0, 140),
        storeLogoUrl: cleanLogo,
        footerText: nextDraft.footerText.trim().slice(0, 200),
        primaryCurrencyCode: nextDraft.primaryCurrencyCode,
        primaryCurrencySymbol:
          nextDraft.primaryCurrencySymbol.trim().slice(0, 8) ||
          nextDraft.primaryCurrencyCode,
        secondaryCurrencyCode: nextDraft.secondaryCurrencyCode,
        secondaryCurrencySymbol:
          nextDraft.secondaryCurrencySymbol.trim().slice(0, 8) ||
          nextDraft.secondaryCurrencyCode,
        exchangeRate: safeRate,
        themeAccent: nextDraft.themeAccent,
        storeAddress: nextDraft.storeAddress.trim().slice(0, 200),
        storeHours: nextDraft.storeHours.trim().slice(0, 80),
        telegramOrderUrl: cleanTelegramUrl,
        permanentStoreUrl: trimmed,
        announcementBarText: nextDraft.announcementBarText.trim().slice(0, 160),
        maintenanceMode: Boolean(nextDraft.maintenanceMode),
        updatedBy: (user?.email || MASTER_DATA_EMAIL).slice(0, 128),
        updatedAt: serverTimestamp(),
      };

      await setDoc(doc(db, 'storeConfig', 'master'), payload);
      lastRemoteMasterRef.current = JSON.stringify(nextDraft);
      setDraft(nextDraft);
      broadcastCrossTabEvent({
        type: 'revision_broadcast',
        source: 'master_url_save',
      });
      showToast(
        trimmed
          ? `Link URL website diganti online ke ${trimmed} — seluruh data toko tetap utuh & langsung tersinkron ke semua akun dan link!`
          : 'Link URL website dikembalikan ke URL Default Server di seluruh akun (semua data tetap utuh).'
      );
      return { ok: true };
    } catch (err) {
      try {
        handleFirestoreError(err, OperationType.WRITE, 'storeConfig/master');
      } catch (wrapped) {
        const msg =
          wrapped instanceof Error
            ? wrapped.message
            : 'Gagal menyimpan link URL website secara online.';
        setFormError(msg);
        return { ok: false, error: msg };
      }
      return { ok: false, error: 'Gagal menyimpan link URL website secara online.' };
    } finally {
      setSavingMaster(false);
    }
  };

  const handleResetDefaults = () => {
    setDraft({ ...DEFAULT_MASTER_CONFIG });
    setFormError(null);
  };

  // GATE 1: Not Signed In
  if (!user) {
    return (
      <div className="min-h-screen bg-slate-950/65 flex items-center justify-center p-4 sm:p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-2xl">
          <div className="h-1.5 w-full bg-gradient-to-r from-amber-500 via-red-600 to-blue-700" />
          <div className="p-6 sm:p-8 space-y-5">
            <div className="text-center space-y-2">
              <img
                src={masterConfig.storeLogoUrl || DEFAULT_MASTER_CONFIG.storeLogoUrl}
                alt={masterConfig.storeName}
                referrerPolicy="no-referrer"
                onError={(e) => {
                  const img = e.currentTarget;
                  if (!img.dataset.fallbackApplied) {
                    img.dataset.fallbackApplied = '1';
                    img.src = DEFAULT_MASTER_CONFIG.storeLogoUrl;
                  }
                }}
                className="w-16 h-16 rounded-2xl object-contain bg-white border border-slate-200 p-1 shadow-xs mx-auto"
              />
              <p className="text-xs font-bold uppercase tracking-wider text-amber-700 inline-flex items-center justify-center gap-1">
                <Crown className="w-3.5 h-3.5" />
                <span>Portal Master Data · Super Control</span>
              </p>
              <h1 className="font-display text-xl font-bold text-slate-900">
                Masuk Akun Master Data
              </h1>
              <p className="text-xs text-slate-600 leading-relaxed">
                Kendali penuh untuk mengubah <strong>Nama Toko, Logo, Mata Uang, Kurs, Tema Warna, Banner Depan, hingga Barcode Checkout</strong>.
              </p>
            </div>

            {/* Mode Switcher: Login vs First-Time Activation */}
            <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-100 rounded-lg text-xs font-semibold">
              <button
                type="button"
                onClick={() => {
                  setAuthMode('login');
                  setAuthError(null);
                }}
                className={`py-2 px-2 rounded-md transition-colors cursor-pointer ${
                  authMode === 'login'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Masuk (Password)
              </button>
              <button
                type="button"
                onClick={() => {
                  setAuthMode('activate');
                  setAuthError(null);
                }}
                className={`py-2 px-2 rounded-md transition-colors cursor-pointer ${
                  authMode === 'activate'
                    ? 'bg-white text-amber-800 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Aktivasi Pertama
              </button>
            </div>

            {/* Email & Password Form (Works natively in Safari iPhone with zero popups!) */}
            <form onSubmit={handleEmailPasswordSubmit} className="space-y-3.5">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Email Master Data
                </label>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  placeholder="Hananbintang30@gmail.com"
                  className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-semibold text-slate-700">
                    {authMode === 'login'
                      ? 'Password Master Data'
                      : 'Buat Password Baru (Minimal 6 karakter)'}
                  </label>
                  {authMode === 'login' && (
                    <button
                      type="button"
                      onClick={handleForgotPassword}
                      className="text-[11px] font-medium text-blue-700 hover:underline cursor-pointer"
                    >
                      Lupa password?
                    </button>
                  )}
                </div>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={6}
                    autoComplete={
                      authMode === 'login' ? 'current-password' : 'new-password'
                    }
                    value={passwordInput}
                    onChange={(e) => setPasswordInput(e.target.value)}
                    placeholder="Masukkan password Anda"
                    className="w-full pl-3.5 pr-10 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Sembunyikan password' : 'Tampilkan password'}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-500 hover:text-slate-800 cursor-pointer"
                  >
                    {showPassword ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>

              {inAppBrowser && androidDevice && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-950 space-y-2">
                  <p className="font-semibold">
                    Dibuka di Browser Dalam Aplikasi (WhatsApp / Telegram)
                  </p>
                  <a
                    href={getAndroidChromeIntentUrl(`${liveOrigin}/master`)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-white bg-blue-700 hover:bg-blue-800 rounded-md"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Buka di Google Chrome Android</span>
                  </a>
                </div>
              )}

              {authError && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800 leading-relaxed space-y-2">
                  <p>{authError}</p>
                  {unauthorizedHost && (
                    <a
                      href={FIREBASE_AUTH_SETTINGS_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-semibold text-blue-700 underline"
                    >
                      <span>Buka Firebase Authorized Domains ({unauthorizedHost})</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              )}

              {authInfo && (
                <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800 leading-relaxed">
                  {authInfo}
                </div>
              )}

              {showConsoleGuide && (
                <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-950 space-y-1.5">
                  <p className="font-bold">
                    Cara Mengaktifkan Login Email &amp; Password (1 Kali Saja):
                  </p>
                  <ol className="list-decimal list-inside space-y-1 leading-relaxed text-amber-900">
                    <li>
                      Buka{' '}
                      <a
                        href={FIREBASE_AUTH_PROVIDERS_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-blue-700 underline"
                      >
                        Firebase Console → Authentication → Sign-in method
                      </a>
                    </li>
                    <li>
                      Klik <strong>Add new provider</strong> → pilih{' '}
                      <strong>Email/Password</strong> → aktifkan <strong>Enable</strong> → klik <strong>Save</strong>.
                    </li>
                    <li>
                      Kembali ke sini, pilih tab <strong>Aktivasi Pertama</strong>, masukkan{' '}
                      <code className="font-mono">Hananbintang30@gmail.com</code> &amp; password Anda — atau langsung klik{' '}
                      <strong>Masuk dengan Google</strong> di bawah sekarang juga!
                    </li>
                  </ol>
                </div>
              )}

              <button
                type="submit"
                disabled={authLoading || googleLoading || redirectLoading}
                className="w-full inline-flex items-center justify-center gap-2 py-3 px-4 text-sm font-semibold text-white bg-slate-900 hover:bg-blue-700 rounded-lg transition-colors cursor-pointer disabled:opacity-60"
              >
                <KeyRound className="w-4 h-4" />
                <span>
                  {authLoading
                    ? 'Memverifikasi...'
                    : authMode === 'login'
                      ? 'Masuk dengan Email & Password'
                      : 'Aktivasi Password Master Data'}
                </span>
              </button>
            </form>

            <div className="relative py-1">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-slate-200" />
              </div>
              <div className="relative flex justify-center text-[11px] uppercase">
                <span className="bg-white px-2.5 text-slate-400 font-semibold">
                  Atau Masuk Instan (Langsung Terverifikasi)
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <button
                type="button"
                disabled={authLoading || googleLoading || redirectLoading}
                onClick={handleGoogleSignIn}
                className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 text-xs sm:text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors cursor-pointer disabled:opacity-60"
              >
                <LogIn className="w-4 h-4" />
                <span>
                  {googleLoading
                    ? 'Membuka Google...'
                    : 'Masuk dengan Google (Hananbintang30@gmail.com)'}
                </span>
              </button>

              {(iosDevice || inAppBrowser) && (
                <button
                  type="button"
                  disabled={authLoading || googleLoading || redirectLoading}
                  onClick={handleGoogleRedirectSignIn}
                  className="w-full inline-flex items-center justify-center gap-2 py-2 px-4 text-xs font-semibold text-slate-700 bg-slate-100 border border-slate-200 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer disabled:opacity-60"
                >
                  <Globe className="w-3.5 h-3.5 text-blue-700" />
                  <span>
                    {redirectLoading
                      ? 'Mengalihkan ke Google...'
                      : 'Login Alternatif Safari iPhone (Tanpa Pop-up)'}
                  </span>
                </button>
              )}
            </div>

            <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
              <button
                type="button"
                onClick={() => onNavigatePortal('customer')}
                className="hover:text-slate-900 font-medium cursor-pointer"
              >
                ← Kembali ke Toko
              </button>
              <button
                type="button"
                onClick={() => onNavigatePortal('admin')}
                className="text-blue-700 hover:underline font-medium cursor-pointer"
              >
                Portal Admin →
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // GATE 2: Signed in as Master Email via Email/Password, pending 1-time email verification
  if (isMasterEmail(user.email) && !user.emailVerified) {
    return (
      <div className="min-h-screen bg-slate-950/65 flex items-center justify-center p-4 sm:p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 space-y-5 text-center shadow-2xl">
          <MailCheck className="w-11 h-11 text-amber-600 mx-auto" />
          <div className="space-y-1.5">
            <p className="text-xs font-bold uppercase tracking-wider text-amber-700">
              Verifikasi 1 Kali Akun Master Data
            </p>
            <h1 className="font-display text-xl font-bold text-slate-900">
              Cek Email {user.email}
            </h1>
            <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
              Demi keamanan database toko, klik tautan verifikasi yang dikirim Firebase ke kotak masuk <strong>{user.email}</strong> (cek juga folder Spam), lalu tekan tombol di bawah.
            </p>
          </div>

          {authError && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-left text-xs text-rose-800">
              {authError}
            </div>
          )}
          {authInfo && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-left text-xs text-emerald-800">
              {authInfo}
            </div>
          )}

          <div className="space-y-2.5">
            <button
              type="button"
              disabled={checkingVerify}
              onClick={handleCheckVerification}
              className="w-full inline-flex items-center justify-center gap-2 py-3 px-4 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer disabled:opacity-60"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>
                {checkingVerify
                  ? 'Memeriksa...'
                  : 'Saya Sudah Klik Verifikasi — Masuk'}
              </span>
            </button>
            <button
              type="button"
              disabled={checkingVerify}
              onClick={handleResendVerification}
              className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer disabled:opacity-60"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Kirim Ulang Email Verifikasi</span>
            </button>
            <button
              type="button"
              onClick={handleGoogleSignIn}
              className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-lg cursor-pointer"
            >
              <LogIn className="w-3.5 h-3.5" />
              <span>Atau Masuk Langsung via Google (Otomatis Terverifikasi)</span>
            </button>
            <button
              type="button"
              onClick={() => signOut(auth)}
              className="w-full py-2 text-xs font-medium text-slate-500 hover:text-slate-800 cursor-pointer"
            >
              Keluar
            </button>
          </div>
        </div>
      </div>
    );
  }

  // GATE 3: Signed in, but NOT authorized as Master Data
  if (!isMaster) {
    return (
      <div className="min-h-screen bg-slate-950/65 flex items-center justify-center p-4 sm:p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 space-y-5 text-center shadow-2xl">
          <ShieldAlert className="w-10 h-10 text-red-600 mx-auto" />
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-red-600">
              Akses Khusus Master Data
            </p>
            <h1 className="font-display text-xl font-bold text-slate-900">
              Akun Tidak Memiliki Izin Master Data
            </h1>
            <p className="text-sm text-slate-600">
              Akun <span className="font-mono text-slate-900">{user.email}</span> bukan akun Master Data. Silakan masuk menggunakan <strong>Hananbintang30@gmail.com</strong>.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => signOut(auth)}
              className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 text-sm font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
              <span>Keluar &amp; Ganti ke Akun Master Data</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigatePortal('customer')}
              className="w-full py-2.5 px-4 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 cursor-pointer"
            >
              Kembali ke Halaman Toko
            </button>
          </div>
        </div>
      </div>
    );
  }

  const activeThemeStyle = THEME_ACCENT_STYLES[draft.themeAccent];

  const portalLinks = [
    {
      key: 'master',
      mode: 'master' as SiteMode,
      label: 'Portal Master Data (Super Control)',
      url: getShareablePortalUrl('master', liveOrigin),
      desc: 'Ubah nama toko, logo, mata uang global, kurs, tema, banner, dan checkout.',
    },
    {
      key: 'admin',
      mode: 'admin' as SiteMode,
      label: 'Situs Admin',
      url: getShareablePortalUrl('admin', liveOrigin),
      desc: 'Kelola pesanan masuk, stok produk, promo, laporan CSV, dan printer bill.',
    },
    {
      key: 'delivery',
      mode: 'delivery' as SiteMode,
      label: 'Situs Kurir Deliveri',
      url: getShareablePortalUrl('delivery', liveOrigin),
      desc: 'Khusus kurir lapangan untuk lihat lokasi GPS & unggah foto bukti kirim.',
    },
    {
      key: 'customer',
      mode: 'customer' as SiteMode,
      label: 'Situs Pelanggan (Toko Online)',
      url: getShareablePortalUrl('customer', liveOrigin),
      desc: 'Halaman belanja publik yang siap dibuka di Safari iPhone, Android & Windows.',
    },
  ];

  // MASTER DATA DASHBOARD
  return (
    <div className="min-h-screen bg-transparent flex flex-col lg:flex-row">
      {/* Sidebar */}
      <aside className="w-full lg:w-72 bg-slate-950/95 text-white shrink-0 flex flex-col">
        <div className="p-5 border-b border-slate-800 space-y-2">
          <div className="flex items-center gap-2.5">
            <img
              src={draft.storeLogoUrl || DEFAULT_MASTER_CONFIG.storeLogoUrl}
              alt={draft.storeName}
              referrerPolicy="no-referrer"
              onError={(e) => {
                const img = e.currentTarget;
                if (!img.dataset.fallbackApplied) {
                  img.dataset.fallbackApplied = '1';
                  img.src = DEFAULT_MASTER_CONFIG.storeLogoUrl;
                }
              }}
              className="w-10 h-10 rounded-xl object-contain bg-white p-0.5 shrink-0 border border-slate-700"
            />
            <div className="min-w-0">
              <div className="inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-amber-400">
                <Crown className="w-3.5 h-3.5 shrink-0" />
                <span>Akun Master Data</span>
              </div>
              <p className="font-display text-sm font-bold text-white truncate">
                {draft.storeName}
              </p>
            </div>
          </div>
          <p className="font-mono text-[11px] text-slate-400 truncate">
            {user.email}
          </p>
        </div>

        <nav className="p-3 flex lg:flex-col gap-1 overflow-x-auto">
          <p className="hidden lg:block px-3 pt-1 pb-1 text-[10px] font-bold uppercase tracking-wider text-amber-400/80">
            Pengaturan Master
          </p>
          {(
            [
              ['branding', 'Nama & Logo Toko', Store],
              ['website_url', 'Ganti Link URL Website', Globe],
              ['currency', 'Mata Uang & Kurs', Coins],
              ['theme', 'Tema & Tampilan', Palette],
              ['banners', 'Banner Depan', ImageIcon],
              ['checkout', 'Checkout & Barcode', Sliders],
              ['hours', 'Jam Buka & Tutup', Clock],
              ['portals', 'Template Download Portal', Download],
            ] as const
          ).map(([id, label, Icon]) => {
            const active = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={`flex items-center gap-2.5 px-3 py-2 text-xs sm:text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  active
                    ? 'bg-amber-500 text-slate-950 font-semibold'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{label}</span>
              </button>
            );
          })}

          <p className="hidden lg:block px-3 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-emerald-400/80">
            Semua Fitur Toko (Edit &amp; Hapus Online)
          </p>
          {(
            [
              ['orders', 'Antrean Pesanan', ClipboardList],
              ['daily_history', 'Riwayat per Tanggal', Calendar],
              ['stats', 'Statistik & CSV', BarChart3],
              ['background', 'Background Latar', Layers],
              ['products', 'Katalog Produk & Foto', Box],
              ['categories', 'Kategori Produk', FolderKanban],
              ['promotions', 'Promosi & Diskon', Tag],
              ['journal_pos', 'Integrasi Journal POS', RefreshCw],
              ['deliveries', 'Kurir Delivery', Truck],
              ['automation', 'Otomasi Toko', Settings],
              ['printer', 'Printer Thermal', Bluetooth],
              ['logs', 'Log Otomasi', FileText],
              ['account', 'Akun Admin & Telegram', ShieldCheck],
            ] as const
          ).map(([id, label, Icon]) => {
            const active = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={`flex items-center gap-2.5 px-3 py-2 text-xs sm:text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  active
                    ? 'bg-emerald-500 text-slate-950 font-semibold'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 mt-auto border-t border-slate-800 hidden lg:block space-y-2">
          <button
            type="button"
            onClick={() => onNavigatePortal('admin')}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-600 rounded-lg transition-colors cursor-pointer"
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Buka Portal Admin</span>
          </button>
          <button
            type="button"
            onClick={() => signOut(auth)}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-300 bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Keluar Master Data</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8 space-y-6">
        {/* Header (shown for Master-only tabs; embedded Admin tabs render their own contextual header) */}
        {!EMBEDDED_ADMIN_TABS.has(activeTab) && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold text-amber-700">
              Master Data Super Control · Hanya Master yang Bisa Edit &amp; Hapus Online · Sinkron Real-Time ke Semua Akun
            </p>
            <h1 className="font-display text-xl sm:text-2xl font-bold text-slate-900 mt-0.5">
              {activeTab === 'branding'
                ? 'Ubah Nama Toko, Logo & Info Operasional'
                : activeTab === 'website_url'
                  ? 'Ganti Link URL Website Secara Online'
                  : activeTab === 'currency'
                    ? 'Pengaturan Mata Uang Global & Kurs'
                    : activeTab === 'theme'
                      ? 'Tema Warna & Gaya Tampilan Toko'
                      : activeTab === 'banners'
                        ? 'Banner Slider Halaman Depan'
                        : activeTab === 'checkout'
                          ? 'Pengaturan Keranjang, Checkout & Barcode Pembayaran'
                          : activeTab === 'hours'
                            ? 'Pengaturan Jam Buka & Tutup Toko'
                            : 'Akses Semua Portal (Master, Admin, Delivery, Pelanggan)'}
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {(activeTab === 'branding' ||
              activeTab === 'currency' ||
              activeTab === 'theme') && (
              <>
                <button
                  type="button"
                  onClick={handleResetDefaults}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Reset Default</span>
                </button>
                <button
                  type="button"
                  disabled={savingMaster}
                  onClick={() => handleSaveMasterConfig()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer disabled:opacity-60"
                >
                  <Save className="w-4 h-4" />
                  <span>
                    {savingMaster ? 'Menyimpan...' : 'Simpan Semua Perubahan'}
                  </span>
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => signOut(auth)}
              className="lg:hidden inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Keluar</span>
            </button>
          </div>
        </div>
        )}

        {toastMsg && (
          <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-xl text-xs sm:text-sm font-medium text-emerald-900 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{toastMsg}</span>
          </div>
        )}

        {formError && (
          <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-xs sm:text-sm font-medium text-rose-800">
            {formError}
          </div>
        )}

        {/* TAB 1: BRANDING (NAMA, LOGO, INFO TOKO) */}
        {activeTab === 'branding' && (
          <form onSubmit={handleSaveMasterConfig} className="space-y-6">
            {/* Live Navbar Preview */}
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs">
              <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-700">
                  Preview Header Toko Secara Langsung
                </span>
                <span className="font-mono text-slate-500">
                  {draft.primaryCurrencyCode} / {draft.secondaryCurrencyCode}
                </span>
              </div>
              {draft.announcementBarText.trim() && (
                <div className="bg-slate-900 text-white text-center text-xs font-medium py-1.5 px-4">
                  {draft.announcementBarText}
                </div>
              )}
              <div className={`h-1.5 w-full ${activeThemeStyle.topBar}`} />
              <div className="px-5 py-4 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  {draft.storeLogoUrl ? (
                    <img
                      src={
                        isUsableDirectLogoUrl(draft.storeLogoUrl)
                          ? draft.storeLogoUrl
                          : DEFAULT_MASTER_CONFIG.storeLogoUrl
                      }
                      alt="Preview Logo Toko"
                      onError={(e) => {
                        const img = e.currentTarget;
                        if (img.dataset.fallbackApplied) return;
                        img.dataset.fallbackApplied = '1';
                        img.src = DEFAULT_MASTER_CONFIG.storeLogoUrl;
                      }}
                      className="w-10 h-10 rounded-lg object-contain border border-slate-200 bg-white p-0.5 shrink-0"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-lg bg-slate-900 text-white font-display font-bold text-sm flex items-center justify-center shrink-0">
                      {(draft.storeName || 'AT').slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="font-display text-base font-bold text-slate-900 truncate">
                      {draft.storeName || 'Nama Toko'}
                    </p>
                    <p className="text-[11px] text-slate-500 truncate">
                      {draft.storeTagline || 'Tagline toko'}
                    </p>
                  </div>
                </div>
                <span
                  className={`px-3.5 py-2 text-xs font-semibold rounded-lg shrink-0 ${activeThemeStyle.primaryBtn}`}
                >
                  Keranjang (2)
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Store Name & Logo Upload */}
              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                <h2 className="font-display text-base font-bold text-slate-900">
                  Identitas &amp; Logo Toko
                </h2>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Nama Toko (Tampil di Navbar, Halaman Depan, Bill &amp; Judul Web)
                  </label>
                  <input
                    type="text"
                    required
                    minLength={2}
                    maxLength={80}
                    value={draft.storeName}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, storeName: e.target.value }))
                    }
                    className="w-full px-3.5 py-2.5 text-sm font-semibold border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Tagline / Slogan Toko
                  </label>
                  <input
                    type="text"
                    maxLength={140}
                    value={draft.storeTagline}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, storeTagline: e.target.value }))
                    }
                    placeholder="Belanja online mudah dan terpercaya..."
                    className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>

                <div className="space-y-2 pt-2 border-t border-slate-100">
                  <label className="block text-xs font-semibold text-slate-700">
                    Logo Toko (Upload dari HP / iPhone / PC atau URL)
                  </label>
                  <div className="flex flex-wrap items-center gap-2.5">
                    <label className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer">
                      <Upload className="w-3.5 h-3.5" />
                      <span>
                        {uploadingLogo ? 'Mengompres Logo...' : 'Unggah Gambar Logo'}
                      </span>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handleUploadLogo}
                        className="sr-only"
                      />
                    </label>
                    {draft.storeLogoUrl &&
                      draft.storeLogoUrl !== DEFAULT_MASTER_CONFIG.storeLogoUrl && (
                        <button
                          type="button"
                          onClick={() =>
                            setDraft((d) => ({
                              ...d,
                              storeLogoUrl: DEFAULT_MASTER_CONFIG.storeLogoUrl,
                            }))
                          }
                          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 cursor-pointer"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          <span>Reset Logo ALPAMART</span>
                        </button>
                      )}
                  </div>
                  <input
                    type="text"
                    value={
                      draft.storeLogoUrl.startsWith('data:image/')
                        ? ''
                        : draft.storeLogoUrl
                    }
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, storeLogoUrl: e.target.value }))
                    }
                    placeholder="Atau tempel URL logo https://..."
                    className="w-full px-3 py-2 text-xs font-mono border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>
              </div>

              {/* Operational Info & Announcement */}
              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                <h2 className="font-display text-base font-bold text-slate-900">
                  Operasional, Pengumuman &amp; Footer
                </h2>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Pita Pengumuman Atas (Opsional — tampil paling atas toko)
                  </label>
                  <input
                    type="text"
                    maxLength={160}
                    value={draft.announcementBarText}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        announcementBarText: e.target.value,
                      }))
                    }
                    placeholder="Contoh: Promo Gratis Ongkir Hari Ini! Buka 08:00 - 22:00"
                    className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Jam Operasional
                    </label>
                    <input
                      type="text"
                      maxLength={80}
                      value={draft.storeHours}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, storeHours: e.target.value }))
                      }
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Link Telegram Bukti Order
                    </label>
                    <input
                      type="url"
                      maxLength={200}
                      value={draft.telegramOrderUrl}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          telegramOrderUrl: e.target.value,
                        }))
                      }
                      placeholder="https://t.me/AlpamartTM03"
                      className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Alamat / Wilayah Toko (Opsional)
                  </label>
                  <input
                    type="text"
                    maxLength={200}
                    value={draft.storeAddress}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, storeAddress: e.target.value }))
                    }
                    placeholder="Contoh: Trimuia · Pengantaran Cepat GPS"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Teks Footer Bawah Website
                  </label>
                  <input
                    type="text"
                    maxLength={200}
                    value={draft.footerText}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, footerText: e.target.value }))
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>

                <label className="flex items-start gap-2.5 p-3 rounded-lg border border-amber-200 bg-amber-50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.maintenanceMode}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        maintenanceMode: e.target.checked,
                      }))
                    }
                    className="mt-0.5"
                  />
                  <div className="text-xs">
                    <p className="font-bold text-amber-950">
                      Mode Tutup Sementara / Maintenance Toko
                    </p>
                    <p className="text-amber-800">
                      Jika dicentang, pelanggan akan melihat pemberitahuan toko sedang tutup sementara saat membuka website.
                    </p>
                  </div>
                </label>
              </div>
            </div>
          </form>
        )}

        {/* TAB 1B: GANTI LINK URL WEBSITE SECARA ONLINE */}
        {activeTab === 'website_url' && (
          <MasterWebsiteUrlPanel
            storeName={draft.storeName}
            storeTagline={draft.storeTagline}
            permanentStoreUrl={draft.permanentStoreUrl}
            saving={savingMaster}
            onSavePermanentUrl={handleSavePermanentUrl}
            onNavigatePortal={onNavigatePortal}
            onNotify={showToast}
          />
        )}

        {/* TAB 2: CURRENCY & EXCHANGE RATE MASTER */}
        {activeTab === 'currency' && (
          <div className="space-y-6">
            {/* Quick Presets */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <h2 className="font-display text-base font-bold text-slate-900">
                Preset Mata Uang Cepat (1-Klik)
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {CURRENCY_PRESETS.map((preset) => {
                  const isActive =
                    draft.primaryCurrencyCode === preset.primaryCode &&
                    draft.secondaryCurrencyCode === preset.secondaryCode;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() =>
                        setDraft((d) => ({
                          ...d,
                          primaryCurrencyCode: preset.primaryCode,
                          primaryCurrencySymbol: preset.primarySymbol,
                          secondaryCurrencyCode: preset.secondaryCode,
                          secondaryCurrencySymbol: preset.secondarySymbol,
                          exchangeRate: preset.exchangeRate,
                        }))
                      }
                      className={`p-3 rounded-lg border text-left transition-colors cursor-pointer ${
                        isActive
                          ? 'bg-blue-50 border-blue-600 text-blue-950'
                          : 'bg-white border-slate-200 hover:bg-slate-50 text-slate-800'
                      }`}
                    >
                      <p className="text-xs font-bold">{preset.label}</p>
                      <p className="text-[11px] font-mono text-slate-500 mt-0.5">
                        1 {preset.primaryCode} = {preset.exchangeRate}{' '}
                        {preset.secondaryCode}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                <h2 className="font-display text-base font-bold text-slate-900">
                  Konfigurasi Mata Uang Utama &amp; Sekunder
                </h2>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Mata Uang Utama (Harga Produk &amp; QR)
                    </label>
                    <select
                      value={draft.primaryCurrencyCode}
                      onChange={(e) => {
                        const code = e.target.value as CurrencyCode;
                        const opt = CURRENCY_OPTIONS.find((o) => o.code === code);
                        setDraft((d) => ({
                          ...d,
                          primaryCurrencyCode: code,
                          primaryCurrencySymbol: opt?.symbol || code,
                        }));
                      }}
                      className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
                    >
                      {CURRENCY_OPTIONS.map((opt) => (
                        <option key={opt.code} value={opt.code}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Simbol Utama
                    </label>
                    <input
                      type="text"
                      maxLength={8}
                      value={draft.primaryCurrencySymbol}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          primaryCurrencySymbol: e.target.value,
                        }))
                      }
                      className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Mata Uang Sekunder (Pembayaran Tunai / CASH)
                    </label>
                    <select
                      value={draft.secondaryCurrencyCode}
                      onChange={(e) => {
                        const code = e.target.value as CurrencyCode;
                        const opt = CURRENCY_OPTIONS.find((o) => o.code === code);
                        setDraft((d) => ({
                          ...d,
                          secondaryCurrencyCode: code,
                          secondaryCurrencySymbol: opt?.symbol || code,
                        }));
                      }}
                      className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
                    >
                      {CURRENCY_OPTIONS.map((opt) => (
                        <option key={opt.code} value={opt.code}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Simbol Sekunder
                    </label>
                    <input
                      type="text"
                      maxLength={8}
                      value={draft.secondaryCurrencySymbol}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          secondaryCurrencySymbol: e.target.value,
                        }))
                      }
                      className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Kurs Konversi (1 {draft.primaryCurrencyCode} = ...{' '}
                    {draft.secondaryCurrencyCode})
                  </label>
                  <input
                    type="number"
                    step="any"
                    min={0.0001}
                    max={1000000}
                    value={draft.exchangeRate}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        exchangeRate: Number(e.target.value) || 0,
                      }))
                    }
                    className="w-full px-3.5 py-2.5 text-sm font-mono font-semibold border border-slate-300 rounded-lg"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">
                    Jika Mata Uang Utama &amp; Sekunder sama (misal IDR &amp; IDR), isi kurs dengan <strong>1</strong>.
                  </p>
                </div>
              </div>

              {/* Live Price Preview */}
              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                <h2 className="font-display text-base font-bold text-slate-900">
                  Simulasi Harga di Etalase &amp; Checkout
                </h2>
                <div className="space-y-3">
                  {[1, 5, 25].map((sampleAmount) => (
                    <div
                      key={sampleAmount}
                      className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-between gap-4"
                    >
                      <div>
                        <p className="text-xs text-slate-500">
                          Contoh Harga Dasar ({sampleAmount})
                        </p>
                        <p className="font-mono text-base font-bold text-blue-700">
                          QR: {formatPrimaryAmount(sampleAmount, draft)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-slate-500">
                          Konversi Tunai (CASH)
                        </p>
                        <p className="font-mono text-base font-bold text-red-600">
                          {formatSecondaryAmount(sampleAmount, draft)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: THEME & APPEARANCE */}
        {activeTab === 'theme' && (
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <h2 className="font-display text-base font-bold text-slate-900">
              Pilih Palet Warna Utama Website Toko
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {(Object.keys(THEME_ACCENT_STYLES) as ThemeAccent[]).map((key) => {
                const style = THEME_ACCENT_STYLES[key];
                const selected = draft.themeAccent === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setDraft((d) => ({ ...d, themeAccent: key }))}
                    className={`rounded-xl border-2 overflow-hidden text-left transition-all cursor-pointer ${
                      selected
                        ? 'border-blue-700 shadow-md ring-2 ring-blue-100'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className={`h-3 w-full ${style.topBar}`} />
                    <div className={`p-4 space-y-3 ${style.pageBg}`}>
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-bold text-slate-900">
                          {style.label}
                        </span>
                        {selected && (
                          <CheckCircle2 className="w-4 h-4 text-blue-700 shrink-0" />
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`px-3 py-1.5 text-xs font-semibold rounded-md ${style.primaryBtn}`}
                        >
                          Tombol Utama
                        </span>
                        <span
                          className={`px-3 py-1.5 text-xs font-semibold rounded-md ${style.secondaryBtn}`}
                        >
                          Aksen
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* TAB 4: BANNERS */}
        {activeTab === 'banners' && (
          <AdminBannerSettingsPanel banners={storeBanners} onNotify={showToast} />
        )}

        {/* TAB 5: CHECKOUT & BARCODE QR */}
        {activeTab === 'checkout' && (
          <AdminCheckoutSettingsPanel
            config={checkoutConfig}
            masterConfig={draft}
            adminEmail={user.email || MASTER_DATA_EMAIL}
            onNotify={showToast}
          />
        )}

        {/* TAB 5B: JAM BUKA & TUTUP TOKO */}
        {activeTab === 'hours' && (
          <AdminStoreHoursPanel
            hoursConfig={storeHoursConfig || DEFAULT_STORE_HOURS_CONFIG}
            adminEmail={user.email || MASTER_DATA_EMAIL}
          />
        )}

        {/* TAB 7+: ALL FULL STORE FEATURES DIRECTLY INSIDE MASTER DATA */}
        {EMBEDDED_ADMIN_TABS.has(activeTab) && (
          <AdminDashboardView
            user={user}
            isAdmin={true}
            isMaster={true}
            masterConfig={draft}
            backgroundConfig={backgroundConfig}
            embeddedInMaster={true}
            controlledTab={activeTab as AdminTab}
            onControlledTabChange={(nextTab) => {
              setActiveTab(nextTab as MasterTab);
            }}
            onOpenPortalGuide={onOpenPortalGuide}
            onUserReloaded={onUserReloaded}
          />
        )}

        {/* TAB 6: DEDICATED SEPARATED PORTAL DOWNLOAD TEMPLATES & BACKUP */}
        {activeTab === 'portals' && (
          <PortalDownloadTemplatePanel
            storeName={draft.storeName}
            storeTagline={draft.storeTagline}
            permanentStoreUrl={draft.permanentStoreUrl}
            onSavePermanentUrl={handleSavePermanentUrl}
            onNavigatePortal={onNavigatePortal}
            onNotify={showToast}
            extraBackupActions={
              <>
                <button
                  type="button"
                  disabled={backingUp !== null}
                  onClick={async () => {
                    setBackingUp('zip');
                    try {
                      const res = await exportMasterFirestoreBackup({
                        format: 'zip',
                        adminEmail: user?.email || MASTER_DATA_EMAIL,
                        storeName: draft.storeName,
                      });
                      showToast(
                        `Backup Data Master ZIP berhasil (${res.filename} · ${res.totalDocuments} dokumen).`
                      );
                    } catch {
                      showToast('Gagal membuat backup ZIP data master.');
                    } finally {
                      setBackingUp(null);
                    }
                  }}
                  className="inline-flex items-center justify-center gap-2 px-3.5 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
                >
                  <Download className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    {backingUp === 'zip'
                      ? 'Membuat Backup...'
                      : 'Backup Database (.ZIP)'}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={backingUp !== null}
                  onClick={async () => {
                    setBackingUp('json');
                    try {
                      const res = await exportMasterFirestoreBackup({
                        format: 'json',
                        adminEmail: user?.email || MASTER_DATA_EMAIL,
                        storeName: draft.storeName,
                      });
                      showToast(
                        `Backup Data Master JSON berhasil (${res.filename} · ${res.totalDocuments} dokumen).`
                      );
                    } catch {
                      showToast('Gagal membuat backup JSON data master.');
                    } finally {
                      setBackingUp(null);
                    }
                  }}
                  className="inline-flex items-center justify-center gap-2 px-3.5 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
                >
                  <Download className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    {backingUp === 'json' ? 'Mengekspor...' : 'Backup (.JSON)'}
                  </span>
                </button>
              </>
            }
          />
        )}
      </main>
    </div>
  );
}

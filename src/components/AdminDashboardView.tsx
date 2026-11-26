import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  Bluetooth,
  Box,
  Calendar,
  CalendarClock,
  Camera,
  Check,
  CheckCircle2,
  ClipboardList,
  Clock,
  Copy,
  Crown,
  Database,
  Download,
  Edit3,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  FolderKanban,
  Gift,
  Globe,
  Image as ImageIcon,
  KeyRound,
  Layers,
  Lock,
  LogIn,
  LogOut,
  MailCheck,
  MapPin,
  Maximize2,
  MessageCircle,
  PackageCheck,
  Percent,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Tag,
  Trash2,
  Truck,
  Upload,
  X,
  XCircle,
} from 'lucide-react';
import { signOut, type User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import type {
  AdminAccount,
  AutomationLog,
  AutomationSettings,
  DeliveryAccount,
  DeliveryRoster,
  Order,
  OrderStatus,
  Product,
  ProductCategory,
  ProductUnit,
  Promotion,
  PromoType,
  StoreBackgroundConfig,
  StoreBanner,
  StoreCategory,
  StoreCheckoutConfig,
  StoreHoursConfig,
  StoreMasterConfig,
  StoreSupportConfig,
} from '../types/marketplace';
import { FIELD_LIMITS, PRODUCT_UNITS } from '../types/marketplace';
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
  ABA_MERCHANT,
  BOOTSTRAPPED_ADMIN_EMAIL,
  copyTextToClipboard,
  type CsvExportPeriod,
  DEFAULT_AUTOMATION_SETTINGS,
  DEFAULT_DELIVERY_FEED_KEY,
  DEFAULT_STORE_SUPPORT,
  exportOrdersToCsv,
  filterOrdersByCsvPeriod,
  formatAmountByCurrency,
  formatComboInstruction,
  formatTimestamp,
  generateTrackingNumber,
  getPromotionScheduleInfo,
  getShareableOrigin,
  getShareablePortalUrl,
  getTelegramContactHref,
  INITIAL_CATEGORIES,
  isLikelyTelegramBotContact,
  isMasterEmail,
  isPromotionCurrentlyActive,
  normalizeEmail,
  normalizeProductUnit,
  normalizeTelegramHandle,
  normalizeWhatsAppNumber,
  ORDER_STATUS_META,
  parseDecimalPrice,
  seedInitialCatalogForAdmin,
  sha256Hex,
  STORE_NAME,
} from '../lib/catalogSeed';
import {
  downloadSinglePortalDomainZip,
  type PortalZipTarget,
} from '../lib/portalZipExport';
import { broadcastCrossTabEvent } from '../lib/crossAccountSync';
import { AdminBarcodeAutoImageModal } from './AdminBarcodeAutoImageModal';
import {
  getConnectedPrinterName,
  loadPrinterSettings,
  playNewOrderChime,
  printOrderViaBluetooth,
  savePrinterSettings,
  type PrinterSettings,
} from '../lib/thermalPrinter';
import {
  DEFAULT_CHECKOUT_CONFIG,
  DEFAULT_MASTER_CONFIG,
  DEFAULT_STORE_BACKGROUND_CONFIG,
  DEFAULT_STORE_HOURS_CONFIG,
  evaluateStoreOpenStatus,
  formatPrimaryAmount,
  formatSecondaryAmount,
  mergeCheckoutConfig,
  mergeStoreHoursConfig,
  THEME_ACCENT_STYLES,
} from '../lib/storeDefaults';
import {
  isProductNeedingImage,
  PLACEHOLDER_PRODUCT_IMAGE_URL,
} from '../lib/marketplaceBulkImport';
import {
  optimizeProductImageFileOnBackend,
  optimizeProductImageOnBackend,
} from '../lib/productImageOptimizerClient';
import { ProductImage } from './ProductImage';
import { AdminAccountsPanel } from './AdminAccountsPanel';
import { AdminPrinterSettingsPanel } from './AdminPrinterSettingsPanel';
import { AdminBannerSettingsPanel } from './AdminBannerSettingsPanel';
import { AdminBackgroundSettingsPanel } from './AdminBackgroundSettingsPanel';
import { AdminCheckoutSettingsPanel } from './AdminCheckoutSettingsPanel';
import { AdminStoreHoursPanel } from './AdminStoreHoursPanel';
import { AdminJournalPosPanel } from './AdminJournalPosPanel';
import { AdminMarketplaceImportModal } from './AdminMarketplaceImportModal';
import {
  FullscreenImageLightbox,
  isPdfProofDataUrl,
  ProofAttachmentPreview,
} from './ProofAttachmentPreview';
import { ThermalBillModal } from './ThermalBillModal';
import { ProductBarcodeScanner } from './ProductBarcodeScanner';
import { PortalDownloadTemplatePanel } from './PortalDownloadTemplatePanel';
import { AdminDailyOrderHistoryPanel } from './AdminDailyOrderHistoryPanel';

interface AdminDashboardViewProps {
  user: User | null;
  isAdmin: boolean;
  isMaster?: boolean;
  masterConfig?: StoreMasterConfig;
  backgroundConfig?: StoreBackgroundConfig;
  embeddedInMaster?: boolean;
  controlledTab?: AdminTab;
  onControlledTabChange?: (tab: AdminTab) => void;
  initialAuthError?: string | null;
  onOpenPortalGuide?: () => void;
  onUserReloaded?: () => void;
}

export type AdminTab =
  | 'orders'
  | 'daily_history'
  | 'stats'
  | 'journal_pos'
  | 'deliveries'
  | 'banners'
  | 'background'
  | 'checkout'
  | 'hours'
  | 'promotions'
  | 'categories'
  | 'automation'
  | 'printer'
  | 'products'
  | 'logs'
  | 'portal_templates'
  | 'account';

export function AdminDashboardView({
  user,
  isAdmin,
  isMaster,
  masterConfig,
  backgroundConfig,
  embeddedInMaster = false,
  controlledTab,
  onControlledTabChange,
  initialAuthError,
  onOpenPortalGuide,
  onUserReloaded,
}: AdminDashboardViewProps) {
  const [internalTab, setInternalTab] = useState<AdminTab>(controlledTab || 'orders');
  const activeTab: AdminTab = controlledTab ?? internalTab;
  const setActiveTab = useCallback(
    (next: AdminTab) => {
      setInternalTab(next);
      onControlledTabChange?.(next);
    },
    [onControlledTabChange]
  );

  useEffect(() => {
    if (controlledTab) {
      setInternalTab(controlledTab);
    }
  }, [controlledTab]);

  const canMasterEdit = Boolean(
    isMaster ?? (user?.emailVerified && isMasterEmail(user?.email))
  );
  const activeMaster = masterConfig || DEFAULT_MASTER_CONFIG;
  const activeStoreName = activeMaster.storeName?.trim() || STORE_NAME;
  const activeStoreLogo = activeMaster.storeLogoUrl || DEFAULT_MASTER_CONFIG.storeLogoUrl;
  const activeTheme =
    THEME_ACCENT_STYLES[activeMaster.themeAccent] || THEME_ACCENT_STYLES.blue_red;
  const [copiedPortalKey, setCopiedPortalKey] = useState<string | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<StoreCategory[]>([]);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [storeBanners, setStoreBanners] = useState<StoreBanner[]>([]);
  const [checkoutConfig, setCheckoutConfig] = useState<StoreCheckoutConfig>(() => ({
    ...DEFAULT_CHECKOUT_CONFIG,
  }));
  const liveKhrRate =
    activeMaster.primaryCurrencyCode === 'USD' &&
    activeMaster.secondaryCurrencyCode === 'KHR' &&
    activeMaster.exchangeRate >= 1000
      ? Math.round(activeMaster.exchangeRate)
      : checkoutConfig.exchangeRateKhr || 4100;
  const [storeHoursConfig, setStoreHoursConfig] = useState<StoreHoursConfig>(() => ({
    ...DEFAULT_STORE_HOURS_CONFIG,
  }));
  const [lightboxImage, setLightboxImage] = useState<{
    src: string;
    title: string;
    filename?: string;
  } | null>(null);
  const [deliveryAccounts, setDeliveryAccounts] = useState<DeliveryAccount[]>([]);
  const [adminAccounts, setAdminAccounts] = useState<AdminAccount[]>([]);
  const [deliveryFeedKey, setDeliveryFeedKey] = useState<string>(
    DEFAULT_DELIVERY_FEED_KEY
  );
  const [syncingDeliveryFeed, setSyncingDeliveryFeed] = useState(false);
  const [logs, setLogs] = useState<AutomationLog[]>([]);
  const [settings, setSettings] = useState<AutomationSettings>({
    ...DEFAULT_AUTOMATION_SETTINGS,
    updatedAt: null,
  });

  // Bluetooth Thermal Printer & Auto-Print Bill State
  const [printerSettings, setPrinterSettings] = useState<PrinterSettings>(() =>
    loadPrinterSettings()
  );
  const [connectedPrinterName, setConnectedPrinterName] = useState<string | null>(
    () => getConnectedPrinterName()
  );
  const [billOrder, setBillOrder] = useState<Order | null>(null);
  const [billAutoTriggered, setBillAutoTriggered] = useState(false);
  const [billAutoStatus, setBillAutoStatus] = useState<string | null>(null);

  const [loadingOrders, setLoadingOrders] = useState(true);
  const [orderFilter, setOrderFilter] = useState<'all' | OrderStatus>('all');
  const [orderSearch, setOrderSearch] = useState('');
  const [orderDateFrom, setOrderDateFrom] = useState('');
  const [orderDateTo, setOrderDateTo] = useState('');
  const [csvPeriod, setCsvPeriod] = useState<CsvExportPeriod>('daily');
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [batchProcessing, setBatchProcessing] = useState(false);
  const [copiedOrderAddress, setCopiedOrderAddress] = useState(false);
  const [authError, setAuthError] = useState<string | null>(initialAuthError ?? null);
  const [authInfo, setAuthInfo] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [redirectingSignIn, setRedirectingSignIn] = useState(false);
  const [adminLoginTab, setAdminLoginTab] = useState<'google' | 'password'>(() =>
    isIosDevice() || isAndroidDevice() || isInAppMobileBrowser() ? 'password' : 'google'
  );
  const [adminPwdMode, setAdminPwdMode] = useState<'login' | 'activate'>('login');
  const [adminEmailInput, setAdminEmailInput] = useState<string>('Hananbintang30@gmail.com');
  const [adminPasswordInput, setAdminPasswordInput] = useState<string>('');
  const [showAdminPassword, setShowAdminPassword] = useState(false);
  const [pwdLoading, setPwdLoading] = useState(false);
  const [showConsoleGuide, setShowConsoleGuide] = useState(false);
  const [unauthorizedHost, setUnauthorizedHost] = useState<string | null>(null);
  const [checkingVerify, setCheckingVerify] = useState(false);
  const [copiedAdminUrl, setCopiedAdminUrl] = useState(false);
  const inAppBrowser = useMemo(() => isInAppMobileBrowser(), []);
  const iosDevice = useMemo(() => isIosDevice(), []);
  const androidDevice = useMemo(() => isAndroidDevice(), []);

  useEffect(() => {
    if (initialAuthError) {
      setAuthError(initialAuthError);
    }
  }, [initialAuthError]);

  // Product Form Modal + Adaptive Image Box + Auto-Save Permanen
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [pName, setPName] = useState('');
  const [pSku, setPSku] = useState('');
  const [pCategory, setPCategory] = useState<ProductCategory>('Kebutuhan Harian');
  const [pPrice, setPPrice] = useState('45');
  const [pPriceError, setPPriceError] = useState<string | null>(null);
  const [pUnit, setPUnit] = useState<ProductUnit>('PCS');
  const [pStock, setPStock] = useState('20');
  const [pImageUrl, setPImageUrl] = useState(PLACEHOLDER_PRODUCT_IMAGE_URL);
  const [pImageDims, setPImageDims] = useState<{ width: number; height: number } | null>(null);
  const [uploadingProductImage, setUploadingProductImage] = useState(false);
  const [pImageFeedback, setPImageFeedback] = useState<string | null>(null);
  const [pDescription, setPDescription] = useState('');
  const [pIsActive, setPIsActive] = useState(true);
  const [savingProduct, setSavingProduct] = useState(false);
  const [productAutoSaveState, setProductAutoSaveState] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');
  const lastProductSavedSigRef = useRef<string>('');

  // Bulk External Marketplace Database Importer + Catalog Filter + Auto Image Fetch
  const [marketplaceImportOpen, setMarketplaceImportOpen] = useState(false);
  const [barcodeAutoImageOpen, setBarcodeAutoImageOpen] = useState(false);
  const [productCatalogSearch, setProductCatalogSearch] = useState('');
  const [productCatalogCategory, setProductCatalogCategory] = useState<string>('ALL');
  const [productCatalogFilter, setProductCatalogFilter] = useState<
    'all' | 'safe_stock' | 'low_stock' | 'out_of_stock' | 'needs_image'
  >('all');
  const [autoFillRunning, setAutoFillRunning] = useState(false);
  const [autoFillProgress, setAutoFillProgress] = useState<{
    done: number;
    total: number;
    filled: number;
    missed: number;
    currentName: string;
  } | null>(null);
  const autoFillCancelRef = useRef(false);
  const [autoFetchingRowId, setAutoFetchingRowId] = useState<string | null>(null);
  const [autoFetchingModalImage, setAutoFetchingModalImage] = useState(false);

  // Category Form Modal
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<StoreCategory | null>(null);
  const [catName, setCatName] = useState('');
  const [catSortOrder, setCatSortOrder] = useState('1');
  const [catIsActive, setCatIsActive] = useState(true);
  const [catErrorMsg, setCatErrorMsg] = useState<string | null>(null);
  const [savingCategory, setSavingCategory] = useState(false);

  // Promotion Form Modal (Combo, Buy X Get Y & Discount % + Auto Schedule/Expiry)
  const [promoModalOpen, setPromoModalOpen] = useState(false);
  const [editingPromo, setEditingPromo] = useState<Promotion | null>(null);
  const [promoTitle, setPromoTitle] = useState('');
  const [promoDescription, setPromoDescription] = useState('');
  const [promoType, setPromoType] = useState<PromoType>('combo');
  const [promoProductId, setPromoProductId] = useState('');
  const [promoDiscountPercent, setPromoDiscountPercent] = useState('20');
  const [promoBuyQty, setPromoBuyQty] = useState('1');
  const [promoGetQty, setPromoGetQty] = useState('2');
  const [promoStartDate, setPromoStartDate] = useState('');
  const [promoEndDate, setPromoEndDate] = useState('');
  const [promoAutoZeroStock, setPromoAutoZeroStock] = useState(true);
  const [promoFormError, setPromoFormError] = useState<string | null>(null);
  const [promoIsActive, setPromoIsActive] = useState(true);
  const [savingPromo, setSavingPromo] = useState(false);
  const [promoClockMs, setPromoClockMs] = useState<number>(() => Date.now());
  const [promoScanSelectedProductId, setPromoScanSelectedProductId] = useState('');
  const processingExpiredPromoIdsRef = useRef<Set<string>>(new Set());

  // Delivery Account Form Modal
  const [deliveryModalOpen, setDeliveryModalOpen] = useState(false);
  const [editingDelivery, setEditingDelivery] = useState<DeliveryAccount | null>(null);
  const [dName, setDName] = useState('');
  const [dEmail, setDEmail] = useState('');
  const [dPhone, setDPhone] = useState('');
  const [dIsActive, setDIsActive] = useState(true);
  const [dErrorMsg, setDErrorMsg] = useState<string | null>(null);
  const [savingDelivery, setSavingDelivery] = useState(false);

  const [savingSettings, setSavingSettings] = useState(false);
  const [supportConfig, setSupportConfig] = useState<StoreSupportConfig>({
    ...DEFAULT_STORE_SUPPORT,
    updatedAt: null,
  });
  const [savingSupport, setSavingSupport] = useState(false);
  const [adminBannerMsg, setAdminBannerMsg] = useState<string | null>(null);
  const [confirmDeleteOrderId, setConfirmDeleteOrderId] = useState<string | null>(null);
  const [deletingOrderId, setDeletingOrderId] = useState<string | null>(null);

  const autoProcessedIdsRef = useRef<Set<string>>(new Set());
  const seenOrderIdsRef = useRef<Set<string>>(new Set());
  const syncedCancelledIdsRef = useRef<Set<string>>(new Set());
  const lastRemoteAutomationRef = useRef<string>('');
  const initialOrdersLoadedRef = useRef(false);
  const printerSettingsRef = useRef<PrinterSettings>(printerSettings);
  const connectedPrinterNameRef = useRef<string | null>(connectedPrinterName);
  const deliveryFeedKeyRef = useRef<string>(deliveryFeedKey);

  useEffect(() => {
    printerSettingsRef.current = printerSettings;
  }, [printerSettings]);

  useEffect(() => {
    connectedPrinterNameRef.current = connectedPrinterName;
  }, [connectedPrinterName]);

  useEffect(() => {
    deliveryFeedKeyRef.current = deliveryFeedKey;
  }, [deliveryFeedKey]);

  useEffect(() => {
    setSelectedOrder((prev) =>
      prev ? orders.find((o) => o.id === prev.id) || prev : null
    );
  }, [orders]);

  // Real-time 30s clock for automatic promo start/expiry status
  useEffect(() => {
    const timer = window.setInterval(() => setPromoClockMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // Automatically expire finished promotions and set linked product stock to 0
  useEffect(() => {
    if (!canMasterEdit || promotions.length === 0) return;
    const dueExpired = promotions.filter((promo) => {
      if (!promo.endDate || !promo.endDate.trim()) return false;
      if (promo.autoZeroStockOnExpiry === false) return false;
      if (promo.expiredStockZeroedAt) return false;
      if (processingExpiredPromoIdsRef.current.has(promo.id)) return false;
      return getPromotionScheduleInfo(promo, promoClockMs).isExpired;
    });
    if (dueExpired.length === 0) return;

    dueExpired.forEach((p) => processingExpiredPromoIdsRef.current.add(p.id));
    let cancelled = false;

    const runAutoExpire = async () => {
      try {
        const batch = writeBatch(db);
        const nowIso = new Date().toISOString();
        const zeroedProductIds = new Set<string>();

        for (const promo of dueExpired) {
          const targetProd = products.find((p) => p.id === promo.productId);
          if (targetProd && targetProd.stock > 0 && !zeroedProductIds.has(targetProd.id)) {
            batch.update(doc(db, 'products', targetProd.id), {
              stock: 0,
              updatedAt: serverTimestamp(),
            });
            zeroedProductIds.add(targetProd.id);
          }
          batch.update(doc(db, 'promotions', promo.id), {
            isActive: false,
            expiredStockZeroedAt: nowIso,
            updatedAt: serverTimestamp(),
          });
        }

        await batch.commit();
        if (!cancelled) {
          setAdminBannerMsg(
            `${dueExpired.length} promosi telah melewati tanggal expired — promo dinonaktifkan & stok produk terkait otomatis diubah menjadi 0.`
          );
          window.setTimeout(() => setAdminBannerMsg(null), 5000);
        }
      } catch (err) {
        dueExpired.forEach((p) => processingExpiredPromoIdsRef.current.delete(p.id));
        console.error('Auto-expire promotion stock zeroing failed:', err);
      }
    };

    void runAutoExpire();
    return () => {
      cancelled = true;
    };
  }, [canMasterEdit, promotions, products, promoClockMs]);

  // Automatic one-time (per session) fast batch photo sync from https://alpamartkps.store/
  // when Master opens Admin with placeholder-only products, so all accounts update live in seconds.
  const kpsAutoSyncTriggeredRef = useRef(false);
  useEffect(() => {
    if (!canMasterEdit || products.length === 0 || kpsAutoSyncTriggeredRef.current) return;
    const sessionKey = 'alpamart_kps_autosync_done_v4';
    try {
      if (window.sessionStorage.getItem(sessionKey) === '1') return;
    } catch {
      // ignore storage errors
    }

    const targets = products.filter((p) => isProductNeedingImage(p.imageUrl));
    if (targets.length === 0) return;

    kpsAutoSyncTriggeredRef.current = true;
    try {
      window.sessionStorage.setItem(sessionKey, '1');
    } catch {
      // ignore
    }

    let cancelled = false;
    void (async () => {
      try {
        const resp = await fetch('/api/catalog/alpamartkps-match-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            strictBarcodeOnly: false,
            items: targets.map((p) => ({
              id: p.id,
              barcode: p.barcode || '',
              sku: p.sku || '',
              name: p.name,
            })),
          }),
        });
        const data = (await resp.json().catch(() => null)) as {
          ok?: boolean;
          matches?: Array<{ index: number; id: string; imageUrl: string }>;
        } | null;
        if (!resp.ok || !data?.ok || !Array.isArray(data.matches) || data.matches.length === 0) {
          return;
        }

        let committed = 0;
        const CHUNK_SIZE = 150;
        for (let start = 0; start < data.matches.length; start += CHUNK_SIZE) {
          if (cancelled) break;
          const chunk = data.matches.slice(start, start + CHUNK_SIZE);
          const batch = writeBatch(db);
          for (const m of chunk) {
            if (!m.id || !m.imageUrl) continue;
            batch.update(doc(db, 'products', m.id), {
              imageUrl: buildSafeProductImageUrl(m.imageUrl),
              updatedAt: serverTimestamp(),
            });
          }
          await batch.commit();
          committed += chunk.length;
        }

        if (committed > 0 && !cancelled) {
          broadcastCrossTabEvent({ type: 'revision_broadcast', source: 'admin_kps_autosync' });
          setAdminBannerMsg(
            `Sinkron otomatis selesai: ${committed} foto produk akurat disalin dari alpamartkps.store ke database dan langsung tampil di semua akun (Pelanggan, Delivery, Admin, Master).`
          );
          window.setTimeout(() => setAdminBannerMsg(null), 8000);
        }
      } catch {
        // Non-fatal: Master can also trigger manually via "Salin Foto KPS / Barcode"
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [canMasterEdit, products]);

  const handleUpdatePrinterSettings = useCallback((next: PrinterSettings) => {
    setPrinterSettings(next);
    savePrinterSettings(next);
  }, []);

  const buildDeliveryFeedPayload = useCallback(
    (order: Order, nextStatus: OrderStatus, nextTracking: string) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      shippingAddress: order.shippingAddress || '',
      city: order.city || '',
      postalCode: order.postalCode || '',
      locationDetail: order.locationDetail || '',
      locationCoords: order.locationCoords || '',
      locationUrl: order.locationUrl || '',
      locationImageUrl: order.locationImageUrl || '',
      deliveryProofImageUrl: order.deliveryProofImageUrl || '',
      paymentMethod: order.paymentMethod,
      currency: order.currency || 'USD',
      shippingMethod: order.shippingMethod,
      notes: order.notes || '',
      items: order.items,
      totalAmount: order.totalAmount,
      trackingNumber: nextTracking,
      status: nextStatus,
      createdAt: order.createdAt || serverTimestamp(),
      updatedAt: serverTimestamp(),
    }),
    []
  );

  // Seed initial store catalog & automation settings on admin login
  useEffect(() => {
    if (!user || !isAdmin) return;
    seedInitialCatalogForAdmin(user.email || BOOTSTRAPPED_ADMIN_EMAIL);
  }, [user, isAdmin]);

  // Real-time listeners for Admin
  useEffect(() => {
    if (!user || !isAdmin) return;

    initialOrdersLoadedRef.current = false;
    seenOrderIdsRef.current = new Set();

    setLoadingOrders(true);
    const unsubOrders = onSnapshot(
      query(collection(db, 'orders'), orderBy('createdAt', 'desc'), limit(150)),
      (snap) => {
        const list = snap.docs.map((d) => d.data() as Order);

        if (!initialOrdersLoadedRef.current) {
          for (const o of list) {
            seenOrderIdsRef.current.add(o.id);
          }
          initialOrdersLoadedRef.current = true;
        } else {
          const newlyArrived = list.filter((o) => !seenOrderIdsRef.current.has(o.id));
          for (const o of newlyArrived) {
            seenOrderIdsRef.current.add(o.id);
          }

          if (newlyArrived.length > 0) {
            const latestOrder = newlyArrived[0];
            const pCfg = printerSettingsRef.current;

            if (pCfg.soundAlert) {
              playNewOrderChime();
            }

            if (pCfg.autoOpenBillPopup || pCfg.autoPrintOnCheckout) {
              setBillOrder(latestOrder);
              setBillAutoTriggered(true);
              setBillAutoStatus(null);
            }

            if (pCfg.autoPrintOnCheckout) {
              if (pCfg.mode === 'bluetooth' && connectedPrinterNameRef.current) {
                setBillAutoStatus(
                  `Mengirim bill ${latestOrder.orderNumber} ke printer Bluetooth ${connectedPrinterNameRef.current}...`
                );
                void printOrderViaBluetooth(latestOrder, pCfg).then((res) => {
                  setBillAutoStatus(
                    res.ok
                      ? `Bill ${latestOrder.orderNumber} berhasil tercetak otomatis di ${connectedPrinterNameRef.current}.`
                      : `Gagal cetak Bluetooth otomatis: ${res.error || 'Periksa printer'}`
                  );
                });
              } else if (pCfg.mode === 'browser') {
                setBillAutoStatus(
                  `Bill ${latestOrder.orderNumber} otomatis dibuka — memanggil dialog cetak perangkat...`
                );
                window.setTimeout(() => {
                  document.body.classList.add('printing-thermal-bill');
                  window.print();
                  window.setTimeout(() => {
                    document.body.classList.remove('printing-thermal-bill');
                  }, 500);
                }, 380);
              } else {
                setBillAutoStatus(
                  `Pesanan baru ${latestOrder.orderNumber} masuk! Hubungkan Printer Bluetooth di tab Setting Printer atau klik tombol cetak di bawah.`
                );
              }
            }
          }
        }

        setOrders(list);
        setLoadingOrders(false);
      },
      (err) => {
        setLoadingOrders(false);
        handleFirestoreError(err, OperationType.LIST, 'orders');
      }
    );

    const unsubProducts = onSnapshot(
      collection(db, 'products'),
      (snap) => {
        setProducts(snap.docs.map((d) => d.data() as Product));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'products')
    );

    const unsubSettings = onSnapshot(
      doc(db, 'automationSettings', 'roboto'),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as AutomationSettings;
          lastRemoteAutomationRef.current = JSON.stringify({
            autoConfirmOrders: data.autoConfirmOrders,
            autoGenerateResi: data.autoGenerateResi,
            autoDeductStock: data.autoDeductStock,
            lowStockThreshold: data.lowStockThreshold,
            defaultCourierPrefix: data.defaultCourierPrefix,
          });
          setSettings(data);
        }
      },
      (err) =>
        handleFirestoreError(err, OperationType.GET, 'automationSettings/roboto')
    );

    const unsubLogs = onSnapshot(
      query(collection(db, 'automationLogs'), orderBy('createdAt', 'desc'), limit(80)),
      (snap) => {
        setLogs(snap.docs.map((d) => d.data() as AutomationLog));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'automationLogs')
    );

    const unsubPromos = onSnapshot(
      collection(db, 'promotions'),
      (snap) => {
        setPromotions(snap.docs.map((d) => d.data() as Promotion));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'promotions')
    );

    const unsubCategories = onSnapshot(
      collection(db, 'categories'),
      (snap) => {
        const list = snap.docs
          .map((d) => d.data() as StoreCategory)
          .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
        setCategories(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'categories')
    );

    const unsubDelivery = onSnapshot(
      collection(db, 'deliveryAccounts'),
      (snap) => {
        const list = snap.docs
          .map((d) => d.data() as DeliveryAccount)
          .sort((a, b) => a.name.localeCompare(b.name));
        setDeliveryAccounts(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'deliveryAccounts')
    );

    const unsubAdminAccounts = onSnapshot(
      collection(db, 'adminAccounts'),
      (snap) => {
        const list = snap.docs
          .map((d) => d.data() as AdminAccount)
          .sort((a, b) => a.name.localeCompare(b.name));
        setAdminAccounts(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'adminAccounts')
    );

    const unsubRoster = onSnapshot(
      doc(db, 'storeMeta', 'deliveryRoster'),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as DeliveryRoster;
          if (data.directAccessKey && data.directAccessKey.length >= 24) {
            setDeliveryFeedKey(data.directAccessKey);
          }
        }
      },
      () => {
        // Fallback to DEFAULT_DELIVERY_FEED_KEY if roster doc does not exist yet
      }
    );

    const unsubSupport = onSnapshot(
      doc(db, 'storeSupport', 'telegram'),
      (snap) => {
        if (snap.exists()) {
          setSupportConfig(snap.data() as StoreSupportConfig);
        }
      },
      (err) => handleFirestoreError(err, OperationType.GET, 'storeSupport/telegram')
    );

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

    const unsubCheckoutConfig = onSnapshot(
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

    const unsubHoursConfig = onSnapshot(
      doc(db, 'storeConfig', 'hours'),
      (snap) => {
        if (snap.exists()) {
          setStoreHoursConfig(
            mergeStoreHoursConfig(snap.data() as Partial<StoreHoursConfig>)
          );
        } else {
          setStoreHoursConfig({ ...DEFAULT_STORE_HOURS_CONFIG });
        }
      },
      () => {
        setStoreHoursConfig({ ...DEFAULT_STORE_HOURS_CONFIG });
      }
    );

    return () => {
      unsubOrders();
      unsubProducts();
      unsubSettings();
      unsubLogs();
      unsubPromos();
      unsubCategories();
      unsubDelivery();
      unsubAdminAccounts();
      unsubRoster();
      unsubSupport();
      unsubBanners();
      unsubCheckoutConfig();
      unsubHoursConfig();
    };
  }, [user, isAdmin]);

  // Automatic Order Processor: processes new pending orders and syncs Delivery feed
  const processOrderAutomatically = useCallback(
    async (order: Order) => {
      const generatedResi =
        order.trackingNumber ||
        (settings.autoGenerateResi
          ? generateTrackingNumber(settings.defaultCourierPrefix || 'ALP')
          : '');
      const logId = `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const cur = order.currency || 'USD';
      const legacyAddress = [order.shippingAddress, order.city, order.postalCode]
        .filter(Boolean)
        .join(', ');
      const locationSummary =
        order.locationCoords || order.locationUrl || legacyAddress || 'Lokasi GPS';
      const feedKey = deliveryFeedKeyRef.current || DEFAULT_DELIVERY_FEED_KEY;

      const batch = writeBatch(db);
      batch.update(doc(db, 'orders', order.id), {
        status: 'processing',
        trackingNumber: generatedResi,
        autoProcessed: true,
        updatedAt: serverTimestamp(),
      });

      batch.set(
        doc(db, 'deliveryFeeds', feedKey, 'orders', order.id),
        buildDeliveryFeedPayload(order, 'processing', generatedResi)
      );

      batch.set(doc(db, 'automationLogs', logId), {
        id: logId,
        orderId: order.id,
        orderNumber: order.orderNumber,
        action: 'Verifikasi Pesanan & Lokasi GPS Otomatis',
        detail: `Pesanan ${order.customerName} (${order.paymentMethod} · ${formatAmountByCurrency(order.totalAmount, cur)}) · Lokasi: ${locationSummary} · Resi: ${generatedResi || 'Manual'}`.slice(0, 390),
        status: 'success',
        createdAt: serverTimestamp(),
      });

      await batch.commit();
    },
    [settings.autoGenerateResi, settings.defaultCourierPrefix, buildDeliveryFeedPayload]
  );

  useEffect(() => {
    if (!user || !isAdmin || !settings.autoConfirmOrders) return;

    const pendingQueue = orders.filter(
      (o) =>
        o.status === 'pending' && !autoProcessedIdsRef.current.has(o.id)
    );
    if (pendingQueue.length === 0) return;

    const runAutoPilot = async () => {
      for (const order of pendingQueue) {
        autoProcessedIdsRef.current.add(order.id);
        try {
          await processOrderAutomatically(order);
        } catch (err) {
          autoProcessedIdsRef.current.delete(order.id);
          handleFirestoreError(err, OperationType.WRITE, `orders/${order.id}`);
        }
      }
    };

    runAutoPilot();
  }, [user, isAdmin, orders, settings.autoConfirmOrders, processOrderAutomatically]);

  const handleManualBatchProcess = async () => {
    const pendingList = orders.filter((o) => o.status === 'pending');
    if (pendingList.length === 0) {
      setAdminBannerMsg('Tidak ada pesanan berstatus Menunggu untuk diproses.');
      setTimeout(() => setAdminBannerMsg(null), 2500);
      return;
    }

    setBatchProcessing(true);
    try {
      for (const order of pendingList) {
        await processOrderAutomatically(order);
      }
      setAdminBannerMsg(
        `Selesai memproses ${pendingList.length} pesanan secara otomatis.`
      );
      setTimeout(() => setAdminBannerMsg(null), 3000);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'orders');
    } finally {
      setBatchProcessing(false);
    }
  };

  const handleAdvanceStatus = async (order: Order, nextStatus: OrderStatus) => {
    try {
      const tracking =
        order.trackingNumber ||
        (nextStatus === 'processing' || nextStatus === 'shipped'
          ? generateTrackingNumber(settings.defaultCourierPrefix || 'ALP')
          : '');
      const feedKey = deliveryFeedKeyRef.current || DEFAULT_DELIVERY_FEED_KEY;

      const logId = `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const batch = writeBatch(db);
      batch.update(doc(db, 'orders', order.id), {
        status: nextStatus,
        trackingNumber: tracking,
        autoProcessed: nextStatus === 'processing' ? true : order.autoProcessed,
        updatedAt: serverTimestamp(),
      });
      batch.set(
        doc(db, 'deliveryFeeds', feedKey, 'orders', order.id),
        buildDeliveryFeedPayload(order, nextStatus, tracking)
      );
      batch.set(doc(db, 'automationLogs', logId), {
        id: logId,
        orderId: order.id,
        orderNumber: order.orderNumber,
        action: `Status diubah ke ${ORDER_STATUS_META[nextStatus].label}`,
        detail: `Admin memperbarui status pesanan ${order.orderNumber}${tracking ? ` · Resi ${tracking}` : ''}`,
        status: 'success',
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      if (selectedOrder?.id === order.id) {
        setSelectedOrder({ ...order, status: nextStatus, trackingNumber: tracking });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `orders/${order.id}`);
    }
  };

  const handleDeleteOrder = async (order: Order) => {
    if (!isAdmin) return;
    setDeletingOrderId(order.id);
    try {
      const feedKey = deliveryFeedKeyRef.current || DEFAULT_DELIVERY_FEED_KEY;
      const shouldRestoreStock = order.status !== 'cancelled';

      // Aggregate quantities per productId so each product doc is read/updated once
      const restoreMap = new Map<string, number>();
      if (shouldRestoreStock && Array.isArray(order.items)) {
        for (const item of order.items) {
          const pid = String(item.productId || '').trim();
          const qty = Math.max(0, Math.trunc(Number(item.quantity) || 0));
          if (pid && qty > 0) {
            restoreMap.set(pid, (restoreMap.get(pid) || 0) + qty);
          }
        }
      }

      let restoredUnits = 0;
      let restoredProductCount = 0;

      await runTransaction(db, async (tx) => {
        // Firestore requires all reads before any writes in a transaction
        const updates: Array<{ productId: string; nextStock: number; addedQty: number }> = [];
        for (const [productId, restoreQty] of restoreMap.entries()) {
          const prodRef = doc(db, 'products', productId);
          const prodSnap = await tx.get(prodRef);
          if (prodSnap.exists()) {
            const currentStock = Math.max(0, Math.trunc(Number(prodSnap.data().stock ?? 0)));
            const nextStock = Math.min(999999, currentStock + restoreQty);
            updates.push({ productId, nextStock, addedQty: restoreQty });
          }
        }

        for (const u of updates) {
          tx.update(doc(db, 'products', u.productId), {
            stock: u.nextStock,
            updatedAt: serverTimestamp(),
          });
          restoredUnits += u.addedQty;
          restoredProductCount += 1;
        }

        tx.delete(doc(db, 'orders', order.id));
        tx.delete(doc(db, 'deliveryFeeds', feedKey, 'orders', order.id));
      });

      if (selectedOrder?.id === order.id) setSelectedOrder(null);
      if (billOrder?.id === order.id) setBillOrder(null);
      setConfirmDeleteOrderId(null);
      setAdminBannerMsg(
        restoredUnits > 0
          ? `Pesanan ${order.orderNumber} berhasil dihapus & stok +${restoredUnits} unit (${restoredProductCount} produk) otomatis dikembalikan ke katalog.`
          : `Pesanan ${order.orderNumber} berhasil dihapus permanen secara online di semua akun.`
      );
      setTimeout(() => setAdminBannerMsg(null), 4500);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `orders/${order.id}`);
    } finally {
      setDeletingOrderId(null);
    }
  };

  // Cross-account live sync: keep open Order Detail / Bill modals in sync when Delivery or Customer revises an order
  useEffect(() => {
    if (selectedOrder) {
      const fresh = orders.find((o) => o.id === selectedOrder.id);
      if (!fresh) {
        setSelectedOrder(null);
      } else if (
        fresh.status !== selectedOrder.status ||
        fresh.trackingNumber !== selectedOrder.trackingNumber ||
        fresh.deliveryProofImageUrl !== selectedOrder.deliveryProofImageUrl ||
        fresh.updatedAt !== selectedOrder.updatedAt
      ) {
        setSelectedOrder(fresh);
      }
    }
    if (billOrder && billOrder.id !== 'test_bill') {
      const freshBill = orders.find((o) => o.id === billOrder.id);
      if (!freshBill) {
        setBillOrder(null);
      } else if (
        freshBill.status !== billOrder.status ||
        freshBill.trackingNumber !== billOrder.trackingNumber
      ) {
        setBillOrder(freshBill);
      }
    }
  }, [orders, selectedOrder, billOrder]);

  // Cross-account live sync: mirror customer-cancelled orders into Delivery Feed automatically
  useEffect(() => {
    if (!user || !isAdmin || orders.length === 0) return;
    const feedKey = deliveryFeedKeyRef.current || DEFAULT_DELIVERY_FEED_KEY;
    const newlyCancelled = orders.filter(
      (o) => o.status === 'cancelled' && !syncedCancelledIdsRef.current.has(o.id)
    );
    if (newlyCancelled.length === 0) return;
    newlyCancelled.forEach((o) => syncedCancelledIdsRef.current.add(o.id));
    const batch = writeBatch(db);
    newlyCancelled.slice(0, 50).forEach((o) => {
      batch.set(
        doc(db, 'deliveryFeeds', feedKey, 'orders', o.id),
        buildDeliveryFeedPayload(o, 'cancelled', o.trackingNumber || '')
      );
    });
    void batch.commit().catch(() => undefined);
  }, [orders, user, isAdmin]);

  // Debounced Auto-Save Permanen for Automation Settings (Master Data only)
  useEffect(() => {
    if (!user || !canMasterEdit || !lastRemoteAutomationRef.current) return;
    const sig = JSON.stringify({
      autoConfirmOrders: settings.autoConfirmOrders,
      autoGenerateResi: settings.autoGenerateResi,
      autoDeductStock: settings.autoDeductStock,
      lowStockThreshold: settings.lowStockThreshold,
      defaultCourierPrefix: settings.defaultCourierPrefix,
    });
    if (sig === lastRemoteAutomationRef.current) return;
    const timer = window.setTimeout(() => {
      void setDoc(doc(db, 'automationSettings', 'roboto'), {
        id: 'roboto',
        autoConfirmOrders: settings.autoConfirmOrders,
        autoGenerateResi: settings.autoGenerateResi,
        autoDeductStock: settings.autoDeductStock,
        lowStockThreshold: Math.min(
          100,
          Math.max(1, Number(settings.lowStockThreshold) || 5)
        ),
        defaultCourierPrefix: (settings.defaultCourierPrefix || 'ALP')
          .toUpperCase()
          .slice(0, 16),
        updatedBy: user.email || BOOTSTRAPPED_ADMIN_EMAIL,
        updatedAt: serverTimestamp(),
      })
        .then(() => {
          lastRemoteAutomationRef.current = sig;
          setAdminBannerMsg('Pengaturan otomasi tersimpan otomatis permanen.');
          setTimeout(() => setAdminBannerMsg(null), 2400);
        })
        .catch(() => undefined);
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [settings, user, canMasterEdit]);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !canMasterEdit) return;
    setSavingSettings(true);
    try {
      await setDoc(doc(db, 'automationSettings', 'roboto'), {
        id: 'roboto',
        autoConfirmOrders: settings.autoConfirmOrders,
        autoGenerateResi: settings.autoGenerateResi,
        autoDeductStock: settings.autoDeductStock,
        lowStockThreshold: Math.min(
          100,
          Math.max(1, Number(settings.lowStockThreshold) || 5)
        ),
        defaultCourierPrefix: (settings.defaultCourierPrefix || 'ALP')
          .toUpperCase()
          .slice(0, 16),
        updatedBy: user.email || BOOTSTRAPPED_ADMIN_EMAIL,
        updatedAt: serverTimestamp(),
      });
      setAdminBannerMsg('Pengaturan otomasi toko berhasil disimpan.');
      setTimeout(() => setAdminBannerMsg(null), 2500);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'automationSettings/roboto');
    } finally {
      setSavingSettings(false);
    }
  };

  const availableCategoryNames = useMemo(() => {
    const names = new Set<string>();
    const source =
      categories.length > 0
        ? categories.map((c) => c.name)
        : INITIAL_CATEGORIES.map((c) => c.name);
    for (const n of source) {
      if (n.trim()) names.add(n.trim());
    }
    if (editingProduct?.category?.trim()) {
      names.add(editingProduct.category.trim());
    }
    return Array.from(names);
  }, [categories, editingProduct]);

  const parsedProductPrice = useMemo(() => parseDecimalPrice(pPrice), [pPrice]);

  const lowStockLimit = Math.max(1, Math.trunc(Number(settings.lowStockThreshold) || 5));

  const adminCategoryList = useMemo(() => {
    const counts = new Map<
      string,
      { total: number; safe: number; low: number; empty: number }
    >();
    for (const c of categories) {
      const name = c.name.trim();
      if (name && !counts.has(name)) {
        counts.set(name, { total: 0, safe: 0, low: 0, empty: 0 });
      }
    }
    for (const p of products) {
      const catName = (p.category || 'Lainnya').trim() || 'Lainnya';
      const entry = counts.get(catName) || { total: 0, safe: 0, low: 0, empty: 0 };
      entry.total += 1;
      const st = Math.trunc(Number(p.stock ?? 0));
      if (st <= 0) {
        entry.empty += 1;
      } else if (st <= lowStockLimit) {
        entry.low += 1;
      } else {
        entry.safe += 1;
      }
      counts.set(catName, entry);
    }
    return Array.from(counts.entries()).map(([name, stats]) => ({
      name,
      ...stats,
    }));
  }, [categories, products, lowStockLimit]);

  const categoryScopedAdminProducts = useMemo(() => {
    if (productCatalogCategory === 'ALL') return products;
    return products.filter(
      (p) => ((p.category || 'Lainnya').trim() || 'Lainnya') === productCatalogCategory
    );
  }, [products, productCatalogCategory]);

  const adminScopedStockCounts = useMemo(() => {
    let safe = 0;
    let low = 0;
    let empty = 0;
    let needsImg = 0;
    for (const p of categoryScopedAdminProducts) {
      const st = Math.trunc(Number(p.stock ?? 0));
      if (st <= 0) empty += 1;
      else if (st <= lowStockLimit) low += 1;
      else safe += 1;
      if (isProductNeedingImage(p.imageUrl)) needsImg += 1;
    }
    return {
      total: categoryScopedAdminProducts.length,
      safe,
      low,
      empty,
      needsImg,
    };
  }, [categoryScopedAdminProducts, lowStockLimit]);

  const productsNeedingImageCount = useMemo(
    () => products.filter((p) => isProductNeedingImage(p.imageUrl)).length,
    [products]
  );

  const filteredAdminProducts = useMemo(() => {
    const q = productCatalogSearch.trim().toLowerCase();
    return categoryScopedAdminProducts.filter((p) => {
      const st = Math.trunc(Number(p.stock ?? 0));
      if (productCatalogFilter === 'needs_image' && !isProductNeedingImage(p.imageUrl)) {
        return false;
      }
      if (productCatalogFilter === 'safe_stock' && st <= lowStockLimit) {
        return false;
      }
      if (productCatalogFilter === 'low_stock' && (st <= 0 || st > lowStockLimit)) {
        return false;
      }
      if (productCatalogFilter === 'out_of_stock' && st > 0) {
        return false;
      }
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q)
      );
    });
  }, [
    categoryScopedAdminProducts,
    productCatalogFilter,
    productCatalogSearch,
    lowStockLimit,
  ]);

  const buildSafeProductImageUrl = (raw: string): string => {
    const trimmed = raw.trim();
    if (!trimmed) return PLACEHOLDER_PRODUCT_IMAGE_URL;
    if (trimmed.startsWith('data:image/')) {
      return trimmed.slice(0, 248000);
    }
    if (trimmed.startsWith('https://') || trimmed.startsWith('/')) {
      return trimmed.slice(0, 1000);
    }
    return PLACEHOLDER_PRODUCT_IMAGE_URL;
  };

  const buildProductEditSignature = (vals: {
    name: string;
    sku: string;
    category: string;
    price: string;
    unit: ProductUnit;
    stock: string;
    imageUrl: string;
    description: string;
    isActive: boolean;
  }) => JSON.stringify(vals);

  const openAddProductModal = () => {
    setEditingProduct(null);
    setPName('');
    setPSku(`ATM-${Math.floor(100 + Math.random() * 900)}`);
    setPCategory(availableCategoryNames[0] || 'Kebutuhan Harian');
    setPPrice('25');
    setPPriceError(null);
    setPUnit('PCS');
    setPStock('25');
    setPImageUrl(PLACEHOLDER_PRODUCT_IMAGE_URL);
    setPImageDims(null);
    setPImageFeedback(null);
    setPDescription('');
    setPIsActive(true);
    setProductAutoSaveState('idle');
    lastProductSavedSigRef.current = '';
    setProductModalOpen(true);
  };

  const openEditProductModal = (product: Product) => {
    const normalizedUnit = normalizeProductUnit(product.unit);
    setEditingProduct(product);
    setPName(product.name);
    setPSku(product.sku);
    setPCategory(product.category);
    setPPrice(String(product.price));
    setPPriceError(null);
    setPUnit(normalizedUnit);
    setPStock(String(product.stock));
    setPImageUrl(product.imageUrl || PLACEHOLDER_PRODUCT_IMAGE_URL);
    setPImageDims(null);
    setPImageFeedback(null);
    setPDescription(product.description);
    setPIsActive(product.isActive);
    setProductAutoSaveState('idle');
    lastProductSavedSigRef.current = buildProductEditSignature({
      name: product.name,
      sku: product.sku,
      category: product.category,
      price: String(product.price),
      unit: normalizedUnit,
      stock: String(product.stock),
      imageUrl: product.imageUrl || PLACEHOLDER_PRODUCT_IMAGE_URL,
      description: product.description,
      isActive: product.isActive,
    });
    setProductModalOpen(true);
  };

  // Real-time debounced Auto-Save Permanen whenever Master Data edits an existing product
  useEffect(() => {
    if (!canMasterEdit || !productModalOpen || !editingProduct || savingProduct || uploadingProductImage) return;

    const currentSig = buildProductEditSignature({
      name: pName,
      sku: pSku,
      category: pCategory,
      price: pPrice,
      unit: pUnit,
      stock: pStock,
      imageUrl: pImageUrl,
      description: pDescription,
      isActive: pIsActive,
    });
    if (currentSig === lastProductSavedSigRef.current) return;

    const parsedPrice = parseDecimalPrice(pPrice);
    const cleanName = pName.trim().slice(0, FIELD_LIMITS.PRODUCT_NAME_MAX);
    const cleanSku = pSku.trim().slice(0, FIELD_LIMITS.SKU_MAX);
    const cleanCat = pCategory.trim().slice(0, FIELD_LIMITS.CATEGORY_NAME_MAX);
    const cleanDesc = pDescription.trim().slice(0, FIELD_LIMITS.DESCRIPTION_MAX);
    const parsedStock = Math.max(0, parseInt(pStock, 10) || 0);
    const safeImageUrl = buildSafeProductImageUrl(pImageUrl);

    if (
      cleanName.length < 1 ||
      cleanSku.length < 1 ||
      cleanCat.length < 2 ||
      cleanDesc.length < 2 ||
      !Number.isFinite(parsedPrice) ||
      parsedPrice < 0.01
    ) {
      return;
    }

    let cancelled = false;
    setProductAutoSaveState('saving');
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const optimized = await optimizeProductImageOnBackend(safeImageUrl);
          if (cancelled) return;
          const finalImageUrl = buildSafeProductImageUrl(optimized.imageUrl);

          await updateDoc(doc(db, 'products', editingProduct.id), {
            name: cleanName,
            sku: cleanSku,
            category: cleanCat,
            description: cleanDesc,
            price: parsedPrice,
            unit: pUnit,
            stock: parsedStock,
            imageUrl: finalImageUrl,
            isActive: pIsActive,
            updatedAt: serverTimestamp(),
          });

          if (cancelled) return;
          const savedSig = buildProductEditSignature({
            name: pName,
            sku: pSku,
            category: pCategory,
            price: pPrice,
            unit: pUnit,
            stock: pStock,
            imageUrl: finalImageUrl,
            description: pDescription,
            isActive: pIsActive,
          });
          lastProductSavedSigRef.current = savedSig;
          if (finalImageUrl !== pImageUrl) {
            setPImageUrl(finalImageUrl);
            if (optimized.viaBackend) {
              setPImageDims({ width: optimized.boxWidth, height: optimized.boxHeight });
            }
          }
          setProductAutoSaveState('saved');
        } catch {
          if (!cancelled) {
            setProductAutoSaveState('error');
          }
        }
      })();
    }, 1000);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    editingProduct,
    pCategory,
    pDescription,
    pImageUrl,
    pIsActive,
    pName,
    pPrice,
    pSku,
    pStock,
    pUnit,
    productModalOpen,
    savingProduct,
    uploadingProductImage,
  ]);

  const handleUploadProductImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadingProductImage(true);
    setPImageFeedback(null);
    try {
      const prepared = await optimizeProductImageFileOnBackend(file);
      setPImageUrl(prepared.imageUrl);
      setPImageDims({ width: prepared.boxWidth, height: prepared.boxHeight });
      setPImageFeedback(
        prepared.viaBackend
          ? `Foto siap (${prepared.originalWidth} × ${prepared.originalHeight} px → kotak display ${prepared.boxWidth} × ${prepared.boxHeight} px · ${prepared.sizeKb} KB · rasio aspek asli utuh tanpa dipotong).`
          : `Foto siap (${prepared.boxWidth} × ${prepared.boxHeight} px · ${prepared.sizeKb} KB · rasio aspek asli dipertahankan tanpa dipotong).`
      );
    } catch (err) {
      setPImageFeedback(
        err instanceof Error ? err.message : 'Gagal memproses foto produk.'
      );
    } finally {
      setUploadingProductImage(false);
    }
  };

  const requestAutoFetchProductImage = async (params: {
    barcode?: string;
    sku?: string;
    name?: string;
    category?: string;
  }): Promise<{
    found: boolean;
    imageUrl?: string;
    source?: string;
    matchedName?: string;
    sizeKb?: number;
    reason?: string;
  }> => {
    const resp = await fetch('/api/catalog/auto-fetch-product-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = (await resp.json().catch(() => null)) as {
      ok?: boolean;
      found?: boolean;
      imageUrl?: string;
      source?: string;
      matchedName?: string;
      sizeKb?: number;
      reason?: string;
    } | null;
    if (!resp.ok || !data) {
      return {
        found: false,
        reason: data?.reason || 'Gagal menghubungi server pencari foto otomatis.',
      };
    }
    return {
      found: Boolean(data.found && data.imageUrl),
      imageUrl: data.imageUrl,
      source: data.source,
      matchedName: data.matchedName,
      sizeKb: data.sizeKb,
      reason: data.reason,
    };
  };

  const handleAutoFetchModalProductImage = async () => {
    if (!pName.trim() && !pSku.trim() && !editingProduct?.barcode) {
      setPImageFeedback('Isi nama produk atau SKU/barcode terlebih dahulu agar sistem bisa mencari fotonya.');
      return;
    }
    setAutoFetchingModalImage(true);
    setPImageFeedback(null);
    try {
      const result = await requestAutoFetchProductImage({
        barcode: editingProduct?.barcode || '',
        sku: pSku.trim(),
        name: pName.trim(),
        category: pCategory,
      });
      if (result.found && result.imageUrl) {
        setPImageUrl(result.imageUrl);
        setPImageDims(null);
        setPImageFeedback(
          `Foto siap (otomatis dari ${result.source || 'Database Barcode'} · ${result.sizeKb || 0} KB · "${result.matchedName || pName}").`
        );
      } else {
        setPImageFeedback(
          result.reason || 'Foto belum ditemukan di database barcode. Anda bisa unggah manual lewat tombol kamera/galeri.'
        );
      }
    } catch {
      setPImageFeedback('Gagal mencari foto otomatis. Periksa koneksi internet lalu coba lagi.');
    } finally {
      setAutoFetchingModalImage(false);
    }
  };

  const handleSingleAutoFillProductImage = async (product: Product) => {
    if (!canMasterEdit || autoFillRunning || autoFetchingRowId) return;
    setAutoFetchingRowId(product.id);
    try {
      const result = await requestAutoFetchProductImage({
        barcode: product.barcode || '',
        sku: product.sku || '',
        name: product.name,
        category: product.category,
      });
      if (result.found && result.imageUrl) {
        await updateDoc(doc(db, 'products', product.id), {
          imageUrl: buildSafeProductImageUrl(result.imageUrl),
          updatedAt: serverTimestamp(),
        });
        broadcastCrossTabEvent({ type: 'revision_broadcast', source: 'admin' });
        setAdminBannerMsg(
          `Foto otomatis terpasang untuk "${product.name}" (${result.source || 'Database Barcode'}).`
        );
      } else {
        setAdminBannerMsg(
          result.reason || `Foto "${product.name}" belum ada di database barcode publik — klik Edit Gambar untuk unggah manual.`
        );
      }
      setTimeout(() => setAdminBannerMsg(null), 5000);
    } catch {
      setAdminBannerMsg(`Gagal mengambil foto otomatis untuk "${product.name}".`);
      setTimeout(() => setAdminBannerMsg(null), 4500);
    } finally {
      setAutoFetchingRowId(null);
    }
  };

  const handleBatchAutoFillCatalogImages = async () => {
    if (!canMasterEdit || autoFillRunning) return;
    const targets = products.filter((p) => isProductNeedingImage(p.imageUrl));
    if (targets.length === 0) {
      setAdminBannerMsg('Semua produk di katalog sudah memiliki foto terdaftar.');
      setTimeout(() => setAdminBannerMsg(null), 3500);
      return;
    }

    autoFillCancelRef.current = false;
    setAutoFillRunning(true);
    let filled = 0;
    let missed = 0;
    setAutoFillProgress({
      done: 0,
      total: targets.length,
      filled: 0,
      missed: 0,
      currentName: 'Mencocokkan batch seluruh katalog dengan alpamartkps.store...',
    });

    // Stage 1: Fast batch match against all 2,138 AlpaMart KPS products + Firestore writeBatch
    try {
      const kpsResp = await fetch('/api/catalog/alpamartkps-match-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          strictBarcodeOnly: false,
          items: targets.map((p) => ({
            id: p.id,
            barcode: p.barcode || '',
            sku: p.sku || '',
            name: p.name,
          })),
        }),
      });
      const kpsData = (await kpsResp.json().catch(() => null)) as {
        ok?: boolean;
        matches?: Array<{ index: number; id: string; imageUrl: string }>;
      } | null;

      if (kpsResp.ok && kpsData?.ok && Array.isArray(kpsData.matches)) {
        const CHUNK_SIZE = 150;
        for (let start = 0; start < kpsData.matches.length; start += CHUNK_SIZE) {
          if (autoFillCancelRef.current) break;
          const chunk = kpsData.matches.slice(start, start + CHUNK_SIZE);
          setAutoFillProgress({
            done: filled,
            total: targets.length,
            filled,
            missed,
            currentName: `Menyimpan batch ${start + 1}–${Math.min(
              start + chunk.length,
              kpsData.matches.length
            )} foto KPS ke semua akun...`,
          });
          const batch = writeBatch(db);
          for (const m of chunk) {
            if (!m.id || !m.imageUrl) continue;
            batch.update(doc(db, 'products', m.id), {
              imageUrl: buildSafeProductImageUrl(m.imageUrl),
              updatedAt: serverTimestamp(),
            });
          }
          await batch.commit();
          filled += chunk.length;
        }
      }
    } catch {
      // Fallback safely to remaining count
    }

    missed = Math.max(0, targets.length - filled);
    setAutoFillProgress({
      done: targets.length,
      total: targets.length,
      filled,
      missed,
      currentName: 'Selesai',
    });

    setAutoFillRunning(false);
    if (filled > 0) {
      broadcastCrossTabEvent({ type: 'revision_broadcast', source: 'admin' });
    }
    const stoppedNote = autoFillCancelRef.current ? ' (dihentikan pengguna)' : '';
    setAdminBannerMsg(
      `Isi foto otomatis selesai${stoppedNote}: ${filled} produk berhasil terisi foto akurat dari alpamartkps.store untuk semua akun, ${missed} produk belum ada kecocokan 100% (foto lama tetap aman).`
    );
    setTimeout(() => setAdminBannerMsg(null), 6500);
  };

  const handlePriceInputChange = (raw: string) => {
    // Allow digits, dot (.), comma (,) freely so decimal prices work across all keyboards
    const sanitized = raw.replace(/[^0-9.,]/g, '');
    setPPrice(sanitized);
    if (pPriceError) setPPriceError(null);
  };

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canMasterEdit) return;
    setPPriceError(null);
    const parsedPrice = parseDecimalPrice(pPrice);
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0.01) {
      setPPriceError(
        'Masukkan harga jual valid minimal 0.01 USD (bisa memakai titik, contoh: 1.50 atau 0.75).'
      );
      return;
    }
    setSavingProduct(true);
    const parsedStock = Math.max(0, parseInt(pStock, 10) || 0);
    const id =
      editingProduct?.id ||
      `prod_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    try {
      // Always route product image through backend optimizer on create & update
      // so every item fits consistently in the display box without breaking aspect ratio.
      const rawImageCandidate = buildSafeProductImageUrl(pImageUrl);
      const optimizedImage = await optimizeProductImageOnBackend(rawImageCandidate);
      const safeImageUrl = buildSafeProductImageUrl(optimizedImage.imageUrl);

      if (editingProduct) {
        await updateDoc(doc(db, 'products', id), {
          name: pName.trim().slice(0, FIELD_LIMITS.PRODUCT_NAME_MAX),
          sku: pSku.trim().slice(0, FIELD_LIMITS.SKU_MAX),
          category: pCategory.trim().slice(0, FIELD_LIMITS.CATEGORY_NAME_MAX),
          description: pDescription.trim().slice(0, FIELD_LIMITS.DESCRIPTION_MAX),
          price: parsedPrice,
          unit: pUnit,
          stock: parsedStock,
          imageUrl: safeImageUrl,
          isActive: pIsActive,
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(doc(db, 'products', id), {
          id,
          name: pName.trim().slice(0, FIELD_LIMITS.PRODUCT_NAME_MAX),
          sku: pSku.trim().slice(0, FIELD_LIMITS.SKU_MAX),
          category: pCategory.trim().slice(0, FIELD_LIMITS.CATEGORY_NAME_MAX),
          description: pDescription.trim().slice(0, FIELD_LIMITS.DESCRIPTION_MAX),
          price: parsedPrice,
          unit: pUnit,
          stock: parsedStock,
          imageUrl: safeImageUrl,
          isActive: pIsActive,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      setProductModalOpen(false);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `products/${id}`);
    } finally {
      setSavingProduct(false);
    }
  };

  const handleDeleteProduct = async (productId: string) => {
    if (!canMasterEdit) return;
    try {
      await deleteDoc(doc(db, 'products', productId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `products/${productId}`);
    }
  };

  const openAddCategoryModal = () => {
    setEditingCategory(null);
    setCatName('');
    setCatSortOrder(String((categories.length || 0) + 1));
    setCatIsActive(true);
    setCatErrorMsg(null);
    setCategoryModalOpen(true);
  };

  const openEditCategoryModal = (cat: StoreCategory) => {
    setEditingCategory(cat);
    setCatName(cat.name);
    setCatSortOrder(String(cat.sortOrder ?? 1));
    setCatIsActive(cat.isActive);
    setCatErrorMsg(null);
    setCategoryModalOpen(true);
  };

  const handleSaveCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canMasterEdit) return;
    setCatErrorMsg(null);
    const trimmedName = catName.trim().slice(0, FIELD_LIMITS.CATEGORY_NAME_MAX);
    if (trimmedName.length < FIELD_LIMITS.CATEGORY_NAME_MIN) {
      setCatErrorMsg('Nama kategori minimal 2 karakter.');
      return;
    }

    const duplicate = categories.find(
      (c) =>
        c.name.toLowerCase() === trimmedName.toLowerCase() &&
        c.id !== editingCategory?.id
    );
    if (duplicate) {
      setCatErrorMsg('Nama kategori tersebut sudah ada.');
      return;
    }

    const safeOrder = Math.min(1000, Math.max(0, parseInt(catSortOrder, 10) || 0));
    const slug = trimmedName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32);
    const id =
      editingCategory?.id ||
      `cat_${slug || 'baru'}_${Math.random().toString(36).slice(2, 6)}`;

    setSavingCategory(true);
    try {
      const batch = writeBatch(db);
      if (editingCategory) {
        batch.update(doc(db, 'categories', id), {
          name: trimmedName,
          sortOrder: safeOrder,
          isActive: catIsActive,
          updatedAt: serverTimestamp(),
        });

        // Sync existing products that referenced the previous category name
        if (editingCategory.name !== trimmedName) {
          for (const prod of products) {
            if (prod.category === editingCategory.name) {
              batch.update(doc(db, 'products', prod.id), {
                category: trimmedName,
                updatedAt: serverTimestamp(),
              });
            }
          }
        }
      } else {
        batch.set(doc(db, 'categories', id), {
          id,
          name: trimmedName,
          sortOrder: safeOrder,
          isActive: catIsActive,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
      setCategoryModalOpen(false);
      setAdminBannerMsg(
        editingCategory
          ? `Kategori "${trimmedName}" berhasil diperbarui.`
          : `Kategori "${trimmedName}" berhasil ditambahkan.`
      );
      setTimeout(() => setAdminBannerMsg(null), 2500);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `categories/${id}`);
    } finally {
      setSavingCategory(false);
    }
  };

  const handleToggleCategoryActive = async (cat: StoreCategory) => {
    if (!canMasterEdit) return;
    try {
      await updateDoc(doc(db, 'categories', cat.id), {
        isActive: !cat.isActive,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `categories/${cat.id}`);
    }
  };

  const handleDeleteCategory = async (catId: string) => {
    if (!canMasterEdit) return;
    try {
      await deleteDoc(doc(db, 'categories', catId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `categories/${catId}`);
    }
  };

  const openAddPromoModal = (preselectedProductId?: string) => {
    setEditingPromo(null);
    setPromoTitle('');
    setPromoDescription('');
    setPromoType('combo');
    setPromoProductId(preselectedProductId || products[0]?.id || '');
    setPromoDiscountPercent('20');
    setPromoBuyQty('1');
    setPromoGetQty('2');
    setPromoStartDate('');
    setPromoEndDate('');
    setPromoAutoZeroStock(true);
    setPromoFormError(null);
    setPromoIsActive(true);
    setPromoModalOpen(true);
  };

  const openEditPromoModal = (promo: Promotion) => {
    setEditingPromo(promo);
    setPromoTitle(promo.title);
    setPromoDescription(promo.description);
    setPromoType(promo.promoType);
    setPromoProductId(promo.productId);
    setPromoDiscountPercent(String(promo.discountPercent || 20));
    setPromoBuyQty(String(promo.buyQty || 1));
    setPromoGetQty(String(promo.getQty || 1));
    setPromoStartDate(promo.startDate || '');
    setPromoEndDate(promo.endDate || '');
    setPromoAutoZeroStock(promo.autoZeroStockOnExpiry !== false);
    setPromoFormError(null);
    setPromoIsActive(promo.isActive);
    setPromoModalOpen(true);
  };

  const handleSavePromo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canMasterEdit || !promoProductId) return;
    setPromoFormError(null);

    const cleanStart = promoStartDate.trim().slice(0, 40);
    const cleanEnd = promoEndDate.trim().slice(0, 40);
    if (cleanStart && cleanEnd) {
      const startMs = Date.parse(cleanStart);
      const endMs = Date.parse(cleanEnd);
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs <= startMs) {
        setPromoFormError('Tanggal expired promosi harus lebih besar dari tanggal mulai periode.');
        return;
      }
    }

    setSavingPromo(true);

    const isQuantityPromo = promoType === 'combo' || promoType === 'buy_x_get_y';
    const safeDiscount =
      promoType === 'discount'
        ? Math.min(90, Math.max(1, Math.trunc(Number(promoDiscountPercent) || 10)))
        : 0;
    const safeBuy = isQuantityPromo
      ? Math.min(20, Math.max(1, Math.trunc(Number(promoBuyQty) || 1)))
      : 1;
    const safeGet = isQuantityPromo
      ? Math.min(20, Math.max(1, Math.trunc(Number(promoGetQty) || 1)))
      : 0;

    const id =
      editingPromo?.id ||
      `promo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    // Reset expiredStockZeroedAt if admin sets a new or future endDate
    const nextExpiredZeroedAt =
      editingPromo && editingPromo.endDate === cleanEnd && editingPromo.expiredStockZeroedAt
        ? editingPromo.expiredStockZeroedAt
        : '';

    try {
      if (editingPromo) {
        await updateDoc(doc(db, 'promotions', id), {
          title: promoTitle.trim().slice(0, FIELD_LIMITS.PROMO_TITLE_MAX),
          description: promoDescription.trim().slice(0, FIELD_LIMITS.PROMO_DESC_MAX),
          promoType,
          productId: promoProductId,
          discountPercent: safeDiscount,
          buyQty: safeBuy,
          getQty: safeGet,
          startDate: cleanStart,
          endDate: cleanEnd,
          autoZeroStockOnExpiry: Boolean(promoAutoZeroStock),
          expiredStockZeroedAt: nextExpiredZeroedAt,
          isActive: promoIsActive,
          updatedAt: serverTimestamp(),
        });
      } else {
        await setDoc(doc(db, 'promotions', id), {
          id,
          title: promoTitle.trim().slice(0, FIELD_LIMITS.PROMO_TITLE_MAX),
          description: promoDescription.trim().slice(0, FIELD_LIMITS.PROMO_DESC_MAX),
          promoType,
          productId: promoProductId,
          discountPercent: safeDiscount,
          buyQty: safeBuy,
          getQty: safeGet,
          startDate: cleanStart,
          endDate: cleanEnd,
          autoZeroStockOnExpiry: Boolean(promoAutoZeroStock),
          expiredStockZeroedAt: '',
          isActive: promoIsActive,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      processingExpiredPromoIdsRef.current.delete(id);
      broadcastCrossTabEvent({ type: 'revision_broadcast', source: 'promo_saved' });
      setPromoModalOpen(false);
      setAdminBannerMsg('Promosi berhasil disimpan dan otomatis aktif di seluruh akun.');
      setTimeout(() => setAdminBannerMsg(null), 2800);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `promotions/${id}`);
    } finally {
      setSavingPromo(false);
    }
  };

  const handleTogglePromoActive = async (promo: Promotion) => {
    if (!canMasterEdit) return;
    try {
      const nextActive = !promo.isActive;
      await updateDoc(doc(db, 'promotions', promo.id), {
        isActive: nextActive,
        updatedAt: serverTimestamp(),
      });
      setAdminBannerMsg(
        nextActive
          ? `Promo "${promo.title}" diaktifkan dan tampil di halaman pelanggan.`
          : `Promo "${promo.title}" dinonaktifkan — diskon langsung dicabut dari halaman pelanggan & keranjang.`
      );
      setTimeout(() => setAdminBannerMsg(null), 3000);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `promotions/${promo.id}`);
    }
  };

  const handleDisableAllPromos = async () => {
    if (!canMasterEdit) return;
    const activePromos = promotions.filter((p) => p.isActive);
    if (activePromos.length === 0) return;
    try {
      const batch = writeBatch(db);
      for (const promo of activePromos) {
        batch.update(doc(db, 'promotions', promo.id), {
          isActive: false,
          updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
      setAdminBannerMsg(
        `${activePromos.length} promo/diskon berhasil dinonaktifkan. Seluruh item kini kembali ke harga normal.`
      );
      setTimeout(() => setAdminBannerMsg(null), 3500);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'promotions');
    }
  };

  const handleDeletePromo = async (promoId: string) => {
    if (!canMasterEdit) return;
    try {
      await deleteDoc(doc(db, 'promotions', promoId));
      setAdminBannerMsg('Promo/diskon berhasil dihapus secara permanen.');
      setTimeout(() => setAdminBannerMsg(null), 2600);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `promotions/${promoId}`);
    }
  };

  const syncDeliveryRosterAndOrders = useCallback(
    async (accounts: DeliveryAccount[], explicitFeedKey?: string) => {
      const activeHashes = Array.from(
        new Set(
          accounts
            .filter((acc) => acc.isActive && acc.emailHash?.length === 64)
            .map((acc) => acc.emailHash)
        )
      ).slice(0, 20);
      const feedKey = explicitFeedKey || deliveryFeedKeyRef.current || DEFAULT_DELIVERY_FEED_KEY;

      await setDoc(doc(db, 'storeMeta', 'deliveryRoster'), {
        id: 'deliveryRoster',
        activeEmailHashes: activeHashes,
        directAccessKey: feedKey,
        updatedBy: (user?.email || BOOTSTRAPPED_ADMIN_EMAIL).slice(0, 128),
        updatedAt: serverTimestamp(),
      });

      const targetKey = activeHashes.join(',');
      const ordersNeedingSync = orders.filter(
        (o) => (o.deliveryEmailHashes || []).join(',') !== targetKey
      );

      for (let i = 0; i < ordersNeedingSync.length; i += 400) {
        const chunk = ordersNeedingSync.slice(i, i + 400);
        const batch = writeBatch(db);
        for (const o of chunk) {
          batch.update(doc(db, 'orders', o.id), {
            deliveryEmailHashes: activeHashes,
            updatedAt: serverTimestamp(),
          });
        }
        await batch.commit();
      }
    },
    [orders, user]
  );

  const handleSyncAllOrdersToDeliveryFeed = async (targetKey?: string) => {
    if (!canMasterEdit) return;
    const feedKey = targetKey || deliveryFeedKey || DEFAULT_DELIVERY_FEED_KEY;
    setSyncingDeliveryFeed(true);
    try {
      await syncDeliveryRosterAndOrders(deliveryAccounts, feedKey);
      for (let i = 0; i < orders.length; i += 350) {
        const chunk = orders.slice(i, i + 350);
        const batch = writeBatch(db);
        for (const o of chunk) {
          batch.set(
            doc(db, 'deliveryFeeds', feedKey, 'orders', o.id),
            buildDeliveryFeedPayload(o, o.status, o.trackingNumber || '')
          );
        }
        await batch.commit();
      }
      setAdminBannerMsg(
        `Link Delivery 1-Klik siap digunakan dan ${orders.length} pesanan telah disinkronkan.`
      );
      setTimeout(() => setAdminBannerMsg(null), 3500);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `deliveryFeeds/${feedKey}/orders`);
    } finally {
      setSyncingDeliveryFeed(false);
    }
  };

  const openAddDeliveryModal = () => {
    setEditingDelivery(null);
    setDName('');
    setDEmail('');
    setDPhone('');
    setDIsActive(true);
    setDErrorMsg(null);
    setDeliveryModalOpen(true);
  };

  const openEditDeliveryModal = (acc: DeliveryAccount) => {
    setEditingDelivery(acc);
    setDName(acc.name);
    setDEmail(acc.email);
    setDPhone(acc.phone);
    setDIsActive(acc.isActive);
    setDErrorMsg(null);
    setDeliveryModalOpen(true);
  };

  const handleSaveDeliveryAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canMasterEdit) return;
    setDErrorMsg(null);
    const cleanName = dName.trim().slice(0, FIELD_LIMITS.NAME_MAX);
    const cleanEmail = normalizeEmail(dEmail).slice(0, 120);
    const cleanPhone = dPhone.trim().slice(0, FIELD_LIMITS.PHONE_MAX);

    if (cleanName.length < FIELD_LIMITS.NAME_MIN) {
      setDErrorMsg('Nama akun delivery minimal 2 karakter.');
      return;
    }
    if (!cleanEmail.includes('@') || cleanEmail.length < 5) {
      setDErrorMsg('Masukkan alamat email Google yang valid.');
      return;
    }

    const duplicate = deliveryAccounts.find(
      (a) => a.email === cleanEmail && a.id !== editingDelivery?.id
    );
    if (duplicate) {
      setDErrorMsg(`Email "${cleanEmail}" sudah terdaftar di Akun Delivery.`);
      return;
    }

    setSavingDelivery(true);
    const id =
      editingDelivery?.id ||
      `deliv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    try {
      const emailHash = await sha256Hex(cleanEmail);
      let nextAccounts: DeliveryAccount[];

      if (editingDelivery) {
        await updateDoc(doc(db, 'deliveryAccounts', id), {
          name: cleanName,
          email: cleanEmail,
          emailHash,
          phone: cleanPhone,
          isActive: dIsActive,
          updatedAt: serverTimestamp(),
        });
        nextAccounts = deliveryAccounts.map((a) =>
          a.id === id
            ? {
                ...a,
                name: cleanName,
                email: cleanEmail,
                emailHash,
                phone: cleanPhone,
                isActive: dIsActive,
              }
            : a
        );
      } else {
        const newAcc: DeliveryAccount = {
          id,
          name: cleanName,
          email: cleanEmail,
          emailHash,
          phone: cleanPhone,
          isActive: dIsActive,
          createdAt: null,
          updatedAt: null,
        };
        await setDoc(doc(db, 'deliveryAccounts', id), {
          id,
          name: cleanName,
          email: cleanEmail,
          emailHash,
          phone: cleanPhone,
          isActive: dIsActive,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        nextAccounts = [...deliveryAccounts, newAcc];
      }

      await syncDeliveryRosterAndOrders(nextAccounts);
      setDeliveryModalOpen(false);
      setAdminBannerMsg(
        `Akun Delivery "${cleanName}" (${cleanEmail}) aktif dan otomatis menerima pesanan baru & alamat penerima.`
      );
      setTimeout(() => setAdminBannerMsg(null), 3200);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `deliveryAccounts/${id}`);
    } finally {
      setSavingDelivery(false);
    }
  };

  const handleToggleDeliveryActive = async (acc: DeliveryAccount) => {
    if (!canMasterEdit) return;
    try {
      const nextActive = !acc.isActive;
      await updateDoc(doc(db, 'deliveryAccounts', acc.id), {
        isActive: nextActive,
        updatedAt: serverTimestamp(),
      });
      const nextAccounts = deliveryAccounts.map((a) =>
        a.id === acc.id ? { ...a, isActive: nextActive } : a
      );
      await syncDeliveryRosterAndOrders(nextAccounts);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `deliveryAccounts/${acc.id}`);
    }
  };

  const handleDeleteDeliveryAccount = async (accId: string) => {
    if (!canMasterEdit) return;
    try {
      await deleteDoc(doc(db, 'deliveryAccounts', accId));
      const nextAccounts = deliveryAccounts.filter((a) => a.id !== accId);
      await syncDeliveryRosterAndOrders(nextAccounts);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `deliveryAccounts/${accId}`);
    }
  };

  const handleCopyOrderAddress = async (order: Order) => {
    const legacyAddress = [order.shippingAddress, order.city, order.postalCode]
      .filter(Boolean)
      .join(', ');
    const lines = [
      `Penerima: ${order.customerName} (Telegram: ${order.customerPhone})`,
      legacyAddress ? `Alamat: ${legacyAddress}` : '',
      order.locationDetail ? `Patokan: ${order.locationDetail}` : '',
      order.locationCoords ? `GPS: ${order.locationCoords}` : '',
      order.locationUrl ? `Maps: ${order.locationUrl}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    await copyTextToClipboard(lines);
    setCopiedOrderAddress(true);
    setTimeout(() => setCopiedOrderAddress(false), 1800);
  };

  const getOrderMapsHref = (order: Order): string => {
    if (order.locationUrl && order.locationUrl.startsWith('https://')) {
      return order.locationUrl;
    }
    if (order.locationCoords) {
      return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(order.locationCoords)}`;
    }
    const q = encodeURIComponent(
      `${order.shippingAddress}, ${order.city} ${order.postalCode}`.trim()
    );
    return `https://www.google.com/maps/search/?api=1&query=${q}`;
  };

  const applyOrderDatePreset = (preset: 'all' | 'today' | '7d' | '30d') => {
    if (preset === 'all') {
      setOrderDateFrom('');
      setOrderDateTo('');
      return;
    }
    const toLocalDateStr = (dt: Date) => {
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, '0');
      const d = String(dt.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    };
    const now = new Date();
    const todayStr = toLocalDateStr(now);
    if (preset === 'today') {
      setOrderDateFrom(todayStr);
      setOrderDateTo(todayStr);
      return;
    }
    const offsetDays = preset === '7d' ? 6 : 29;
    const startDt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offsetDays);
    setOrderDateFrom(toLocalDateStr(startDt));
    setOrderDateTo(todayStr);
  };

  const filteredOrders = useMemo(() => {
    const q = orderSearch.trim().toLowerCase();
    const parseLocalDateBound = (dateStr: string, bound: 'start' | 'end'): number | null => {
      const m = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return null;
      const y = Number(m[1]);
      const mo = Number(m[2]) - 1;
      const d = Number(m[3]);
      return bound === 'start'
        ? new Date(y, mo, d, 0, 0, 0, 0).getTime()
        : new Date(y, mo, d, 23, 59, 59, 999).getTime();
    };
    const fromMs = orderDateFrom ? parseLocalDateBound(orderDateFrom, 'start') : null;
    const toMs = orderDateTo ? parseLocalDateBound(orderDateTo, 'end') : null;

    return orders.filter((o) => {
      const matchStatus = orderFilter === 'all' || o.status === orderFilter;
      const orderMs = o.createdAt?.toMillis?.() ?? 0;
      const matchFrom = fromMs === null || (orderMs > 0 && orderMs >= fromMs);
      const matchTo = toMs === null || (orderMs > 0 && orderMs <= toMs);
      const matchQuery =
        !q ||
        o.orderNumber.toLowerCase().includes(q) ||
        o.customerName.toLowerCase().includes(q) ||
        o.trackingNumber.toLowerCase().includes(q) ||
        o.city.toLowerCase().includes(q) ||
        o.shippingAddress.toLowerCase().includes(q) ||
        (o.locationCoords || '').toLowerCase().includes(q) ||
        (o.locationDetail || '').toLowerCase().includes(q);
      return matchStatus && matchFrom && matchTo && matchQuery;
    });
  }, [orders, orderFilter, orderSearch, orderDateFrom, orderDateTo]);

  const metrics = useMemo(() => {
    const primaryCode = activeMaster.primaryCurrencyCode || 'USD';
    const secondaryCode = activeMaster.secondaryCurrencyCode || 'KHR';
    const activeOrders = orders.filter((o) => o.status !== 'cancelled');
    const totalUsdQr = activeOrders
      .filter((o) => (o.currency || primaryCode) === primaryCode)
      .reduce((acc, o) => acc + o.totalAmount, 0);
    const totalKhrCash = activeOrders
      .filter((o) => o.currency === secondaryCode)
      .reduce((acc, o) => acc + o.totalAmount, 0);
    const pendingCount = orders.filter((o) => o.status === 'pending').length;
    const processingCount = orders.filter((o) => o.status === 'processing').length;
    return {
      totalOrders: orders.length,
      totalUsdQr,
      totalKhrCash,
      pendingCount,
      processingCount,
    };
  }, [orders, activeMaster.primaryCurrencyCode, activeMaster.secondaryCurrencyCode]);

  const orderHistoryStats = useMemo(() => {
    const primaryCode = activeMaster.primaryCurrencyCode || 'USD';
    const secondaryCode = activeMaster.secondaryCurrencyCode || 'KHR';
    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    ).getTime();
    const sevenDaysAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = now.getTime() - 30 * 24 * 60 * 60 * 1000;

    const statusCounts: Record<OrderStatus, number> = {
      pending: 0,
      processing: 0,
      shipped: 0,
      completed: 0,
      cancelled: 0,
    };

    let todayCount = 0;
    let todayUsd = 0;
    let todayKhr = 0;
    let weekCount = 0;
    let weekUsd = 0;
    let weekKhr = 0;
    let monthCount = 0;
    let monthUsd = 0;
    let monthKhr = 0;
    let qrOrderCount = 0;
    let cashOrderCount = 0;

    for (const o of orders) {
      statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
      const ms = o.createdAt?.toMillis?.() ?? 0;
      const isActiveOrder = o.status !== 'cancelled';
      const cur = o.currency || primaryCode;

      if (isActiveOrder) {
        if (cur === secondaryCode) cashOrderCount += 1;
        else qrOrderCount += 1;
      }

      if (ms >= startOfToday) {
        todayCount += 1;
        if (isActiveOrder) {
          if (cur === secondaryCode) todayKhr += o.totalAmount;
          else todayUsd += o.totalAmount;
        }
      }
      if (ms >= sevenDaysAgo) {
        weekCount += 1;
        if (isActiveOrder) {
          if (cur === secondaryCode) weekKhr += o.totalAmount;
          else weekUsd += o.totalAmount;
        }
      }
      if (ms >= thirtyDaysAgo) {
        monthCount += 1;
        if (isActiveOrder) {
          if (cur === secondaryCode) monthKhr += o.totalAmount;
          else monthUsd += o.totalAmount;
        }
      }
    }

    const total = orders.length;
    const validOrders = total - statusCounts.cancelled;
    const completionRate =
      validOrders > 0
        ? Math.round((statusCounts.completed / validOrders) * 100)
        : 0;
    const paymentTotalCount = qrOrderCount + cashOrderCount;
    const qrPercent =
      paymentTotalCount > 0
        ? Math.round((qrOrderCount / paymentTotalCount) * 100)
        : 0;
    const cashPercent =
      paymentTotalCount > 0 ? 100 - qrPercent : 0;

    return {
      total,
      validOrders,
      completionRate,
      statusCounts,
      todayCount,
      todayUsd,
      todayKhr,
      weekCount,
      weekUsd,
      weekKhr,
      monthCount,
      monthUsd,
      monthKhr,
      qrOrderCount,
      cashOrderCount,
      qrPercent,
      cashPercent,
    };
  }, [orders]);

  const liveStoreOrigin = useMemo(() => {
    const cleanPerm = (masterConfig?.permanentStoreUrl || '').trim().replace(/\/+$/, '');
    if (cleanPerm && /^https:\/\//i.test(cleanPerm)) {
      return cleanPerm;
    }
    return getShareableOrigin();
  }, [masterConfig?.permanentStoreUrl]);

  const portalUrls = useMemo(() => {
    const origin = liveStoreOrigin;
    return [
      {
        key: 'customer',
        label: '1. Situs Pelanggan (Toko Online)',
        url: getShareablePortalUrl('customer', origin),
        desc: 'Langsung terbuka di semua iPhone, Android, Windows, dan Tablet tanpa perlu memasukkan email.',
        badgeClass: 'text-red-600 bg-red-50 border-red-200',
      },
      {
        key: 'delivery',
        label: '2. Situs Kurir Deliveri',
        url: getShareablePortalUrl('delivery', origin),
        desc: 'Langsung terbuka 1-klik di semua iPhone, Android, Windows, dan Tablet tanpa login email.',
        badgeClass: 'text-blue-700 bg-blue-50 border-blue-200',
      },
      {
        key: 'admin',
        label: '3. Situs Pengelola Admin',
        url: getShareablePortalUrl('admin', origin),
        desc: 'Khusus akun Admin yang terdaftar untuk mengelola pesanan, printer bill otomatis, statistik CSV, produk & akun tim.',
        badgeClass: 'text-slate-900 bg-slate-100 border-slate-300',
      },
    ];
  }, [liveStoreOrigin]);

  const handleCopyPortalUrl = async (key: string, url: string) => {
    await copyTextToClipboard(url);
    setCopiedPortalKey(key);
    setTimeout(
      () => setCopiedPortalKey((prev) => (prev === key ? null : prev)),
      1800
    );
  };

  const handleAdminSignIn = async () => {
    setAuthError(null);
    setAuthInfo(null);
    setUnauthorizedHost(null);
    setSigningIn(true);
    const { errorMessage, unauthorizedDomain, popupBlocked } =
      await signInWithGoogleSafe();
    setSigningIn(false);
    if (unauthorizedDomain) {
      setUnauthorizedHost(unauthorizedDomain);
      setAdminLoginTab('password');
    } else if (popupBlocked && (isIosDevice() || isAndroidDevice())) {
      setAdminLoginTab('password');
    }
    if (errorMessage) {
      setAuthError(errorMessage);
    }
  };

  const handleAdminRedirectSignIn = async () => {
    setAuthError(null);
    setAuthInfo(null);
    setRedirectingSignIn(true);
    const { errorMessage } = await signInWithGoogleRedirectSafe();
    setRedirectingSignIn(false);
    if (errorMessage) {
      setAuthError(errorMessage);
    }
  };

  const handleAdminEmailPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthInfo(null);
    setShowConsoleGuide(false);

    const cleanEmail = adminEmailInput.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      setAuthError('Masukkan alamat email Admin yang valid.');
      return;
    }
    if (adminPasswordInput.length < 6) {
      setAuthError('Password minimal 6 karakter.');
      return;
    }

    setPwdLoading(true);
    if (adminPwdMode === 'login') {
      const res = await signInWithEmailPasswordSafe(cleanEmail, adminPasswordInput);
      setPwdLoading(false);
      if (res.errorMessage) {
        setAuthError(res.errorMessage);
        if (res.providerNotEnabled) setShowConsoleGuide(true);
        if (res.userNotFound) setAdminPwdMode('activate');
      }
    } else {
      const res = await registerMasterEmailPasswordSafe(cleanEmail, adminPasswordInput);
      setPwdLoading(false);
      if (res.errorMessage) {
        setAuthError(res.errorMessage);
        if (res.providerNotEnabled) setShowConsoleGuide(true);
      } else if (res.verificationSent) {
        setAuthInfo(
          `Akun berhasil diaktivasi! Klik tautan verifikasi yang dikirim ke ${cleanEmail}, lalu tekan "Saya Sudah Verifikasi".`
        );
      }
    }
  };

  const handleAdminForgotPassword = async () => {
    setAuthError(null);
    setAuthInfo(null);
    const cleanEmail = adminEmailInput.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      setAuthError('Masukkan email Admin Anda terlebih dahulu.');
      return;
    }
    setPwdLoading(true);
    const res = await sendMasterPasswordResetSafe(cleanEmail);
    setPwdLoading(false);
    if (res.ok) setAuthInfo(res.message);
    else {
      setAuthError(res.message);
      if (res.message.includes('Firebase Console')) setShowConsoleGuide(true);
    }
  };

  const handleAdminCheckVerify = async () => {
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
          `Email ${user.email} belum terverifikasi. Buka inbox/spam, klik tautan verifikasi dari Firebase, lalu tekan tombol ini lagi.`
        );
      }
    } catch {
      setAuthError('Gagal memeriksa verifikasi. Muat ulang halaman lalu coba lagi.');
    } finally {
      setCheckingVerify(false);
    }
  };

  const handleAdminResendVerify = async () => {
    if (!user) return;
    setCheckingVerify(true);
    setAuthError(null);
    const res = await resendVerificationEmailSafe(user);
    setCheckingVerify(false);
    if (res.ok) setAuthInfo(res.message);
    else setAuthError(res.message);
  };

  const handleCopyAdminPortalUrl = async () => {
    await copyTextToClipboard(getShareablePortalUrl('admin', liveStoreOrigin));
    setCopiedAdminUrl(true);
    setTimeout(() => setCopiedAdminUrl(false), 2000);
  };

  const handleExportCsv = (period: CsvExportPeriod) => {
    const labelMap: Record<CsvExportPeriod, string> = {
      daily: 'Harian (Hari Ini)',
      weekly: 'Mingguan (7 Hari Terakhir)',
      monthly: 'Bulanan (30 Hari Terakhir)',
      all: 'Semua Pesanan',
    };
    const matching = filterOrdersByCsvPeriod(orders, period);
    if (matching.length === 0) {
      setAdminBannerMsg(
        `Belum ada pesanan pada periode ${labelMap[period]} untuk diekspor ke CSV. Coba pilih periode Mingguan, Bulanan, atau Semua Pesanan.`
      );
      setTimeout(() => setAdminBannerMsg(null), 4000);
      return;
    }
    const { count, filename } = exportOrdersToCsv(orders, period);
    setAdminBannerMsg(
      `Laporan CSV ${labelMap[period]} berhasil diunduh (${count} pesanan) — ${filename}. Siap dibuka di Excel, Google Sheets, atau WPS Office.`
    );
    setTimeout(() => setAdminBannerMsg(null), 4500);
  };

  // Dedicated Admin Gate
  if (!user) {
    const androidChromeHref =
      androidDevice && inAppBrowser
        ? getAndroidChromeIntentUrl(getShareablePortalUrl('admin', liveStoreOrigin))
        : '';

    return (
      <div className="min-h-screen bg-transparent flex items-center justify-center p-4 sm:p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-xl overflow-hidden shadow-lg">
          <div className="h-1.5 w-full bg-gradient-to-r from-red-600 via-white to-blue-700" />
          <div className="p-6 sm:p-8 space-y-5 text-center">
            <img
              src={activeStoreLogo}
              alt={activeStoreName}
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
            <div className="space-y-1.5">
              <p className="text-xs font-semibold text-red-600 inline-flex items-center justify-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Portal Pengelola Toko · Android, iPhone &amp; Laptop</span>
              </p>
              <h1 className="font-display text-xl font-bold text-slate-900">
                Masuk ke Akun Admin
              </h1>
              <p className="text-xs sm:text-sm text-slate-600">
                Cukup login 1 kali di browser ini untuk membuka <strong>Admin</strong> sekaligus <strong>Master Data, Delivery &amp; Toko</strong> dalam 1 browser.
              </p>
            </div>

            {/* Login Method Switcher: Google vs Email & Password (Zero Popup!) */}
            <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-100 rounded-lg text-xs font-semibold">
              <button
                type="button"
                onClick={() => {
                  setAdminLoginTab('google');
                  setAuthError(null);
                  setAuthInfo(null);
                }}
                className={`py-2 px-2 rounded-md transition-colors cursor-pointer ${
                  adminLoginTab === 'google'
                    ? 'bg-white text-blue-700 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Akun Google
              </button>
              <button
                type="button"
                onClick={() => {
                  setAdminLoginTab('password');
                  setAuthError(null);
                  setAuthInfo(null);
                }}
                className={`py-2 px-2 rounded-md transition-colors cursor-pointer ${
                  adminLoginTab === 'password'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Email &amp; Password (HP)
              </button>
            </div>

            {(inAppBrowser || iosDevice || androidDevice) && (
              <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-left text-xs text-amber-950 space-y-2">
                <p className="font-semibold">
                  {inAppBrowser
                    ? 'Terdeteksi Browser Dalam Aplikasi (WhatsApp / Telegram)'
                    : iosDevice
                      ? 'Panduan Login di iPhone / Safari'
                      : 'Panduan Login di HP Android'}
                </p>
                <p className="leading-relaxed text-amber-900">
                  {inAppBrowser
                    ? 'Google memblokir tombol Login Google di dalam WhatsApp/Telegram. Buka langsung di Chrome/Safari asli atau pakai tab "Email & Password (HP)" di atas.'
                    : iosDevice
                      ? 'Jika Pop-up Google terblokir di Safari iPhone: buka Pengaturan iPhone → Safari → matikan "Blokir Pop-up", atau pakai tab "Email & Password (HP)" (langsung masuk tanpa pop-up).'
                      : 'Pastikan dibuka di Google Chrome asli dengan Pop-up diizinkan, atau pakai tab "Email & Password (HP)" (langsung masuk tanpa pop-up).'}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {androidChromeHref && (
                    <a
                      href={androidChromeHref}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-white bg-blue-700 hover:bg-blue-800 rounded-md"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>Buka di Google Chrome Android</span>
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={handleCopyAdminPortalUrl}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-amber-950 bg-white border border-amber-300 rounded-md hover:bg-amber-100 cursor-pointer"
                  >
                    {copiedAdminUrl ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                        <span>Link HP Disalin</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Salin Link Admin (Android / iPhone)</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}

            {authError && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-left text-xs text-rose-800 leading-relaxed space-y-2">
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
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-left text-xs text-emerald-800 leading-relaxed">
                {authInfo}
              </div>
            )}

            {showConsoleGuide && (
              <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-left text-xs text-amber-950 space-y-1.5">
                <p className="font-bold">
                  Aktifkan Email &amp; Password (1 Kali Saja agar Bisa Login Tanpa Pop-up di Semua HP):
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
                    Klik <strong>Add new provider</strong> → pilih <strong>Email/Password</strong> → nyalakan <strong>Enable</strong> → <strong>Save</strong>.
                  </li>
                  <li>
                    Kembali ke sini, klik <strong>Aktivasi Pertama</strong>, masukkan email Admin/Master &amp; password Anda.
                  </li>
                </ol>
              </div>
            )}

            {adminLoginTab === 'google' ? (
              <div className="space-y-2.5">
                <button
                  type="button"
                  disabled={signingIn || redirectingSignIn}
                  onClick={handleAdminSignIn}
                  className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-semibold text-white bg-blue-700 rounded-lg hover:bg-red-600 transition-colors cursor-pointer disabled:opacity-60"
                >
                  <LogIn className="w-4 h-4" />
                  <span>
                    {signingIn
                      ? 'Membuka Login Google...'
                      : 'Masuk dengan Akun Admin Google'}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={signingIn || redirectingSignIn}
                  onClick={handleAdminRedirectSignIn}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-slate-800 bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200 transition-colors cursor-pointer disabled:opacity-60"
                >
                  <Globe className="w-4 h-4 text-blue-700" />
                  <span>
                    {redirectingSignIn
                      ? 'Mengalihkan ke Google...'
                      : 'Login Alternatif HP (Mode Redirect)'}
                  </span>
                </button>
              </div>
            ) : (
              <form
                onSubmit={handleAdminEmailPasswordSubmit}
                className="space-y-3 text-left"
              >
                <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-md text-[11px] font-semibold">
                  <button
                    type="button"
                    onClick={() => setAdminPwdMode('login')}
                    className={`py-1.5 rounded cursor-pointer ${
                      adminPwdMode === 'login'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600'
                    }`}
                  >
                    Masuk
                  </button>
                  <button
                    type="button"
                    onClick={() => setAdminPwdMode('activate')}
                    className={`py-1.5 rounded cursor-pointer ${
                      adminPwdMode === 'activate'
                        ? 'bg-white text-amber-800 shadow-xs'
                        : 'text-slate-600'
                    }`}
                  >
                    Aktivasi Pertama
                  </button>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Email Admin / Master
                  </label>
                  <input
                    type="email"
                    required
                    autoComplete="email"
                    value={adminEmailInput}
                    onChange={(e) => setAdminEmailInput(e.target.value)}
                    placeholder="Hananbintang30@gmail.com"
                    className="w-full px-3 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-semibold text-slate-700">
                      Password
                    </label>
                    {adminPwdMode === 'login' && (
                      <button
                        type="button"
                        onClick={handleAdminForgotPassword}
                        className="text-[11px] font-medium text-blue-700 hover:underline cursor-pointer"
                      >
                        Lupa password?
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <input
                      type={showAdminPassword ? 'text' : 'password'}
                      required
                      minLength={6}
                      autoComplete={
                        adminPwdMode === 'login' ? 'current-password' : 'new-password'
                      }
                      value={adminPasswordInput}
                      onChange={(e) => setAdminPasswordInput(e.target.value)}
                      placeholder="Minimal 6 karakter"
                      className="w-full pl-3 pr-10 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                    />
                    <button
                      type="button"
                      onClick={() => setShowAdminPassword((v) => !v)}
                      aria-label={showAdminPassword ? 'Sembunyikan' : 'Tampilkan'}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-500 hover:text-slate-800 cursor-pointer"
                    >
                      {showAdminPassword ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={pwdLoading}
                  className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 text-sm font-semibold text-white bg-slate-900 hover:bg-blue-700 rounded-lg transition-colors cursor-pointer disabled:opacity-60"
                >
                  <KeyRound className="w-4 h-4" />
                  <span>
                    {pwdLoading
                      ? 'Memverifikasi...'
                      : adminPwdMode === 'login'
                        ? 'Masuk dengan Email & Password'
                        : 'Aktivasi Password Pertama'}
                  </span>
                </button>
              </form>
            )}

            <p className="text-[11px] text-slate-500 leading-relaxed">
              Gunakan bar navigasi di paling atas untuk membuka <strong>Toko</strong>, <strong>Delivery</strong>, <strong>Admin</strong>, dan <strong>Master Data</strong> sekaligus dalam 1 browser.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Signed in via Email/Password but email not verified yet
  if (!user.emailVerified) {
    return (
      <div className="min-h-screen bg-transparent flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-xl p-8 space-y-5 text-center shadow-lg">
          <MailCheck className="w-10 h-10 text-amber-600 mx-auto" />
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-amber-700">
              Verifikasi 1 Kali Akun Admin
            </p>
            <h1 className="font-display text-xl font-bold text-slate-900">
              Cek Email {user.email}
            </h1>
            <p className="text-xs sm:text-sm text-slate-600">
              Buka inbox atau folder Spam di <strong>{user.email}</strong>, klik tautan verifikasi dari Firebase, lalu tekan tombol di bawah.
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
          <div className="flex flex-col gap-2">
            <button
              type="button"
              disabled={checkingVerify}
              onClick={handleAdminCheckVerify}
              className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer disabled:opacity-60"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>{checkingVerify ? 'Memeriksa...' : 'Saya Sudah Verifikasi Email'}</span>
            </button>
            <button
              type="button"
              disabled={checkingVerify}
              onClick={handleAdminResendVerify}
              className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-lg cursor-pointer disabled:opacity-60"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Kirim Ulang Email Verifikasi</span>
            </button>
            <button
              type="button"
              onClick={() => signOut(auth)}
              className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
              <span>Keluar</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-transparent flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-xl p-8 space-y-5 text-center shadow-lg">
          <ShieldAlert className="w-10 h-10 text-red-600 mx-auto" />
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-red-600">
              Situs Khusus Akun Admin
            </p>
            <h1 className="font-display text-xl font-bold text-slate-900">
              Akses Terbatas untuk Pengelola
            </h1>
            <p className="text-sm text-slate-600">
              Akun <span className="font-mono text-slate-900">{user.email}</span> bukan akun Admin. Halaman ini terpisah khusus untuk akun pengelola toko yang berwenang.
            </p>
          </div>
          {authError && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-left text-xs text-rose-800 leading-relaxed">
              {authError}
            </div>
          )}
          <div className="flex flex-col gap-2">
            <button
              type="button"
              disabled={signingIn || redirectingSignIn}
              onClick={handleAdminSignIn}
              className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 text-sm font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 cursor-pointer disabled:opacity-60"
            >
              <RefreshCw className="w-4 h-4" />
              <span>{signingIn ? 'Membuka Login...' : 'Ganti Akun Pengelola'}</span>
            </button>
            <button
              type="button"
              disabled={signingIn || redirectingSignIn}
              onClick={handleAdminRedirectSignIn}
              className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 text-xs font-semibold text-slate-800 bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200 cursor-pointer disabled:opacity-60"
            >
              <Globe className="w-4 h-4 text-blue-700" />
              <span>
                {redirectingSignIn
                  ? 'Mengalihkan ke Google...'
                  : 'Ganti Akun via Mode Redirect HP'}
              </span>
            </button>
            <button
              type="button"
              onClick={() => signOut(auth)}
              className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
              <span>Keluar</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        embeddedInMaster
          ? 'w-full'
          : 'min-h-screen bg-transparent flex flex-col lg:flex-row'
      }
    >
      {/* Sidebar Navigation (288px desktop — hidden when embedded inside Portal Master Data) */}
      {!embeddedInMaster && (
        <aside className="w-full lg:w-72 bg-white/95 backdrop-blur-xs border-b lg:border-b-0 lg:border-r border-slate-200 shrink-0 no-print flex flex-col">
          <div className="p-5 border-b border-slate-200 space-y-1.5">
            <div className="flex items-center gap-2.5">
              <img
                src={activeStoreLogo}
                alt={activeStoreName}
                referrerPolicy="no-referrer"
                onError={(e) => {
                  const img = e.currentTarget;
                  if (!img.dataset.fallbackApplied) {
                    img.dataset.fallbackApplied = '1';
                    img.src = DEFAULT_MASTER_CONFIG.storeLogoUrl;
                  }
                }}
                className="w-8 h-8 rounded-lg object-contain bg-white border border-slate-200 p-0.5 shrink-0"
              />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-red-600">
                  {canMasterEdit ? 'Admin · Akses Master' : 'Akun Khusus Admin'}
                </p>
                <p className="font-display text-sm font-bold text-slate-900 truncate">
                  {activeStoreName}
                </p>
              </div>
            </div>
            <p className="font-mono text-xs text-blue-700 truncate">{user.email}</p>
          </div>

        <nav className="p-3 flex lg:flex-col gap-1 overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab('orders')}
            className={`flex items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'orders'
                ? 'bg-blue-700 text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <ClipboardList className="w-4 h-4 shrink-0" />
              <span>Antrean Pesanan</span>
            </span>
            <span className="font-mono tabular-nums text-xs opacity-90">
              {orders.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('daily_history')}
            className={`flex items-center justify-between gap-2 px-3.5 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'daily_history'
                ? 'bg-blue-700 text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <Calendar className="w-4 h-4 shrink-0" />
              <span>Riwayat per Tanggal</span>
            </span>
            <span className="font-mono tabular-nums text-xs opacity-90">
              {orderHistoryStats.todayCount}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('stats')}
            className={`flex items-center justify-between gap-2 px-3.5 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'stats'
                ? 'bg-blue-700 text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <BarChart3 className="w-4 h-4 shrink-0" />
              <span>Statistik &amp; Riwayat</span>
            </span>
            <span className="font-mono tabular-nums text-xs opacity-90">
              {orderHistoryStats.completionRate}%
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('journal_pos')}
            className={`flex items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'journal_pos'
                ? 'bg-emerald-700 text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <RefreshCw className="w-4 h-4 shrink-0" />
              <span>INTEGRASI JOURNAL POS</span>
            </span>
            <span
              className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${
                activeTab === 'journal_pos'
                  ? 'bg-white/20 text-white'
                  : 'bg-emerald-100 text-emerald-800'
              }`}
            >
              POS
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('banners')}
            className={`flex items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'banners'
                ? 'bg-red-600 text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <ImageIcon className="w-4 h-4 shrink-0" />
              <span>Banner Depan</span>
            </span>
            <span className="font-mono tabular-nums text-xs opacity-90">
              {storeBanners.filter((b) => b.isActive).length || 3}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('background')}
            className={`flex items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'background'
                ? 'bg-blue-700 text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <Layers className="w-4 h-4 shrink-0" />
              <span>Background Latar</span>
            </span>
            <span
              className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${
                activeTab === 'background'
                  ? 'bg-white/20 text-white'
                  : 'bg-blue-100 text-blue-800'
              }`}
            >
              {(backgroundConfig?.enabled ?? true) ? 'ON' : 'OFF'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('checkout')}
            className={`flex items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'checkout'
                ? 'bg-blue-700 text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <Sliders className="w-4 h-4 shrink-0" />
              <span>Setting Checkout</span>
            </span>
            <span className="text-[11px] font-mono opacity-90">QR</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('hours')}
            className={`flex items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'hours'
                ? 'bg-blue-700 text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <Clock className="w-4 h-4 shrink-0" />
              <span>Jam Buka &amp; Tutup</span>
            </span>
            <span
              className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${
                activeTab === 'hours'
                  ? 'bg-white/20 text-white'
                  : evaluateStoreOpenStatus(storeHoursConfig).isOpen
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-red-100 text-red-700'
              }`}
            >
              {evaluateStoreOpenStatus(storeHoursConfig).isOpen ? 'BUKA' : 'TUTUP'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('promotions')}
            className={`flex items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'promotions'
                ? 'bg-red-600 text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <Tag className="w-4 h-4 shrink-0" />
              <span>Promosi & Diskon</span>
            </span>
            <span className="font-mono tabular-nums text-xs opacity-90">
              {promotions.filter((p) => p.isActive).length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('printer')}
            className={`flex items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'printer'
                ? 'bg-blue-700 text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <Bluetooth className="w-4 h-4 shrink-0" />
              <span>Setting Printer</span>
            </span>
            <span className="text-[11px] font-mono opacity-90">
              {connectedPrinterName
                ? 'BT ON'
                : printerSettings.autoPrintOnCheckout
                  ? 'AUTO'
                  : 'OFF'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('automation')}
            className={`flex items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'automation'
                ? 'bg-blue-700 text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <Settings className="w-4 h-4 shrink-0" />
              <span>Otomasi Toko</span>
            </span>
            <span className="text-xs font-mono opacity-90">
              {settings.autoConfirmOrders ? 'ON' : 'OFF'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('products')}
            className={`flex items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'products'
                ? 'bg-blue-700 text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <Box className="w-4 h-4 shrink-0" />
              <span>Inventaris Produk</span>
            </span>
            <span className="font-mono tabular-nums text-xs opacity-90">
              {products.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('categories')}
            className={`flex items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'categories'
                ? 'bg-blue-700 text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <FolderKanban className="w-4 h-4 shrink-0" />
              <span>Kategori Produk</span>
            </span>
            <span className="font-mono tabular-nums text-xs opacity-90">
              {categories.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('logs')}
            className={`flex items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'logs'
                ? 'bg-blue-700 text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <FileText className="w-4 h-4 shrink-0" />
              <span>Log Otomasi</span>
            </span>
            <span className="font-mono tabular-nums text-xs opacity-90">
              {logs.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('deliveries')}
            className={`flex items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'deliveries'
                ? 'bg-blue-700 text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <Truck className="w-4 h-4 shrink-0" />
              <span>Akun Delivery</span>
            </span>
            <span className="font-mono tabular-nums text-xs opacity-90">
              1-KLIK
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('portal_templates')}
            className={`flex items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'portal_templates'
                ? 'bg-blue-700 text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <Download className="w-4 h-4 shrink-0" />
              <span>Template Download Portal</span>
            </span>
            <span className="font-mono tabular-nums text-[11px] opacity-90">
              4 ZIP
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('account')}
            className={`flex items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'account'
                ? 'bg-red-600 text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="flex items-center gap-2.5">
              <ShieldCheck className="w-4 h-4 shrink-0" />
              <span>Akun Admin</span>
            </span>
            <span className="font-mono tabular-nums text-xs opacity-90">
              {adminAccounts.length + 1}
            </span>
          </button>
        </nav>

        <div className="p-4 mt-auto border-t border-slate-100 hidden lg:block space-y-2">
          <p className="text-xs text-slate-500 font-mono truncate">{liveStoreOrigin}</p>
          <button
            type="button"
            onClick={() => signOut(auth)}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Keluar Admin</span>
          </button>
        </div>
        </aside>
      )}

      {/* Main Viewport */}
      <main
        className={
          embeddedInMaster
            ? 'w-full space-y-6'
            : 'flex-1 min-w-0 p-4 sm:p-6 lg:p-8 space-y-6'
        }
      >
        {/* Contextual Header & Primary Action */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 no-print">
          <div>
            <p className="text-xs text-slate-500">
              Situs Khusus Admin /{' '}
              {activeTab === 'orders'
                ? 'Terima Pesanan & Pembaruan Status'
                : activeTab === 'daily_history'
                  ? 'Monitor Performa Penjualan Harian & Riwayat Pesanan Berdasarkan Tanggal'
                  : activeTab === 'stats'
                    ? 'Statistik Riwayat Pesanan & Pembayaran'
                  : activeTab === 'journal_pos'
                    ? 'Sinkronisasi Master Produk JOURNAL POS & Backup Data'
                    : activeTab === 'banners'
                      ? 'Template Image Carousel & Pengumuman Halaman Depan'
                      : activeTab === 'background'
                        ? 'Pengaturan Khusus Gambar Background Latar Belakang Semua Akun'
                        : activeTab === 'checkout'
                          ? 'Template Keranjang, Checkout, Ongkir & Barcode Pembayaran'
                          : activeTab === 'hours'
                            ? 'Template Jam Buka & Jam Tutup Operasional Toko'
                            : activeTab === 'deliveries'
                              ? 'Link 1-Klik Delivery Tanpa Email (Hanya Lihat)'
                              : activeTab === 'promotions'
                                ? 'Kelola Buy 1 Get 1 & Diskon'
                                : activeTab === 'categories'
                                  ? 'Edit & Atur Kategori Toko'
                                  : activeTab === 'printer'
                                    ? 'Printer Bluetooth Thermal & Auto-Cetak Bill'
                                    : activeTab === 'automation'
                                      ? 'Konfigurasi Otomasi Pesanan Toko'
                                      : activeTab === 'products'
                                        ? 'Inventaris Produk'
                                        : activeTab === 'logs'
                                          ? 'Log Aktivitas Otomatis'
                                          : activeTab === 'portal_templates'
                                            ? 'Template Download Masing-Masing Portal (1 Portal = 1 File ZIP)'
                                            : 'Pengaturan Akun Admin & 4 Situs Terpisah'}
            </p>
            <h1 className="font-display text-2xl font-bold text-slate-900 mt-0.5">
              {activeTab === 'orders'
                ? 'Daftar Pesanan, Pembaruan Status & GPS'
                : activeTab === 'daily_history'
                  ? 'Riwayat Pesanan per Tanggal & Performa Harian'
                  : activeTab === 'stats'
                    ? 'Statistik Riwayat Pesanan'
                  : activeTab === 'journal_pos'
                    ? 'INTEGRASI JOURNAL POS & Backup Master'
                    : activeTab === 'banners'
                      ? 'Template Banner & Carousel Halaman Depan'
                      : activeTab === 'background'
                        ? 'Ganti Gambar Background Latar Belakang (Semua Akun)'
                        : activeTab === 'checkout'
                          ? 'Setting Keranjang, Checkout & Barcode Pembayaran'
                          : activeTab === 'hours'
                            ? 'Template Jam Buka & Tutup Toko'
                            : activeTab === 'deliveries'
                              ? 'Akun Delivery (1-Klik Tanpa Email · Hanya Lihat)'
                              : activeTab === 'promotions'
                                ? 'Sistem Promosi Buy 1 Get 1 & Diskon'
                                : activeTab === 'categories'
                                  ? 'Manajemen & Edit Kategori Produk'
                                  : activeTab === 'printer'
                                    ? 'Setting Printer Bluetooth & Cetak Bill Otomatis'
                                    : activeTab === 'automation'
                                      ? 'Sistem Otomasi Pesanan Toko'
                                      : activeTab === 'products'
                                        ? 'Manajemen Produk & Stok'
                                        : activeTab === 'logs'
                                          ? 'Riwayat Otomasi Pesanan'
                                          : activeTab === 'portal_templates'
                                            ? 'Template Download Portal Terpisah (1 File / Portal)'
                                            : 'Akun Admin, Template Tambah Admin & 4 Situs'}
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            {(activeTab === 'orders' || activeTab === 'stats') && (
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Pilih periode laporan CSV"
                  value={csvPeriod}
                  onChange={(e) => setCsvPeriod(e.target.value as CsvExportPeriod)}
                  className="px-3 py-2 text-xs font-medium text-slate-800 bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600 cursor-pointer"
                >
                  <option value="daily">
                    Harian (Hari Ini · {orderHistoryStats.todayCount})
                  </option>
                  <option value="weekly">
                    Mingguan (7 Hari · {orderHistoryStats.weekCount})
                  </option>
                  <option value="monthly">
                    Bulanan (30 Hari · {orderHistoryStats.monthCount})
                  </option>
                  <option value="all">
                    Semua Pesanan ({orders.length})
                  </option>
                </select>
                <button
                  type="button"
                  onClick={() => handleExportCsv(csvPeriod)}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Download className="w-4 h-4" />
                  <span>Export ke CSV</span>
                </button>
              </div>
            )}
            {activeTab === 'orders' && (
              <button
                type="button"
                disabled={batchProcessing}
                onClick={handleManualBatchProcess}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-red-600 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
              >
                <PackageCheck className="w-4 h-4" />
                <span>
                  {batchProcessing
                    ? 'Memproses...'
                    : 'Proses Batch Otomatis'}
                </span>
              </button>
            )}
            {activeTab === 'deliveries' && canMasterEdit && (
              <button
                type="button"
                onClick={openAddDeliveryModal}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-red-600 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>Tambah Akun Delivery</span>
              </button>
            )}
            {activeTab === 'promotions' && canMasterEdit && (
              <>
                {promotions.some((p) => p.isActive) && (
                  <button
                    type="button"
                    onClick={handleDisableAllPromos}
                    className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <XCircle className="w-4 h-4 text-red-600" />
                    <span>Nonaktifkan Semua Promo</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => openAddPromoModal(promoScanSelectedProductId || undefined)}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Tambah Promo / Diskon</span>
                </button>
              </>
            )}
            {activeTab === 'categories' && canMasterEdit && (
              <button
                type="button"
                onClick={openAddCategoryModal}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-red-600 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>Tambah Kategori</span>
              </button>
            )}
            {activeTab === 'products' && canMasterEdit && (
              <>
                <button
                  type="button"
                  onClick={() => setMarketplaceImportOpen(true)}
                  className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-bold text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Database className="w-4 h-4" />
                  <span>Gabung Database Marketplace</span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('categories')}
                  className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <FolderKanban className="w-4 h-4 text-blue-700" />
                  <span>Edit Kategori</span>
                </button>
                <button
                  type="button"
                  onClick={openAddProductModal}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-red-600 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Tambah Produk</span>
                </button>
              </>
            )}
          </div>
        </div>

        {!canMasterEdit && (
          <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-950 flex items-start gap-2.5 no-print">
            <Lock className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
            <div>
              <p className="font-bold">
                Mode Admin Operasional · Edit &amp; Hapus Online Khusus Akun Master Data
              </p>
              <p className="text-amber-900 mt-0.5 leading-relaxed">
                Anda dapat menerima pesanan, memperbarui status pengiriman, mencetak bill thermal, dan ekspor CSV. Untuk mengedit atau menghapus katalog produk, kategori, promo, banner, pengaturan, akun, atau menghapus pesanan secara online, silakan masuk ke <strong>Akun Master Data</strong>.
              </p>
            </div>
          </div>
        )}

        {adminBannerMsg && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs font-medium text-emerald-800 no-print">
            {adminBannerMsg}
          </div>
        )}

        {/* KPI Summary Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 no-print">
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs text-slate-500">
              Pendapatan QR ({activeMaster.primaryCurrencyCode})
            </p>
            <p className="font-mono tabular-nums text-xl font-bold text-blue-700 mt-1">
              {formatAmountByCurrency(
                metrics.totalUsdQr,
                activeMaster.primaryCurrencyCode,
                activeMaster.primaryCurrencySymbol
              )}
            </p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs text-slate-500">
              Pendapatan CASH ({activeMaster.secondaryCurrencyCode})
            </p>
            <p className="font-mono tabular-nums text-xl font-bold text-red-600 mt-1">
              {formatAmountByCurrency(
                metrics.totalKhrCash,
                activeMaster.secondaryCurrencyCode,
                activeMaster.secondaryCurrencySymbol
              )}
            </p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs text-slate-500">Total Pesanan Masuk</p>
            <p className="font-mono tabular-nums text-xl font-bold text-slate-900 mt-1">
              {metrics.totalOrders}
            </p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs text-slate-500">Sedang Diproses</p>
            <p className="font-mono tabular-nums text-xl font-bold text-blue-700 mt-1">
              {metrics.processingCount}
            </p>
          </div>
        </div>

        {/* TAB 1: ORDER QUEUE */}
        {activeTab === 'orders' && (
          <div className="space-y-4">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 no-print">
              <div className="flex items-center gap-1 p-1 bg-white border border-slate-200 rounded-lg overflow-x-auto w-fit max-w-full">
                {(
                  [
                    ['all', 'Semua'],
                    ['pending', 'Menunggu'],
                    ['processing', 'Sedang Diproses'],
                    ['shipped', 'Dikirim'],
                    ['completed', 'Selesai'],
                    ['cancelled', 'Dibatalkan'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setOrderFilter(key)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      orderFilter === key
                        ? 'bg-blue-700 text-white'
                        : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={orderSearch}
                  onChange={(e) => setOrderSearch(e.target.value)}
                  placeholder="Cari kode order, pelanggan, resi..."
                  className="w-full md:w-72 pl-9 pr-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                />
              </div>
            </div>

            {/* Tarik Tanggal / Date Range Filter Bar */}
            <div className="bg-white border border-slate-200 rounded-xl p-3.5 flex flex-col lg:flex-row lg:items-center justify-between gap-3 no-print">
              <div className="flex flex-wrap items-center gap-2.5">
                <div className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-800">
                  <Calendar className="w-4 h-4 text-blue-700" />
                  <span>Tarik Tanggal:</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <label className="text-[11px] font-medium text-slate-500">Dari</label>
                  <input
                    type="date"
                    value={orderDateFrom}
                    onChange={(e) => setOrderDateFrom(e.target.value)}
                    aria-label="Dari tanggal pesanan"
                    className="px-2.5 py-1.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <label className="text-[11px] font-medium text-slate-500">Sampai</label>
                  <input
                    type="date"
                    value={orderDateTo}
                    onChange={(e) => setOrderDateTo(e.target.value)}
                    aria-label="Sampai tanggal pesanan"
                    className="px-2.5 py-1.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>
                <div className="flex items-center gap-1">
                  {(
                    [
                      ['all', 'Semua'],
                      ['today', 'Hari Ini'],
                      ['7d', '7 Hari'],
                      ['30d', '30 Hari'],
                    ] as const
                  ).map(([presetKey, presetLabel]) => (
                    <button
                      key={presetKey}
                      type="button"
                      onClick={() => applyOrderDatePreset(presetKey)}
                      className={`px-2.5 py-1.5 text-[11px] font-semibold rounded-md border transition-colors cursor-pointer ${
                        presetKey === 'all' && !orderDateFrom && !orderDateTo
                          ? 'bg-blue-700 text-white border-blue-700'
                          : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-blue-50 hover:text-blue-700'
                      }`}
                    >
                      {presetLabel}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <span className="text-xs text-slate-500 font-mono">
                  Menampilkan <strong className="text-slate-900">{filteredOrders.length}</strong> pesanan
                </span>
                <button
                  type="button"
                  disabled={filteredOrders.length === 0}
                  onClick={() => {
                    const { count, filename } = exportOrdersToCsv(filteredOrders, 'all');
                    setAdminBannerMsg(
                      `Export CSV (${count} pesanan sesuai filter tanggal${
                        orderDateFrom || orderDateTo
                          ? ` ${orderDateFrom || '...'} s/d ${orderDateTo || '...'}`
                          : ''
                      }) berhasil diunduh: ${filename}`
                    );
                    setTimeout(() => setAdminBannerMsg(null), 4500);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg transition-colors cursor-pointer disabled:opacity-40"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Export CSV Tanggal Ini</span>
                </button>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              {loadingOrders ? (
                <div className="p-8 space-y-3">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-10 bg-slate-100 rounded animate-pulse"
                    />
                  ))}
                </div>
              ) : filteredOrders.length === 0 ? (
                <div className="p-12 text-center space-y-2">
                  <ClipboardList className="w-8 h-8 text-slate-300 mx-auto" />
                  <p className="text-sm font-semibold text-slate-900">
                    Belum ada pesanan masuk pada filter ini
                  </p>
                  <p className="text-xs text-slate-500">
                    Setiap checkout dari halaman toko akan otomatis masuk ke akun khusus Admin ini.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-3 px-4">Kode Order</th>
                        <th className="py-3 px-4">Pelanggan</th>
                        <th className="py-3 px-4">Lokasi GPS</th>
                        <th className="py-3 px-4">Produk</th>
                        <th className="py-3 px-4">Bayar</th>
                        <th className="py-3 px-4 text-right">Total</th>
                        <th className="py-3 px-4">Nomor Resi</th>
                        <th className="py-3 px-4">Status</th>
                        <th className="py-3 px-4 text-right">Aksi</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-sm">
                      {filteredOrders.map((order) => {
                        const meta = ORDER_STATUS_META[order.status];
                        const cur = order.currency || 'USD';
                        const mapsHref = getOrderMapsHref(order);
                        const legacyAddress = [order.shippingAddress, order.city, order.postalCode]
                          .filter(Boolean)
                          .join(', ');
                        return (
                          <tr
                            key={order.id}
                            className="hover:bg-slate-50/80 transition-colors"
                          >
                            <td className="py-3 px-4 font-mono text-xs font-semibold text-slate-900 whitespace-nowrap">
                              {order.orderNumber}
                              <span className="block font-sans font-normal text-slate-400">
                                {formatTimestamp(order.createdAt)}
                              </span>
                            </td>
                            <td className="py-3 px-4">
                              <p className="font-medium text-slate-900 text-xs">
                                {order.customerName}
                              </p>
                              {getTelegramContactHref(order.customerPhone) ? (
                                <div className="space-y-0.5">
                                  <a
                                    href={getTelegramContactHref(order.customerPhone)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-xs text-sky-700 hover:underline font-mono inline-flex items-center gap-1"
                                  >
                                    <MessageCircle className="w-3 h-3 shrink-0" />
                                    <span>{order.customerPhone}</span>
                                  </a>
                                  {isLikelyTelegramBotContact(order.customerPhone) && (
                                    <p className="text-[10px] font-medium text-amber-700">
                                      Catatan: Kontak pelanggan berakhiran bot
                                    </p>
                                  )}
                                </div>
                              ) : (
                                <p className="text-xs text-slate-500 font-mono">
                                  Telegram: {order.customerPhone}
                                </p>
                              )}
                            </td>
                            <td className="py-3 px-4 max-w-xs">
                              {legacyAddress && (
                                <p className="text-xs text-slate-700 line-clamp-1">
                                  {legacyAddress}
                                </p>
                              )}
                              {order.locationDetail && (
                                <p className="text-[11px] text-slate-500 truncate">
                                  {order.locationDetail}
                                </p>
                              )}
                              <div className="flex flex-wrap items-center gap-2 mt-0.5">
                                {order.locationCoords && (
                                  <span className="font-mono text-xs font-medium text-blue-700">
                                    {order.locationCoords}
                                  </span>
                                )}
                                <a
                                  href={mapsHref}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-xs font-semibold text-red-600 hover:underline"
                                >
                                  <MapPin className="w-3.5 h-3.5" />
                                  <span>Buka Peta GPS</span>
                                </a>
                                {order.locationImageUrl && (
                                  <button
                                    type="button"
                                    onClick={() => setSelectedOrder(order)}
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded hover:bg-emerald-100 cursor-pointer"
                                  >
                                    <ImageIcon className="w-3 h-3" />
                                    <span>Foto Lokasi</span>
                                  </button>
                                )}
                                {order.deliveryProofImageUrl && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (
                                        order.deliveryProofImageUrl &&
                                        !isPdfProofDataUrl(order.deliveryProofImageUrl)
                                      ) {
                                        setLightboxImage({
                                          src: order.deliveryProofImageUrl,
                                          title: `Bukti Pengiriman · ${order.orderNumber} (${order.customerName})`,
                                          filename: `bukti-${order.orderNumber}.jpg`,
                                        });
                                      } else {
                                        setSelectedOrder(order);
                                      }
                                    }}
                                    title="Klik untuk membuka foto bukti pengiriman sesuai ukuran layar"
                                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-semibold border rounded cursor-pointer ${
                                      order.status === 'completed'
                                        ? 'text-emerald-700 bg-emerald-50 border-emerald-200 hover:bg-emerald-100'
                                        : 'text-amber-800 bg-amber-50 border-amber-200 hover:bg-amber-100'
                                    }`}
                                  >
                                    <CheckCircle2 className="w-3 h-3" />
                                    <span>
                                      {order.status === 'completed'
                                        ? 'Bukti · Sudah Diterima'
                                        : 'Foto · Belum Diterima'}
                                    </span>
                                  </button>
                                )}
                              </div>
                            </td>
                            <td className="py-3 px-4 text-xs text-slate-700">
                              <span className="font-medium">
                                {order.items[0]?.name}
                              </span>
                              {order.items.length > 1 && (
                                <span className="text-slate-500">
                                  {' '}
                                  +{order.items.length - 1} lainnya
                                </span>
                              )}
                            </td>
                            <td className="py-3 px-4 font-mono text-xs whitespace-nowrap">
                              <span
                                className={`font-semibold ${
                                  cur === 'KHR' ? 'text-red-600' : 'text-blue-700'
                                }`}
                              >
                                {order.paymentMethod} ({cur})
                              </span>
                            </td>
                            <td
                              className={`py-3 px-4 text-right font-mono tabular-nums text-xs font-bold whitespace-nowrap ${
                                cur === 'KHR' ? 'text-red-600' : 'text-blue-700'
                              }`}
                            >
                              {formatAmountByCurrency(order.totalAmount, cur)}
                            </td>
                            <td className="py-3 px-4 font-mono text-xs text-slate-700 whitespace-nowrap">
                              {order.trackingNumber || '—'}
                            </td>
                            <td className="py-3 px-4 whitespace-nowrap">
                              <div className="space-y-1">
                                <span
                                  className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium border rounded ${meta.toneClass}`}
                                >
                                  {order.status === 'pending' && (
                                    <Clock className="w-3 h-3" />
                                  )}
                                  {order.status === 'processing' && (
                                    <PackageCheck className="w-3 h-3" />
                                  )}
                                  {order.status === 'shipped' && (
                                    <Truck className="w-3 h-3" />
                                  )}
                                  {order.status === 'completed' && (
                                    <CheckCircle2 className="w-3 h-3" />
                                  )}
                                  {order.status === 'cancelled' && (
                                    <XCircle className="w-3 h-3" />
                                  )}
                                  <span>{meta.label}</span>
                                </span>
                                <p className="text-[11px] text-slate-400 font-mono">
                                  {formatTimestamp(order.updatedAt || order.createdAt)}
                                </p>
                              </div>
                            </td>
                            <td className="py-3 px-4 text-right whitespace-nowrap">
                              <div className="inline-flex items-center gap-1.5">
                                <select
                                  aria-label={`Perbarui status ${order.orderNumber}`}
                                  value={order.status}
                                  onChange={(e) =>
                                    handleAdvanceStatus(
                                      order,
                                      e.target.value as OrderStatus
                                    )
                                  }
                                  className="px-2 py-1 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-700 cursor-pointer"
                                >
                                  <option value="pending">Menunggu</option>
                                  <option value="processing">Sedang Diproses</option>
                                  <option value="shipped">Dikirim</option>
                                  <option value="completed">Selesai</option>
                                  <option value="cancelled">Dibatalkan</option>
                                </select>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setBillOrder(order);
                                    setBillAutoTriggered(false);
                                    setBillAutoStatus(null);
                                  }}
                                  title="Cetak Bill Thermal / Bluetooth"
                                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded hover:bg-blue-100 cursor-pointer"
                                >
                                  <Printer className="w-3.5 h-3.5" />
                                  <span>Bill</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setSelectedOrder(order)}
                                  className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 rounded hover:bg-slate-200 cursor-pointer"
                                >
                                  Detail
                                </button>
                                {isAdmin &&
                                  (confirmDeleteOrderId === order.id ? (
                                    <span className="inline-flex items-center gap-1">
                                      <button
                                        type="button"
                                        disabled={deletingOrderId === order.id}
                                        onClick={() => handleDeleteOrder(order)}
                                        className="px-2 py-1 text-[11px] font-bold text-white bg-red-600 hover:bg-red-700 rounded cursor-pointer disabled:opacity-50"
                                      >
                                        {deletingOrderId === order.id ? '...' : 'Ya, Hapus + Stok'}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setConfirmDeleteOrderId(null)}
                                        className="px-2 py-1 text-[11px] font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded cursor-pointer"
                                      >
                                        Batal
                                      </button>
                                    </span>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => setConfirmDeleteOrderId(order.id)}
                                      title="Hapus pesanan & otomatis kembalikan stok ke katalog"
                                      aria-label={`Hapus pesanan ${order.orderNumber} dan kembalikan stok`}
                                      className="p-1.5 text-slate-400 hover:text-red-600 rounded hover:bg-rose-50 cursor-pointer"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  ))}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 1B: DATE-BASED DAILY ORDER HISTORY & SALES PERFORMANCE MONITOR */}
        {activeTab === 'daily_history' && (
          <AdminDailyOrderHistoryPanel
            orders={orders}
            masterConfig={activeMaster}
            onSelectOrder={setSelectedOrder}
            onNotify={(msg) => {
              setAdminBannerMsg(msg);
              window.setTimeout(() => setAdminBannerMsg(null), 5000);
            }}
          />
        )}

        {/* TAB 1A: ORDER HISTORY STATISTICS */}
        {activeTab === 'stats' && (
          <div className="space-y-6">
            {/* Period Totals: Today / 7 Days / 30 Days + Quick CSV Export */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-3">
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-slate-500">Hari Ini</p>
                  <p className="font-mono tabular-nums text-2xl font-bold text-slate-900">
                    {orderHistoryStats.todayCount} pesanan
                  </p>
                  <div className="text-xs font-mono space-y-0.5">
                    <p className="text-blue-700">
                      QR {activeMaster.primaryCurrencyCode}:{' '}
                      {formatAmountByCurrency(
                        orderHistoryStats.todayUsd,
                        activeMaster.primaryCurrencyCode,
                        activeMaster.primaryCurrencySymbol
                      )}
                    </p>
                    <p className="text-red-600">
                      CASH {activeMaster.secondaryCurrencyCode}:{' '}
                      {formatAmountByCurrency(
                        orderHistoryStats.todayKhr,
                        activeMaster.secondaryCurrencyCode,
                        activeMaster.secondaryCurrencySymbol
                      )}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleExportCsv('daily')}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 transition-colors cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Export CSV Harian</span>
                </button>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-3">
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-slate-500">
                    7 Hari Terakhir
                  </p>
                  <p className="font-mono tabular-nums text-2xl font-bold text-slate-900">
                    {orderHistoryStats.weekCount} pesanan
                  </p>
                  <div className="text-xs font-mono space-y-0.5">
                    <p className="text-blue-700">
                      QR {activeMaster.primaryCurrencyCode}:{' '}
                      {formatAmountByCurrency(
                        orderHistoryStats.weekUsd,
                        activeMaster.primaryCurrencyCode,
                        activeMaster.primaryCurrencySymbol
                      )}
                    </p>
                    <p className="text-red-600">
                      CASH {activeMaster.secondaryCurrencyCode}:{' '}
                      {formatAmountByCurrency(
                        orderHistoryStats.weekKhr,
                        activeMaster.secondaryCurrencyCode,
                        activeMaster.secondaryCurrencySymbol
                      )}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleExportCsv('weekly')}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 transition-colors cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Export CSV Mingguan</span>
                </button>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-3">
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-slate-500">
                    30 Hari Terakhir
                  </p>
                  <p className="font-mono tabular-nums text-2xl font-bold text-slate-900">
                    {orderHistoryStats.monthCount} pesanan
                  </p>
                  <div className="text-xs font-mono space-y-0.5">
                    <p className="text-blue-700">
                      QR {activeMaster.primaryCurrencyCode}:{' '}
                      {formatAmountByCurrency(
                        orderHistoryStats.monthUsd,
                        activeMaster.primaryCurrencyCode,
                        activeMaster.primaryCurrencySymbol
                      )}
                    </p>
                    <p className="text-red-600">
                      CASH {activeMaster.secondaryCurrencyCode}:{' '}
                      {formatAmountByCurrency(
                        orderHistoryStats.monthKhr,
                        activeMaster.secondaryCurrencyCode,
                        activeMaster.secondaryCurrencySymbol
                      )}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleExportCsv('monthly')}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 transition-colors cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Export CSV Bulanan</span>
                </button>
              </div>
            </div>

            {/* Status Distribution & Payment Split */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-bold text-slate-900">
                    Distribusi Status Pesanan
                  </h2>
                  <span className="font-mono text-xs font-bold text-emerald-700">
                    Tingkat Selesai: {orderHistoryStats.completionRate}%
                  </span>
                </div>

                <div className="space-y-3">
                  {(
                    [
                      ['pending', 'Menunggu', 'bg-amber-500'],
                      ['processing', 'Sedang Diproses', 'bg-blue-600'],
                      ['shipped', 'Dikirim', 'bg-indigo-600'],
                      ['completed', 'Selesai', 'bg-emerald-600'],
                      ['cancelled', 'Dibatalkan', 'bg-rose-500'],
                    ] as const
                  ).map(([statusKey, label, barColor]) => {
                    const count = orderHistoryStats.statusCounts[statusKey];
                    const pct =
                      orderHistoryStats.total > 0
                        ? Math.round((count / orderHistoryStats.total) * 100)
                        : 0;
                    return (
                      <div key={statusKey} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium text-slate-700">
                            {label}
                          </span>
                          <span className="font-mono tabular-nums text-slate-900 font-semibold">
                            {count} ({pct}%)
                          </span>
                        </div>
                        <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                          <div
                            className={`h-full ${barColor} rounded-full transition-all`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                <h2 className="text-sm font-bold text-slate-900">
                  Statistik Metode Pembayaran (Pesanan Aktif)
                </h2>

                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 bg-blue-50/60 border border-blue-200 rounded-lg space-y-1">
                    <p className="text-xs font-semibold text-blue-700">
                      QR ({activeMaster.primaryCurrencyCode})
                    </p>
                    <p className="font-mono tabular-nums text-xl font-bold text-slate-900">
                      {orderHistoryStats.qrOrderCount} order
                    </p>
                    <p className="font-mono text-xs text-blue-700 font-semibold">
                      {orderHistoryStats.qrPercent}% ·{' '}
                      {formatAmountByCurrency(
                        metrics.totalUsdQr,
                        activeMaster.primaryCurrencyCode,
                        activeMaster.primaryCurrencySymbol
                      )}
                    </p>
                  </div>

                  <div className="p-4 bg-red-50/60 border border-red-200 rounded-lg space-y-1">
                    <p className="text-xs font-semibold text-red-600">
                      CASH ({activeMaster.secondaryCurrencyCode})
                    </p>
                    <p className="font-mono tabular-nums text-xl font-bold text-slate-900">
                      {orderHistoryStats.cashOrderCount} order
                    </p>
                    <p className="font-mono text-xs text-red-600 font-semibold">
                      {orderHistoryStats.cashPercent}% ·{' '}
                      {formatAmountByCurrency(
                        metrics.totalKhrCash,
                        activeMaster.secondaryCurrencyCode,
                        activeMaster.secondaryCurrencySymbol
                      )}
                    </p>
                  </div>
                </div>

                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600">
                  Seluruh pesanan menggunakan layanan{' '}
                  <strong className="text-emerald-700">FREE DELIVERY</strong> dan
                  otomatis sinkron ke riwayat Pelanggan, Admin, dan Delivery.
                </div>
              </div>
            </div>

            {/* Chronological Order History & Status Update Log */}
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-bold text-slate-900">
                    Riwayat Lengkap Pesanan &amp; Pembaruan Status
                  </h2>
                  <span className="font-mono text-xs text-slate-500">
                    {orders.length} total transaksi
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveTab('daily_history')}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs sm:text-sm font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <Calendar className="w-4 h-4" />
                    <span>Filter Riwayat per Tanggal</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleExportCsv('all')}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs sm:text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <Download className="w-4 h-4" />
                    <span>Export Semua ke CSV</span>
                  </button>
                </div>
              </div>

              {orders.length === 0 ? (
                <div className="p-10 text-center text-sm text-slate-500">
                  Belum ada riwayat pesanan tercatat.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-3 px-4">Order</th>
                        <th className="py-3 px-4">Dibuat</th>
                        <th className="py-3 px-4">Diperbarui</th>
                        <th className="py-3 px-4">Pelanggan</th>
                        <th className="py-3 px-4">Pembayaran</th>
                        <th className="py-3 px-4 text-right">Total</th>
                        <th className="py-3 px-4">Status</th>
                        <th className="py-3 px-4 text-right">Aksi</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {orders.map((o) => {
                        const cur = o.currency || 'USD';
                        const meta = ORDER_STATUS_META[o.status];
                        return (
                          <tr key={o.id} className="hover:bg-slate-50/80">
                            <td className="py-3 px-4 font-mono font-bold text-slate-900 whitespace-nowrap">
                              {o.orderNumber}
                            </td>
                            <td className="py-3 px-4 font-mono text-slate-500 whitespace-nowrap">
                              {formatTimestamp(o.createdAt)}
                            </td>
                            <td className="py-3 px-4 font-mono text-slate-700 whitespace-nowrap">
                              {formatTimestamp(o.updatedAt || o.createdAt)}
                            </td>
                            <td className="py-3 px-4">
                              <span className="font-medium text-slate-900">
                                {o.customerName}
                              </span>
                            </td>
                            <td className="py-3 px-4 font-mono whitespace-nowrap">
                              {o.paymentMethod} ({cur})
                            </td>
                            <td
                              className={`py-3 px-4 text-right font-mono font-bold whitespace-nowrap ${
                                cur === 'KHR' ? 'text-red-600' : 'text-blue-700'
                              }`}
                            >
                              {formatAmountByCurrency(o.totalAmount, cur)}
                            </td>
                            <td className="py-3 px-4 whitespace-nowrap">
                              <span
                                className={`inline-flex px-2 py-0.5 font-medium border rounded ${meta.toneClass}`}
                              >
                                {meta.label}
                              </span>
                            </td>
                            <td className="py-3 px-4 text-right whitespace-nowrap">
                              <button
                                type="button"
                                onClick={() => setSelectedOrder(o)}
                                className="px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 rounded hover:bg-blue-100 cursor-pointer"
                              >
                                Detail
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 1B: PROMOTIONS (BUY X GET Y & DISCOUNTS) */}
        {activeTab === 'promotions' && (() => {
          const scannedItemExistingPromo = promoScanSelectedProductId
            ? promotions.find((p) => p.productId === promoScanSelectedProductId) || null
            : null;
          const displayedPromotions = promoScanSelectedProductId
            ? promotions.filter((p) => p.productId === promoScanSelectedProductId)
            : promotions;
          const scannedItemObj = promoScanSelectedProductId
            ? products.find((p) => p.id === promoScanSelectedProductId) || null
            : null;

          return (
          <div className="space-y-4">
            {/* Barcode Scanner Directly on Promotions Page to Find & Promote Any Item Instantly */}
            <ProductBarcodeScanner
              products={products}
              selectedProductId={promoScanSelectedProductId}
              masterConfig={activeMaster}
              title="Scan Barcode Cari Item yang Akan Dipromosikan"
              subtitle="Gunakan kamera HP/Laptop, foto barcode, atau alat scan USB/Bluetooth untuk langsung menemukan item lalu buat promosinya dalam 1 klik."
              onSelectProduct={(matched) => {
                setPromoScanSelectedProductId(matched.id);
              }}
              getItemExtraLabel={(item) => {
                const existing = promotions.find((p) => p.productId === item.id);
                if (!existing) return 'Belum ada promo';
                return existing.isActive ? `Sudah ada promo: ${existing.title}` : 'Promo nonaktif';
              }}
              primaryActionLabel={
                canMasterEdit ? 'Buat Promo untuk Item Ini' : undefined
              }
              onPrimaryAction={
                canMasterEdit
                  ? (prod) => {
                      openAddPromoModal(prod.id);
                    }
                  : undefined
              }
              secondaryActionLabel={
                canMasterEdit && scannedItemExistingPromo
                  ? 'Edit Promo Item Ini'
                  : undefined
              }
              onSecondaryAction={
                canMasterEdit && scannedItemExistingPromo
                  ? () => {
                      openEditPromoModal(scannedItemExistingPromo);
                    }
                  : undefined
              }
            />

            {scannedItemObj && (
              <div className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-lg flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="text-slate-700">
                  Menampilkan promo khusus untuk hasil scan:{' '}
                  <strong className="text-slate-900">{scannedItemObj.name}</strong>{' '}
                  ({displayedPromotions.length} promo)
                </span>
                <button
                  type="button"
                  onClick={() => setPromoScanSelectedProductId('')}
                  className="text-blue-700 hover:underline font-semibold cursor-pointer whitespace-nowrap"
                >
                  Tampilkan Semua Promo ({promotions.length})
                </button>
              </div>
            )}

            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              {displayedPromotions.length === 0 ? (
                <div className="p-12 text-center space-y-3">
                  <Tag className="w-8 h-8 text-slate-300 mx-auto" />
                  <p className="text-sm font-semibold text-slate-900">
                    {scannedItemObj
                      ? `Belum ada promosi untuk "${scannedItemObj.name}"`
                      : 'Belum ada promosi aktif'}
                  </p>
                  <p className="text-xs text-slate-500 max-w-md mx-auto">
                    {scannedItemObj
                      ? 'Item hasil scan siap dipromosikan. Klik tombol di bawah untuk langsung membuat promo Combo (Beli X Free Y) atau Diskon %.'
                      : 'Buat promosi Combo (Beli 1 Free 2, Beli 2 Free 1, dll.), Buy X Get Y, atau diskon persentase lengkap dengan tanggal mulai & expired otomatis (stok otomatis jadi 0 saat periode habis).'}
                  </p>
                  {canMasterEdit && (
                    <button
                      type="button"
                      onClick={() => openAddPromoModal(scannedItemObj?.id)}
                      className="px-4 py-2 text-xs font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 cursor-pointer"
                    >
                      {scannedItemObj
                        ? `Buat Promo untuk ${scannedItemObj.name}`
                        : 'Buat Promo Pertama'}
                    </button>
                  )}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-3 px-4">Judul Promosi</th>
                        <th className="py-3 px-4">Produk Target</th>
                        <th className="py-3 px-4">Skema Promo</th>
                        <th className="py-3 px-4">Periode &amp; Expired</th>
                        <th className="py-3 px-4">Status</th>
                        <th className="py-3 px-4 text-right">Aksi</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-sm">
                      {displayedPromotions.map((promo) => {
                        const targetProd = products.find(
                          (p) => p.id === promo.productId
                        );
                        const unit = normalizeProductUnit(targetProd?.unit);
                        const isDiscount = promo.promoType === 'discount';
                        const isCombo = promo.promoType === 'combo';
                        const bundleSize = promo.buyQty + promo.getQty;
                        const schedule = getPromotionScheduleInfo(promo, promoClockMs);
                        const currentlyLive = isPromotionCurrentlyActive(promo, promoClockMs);

                        return (
                          <tr key={promo.id} className="hover:bg-slate-50/80">
                            <td className="py-3 px-4 max-w-xs">
                              <p className="text-xs font-bold text-slate-900">
                                {promo.title}
                              </p>
                              <p className="text-xs text-slate-500 line-clamp-1">
                                {promo.description}
                              </p>
                            </td>
                            <td className="py-3 px-4 text-xs text-slate-700">
                              {targetProd ? (
                                <>
                                  <span className="font-medium block">
                                    {targetProd.name}
                                  </span>
                                  <span className="font-mono text-slate-400">
                                    {formatPrimaryAmount(targetProd.price, activeMaster)} · {formatSecondaryAmount(targetProd.price, activeMaster)} · Stok {targetProd.stock} {unit}
                                  </span>
                                </>
                              ) : (
                                <span className="font-mono text-slate-400">
                                  {promo.productId}
                                </span>
                              )}
                            </td>
                            <td className="py-3 px-4 whitespace-nowrap text-xs">
                              {isCombo ? (
                                <div className="space-y-0.5">
                                  <span className="inline-flex items-center gap-1 font-mono font-bold text-emerald-700">
                                    <Layers className="w-3.5 h-3.5" />
                                    <span>
                                      Combo Beli {promo.buyQty} Free {promo.getQty}
                                    </span>
                                  </span>
                                  <span className="block text-[11px] text-slate-500">
                                    Input {bundleSize} {unit} (Stok -{bundleSize}) · Bayar {promo.buyQty} {unit}
                                  </span>
                                </div>
                              ) : isDiscount ? (
                                <span className="inline-flex items-center gap-1 font-mono font-bold text-blue-700">
                                  <Percent className="w-3.5 h-3.5" />
                                  <span>Diskon {promo.discountPercent}%</span>
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 font-mono font-bold text-red-600">
                                  <Gift className="w-3.5 h-3.5" />
                                  <span>
                                    Buy {promo.buyQty} Get {promo.getQty}
                                  </span>
                                </span>
                              )}
                            </td>
                            <td className="py-3 px-4 text-xs text-slate-600">
                              <div className="space-y-0.5">
                                <p className="font-medium text-slate-800 flex items-center gap-1">
                                  <CalendarClock className="w-3.5 h-3.5 text-blue-700 shrink-0" />
                                  <span>{schedule.periodLabel}</span>
                                </p>
                                {schedule.remainingLabel && (
                                  <p
                                    className={`text-[11px] font-mono font-semibold ${
                                      schedule.isExpired
                                        ? 'text-red-600'
                                        : schedule.isScheduled
                                          ? 'text-blue-700'
                                          : 'text-amber-700'
                                    }`}
                                  >
                                    {schedule.remainingLabel}
                                  </p>
                                )}
                                {promo.endDate && promo.autoZeroStockOnExpiry !== false && (
                                  <p className="text-[10px] font-medium text-slate-500">
                                    {promo.expiredStockZeroedAt
                                      ? 'Stok otomatis telah di-0-kan'
                                      : 'Auto stok jadi 0 saat expired'}
                                  </p>
                                )}
                              </div>
                            </td>
                            <td className="py-3 px-4 text-xs">
                              {schedule.isExpired ? (
                                <span className="px-2.5 py-1 rounded font-semibold inline-block bg-red-50 text-red-700 border border-red-200">
                                  Expired{promo.expiredStockZeroedAt ? ' · Stok 0' : ''}
                                </span>
                              ) : schedule.isScheduled && promo.isActive ? (
                                <span className="px-2.5 py-1 rounded font-semibold inline-block bg-blue-50 text-blue-700 border border-blue-200">
                                  Terjadwal
                                </span>
                              ) : canMasterEdit ? (
                                <button
                                  type="button"
                                  onClick={() => handleTogglePromoActive(promo)}
                                  className={`px-2.5 py-1 rounded font-semibold cursor-pointer ${
                                    currentlyLive
                                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                      : 'bg-slate-100 text-slate-500 border border-slate-200'
                                  }`}
                                >
                                  {currentlyLive ? 'Aktif' : 'Nonaktif'}
                                </button>
                              ) : (
                                <span
                                  className={`px-2.5 py-1 rounded font-semibold inline-block ${
                                    currentlyLive
                                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                      : 'bg-slate-100 text-slate-500 border border-slate-200'
                                  }`}
                                >
                                  {currentlyLive ? 'Aktif' : 'Nonaktif'}
                                </span>
                              )}
                            </td>
                            <td className="py-3 px-4 text-right whitespace-nowrap">
                              {canMasterEdit ? (
                                <div className="inline-flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => openEditPromoModal(promo)}
                                    aria-label={`Edit ${promo.title}`}
                                    className="p-1.5 text-slate-600 hover:text-blue-700 rounded hover:bg-slate-100 cursor-pointer"
                                  >
                                    <Edit3 className="w-4 h-4" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDeletePromo(promo.id)}
                                    aria-label={`Hapus ${promo.title}`}
                                    className="p-1.5 text-slate-500 hover:text-red-600 rounded hover:bg-slate-100 cursor-pointer"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </div>
                              ) : (
                                <span className="text-[11px] font-medium text-slate-400">
                                  Khusus Master
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
          );
        })()}

        {/* TAB 1C: CATEGORIES MANAGEMENT */}
        {activeTab === 'categories' && (
          <div className="space-y-4">
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              {categories.length === 0 ? (
                <div className="p-12 text-center space-y-3">
                  <FolderKanban className="w-8 h-8 text-slate-300 mx-auto" />
                  <p className="text-sm font-semibold text-slate-900">
                    Belum ada kategori tersimpan
                  </p>
                  <button
                    type="button"
                    onClick={openAddCategoryModal}
                    className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-red-600 cursor-pointer"
                  >
                    Tambah Kategori Pertama
                  </button>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-3 px-4">Urutan</th>
                        <th className="py-3 px-4">Nama Kategori</th>
                        <th className="py-3 px-4 text-right">Total Produk</th>
                        <th className="py-3 px-4 text-center">Stok Rendah (1–{lowStockLimit})</th>
                        <th className="py-3 px-4 text-center">Stok Kosong (0)</th>
                        <th className="py-3 px-4">Status</th>
                        <th className="py-3 px-4 text-right">Aksi</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-sm">
                      {categories.map((cat) => {
                        const catProducts = products.filter(
                          (p) => p.category === cat.name
                        );
                        const prodCount = catProducts.length;
                        const lowCount = catProducts.filter((p) => {
                          const st = Math.trunc(Number(p.stock ?? 0));
                          return st > 0 && st <= lowStockLimit;
                        }).length;
                        const emptyCount = catProducts.filter(
                          (p) => Math.trunc(Number(p.stock ?? 0)) <= 0
                        ).length;
                        return (
                          <tr key={cat.id} className="hover:bg-slate-50/80">
                            <td className="py-3 px-4 font-mono text-xs text-slate-500">
                              #{cat.sortOrder}
                            </td>
                            <td className="py-3 px-4 font-semibold text-xs text-slate-900">
                              {cat.name}
                            </td>
                            <td className="py-3 px-4 text-right font-mono tabular-nums text-xs">
                              <button
                                type="button"
                                onClick={() => {
                                  setProductCatalogCategory(cat.name);
                                  setProductCatalogFilter('all');
                                  setActiveTab('products');
                                }}
                                className="font-semibold text-slate-700 hover:text-blue-700 underline underline-offset-2 cursor-pointer"
                              >
                                {prodCount} produk
                              </button>
                            </td>
                            <td className="py-3 px-4 text-center">
                              <button
                                type="button"
                                onClick={() => {
                                  setProductCatalogCategory(cat.name);
                                  setProductCatalogFilter('low_stock');
                                  setActiveTab('products');
                                }}
                                className={`inline-flex items-center justify-center px-2.5 py-1 rounded text-xs font-mono font-bold border cursor-pointer transition-colors ${
                                  lowCount > 0
                                    ? 'bg-amber-50 text-amber-800 border-amber-300 hover:bg-amber-100'
                                    : 'bg-slate-50 text-slate-400 border-slate-200 hover:bg-slate-100'
                                }`}
                              >
                                {lowCount} rendah
                              </button>
                            </td>
                            <td className="py-3 px-4 text-center">
                              <button
                                type="button"
                                onClick={() => {
                                  setProductCatalogCategory(cat.name);
                                  setProductCatalogFilter('out_of_stock');
                                  setActiveTab('products');
                                }}
                                className={`inline-flex items-center justify-center px-2.5 py-1 rounded text-xs font-mono font-bold border cursor-pointer transition-colors ${
                                  emptyCount > 0
                                    ? 'bg-rose-50 text-rose-700 border-rose-300 hover:bg-rose-100'
                                    : 'bg-slate-50 text-slate-400 border-slate-200 hover:bg-slate-100'
                                }`}
                              >
                                {emptyCount} kosong
                              </button>
                            </td>
                            <td className="py-3 px-4 text-xs">
                              {canMasterEdit ? (
                                <button
                                  type="button"
                                  onClick={() => handleToggleCategoryActive(cat)}
                                  className={`px-2.5 py-1 rounded font-semibold cursor-pointer ${
                                    cat.isActive
                                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                      : 'bg-slate-100 text-slate-500 border border-slate-200'
                                  }`}
                                >
                                  {cat.isActive ? 'Aktif' : 'Nonaktif'}
                                </button>
                              ) : (
                                <span
                                  className={`px-2.5 py-1 rounded font-semibold inline-block ${
                                    cat.isActive
                                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                      : 'bg-slate-100 text-slate-500 border border-slate-200'
                                  }`}
                                >
                                  {cat.isActive ? 'Aktif' : 'Nonaktif'}
                                </span>
                              )}
                            </td>
                            <td className="py-3 px-4 text-right whitespace-nowrap">
                              {canMasterEdit ? (
                                <div className="inline-flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => openEditCategoryModal(cat)}
                                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 rounded hover:bg-blue-100 cursor-pointer"
                                  >
                                    <Edit3 className="w-3.5 h-3.5" />
                                    <span>Edit</span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteCategory(cat.id)}
                                    aria-label={`Hapus ${cat.name}`}
                                    className="p-1.5 text-slate-500 hover:text-red-600 rounded hover:bg-slate-100 cursor-pointer"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </div>
                              ) : (
                                <span className="text-[11px] font-medium text-slate-400">
                                  Khusus Master
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB: DELIVERY ACCOUNTS (1-CLICK NO-EMAIL READ-ONLY DISPATCH) */}
        {activeTab === 'deliveries' && (
          <div className="space-y-4">
            <div className="p-5 bg-blue-50/70 border border-blue-200 rounded-xl space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="text-xs font-bold text-blue-900">
                    Link Delivery 1-Klik Langsung Terbuka (Tanpa Login Email · Semua Merek HP)
                  </p>
                  <p className="text-xs text-blue-800 leading-relaxed">
                    Link kurir di bawah ini <strong>bersifat tetap (permanen)</strong> dan tidak berubah meski ada pembaruan aplikasi. Begitu diklik di iPhone, Android, Windows, atau Tablet, kurir langsung melihat pesanan masuk, foto lokasi, GPS, dan akun Telegram penerima tanpa perlu login email.
                  </p>
                </div>
                {canMasterEdit && (
                  <button
                    type="button"
                    onClick={openAddDeliveryModal}
                    className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-red-600 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    + Catat Data Kurir
                  </button>
                )}
              </div>

              <div className="p-3 bg-white border border-blue-200 rounded-lg space-y-2.5">
                <p className="font-mono text-xs text-blue-950 break-all">
                  {portalUrls[1].url}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      handleCopyPortalUrl('delivery_tab', portalUrls[1].url)
                    }
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 cursor-pointer"
                  >
                    {copiedPortalKey === 'delivery_tab' ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        <span>Link Disalin</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Salin Link Tetap Delivery</span>
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const msg = [
                        `Link Tetap Kurir Delivery ${activeStoreName} (1-Klik Tanpa Login Email):`,
                        portalUrls[1].url,
                        `Bisa dibuka di semua tipe iPhone, Android, Windows & Tablet. Cukup klik link untuk melihat pesanan masuk, GPS penerima & upload foto bukti sampai.`,
                      ].join('\n');
                      handleCopyPortalUrl('delivery_invite_direct', msg);
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 cursor-pointer"
                  >
                    {copiedPortalKey === 'delivery_invite_direct' ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        <span>Pesan Undangan Disalin</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Salin Pesan Undangan Kurir</span>
                      </>
                    )}
                  </button>
                  {canMasterEdit && (
                    <button
                      type="button"
                      disabled={syncingDeliveryFeed}
                      onClick={() => handleSyncAllOrdersToDeliveryFeed()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200 cursor-pointer disabled:opacity-50"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 ${syncingDeliveryFeed ? 'animate-spin' : ''}`}
                      />
                      <span>
                        {syncingDeliveryFeed
                          ? 'Menyinkronkan...'
                          : 'Sinkronkan Semua Pesanan'}
                      </span>
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              {deliveryAccounts.length === 0 ? (
                <div className="p-12 text-center space-y-2">
                  <Truck className="w-8 h-8 text-slate-300 mx-auto" />
                  <p className="text-sm font-semibold text-slate-900">
                    Belum ada Akun Delivery terdaftar
                  </p>
                  <p className="text-xs text-slate-500 max-w-md mx-auto">
                    Tambahkan email Google kurir Anda agar pesanan checkout pelanggan otomatis masuk ke akun Delivery.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-3 px-4">Nama Kurir</th>
                        <th className="py-3 px-4">Email Google Login</th>
                        <th className="py-3 px-4">No. Telepon</th>
                        <th className="py-3 px-4">Hak Akses</th>
                        <th className="py-3 px-4">Status</th>
                        <th className="py-3 px-4 text-right">Aksi</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-sm">
                      {deliveryAccounts.map((acc) => (
                        <tr key={acc.id} className="hover:bg-slate-50/80">
                          <td className="py-3 px-4 font-semibold text-slate-900 text-xs">
                            {acc.name}
                          </td>
                          <td className="py-3 px-4 font-mono text-xs text-blue-700">
                            {acc.email}
                          </td>
                          <td className="py-3 px-4 font-mono text-xs text-slate-600">
                            {acc.phone || '—'}
                          </td>
                          <td className="py-3 px-4 text-xs text-slate-600">
                            Hanya Lihat Pesanan &amp; Alamat
                          </td>
                          <td className="py-3 px-4 text-xs">
                            {canMasterEdit ? (
                              <button
                                type="button"
                                onClick={() => handleToggleDeliveryActive(acc)}
                                className={`font-semibold cursor-pointer ${
                                  acc.isActive ? 'text-emerald-700' : 'text-slate-400'
                                }`}
                              >
                                {acc.isActive ? 'Aktif' : 'Nonaktif'}
                              </button>
                            ) : (
                              <span
                                className={`font-semibold ${
                                  acc.isActive ? 'text-emerald-700' : 'text-slate-400'
                                }`}
                              >
                                {acc.isActive ? 'Aktif' : 'Nonaktif'}
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-4 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  const msg = [
                                    `Halo ${acc.name}, berikut link 1-Klik Akun Delivery ${activeStoreName}:`,
                                    `Link Situs Delivery (Tanpa Email): ${portalUrls[1].url}`,
                                    `Cara pakai: Cukup klik link di atas langsung dari HP untuk melihat pesanan masuk, foto lokasi & GPS penerima.`,
                                  ].join('\n');
                                  handleCopyPortalUrl(`invite_${acc.id}`, msg);
                                }}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded hover:bg-emerald-100 cursor-pointer"
                              >
                                {copiedPortalKey === `invite_${acc.id}` ? (
                                  <>
                                    <Check className="w-3.5 h-3.5" />
                                    <span>Tersalin</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="w-3.5 h-3.5" />
                                    <span>Salin Undangan</span>
                                  </>
                                )}
                              </button>
                              {normalizeWhatsAppNumber(acc.phone || '') && (
                                <a
                                  href={`https://wa.me/${normalizeWhatsAppNumber(acc.phone || '')}?text=${encodeURIComponent(
                                    [
                                      `Halo ${acc.name}, berikut link 1-Klik Akun Delivery ${activeStoreName}:`,
                                      `Link Situs Delivery (Tanpa Email): ${portalUrls[1].url}`,
                                      `Cukup klik link di atas langsung dari HP untuk melihat pesanan masuk, foto lokasi & GPS penerima.`,
                                    ].join('\n')
                                  )}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-white bg-[#25D366] rounded hover:bg-[#1EB956]"
                                >
                                  <MessageCircle className="w-3.5 h-3.5" />
                                  <span>Kirim WA</span>
                                </a>
                              )}
                              {canMasterEdit && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => openEditDeliveryModal(acc)}
                                    aria-label={`Edit ${acc.name}`}
                                    className="p-1.5 text-slate-600 hover:text-blue-700 rounded hover:bg-slate-100 cursor-pointer"
                                  >
                                    <Edit3 className="w-4 h-4" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteDeliveryAccount(acc.id)}
                                    aria-label={`Hapus ${acc.name}`}
                                    className="p-1.5 text-slate-500 hover:text-red-600 rounded hover:bg-slate-100 cursor-pointer"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 2A: BLUETOOTH THERMAL PRINTER & AUTO-BILL SETTINGS */}
        {activeTab === 'printer' && (
          <AdminPrinterSettingsPanel
            settings={printerSettings}
            connectedPrinterName={connectedPrinterName}
            onUpdateSettings={handleUpdatePrinterSettings}
            onPrinterConnectionChange={setConnectedPrinterName}
            onTriggerBrowserTestPrint={() => {
              const sampleOrder: Order = orders[0] || {
                id: 'test_bill',
                orderNumber: 'ALP-TEST-001',
                customerId: 'guest_test',
                customerName: 'Tes Cetak Bill',
                customerEmail: '',
                customerPhone: '081234567890',
                shippingAddress: '',
                city: '',
                postalCode: '',
                locationDetail: 'Contoh Patokan Lokasi',
                locationCoords: '11.556400, 104.928200',
                locationUrl: '',
                paymentMethod: 'QR',
                currency: 'USD',
                shippingMethod: 'FREE DELIVERY',
                notes: 'Contoh struk uji cetak',
                items: [
                  {
                    productId: 'sample_1',
                    name: 'Contoh Produk Toko',
                    price: 5,
                    quantity: 2,
                    imageUrl: '',
                  },
                ],
                subtotal: 10,
                shippingCost: 0,
                totalAmount: 10,
                status: 'processing',
                trackingNumber: 'ALP-TEST-RESI',
                autoProcessed: true,
                createdAt: null,
                updatedAt: null,
              };
              setBillOrder(sampleOrder);
              setBillAutoTriggered(false);
              setBillAutoStatus('Pratinjau Bill Uji Cetak siap dicetak.');
            }}
          />
        )}

        {/* TAB 2: STORE AUTOMATION */}
        {activeTab === 'automation' && (
          <form
            onSubmit={handleSaveSettings}
            className="bg-white border border-slate-200 rounded-xl p-6 max-w-2xl space-y-6"
          >
            <div className="flex items-start gap-3 pb-4 border-b border-slate-100">
              <Settings className="w-5 h-5 text-blue-700 shrink-0 mt-0.5" />
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Aturan Pemrosesan Pesanan Otomatis
                </h2>
                <p className="text-xs text-slate-600 mt-0.5">
                  Tentukan bagaimana pesanan yang masuk dari checkout pelanggan diproses secara otomatis oleh akun Admin.
                </p>
              </div>
            </div>

            <div className="space-y-4">
              <label className="flex items-start justify-between gap-4 p-4 border border-slate-200 rounded-lg cursor-pointer hover:bg-slate-50">
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    Auto-Verifikasi Pesanan Masuk
                  </p>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Pesanan baru otomatis berpindah dari Menunggu ke Sedang Diproses begitu masuk ke antrean Admin.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={settings.autoConfirmOrders}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      autoConfirmOrders: e.target.checked,
                    }))
                  }
                  className="mt-1 h-4 w-4 text-blue-700 rounded"
                />
              </label>

              <label className="flex items-start justify-between gap-4 p-4 border border-slate-200 rounded-lg cursor-pointer hover:bg-slate-50">
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    Terbitkan Nomor Resi Otomatis
                  </p>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Membuat nomor resi pengiriman unik secara otomatis saat pesanan diproses.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={settings.autoGenerateResi}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      autoGenerateResi: e.target.checked,
                    }))
                  }
                  className="mt-1 h-4 w-4 text-blue-700 rounded"
                />
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Prefiks Nomor Resi Toko
                  </label>
                  <input
                    type="text"
                    maxLength={16}
                    value={settings.defaultCourierPrefix}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        defaultCourierPrefix: e.target.value,
                      }))
                    }
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Batas Peringatan Stok Rendah (unit)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={settings.lowStockThreshold}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        lowStockThreshold: Number(e.target.value),
                      }))
                    }
                    className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-100 flex items-center justify-between gap-3">
              <span className="text-[11px] text-slate-500">
                {canMasterEdit
                  ? 'Perubahan pengaturan otomasi juga otomatis tersimpan permanen.'
                  : 'Pengaturan otomasi hanya dapat diubah oleh Akun Master Data.'}
              </span>
              {canMasterEdit && (
                <button
                  type="submit"
                  disabled={savingSettings}
                  className="px-5 py-2.5 text-sm font-semibold text-white bg-blue-700 rounded-lg hover:bg-red-600 transition-colors cursor-pointer disabled:opacity-50"
                >
                  {savingSettings ? 'Menyimpan...' : 'Simpan Pengaturan Otomasi'}
                </button>
              )}
            </div>
          </form>
        )}

        {/* TAB 3: PRODUCT INVENTORY */}
        {activeTab === 'products' && (
          <div className="space-y-4">
            {/* Category + Stock Separation Controls (Aman / Stok Rendah / Stok Kosong per Kategori) */}
            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2 flex-1">
                  <div className="relative flex-1 min-w-[200px]">
                    <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="search"
                      value={productCatalogSearch}
                      onChange={(e) => setProductCatalogSearch(e.target.value)}
                      placeholder="Cari nama produk, SKU, kategori..."
                      className="w-full pl-9 pr-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                    />
                  </div>
                  <select
                    aria-label="Filter Kategori Produk"
                    value={productCatalogCategory}
                    onChange={(e) => setProductCatalogCategory(e.target.value)}
                    className="px-3 py-2 text-xs font-semibold text-slate-800 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700 cursor-pointer"
                  >
                    <option value="ALL">Semua Kategori ({products.length})</option>
                    {adminCategoryList.map((cat) => (
                      <option key={cat.name} value={cat.name}>
                        {cat.name} ({cat.total} · Rendah {cat.low} · Kosong {cat.empty})
                      </option>
                    ))}
                  </select>
                </div>
                {canMasterEdit && (
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={autoFillRunning || productsNeedingImageCount === 0}
                      onClick={() => void handleBatchAutoFillCatalogImages()}
                      className="inline-flex items-center justify-center gap-2 px-3.5 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 ${autoFillRunning ? 'animate-spin' : ''}`}
                      />
                      <span>
                        {autoFillRunning
                          ? 'Mengisi Foto Otomatis...'
                          : `Isi Foto Otomatis (${productsNeedingImageCount})`}
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={autoFillRunning}
                      onClick={() => setBarcodeAutoImageOpen(true)}
                      className="inline-flex items-center justify-center gap-2 px-3.5 py-2 text-xs font-semibold text-white bg-indigo-700 hover:bg-indigo-800 rounded-lg cursor-pointer whitespace-nowrap disabled:opacity-50"
                    >
                      <Globe className="w-3.5 h-3.5" />
                      <span>Salin Foto KPS / Barcode</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setMarketplaceImportOpen(true)}
                      className="inline-flex items-center justify-center gap-2 px-3.5 py-2 text-xs font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg cursor-pointer whitespace-nowrap"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      <span>Impor Massal CSV/JSON</span>
                    </button>
                  </div>
                )}
              </div>

              {/* Per-Category Stock Separation Bar: Semua / Stok Aman / Stok Rendah / Stok Kosong */}
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100">
                <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mr-1">
                  {productCatalogCategory === 'ALL'
                    ? 'Filter Stok:'
                    : `Stok di ${productCatalogCategory}:`}
                </span>
                <button
                  type="button"
                  onClick={() => setProductCatalogFilter('all')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-lg border cursor-pointer transition-colors ${
                    productCatalogFilter === 'all'
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  Semua ({adminScopedStockCounts.total})
                </button>
                <button
                  type="button"
                  onClick={() => setProductCatalogFilter('safe_stock')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-lg border cursor-pointer transition-colors ${
                    productCatalogFilter === 'safe_stock'
                      ? 'bg-emerald-700 text-white border-emerald-700'
                      : 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
                  }`}
                >
                  Stok Aman (&gt;{lowStockLimit}) ({adminScopedStockCounts.safe})
                </button>
                <button
                  type="button"
                  onClick={() => setProductCatalogFilter('low_stock')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-lg border cursor-pointer transition-colors ${
                    productCatalogFilter === 'low_stock'
                      ? 'bg-amber-600 text-white border-amber-600'
                      : 'bg-amber-50 text-amber-800 border-amber-300 hover:bg-amber-100'
                  }`}
                >
                  Stok Rendah (1–{lowStockLimit}) ({adminScopedStockCounts.low})
                </button>
                <button
                  type="button"
                  onClick={() => setProductCatalogFilter('out_of_stock')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-lg border cursor-pointer transition-colors ${
                    productCatalogFilter === 'out_of_stock'
                      ? 'bg-rose-600 text-white border-rose-600'
                      : 'bg-rose-50 text-rose-700 border-rose-300 hover:bg-rose-100'
                  }`}
                >
                  Stok Kosong (0) ({adminScopedStockCounts.empty})
                </button>
                <button
                  type="button"
                  onClick={() => setProductCatalogFilter('needs_image')}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border cursor-pointer transition-colors ${
                    productCatalogFilter === 'needs_image'
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-indigo-50 text-indigo-800 border-indigo-200 hover:bg-indigo-100'
                  }`}
                >
                  <ImageIcon className="w-3.5 h-3.5" />
                  <span>Siap Edit Gambar ({adminScopedStockCounts.needsImg})</span>
                </button>
              </div>
            </div>

            {/* Live Progress Bar for Automatic Barcode/Name Catalog Image Fill */}
            {autoFillProgress && (
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="space-y-0.5 min-w-0">
                    <p className="font-bold text-blue-950">
                      {autoFillRunning
                        ? `Mencari foto otomatis dari Barcode & Nama Produk (${autoFillProgress.done} / ${autoFillProgress.total})`
                        : `Selesai mencari foto otomatis (${autoFillProgress.done} / ${autoFillProgress.total} item diperiksa)`}
                    </p>
                    <p className="text-blue-900 truncate">
                      {autoFillRunning
                        ? `Sedang memeriksa: ${autoFillProgress.currentName}`
                        : `Berhasil diisi: ${autoFillProgress.filled} · Belum ada di database barcode: ${autoFillProgress.missed} · Foto lama aman tidak tertimpa`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-mono tabular-nums font-semibold text-emerald-700">
                      Berhasil: {autoFillProgress.filled}
                    </span>
                    <span className="text-slate-300" aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums font-semibold text-slate-600">
                      Kosong: {autoFillProgress.missed}
                    </span>
                    {autoFillRunning ? (
                      <button
                        type="button"
                        onClick={() => {
                          autoFillCancelRef.current = true;
                        }}
                        className="px-2.5 py-1 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-md cursor-pointer"
                      >
                        Hentikan
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setAutoFillProgress(null)}
                        className="px-2.5 py-1 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-md cursor-pointer"
                      >
                        Tutup
                      </button>
                    )}
                  </div>
                </div>
                <div className="h-2 w-full bg-blue-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-700 transition-all duration-200"
                    style={{
                      width: `${Math.min(
                        100,
                        Math.round(
                          (autoFillProgress.done / Math.max(1, autoFillProgress.total)) * 100
                        )
                      )}%`,
                    }}
                  />
                </div>
              </div>
            )}

            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                      <th className="py-3 px-4">Produk</th>
                      <th className="py-3 px-4">SKU</th>
                      <th className="py-3 px-4">Kategori</th>
                      <th className="py-3 px-4 text-right">Harga QR ({activeMaster.primaryCurrencyCode})</th>
                      <th className="py-3 px-4 text-right">Harga CASH ({activeMaster.secondaryCurrencyCode})</th>
                      <th className="py-3 px-4 text-right">Stok</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4 text-right">Aksi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-sm">
                    {filteredAdminProducts.map((product) => {
                      const stockInt = Math.trunc(Number(product.stock ?? 0));
                      const isEmptyStock = stockInt <= 0;
                      const isLow = !isEmptyStock && stockInt <= lowStockLimit;
                      const needsImg = isProductNeedingImage(product.imageUrl);
                      return (
                        <tr key={product.id} className="hover:bg-slate-50/80">
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-3">
                              <button
                                type="button"
                                disabled={!canMasterEdit}
                                onClick={() => canMasterEdit && openEditProductModal(product)}
                                title={
                                  canMasterEdit
                                    ? 'Klik untuk ganti / lihat gambar produk'
                                    : 'Edit gambar produk khusus Akun Master Data'
                                }
                                className={`min-w-[48px] max-w-[72px] min-h-[40px] max-h-[56px] rounded border border-slate-200 overflow-hidden bg-white flex items-center justify-center p-0.5 shrink-0 ${
                                  canMasterEdit ? 'cursor-pointer hover:border-blue-500' : 'cursor-default'
                                }`}
                              >
                                <ProductImage
                                  src={product.imageUrl}
                                  alt={product.name}
                                  className="w-auto max-w-full h-auto max-h-12 object-contain"
                                />
                              </button>
                              <div className="min-w-0">
                                <span className="font-medium text-slate-900 text-xs block">
                                  {product.name}
                                </span>
                                {needsImg && canMasterEdit && (
                                  <div className="mt-0.5 flex flex-wrap items-center gap-2.5">
                                    <button
                                      type="button"
                                      disabled={autoFillRunning || autoFetchingRowId !== null}
                                      onClick={() => void handleSingleAutoFillProductImage(product)}
                                      className="inline-flex items-center gap-1 text-[10px] font-bold text-blue-700 hover:text-blue-900 cursor-pointer disabled:opacity-50"
                                    >
                                      <RefreshCw
                                        className={`w-3 h-3 ${
                                          autoFetchingRowId === product.id ? 'animate-spin' : ''
                                        }`}
                                      />
                                      <span>
                                        {autoFetchingRowId === product.id
                                          ? 'Mencari...'
                                          : 'Cari Foto Otomatis'}
                                      </span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => openEditProductModal(product)}
                                      className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-700 hover:text-blue-700 cursor-pointer"
                                    >
                                      <Camera className="w-3 h-3" />
                                      <span>Upload Manual</span>
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="py-3 px-4 font-mono text-xs text-slate-600">
                            {product.sku}
                          </td>
                          <td className="py-3 px-4 text-xs text-slate-600">
                            {product.category}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-xs font-bold text-blue-700 whitespace-nowrap">
                            {formatPrimaryAmount(product.price, activeMaster)}{' '}
                            <span className="text-[11px] font-semibold text-slate-500">
                              / {normalizeProductUnit(product.unit)}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-xs font-semibold text-red-600 whitespace-nowrap">
                            {formatSecondaryAmount(product.price, activeMaster)}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-xs font-semibold whitespace-nowrap">
                            {isEmptyStock ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200 font-bold">
                                0 {normalizeProductUnit(product.unit)} · Kosong
                              </span>
                            ) : isLow ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-300 font-bold">
                                {stockInt} {normalizeProductUnit(product.unit)} · Rendah
                              </span>
                            ) : (
                              <span className="text-slate-900">
                                {stockInt} {normalizeProductUnit(product.unit)}
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-4 text-xs">
                            <span
                              className={`font-medium ${
                                product.isActive
                                  ? 'text-emerald-700'
                                  : 'text-slate-400'
                              }`}
                            >
                              {product.isActive ? 'Aktif' : 'Nonaktif'}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right whitespace-nowrap">
                            {canMasterEdit ? (
                              <div className="inline-flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => openEditProductModal(product)}
                                  aria-label={`Edit ${product.name}`}
                                  className="p-1.5 text-slate-600 hover:text-blue-700 rounded hover:bg-slate-100 cursor-pointer"
                                >
                                  <Edit3 className="w-4 h-4" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteProduct(product.id)}
                                  aria-label={`Hapus ${product.name}`}
                                  className="p-1.5 text-slate-500 hover:text-red-600 rounded hover:bg-slate-100 cursor-pointer"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            ) : (
                              <span className="text-[11px] font-medium text-slate-400">
                                Khusus Master
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {filteredAdminProducts.length === 0 && (
                      <tr>
                        <td colSpan={8} className="py-10 text-center text-xs text-slate-500">
                          {productCatalogFilter === 'needs_image'
                            ? 'Semua produk di kategori ini sudah memiliki foto.'
                            : productCatalogFilter === 'out_of_stock'
                              ? 'Tidak ada produk dengan stok kosong (0) pada filter ini.'
                              : productCatalogFilter === 'low_stock'
                                ? `Tidak ada produk dengan stok rendah (1–${lowStockLimit}) pada filter ini.`
                                : productCatalogFilter === 'safe_stock'
                                  ? `Tidak ada produk dengan stok aman (>${lowStockLimit}) pada filter ini.`
                                  : 'Tidak ada produk yang cocok dengan pencarian Anda.'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: AUTOMATION AUDIT LOGS */}
        {activeTab === 'logs' && (
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            {logs.length === 0 ? (
              <div className="p-12 text-center text-sm text-slate-500">
                Belum ada riwayat aksi otomasi toko.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                      <th className="py-3 px-4">Waktu</th>
                      <th className="py-3 px-4">Nomor Order</th>
                      <th className="py-3 px-4">Aksi Otomasi Toko</th>
                      <th className="py-3 px-4">Keterangan</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {logs.map((log) => (
                      <tr key={log.id} className="hover:bg-slate-50/80">
                        <td className="py-3 px-4 font-mono text-slate-500 whitespace-nowrap">
                          {formatTimestamp(log.createdAt)}
                        </td>
                        <td className="py-3 px-4 font-mono font-semibold text-slate-900 whitespace-nowrap">
                          {log.orderNumber}
                        </td>
                        <td className="py-3 px-4 font-medium text-blue-700 whitespace-nowrap">
                          {log.action}
                        </td>
                        <td className="py-3 px-4 text-slate-600">{log.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* TAB: DEDICATED SEPARATED PORTAL DOWNLOAD TEMPLATES */}
        {activeTab === 'portal_templates' && (
          <PortalDownloadTemplatePanel
            storeName={activeStoreName}
            storeTagline={activeMaster.storeTagline}
            permanentStoreUrl={masterConfig?.permanentStoreUrl}
            onNotify={(msg) => {
              setAdminBannerMsg(msg);
              setTimeout(() => setAdminBannerMsg(null), 4500);
            }}
          />
        )}

        {/* TAB 5: DEDICATED ADMIN ACCOUNT & 3 SEPARATE SITES */}
        {activeTab === 'account' && (
          <div className="space-y-6 max-w-3xl">
            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
              <div className="flex items-start gap-3 pb-4 border-b border-slate-100">
                <ShieldCheck className="w-6 h-6 text-blue-700 shrink-0 mt-0.5" />
                <div>
                  <h2 className="text-base font-bold text-slate-900">
                    Akun Khusus Penerima Pesanan Customer
                  </h2>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Akun ini memiliki hak akses operasional untuk menerima seluruh pesanan checkout dari pelanggan, memverifikasi pembayaran CASH (KHR) dan QR (USD), serta memperbarui status pesanan toko {activeStoreName}.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-1">
                  <p className="text-xs text-slate-500">Email Admin Utama</p>
                  <p className="font-mono text-sm font-semibold text-blue-700">
                    {user.email}
                  </p>
                </div>
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-1">
                  <p className="text-xs text-slate-500">Link Marketplace Terhubung</p>
                  <p className="font-mono text-xs font-semibold text-red-600 break-all">
                    {portalUrls[0].url}
                  </p>
                </div>
                <div className="sm:col-span-2 p-4 bg-[#00526B]/5 border border-[#00526B]/20 rounded-lg space-y-1">
                  <p className="text-xs font-semibold text-[#00526B]">
                    Rekening QR ABA&apos; PAY Terhubung ({ABA_MERCHANT.network} · USD)
                  </p>
                  <p className="text-sm font-bold text-slate-900">
                    {ABA_MERCHANT.merchantName} · {ABA_MERCHANT.accountHolder}
                  </p>
                  <p className="font-mono text-xs text-slate-700">
                    No. Rekening ABA: {ABA_MERCHANT.accountNumber}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  disabled={signingIn}
                  onClick={handleAdminSignIn}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 cursor-pointer disabled:opacity-60"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Ganti Sesi Google</span>
                </button>
                <button
                  type="button"
                  onClick={() => signOut(auth)}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Keluar dari Akun Admin</span>
                </button>
              </div>
            </div>

            {/* Template & Management to Add New Admin Accounts (Master Data Only) */}
            {canMasterEdit && (
              <AdminAccountsPanel
                currentAdminEmail={user.email || BOOTSTRAPPED_ADMIN_EMAIL}
                adminAccounts={adminAccounts}
                adminPortalUrl={portalUrls[2].url}
                onNotify={(msg) => {
                  setAdminBannerMsg(msg);
                  setTimeout(() => setAdminBannerMsg(null), 3800);
                }}
              />
            )}

            {/* 3 Isolated Sites Reference Card */}
            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <Globe className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                  <div>
                    <h2 className="text-base font-bold text-slate-900">
                      4 Situs Terpisah (1 Situs = 1 Akun)
                    </h2>
                    <p className="text-xs text-slate-600 mt-0.5">
                      Pelanggan, Delivery, Admin, dan Master Data masing-masing memiliki link situs terpisah dan tersinkronisasi otomatis secara real-time.
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {(
                    [
                      ['customer', 'ZIP Pelanggan', 'bg-red-600 hover:bg-red-700'],
                      ['delivery', 'ZIP Deliveri', 'bg-blue-700 hover:bg-blue-800'],
                      ['admin', 'ZIP Admin', 'bg-slate-900 hover:bg-slate-800'],
                      ['master', 'ZIP Master', 'bg-amber-600 hover:bg-amber-700'],
                    ] as [PortalZipTarget, string, string][]
                  ).map(([portalKey, btnLabel, btnClass]) => (
                    <button
                      key={portalKey}
                      type="button"
                      onClick={() => {
                        const res = downloadSinglePortalDomainZip(portalKey, {
                          storeName: activeStoreName,
                          storeTagline: activeMaster.storeTagline,
                          customBaseOrigin: masterConfig?.permanentStoreUrl,
                        });
                        setAdminBannerMsg(
                          `${res.portalLabel} (1 file ZIP terpisah · Auto-Update) berhasil diunduh: ${res.filename}`
                        );
                        setTimeout(() => setAdminBannerMsg(null), 4500);
                      }}
                      className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white rounded-lg cursor-pointer whitespace-nowrap ${btnClass}`}
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>{btnLabel}</span>
                    </button>
                  ))}
                  {onOpenPortalGuide && (
                    <button
                      type="button"
                      onClick={onOpenPortalGuide}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 cursor-pointer whitespace-nowrap"
                    >
                      <Globe className="w-3.5 h-3.5" />
                      <span>Panduan Portal</span>
                    </button>
                  )}
                </div>
              </div>

              <div className="space-y-3">
                {portalUrls.map((portal) => (
                  <div
                    key={portal.key}
                    className="p-4 bg-slate-50 border border-slate-200 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div className="space-y-1 min-w-0">
                      <span
                        className={`inline-block text-[11px] font-bold px-2 py-0.5 border rounded ${portal.badgeClass}`}
                      >
                        {portal.label}
                      </span>
                      <p className="font-mono text-xs text-slate-900 truncate">
                        {portal.url}
                      </p>
                      <p className="text-xs text-slate-500">{portal.desc}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          const targetKey = portal.key as PortalZipTarget;
                          const res = downloadSinglePortalDomainZip(targetKey, {
                            storeName: activeStoreName,
                            storeTagline: activeMaster.storeTagline,
                            customBaseOrigin: masterConfig?.permanentStoreUrl,
                          });
                          setAdminBannerMsg(
                            `${res.portalLabel} (1 file ZIP terpisah · Auto-Update) berhasil diunduh: ${res.filename}`
                          );
                          setTimeout(() => setAdminBannerMsg(null), 4500);
                        }}
                        className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer whitespace-nowrap"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Download ZIP (1 File)</span>
                      </button>
                      {portal.key === 'customer' && (
                        <button
                          type="button"
                          onClick={() => {
                            const inviteText = [
                              `Belanja online di ${activeStoreName} (FREE DELIVERY)!`,
                              `Klik langsung (tanpa perlu masuk email): ${portal.url}`,
                              `Pilih produk, kirim lokasi GPS, lalu checkout langsung.`,
                            ].join('\n');
                            handleCopyPortalUrl('invite_customer', inviteText);
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 cursor-pointer whitespace-nowrap"
                        >
                          {copiedPortalKey === 'invite_customer' ? (
                            <>
                              <Check className="w-3.5 h-3.5 text-emerald-600" />
                              <span>Undangan Disalin</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5" />
                              <span>Salin Undangan 1-Klik Pelanggan</span>
                            </>
                          )}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleCopyPortalUrl(portal.key, portal.url)}
                        className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 cursor-pointer whitespace-nowrap"
                      >
                        {copiedPortalKey === portal.key ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-600" />
                            <span>Tersalin</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            <span>Salin Link</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Admin Telegram Support Config Card (Master Data Only) */}
            {canMasterEdit && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!user || !canMasterEdit) return;
                setSavingSupport(true);
                try {
                  const cleanHandle = normalizeTelegramHandle(
                    supportConfig.telegramUsername || ''
                  ).slice(0, FIELD_LIMITS.TELEGRAM_USERNAME_MAX);
                  const cleanDisplayName =
                    supportConfig.adminDisplayName
                      .trim()
                      .slice(0, FIELD_LIMITS.ADMIN_DISPLAY_NAME_MAX) ||
                    DEFAULT_STORE_SUPPORT.adminDisplayName;
                  const cleanGreeting =
                    supportConfig.greetingMessage
                      .trim()
                      .slice(0, FIELD_LIMITS.GREETING_MAX) ||
                    DEFAULT_STORE_SUPPORT.greetingMessage;

                  await setDoc(doc(db, 'storeSupport', 'telegram'), {
                    id: 'telegram',
                    telegramUsername: cleanHandle,
                    adminDisplayName: cleanDisplayName,
                    greetingMessage: cleanGreeting,
                    updatedBy: user.email || BOOTSTRAPPED_ADMIN_EMAIL,
                    updatedAt: serverTimestamp(),
                  });
                  setSupportConfig((prev) => ({
                    ...prev,
                    telegramUsername: cleanHandle,
                    adminDisplayName: cleanDisplayName,
                    greetingMessage: cleanGreeting,
                  }));
                  setAdminBannerMsg(
                    cleanHandle
                      ? `Telegram Admin (${cleanHandle.startsWith('+') ? cleanHandle : `@${cleanHandle}`}) aktif di tombol Chat Pelanggan.`
                      : 'Pengaturan chat Telegram Admin disimpan.'
                  );
                  setTimeout(() => setAdminBannerMsg(null), 3000);
                } catch (err) {
                  handleFirestoreError(
                    err,
                    OperationType.WRITE,
                    'storeSupport/telegram'
                  );
                } finally {
                  setSavingSupport(false);
                }
              }}
              className="bg-white border border-slate-200 rounded-xl p-6 space-y-4"
            >
              <div className="flex items-start gap-3 pb-3 border-b border-slate-100">
                <MessageCircle className="w-5 h-5 text-[#0088cc] shrink-0 mt-0.5" />
                <div>
                  <h2 className="text-base font-bold text-slate-900">
                    Tombol Chat Telegram Melayang (Halaman Pelanggan)
                  </h2>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Masukkan username Telegram Admin agar pelanggan bisa langsung klik tombol chat Telegram di kanan bawah situs toko untuk menanyakan status pesanan.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Username Telegram Admin (atau link t.me / no. HP)
                  </label>
                  <input
                    type="text"
                    maxLength={FIELD_LIMITS.TELEGRAM_USERNAME_MAX}
                    value={supportConfig.telegramUsername}
                    onChange={(e) =>
                      setSupportConfig((s) => ({
                        ...s,
                        telegramUsername: e.target.value,
                      }))
                    }
                    placeholder="Contoh: @alpamart_admin atau t.me/alpamart_admin"
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0088cc]"
                  />
                  {normalizeTelegramHandle(supportConfig.telegramUsername) && (
                    <p className="text-[11px] font-mono text-[#006699] mt-1">
                      Link aktif: https://t.me/
                      {normalizeTelegramHandle(supportConfig.telegramUsername)}
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Nama Tampilan Admin di Chat
                  </label>
                  <input
                    type="text"
                    required
                    minLength={2}
                    maxLength={FIELD_LIMITS.ADMIN_DISPLAY_NAME_MAX}
                    value={supportConfig.adminDisplayName}
                    onChange={(e) =>
                      setSupportConfig((s) => ({
                        ...s,
                        adminDisplayName: e.target.value,
                      }))
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0088cc]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Pesan Pembuka Otomatis Pelanggan
                </label>
                <input
                  type="text"
                  maxLength={FIELD_LIMITS.GREETING_MAX}
                  value={supportConfig.greetingMessage}
                  onChange={(e) =>
                    setSupportConfig((s) => ({
                      ...s,
                      greetingMessage: e.target.value,
                    }))
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0088cc]"
                />
              </div>

              <div className="flex justify-end pt-2 border-t border-slate-100">
                <button
                  type="submit"
                  disabled={savingSupport}
                  className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-[#0088cc] hover:bg-[#0077b5] rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                >
                  <MessageCircle className="w-4 h-4" />
                  <span>
                    {savingSupport
                      ? 'Menyimpan...'
                      : 'Simpan Telegram Admin'}
                  </span>
                </button>
              </div>
            </form>
            )}
          </div>
        )}

        {activeTab === 'banners' &&
          (canMasterEdit ? (
            <AdminBannerSettingsPanel
              banners={storeBanners}
              onNotify={(msg) => {
                setAdminBannerMsg(msg);
                setTimeout(() => setAdminBannerMsg(null), 3500);
              }}
            />
          ) : (
            <div className="bg-white border border-amber-200 rounded-xl p-6 flex items-start gap-3 text-sm text-slate-700">
              <Crown className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold text-slate-900">Edit &amp; Hapus Banner Khusus Akun Master Data</p>
                <p className="text-xs text-slate-600 mt-1">
                  Pengubahan atau penghapusan banner halaman depan hanya diizinkan melalui Portal Master Data.
                </p>
              </div>
            </div>
          ))}

        {activeTab === 'background' && (
          <AdminBackgroundSettingsPanel
            backgroundConfig={backgroundConfig || DEFAULT_STORE_BACKGROUND_CONFIG}
            adminEmail={user.email || BOOTSTRAPPED_ADMIN_EMAIL}
            baseThemeClassName={activeTheme.pageBg}
            onNotify={(msg) => {
              setAdminBannerMsg(msg);
              setTimeout(() => setAdminBannerMsg(null), 4000);
            }}
          />
        )}

        {activeTab === 'checkout' &&
          (canMasterEdit ? (
            <AdminCheckoutSettingsPanel
              config={checkoutConfig}
              masterConfig={activeMaster}
              adminEmail={user.email || BOOTSTRAPPED_ADMIN_EMAIL}
              onNotify={(msg) => {
                setAdminBannerMsg(msg);
                setTimeout(() => setAdminBannerMsg(null), 3500);
              }}
            />
          ) : (
            <div className="bg-white border border-amber-200 rounded-xl p-6 flex items-start gap-3 text-sm text-slate-700">
              <Crown className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold text-slate-900">Setting Checkout &amp; Barcode Khusus Akun Master Data</p>
                <p className="text-xs text-slate-600 mt-1">
                  Pengubahan rekening QR ABA, kurs checkout, ongkir, dan teks checkout hanya diizinkan melalui Portal Master Data.
                </p>
              </div>
            </div>
          ))}

        {activeTab === 'hours' &&
          (canMasterEdit ? (
            <AdminStoreHoursPanel
              hoursConfig={storeHoursConfig}
              adminEmail={user.email || BOOTSTRAPPED_ADMIN_EMAIL}
            />
          ) : (
            <div className="bg-white border border-amber-200 rounded-xl p-6 flex items-start gap-3 text-sm text-slate-700">
              <Crown className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold text-slate-900">Pengaturan Jam Buka &amp; Tutup Khusus Akun Master Data</p>
                <p className="text-xs text-slate-600 mt-1">
                  Perubahan jadwal buka/tutup toko hanya diizinkan melalui Portal Master Data.
                </p>
              </div>
            </div>
          ))}

        {activeTab === 'journal_pos' &&
          (canMasterEdit ? (
            <AdminJournalPosPanel
              user={user}
              products={products}
              categories={categories}
              exchangeRateKhr={liveKhrRate}
            />
          ) : (
            <div className="bg-white border border-amber-200 rounded-xl p-6 flex items-start gap-3 text-sm text-slate-700">
              <Crown className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold text-slate-900">Integrasi Journal POS Khusus Akun Master Data</p>
                <p className="text-xs text-slate-600 mt-1">
                  Sinkronisasi master katalog Journal POS dan backup database hanya diizinkan melalui Portal Master Data.
                </p>
              </div>
            </div>
          ))}
      </main>

      {/* Order Detail & Invoice Modal */}
      {selectedOrder && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Detail Pesanan ${selectedOrder.orderNumber}`}
        >
          <div className="bg-white border border-slate-200 rounded-xl max-w-2xl w-full max-h-[90dvh] overflow-y-auto shadow-xl">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between no-print">
              <div>
                <h3 className="font-display text-lg font-bold text-slate-900">
                  Faktur & Detail Pesanan
                </h3>
                <p className="font-mono text-xs text-slate-500">
                  {selectedOrder.orderNumber}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedOrder(null)}
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-6">
              <div className="flex flex-wrap justify-between gap-4 pb-4 border-b border-slate-200">
                <div>
                  <p className="font-display font-bold text-slate-900">
                    {activeStoreName}
                  </p>
                  <p className="font-mono text-xs text-slate-500 break-all">{liveStoreOrigin}</p>
                </div>
                <div className="text-right text-xs text-slate-600">
                  <p className="font-mono font-semibold text-slate-900">
                    {selectedOrder.orderNumber}
                  </p>
                  <p>{formatTimestamp(selectedOrder.createdAt)}</p>
                  {selectedOrder.trackingNumber && (
                    <p className="font-mono text-blue-700 font-semibold mt-0.5">
                      Resi: {selectedOrder.trackingNumber}
                    </p>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-1">
                  <p className="font-semibold text-slate-900">Data Penerima</p>
                  <p>{selectedOrder.customerName}</p>
                  {getTelegramContactHref(selectedOrder.customerPhone) ? (
                    <div className="space-y-0.5">
                      <a
                        href={getTelegramContactHref(selectedOrder.customerPhone)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-sky-700 hover:underline inline-flex items-center gap-1 font-semibold"
                      >
                        <MessageCircle className="w-3.5 h-3.5 shrink-0" />
                        <span>Telegram: {selectedOrder.customerPhone}</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                      {isLikelyTelegramBotContact(selectedOrder.customerPhone) && (
                        <p className="text-[11px] font-medium text-amber-700">
                          Pelanggan mengisi akun berakhiran &quot;bot&quot; (bukan username pribadi).
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="font-mono">Telegram: {selectedOrder.customerPhone}</p>
                  )}
                  {selectedOrder.customerEmail ? (
                    <p className="text-slate-600">{selectedOrder.customerEmail}</p>
                  ) : (
                    <p className="text-slate-400">Checkout 1-Klik (Tanpa Email)</p>
                  )}
                </div>
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-slate-900">
                      Lokasi GPS & Pembayaran
                    </p>
                    <button
                      type="button"
                      onClick={() => handleCopyOrderAddress(selectedOrder)}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100 cursor-pointer no-print"
                    >
                      {copiedOrderAddress ? (
                        <>
                          <Check className="w-3 h-3 text-emerald-600" />
                          <span>Tersalin</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          <span>Salin</span>
                        </>
                      )}
                    </button>
                  </div>
                  {(selectedOrder.shippingAddress || selectedOrder.city || selectedOrder.postalCode) && (
                    <p>
                      {[selectedOrder.shippingAddress, selectedOrder.city, selectedOrder.postalCode]
                        .filter(Boolean)
                        .join(', ')}
                    </p>
                  )}
                  {selectedOrder.locationDetail && (
                    <p className="text-slate-700">
                      Patokan: {selectedOrder.locationDetail}
                    </p>
                  )}
                  {selectedOrder.locationCoords && (
                    <p className="font-mono text-blue-700">
                      GPS: {selectedOrder.locationCoords}
                    </p>
                  )}
                  <a
                    href={getOrderMapsHref(selectedOrder)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-red-600 font-semibold hover:underline no-print"
                  >
                    <ExternalLink className="w-3 h-3" />
                    <span>Buka Lokasi GPS di Google Maps</span>
                  </a>
                  <p className="font-semibold text-blue-700 pt-1">
                    {selectedOrder.shippingMethod} · {selectedOrder.paymentMethod} (
                    {selectedOrder.currency || 'USD'})
                  </p>
                </div>
              </div>

              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <tr>
                      <th className="py-2.5 px-3">Item</th>
                      <th className="py-2.5 px-3 text-right">Qty</th>
                      <th className="py-2.5 px-3 text-right">Subtotal</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {selectedOrder.items.map((it) => (
                      <tr key={it.productId}>
                        <td className="py-2.5 px-3 font-medium text-slate-900">
                          {it.name}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                          {it.quantity} {normalizeProductUnit(it.unit)}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                          {formatAmountByCurrency(
                            it.price * it.quantity,
                            selectedOrder.currency || 'USD'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="space-y-1 text-sm text-right">
                <p className="text-xs text-slate-500">
                  Ongkir:{' '}
                  {selectedOrder.shippingCost === 0 ? (
                    <span className="font-semibold text-emerald-700">
                      FREE DELIVERY
                    </span>
                  ) : (
                    formatAmountByCurrency(
                      selectedOrder.shippingCost,
                      selectedOrder.currency || 'USD'
                    )
                  )}
                </p>
                <p className="font-mono tabular-nums text-lg font-bold text-slate-900">
                  Total:{' '}
                  {formatAmountByCurrency(
                    selectedOrder.totalAmount,
                    selectedOrder.currency || 'USD'
                  )}
                </p>
              </div>

              {selectedOrder.locationImageUrl && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
                  <p className="text-xs font-semibold text-slate-900 inline-flex items-center gap-1.5">
                    <ImageIcon className="w-4 h-4 text-emerald-600" />
                    <span>Foto Lokasi dari Pelanggan</span>
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      setLightboxImage({
                        src: selectedOrder.locationImageUrl || '',
                        title: `Foto Lokasi · ${selectedOrder.orderNumber} (${selectedOrder.customerName})`,
                        filename: `lokasi-${selectedOrder.orderNumber}.jpg`,
                      })
                    }
                    className="group relative block w-full rounded-lg overflow-hidden border border-slate-200 bg-white cursor-zoom-in text-left"
                    title="Klik untuk membuka foto lokasi sesuai ukuran layar"
                  >
                    <img
                      src={selectedOrder.locationImageUrl}
                      alt={`Foto lokasi ${selectedOrder.customerName}`}
                      className="w-full max-h-64 object-contain bg-white"
                    />
                    <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-white bg-slate-900/80 group-hover:bg-blue-700 rounded-md transition-colors">
                      <Maximize2 className="w-3 h-3" />
                      <span>Klik · Sesuai Layar</span>
                    </span>
                  </button>
                </div>
              )}

              {selectedOrder.deliveryProofImageUrl && (
                <div
                  className={`p-3 rounded-lg border space-y-2 ${
                    selectedOrder.status === 'completed'
                      ? 'bg-emerald-50 border-emerald-200'
                      : 'bg-amber-50 border-amber-200'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p
                      className={`text-xs font-semibold inline-flex items-center gap-1.5 ${
                        selectedOrder.status === 'completed'
                          ? 'text-emerald-900'
                          : 'text-amber-900'
                      }`}
                    >
                      <CheckCircle2
                        className={`w-4 h-4 ${
                          selectedOrder.status === 'completed'
                            ? 'text-emerald-700'
                            : 'text-amber-600'
                        }`}
                      />
                      <span>
                        {selectedOrder.status === 'completed'
                          ? 'Bukti Pengiriman Kurir · Sudah Diterima Pelanggan'
                          : 'Bukti Foto Kurir Tersimpan · Belum Diterima Pelanggan'}
                      </span>
                    </p>
                    <span
                      className={`font-mono text-[11px] ${
                        selectedOrder.status === 'completed'
                          ? 'text-emerald-800'
                          : 'text-amber-800'
                      }`}
                    >
                      {formatTimestamp(selectedOrder.updatedAt || selectedOrder.createdAt)}
                    </span>
                  </div>
                  <ProofAttachmentPreview
                    dataUrl={selectedOrder.deliveryProofImageUrl}
                    orderNumber={selectedOrder.orderNumber}
                    maxHeightClass="max-h-72"
                  />
                </div>
              )}

              {selectedOrder.notes && (
                <p className="text-xs text-slate-600 p-3 bg-slate-50 rounded-lg border border-slate-200">
                  Catatan Pelanggan: {selectedOrder.notes}
                </p>
              )}

              <div className="pt-4 border-t border-slate-200 space-y-3 no-print">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-semibold text-slate-900">
                    Pembaruan Status Pesanan
                  </span>
                  <span className="font-mono text-slate-500">
                    Diperbarui: {formatTimestamp(selectedOrder.updatedAt || selectedOrder.createdAt)}
                  </span>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setBillOrder(selectedOrder);
                        setBillAutoTriggered(false);
                        setBillAutoStatus(null);
                      }}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 cursor-pointer"
                    >
                      <Bluetooth className="w-4 h-4" />
                      <span>Cetak Bill Thermal</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => window.print()}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 cursor-pointer"
                    >
                      <Printer className="w-4 h-4" />
                      <span>Cetak Faktur</span>
                    </button>
                    {isAdmin &&
                      (confirmDeleteOrderId === selectedOrder.id ? (
                        <span className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={deletingOrderId === selectedOrder.id}
                            onClick={() => handleDeleteOrder(selectedOrder)}
                            className="px-3 py-2 text-xs font-bold text-white bg-red-600 hover:bg-red-700 rounded-lg cursor-pointer disabled:opacity-50"
                          >
                            {deletingOrderId === selectedOrder.id
                              ? 'Menghapus...'
                              : 'Ya, Hapus & Kembalikan Stok'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteOrderId(null)}
                            className="px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                          >
                            Batal
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteOrderId(selectedOrder.id)}
                          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-red-700 bg-rose-50 border border-rose-200 hover:bg-rose-100 rounded-lg cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                          <span>Hapus Order &amp; Kembalikan Stok</span>
                        </button>
                      ))}
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {(
                      [
                        ['pending', 'Menunggu', 'bg-amber-600'],
                        ['processing', 'Sedang Diproses', 'bg-blue-700'],
                        ['shipped', 'Dikirim', 'bg-indigo-600'],
                        ['completed', 'Selesai', 'bg-emerald-600'],
                        ['cancelled', 'Dibatalkan', 'bg-rose-600'],
                      ] as const
                    ).map(([statusKey, label, activeBg]) => {
                      const isCurrent = selectedOrder.status === statusKey;
                      return (
                        <button
                          key={statusKey}
                          type="button"
                          disabled={isCurrent}
                          onClick={() => handleAdvanceStatus(selectedOrder, statusKey)}
                          className={`px-3 py-2 text-xs font-semibold rounded-lg transition-colors ${
                            isCurrent
                              ? `${activeBg} text-white cursor-default`
                              : 'text-slate-700 bg-slate-100 hover:bg-slate-200 cursor-pointer'
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Product Add/Edit Modal */}
      {productModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 no-print"
          role="dialog"
          aria-modal="true"
          aria-label={editingProduct ? 'Edit Produk' : 'Tambah Produk'}
        >
          <div className="bg-white border border-slate-200 rounded-xl max-w-lg w-full max-h-[90dvh] overflow-y-auto shadow-xl">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-lg font-bold text-slate-900">
                {editingProduct ? 'Edit Produk' : 'Tambah Produk Baru'}
              </h3>
              <button
                type="button"
                onClick={() => setProductModalOpen(false)}
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveProduct} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Nama Produk
                </label>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={FIELD_LIMITS.PRODUCT_NAME_MAX}
                  value={pName}
                  onChange={(e) => setPName(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    SKU
                  </label>
                  <input
                    type="text"
                    required
                    minLength={2}
                    maxLength={FIELD_LIMITS.SKU_MAX}
                    value={pSku}
                    onChange={(e) => setPSku(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-medium text-slate-700">
                      Kategori
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setProductModalOpen(false);
                        setActiveTab('categories');
                      }}
                      className="text-[11px] font-semibold text-blue-700 hover:underline cursor-pointer"
                    >
                      Edit Daftar Kategori
                    </button>
                  </div>
                  <select
                    value={pCategory}
                    onChange={(e) =>
                      setPCategory(e.target.value as ProductCategory)
                    }
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                  >
                    {availableCategoryNames.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Harga Jual QR ({activeMaster.primaryCurrencyCode}) · Bisa Pakai Titik
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    required
                    value={pPrice}
                    onChange={(e) => handlePriceInputChange(e.target.value)}
                    placeholder="Contoh: 1.50 atau 0.75"
                    className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                  {pPriceError ? (
                    <p className="text-[11px] text-rose-600 mt-1">{pPriceError}</p>
                  ) : (
                    <p className="text-[11px] font-mono text-red-600 mt-1">
                      {Number.isFinite(parsedProductPrice) && parsedProductPrice >= 0.01
                        ? `QR: ${formatPrimaryAmount(parsedProductPrice, activeMaster)} · CASH: ${formatSecondaryAmount(parsedProductPrice, activeMaster)}`
                        : 'Masukkan angka harga (contoh: 1.50 atau 12.99)'}
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Stok Tersedia ({pUnit})
                  </label>
                  <input
                    type="number"
                    required
                    min={0}
                    value={pStock}
                    onChange={(e) => setPStock(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Satuan Item
                </label>
                <div className="grid grid-cols-5 gap-1.5">
                  {PRODUCT_UNITS.map((unitOption) => {
                    const active = pUnit === unitOption;
                    return (
                      <button
                        key={unitOption}
                        type="button"
                        onClick={() => setPUnit(unitOption)}
                        className={`py-2 px-1 text-xs font-mono font-bold rounded-lg border transition-colors cursor-pointer ${
                          active
                            ? 'bg-blue-700 text-white border-blue-700'
                            : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        {unitOption}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Adaptive Product Image Upload & Preview Box (Follows Original Dimensions Without Cropping) */}
              <div className="space-y-2.5 p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <label className="block text-xs font-bold text-slate-900">
                      Foto / Gambar Produk (Mengikuti Ukuran Asli Tanpa Potong)
                    </label>
                    <p className="text-[11px] text-slate-500">
                      Kotak gambar otomatis menyesuaikan lebar &amp; tinggi gambar asli Anda.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {editingProduct && (
                      <span
                        className={`text-[11px] font-semibold px-2 py-0.5 rounded border ${
                          productAutoSaveState === 'saving'
                            ? 'bg-blue-50 text-blue-700 border-blue-200'
                            : productAutoSaveState === 'saved'
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : productAutoSaveState === 'error'
                                ? 'bg-rose-50 text-rose-700 border-rose-200'
                                : 'bg-white text-slate-500 border-slate-200'
                        }`}
                      >
                        {productAutoSaveState === 'saving'
                          ? 'Menyimpan otomatis...'
                          : productAutoSaveState === 'saved'
                            ? 'Tersimpan otomatis permanen'
                            : productAutoSaveState === 'error'
                              ? 'Gagal auto-save'
                              : 'Auto-Save Aktif'}
                      </span>
                    )}
                  </div>
                </div>

                {/* Adaptive Frame: expands/shrinks naturally to the exact aspect ratio of the photo */}
                <div className="w-full rounded-xl border-2 border-dashed border-slate-300 bg-white p-3 flex flex-col items-center justify-center gap-3">
                  {pImageUrl ? (
                    <div className="relative inline-flex flex-col items-center max-w-full">
                      <ProductImage
                        src={pImageUrl}
                        alt={pName || 'Preview Gambar Produk'}
                        onDimensionsLoad={(dims) => setPImageDims(dims)}
                        className="w-auto max-w-full h-auto max-h-[380px] object-contain rounded-lg border border-slate-200 bg-white shadow-xs"
                      />
                      {pImageDims && (
                        <span className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-0.5 text-[11px] font-mono font-semibold text-slate-700 bg-slate-100 border border-slate-200 rounded">
                          Ukuran Asli: {pImageDims.width} × {pImageDims.height} px
                        </span>
                      )}
                    </div>
                  ) : (
                    <div className="py-6 text-center text-xs text-slate-500">
                      Belum ada gambar dipilih. Klik tombol di bawah untuk mengunggah foto.
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <label className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-red-600 rounded-lg transition-colors cursor-pointer">
                      <Camera className="w-4 h-4" />
                      <span>
                        {uploadingProductImage
                          ? 'Memproses Foto...'
                          : pImageUrl && !isProductNeedingImage(pImageUrl)
                            ? 'Ganti Foto dari Galeri / Kamera'
                            : 'Upload Foto Produk (Galeri / Kamera)'}
                      </span>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => void handleUploadProductImage(e)}
                        className="sr-only"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={autoFetchingModalImage || uploadingProductImage}
                      onClick={() => void handleAutoFetchModalProductImage()}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-blue-800 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 ${autoFetchingModalImage ? 'animate-spin' : ''}`}
                      />
                      <span>
                        {autoFetchingModalImage
                          ? 'Mencari Foto...'
                          : 'Cari Foto Otomatis (Barcode/Nama)'}
                      </span>
                    </button>
                    {pImageUrl && !isProductNeedingImage(pImageUrl) && (
                      <button
                        type="button"
                        onClick={() => {
                          setPImageUrl(PLACEHOLDER_PRODUCT_IMAGE_URL);
                          setPImageDims(null);
                          setPImageFeedback(null);
                        }}
                        className="inline-flex items-center gap-1 px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-rose-50 hover:text-rose-700 border border-slate-200 rounded-lg cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Reset Gambar</span>
                      </button>
                    )}
                  </div>
                </div>

                {pImageFeedback && (
                  <p
                    className={`text-[11px] leading-relaxed ${
                      pImageFeedback.startsWith('Foto siap')
                        ? 'text-emerald-700 font-medium'
                        : 'text-rose-700'
                    }`}
                  >
                    {pImageFeedback}
                  </p>
                )}

                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    Atau Tempel Link URL Gambar (Opsional)
                  </label>
                  <input
                    type="text"
                    value={pImageUrl.startsWith('data:image/') ? '' : pImageUrl}
                    onChange={(e) => {
                      setPImageDims(null);
                      setPImageFeedback(null);
                      setPImageUrl(e.target.value);
                    }}
                    placeholder={
                      pImageUrl.startsWith('data:image/')
                        ? 'Foto terunggah dari perangkat (tersimpan otomatis) — ketik https:// untuk ganti ke URL'
                        : 'https://... atau unggah foto lewat tombol di atas'
                    }
                    className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Deskripsi Produk
                </label>
                <textarea
                  rows={3}
                  required
                  minLength={2}
                  maxLength={FIELD_LIMITS.DESCRIPTION_MAX}
                  value={pDescription}
                  onChange={(e) => setPDescription(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                />
              </div>

              <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={pIsActive}
                  onChange={(e) => setPIsActive(e.target.checked)}
                />
                <span>Tampilkan produk di etalase toko</span>
              </label>

              <div className="pt-3 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] text-slate-500">
                  {editingProduct
                    ? 'Setiap perubahan otomatis tersimpan permanen.'
                    : 'Klik Simpan Produk untuk menambahkan ke katalog.'}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setProductModalOpen(false)}
                    className="px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 cursor-pointer"
                  >
                    Tutup
                  </button>
                  <button
                    type="submit"
                    disabled={savingProduct || uploadingProductImage}
                    className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-red-600 cursor-pointer disabled:opacity-50"
                  >
                    {savingProduct ? 'Menyimpan...' : 'Simpan Produk'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Bulk External Marketplace Database Import Modal */}
      <AdminMarketplaceImportModal
        isOpen={marketplaceImportOpen}
        onClose={() => setMarketplaceImportOpen(false)}
        existingProducts={products}
        existingCategories={categories}
        exchangeRateKhr={liveKhrRate}
        onImportComplete={(result, filterNeedsImage) => {
          setAdminBannerMsg(
            `Impor selesai tanpa duplikat: +${result.insertedCount} produk baru, ${result.updatedCount} produk diperbarui harga & stoknya sesuai file CSV.`
          );
          if (filterNeedsImage) {
            setProductCatalogFilter('needs_image');
          }
        }}
      />

      {/* Promotion Add/Edit Modal (Combo, Buy X Get Y, Discount % + Auto Schedule/Expiry) */}
      {promoModalOpen && (() => {
        const selectedPromoProd = products.find((p) => p.id === promoProductId);
        const previewUnit = normalizeProductUnit(selectedPromoProd?.unit);
        const previewBuy = Math.min(20, Math.max(1, Math.trunc(Number(promoBuyQty) || 1)));
        const previewGet = Math.min(20, Math.max(1, Math.trunc(Number(promoGetQty) || 1)));
        const previewBundle = previewBuy + previewGet;

        return (
          <div
            className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 no-print"
            role="dialog"
            aria-modal="true"
            aria-label={editingPromo ? 'Edit Promosi' : 'Tambah Promosi'}
          >
            <div className="bg-white border border-slate-200 rounded-xl max-w-xl w-full max-h-[92dvh] overflow-y-auto shadow-xl">
              <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
                <h3 className="font-display text-lg font-bold text-slate-900">
                  {editingPromo ? 'Edit Promosi Toko' : 'Buat Promosi Combo / Diskon'}
                </h3>
                <button
                  type="button"
                  onClick={() => setPromoModalOpen(false)}
                  className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <form onSubmit={handleSavePromo} className="p-6 space-y-4">
                {promoFormError && (
                  <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs font-medium text-rose-700">
                    {promoFormError}
                  </div>
                )}

                <div>
                  <label className="block text-xs font-semibold text-slate-800 mb-1.5">
                    Jenis Promosi
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <button
                      type="button"
                      onClick={() => setPromoType('combo')}
                      className={`p-3 border rounded-lg text-left cursor-pointer ${
                        promoType === 'combo'
                          ? 'border-emerald-700 bg-emerald-50/80 ring-1 ring-emerald-700'
                          : 'border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      <p className="text-xs font-bold text-emerald-800 inline-flex items-center gap-1">
                        <Layers className="w-3.5 h-3.5" />
                        <span>Paket Combo</span>
                      </p>
                      <p className="text-[11px] text-slate-600 mt-0.5">
                        Beli X Free Y (input X+Y, bayar X)
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={() => setPromoType('buy_x_get_y')}
                      className={`p-3 border rounded-lg text-left cursor-pointer ${
                        promoType === 'buy_x_get_y'
                          ? 'border-red-600 bg-red-50/70 ring-1 ring-red-600'
                          : 'border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      <p className="text-xs font-bold text-red-700 inline-flex items-center gap-1">
                        <Gift className="w-3.5 h-3.5" />
                        <span>Buy X Get Y</span>
                      </p>
                      <p className="text-[11px] text-slate-600 mt-0.5">
                        Beli X + bonus Y unit
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={() => setPromoType('discount')}
                      className={`p-3 border rounded-lg text-left cursor-pointer ${
                        promoType === 'discount'
                          ? 'border-blue-700 bg-blue-50/70 ring-1 ring-blue-700'
                          : 'border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      <p className="text-xs font-bold text-blue-700 inline-flex items-center gap-1">
                        <Percent className="w-3.5 h-3.5" />
                        <span>Diskon (%)</span>
                      </p>
                      <p className="text-[11px] text-slate-600 mt-0.5">
                        Potongan harga otomatis
                      </p>
                    </button>
                  </div>
                </div>

                <div className="space-y-2.5">
                  <ProductBarcodeScanner
                    products={products}
                    selectedProductId={promoProductId}
                    masterConfig={activeMaster}
                    autoFocusInput={true}
                    onSelectProduct={(matched) => {
                      setPromoProductId(matched.id);
                    }}
                  />

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Atau Pilih Produk Target dari Daftar ({products.length} item)
                    </label>
                    <select
                      required
                      value={promoProductId}
                      onChange={(e) => setPromoProductId(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                    >
                      <option value="" disabled>
                        -- Pilih produk --
                      </option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                          {p.barcode ? ` [BC: ${p.barcode}]` : ''} ({formatPrimaryAmount(p.price, activeMaster)} · Stok {p.stock} {normalizeProductUnit(p.unit)})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {promoType === 'combo' ? (
                  <div className="p-4 bg-emerald-50/60 border border-emerald-200 rounded-lg space-y-3">
                    <div className="flex flex-wrap gap-2">
                      {[
                        ['1', '2', 'Beli 1 Free 2 (Input 3)'],
                        ['2', '1', 'Beli 2 Free 1 (Input 3)'],
                        ['1', '1', 'Beli 1 Free 1 (Input 2)'],
                        ['2', '2', 'Beli 2 Free 2 (Input 4)'],
                        ['3', '1', 'Beli 3 Free 1 (Input 4)'],
                      ].map(([bx, gy, lbl]) => (
                        <button
                          key={lbl}
                          type="button"
                          onClick={() => {
                            setPromoBuyQty(bx);
                            setPromoGetQty(gy);
                          }}
                          className={`px-2.5 py-1 text-xs font-semibold rounded border cursor-pointer ${
                            promoBuyQty === bx && promoGetQty === gy
                              ? 'bg-emerald-700 text-white border-emerald-700'
                              : 'bg-white text-slate-700 border-slate-200'
                          }`}
                        >
                          {lbl}
                        </button>
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Jumlah Dibayar (Beli)
                        </label>
                        <input
                          type="number"
                          required
                          min={1}
                          max={20}
                          value={promoBuyQty}
                          onChange={(e) => setPromoBuyQty(e.target.value)}
                          className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-200 rounded-lg"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Jumlah Gratis (Free)
                        </label>
                        <input
                          type="number"
                          required
                          min={1}
                          max={20}
                          value={promoGetQty}
                          onChange={(e) => setPromoGetQty(e.target.value)}
                          className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-200 rounded-lg"
                        />
                      </div>
                    </div>
                    <div className="p-3 bg-white border border-emerald-200 rounded-lg space-y-1 text-xs text-emerald-950">
                      <p className="font-bold">
                        Simulasi Otomatis (Tampil sebagai Keterangan untuk Pelanggan):
                      </p>
                      <p className="text-emerald-900 leading-relaxed">
                        {formatComboInstruction(previewBuy, previewGet, previewUnit)}
                      </p>
                      <div className="pt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] font-bold text-emerald-800">
                        <span>Wajib Input: {previewBundle} {previewUnit}</span>
                        <span>·</span>
                        <span>Stok Berkurang: {previewBundle} {previewUnit}</span>
                        <span>·</span>
                        <span>Harga Dibayar: {previewBuy} {previewUnit}</span>
                      </div>
                    </div>
                  </div>
                ) : promoType === 'buy_x_get_y' ? (
                  <div className="p-4 bg-red-50/50 border border-red-200 rounded-lg space-y-3">
                    <div className="flex flex-wrap gap-2">
                      {[
                        ['1', '1', 'Buy 1 Get 1'],
                        ['2', '1', 'Buy 2 Get 1'],
                        ['3', '1', 'Buy 3 Get 1'],
                        ['5', '2', 'Buy 5 Get 2'],
                      ].map(([bx, gy, lbl]) => (
                        <button
                          key={lbl}
                          type="button"
                          onClick={() => {
                            setPromoBuyQty(bx);
                            setPromoGetQty(gy);
                          }}
                          className={`px-2.5 py-1 text-xs font-semibold rounded border cursor-pointer ${
                            promoBuyQty === bx && promoGetQty === gy
                              ? 'bg-red-600 text-white border-red-600'
                              : 'bg-white text-slate-700 border-slate-200'
                          }`}
                        >
                          {lbl}
                        </button>
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Jumlah Beli (Buy)
                        </label>
                        <input
                          type="number"
                          required
                          min={1}
                          max={20}
                          value={promoBuyQty}
                          onChange={(e) => setPromoBuyQty(e.target.value)}
                          className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-200 rounded-lg"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          Bonus Gratis (Get)
                        </label>
                        <input
                          type="number"
                          required
                          min={1}
                          max={20}
                          value={promoGetQty}
                          onChange={(e) => setPromoGetQty(e.target.value)}
                          className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-200 rounded-lg"
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="p-4 bg-blue-50/50 border border-blue-200 rounded-lg space-y-3">
                    <div className="flex flex-wrap gap-2">
                      {['10', '20', '30', '50'].map((pct) => (
                        <button
                          key={pct}
                          type="button"
                          onClick={() => setPromoDiscountPercent(pct)}
                          className={`px-2.5 py-1 text-xs font-semibold rounded border cursor-pointer ${
                            promoDiscountPercent === pct
                              ? 'bg-blue-700 text-white border-blue-700'
                              : 'bg-white text-slate-700 border-slate-200'
                          }`}
                        >
                          Diskon {pct}%
                        </button>
                      ))}
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Persentase Diskon (1% – 90%)
                      </label>
                      <input
                        type="number"
                        required
                        min={1}
                        max={90}
                        value={promoDiscountPercent}
                        onChange={(e) => setPromoDiscountPercent(e.target.value)}
                        className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-200 rounded-lg"
                      />
                    </div>
                  </div>
                )}

                {/* Automatic Promo Start & Expiry Schedule */}
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900">
                    <CalendarClock className="w-4 h-4 text-blue-700" />
                    <span>Periode Promosi Otomatis &amp; Tanggal Expired</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Mulai Periode Promosi
                      </label>
                      <input
                        type="datetime-local"
                        value={promoStartDate}
                        onChange={(e) => setPromoStartDate(e.target.value)}
                        className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Tanggal Expired / Berakhir
                      </label>
                      <input
                        type="datetime-local"
                        value={promoEndDate}
                        onChange={(e) => setPromoEndDate(e.target.value)}
                        className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                      />
                    </div>
                  </div>
                  <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={promoAutoZeroStock}
                      onChange={(e) => setPromoAutoZeroStock(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      <strong>Otomatis ubah stok produk menjadi 0 saat periode habis (expired).</strong>{' '}
                      Begitu melewati tanggal expired, promo langsung berhenti dan stok produk otomatis menjadi 0.
                    </span>
                  </label>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Judul Promosi
                  </label>
                  <input
                    type="text"
                    required
                    minLength={2}
                    maxLength={FIELD_LIMITS.PROMO_TITLE_MAX}
                    value={promoTitle}
                    onChange={(e) => setPromoTitle(e.target.value)}
                    placeholder={
                      promoType === 'combo'
                        ? `Contoh: Combo Beli ${previewBuy} Free ${previewGet} · Masukkan ${previewBundle} ${previewUnit}`
                        : 'Contoh: Buy 1 Get 1 Free · Minuman Dingin'
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Deskripsi Promosi
                  </label>
                  <textarea
                    rows={3}
                    required
                    minLength={4}
                    maxLength={FIELD_LIMITS.PROMO_DESC_MAX}
                    value={promoDescription}
                    onChange={(e) => setPromoDescription(e.target.value)}
                    placeholder={
                      promoType === 'combo'
                        ? `Contoh: Beli ${previewBuy} Free ${previewGet}. Masukkan ${previewBundle} ${previewUnit} ke keranjang, stok berkurang ${previewBundle} ${previewUnit} dan cukup bayar ${previewBuy} ${previewUnit}!`
                        : 'Jelaskan syarat dan keuntungan promosi untuk pelanggan...'
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                  />
                </div>

                <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={promoIsActive}
                    onChange={(e) => setPromoIsActive(e.target.checked)}
                  />
                  <span>Tayangkan di halaman Promo &amp; Diskon pelanggan</span>
                </label>

                <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setPromoModalOpen(false)}
                    className="px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 cursor-pointer"
                  >
                    Batal
                  </button>
                  <button
                    type="submit"
                    disabled={savingPromo}
                    className="px-4 py-2 text-xs font-semibold text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 cursor-pointer disabled:opacity-50"
                  >
                    {savingPromo ? 'Menyimpan...' : 'Simpan Promosi'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        );
      })()}

      {/* Category Add/Edit Modal */}
      {categoryModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 no-print"
          role="dialog"
          aria-modal="true"
          aria-label={editingCategory ? 'Edit Kategori' : 'Tambah Kategori'}
        >
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full shadow-xl">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-lg font-bold text-slate-900">
                {editingCategory ? 'Edit Kategori Produk' : 'Tambah Kategori Baru'}
              </h3>
              <button
                type="button"
                onClick={() => setCategoryModalOpen(false)}
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveCategory} className="p-6 space-y-4">
              {catErrorMsg && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-700">
                  {catErrorMsg}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Nama Kategori
                </label>
                <input
                  type="text"
                  required
                  minLength={FIELD_LIMITS.CATEGORY_NAME_MIN}
                  maxLength={FIELD_LIMITS.CATEGORY_NAME_MAX}
                  value={catName}
                  onChange={(e) => setCatName(e.target.value)}
                  placeholder="Contoh: Minuman Dingin, Sembako, Elektronik..."
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                />
                {editingCategory && (
                  <p className="text-[11px] text-slate-500 mt-1">
                    Mengubah nama kategori akan otomatis memperbarui kategori seluruh produk terkait.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Urutan Tampil (0 – 1000)
                </label>
                <input
                  type="number"
                  required
                  min={0}
                  max={1000}
                  value={catSortOrder}
                  onChange={(e) => setCatSortOrder(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                />
              </div>

              <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={catIsActive}
                  onChange={(e) => setCatIsActive(e.target.checked)}
                />
                <span>Tampilkan kategori di halaman pelanggan</span>
              </label>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setCategoryModalOpen(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={savingCategory}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-red-600 cursor-pointer disabled:opacity-50"
                >
                  {savingCategory ? 'Menyimpan...' : 'Simpan Kategori'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Delivery Account Add/Edit Modal */}
      {deliveryModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 no-print"
          role="dialog"
          aria-modal="true"
          aria-label={editingDelivery ? 'Edit Akun Delivery' : 'Tambah Akun Delivery'}
        >
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full shadow-xl">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-display text-lg font-bold text-slate-900">
                {editingDelivery ? 'Edit Akun Delivery' : 'Tambah Akun Delivery'}
              </h3>
              <button
                type="button"
                onClick={() => setDeliveryModalOpen(false)}
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveDeliveryAccount} className="p-6 space-y-4">
              {dErrorMsg && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-700">
                  {dErrorMsg}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Nama Kurir / Akun Delivery
                </label>
                <input
                  type="text"
                  required
                  minLength={FIELD_LIMITS.NAME_MIN}
                  maxLength={FIELD_LIMITS.NAME_MAX}
                  value={dName}
                  onChange={(e) => setDName(e.target.value)}
                  placeholder="Contoh: Kurir Alpamart 01"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Email Google Akun Delivery
                </label>
                <input
                  type="email"
                  required
                  minLength={5}
                  maxLength={120}
                  value={dEmail}
                  onChange={(e) => setDEmail(e.target.value)}
                  placeholder="kurir.alpamart@gmail.com"
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  Kurir masuk di Portal Delivery menggunakan email Google ini dan hanya bisa melihat pesanan &amp; alamat penerima.
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  No. Telepon / WhatsApp Kurir (Opsional)
                </label>
                <input
                  type="tel"
                  maxLength={FIELD_LIMITS.PHONE_MAX}
                  value={dPhone}
                  onChange={(e) => setDPhone(e.target.value)}
                  placeholder="081234567890"
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                />
              </div>

              <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={dIsActive}
                  onChange={(e) => setDIsActive(e.target.checked)}
                />
                <span>Aktifkan akun Delivery untuk menerima pesanan otomatis</span>
              </label>

              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDeliveryModalOpen(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={savingDelivery}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-red-600 cursor-pointer disabled:opacity-50"
                >
                  {savingDelivery ? 'Menyimpan...' : 'Simpan Akun Delivery'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Thermal Bill Auto-Print & Manual Print Modal */}
      <ThermalBillModal
        order={billOrder}
        isAutoTriggered={billAutoTriggered}
        autoPrintStatus={billAutoStatus}
        settings={printerSettings}
        connectedPrinterName={connectedPrinterName}
        onClose={() => {
          setBillOrder(null);
          setBillAutoTriggered(false);
          setBillAutoStatus(null);
        }}
      />

      {/* Responsive Fit-to-Screen Lightbox for Delivery Proof & Location Images */}
      <FullscreenImageLightbox
        isOpen={Boolean(lightboxImage)}
        src={lightboxImage?.src || ''}
        title={lightboxImage?.title || 'Bukti Pengiriman'}
        downloadFilename={lightboxImage?.filename}
        onClose={() => setLightboxImage(null)}
      />

      {/* Official AlpaMart KPS & Strict Barcode Auto-Image Sync Modal */}
      <AdminBarcodeAutoImageModal
        isOpen={barcodeAutoImageOpen}
        products={products}
        onClose={() => setBarcodeAutoImageOpen(false)}
        onNotify={(msg) => {
          setAdminBannerMsg(msg);
          window.setTimeout(() => setAdminBannerMsg(null), 6500);
        }}
      />
    </div>
  );
}

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getDocsFromServer,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import type {
  CartItem,
  DeliveryAccount,
  Product,
  Promotion,
  StoreBackgroundConfig,
  StoreBanner,
  StoreCategory,
  StoreCheckoutConfig,
  StoreHoursConfig,
  StoreMasterConfig,
} from './types/marketplace';
import {
  auth,
  db,
  ensureResilientAuthPersistence,
  fetchActiveCollectionViaRest,
  fetchStoreConfigDocViaRest,
  formatCatalogLoadError,
  isIosDevice,
  resolveGoogleRedirectResult,
  waitForAuthReady,
} from './lib/firebase';
import {
  clearRoleSession,
  getResilientItem,
  loadRoleSession,
  saveRoleSession,
  setResilientItem,
} from './lib/sessionStorage';
import {
  BOOTSTRAPPED_ADMIN_EMAIL,
  getEffectiveProductStock,
  INITIAL_CATEGORIES,
  INITIAL_PRODUCTS,
  isMasterEmail,
  normalizeEmail,
  seedInitialCatalogForAdmin,
  sha256Hex,
} from './lib/catalogSeed';
import { useJournalPosGlobalSync } from './hooks/useJournalPosGlobalSync';
import {
  DEFAULT_CHECKOUT_CONFIG,
  DEFAULT_MASTER_CONFIG,
  DEFAULT_STORE_BACKGROUND_CONFIG,
  DEFAULT_STORE_HOURS_CONFIG,
  isUsableDirectLogoUrl,
  mergeCheckoutConfig,
  mergeMasterConfig,
  mergeStoreBackgroundConfig,
  mergeStoreHoursConfig,
  THEME_ACCENT_STYLES,
} from './lib/storeDefaults';
import { isProductNeedingImage } from './lib/marketplaceBulkImport';
import {
  broadcastCrossTabEvent,
  resolveEffectiveMasterConfig,
  subscribeCrossTabEvents,
} from './lib/crossAccountSync';
import { Download } from 'lucide-react';
import { downloadCustomerDomainZip } from './lib/portalZipExport';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Navbar, type ActivePage } from './components/Navbar';
import { PortalBackgroundLayer } from './components/PortalBackgroundLayer';
import { StorefrontView } from './components/StorefrontView';

const CatalogView = lazy(() =>
  import('./components/CatalogView').then((m) => ({ default: m.CatalogView }))
);
const PromoDiscountView = lazy(() =>
  import('./components/PromoDiscountView').then((m) => ({ default: m.PromoDiscountView }))
);
const SearchView = lazy(() =>
  import('./components/SearchView').then((m) => ({ default: m.SearchView }))
);
const ProductDetailModal = lazy(() =>
  import('./components/ProductDetailModal').then((m) => ({ default: m.ProductDetailModal }))
);
const CartCheckoutDrawer = lazy(() =>
  import('./components/CartCheckoutDrawer').then((m) => ({ default: m.CartCheckoutDrawer }))
);
const OrderTrackingView = lazy(() =>
  import('./components/OrderTrackingView').then((m) => ({ default: m.OrderTrackingView }))
);
const DeliveryDashboardView = lazy(() =>
  import('./components/DeliveryDashboardView').then((m) => ({ default: m.DeliveryDashboardView }))
);
const AdminDashboardView = lazy(() =>
  import('./components/AdminDashboardView').then((m) => ({ default: m.AdminDashboardView }))
);
const MasterDashboardView = lazy(() =>
  import('./components/MasterDashboardView').then((m) => ({ default: m.MasterDashboardView }))
);
const TelegramFloatingChat = lazy(() =>
  import('./components/TelegramFloatingChat').then((m) => ({ default: m.TelegramFloatingChat }))
);
const PortalGuideModal = lazy(() =>
  import('./components/PortalGuideModal').then((m) => ({ default: m.PortalGuideModal }))
);
const PortalSwitcherBar = lazy(() =>
  import('./components/PortalSwitcherBar').then((m) => ({ default: m.PortalSwitcherBar }))
);

export type SiteMode = 'customer' | 'admin' | 'delivery' | 'master';

const PORTAL_GUIDE_SEEN_KEY = 'alpamart_portal_guide_seen_v1';

function detectSiteMode(): SiteMode {
  if (typeof window === 'undefined') return 'customer';
  const envLockedPortal = String(
    (import.meta.env?.VITE_LOCKED_PORTAL as string | undefined) || ''
  )
    .trim()
    .toLowerCase();
  const lockedPortal =
    (
      window as Window & { __ALPAMART_LOCKED_PORTAL__?: string }
    ).__ALPAMART_LOCKED_PORTAL__ || envLockedPortal;
  if (
    lockedPortal === 'customer' ||
    lockedPortal === 'delivery' ||
    lockedPortal === 'admin' ||
    lockedPortal === 'master'
  ) {
    return lockedPortal;
  }
  let decodedPath = window.location.pathname;
  try {
    decodedPath = decodeURIComponent(window.location.pathname);
  } catch {
    // keep raw pathname
  }
  const path = decodedPath.toLowerCase().replace(/\/+$/, '');
  const host = (window.location.hostname || '').toLowerCase();
  const hash = window.location.hash.toLowerCase();
  const params = new URLSearchParams(window.location.search);
  const portalParam = (params.get('portal') || params.get('site') || '').toLowerCase();

  if (
    path === '/master' ||
    path.startsWith('/master/') ||
    path === '/alpamart.tm.master' ||
    path === '/alpamart-tm.master' ||
    host.startsWith('master.') ||
    portalParam === 'master' ||
    hash.startsWith('#/master') ||
    hash === '#master'
  ) {
    return 'master';
  }

  if (
    path === '/admin' ||
    path.startsWith('/admin/') ||
    path === '/alpamart.tm-admin' ||
    path === '/alpamart.tm admin' ||
    path === '/alpamart.tm.admin' ||
    path === '/alpamart-tm.admin' ||
    host.startsWith('admin.') ||
    portalParam === 'admin' ||
    hash.startsWith('#/admin') ||
    hash === '#admin'
  ) {
    return 'admin';
  }

  if (
    path === '/delivery' ||
    path.startsWith('/delivery/') ||
    path === '/deliveri' ||
    path.startsWith('/deliveri/') ||
    path === '/kurir' ||
    path.startsWith('/kurir/') ||
    path === '/alpamart.tm.deliveri' ||
    path === '/alpamart.tm.delivery' ||
    path === '/alpamart-tm.deliveri' ||
    host.startsWith('deliveri.') ||
    host.startsWith('delivery.') ||
    host.startsWith('kurir.') ||
    portalParam === 'delivery' ||
    portalParam === 'deliveri' ||
    portalParam === 'kurir' ||
    hash.startsWith('#/delivery') ||
    hash.startsWith('#/deliveri') ||
    hash.startsWith('#/kurir') ||
    hash === '#delivery' ||
    hash === '#deliveri' ||
    hash === '#kurir'
  ) {
    return 'delivery';
  }

  return 'customer';
}

export function AppContent() {
  const [siteMode, setSiteMode] = useState<SiteMode>(() => detectSiteMode());
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isMaster, setIsMaster] = useState(false);
  const [isDelivery, setIsDelivery] = useState(false);
  const [deliveryEmailHash, setDeliveryEmailHash] = useState('');

  const [activePage, setActivePage] = useState<ActivePage>(() => {
    try {
      const saved = getResilientItem('alpamart_customer_active_page_v1');
      if (
        saved === 'storefront' ||
        saved === 'catalog' ||
        saved === 'promo' ||
        saved === 'search' ||
        saved === 'orders'
      ) {
        return saved;
      }
    } catch {
      // ignore storage errors
    }
    return 'storefront';
  });
  const [products, setProducts] = useState<Product[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [productsStatus, setProductsStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [productsError, setProductsError] = useState<string | null>(null);
  const [productsReloadToken, setProductsReloadToken] = useState(0);
  const [categories, setCategories] = useState<StoreCategory[]>([]);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [promoClockMs, setPromoClockMs] = useState<number>(() => Date.now());
  const [loadingPromotions, setLoadingPromotions] = useState(true);
  const [banners, setBanners] = useState<StoreBanner[]>([]);

  const handleRetryLoadProducts = () => {
    setProductsError(null);
    setProductsStatus('loading');
    setLoadingProducts(true);
    setProductsReloadToken((prev) => prev + 1);
  };
  const [checkoutConfig, setCheckoutConfig] = useState<StoreCheckoutConfig>(() => ({
    ...DEFAULT_CHECKOUT_CONFIG,
  }));
  const [storeHoursConfig, setStoreHoursConfig] = useState<StoreHoursConfig>(() => ({
    ...DEFAULT_STORE_HOURS_CONFIG,
  }));
  const [backgroundConfig, setBackgroundConfig] = useState<StoreBackgroundConfig>(() => ({
    ...DEFAULT_STORE_BACKGROUND_CONFIG,
  }));
  const [masterConfig, setMasterConfig] = useState<StoreMasterConfig>(() => ({
    ...DEFAULT_MASTER_CONFIG,
  }));
  const [redirectAuthError, setRedirectAuthError] = useState<string | null>(null);
  const siteModeRef = useRef<SiteMode>(siteMode);
  const authSeqRef = useRef(0);

  const [cart, setCart] = useState<CartItem[]>(() => {
    try {
      const saved = getResilientItem('alpamart_roboto_cart');
      if (!saved) return [];
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) return [];
      const seedPriceMap = new Map(INITIAL_PRODUCTS.map((s) => [s.id, s.price]));
      return parsed
        .filter(
          (item): item is CartItem =>
            Boolean(item) &&
            typeof item === 'object' &&
            Boolean(item.product) &&
            typeof item.product.id === 'string' &&
            typeof item.product.name === 'string' &&
            Number.isFinite(Number(item.product.price)) &&
            Number.isFinite(Number(item.quantity)) &&
            Number(item.quantity) >= 1
        )
        .map((item) => {
          const seedPrice = seedPriceMap.get(item.product.id);
          const rawPrice = Number(item.product.price);
          const normalizedPrice =
            seedPrice && rawPrice >= 10000 ? seedPrice : rawPrice;
          const stock = Math.max(1, Math.trunc(Number(item.product.stock ?? 1)));
          const qty = Math.min(stock, Math.max(1, Math.trunc(Number(item.quantity))));
          return {
            product: {
              ...item.product,
              price: normalizedPrice,
              stock,
            },
            quantity: qty,
          };
        });
    } catch {
      return [];
    }
  });
  const [cartOpen, setCartOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [portalGuideOpen, setPortalGuideOpen] = useState<boolean>(false);
  const [downloadingCustomerZip, setDownloadingCustomerZip] = useState<boolean>(false);

  const handleClosePortalGuide = () => {
    try {
      setResilientItem(PORTAL_GUIDE_SEEN_KEY, '1');
    } catch {
      // ignore storage restrictions
    }
    setPortalGuideOpen(false);
  };

  const handleNavigatePortal = (targetMode: SiteMode) => {
    const nextUrl =
      targetMode === 'customer' ? '/' : `/?portal=${targetMode}`;
    try {
      window.history.pushState({}, '', nextUrl);
    } catch {
      // ignore pushState restrictions
    }
    setSiteMode(targetMode);
    handleClosePortalGuide();
  };

  // Sync browser URL changes for 1-site-1-account routing
  useEffect(() => {
    const syncSite = () => setSiteMode(detectSiteMode());
    window.addEventListener('popstate', syncSite);
    window.addEventListener('hashchange', syncSite);
    return () => {
      window.removeEventListener('popstate', syncSite);
      window.removeEventListener('hashchange', syncSite);
    };
  }, []);

  // Update document title dynamically from Master Data storeName
  useEffect(() => {
    const titleBrand = masterConfig.storeName || DEFAULT_MASTER_CONFIG.storeName;
    if (siteMode === 'master') {
      document.title = `Master Data · ${titleBrand}`;
    } else if (siteMode === 'admin') {
      document.title = `Akun Admin · ${titleBrand}`;
    } else if (siteMode === 'delivery') {
      document.title = `Akun Delivery · ${titleBrand}`;
    } else {
      document.title = titleBrand;
    }
  }, [siteMode, masterConfig.storeName]);

  // Keep browser tab icon (favicon & Apple touch icon) synchronized with ALPAMART logo or Master custom logo
  useEffect(() => {
    const logoHref =
      masterConfig.storeLogoUrl?.trim() || DEFAULT_MASTER_CONFIG.storeLogoUrl || '/assets/aistudio/ALPA_17db3f6e.jpg';
    const isCustomUploadedLogo =
      logoHref.startsWith('data:image/') || logoHref.startsWith('https://');

    const upsertHeadIcon = (rel: string, href: string, type?: string) => {
      let link = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"][data-dynamic-brand-icon="1"]`);
      if (!link) {
        link = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
      }
      if (!link) {
        link = document.createElement('link');
        link.rel = rel;
        document.head.appendChild(link);
      }
      link.setAttribute('data-dynamic-brand-icon', '1');
      if (type) {
        link.type = type;
      } else if (href.endsWith('.svg')) {
        link.type = 'image/svg+xml';
      } else if (href.endsWith('.png')) {
        link.type = 'image/png';
      } else {
        link.removeAttribute('type');
      }
      link.href = href;
    };

    upsertHeadIcon('icon', logoHref);
    upsertHeadIcon('shortcut icon', isCustomUploadedLogo ? logoHref : '/favicon.png');
    upsertHeadIcon(
      'apple-touch-icon',
      isCustomUploadedLogo ? logoHref : '/assets/alpamart-logo-192.png'
    );
  }, [masterConfig.storeLogoUrl]);

  // Listen to global Master Data config across all portals
  useEffect(() => {
    const unsubscribe = onSnapshot(
      doc(db, 'storeConfig', 'master'),
      (snap) => {
        if (snap.exists()) {
          setMasterConfig(
            mergeMasterConfig(snap.data() as Partial<StoreMasterConfig>)
          );
        } else {
          setMasterConfig({ ...DEFAULT_MASTER_CONFIG });
        }
      },
      () => {
        // Preserve already-loaded live Master config on transient mobile network hiccups
      }
    );
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    siteModeRef.current = siteMode;
  }, [siteMode]);

  // Persist customer shopping cart & active page across Safari Private Browsing / ITP tiers
  // Strip inline base64 data: images so browser localStorage never hits QuotaExceededError
  useEffect(() => {
    try {
      const compactCart = cart.map((item) => ({
        quantity: item.quantity,
        product: {
          ...item.product,
          imageUrl:
            typeof item.product.imageUrl === 'string' &&
            item.product.imageUrl.startsWith('data:')
              ? ''
              : item.product.imageUrl,
        },
      }));
      setResilientItem('alpamart_roboto_cart', JSON.stringify(compactCart));
    } catch {
      // ignore storage quota
    }
  }, [cart]);

  useEffect(() => {
    try {
      setResilientItem('alpamart_customer_active_page_v1', activePage, {
        allowCookie: true,
      });
    } catch {
      // ignore storage quota
    }
  }, [activePage]);

  // Safari Private Browsing & ITP-resilient Firebase Auth + multi-role session initialization
  useEffect(() => {
    let active = true;
    let unsubscribeAuth: (() => void) | null = null;

    const verifyAndPersistRoles = async (currentUser: User | null) => {
      const seq = ++authSeqRef.current;
      if (!active) return;

      setUser(currentUser);

      if (!currentUser) {
        clearRoleSession();
        setIsMaster(false);
        setIsAdmin(false);
        setIsDelivery(false);
        setDeliveryEmailHash('');
        setAuthReady(true);
        return;
      }

      // 1. Immediately hydrate previously verified roles for the exact same authenticated UID
      //    so Safari ITP reloads or brief network stalls never drop Admin/Delivery/Master state.
      const cachedSession = loadRoleSession();
      const hasMatchingCache =
        cachedSession !== null && cachedSession.uid === currentUser.uid;

      if (hasMatchingCache) {
        setIsMaster(cachedSession.isMaster);
        setIsAdmin(cachedSession.isAdmin);
        setIsDelivery(cachedSession.isDelivery);
        setDeliveryEmailHash(cachedSession.deliveryEmailHash);
        // Unblock UI immediately from verified session cache while re-verifying in background
        setAuthReady(true);
      }

      // 2. Authoritatively re-verify Master, Admin, and Delivery roles against Firestore
      const masterMatch = Boolean(
        currentUser.emailVerified && isMasterEmail(currentUser.email)
      );
      if (masterMatch) {
        setIsMaster(true);
        setIsAdmin(true);
        setAuthReady(true);
      }
      let resolvedAdmin = masterMatch;
      let adminLookupFailed = false;

      if (!masterMatch && (siteModeRef.current === 'admin' || siteModeRef.current === 'master')) {
        let adminFlag = false;
        let primaryChecked = false;

        if (currentUser.emailVerified && currentUser.email) {
          try {
            const cleanEmail = normalizeEmail(currentUser.email);
            const emailHash = await sha256Hex(cleanEmail);
            const registeredAdminDoc = await getDoc(
              doc(db, 'adminAccounts', emailHash)
            );
            primaryChecked = true;
            if (
              registeredAdminDoc.exists() &&
              registeredAdminDoc.data().isActive === true
            ) {
              adminFlag = true;
            }
          } catch {
            adminLookupFailed = true;
          }
        }

        if (!adminFlag) {
          try {
            const adminDoc = await getDoc(doc(db, 'admins', currentUser.uid));
            adminFlag = adminDoc.exists();
            adminLookupFailed = false;
          } catch {
            if (!primaryChecked) {
              adminLookupFailed = true;
            }
          }
        }

        resolvedAdmin =
          adminLookupFailed && hasMatchingCache
            ? cachedSession.isAdmin
            : adminFlag;
      } else if (!masterMatch && hasMatchingCache) {
        resolvedAdmin = cachedSession.isAdmin;
      }

      let resolvedDelivery = hasMatchingCache ? cachedSession.isDelivery : false;
      let resolvedDeliveryHash = hasMatchingCache ? cachedSession.deliveryEmailHash : '';

      if (siteModeRef.current === 'delivery' && currentUser.emailVerified && currentUser.email) {
        try {
          const cleanEmail = normalizeEmail(currentUser.email);
          const delivSnap = await getDocs(
            query(
              collection(db, 'deliveryAccounts'),
              where('email', '==', cleanEmail)
            )
          );
          const hasActiveDelivery = delivSnap.docs.some(
            (d) => (d.data() as DeliveryAccount).isActive === true
          );
          resolvedDelivery = hasActiveDelivery;
          resolvedDeliveryHash = hasActiveDelivery ? await sha256Hex(cleanEmail) : '';
        } catch {
          // Keep cached delivery state on transient offline read
        }
      }

      if (!active || seq !== authSeqRef.current) return;

      setIsMaster(masterMatch);
      setIsAdmin(resolvedAdmin);
      setIsDelivery(resolvedDelivery);
      setDeliveryEmailHash(resolvedDeliveryHash);

      // 3. Persist verified session snapshot across Safari-compatible first-party storage tiers
      const activeRole = masterMatch
        ? 'master'
        : resolvedAdmin
          ? 'admin'
          : resolvedDelivery
            ? 'delivery'
            : siteModeRef.current === 'delivery'
              ? 'delivery'
              : 'customer';

      saveRoleSession({
        uid: currentUser.uid,
        email: currentUser.email,
        emailVerified: Boolean(currentUser.emailVerified),
        isMaster: masterMatch,
        isAdmin: resolvedAdmin,
        isDelivery: resolvedDelivery,
        deliveryEmailHash: resolvedDeliveryHash,
        activeRole,
        updatedAt: Date.now(),
      });

      setAuthReady(true);
    };

    // Failsafe so strict iPhone/iPad Safari ITP or slow mobile networks never stall UI hydration
    const readyTimer = window.setTimeout(() => {
      if (active) setAuthReady(true);
    }, 1200);

    const bootstrapAuth = async () => {
      // Probe and lock in the strongest Safari-compatible Firebase Auth persistence first
      await ensureResilientAuthPersistence();
      if (!active) return;

      // Resolve any pending Google redirect flow before/alongside initial auth state hydration.
      // On Admin/Master/Delivery portals, also check even if Safari ITP cleared the pending cookie flag.
      const isAuthPortal =
        siteModeRef.current === 'admin' ||
        siteModeRef.current === 'master' ||
        siteModeRef.current === 'delivery';
      const redirectResult = await resolveGoogleRedirectResult(isAuthPortal);
      if (active && redirectResult.errorMessage) {
        setRedirectAuthError(redirectResult.errorMessage);
      }
      if (!active) return;

      unsubscribeAuth = onAuthStateChanged(
        auth,
        (currentUser) => {
          window.clearTimeout(readyTimer);
          void verifyAndPersistRoles(currentUser);
        },
        () => {
          window.clearTimeout(readyTimer);
          if (active) setAuthReady(true);
        }
      );

      await waitForAuthReady(2500);
      if (active) {
        window.clearTimeout(readyTimer);
        if (!auth.currentUser) {
          setAuthReady(true);
        }
      }
    };

    void bootstrapAuth();

    // When iOS Safari resumes a backgrounded tab, quietly re-sync auth token & role session
    const handleVisibilityResume = () => {
      if (document.visibilityState === 'visible' && auth.currentUser) {
        void verifyAndPersistRoles(auth.currentUser);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityResume);

    return () => {
      active = false;
      window.clearTimeout(readyTimer);
      document.removeEventListener('visibilitychange', handleVisibilityResume);
      if (unsubscribeAuth) {
        unsubscribeAuth();
      }
    };
  }, []);

  // Real-time role & account revision sync: if Master updates/revokes an Admin or Delivery account,
  // every signed-in account reflects that revision immediately without manual page refresh.
  useEffect(() => {
    if (!authReady || !user || !user.emailVerified || !user.email) return;
    const cleanEmail = normalizeEmail(user.email);
    const masterMatch = isMasterEmail(cleanEmail);
    let cancelled = false;
    let unsubAdminAcc: (() => void) | null = null;
    let unsubDeliveryAcc: (() => void) | null = null;

    const attachRoleListeners = async () => {
      const emailHash = await sha256Hex(cleanEmail);
      if (cancelled) return;

      if (!masterMatch) {
        unsubAdminAcc = onSnapshot(
          doc(db, 'adminAccounts', emailHash),
          async (snap) => {
            if (cancelled) return;
            const activeRegistered = snap.exists() && snap.data().isActive === true;
            if (activeRegistered) {
              setIsAdmin(true);
              return;
            }
            if (snap.exists() && snap.data().isActive === false) {
              setIsAdmin(false);
              return;
            }
            try {
              const legacyDoc = await getDoc(doc(db, 'admins', user.uid));
              if (!cancelled) {
                setIsAdmin(legacyDoc.exists());
              }
            } catch {
              // Keep existing role state on transient offline read
            }
          },
          () => {
            // Keep existing role state on transient offline read
          }
        );
      }

      unsubDeliveryAcc = onSnapshot(
        query(collection(db, 'deliveryAccounts'), where('email', '==', cleanEmail)),
        (snap) => {
          if (cancelled) return;
          const hasActiveDelivery = snap.docs.some(
            (d) => (d.data() as DeliveryAccount).isActive === true
          );
          setIsDelivery(hasActiveDelivery);
          setDeliveryEmailHash(hasActiveDelivery ? emailHash : '');
        },
        () => {
          // Keep existing delivery role state on transient offline read
        }
      );
    };

    void attachRoleListeners();

    return () => {
      cancelled = true;
      unsubAdminAcc?.();
      unsubDeliveryAcc?.();
    };
  }, [authReady, user]);

  // Cross-tab & multi-account automatic synchronization (Customer, Delivery, Admin, Master)
  // Lightweight config sync (4 single-doc reads) keeps URL, logo, hours & checkout updated across all
  // devices & links WITHOUT repeatedly re-reading the entire 4,000+ product catalog every 20 seconds.
  useEffect(() => {
    let lastConfigRefreshAt = 0;

    const fetchConfigDataFresh = async <T,>(
      docId: 'master' | 'checkout' | 'hours' | 'background'
    ): Promise<Partial<T> | null> => {
      const ref = doc(db, 'storeConfig', docId);
      try {
        const snap = await getDocFromServer(ref);
        if (snap.exists()) return snap.data() as Partial<T>;
      } catch {
        // Fall through to REST fallback (especially helpful on iOS Safari)
      }
      try {
        const viaRest = await fetchStoreConfigDocViaRest<Partial<T>>(docId, {
          timeoutMs: 10_000,
        });
        if (viaRest) return viaRest;
      } catch {
        // Fall through to SDK local/default getDoc
      }
      try {
        const snap = await getDoc(ref);
        if (snap.exists()) return snap.data() as Partial<T>;
      } catch {
        // Ignore transient offline errors
      }
      return null;
    };

    const fetchQueryFresh = async (qRef: ReturnType<typeof query>) => {
      try {
        return await getDocsFromServer(qRef);
      } catch {
        return await getDocs(qRef);
      }
    };

    const refreshSharedConfigsFromServer = async (
      includeCustomerCatalog = false,
      force = false
    ) => {
      const now = Date.now();
      if (!force && !includeCustomerCatalog && now - lastConfigRefreshAt < 15_000) {
        return;
      }
      lastConfigRefreshAt = now;

      try {
        const [masterData, checkoutData, hoursData, bgData] = await Promise.all([
          fetchConfigDataFresh<StoreMasterConfig>('master'),
          fetchConfigDataFresh<StoreCheckoutConfig>('checkout'),
          fetchConfigDataFresh<StoreHoursConfig>('hours'),
          fetchConfigDataFresh<StoreBackgroundConfig>('background'),
        ]);
        if (masterData) {
          setMasterConfig(mergeMasterConfig(masterData));
        }
        if (checkoutData) {
          setCheckoutConfig(mergeCheckoutConfig(checkoutData));
        }
        if (hoursData) {
          setStoreHoursConfig(mergeStoreHoursConfig(hoursData));
        }
        if (bgData) {
          setBackgroundConfig(mergeStoreBackgroundConfig(bgData));
        }

        if (includeCustomerCatalog && siteModeRef.current === 'customer') {
          const [prodRes, promoRes, catRes, bannerRes] = await Promise.allSettled([
            fetchQueryFresh(query(collection(db, 'products'), where('isActive', '==', true))),
            fetchQueryFresh(query(collection(db, 'promotions'), where('isActive', '==', true))),
            fetchQueryFresh(query(collection(db, 'categories'), where('isActive', '==', true))),
            fetchQueryFresh(query(collection(db, 'storeBanners'), where('isActive', '==', true))),
          ]);

          if (prodRes.status === 'fulfilled' && !prodRes.value.empty) {
            const seedPriceMap = new Map(INITIAL_PRODUCTS.map((s) => [s.id, s.price]));
            const list = prodRes.value.docs.map((d) => {
              const prod = d.data() as Product;
              const fallbackUsd = seedPriceMap.get(prod.id);
              if (fallbackUsd && prod.price >= 10000) {
                return { ...prod, price: fallbackUsd };
              }
              return prod;
            });
            setProducts(list);
            setProductsStatus('ready');
            setProductsError(null);
            setLoadingProducts(false);
          }

          if (promoRes.status === 'fulfilled') {
            setPromotions(promoRes.value.docs.map((d) => d.data() as Promotion));
          }

          if (catRes.status === 'fulfilled' && !catRes.value.empty) {
            const catList = catRes.value.docs
              .map((d) => d.data() as StoreCategory)
              .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
            setCategories(catList);
          }

          if (bannerRes.status === 'fulfilled') {
            const bannerList = bannerRes.value.docs
              .map((d) => d.data() as StoreBanner)
              .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
            setBanners(bannerList);
          }
        }
      } catch {
        // Ignore transient offline errors; Firestore onSnapshot keeps live state
      }
    };

    const unsub = subscribeCrossTabEvents((event) => {
      if (event.type === 'guest_orders_updated') {
        window.dispatchEvent(new Event('alpamart_guest_orders_updated'));
      } else if (event.type === 'revision_broadcast') {
        void refreshSharedConfigsFromServer(true, true);
      } else if (event.type === 'app_version_updated') {
        const activeEl = document.activeElement;
        const isTyping =
          activeEl instanceof HTMLInputElement ||
          activeEl instanceof HTMLTextAreaElement ||
          activeEl instanceof HTMLSelectElement;
        if (!isTyping) {
          window.location.reload();
        }
      }
    });
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'alpamart_guest_orders_v1') {
        window.dispatchEvent(new Event('alpamart_guest_orders_updated'));
      }
    };
    const onVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible') {
        void refreshSharedConfigsFromServer(false);
      }
    };
    const onOnline = () => {
      void refreshSharedConfigsFromServer(false, true);
    };
    const onManualSyncAll = () => {
      void refreshSharedConfigsFromServer(true, true);
    };
    const onPageShow = () => {
      void refreshSharedConfigsFromServer(false);
    };

    // Immediate lightweight config pull on mount (store URL, logo, hours, checkout)
    void refreshSharedConfigsFromServer(false, true);

    // Gentle periodic config sync (every 90s, 4 tiny docs only — preserves Firestore daily quota)
    const periodicSyncId = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refreshSharedConfigsFromServer(false);
      }
    }, 90_000);

    window.addEventListener('storage', onStorage);
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onVisibilityOrFocus);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('alpamart_manual_sync_all', onManualSyncAll);
    document.addEventListener('visibilitychange', onVisibilityOrFocus);
    return () => {
      unsub();
      window.clearInterval(periodicSyncId);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onVisibilityOrFocus);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('alpamart_manual_sync_all', onManualSyncAll);
      document.removeEventListener('visibilitychange', onVisibilityOrFocus);
    };
  }, []);

  // Automatic live app version watcher across ALL 4 portals (Pelanggan, Deliveri, Admin, Master):
  // When any new update is published/restarted, every open account tab refreshes automatically.
  useEffect(() => {
    let mounted = true;
    let knownVersion = '';
    let pendingReload = false;

    const triggerSafeReload = () => {
      const activeEl = document.activeElement;
      const isTyping =
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        activeEl instanceof HTMLSelectElement;
      if (isTyping) {
        pendingReload = true;
        return;
      }
      window.location.reload();
    };

    const extractHtmlBundleSignature = (htmlText: string): string => {
      const scriptMatches = Array.from(
        htmlText.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)
      ).map((m) => m[1]);
      const cssMatches = Array.from(
        htmlText.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']/gi)
      ).map((m) => m[1]);
      const hashedAssets = [...scriptMatches, ...cssMatches].filter(
        (href) => href.includes('/assets/') || href.includes('assets/')
      );
      return hashedAssets.sort().join('|');
    };

    const getCurrentDomBundleSignature = (): string => {
      const scripts = Array.from(document.querySelectorAll('script[src]'))
        .map((el) => el.getAttribute('src') || '')
        .filter((s) => s.includes('/assets/') || s.includes('assets/'));
      const links = Array.from(document.querySelectorAll('link[rel="stylesheet"][href]'))
        .map((el) => el.getAttribute('href') || '')
        .filter((s) => s.includes('/assets/') || s.includes('assets/'));
      return [...scripts, ...links].sort().join('|');
    };

    let useStaticHtmlCheck = false;
    const initialDomSignature = getCurrentDomBundleSignature();

    const applyDetectedVersion = (latest: string) => {
      if (!latest) return;
      if (!knownVersion) {
        knownVersion = latest;
        return;
      }
      if (latest !== knownVersion) {
        knownVersion = latest;
        broadcastCrossTabEvent({ type: 'app_version_updated', version: latest });
        triggerSafeReload();
      }
    };

    const checkAppVersion = async () => {
      try {
        if (!useStaticHtmlCheck) {
          const res = await fetch(`/api/app-version?t=${Date.now()}`, {
            cache: 'no-store',
          });
          if (!mounted) return;
          const contentType = (res.headers.get('content-type') || '').toLowerCase();
          if (res.ok && contentType.includes('application/json')) {
            const data = (await res.json()) as { version?: string };
            const latest = typeof data?.version === 'string' ? data.version.trim() : '';
            if (latest) {
              applyDetectedVersion(latest);
              return;
            }
          }
          // Static hosting (Netlify / Cloudflare Pages / Vercel) rewrites /api/* to index.html or 404.
          // Switch permanently to zero-cache HTML asset-hash detection so the SAME permanent URL auto-updates forever.
          useStaticHtmlCheck = true;
          if (!knownVersion && initialDomSignature) {
            knownVersion = `static:${initialDomSignature}`;
          }
        }

        // 1. Prefer zero-cache static /version.json generated on every Vite build (Netlify/Vercel/custom domains)
        try {
          const verRes = await fetch(`/version.json?t=${Date.now()}`, {
            cache: 'no-store',
            headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
          });
          if (verRes.ok && mounted) {
            const verCt = (verRes.headers.get('content-type') || '').toLowerCase();
            if (verCt.includes('application/json')) {
              const verJson = (await verRes.json()) as { version?: string };
              const staticVer =
                typeof verJson?.version === 'string' ? verJson.version.trim() : '';
              if (staticVer) {
                applyDetectedVersion(staticVer);
                return;
              }
            }
          }
        } catch {
          // Fall through to HTML asset-hash inspection
        }

        const htmlRes = await fetch(`/?_vcheck=${Date.now()}`, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache' },
        });
        if (!htmlRes.ok || !mounted) return;
        const htmlText = await htmlRes.text();
        const latestSig = extractHtmlBundleSignature(htmlText);
        if (!latestSig) return;
        applyDetectedVersion(`static:${latestSig}`);
      } catch {
        // Ignore offline/network errors
      }
    };

    const handleBlurCheck = () => {
      if (pendingReload) {
        pendingReload = false;
        window.setTimeout(triggerSafeReload, 250);
      }
    };

    const handleResumeCheck = () => {
      if (document.visibilityState === 'visible') {
        void checkAppVersion();
      }
    };

    void checkAppVersion();
    const intervalId = window.setInterval(() => {
      void checkAppVersion();
    }, 15_000);
    window.addEventListener('focus', checkAppVersion);
    window.addEventListener('pageshow', checkAppVersion);
    window.addEventListener('blur', handleBlurCheck, true);
    document.addEventListener('visibilitychange', handleResumeCheck);

    return () => {
      mounted = false;
      window.clearInterval(intervalId);
      window.removeEventListener('focus', checkAppVersion);
      window.removeEventListener('pageshow', checkAppVersion);
      window.removeEventListener('blur', handleBlurCheck, true);
      document.removeEventListener('visibilitychange', handleResumeCheck);
    };
  }, []);

  // Seed initial catalog and auto-heal broken/legacy logo & background config in Firestore
  // whenever Master signs in on ANY portal, so every other account & device updates live.
  useEffect(() => {
    if (!authReady || !user || !isMaster) return;

    if (siteMode === 'admin' || siteMode === 'master') {
      void seedInitialCatalogForAdmin(user.email || BOOTSTRAPPED_ADMIN_EMAIL);
    }

    const loadCompactOfficialLogoDataUrl = async (): Promise<string> => {
      try {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        const loaded = await new Promise<boolean>((resolve) => {
          img.onload = () => resolve(true);
          img.onerror = () => resolve(false);
          img.src = DEFAULT_MASTER_CONFIG.storeLogoUrl;
        });
        if (!loaded || !img.naturalWidth || !img.naturalHeight) {
          return DEFAULT_MASTER_CONFIG.storeLogoUrl;
        }
        const maxDim = 256;
        const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(64, Math.round(img.naturalWidth * scale));
        const h = Math.max(64, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return DEFAULT_MASTER_CONFIG.storeLogoUrl;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
        if (dataUrl.startsWith('data:image/jpeg;base64,') && dataUrl.length < 180_000) {
          return dataUrl;
        }
      } catch {
        // Fallback to static official logo path
      }
      return DEFAULT_MASTER_CONFIG.storeLogoUrl;
    };

    void (async () => {
      const updatedBy = (user.email || BOOTSTRAPPED_ADMIN_EMAIL).slice(0, 128);
      try {
        const masterRef = doc(db, 'storeConfig', 'master');
        const snap = await getDocFromServer(masterRef);
        if (snap.exists()) {
          const raw = snap.data() as Partial<StoreMasterConfig>;
          const rawLogo = typeof raw.storeLogoUrl === 'string' ? raw.storeLogoUrl.trim() : '';
          if (!isUsableDirectLogoUrl(rawLogo)) {
            const healedLogoUrl = await loadCompactOfficialLogoDataUrl();
            await updateDoc(masterRef, {
              storeLogoUrl: healedLogoUrl,
              updatedBy,
              updatedAt: serverTimestamp(),
            });
            broadcastCrossTabEvent({ type: 'revision_broadcast', source: 'master_logo_sync' });
          }
        }
      } catch {
        // Non-fatal: UI still displays official logo fallback locally
      }

      try {
        const bgRef = doc(db, 'storeConfig', 'background');
        const bgSnap = await getDocFromServer(bgRef);
        if (!bgSnap.exists()) {
          await setDoc(bgRef, {
            id: 'background',
            imageUrl: DEFAULT_STORE_BACKGROUND_CONFIG.imageUrl,
            displayMode: DEFAULT_STORE_BACKGROUND_CONFIG.displayMode,
            opacity: DEFAULT_STORE_BACKGROUND_CONFIG.opacity,
            enabled: DEFAULT_STORE_BACKGROUND_CONFIG.enabled,
            updatedBy,
            updatedAt: serverTimestamp(),
          });
          broadcastCrossTabEvent({ type: 'revision_broadcast', source: 'master_bg_sync' });
        }
      } catch {
        // Non-fatal
      }

      // Auto-sync placeholder product photos from https://alpamartkps.store/ once per session
      // regardless of which portal Master opens, so every other account updates live immediately.
      const kpsSessionKey = 'alpamart_kps_autosync_done_v4';
      let alreadyRan = false;
      try {
        alreadyRan = window.sessionStorage.getItem(kpsSessionKey) === '1';
      } catch {
        alreadyRan = false;
      }
      if (!alreadyRan) {
        try {
          window.sessionStorage.setItem(kpsSessionKey, '1');
        } catch {
          // ignore
        }
        try {
          const prodSnap = await getDocsFromServer(collection(db, 'products'));
          const targets = prodSnap.docs
            .map((d) => {
              const data = d.data() as Partial<Product>;
              return {
                id: d.id,
                barcode: typeof data.barcode === 'string' ? data.barcode : '',
                sku: typeof data.sku === 'string' ? data.sku : '',
                name: typeof data.name === 'string' ? data.name : '',
                imageUrl: typeof data.imageUrl === 'string' ? data.imageUrl : '',
              };
            })
            .filter((p) => p.name && isProductNeedingImage(p.imageUrl));

          if (targets.length > 0) {
            const resp = await fetch('/api/catalog/alpamartkps-match-batch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                strictBarcodeOnly: false,
                items: targets.map((p) => ({
                  id: p.id,
                  barcode: p.barcode,
                  sku: p.sku,
                  name: p.name,
                })),
              }),
            });
            const data = (await resp.json().catch(() => null)) as {
              ok?: boolean;
              matches?: Array<{ id: string; imageUrl: string }>;
            } | null;

            if (resp.ok && data?.ok && Array.isArray(data.matches) && data.matches.length > 0) {
              const CHUNK_SIZE = 150;
              let committed = 0;
              for (let start = 0; start < data.matches.length; start += CHUNK_SIZE) {
                const chunk = data.matches.slice(start, start + CHUNK_SIZE);
                const batch = writeBatch(db);
                for (const m of chunk) {
                  if (!m.id || !m.imageUrl || !m.imageUrl.startsWith('https://alpamartkps.store/uploads/p/')) {
                    continue;
                  }
                  batch.update(doc(db, 'products', m.id), {
                    imageUrl: m.imageUrl,
                    updatedAt: serverTimestamp(),
                  });
                }
                await batch.commit();
                committed += chunk.length;
              }
              if (committed > 0) {
                broadcastCrossTabEvent({ type: 'revision_broadcast', source: 'master_kps_autosync' });
              }
            }
          }
        } catch {
          // Non-fatal: Master can also trigger via Admin "Salin Foto KPS / Barcode"
        }
      }
    })();
  }, [authReady, isMaster, siteMode, user]);

  // Listen to storefront products on Customer site with iOS Safari empty-cache guard + REST fallback
  useEffect(() => {
    if (siteMode !== 'customer') return;

    let cancelled = false;
    let hasConfirmedData = false;
    let restFallbackStarted = false;

    setLoadingProducts(true);
    setProductsStatus('loading');
    setProductsError(null);

    const seedPriceMap = new Map(INITIAL_PRODUCTS.map((s) => [s.id, s.price]));
    const normalizeProducts = (rawList: Product[]): Product[] =>
      rawList
        .filter((prod) => Boolean(prod && prod.id && prod.name))
        .map((prod) => {
          const fallbackUsd = seedPriceMap.get(prod.id);
          const numericPrice = Number(prod.price);
          const numericStock = Number(prod.stock);
          const safePrice =
            fallbackUsd && numericPrice >= 10000
              ? fallbackUsd
              : Number.isFinite(numericPrice)
                ? numericPrice
                : 0;
          const safeStock = Number.isFinite(numericStock)
            ? Math.max(0, Math.trunc(numericStock))
            : 0;
          return {
            ...prod,
            price: safePrice,
            stock: safeStock,
            isActive: prod.isActive !== false,
          };
        });

    const runRestProductsFallback = async () => {
      if (cancelled || restFallbackStarted || hasConfirmedData) return;
      restFallbackStarted = true;
      try {
        const restRaw = await fetchActiveCollectionViaRest<Product>('products', {
          timeoutMs: 22_000,
        });
        if (cancelled || hasConfirmedData) return;
        const normalized = normalizeProducts(restRaw);
        hasConfirmedData = true;
        setProducts(normalized);
        setProductsStatus('ready');
        setProductsError(null);
        setLoadingProducts(false);
      } catch (restErr) {
        if (cancelled || hasConfirmedData) return;
        console.warn('Firestore REST products fallback failed:', restErr);
        setProductsStatus('error');
        setProductsError(formatCatalogLoadError(restErr));
        setLoadingProducts(false);
      }
    };

    const fallbackDelayMs = isIosDevice() ? 3500 : 6500;
    const recoveryTimer = window.setTimeout(() => {
      if (!cancelled && !hasConfirmedData) {
        void runRestProductsFallback();
      }
    }, fallbackDelayMs);

    const q = query(collection(db, 'products'), where('isActive', '==', true));

    const unsubscribe = onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (cancelled) return;

        // CRITICAL iOS Safari guard: NEVER treat an initial empty fromCache snapshot
        // as an empty catalog! Keep showing the loading state until the server or REST fallback confirms.
        if (snapshot.metadata.fromCache && snapshot.empty && !hasConfirmedData) {
          return;
        }

        if (!snapshot.empty) {
          window.clearTimeout(recoveryTimer);
          const list = normalizeProducts(snapshot.docs.map((d) => d.data() as Product));
          hasConfirmedData = true;
          setProducts(list);
          setProductsStatus('ready');
          setProductsError(null);
          setLoadingProducts(false);
          return;
        }

        // Server explicitly confirmed 0 active products
        if (!snapshot.metadata.fromCache) {
          window.clearTimeout(recoveryTimer);
          hasConfirmedData = true;
          setProducts([]);
          setProductsStatus('ready');
          setProductsError(null);
          setLoadingProducts(false);
        }
      },
      (error) => {
        if (cancelled) return;
        window.clearTimeout(recoveryTimer);
        console.warn('Firestore products onSnapshot error; trying REST fallback:', error);
        if (!hasConfirmedData) {
          void runRestProductsFallback();
        }
      }
    );

    return () => {
      cancelled = true;
      window.clearTimeout(recoveryTimer);
      unsubscribe();
    };
  }, [siteMode, productsReloadToken]);

  useEffect(() => {
    if (siteMode !== 'customer') return;

    let cancelled = false;
    let hasConfirmed = false;
    let restStarted = false;
    setLoadingPromotions(true);

    const runRestPromos = async () => {
      if (cancelled || restStarted || hasConfirmed) return;
      restStarted = true;
      try {
        const list = await fetchActiveCollectionViaRest<Promotion>('promotions', {
          timeoutMs: 15_000,
        });
        if (!cancelled && !hasConfirmed) {
          hasConfirmed = true;
          setPromotions(list);
          setLoadingPromotions(false);
        }
      } catch {
        if (!cancelled && !hasConfirmed) {
          setLoadingPromotions(false);
        }
      }
    };

    const recoveryTimer = window.setTimeout(() => {
      if (!cancelled && !hasConfirmed) void runRestPromos();
    }, isIosDevice() ? 3800 : 7000);

    const q = query(collection(db, 'promotions'), where('isActive', '==', true));

    const unsubscribe = onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (cancelled) return;
        if (snapshot.metadata.fromCache && snapshot.empty && !hasConfirmed) return;
        window.clearTimeout(recoveryTimer);
        hasConfirmed = true;
        setPromotions(snapshot.docs.map((d) => d.data() as Promotion));
        setLoadingPromotions(false);
      },
      (error) => {
        if (cancelled) return;
        window.clearTimeout(recoveryTimer);
        console.warn('Firestore promotions onSnapshot error; trying REST fallback:', error);
        void runRestPromos();
      }
    );

    return () => {
      cancelled = true;
      window.clearTimeout(recoveryTimer);
      unsubscribe();
    };
  }, [siteMode, productsReloadToken]);

  useEffect(() => {
    if (siteMode !== 'customer') return;
    const timer = window.setInterval(() => setPromoClockMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [siteMode]);

  const effectiveProducts = useMemo(
    () =>
      products.map((p) => {
        const effStock = getEffectiveProductStock(p, promotions, promoClockMs);
        return effStock === p.stock ? p : { ...p, stock: effStock };
      }),
    [products, promotions, promoClockMs]
  );

  useEffect(() => {
    if (siteMode !== 'customer') return;

    let cancelled = false;
    let hasConfirmed = false;
    let restStarted = false;

    const runRestCategories = async () => {
      if (cancelled || restStarted || hasConfirmed) return;
      restStarted = true;
      try {
        const list = await fetchActiveCollectionViaRest<StoreCategory>('categories', {
          timeoutMs: 15_000,
        });
        if (!cancelled && !hasConfirmed && list.length > 0) {
          hasConfirmed = true;
          setCategories(list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)));
        }
      } catch {
        // Keep existing or default categories without crashing
      }
    };

    const recoveryTimer = window.setTimeout(() => {
      if (!cancelled && !hasConfirmed) void runRestCategories();
    }, isIosDevice() ? 3800 : 7000);

    const q = query(collection(db, 'categories'), where('isActive', '==', true));
    const unsubscribe = onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (cancelled) return;
        if (snapshot.metadata.fromCache && snapshot.empty && !hasConfirmed) return;
        window.clearTimeout(recoveryTimer);
        hasConfirmed = true;
        if (snapshot.empty) {
          setCategories(
            INITIAL_CATEGORIES.map((c) => ({
              ...c,
              createdAt: null,
              updatedAt: null,
            }))
          );
        } else {
          const list = snapshot.docs
            .map((d) => d.data() as StoreCategory)
            .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
          setCategories(list);
        }
      },
      (error) => {
        if (cancelled) return;
        window.clearTimeout(recoveryTimer);
        console.warn('Firestore categories onSnapshot error; trying REST fallback:', error);
        void runRestCategories();
      }
    );
    return () => {
      cancelled = true;
      window.clearTimeout(recoveryTimer);
      unsubscribe();
    };
  }, [siteMode, productsReloadToken]);

  // Listen to active homepage carousel banners on Customer site
  useEffect(() => {
    if (siteMode !== 'customer') return;

    let cancelled = false;
    let hasConfirmed = false;
    let restStarted = false;

    const runRestBanners = async () => {
      if (cancelled || restStarted || hasConfirmed) return;
      restStarted = true;
      try {
        const list = await fetchActiveCollectionViaRest<StoreBanner>('storeBanners', {
          timeoutMs: 15_000,
        });
        if (!cancelled && !hasConfirmed) {
          hasConfirmed = true;
          setBanners(list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)));
        }
      } catch {
        // Keep built-in default banners silently
      }
    };

    const recoveryTimer = window.setTimeout(() => {
      if (!cancelled && !hasConfirmed) void runRestBanners();
    }, isIosDevice() ? 4000 : 7500);

    const q = query(collection(db, 'storeBanners'), where('isActive', '==', true));
    const unsubscribe = onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (cancelled) return;
        if (snapshot.metadata.fromCache && snapshot.empty && !hasConfirmed) return;
        window.clearTimeout(recoveryTimer);
        hasConfirmed = true;
        const list = snapshot.docs
          .map((d) => d.data() as StoreBanner)
          .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
        setBanners(list);
      },
      () => {
        if (cancelled) return;
        window.clearTimeout(recoveryTimer);
        void runRestBanners();
      }
    );
    return () => {
      cancelled = true;
      window.clearTimeout(recoveryTimer);
      unsubscribe();
    };
  }, [siteMode, productsReloadToken]);

  // Listen globally to storefront cart, checkout & payment barcode settings across ALL 4 portals
  useEffect(() => {
    const unsubscribe = onSnapshot(
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
      () => {
        // Preserve already-loaded live checkout config on transient mobile network hiccups
      }
    );
    return () => unsubscribe();
  }, []);

  // Listen globally to Master-managed store opening & closing hours across ALL 4 portals
  useEffect(() => {
    const unsubscribe = onSnapshot(
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
        // Preserve already-loaded live store hours on transient mobile network hiccups
      }
    );
    return () => unsubscribe();
  }, []);

  // Listen globally to Admin-managed background image config across ALL 4 portals
  useEffect(() => {
    const unsubscribe = onSnapshot(
      doc(db, 'storeConfig', 'background'),
      (snap) => {
        if (snap.exists()) {
          setBackgroundConfig(
            mergeStoreBackgroundConfig(snap.data() as Partial<StoreBackgroundConfig>)
          );
        } else {
          setBackgroundConfig({ ...DEFAULT_STORE_BACKGROUND_CONFIG });
        }
      },
      () => {
        // Preserve already-loaded live background config on transient mobile network hiccups
      }
    );
    return () => unsubscribe();
  }, []);

  // Auto-sync open customer cart & product detail modal whenever any product is revised online
  useEffect(() => {
    if (siteMode !== 'customer' || loadingProducts || productsStatus !== 'ready') return;
    const latestMap = new Map(products.map((p) => [p.id, p]));

    setCart((prev) => {
      if (prev.length === 0) return prev;
      let changed = false;
      const next: CartItem[] = [];
      for (const item of prev) {
        const fresh = latestMap.get(item.product.id);
        if (!fresh || !fresh.isActive || fresh.stock <= 0) {
          changed = true;
          continue;
        }
        const clampedQty = Math.min(fresh.stock, Math.max(1, item.quantity));
        const prodChanged =
          fresh.name !== item.product.name ||
          fresh.price !== item.product.price ||
          fresh.priceKhr !== item.product.priceKhr ||
          fresh.stock !== item.product.stock ||
          fresh.imageUrl !== item.product.imageUrl ||
          fresh.unit !== item.product.unit ||
          fresh.category !== item.product.category ||
          fresh.description !== item.product.description ||
          fresh.promoActive !== item.product.promoActive ||
          fresh.promoPriceUsd !== item.product.promoPriceUsd ||
          fresh.promoPriceKhr !== item.product.promoPriceKhr ||
          fresh.promoLabel !== item.product.promoLabel ||
          fresh.promoDiscountPercent !== item.product.promoDiscountPercent ||
          clampedQty !== item.quantity;
        if (prodChanged) {
          changed = true;
          next.push({ product: fresh, quantity: clampedQty });
        } else {
          next.push(item);
        }
      }
      return changed ? next : prev;
    });

    setSelectedProduct((prev) => {
      if (!prev) return null;
      const fresh = latestMap.get(prev.id);
      if (!fresh || !fresh.isActive) return null;
      return fresh;
    });
  }, [products, loadingProducts, productsStatus, siteMode]);

  const categoryOptions = useMemo(() => {
    const names = new Set<string>();
    const source =
      categories.length > 0
        ? categories.map((c) => c.name)
        : INITIAL_CATEGORIES.map((c) => c.name);
    for (const n of source) {
      if (n.trim()) names.add(n.trim());
    }
    for (const p of products) {
      if (p.isActive && p.category?.trim()) names.add(p.category.trim());
    }
    return ['Semua', ...Array.from(names)];
  }, [categories, products]);

  const handleNavigate = (page: ActivePage, sectionId?: string) => {
    setActivePage(page);
    if (page === 'storefront' && sectionId) {
      setTimeout(() => {
        const el = document.getElementById(sectionId);
        el?.scrollIntoView({ behavior: 'smooth' });
      }, 60);
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const handleAddToCart = (product: Product, quantity = 1) => {
    setCart((prev) => {
      const existing = prev.find((item) => item.product.id === product.id);
      if (existing) {
        const nextQty = Math.min(product.stock, existing.quantity + quantity);
        return prev.map((item) =>
          item.product.id === product.id ? { ...item, product, quantity: nextQty } : item
        );
      }
      return [...prev, { product, quantity: Math.min(product.stock, quantity) }];
    });
  };

  const handleUpdateCartQty = (productId: string, qty: number) => {
    if (qty <= 0) {
      setCart((prev) => prev.filter((item) => item.product.id !== productId));
      return;
    }
    setCart((prev) =>
      prev.map((item) =>
        item.product.id === productId
          ? { ...item, quantity: Math.min(item.product.stock, qty) }
          : item
      )
    );
  };

  const handleRemoveCartItem = (productId: string) => {
    setCart((prev) => prev.filter((item) => item.product.id !== productId));
  };

  const totalCartCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  const effectiveMasterConfig = useMemo(
    () => resolveEffectiveMasterConfig(masterConfig, checkoutConfig),
    [masterConfig, checkoutConfig]
  );

  // Global background Journal POS price & stock auto-sync (runs on any portal when Master is signed in)
  const { syncToast: journalSyncToast, dismissSyncToast: dismissJournalSyncToast } =
    useJournalPosGlobalSync({
      user,
      isMaster,
      products,
      categories,
      exchangeRateKhr: effectiveMasterConfig.exchangeRate || 4000,
    });

  const activeTheme =
    THEME_ACCENT_STYLES[effectiveMasterConfig.themeAccent] || THEME_ACCENT_STYLES.blue_red;

  const journalAutoSyncToastBanner = journalSyncToast ? (
    <div
      role="status"
      className="fixed top-20 right-4 z-50 max-w-sm bg-slate-900 text-white border border-emerald-500/40 rounded-xl shadow-xl px-4 py-3 flex items-start gap-3 text-xs no-print"
    >
      <span className="w-2 h-2 rounded-full bg-emerald-400 mt-1 shrink-0" />
      <p className="leading-relaxed flex-1">{journalSyncToast}</p>
      <button
        type="button"
        onClick={dismissJournalSyncToast}
        className="text-slate-400 hover:text-white font-bold cursor-pointer"
        aria-label="Tutup notifikasi"
      >
        ✕
      </button>
    </div>
  ) : null;

  const portalLoaderFallback = (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="w-8 h-8 rounded-full border-2 border-slate-300 border-t-blue-700 animate-spin" />
    </div>
  );

  // SITE 1 OF 4: DEDICATED MASTER DATA SITE (/master)
  if (siteMode === 'master') {
    return (
      <div className="relative min-h-screen">
        <PortalBackgroundLayer
          config={backgroundConfig}
          baseClassName="bg-slate-50"
        />
        <div className="relative z-10 min-h-screen">
          <Suspense fallback={portalLoaderFallback}>
            <PortalSwitcherBar
              currentSiteMode={siteMode}
              onNavigatePortal={handleNavigatePortal}
              onOpenPortalGuide={() => setPortalGuideOpen(true)}
              signedInEmail={user?.email}
              storeName={effectiveMasterConfig.storeName}
              storeLogoUrl={effectiveMasterConfig.storeLogoUrl}
              permanentStoreUrl={effectiveMasterConfig.permanentStoreUrl}
            />
            {!authReady ? (
              <div className="min-h-screen bg-slate-950/75 flex items-center justify-center p-6">
                <div className="max-w-md w-full h-64 bg-slate-900 border border-slate-800 rounded-xl animate-pulse" />
              </div>
            ) : (
              <MasterDashboardView
                user={user}
                isMaster={isMaster}
                masterConfig={effectiveMasterConfig}
                storeHoursConfig={storeHoursConfig}
                backgroundConfig={backgroundConfig}
                initialAuthError={redirectAuthError}
                onNavigatePortal={handleNavigatePortal}
                onOpenPortalGuide={() => setPortalGuideOpen(true)}
                onUserReloaded={() => {
                  const current = auth.currentUser;
                  setUser(current);
                  const verifiedMaster = Boolean(
                    current?.emailVerified && isMasterEmail(current.email)
                  );
                  setIsMaster(verifiedMaster);
                  if (verifiedMaster) {
                    setIsAdmin(true);
                  }
                }}
              />
            )}
            {portalGuideOpen && (
              <PortalGuideModal
                isOpen={portalGuideOpen}
                currentSiteMode={siteMode}
                onClose={handleClosePortalGuide}
                onNavigatePortal={handleNavigatePortal}
                storeName={effectiveMasterConfig.storeName}
                permanentStoreUrl={effectiveMasterConfig.permanentStoreUrl}
              />
            )}
            {journalAutoSyncToastBanner}
          </Suspense>
        </div>
      </div>
    );
  }

  // SITE 2 OF 4: DEDICATED ADMIN SITE (/admin)
  if (siteMode === 'admin') {
    return (
      <div className="relative min-h-screen">
        <PortalBackgroundLayer
          config={backgroundConfig}
          baseClassName={activeTheme.pageBg}
        />
        <div className="relative z-10 min-h-screen">
          <Suspense fallback={portalLoaderFallback}>
            <PortalSwitcherBar
              currentSiteMode={siteMode}
              onNavigatePortal={handleNavigatePortal}
              onOpenPortalGuide={() => setPortalGuideOpen(true)}
              signedInEmail={user?.email}
              storeName={effectiveMasterConfig.storeName}
              storeLogoUrl={effectiveMasterConfig.storeLogoUrl}
              permanentStoreUrl={effectiveMasterConfig.permanentStoreUrl}
            />
            {!authReady ? (
              <div className="min-h-screen bg-transparent flex items-center justify-center p-6">
                <div className="max-w-md w-full h-64 bg-white/90 border border-slate-200 rounded-xl animate-pulse" />
              </div>
            ) : (
              <AdminDashboardView
                user={user}
                isAdmin={isAdmin}
                isMaster={isMaster}
                masterConfig={effectiveMasterConfig}
                backgroundConfig={backgroundConfig}
                initialAuthError={redirectAuthError}
                onOpenPortalGuide={() => setPortalGuideOpen(true)}
                onUserReloaded={() => {
                  const current = auth.currentUser;
                  setUser(current);
                  if (current?.emailVerified && isMasterEmail(current.email)) {
                    setIsMaster(true);
                    setIsAdmin(true);
                  }
                }}
              />
            )}
            {portalGuideOpen && (
              <PortalGuideModal
                isOpen={portalGuideOpen}
                currentSiteMode={siteMode}
                onClose={handleClosePortalGuide}
                onNavigatePortal={handleNavigatePortal}
                storeName={effectiveMasterConfig.storeName}
                permanentStoreUrl={effectiveMasterConfig.permanentStoreUrl}
              />
            )}
            {journalAutoSyncToastBanner}
          </Suspense>
        </div>
      </div>
    );
  }

  // SITE 3 OF 4: DEDICATED 1-CLICK DELIVERY SITE (/delivery) — Standalone tanpa login & tanpa gabungan portal
  if (siteMode === 'delivery') {
    return (
      <div className="relative min-h-screen">
        <PortalBackgroundLayer
          config={backgroundConfig}
          baseClassName={activeTheme.pageBg}
        />
        <div className="relative z-10 min-h-screen">
          <Suspense fallback={portalLoaderFallback}>
            <DeliveryDashboardView
              user={user}
              isDelivery={isDelivery}
              deliveryEmailHash={deliveryEmailHash}
              storeName={effectiveMasterConfig.storeName}
              masterConfig={effectiveMasterConfig}
              storeHoursConfig={storeHoursConfig}
            />
          </Suspense>
        </div>
      </div>
    );
  }

  // MAINTENANCE MODE GATE ON CUSTOMER STOREFRONT (configured via /master)
  if (effectiveMasterConfig.maintenanceMode) {
    const safeTelegram = effectiveMasterConfig.telegramOrderUrl?.startsWith('https://')
      ? effectiveMasterConfig.telegramOrderUrl
      : 'https://t.me/AlpamartTM03';
    return (
      <div className="relative min-h-screen flex items-center justify-center p-6">
        <PortalBackgroundLayer
          config={backgroundConfig}
          baseClassName={activeTheme.pageBg}
        />
        <div className="relative z-10 max-w-lg w-full bg-white/95 backdrop-blur-xs border border-slate-200 rounded-2xl overflow-hidden shadow-xl">
          <div className={`h-2 w-full ${activeTheme.topBar}`} />
          <div className="p-8 text-center space-y-4">
            <img
              src={effectiveMasterConfig.storeLogoUrl || DEFAULT_MASTER_CONFIG.storeLogoUrl}
              alt={effectiveMasterConfig.storeName}
              referrerPolicy="no-referrer"
              onError={(e) => {
                const img = e.currentTarget;
                if (!img.dataset.fallbackApplied) {
                  img.dataset.fallbackApplied = '1';
                  img.src = DEFAULT_MASTER_CONFIG.storeLogoUrl;
                }
              }}
              className="w-16 h-16 mx-auto rounded-xl object-contain bg-white border border-slate-200 p-1"
            />
            <p className="font-mono text-xs font-semibold uppercase tracking-wider text-amber-700">
              Pemeliharaan Sistem
            </p>
            <h1 className="font-display text-2xl font-bold text-slate-900">
              {effectiveMasterConfig.storeName} Sedang Tutup Sementara
            </h1>
            <p className="text-sm text-slate-600 leading-relaxed">
              Kami sedang memperbarui stok dan tampilan toko. Silakan kunjungi kembali beberapa saat lagi atau hubungi kami langsung melalui Telegram.
            </p>
            {effectiveMasterConfig.storeHours && (
              <p className="text-xs font-medium text-slate-500">
                Jam Operasional: {effectiveMasterConfig.storeHours}
              </p>
            )}
            <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3">
              <a
                href={safeTelegram}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center px-5 py-2.5 text-sm font-semibold text-white bg-[#0088cc] hover:bg-[#0077b5] rounded-lg transition-colors"
              >
                Hubungi Telegram Toko
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // SITE 4 OF 4: DEDICATED CUSTOMER STOREFRONT SITE (/) — Standalone tanpa login & tanpa gabungan portal
  return (
    <div className="relative min-h-screen flex flex-col text-slate-900">
      <PortalBackgroundLayer
        config={backgroundConfig}
        baseClassName={activeTheme.pageBg}
      />
      <div className="relative z-10 min-h-screen flex flex-col">
        <Navbar
          activePage={activePage}
          onNavigate={handleNavigate}
          cartCount={totalCartCount}
          onOpenCart={() => setCartOpen(true)}
          masterConfig={effectiveMasterConfig}
        />

      <main className="flex-1">
        {activePage === 'storefront' && (
          <StorefrontView
            products={effectiveProducts}
            promotions={promotions}
            categories={categoryOptions}
            banners={banners}
            checkoutConfig={checkoutConfig}
            masterConfig={effectiveMasterConfig}
            storeHoursConfig={storeHoursConfig}
            loadingProducts={loadingProducts}
            productsStatus={productsStatus}
            productsError={productsError}
            onRetryLoadProducts={handleRetryLoadProducts}
            onAddToCart={handleAddToCart}
            onSelectProduct={(p) => setSelectedProduct(p)}
            onNavigate={handleNavigate}
            user={user}
          />
        )}

        <Suspense fallback={null}>
          {activePage === 'catalog' && (
            <CatalogView
              products={effectiveProducts}
              promotions={promotions}
              categories={categoryOptions}
              masterConfig={effectiveMasterConfig}
              loadingProducts={loadingProducts}
              productsStatus={productsStatus}
              productsError={productsError}
              onRetryLoadProducts={handleRetryLoadProducts}
              onAddToCart={handleAddToCart}
              onSelectProduct={(p) => setSelectedProduct(p)}
              onNavigate={handleNavigate}
            />
          )}

          {activePage === 'promo' && (
            <PromoDiscountView
              products={effectiveProducts}
              promotions={promotions}
              masterConfig={effectiveMasterConfig}
              loadingPromotions={loadingPromotions}
              onAddToCart={handleAddToCart}
              onSelectProduct={(p) => setSelectedProduct(p)}
              onNavigate={handleNavigate}
            />
          )}

          {activePage === 'search' && (
            <SearchView
              products={effectiveProducts}
              promotions={promotions}
              categories={categoryOptions}
              masterConfig={effectiveMasterConfig}
              loadingProducts={loadingProducts}
              productsStatus={productsStatus}
              productsError={productsError}
              onRetryLoadProducts={handleRetryLoadProducts}
              onAddToCart={handleAddToCart}
              onSelectProduct={(p) => setSelectedProduct(p)}
              onNavigate={handleNavigate}
            />
          )}

          {activePage === 'orders' && (
            <OrderTrackingView
              user={user}
              masterConfig={effectiveMasterConfig}
              onNavigate={handleNavigate}
            />
          )}
        </Suspense>
      </main>

      {/* Persistent Customer-Only Footer across ALL Customer tabs (Zero Admin/Master/Delivery links) */}
      <footer className={`mt-auto text-slate-200 border-t-4 no-print ${activeTheme.footerBg}`}>
        <div className="max-w-[1520px] mx-auto px-4 sm:px-6 lg:px-8 py-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <img
                src={effectiveMasterConfig.storeLogoUrl || DEFAULT_MASTER_CONFIG.storeLogoUrl}
                alt={effectiveMasterConfig.storeName}
                referrerPolicy="no-referrer"
                onError={(e) => {
                  const img = e.currentTarget;
                  if (!img.dataset.fallbackApplied) {
                    img.dataset.fallbackApplied = '1';
                    img.src = DEFAULT_MASTER_CONFIG.storeLogoUrl;
                  }
                }}
                className="w-8 h-8 rounded-md bg-white p-0.5 object-contain shrink-0"
              />
              <p className="font-display text-sm font-semibold text-white">
                {effectiveMasterConfig.storeName}
              </p>
            </div>
            <p className="text-xs text-slate-300">
              {effectiveMasterConfig.footerText ||
                `Belanja Online · CASH (${effectiveMasterConfig.secondaryCurrencyCode}) & QR (${effectiveMasterConfig.primaryCurrencyCode}) · Free Delivery`}
            </p>
            {(effectiveMasterConfig.storeHours ||
              effectiveMasterConfig.storeAddress ||
              effectiveMasterConfig.permanentStoreUrl) && (
              <p className="text-[11px] text-slate-400">
                {[
                  effectiveMasterConfig.storeHours,
                  effectiveMasterConfig.storeAddress,
                  effectiveMasterConfig.permanentStoreUrl
                    ? effectiveMasterConfig.permanentStoreUrl.replace(/^https?:\/\//i, '')
                    : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-4 sm:gap-6 text-xs text-blue-200">
            <button
              type="button"
              onClick={() => handleNavigate('catalog')}
              className="hover:text-white transition-colors cursor-pointer"
            >
              Catalog
            </button>
            <button
              type="button"
              onClick={() => handleNavigate('promo')}
              className="hover:text-white transition-colors cursor-pointer"
            >
              Promo &amp; Diskon
            </button>
            <button
              type="button"
              onClick={() => handleNavigate('search')}
              className="hover:text-white transition-colors cursor-pointer"
            >
              Pencarian
            </button>
            <button
              type="button"
              onClick={() => handleNavigate('orders')}
              className="hover:text-white transition-colors cursor-pointer"
            >
              Lacak Pesanan
            </button>
            <button
              type="button"
              disabled={downloadingCustomerZip}
              onClick={() => {
                setDownloadingCustomerZip(true);
                try {
                  downloadCustomerDomainZip({
                    storeName: effectiveMasterConfig.storeName,
                    storeTagline: effectiveMasterConfig.storeTagline,
                    customBaseOrigin: effectiveMasterConfig.permanentStoreUrl,
                  });
                } finally {
                  window.setTimeout(() => setDownloadingCustomerZip(false), 1000);
                }
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white border border-white/25 font-semibold transition-colors cursor-pointer disabled:opacity-60"
            >
              <Download className="w-3.5 h-3.5 shrink-0" />
              <span>
                {downloadingCustomerZip
                  ? 'Menyiapkan ZIP...'
                  : 'Download ZIP Domain Pelanggan (Auto-Update)'}
              </span>
            </button>
          </div>
        </div>
      </footer>

      <Suspense fallback={null}>
        {selectedProduct && (
          <ProductDetailModal
            product={
              effectiveProducts.find((p) => p.id === selectedProduct.id) ||
              selectedProduct
            }
            promotions={promotions}
            masterConfig={effectiveMasterConfig}
            onClose={() => setSelectedProduct(null)}
            onAddToCart={handleAddToCart}
          />
        )}

        {cartOpen && (
          <CartCheckoutDrawer
            isOpen={cartOpen}
            onClose={() => setCartOpen(false)}
            cart={cart}
            promotions={promotions}
            checkoutConfig={checkoutConfig}
            masterConfig={effectiveMasterConfig}
            storeHoursConfig={storeHoursConfig}
            onUpdateQty={handleUpdateCartQty}
            onRemoveItem={handleRemoveCartItem}
            onClearCart={() => setCart([])}
            user={user}
            isAdmin={isAdmin}
            isDelivery={isDelivery}
            onNavigate={(p) => handleNavigate(p)}
          />
        )}

        <TelegramFloatingChat user={user} />
      </Suspense>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}

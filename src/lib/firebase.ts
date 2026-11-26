import { initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  indexedDBLocalPersistence,
  inMemoryPersistence,
  sendEmailVerification,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  type Auth,
  type Persistence,
  type User,
  type UserCredential,
} from 'firebase/auth';
import {
  getFirestore,
  initializeFirestore,
  memoryLocalCache,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import {
  canUseIndexedDb,
  canUseLocalStorage,
  detectStorageCapabilities,
  getResilientItem,
  removeResilientItem,
  setResilientItem,
  type StorageCapabilities,
} from './sessionStorage';

const app = initializeApp(firebaseConfig);

export const FIREBASE_PROJECT_ID = firebaseConfig.projectId;
export const FIREBASE_AUTH_SETTINGS_URL = `https://console.firebase.google.com/project/${firebaseConfig.projectId}/authentication/settings`;
export const FIREBASE_AUTH_PROVIDERS_URL = `https://console.firebase.google.com/project/${firebaseConfig.projectId}/authentication/providers`;

export function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isClassicIos = /iPhone|iPad|iPod/i.test(ua);
  const isIpadOs =
    typeof navigator.platform === 'string' &&
    navigator.platform === 'MacIntel' &&
    typeof navigator.maxTouchPoints === 'number' &&
    navigator.maxTouchPoints > 1;
  return isClassicIos || isIpadOs;
}

export function isAndroidDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android/i.test(navigator.userAgent || '');
}

export function getAndroidChromeIntentUrl(targetUrl: string): string {
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    const scheme = parsed.protocol.replace(':', '');
    const stripped = `${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
    return `intent://${stripped}#Intent;scheme=${scheme};package=com.android.chrome;end`;
  } catch {
    return '';
  }
}

// Force long-polling + memoryLocalCache on iPhone/iPad Safari:
// iOS WebKit's IndexedDB lease locks (persistentMultipleTabManager) frequently stall or emit
// premature empty fromCache snapshots on large catalogs (4,000+ docs) and Private/ITP tabs.
// Keep persistentLocalCache on Android/Desktop where IndexedDB is reliable, with safe fallback to memoryLocalCache.
function createResilientFirestore(): Firestore {
  const ios = isIosDevice();
  const networkSettings = ios
    ? { experimentalForceLongPolling: true }
    : { experimentalAutoDetectLongPolling: true };

  if (ios) {
    try {
      return initializeFirestore(
        app,
        {
          ...networkSettings,
          localCache: memoryLocalCache(),
        },
        firebaseConfig.firestoreDatabaseId
      );
    } catch {
      return getFirestore(app, firebaseConfig.firestoreDatabaseId);
    }
  }

  const supportsPersistentCache = canUseLocalStorage() && canUseIndexedDb();

  if (supportsPersistentCache) {
    try {
      return initializeFirestore(
        app,
        {
          ...networkSettings,
          localCache: persistentLocalCache({
            tabManager: persistentMultipleTabManager(),
          }),
        },
        firebaseConfig.firestoreDatabaseId
      );
    } catch {
      // Fall through cleanly to memory cache
    }
  }

  try {
    return initializeFirestore(
      app,
      {
        ...networkSettings,
        localCache: memoryLocalCache(),
      },
      firebaseConfig.firestoreDatabaseId
    );
  } catch {
    return getFirestore(app, firebaseConfig.firestoreDatabaseId);
  }
}

export const db = createResilientFirestore();

type FirestoreRestValue = {
  nullValue?: null;
  booleanValue?: boolean;
  integerValue?: string | number;
  doubleValue?: number | string;
  timestampValue?: string;
  stringValue?: string;
  arrayValue?: { values?: FirestoreRestValue[] };
  mapValue?: { fields?: Record<string, FirestoreRestValue> };
};

interface FirestoreRestDocument {
  name?: string;
  fields?: Record<string, FirestoreRestValue>;
}

function decodeFirestoreRestValue(val: FirestoreRestValue | undefined): unknown {
  if (!val || typeof val !== 'object') return undefined;
  if ('nullValue' in val) return null;
  if ('booleanValue' in val) return Boolean(val.booleanValue);
  if ('integerValue' in val) {
    const n = Number(val.integerValue);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  if ('doubleValue' in val) {
    const n = Number(val.doubleValue);
    return Number.isFinite(n) ? n : 0;
  }
  if ('stringValue' in val) return String(val.stringValue ?? '');
  if ('timestampValue' in val) return String(val.timestampValue ?? '');
  if ('arrayValue' in val) {
    const arr = val.arrayValue?.values;
    return Array.isArray(arr) ? arr.map((item) => decodeFirestoreRestValue(item)) : [];
  }
  if ('mapValue' in val) {
    const fields = val.mapValue?.fields;
    if (!fields || typeof fields !== 'object') return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = decodeFirestoreRestValue(v);
    }
    return out;
  }
  return undefined;
}

function decodeFirestoreRestDocument<T>(docObj: FirestoreRestDocument | undefined): T | null {
  if (!docObj || !docObj.fields || typeof docObj.fields !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(docObj.fields)) {
    out[k] = decodeFirestoreRestValue(v);
  }
  if (!out.id && typeof docObj.name === 'string') {
    const parts = docObj.name.split('/');
    const docId = parts[parts.length - 1];
    if (docId) out.id = docId;
  }
  return out as T;
}

function getFirestoreRestDocumentsBaseUrl(): string {
  const dbId = encodeURIComponent(firebaseConfig.firestoreDatabaseId || '(default)');
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    firebaseConfig.projectId
  )}/databases/${dbId}/documents`;
}

/**
 * Read-only Firestore REST v1 fallback for public active storefront collections.
 * Strictly executes the exact same `where isActive == true` query enforced by firestore.rules.
 * Protects iPhone Safari / strict ITP / Private Relay users when SDK WebChannel/long-polling stalls.
 */
export async function fetchActiveCollectionViaRest<T>(
  collectionId: 'products' | 'categories' | 'promotions' | 'storeBanners',
  options?: { timeoutMs?: number }
): Promise<T[]> {
  const timeoutMs = options?.timeoutMs ?? 22_000;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer =
    controller && typeof window !== 'undefined'
      ? window.setTimeout(() => controller.abort(), timeoutMs)
      : null;

  try {
    const url = `${getFirestoreRestDocumentsBaseUrl()}:runQuery?key=${encodeURIComponent(
      firebaseConfig.apiKey
    )}`;
    const res = await fetch(url, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'isActive' },
              op: 'EQUAL',
              value: { booleanValue: true },
            },
          },
        },
      }),
      signal: controller?.signal,
    });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const errJson = (await res.json()) as {
          error?: { message?: string; status?: string };
        };
        const statusText = errJson?.error?.status || '';
        const msgText = errJson?.error?.message || '';
        if (statusText || msgText) {
          detail = `${statusText} ${msgText}`.trim();
        }
      } catch {
        // ignore JSON parse failure
      }
      const err = new Error(`Firestore REST ${collectionId} failed (${res.status}): ${detail}`);
      (err as Error & { code?: string }).code =
        res.status === 429
          ? 'resource-exhausted'
          : res.status === 403
            ? 'permission-denied'
            : 'unavailable';
      throw err;
    }

    const rows = (await res.json()) as Array<{ document?: FirestoreRestDocument }>;
    if (!Array.isArray(rows)) return [];
    const results: T[] = [];
    for (const row of rows) {
      if (row && row.document) {
        const parsed = decodeFirestoreRestDocument<T>(row.document);
        if (parsed) results.push(parsed);
      }
    }
    return results;
  } finally {
    if (timer !== null && typeof window !== 'undefined') {
      window.clearTimeout(timer);
    }
  }
}

/**
 * Read-only Firestore REST v1 fallback for public storeConfig single documents.
 */
export async function fetchStoreConfigDocViaRest<T>(
  docId: 'master' | 'checkout' | 'hours' | 'background',
  options?: { timeoutMs?: number }
): Promise<T | null> {
  const timeoutMs = options?.timeoutMs ?? 12_000;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer =
    controller && typeof window !== 'undefined'
      ? window.setTimeout(() => controller.abort(), timeoutMs)
      : null;

  try {
    const url = `${getFirestoreRestDocumentsBaseUrl()}/storeConfig/${encodeURIComponent(
      docId
    )}?key=${encodeURIComponent(firebaseConfig.apiKey)}`;
    const res = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller?.signal,
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const err = new Error(`Firestore REST storeConfig/${docId} failed (${res.status})`);
      (err as Error & { code?: string }).code =
        res.status === 429 ? 'resource-exhausted' : 'unavailable';
      throw err;
    }
    const docObj = (await res.json()) as FirestoreRestDocument;
    return decodeFirestoreRestDocument<T>(docObj);
  } finally {
    if (timer !== null && typeof window !== 'undefined') {
      window.clearTimeout(timer);
    }
  }
}

/**
 * Read-only Firestore REST v1 fallback for 1-click Delivery Roster key (iOS/Android resilient).
 */
export async function fetchDeliveryRosterViaRest(options?: {
  timeoutMs?: number;
}): Promise<{ directAccessKey?: string } | null> {
  const timeoutMs = options?.timeoutMs ?? 12_000;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer =
    controller && typeof window !== 'undefined'
      ? window.setTimeout(() => controller.abort(), timeoutMs)
      : null;

  try {
    const url = `${getFirestoreRestDocumentsBaseUrl()}/storeMeta/deliveryRoster?key=${encodeURIComponent(
      firebaseConfig.apiKey
    )}`;
    const res = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller?.signal,
    });
    if (!res.ok) return null;
    const docObj = (await res.json()) as FirestoreRestDocument;
    return decodeFirestoreRestDocument<{ directAccessKey?: string }>(docObj);
  } catch {
    return null;
  } finally {
    if (timer !== null && typeof window !== 'undefined') {
      window.clearTimeout(timer);
    }
  }
}

/**
 * Read-only Firestore REST v1 fallback for 1-Click Delivery Feed orders (protects Kurir on iPhone Safari / Android).
 */
export async function fetchDeliveryFeedViaRest<T>(
  feedKey: string,
  options?: { timeoutMs?: number }
): Promise<T[]> {
  if (!feedKey || feedKey.length < 24 || !/^[a-zA-Z0-9_-]+$/.test(feedKey)) {
    return [];
  }
  const timeoutMs = options?.timeoutMs ?? 16_000;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer =
    controller && typeof window !== 'undefined'
      ? window.setTimeout(() => controller.abort(), timeoutMs)
      : null;

  try {
    const url = `${getFirestoreRestDocumentsBaseUrl()}/deliveryFeeds/${encodeURIComponent(
      feedKey
    )}/orders?pageSize=200&key=${encodeURIComponent(firebaseConfig.apiKey)}`;
    const res = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller?.signal,
    });
    if (!res.ok) return [];
    const payload = (await res.json()) as { documents?: FirestoreRestDocument[] };
    const docs = Array.isArray(payload?.documents) ? payload.documents : [];
    const results: T[] = [];
    for (const d of docs) {
      const parsed = decodeFirestoreRestDocument<T>(d);
      if (parsed) results.push(parsed);
    }
    return results;
  } catch {
    return [];
  } finally {
    if (timer !== null && typeof window !== 'undefined') {
      window.clearTimeout(timer);
    }
  }
}

function createCrossDeviceAuth(): Auth {
  // Use standard getAuth(app) to avoid Firebase 13.4.0 initializeAuth bundler assertions
  // while still supporting cross-device persistence negotiation in ensureResilientAuthPersistence().
  return getAuth(app);
}

export const auth = createCrossDeviceAuth();

export type AuthPersistenceTier =
  | 'local'
  | 'session'
  | 'indexedDB'
  | 'memory';

let persistenceInitPromise: Promise<{
  tier: AuthPersistenceTier;
  capabilities: StorageCapabilities;
}> | null = null;

/**
 * Explicitly verifies and applies the most durable Firebase Auth persistence
 * backend that actually succeeds in the current browser (including Safari
 * Private Browsing & strict ITP where standard third-party storage is blocked).
 */
export function ensureResilientAuthPersistence(): Promise<{
  tier: AuthPersistenceTier;
  capabilities: StorageCapabilities;
}> {
  if (persistenceInitPromise) return persistenceInitPromise;

  persistenceInitPromise = (async () => {
    const capabilities = detectStorageCapabilities();
    const candidates: Array<{ tier: AuthPersistenceTier; impl: Persistence }> = [];

    if (capabilities.localStorage) {
      candidates.push({ tier: 'local', impl: browserLocalPersistence });
    }
    if (capabilities.sessionStorage) {
      candidates.push({ tier: 'session', impl: browserSessionPersistence });
    }
    if (capabilities.indexedDB) {
      candidates.push({ tier: 'indexedDB', impl: indexedDBLocalPersistence });
    }
    candidates.push({ tier: 'memory', impl: inMemoryPersistence });

    for (const candidate of candidates) {
      try {
        if (candidate.impl) {
          await setPersistence(auth, candidate.impl);
          return { tier: candidate.tier, capabilities };
        }
      } catch {
        // Safari Private Mode / ITP / sandboxed iframe rejected this backend; try next tier
      }
    }

    return { tier: 'memory', capabilities };
  })();

  return persistenceInitPromise;
}

export async function waitForAuthReady(timeoutMs = 2500): Promise<void> {
  if (typeof auth.authStateReady !== 'function') return;
  await Promise.race([
    auth.authStateReady().catch(() => undefined),
    new Promise<void>((resolve) => {
      if (typeof window !== 'undefined') {
        window.setTimeout(resolve, timeoutMs);
      } else {
        resolve();
      }
    }),
  ]);
}
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export function isInAppMobileBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (
    /(FBAN|FBAV|Instagram|Line\/|MicroMessenger|WhatsApp|Telegram|TikTok|BytedanceWebview|wv\)|; wv)/i.test(
      ua
    )
  ) {
    return true;
  }
  // On iPhone/iPad, in-app WebViews (Telegram, WhatsApp, Instagram, etc.) contain AppleWebKit
  // without real Safari/CriOS/FxiOS/EdgiOS tokens.
  const isIos = /iPhone|iPad|iPod/i.test(ua);
  if (isIos && /AppleWebKit/i.test(ua)) {
    const isStandardIosBrowser = /(Safari\/|CriOS\/|FxiOS\/|EdgiOS\/|OPiOS\/)/i.test(ua);
    if (!isStandardIosBrowser) {
      return true;
    }
  }
  return false;
}

const PENDING_GOOGLE_REDIRECT_KEY = 'alpamart_pending_google_redirect_v1';

export async function resolveGoogleRedirectResult(
  checkEvenWithoutFlag = false
): Promise<{
  credential?: UserCredential | null;
  errorMessage?: string;
}> {
  let hadPendingRedirect = false;
  try {
    hadPendingRedirect = getResilientItem(PENDING_GOOGLE_REDIRECT_KEY) === '1';
    if (hadPendingRedirect) {
      removeResilientItem(PENDING_GOOGLE_REDIRECT_KEY);
    }
  } catch {
    // Ignore storage restrictions
  }

  if (!hadPendingRedirect && !checkEvenWithoutFlag) {
    return { credential: null };
  }

  try {
    const credential = await Promise.race([
      getRedirectResult(auth, browserPopupRedirectResolver),
      new Promise<null>((resolve) => {
        if (typeof window !== 'undefined') {
          window.setTimeout(() => resolve(null), 2800);
        } else {
          resolve(null);
        }
      }),
    ]);
    if (!credential && !auth.currentUser && hadPendingRedirect) {
      return {
        credential: null,
        errorMessage:
          'Browser HP memblokir sesi mode redirect lintas domain. Gunakan tab "Email & Password" (langsung masuk 100% di Android & iPhone tanpa pop-up) atau izinkan Pop-up di Safari/Chrome.',
      };
    }
    return { credential };
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code)
        : '';
    if (!code || code === 'auth/no-auth-event') {
      return { credential: null };
    }
    if (code === 'auth/unauthorized-domain') {
      const host = typeof window !== 'undefined' ? window.location.hostname : '';
      return {
        errorMessage: `Domain "${host}" belum masuk daftar Authorized Domains di Firebase Authentication. Untuk langsung masuk sekarang di Android/iPhone, gunakan tab "Email & Password" (tidak butuh Authorized Domain).`,
      };
    }
    if (!hadPendingRedirect) {
      return { credential: null };
    }
    return {
      errorMessage:
        'Login Google redirect terhalang pembatasan cookie browser HP. Gunakan tab "Email & Password" agar langsung bisa login di Android & iPhone tanpa kendala.',
    };
  }
}

export async function signInWithGoogleRedirectSafe(): Promise<{
  errorMessage?: string;
}> {
  try {
    try {
      setResilientItem(PENDING_GOOGLE_REDIRECT_KEY, '1', {
        allowCookie: true,
        maxAgeSeconds: 600,
      });
    } catch {
      // Ignore storage restrictions
    }
    await signInWithRedirect(auth, googleProvider, browserPopupRedirectResolver);
    return {};
  } catch (err) {
    try {
      removeResilientItem(PENDING_GOOGLE_REDIRECT_KEY);
    } catch {
      // Ignore
    }
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code)
        : '';
    if (code === 'auth/unauthorized-domain') {
      const host = typeof window !== 'undefined' ? window.location.hostname : '';
      return {
        errorMessage: `Domain "${host}" belum terdaftar di Firebase Authorized Domains. Tambahkan domain ini di Firebase Console → Authentication → Settings → Authorized domains.`,
      };
    }
    return {
      errorMessage:
        err instanceof Error
          ? err.message
          : 'Gagal mengalihkan login Google di HP. Pastikan dibuka di Google Chrome (Android) atau Safari asli (iPhone).',
    };
  }
}

export async function signInWithGoogleSafe(): Promise<{
  credential?: UserCredential;
  errorMessage?: string;
  popupBlocked?: boolean;
  unauthorizedDomain?: string;
}> {
  const ios = isIosDevice();
  const android = isAndroidDevice();
  const inApp = isInAppMobileBrowser();

  try {
    const credential = await signInWithPopup(
      auth,
      googleProvider,
      browserPopupRedirectResolver
    );
    return { credential };
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code)
        : '';
    if (code === 'auth/unauthorized-domain') {
      const host = typeof window !== 'undefined' ? window.location.hostname : '';
      return {
        unauthorizedDomain: host,
        errorMessage: `Domain "${host}" belum diizinkan untuk login Google di Firebase. Tambahkan "${host}" ke Firebase Console → Authentication → Settings → Authorized domains, atau gunakan login Email & Password.`,
      };
    }
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      if (ios) {
        return {
          popupBlocked: true,
          errorMessage:
            'Jendela login Google tertutup di iPhone. Pastikan "Blokir Pop-up" di Pengaturan iPhone → Safari sudah dimatikan, atau gunakan tab "Email & Password" (langsung masuk tanpa pop-up).',
        };
      }
      if (android) {
        return {
          popupBlocked: true,
          errorMessage:
            'Jendela login Google tertutup di Android. Pastikan dibuka di Google Chrome asli (bukan di dalam Telegram/WhatsApp) dan izinkan Pop-up, atau gunakan tab "Email & Password".',
        };
      }
      return {
        errorMessage: 'Jendela login Google ditutup sebelum selesai. Silakan coba lagi.',
      };
    }
    if (code === 'auth/popup-blocked') {
      return {
        popupBlocked: true,
        errorMessage: ios
          ? 'Safari iPhone memblokir jendela Pop-up login Google. Buka Pengaturan iPhone → Safari → matikan "Blokir Pop-up", atau gunakan tab "Email & Password" (tanpa pop-up).'
          : 'Popup login Google diblokir oleh browser Android Anda. Ketuk "Selalu tampilkan" pada notifikasi popup Chrome, atau gunakan tab "Email & Password" (tanpa pop-up).',
      };
    }
    if (
      inApp ||
      code === 'auth/operation-not-supported-in-this-environment' ||
      code === 'auth/web-storage-unsupported'
    ) {
      return {
        popupBlocked: true,
        errorMessage: ios
          ? 'Anda membuka link dari browser dalam aplikasi (Telegram/WhatsApp). Ketuk ikon Kompas (Safari) di pojok kanan bawah iPhone, atau masuk memakai tab "Email & Password".'
          : 'Browser bawaan WhatsApp/Telegram memblokir login Google. Klik tombol "Buka di Google Chrome Android" di atas, atau masuk memakai tab "Email & Password".',
      };
    }
    if (code === 'auth/network-request-failed') {
      return {
        errorMessage:
          'Koneksi ke server login terputus. Periksa jaringan internet HP Anda (matikan VPN/Private Relay sementara) lalu coba lagi.',
      };
    }
    return {
      errorMessage:
        err instanceof Error
          ? err.message
          : 'Gagal masuk dengan Google. Pastikan Anda membuka link ini di Google Chrome (Android) atau Safari asli (iPhone).',
    };
  }
}

export async function signInWithEmailPasswordSafe(
  email: string,
  password: string
): Promise<{
  credential?: UserCredential;
  errorMessage?: string;
  providerNotEnabled?: boolean;
  userNotFound?: boolean;
}> {
  try {
    const credential = await signInWithEmailAndPassword(
      auth,
      email.trim(),
      password
    );
    return { credential };
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code)
        : '';
    if (code === 'auth/operation-not-allowed') {
      return {
        providerNotEnabled: true,
        errorMessage:
          'Login Email & Password belum diaktifkan di Firebase Console. Aktifkan "Email/Password" di Firebase Console → Authentication → Sign-in method, atau klik "Masuk dengan Google" di bawah untuk langsung masuk sekarang.',
      };
    }
    if (code === 'auth/user-not-found') {
      return {
        userNotFound: true,
        errorMessage:
          'Akun Email & Password belum diaktivasi di Firebase. Klik tab "Aktivasi Password Pertama" untuk mendaftarkan password akun Master Data Anda.',
      };
    }
    if (
      code === 'auth/invalid-credential' ||
      code === 'auth/wrong-password'
    ) {
      return {
        userNotFound: true,
        errorMessage:
          'Email atau password salah, atau akun belum diaktivasi pertama kali. Jika ini pertama kali login pakai password, pilih tab "Aktivasi Password Pertama".',
      };
    }
    if (code === 'auth/too-many-requests') {
      return {
        errorMessage:
          'Terlalu banyak percobaan login. Tunggu beberapa menit lalu coba lagi, atau gunakan tombol Masuk dengan Google.',
      };
    }
    return {
      errorMessage:
        err instanceof Error
          ? err.message
          : 'Gagal masuk dengan email dan password.',
    };
  }
}

export async function registerMasterEmailPasswordSafe(
  email: string,
  password: string
): Promise<{
  credential?: UserCredential;
  verificationSent?: boolean;
  errorMessage?: string;
  providerNotEnabled?: boolean;
}> {
  try {
    const credential = await createUserWithEmailAndPassword(
      auth,
      email.trim(),
      password
    );
    let verificationSent = false;
    try {
      await sendEmailVerification(credential.user);
      verificationSent = true;
    } catch {
      // Verification email can be re-sent from the verification screen
    }
    return { credential, verificationSent };
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code)
        : '';
    if (code === 'auth/operation-not-allowed') {
      return {
        providerNotEnabled: true,
        errorMessage:
          'Metode Email/Password belum diaktifkan di Firebase Console. Aktifkan di Firebase Console → Authentication → Sign-in method → Email/Password, atau gunakan tombol "Masuk dengan Google" di bawah.',
      };
    }
    if (code === 'auth/email-already-in-use') {
      return {
        errorMessage:
          'Email ini sudah terdaftar di Firebase Auth. Silakan pindah ke tab "Masuk (Email & Password)" atau gunakan "Masuk dengan Google".',
      };
    }
    if (code === 'auth/weak-password') {
      return {
        errorMessage: 'Password minimal 6 karakter.',
      };
    }
    return {
      errorMessage:
        err instanceof Error
          ? err.message
          : 'Gagal mengaktivasi akun Master Data.',
    };
  }
}

export async function sendMasterPasswordResetSafe(email: string): Promise<{
  ok: boolean;
  message: string;
}> {
  try {
    await sendPasswordResetEmail(auth, email.trim());
    return {
      ok: true,
      message: `Link reset password telah dikirim ke ${email.trim()}. Periksa kotak masuk atau folder Spam Anda.`,
    };
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code)
        : '';
    if (code === 'auth/operation-not-allowed') {
      return {
        ok: false,
        message:
          'Provider Email/Password belum diaktifkan di Firebase Console.',
      };
    }
    return {
      ok: false,
      message:
        err instanceof Error
          ? err.message
          : 'Gagal mengirim email reset password.',
    };
  }
}

export async function resendVerificationEmailSafe(user: User): Promise<{
  ok: boolean;
  message: string;
}> {
  try {
    await sendEmailVerification(user);
    return {
      ok: true,
      message: `Email verifikasi telah dikirim ke ${user.email || 'email Anda'}. Buka link di email lalu klik "Saya Sudah Verifikasi".`,
    };
  } catch (err) {
    return {
      ok: false,
      message:
        err instanceof Error
          ? err.message
          : 'Gagal mengirim ulang email verifikasi. Coba beberapa saat lagi.',
    };
  }
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export function isQuotaOrResourceExhaustedError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code).toLowerCase()
      : '';
  const msg =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error || '').toLowerCase();
  return (
    code.includes('resource-exhausted') ||
    code.includes('quota') ||
    msg.includes('resource-exhausted') ||
    msg.includes('resource_exhausted') ||
    msg.includes('quota exceeded') ||
    msg.includes('quotaexceeded') ||
    msg.includes('429') ||
    msg.includes('kuota')
  );
}

export function formatCatalogLoadError(error: unknown): string {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'Perangkat sedang offline. Periksa koneksi internet Anda lalu tekan "Muat Ulang Katalog".';
  }
  if (isQuotaOrResourceExhaustedError(error)) {
    return 'Server katalog sedang mencapai batas akses harian sementara. Data produk & stok tetap aman — silakan coba muat ulang beberapa saat lagi.';
  }
  const msg =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error || '').toLowerCase();
  if (msg.includes('abort') || msg.includes('timeout')) {
    return 'Koneksi ke server katalog terlalu lambat atau terputus di browser ini. Pastikan jaringan stabil (matikan VPN/Private Relay sementara di iPhone jika aktif) lalu tekan "Muat Ulang Katalog".';
  }
  return 'Gagal terhubung ke server katalog produk. Data produk & stok belum dimuat — tekan "Muat Ulang Katalog" untuk mencoba lagi.';
}



/**
 * Safari Private Browsing & ITP-Resilient First-Party Storage Adapter
 *
 * Safari's Intelligent Tracking Prevention (ITP) and Private Browsing can block
 * third-party storage, throw QuotaExceededError/SecurityError on localStorage,
 * or purge Web Storage unexpectedly. This module cascades across four first-party
 * storage tiers so Admin, Delivery, Master, and Customer session state persists
 * reliably:
 *   1. window.localStorage (standard first-party persistence)
 *   2. window.sessionStorage (survives reloads in Safari Private Browsing)
 *   3. First-party SameSite=Lax cookie (small metadata/session payloads only)
 *   4. window.name JSON namespace + in-memory Map (survives reloads even when
 *      Web Storage and cookies are completely disabled)
 */

export type StorageTier = 'localStorage' | 'sessionStorage' | 'cookie' | 'windowName' | 'memory';

export interface StorageCapabilities {
  localStorage: boolean;
  sessionStorage: boolean;
  cookie: boolean;
  indexedDB: boolean;
  preferredTier: StorageTier;
}

export interface PersistedRoleSession {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  isMaster: boolean;
  isAdmin: boolean;
  isDelivery: boolean;
  deliveryEmailHash: string;
  activeRole: 'master' | 'admin' | 'delivery' | 'customer';
  updatedAt: number;
}

const MEMORY_STORE = new Map<string, string>();
const WINDOW_NAME_PREFIX = '__ALPAMART_STORE_V1__:';
const COOKIE_PREFIX = 'am_s1_';
const ROLE_SESSION_KEY = 'alpamart_role_session_v1';
const ROLE_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_COOKIE_VALUE_LENGTH = 2600;
const MAX_WINDOW_NAME_LENGTH = 64000;

function probeWebStorage(kind: 'localStorage' | 'sessionStorage'): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const store = window[kind];
    if (!store) return false;
    const probeKey = `__am_probe_${kind}__`;
    store.setItem(probeKey, '1');
    const ok = store.getItem(probeKey) === '1';
    store.removeItem(probeKey);
    return ok;
  } catch {
    return false;
  }
}

function probeFirstPartyCookie(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const probeName = `${COOKIE_PREFIX}probe`;
    const secureFlag =
      typeof window !== 'undefined' && window.location?.protocol === 'https:'
        ? '; Secure'
        : '';
    document.cookie = `${probeName}=1; Path=/; SameSite=Lax${secureFlag}`;
    const ok = document.cookie.includes(`${probeName}=1`);
    document.cookie = `${probeName}=; Path=/; Max-Age=0; SameSite=Lax${secureFlag}`;
    return ok;
  } catch {
    return false;
  }
}

export function canUseLocalStorage(): boolean {
  return probeWebStorage('localStorage');
}

export function canUseSessionStorage(): boolean {
  return probeWebStorage('sessionStorage');
}

export function canUseIndexedDb(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return typeof window.indexedDB !== 'undefined' && window.indexedDB !== null;
  } catch {
    return false;
  }
}

export function detectStorageCapabilities(): StorageCapabilities {
  const localOk = canUseLocalStorage();
  const sessionOk = canUseSessionStorage();
  const cookieOk = probeFirstPartyCookie();
  const idbOk = canUseIndexedDb();

  const preferredTier: StorageTier = localOk
    ? 'localStorage'
    : sessionOk
      ? 'sessionStorage'
      : cookieOk
        ? 'cookie'
        : 'windowName';

  return {
    localStorage: localOk,
    sessionStorage: sessionOk,
    cookie: cookieOk,
    indexedDB: idbOk,
    preferredTier,
  };
}

function sanitizeCookieKey(key: string): string {
  return `${COOKIE_PREFIX}${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function readCookie(key: string): string | null {
  if (typeof document === 'undefined') return null;
  try {
    const target = `${sanitizeCookieKey(key)}=`;
    const parts = document.cookie ? document.cookie.split('; ') : [];
    for (const part of parts) {
      if (part.startsWith(target)) {
        return decodeURIComponent(part.slice(target.length));
      }
    }
  } catch {
    // ignore malformed cookie
  }
  return null;
}

function writeCookie(key: string, value: string, maxAgeSeconds = 60 * 60 * 24 * 7): void {
  if (typeof document === 'undefined') return;
  try {
    const encoded = encodeURIComponent(value);
    if (encoded.length > MAX_COOKIE_VALUE_LENGTH) return;
    const secureFlag =
      typeof window !== 'undefined' && window.location?.protocol === 'https:'
        ? '; Secure'
        : '';
    document.cookie = `${sanitizeCookieKey(key)}=${encoded}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax${secureFlag}`;
  } catch {
    // ignore cookie restrictions
  }
}

function deleteCookie(key: string): void {
  if (typeof document === 'undefined') return;
  try {
    const secureFlag =
      typeof window !== 'undefined' && window.location?.protocol === 'https:'
        ? '; Secure'
        : '';
    document.cookie = `${sanitizeCookieKey(key)}=; Path=/; Max-Age=0; SameSite=Lax${secureFlag}`;
  } catch {
    // ignore
  }
}

function readWindowNameMap(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.name || '';
    if (!raw.startsWith(WINDOW_NAME_PREFIX)) return {};
    const parsed = JSON.parse(raw.slice(WINDOW_NAME_PREFIX.length));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // ignore corrupted window.name
  }
  return {};
}

function writeWindowNameMap(map: Record<string, string>): void {
  if (typeof window === 'undefined') return;
  try {
    const serialized = `${WINDOW_NAME_PREFIX}${JSON.stringify(map)}`;
    if (serialized.length <= MAX_WINDOW_NAME_LENGTH) {
      window.name = serialized;
    }
  } catch {
    // ignore window.name write restriction
  }
}

export function getResilientItem(key: string): string | null {
  // 1. localStorage
  if (typeof window !== 'undefined') {
    try {
      const val = window.localStorage.getItem(key);
      if (val !== null) {
        MEMORY_STORE.set(key, val);
        return val;
      }
    } catch {
      // Blocked in Safari Private Browsing / ITP
    }

    // 2. sessionStorage
    try {
      const val = window.sessionStorage.getItem(key);
      if (val !== null) {
        MEMORY_STORE.set(key, val);
        return val;
      }
    } catch {
      // Blocked
    }
  }

  // 3. First-party SameSite=Lax cookie
  const fromCookie = readCookie(key);
  if (fromCookie !== null) {
    MEMORY_STORE.set(key, fromCookie);
    return fromCookie;
  }

  // 4. window.name fallback
  const fromWindowName = readWindowNameMap()[key];
  if (typeof fromWindowName === 'string') {
    MEMORY_STORE.set(key, fromWindowName);
    return fromWindowName;
  }

  // 5. In-memory fallback
  return MEMORY_STORE.get(key) ?? null;
}

export function setResilientItem(
  key: string,
  value: string,
  options?: { allowCookie?: boolean; maxAgeSeconds?: number }
): void {
  MEMORY_STORE.set(key, value);

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // ignore quota/security error in Safari Private Browsing
    }

    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      // ignore
    }
  }

  if (options?.allowCookie) {
    writeCookie(key, value, options.maxAgeSeconds);
  }

  // Always mirror small/medium values into window.name for same-tab reload durability
  if (value.length <= 16000) {
    const map = readWindowNameMap();
    map[key] = value;
    writeWindowNameMap(map);
  }
}

export function removeResilientItem(key: string): void {
  MEMORY_STORE.delete(key);

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // ignore
    }
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      // ignore
    }
  }

  deleteCookie(key);

  const map = readWindowNameMap();
  if (Object.prototype.hasOwnProperty.call(map, key)) {
    delete map[key];
    writeWindowNameMap(map);
  }
}

export function loadRoleSession(): PersistedRoleSession | null {
  try {
    const raw = getResilientItem(ROLE_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedRoleSession>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.uid !== 'string' ||
      !parsed.uid ||
      typeof parsed.updatedAt !== 'number'
    ) {
      return null;
    }
    if (Date.now() - parsed.updatedAt > ROLE_SESSION_MAX_AGE_MS) {
      clearRoleSession();
      return null;
    }
    const activeRole =
      parsed.activeRole === 'master' ||
      parsed.activeRole === 'admin' ||
      parsed.activeRole === 'delivery' ||
      parsed.activeRole === 'customer'
        ? parsed.activeRole
        : 'customer';
    return {
      uid: parsed.uid,
      email: typeof parsed.email === 'string' ? parsed.email : null,
      emailVerified: Boolean(parsed.emailVerified),
      isMaster: Boolean(parsed.isMaster),
      isAdmin: Boolean(parsed.isAdmin),
      isDelivery: Boolean(parsed.isDelivery),
      deliveryEmailHash:
        typeof parsed.deliveryEmailHash === 'string' ? parsed.deliveryEmailHash : '',
      activeRole,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

export function saveRoleSession(session: PersistedRoleSession): void {
  try {
    setResilientItem(ROLE_SESSION_KEY, JSON.stringify(session), {
      allowCookie: true,
      maxAgeSeconds: Math.floor(ROLE_SESSION_MAX_AGE_MS / 1000),
    });
  } catch {
    // ignore serialization issues
  }
}

export function clearRoleSession(): void {
  removeResilientItem(ROLE_SESSION_KEY);
}

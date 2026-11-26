import { getShareableOrigin, STORE_NAME } from './catalogSeed';
import {
  buildSinglePortalDomainZipPackage,
  type PortalZipTarget,
} from './portalZipBuilder';

export type { PortalZipTarget } from './portalZipBuilder';

const ZIP_MIME_TYPE = 'application/zip';
const MOBILE_OBJECT_URL_REVOKE_MS = 120_000;

/**
 * Sanitizes a ZIP filename so iOS Files, Android My Files, and HTTP
 * Content-Disposition headers accept it cleanly without illegal characters.
 */
export function sanitizeZipFilename(rawFilename: string): string {
  const cleaned = (rawFilename || '')
    .trim()
    .replace(/[\r\n\t\\/:"*?<>|]+/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  const base = cleaned || 'alpamart-portal';
  return base.toLowerCase().endsWith('.zip') ? base : `${base}.zip`;
}

/**
 * Verifies the PKZIP local file header magic bytes (0x50 0x4B 0x03 0x04).
 */
function hasValidZipMagic(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 22 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

/**
 * Copies the raw ZIP bytes into a fresh, contiguous ArrayBuffer and wraps it
 * in a mobile-browser-compatible Blob/File with strict `application/zip` MIME.
 */
export function createMobileCompatibleZipBlob(
  bytes: Uint8Array,
  filename: string
): Blob {
  if (!hasValidZipMagic(bytes)) {
    throw new Error('ZIP binary gagal divalidasi (header PKZIP tidak lengkap).');
  }

  const safeName = sanitizeZipFilename(filename);
  const contiguousBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(contiguousBuffer).set(bytes);

  // Using File when available preserves the filename metadata for iOS Files & Android share/download managers
  if (typeof File === 'function') {
    try {
      return new File([contiguousBuffer], safeName, {
        type: ZIP_MIME_TYPE,
        lastModified: Date.now(),
      });
    } catch {
      // Fallback to standard Blob below
    }
  }

  return new Blob([contiguousBuffer], { type: ZIP_MIME_TYPE });
}

function isLikelyMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return (
    /Android|iPhone|iPad|iPod|Mobile|CriOS|FxiOS/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/**
 * Builds the direct server ZIP download URL that responds with mobile-ready
 * `Content-Type: application/zip` and RFC 5987 `Content-Disposition: attachment` headers.
 */
export function buildPortalZipDownloadUrl(
  portal: PortalZipTarget,
  options?: {
    storeName?: string;
    storeTagline?: string;
    customBaseOrigin?: string;
  }
): string {
  const params = new URLSearchParams();
  params.set('portal', portal);
  const activeStoreName = (options?.storeName || STORE_NAME).trim() || STORE_NAME;
  params.set('storeName', activeStoreName);
  if (options?.storeTagline && options.storeTagline.trim()) {
    params.set('storeTagline', options.storeTagline.trim());
  }
  const resolvedOrigin = resolveDownloadOrigin(options?.customBaseOrigin);
  if (resolvedOrigin) {
    params.set('origin', resolvedOrigin);
  }
  return `/api/download-portal-zip?${params.toString()}`;
}

function triggerZipDownload(bytes: Uint8Array, filename: string): void {
  const safeName = sanitizeZipFilename(filename);
  const blob = createMobileCompatibleZipBlob(bytes, safeName);

  // Legacy Edge/IE fallback if present
  const navWithSave = navigator as Navigator & {
    msSaveOrOpenBlob?: (blob: Blob, defaultName?: string) => boolean;
  };
  if (typeof navWithSave.msSaveOrOpenBlob === 'function') {
    navWithSave.msSaveOrOpenBlob(blob, safeName);
    return;
  }

  const blobUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = safeName;
  link.type = ZIP_MIME_TYPE;
  link.target = '_self';
  link.rel = 'noopener noreferrer';
  link.className = 'sr-only';
  document.body.appendChild(link);

  // Dispatch inside the active user gesture for iOS Safari & Android Chrome compatibility
  if (isLikelyMobileDevice() && typeof MouseEvent === 'function') {
    link.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
      })
    );
  } else {
    link.click();
  }

  // Keep Object URL alive long enough for iOS/Android background download manager handoff
  window.setTimeout(() => {
    try {
      if (link.parentNode) {
        link.parentNode.removeChild(link);
      }
    } catch {
      // ignore if already detached
    }
    try {
      URL.revokeObjectURL(blobUrl);
    } catch {
      // ignore revoke errors
    }
  }, MOBILE_OBJECT_URL_REVOKE_MS);
}

function resolveDownloadOrigin(customBaseOrigin?: string): string {
  const liveBackendOrigin = getShareableOrigin();
  const rawCustom = (customBaseOrigin || '').trim().replace(/\/+$/, '');
  if (!rawCustom || !/^https?:\/\//i.test(rawCustom)) {
    return liveBackendOrigin;
  }
  const normalizedCustom = rawCustom.replace(/^https:\/\/ais-dev-/i, 'https://ais-pre-');
  // A portal ZIP is uploaded onto a custom frontend domain (e.g., Netlify/Vercel/cPanel)
  // and embeds the live running backend server inside an iframe.
  // Pointing the ZIP iframe back to a custom frontend domain would cause an infinite self-loop
  // or fail to load if the custom domain is not hosted yet. Always target the live backend server
  // unless the provided origin is itself the running Cloud Run / AI Studio backend host.
  try {
    const customHost = new URL(normalizedCustom).hostname.toLowerCase();
    const backendHost = new URL(liveBackendOrigin).hostname.toLowerCase();
    if (customHost === backendHost || customHost.endsWith('.run.app')) {
      return normalizedCustom;
    }
  } catch {
    // fallback to liveBackendOrigin
  }
  return liveBackendOrigin;
}

/**
 * Detects which single portal is currently active in the browser URL
 * (customer, delivery, admin, or master).
 */
export function detectActivePortalTarget(): PortalZipTarget {
  if (typeof window === 'undefined') return 'customer';

  let decodedPath = window.location.pathname || '';
  try {
    decodedPath = decodeURIComponent(decodedPath);
  } catch {
    // keep raw pathname
  }

  const path = decodedPath.toLowerCase().replace(/\/+$/, '');
  const host = (window.location.hostname || '').toLowerCase();
  const hash = (window.location.hash || '').toLowerCase();
  const params = new URLSearchParams(window.location.search || '');
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

function extractDispositionFilename(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const utf8Match = headerValue.match(/filename\*=UTF-8''([^;\r\n]+)/i);
  if (utf8Match?.[1]) {
    try {
      return sanitizeZipFilename(decodeURIComponent(utf8Match[1].trim()));
    } catch {
      // fall through
    }
  }
  const plainMatch = headerValue.match(/filename="([^"]+)"/i);
  if (plainMatch?.[1]) {
    return sanitizeZipFilename(plainMatch[1].trim());
  }
  return null;
}

/**
 * Downloads a strictly isolated standalone full-app hosting ZIP for ONE specific website
 * (1 Website = 1 File ZIP: Customer, Delivery, Admin, or Master).
 * Fetches the full compiled React + Firebase app bundle from `/api/download-portal-zip`
 * so uploading to Netlify / Vercel / Cloudflare Pages / cPanel runs natively with ZERO iframe blocking.
 * Validates PKZIP magic bytes before saving so mobile browsers never save an HTML redirect as a broken .zip.
 */
export function downloadSinglePortalDomainZip(
  portal: PortalZipTarget,
  options?: {
    storeName?: string;
    storeTagline?: string;
    customBaseOrigin?: string;
  }
): {
  filename: string;
  origin: string;
  fileCount: number;
  portal: PortalZipTarget;
  portalLabel: string;
  downloadUrl: string;
} {
  const activeStoreName = (options?.storeName || STORE_NAME).trim() || STORE_NAME;
  const origin = resolveDownloadOrigin(options?.customBaseOrigin);

  const fallbackPkg = buildSinglePortalDomainZipPackage({
    portal,
    storeName: activeStoreName,
    storeTagline: options?.storeTagline,
    origin,
  });

  const safeFallbackName = sanitizeZipFilename(
    fallbackPkg.filename.replace('_AutoUpdate_', '_FullHosting_')
  );
  const downloadUrl = buildPortalZipDownloadUrl(portal, {
    storeName: activeStoreName,
    storeTagline: options?.storeTagline,
    customBaseOrigin: origin,
  });

  // Fetch the real full-app standalone ZIP from our Express backend, verifying PKZIP magic bytes
  // before triggering the mobile-compatible File/Blob download.
  void (async () => {
    try {
      const cacheBustedUrl = `${downloadUrl}&_t=${Date.now()}`;
      const res = await fetch(cacheBustedUrl, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
      });
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (res.ok && (contentType.includes('application/zip') || contentType.includes('octet-stream'))) {
        const buffer = await res.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        if (hasValidZipMagic(bytes)) {
          const serverFilename =
            extractDispositionFilename(res.headers.get('content-disposition')) ||
            safeFallbackName;
          triggerZipDownload(bytes, serverFilename);
          return;
        }
      }
    } catch {
      // Fall back below if running on a static host without Express backend
    }
    triggerZipDownload(fallbackPkg.bytes, sanitizeZipFilename(fallbackPkg.filename));
  })();

  return {
    filename: safeFallbackName,
    origin: fallbackPkg.origin,
    fileCount: fallbackPkg.fileCount,
    portal: fallbackPkg.portal,
    portalLabel: fallbackPkg.portalLabel,
    downloadUrl,
  };
}

/**
 * Detects the currently active portal (unless explicitly specified via options.portal)
 * and generates a standalone domain ZIP dedicated ONLY to that active portal/store.
 * Never merges data or files from other portals.
 */
export function downloadCustomerDomainZip(options?: {
  portal?: PortalZipTarget;
  storeName?: string;
  storeTagline?: string;
  customBaseOrigin?: string;
}): {
  filename: string;
  origin: string;
  fileCount: number;
  portal: PortalZipTarget;
  portalLabel: string;
  downloadUrl: string;
} {
  const activePortal = options?.portal || detectActivePortalTarget();
  return downloadSinglePortalDomainZip(activePortal, options);
}

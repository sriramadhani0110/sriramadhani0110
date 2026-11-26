import { auth } from './firebase';
import { prepareProductImagePreservingDimensions } from './storeDefaults';

const PLACEHOLDER_PRODUCT_IMAGE_URL = '/assets/placeholder-product.svg';

export interface BackendOptimizedProductImage {
  ok: true;
  imageUrl: string;
  originalWidth: number;
  originalHeight: number;
  fittedWidth: number;
  fittedHeight: number;
  boxWidth: number;
  boxHeight: number;
  format: 'webp' | 'jpeg' | 'placeholder' | 'unchanged';
  sizeKb: number;
  aspectRatioPreserved: true;
  alreadyOptimized: boolean;
  viaBackend: boolean;
}

const MAX_CLIENT_RAW_UPLOAD_BYTES = 7 * 1024 * 1024; // 7 MB (keeps base64 comfortably within 12 MB backend cap)
const optimizedCache = new Map<string, BackendOptimizedProductImage>();
const MAX_CACHE_ENTRIES = 80;

function rememberOptimized(sourceKey: string, result: BackendOptimizedProductImage): void {
  if (optimizedCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = optimizedCache.keys().next().value;
    if (oldestKey) optimizedCache.delete(oldestKey);
  }
  optimizedCache.set(sourceKey, result);
  // Also key by the resulting optimized imageUrl so re-saving the same product is instant
  optimizedCache.set(result.imageUrl, { ...result, alreadyOptimized: true });
}

export function isPlaceholderOrEmptyProductImage(raw: string | undefined | null): boolean {
  const trimmed = (raw || '').trim();
  return !trimmed || trimmed === PLACEHOLDER_PRODUCT_IMAGE_URL || trimmed.endsWith('.svg');
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Gagal membaca file gambar dari perangkat.'));
    reader.readAsDataURL(file);
  });
}

async function getAdminAuthHeader(): Promise<Record<string, string>> {
  const user = auth.currentUser;
  if (!user) return {};
  try {
    const token = await user.getIdToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

/**
 * Sends a product image (data URL or HTTPS URL) to the backend optimizer so every
 * created or updated catalog product is consistently fitted into a square display box
 * without distorting or cropping its aspect ratio.
 */
export async function optimizeProductImageOnBackend(
  rawImageInput: string,
  options?: { boxSize?: number; paddingRatio?: number; skipCache?: boolean }
): Promise<BackendOptimizedProductImage> {
  const trimmed = (rawImageInput || '').trim();

  if (isPlaceholderOrEmptyProductImage(trimmed)) {
    return {
      ok: true,
      imageUrl: trimmed || PLACEHOLDER_PRODUCT_IMAGE_URL,
      originalWidth: 800,
      originalHeight: 800,
      fittedWidth: 800,
      fittedHeight: 800,
      boxWidth: 800,
      boxHeight: 800,
      format: 'placeholder',
      sizeKb: 0,
      aspectRatioPreserved: true,
      alreadyOptimized: true,
      viaBackend: false,
    };
  }

  if (!options?.skipCache) {
    const cached = optimizedCache.get(trimmed);
    if (cached) {
      return cached;
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(await getAdminAuthHeader()),
  };

  try {
    const res = await fetch('/api/admin/products/optimize-image', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        imageInput: trimmed,
        boxSize: options?.boxSize ?? 800,
        paddingRatio: options?.paddingRatio ?? 0.04,
      }),
    });

    if (res.ok) {
      const payload = (await res.json()) as Partial<BackendOptimizedProductImage> & {
        ok?: boolean;
        imageUrl?: string;
      };
      if (payload.ok && typeof payload.imageUrl === 'string' && payload.imageUrl.length >= 4) {
        const normalized: BackendOptimizedProductImage = {
          ok: true,
          imageUrl: payload.imageUrl,
          originalWidth: Number(payload.originalWidth) || 800,
          originalHeight: Number(payload.originalHeight) || 800,
          fittedWidth: Number(payload.fittedWidth) || 800,
          fittedHeight: Number(payload.fittedHeight) || 800,
          boxWidth: Number(payload.boxWidth) || 800,
          boxHeight: Number(payload.boxHeight) || 800,
          format: payload.format || 'webp',
          sizeKb: Number(payload.sizeKb) || 0,
          aspectRatioPreserved: true,
          alreadyOptimized: Boolean(payload.alreadyOptimized),
          viaBackend: true,
        };
        rememberOptimized(trimmed, normalized);
        return normalized;
      }
    }
  } catch {
    // Graceful fallback below so admin saving is never blocked by transient network hiccups
  }

  // Fallback: preserve safe original URL/data URL constrained to Firestore rules limits
  const safeFallbackUrl = trimmed.startsWith('data:image/')
    ? trimmed.slice(0, 248000)
    : trimmed.startsWith('https://') || trimmed.startsWith('/')
      ? trimmed.slice(0, 1000)
      : PLACEHOLDER_PRODUCT_IMAGE_URL;

  return {
    ok: true,
    imageUrl: safeFallbackUrl,
    originalWidth: 800,
    originalHeight: 800,
    fittedWidth: 800,
    fittedHeight: 800,
    boxWidth: 800,
    boxHeight: 800,
    format: 'unchanged',
    sizeKb: trimmed.startsWith('data:image/')
      ? Math.max(1, Math.round((safeFallbackUrl.length * 3) / 4 / 1024))
      : 0,
    aspectRatioPreserved: true,
    alreadyOptimized: false,
    viaBackend: false,
  };
}

/**
 * Processes a local image File uploaded in the Admin Catalog modal through the backend
 * optimizer (fitting it cleanly into a consistent 800×800 display box without breaking
 * its aspect ratio). Falls back to client processing only if the server is offline.
 */
export async function optimizeProductImageFileOnBackend(
  file: File
): Promise<BackendOptimizedProductImage> {
  const looksLikeImage =
    !file.type ||
    file.type.startsWith('image/') ||
    /\.(jpe?g|png|webp|gif|avif|heic|heif)$/i.test(file.name || '');

  if (!looksLikeImage) {
    throw new Error('File harus berupa gambar (JPG, PNG, WebP, atau GIF).');
  }

  let rawDataUrl: string;
  if (file.size <= MAX_CLIENT_RAW_UPLOAD_BYTES) {
    rawDataUrl = await readFileAsDataUrl(file);
  } else {
    // Very large camera photo (>7 MB): proportionally pre-shrink client-side before sending to backend
    const preShrunk = await prepareProductImagePreservingDimensions(file, 240000);
    rawDataUrl = preShrunk.dataUrl;
  }

  const backendResult = await optimizeProductImageOnBackend(rawDataUrl, {
    boxSize: 800,
    paddingRatio: 0.04,
    skipCache: true,
  });

  if (backendResult.viaBackend) {
    return backendResult;
  }

  // Offline fallback: compress locally so Firestore 250 KB rule is always respected
  const localPrepared = await prepareProductImagePreservingDimensions(file, 240000);
  return {
    ok: true,
    imageUrl: localPrepared.dataUrl,
    originalWidth: localPrepared.originalWidth,
    originalHeight: localPrepared.originalHeight,
    fittedWidth: localPrepared.savedWidth,
    fittedHeight: localPrepared.savedHeight,
    boxWidth: localPrepared.savedWidth,
    boxHeight: localPrepared.savedHeight,
    format: 'jpeg',
    sizeKb: localPrepared.sizeKb,
    aspectRatioPreserved: true,
    alreadyOptimized: false,
    viaBackend: false,
  };
}

/**
 * Optimizes a batch of product images (used by Bulk CSV Import and JOURNAL POS Sync)
 * through the backend batch optimizer with graceful per-item fallback.
 */
export async function optimizeProductImagesBatchOnBackend(
  items: Array<{ key: string; imageInput: string }>
): Promise<Map<string, string>> {
  const resultMap = new Map<string, string>();
  const toProcess = items.filter((item) => {
    const trimmed = (item.imageInput || '').trim();
    if (isPlaceholderOrEmptyProductImage(trimmed)) return false;
    const cached = optimizedCache.get(trimmed);
    if (cached) {
      resultMap.set(item.key, cached.imageUrl);
      return false;
    }
    return true;
  });

  if (toProcess.length === 0) {
    return resultMap;
  }

  const authHeaders = await getAdminAuthHeader();
  if (!authHeaders.Authorization) {
    return resultMap;
  }

  const BATCH_CHUNK = 20;
  for (let i = 0; i < toProcess.length; i += BATCH_CHUNK) {
    const slice = toProcess.slice(i, i + BATCH_CHUNK);
    try {
      const res = await fetch('/api/admin/products/optimize-images-batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          items: slice,
          boxSize: 800,
          paddingRatio: 0.04,
        }),
      });
      if (!res.ok) continue;

      const json = (await res.json()) as {
        ok?: boolean;
        results?: Array<{
          key: string;
          ok: boolean;
          imageUrl?: string;
          originalWidth?: number;
          originalHeight?: number;
          fittedWidth?: number;
          fittedHeight?: number;
          boxWidth?: number;
          boxHeight?: number;
          format?: 'webp' | 'jpeg' | 'placeholder' | 'unchanged';
          sizeKb?: number;
          alreadyOptimized?: boolean;
        }>;
      };
      if (!json.ok || !Array.isArray(json.results)) continue;

      for (const entry of json.results) {
        if (entry.ok && typeof entry.imageUrl === 'string' && entry.imageUrl.length >= 4) {
          resultMap.set(entry.key, entry.imageUrl);
          const original = slice.find((s) => s.key === entry.key);
          if (original) {
            rememberOptimized(original.imageInput.trim(), {
              ok: true,
              imageUrl: entry.imageUrl,
              originalWidth: entry.originalWidth || 800,
              originalHeight: entry.originalHeight || 800,
              fittedWidth: entry.fittedWidth || 800,
              fittedHeight: entry.fittedHeight || 800,
              boxWidth: entry.boxWidth || 800,
              boxHeight: entry.boxHeight || 800,
              format: entry.format || 'webp',
              sizeKb: entry.sizeKb || 0,
              aspectRatioPreserved: true,
              alreadyOptimized: Boolean(entry.alreadyOptimized),
              viaBackend: true,
            });
          }
        }
      }
    } catch {
      // Keep original URLs for any failed chunk so bulk sync never stalls
    }
  }

  return resultMap;
}

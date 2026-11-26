import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import sharp from 'sharp';

export const DEFAULT_DISPLAY_BOX_SIZE = 800;
export const MIN_DISPLAY_BOX_SIZE = 400;
export const MAX_DISPLAY_BOX_SIZE = 1200;
export const DEFAULT_PADDING_RATIO = 0.04; // 4% clean studio margin on each side
export const MAX_FIRESTORE_IMAGE_DATA_URL_CHARS = 240_000; // Firestore rules cap is 250,000
export const MAX_RAW_INPUT_BYTES = 8 * 1024 * 1024; // 8 MB max raw upload/download
const MAX_INPUT_PIXELS = 40_000_000; // 40 MP decompression-bomb guard
const FETCH_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 2;

const PLACEHOLDER_PATH = '/assets/placeholder-product.svg';
const DATA_IMAGE_REGEX =
  /^data:image\/(jpeg|jpg|png|webp|gif|avif|heic|heif);base64,([A-Za-z0-9+/=\r\n]+)$/i;

export interface ProductImageOptimizeOptions {
  boxSize?: number;
  paddingRatio?: number;
  maxDataUrlChars?: number;
  publicDir?: string;
}

export interface OptimizedProductImageResult {
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
  skipped?: boolean;
  reason?: string;
}

export interface OptimizeImageFailure {
  ok: false;
  reason: string;
  message: string;
}

export type OptimizeImageOutcome = OptimizedProductImageResult | OptimizeImageFailure;

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 & 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a >= 224) return true; // multicast & reserved
  return false;
}

function isPrivateOrReservedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('::ffff:')) {
    const mappedV4 = lower.slice(7);
    if (net.isIPv4(mappedV4)) {
      return isPrivateOrReservedIpv4(mappedV4);
    }
    return true;
  }
  // fc00::/7 (unique local), fe80::/10 (link-local), ff00::/8 (multicast)
  if (
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb') ||
    lower.startsWith('ff')
  ) {
    return true;
  }
  return false;
}

function isBlockedIpAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateOrReservedIpv4(ip);
  if (family === 6) return isPrivateOrReservedIpv6(ip);
  return true;
}

function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!lower) return true;
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower.endsWith('.home.arpa') ||
    lower === 'metadata.google.internal'
  ) {
    return true;
  }
  if (net.isIP(lower)) {
    return isBlockedIpAddress(lower);
  }
  return false;
}

async function assertSafeExternalHttpsUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('INVALID_IMAGE_URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('ONLY_HTTPS_URLS_ALLOWED');
  }
  if (parsed.username || parsed.password) {
    throw new Error('URL_CREDENTIALS_NOT_ALLOWED');
  }
  if (parsed.port && parsed.port !== '443') {
    throw new Error('NON_STANDARD_PORT_BLOCKED');
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new Error('RESTRICTED_HOST_BLOCKED');
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('IMAGE_HOST_UNRESOLVABLE');
  }

  if (!addresses || addresses.length === 0) {
    throw new Error('IMAGE_HOST_UNRESOLVABLE');
  }
  for (const entry of addresses) {
    if (isBlockedIpAddress(entry.address)) {
      throw new Error('RESTRICTED_IP_BLOCKED');
    }
  }

  return parsed;
}

async function fetchExternalImageSafely(rawUrl: string): Promise<Buffer> {
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const validatedUrl = await assertSafeExternalHttpsUrl(currentUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(validatedUrl.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5',
          'User-Agent': 'AlpamartCatalogImageOptimizer/1.0',
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || hop === MAX_REDIRECTS) {
          throw new Error('TOO_MANY_REDIRECTS');
        }
        currentUrl = new URL(location, validatedUrl).toString();
        continue;
      }

      if (!response.ok) {
        throw new Error(`REMOTE_IMAGE_HTTP_${response.status}`);
      }

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (contentType && !contentType.startsWith('image/')) {
        throw new Error('REMOTE_CONTENT_NOT_IMAGE');
      }

      const contentLengthHeader = response.headers.get('content-length');
      if (contentLengthHeader) {
        const declaredSize = Number(contentLengthHeader);
        if (Number.isFinite(declaredSize) && declaredSize > MAX_RAW_INPUT_BYTES) {
          throw new Error('IMAGE_TOO_LARGE');
        }
      }

      if (!response.body) {
        throw new Error('EMPTY_REMOTE_IMAGE');
      }

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > MAX_RAW_INPUT_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new Error('IMAGE_TOO_LARGE');
          }
          chunks.push(value);
        }
      }

      if (totalBytes < 16) {
        throw new Error('EMPTY_REMOTE_IMAGE');
      }

      return Buffer.concat(chunks.map((c) => Buffer.from(c)));
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error('TOO_MANY_REDIRECTS');
}

function clampBoxSize(raw?: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_DISPLAY_BOX_SIZE;
  return Math.max(MIN_DISPLAY_BOX_SIZE, Math.min(MAX_DISPLAY_BOX_SIZE, Math.round(raw)));
}

function clampPaddingRatio(raw?: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_PADDING_RATIO;
  return Math.max(0, Math.min(0.15, raw));
}

function computeFittedDimensions(
  origW: number,
  origH: number,
  innerMax: number
): { fittedWidth: number; fittedHeight: number } {
  const safeW = Math.max(1, origW);
  const safeH = Math.max(1, origH);
  const scale = Math.min(innerMax / safeW, innerMax / safeH);
  return {
    fittedWidth: Math.max(1, Math.min(innerMax, Math.round(safeW * scale))),
    fittedHeight: Math.max(1, Math.min(innerMax, Math.round(safeH * scale))),
  };
}

/**
 * Optimizes a product catalog image on the backend and fits it into a consistent
 * square display box (default 800×800 px with clean studio padding) while
 * strictly preserving the original aspect ratio (zero cropping, zero distortion).
 *
 * Output is guaranteed to comply with Firestore `isValidProductImage` rules
 * (`data:image/webp;base64,...` or `data:image/jpeg;base64,...`, <= 240,000 chars).
 */
export async function optimizeProductImageForDisplayBox(
  rawImageInput: string,
  options: ProductImageOptimizeOptions = {}
): Promise<OptimizeImageOutcome> {
  const trimmed = typeof rawImageInput === 'string' ? rawImageInput.trim() : '';
  const boxSize = clampBoxSize(options.boxSize);
  const paddingRatio = clampPaddingRatio(options.paddingRatio);
  const maxChars = Math.min(
    MAX_FIRESTORE_IMAGE_DATA_URL_CHARS,
    typeof options.maxDataUrlChars === 'number' && options.maxDataUrlChars >= 50_000
      ? Math.round(options.maxDataUrlChars)
      : MAX_FIRESTORE_IMAGE_DATA_URL_CHARS
  );

  // Skip placeholder or empty image safely
  if (!trimmed || trimmed === PLACEHOLDER_PATH || trimmed.endsWith('.svg')) {
    return {
      ok: true,
      imageUrl: trimmed || PLACEHOLDER_PATH,
      originalWidth: boxSize,
      originalHeight: boxSize,
      fittedWidth: boxSize,
      fittedHeight: boxSize,
      boxWidth: boxSize,
      boxHeight: boxSize,
      format: 'placeholder',
      sizeKb: 0,
      aspectRatioPreserved: true,
      alreadyOptimized: true,
      skipped: true,
      reason: 'PLACEHOLDER',
    };
  }

  let inputBuffer: Buffer;
  let sourceKind: 'data_url' | 'https_url' | 'local_asset';
  let dataUrlMime = '';

  if (trimmed.startsWith('data:')) {
    const match = trimmed.match(DATA_IMAGE_REGEX);
    if (!match) {
      return {
        ok: false,
        reason: 'UNSUPPORTED_DATA_IMAGE',
        message: 'Format gambar harus berupa JPG, PNG, WebP, GIF, AVIF, atau HEIC.',
      };
    }
    dataUrlMime = match[1].toLowerCase();
    const base64Body = match[2].replace(/\s+/g, '');
    // Approximate decoded size check before allocating full buffer
    const estimatedBytes = Math.ceil((base64Body.length * 3) / 4);
    if (estimatedBytes > MAX_RAW_INPUT_BYTES) {
      return {
        ok: false,
        reason: 'IMAGE_TOO_LARGE',
        message: 'Ukuran file gambar terlalu besar (maksimal 8 MB).',
      };
    }
    inputBuffer = Buffer.from(base64Body, 'base64');
    sourceKind = 'data_url';
  } else if (trimmed.startsWith('https://')) {
    try {
      inputBuffer = await fetchExternalImageSafely(trimmed);
      sourceKind = 'https_url';
    } catch (err) {
      const code = err instanceof Error ? err.message : 'FETCH_FAILED';
      return {
        ok: false,
        reason: code,
        message: `Tidak dapat mengunduh gambar dari URL eksternal (${code}).`,
      };
    }
  } else if (trimmed.startsWith('/')) {
    // Strictly confine local relative assets to public/
    const publicRoot = path.resolve(options.publicDir || path.resolve(process.cwd(), 'public'));
    const normalizedRel = trimmed.replace(/^\/+/, '');
    const resolvedPath = path.resolve(publicRoot, normalizedRel);
    if (!resolvedPath.startsWith(publicRoot + path.sep)) {
      return {
        ok: false,
        reason: 'INVALID_ASSET_PATH',
        message: 'Path aset gambar lokal tidak valid.',
      };
    }
    try {
      const stat = await fs.stat(resolvedPath);
      if (!stat.isFile() || stat.size > MAX_RAW_INPUT_BYTES) {
        return {
          ok: false,
          reason: 'LOCAL_ASSET_UNAVAILABLE',
          message: 'File aset lokal tidak ditemukan atau terlalu besar.',
        };
      }
      inputBuffer = await fs.readFile(resolvedPath);
      sourceKind = 'local_asset';
    } catch {
      return {
        ok: false,
        reason: 'LOCAL_ASSET_UNAVAILABLE',
        message: 'File aset lokal tidak ditemukan.',
      };
    }
  } else {
    return {
      ok: false,
      reason: 'INVALID_IMAGE_INPUT',
      message: 'Gambar harus berupa file upload atau URL HTTPS yang valid.',
    };
  }

  try {
    // Normalize orientation metadata first (EXIF 5,6,7,8 swap width & height)
    const meta = await sharp(inputBuffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    if (!meta.width || !meta.height) {
      return {
        ok: false,
        reason: 'UNREADABLE_IMAGE',
        message: 'Dimensi gambar tidak dapat dibaca. Gunakan JPG, PNG, atau WebP.',
      };
    }

    const swapsDims = typeof meta.orientation === 'number' && meta.orientation >= 5 && meta.orientation <= 8;
    const origWidth = swapsDims ? meta.height : meta.width;
    const origHeight = swapsDims ? meta.width : meta.height;

    // Smart Idempotency: If caller passed a WebP/JPEG data URL that is ALREADY
    // fitted into the exact consistent square display box and within Firestore's size limit,
    // return verbatim to avoid unnecessary re-compression loss on repeated saves.
    if (
      sourceKind === 'data_url' &&
      (dataUrlMime === 'webp' || dataUrlMime === 'jpeg' || dataUrlMime === 'jpg') &&
      origWidth === boxSize &&
      origHeight === boxSize &&
      trimmed.length <= maxChars
    ) {
      const sizeKb = Math.max(1, Math.round((inputBuffer.byteLength || 1024) / 1024));
      return {
        ok: true,
        imageUrl: trimmed,
        originalWidth: origWidth,
        originalHeight: origHeight,
        fittedWidth: origWidth,
        fittedHeight: origHeight,
        boxWidth: boxSize,
        boxHeight: boxSize,
        format: dataUrlMime === 'webp' ? 'webp' : 'jpeg',
        sizeKb,
        aspectRatioPreserved: true,
        alreadyOptimized: true,
      };
    }

    // Try target boxSize first; step down cleanly only if an extraordinarily complex image exceeds 240 KB
    const candidateBoxSizes = Array.from(
      new Set([boxSize, Math.min(boxSize, 640), Math.min(boxSize, 512)])
    );
    const webpQualities = [84, 76, 68, 58, 48];
    const jpegQualities = [82, 72, 60];

    const whiteBg = { r: 255, g: 255, b: 255, alpha: 1 };

    for (const currentBox of candidateBoxSizes) {
      const innerMax = Math.max(
        64,
        Math.round(currentBox * (1 - paddingRatio * 2))
      );
      const { fittedWidth, fittedHeight } = computeFittedDimensions(
        origWidth,
        origHeight,
        innerMax
      );

      // Step 1: Rotate per EXIF, flatten transparency onto pure white studio canvas,
      // and proportionally fit inside `innerMax × innerMax` (ZERO cropping, ZERO stretching).
      const fittedBuffer = await sharp(inputBuffer, { limitInputPixels: MAX_INPUT_PIXELS })
        .rotate()
        .flatten({ background: '#ffffff' })
        .resize(fittedWidth, fittedHeight, {
          fit: 'inside',
          withoutEnlargement: false,
          kernel: sharp.kernel.lanczos3,
        })
        .toBuffer();

      const fittedMeta = await sharp(fittedBuffer).metadata();
      const actualFittedW = fittedMeta.width || fittedWidth;
      const actualFittedH = fittedMeta.height || fittedHeight;

      // Step 2: Center the proportionally fitted image onto the consistent square display box
      const padLeft = Math.max(0, Math.floor((currentBox - actualFittedW) / 2));
      const padRight = Math.max(0, currentBox - actualFittedW - padLeft);
      const padTop = Math.max(0, Math.floor((currentBox - actualFittedH) / 2));
      const padBottom = Math.max(0, currentBox - actualFittedH - padTop);

      const boxedPipeline = () =>
        sharp(fittedBuffer).extend({
          top: padTop,
          bottom: padBottom,
          left: padLeft,
          right: padRight,
          background: whiteBg,
        });

      // Encode as WebP first (best quality-to-size ratio & supported by firestore.rules)
      for (const quality of webpQualities) {
        const outBuf = await boxedPipeline()
          .webp({ quality, effort: 4, smartSubsample: true })
          .toBuffer();
        const dataUrl = `data:image/webp;base64,${outBuf.toString('base64')}`;
        if (dataUrl.length <= maxChars) {
          return {
            ok: true,
            imageUrl: dataUrl,
            originalWidth: origWidth,
            originalHeight: origHeight,
            fittedWidth: actualFittedW,
            fittedHeight: actualFittedH,
            boxWidth: currentBox,
            boxHeight: currentBox,
            format: 'webp',
            sizeKb: Math.max(1, Math.round(outBuf.byteLength / 1024)),
            aspectRatioPreserved: true,
            alreadyOptimized: false,
          };
        }
      }

      // Fallback to progressive JPEG if needed
      for (const quality of jpegQualities) {
        const outBuf = await boxedPipeline()
          .jpeg({ quality, mozjpeg: true })
          .toBuffer();
        const dataUrl = `data:image/jpeg;base64,${outBuf.toString('base64')}`;
        if (dataUrl.length <= maxChars) {
          return {
            ok: true,
            imageUrl: dataUrl,
            originalWidth: origWidth,
            originalHeight: origHeight,
            fittedWidth: actualFittedW,
            fittedHeight: actualFittedH,
            boxWidth: currentBox,
            boxHeight: currentBox,
            format: 'jpeg',
            sizeKb: Math.max(1, Math.round(outBuf.byteLength / 1024)),
            aspectRatioPreserved: true,
            alreadyOptimized: false,
          };
        }
      }
    }

    return {
      ok: false,
      reason: 'COMPRESSION_BUDGET_EXCEEDED',
      message: 'Gambar terlalu kompleks untuk dikompresi di bawah batas penyimpanan katalog.',
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'IMAGE_PROCESSING_FAILED',
      message:
        err instanceof Error
          ? `Gagal memproses gambar di server: ${err.message}`
          : 'Gagal memproses gambar produk di backend.',
    };
  }
}

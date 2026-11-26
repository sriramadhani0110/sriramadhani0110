import crypto from 'node:crypto';
import {
  PRODUCT_UNITS,
  type JournalPosSignatureFormat,
  type ProductUnit,
} from '../types/marketplace.ts';

function normalizeProductUnit(raw: unknown): ProductUnit {
  const val = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if ((PRODUCT_UNITS as string[]).includes(val)) {
    return val as ProductUnit;
  }
  if (val === 'PC' || val === 'PIECE' || val === 'EA' || val === 'EACH') return 'PCS';
  if (val === 'PK' || val === 'PKT' || val === 'BUNGKUS') return 'PACK';
  if (val === 'BX' || val === 'KOTAK') return 'BOX';
  if (val === 'KILO' || val === 'KILOGRAM') return 'KG';
  if (val === 'L' || val === 'LTR' || val === 'LITRE') return 'LITER';
  if (val === 'BTL' || val === 'BOTTLE') return 'BOTOL';
  if (val === 'CARTON' || val === 'KARTON') return 'CTN';
  if (val === 'GRAM' || val === 'G') return 'GR';
  return 'PCS';
}

export const ALLOWED_JOURNAL_POS_HOST = 'journal.alpa.gdn';
export const DEFAULT_JOURNAL_POS_BASE_URL = 'https://journal.alpa.gdn/web';
export const DEFAULT_EXCHANGE_RATE_KHR = 4000;

export interface MappedJournalPosPublicProduct {
  externalId: string;
  sku: string;
  barcode: string;
  name: string;
  price: number;
  priceKhr: number;
  imageUrl: string;
  stock: number;
  description: string;
  category: string;
  unit: ProductUnit;
  isActive: boolean;
  promoActive: boolean;
  promoPriceUsd: number;
  promoPriceKhr: number;
  promoDiscountPercent: number;
  promoStartDate: string;
  promoEndDate: string;
  promoLabel: string;
  syncSource: 'journal_pos';
  sourceUpdatedAt: string;
}

export interface MappedJournalPosPrivateCost {
  externalId: string;
  sku: string;
  costPriceUsd: number;
  costPriceKhr: number;
  sourceUpdatedAt: string;
}

export interface MappedJournalPosRecord {
  publicProduct: MappedJournalPosPublicProduct;
  privateCostMeta: MappedJournalPosPrivateCost;
  hasExplicitKhrPrice: boolean;
  warnings: string[];
}

export interface JournalPosServerCredentials {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  webhookSecret: string;
  signatureFormat: JournalPosSignatureFormat;
}

function stripAccidentalQuotes(raw?: string): string {
  const trimmed = (raw || '').trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function normalizeAllowedBaseUrl(rawUrl?: string): string {
  let candidate = stripAccidentalQuotes(rawUrl) || DEFAULT_JOURNAL_POS_BASE_URL;
  if (/^journal\.alpa\.gdn(\/|$)/i.test(candidate)) {
    candidate = `https://${candidate}`;
  } else if (/^http:\/\/journal\.alpa\.gdn(\/|$)/i.test(candidate)) {
    candidate = `https://${candidate.slice('http://'.length)}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('URL sumber JOURNAL POS tidak valid.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('URL sumber JOURNAL POS wajib menggunakan protokol HTTPS.');
  }
  if (parsed.hostname.toLowerCase() !== ALLOWED_JOURNAL_POS_HOST) {
    throw new Error(
      `Host tidak diizinkan (${parsed.hostname}). Hanya https://${ALLOWED_JOURNAL_POS_HOST} yang diizinkan.`
    );
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  return `https://${ALLOWED_JOURNAL_POS_HOST}${cleanPath || '/web'}`;
}

export function getJournalPosServerCredentials(
  overrideSignatureFormat?: string
): JournalPosServerCredentials {
  let baseUrl = DEFAULT_JOURNAL_POS_BASE_URL;
  const rawBaseEnv = stripAccidentalQuotes(process.env.JOURNAL_POS_BASE_URL);
  if (rawBaseEnv) {
    try {
      baseUrl = normalizeAllowedBaseUrl(rawBaseEnv);
    } catch {
      // Fall back to official default URL rather than crashing server routes with HTTP 500
      baseUrl = DEFAULT_JOURNAL_POS_BASE_URL;
    }
  }

  const apiKey = stripAccidentalQuotes(process.env.JOURNAL_POS_API_KEY);
  const apiSecret = stripAccidentalQuotes(process.env.JOURNAL_POS_API_SECRET);
  const webhookSecret = stripAccidentalQuotes(process.env.JOURNAL_POS_WEBHOOK_SECRET);
  const envFormat = stripAccidentalQuotes(
    overrideSignatureFormat ||
      process.env.JOURNAL_POS_SIGNATURE_FORMAT ||
      'method_path_timestamp'
  );
  const allowedFormats: JournalPosSignatureFormat[] = [
    'method_path_timestamp',
    'timestamp_method_path',
    'timestamp_path',
    'timestamp_only',
  ];
  const signatureFormat: JournalPosSignatureFormat = allowedFormats.includes(
    envFormat as JournalPosSignatureFormat
  )
    ? (envFormat as JournalPosSignatureFormat)
    : 'method_path_timestamp';

  return {
    baseUrl,
    apiKey,
    apiSecret,
    webhookSecret,
    signatureFormat,
  };
}

export function buildSignedHeaders(params: {
  method: string;
  requestPath: string;
  apiKey: string;
  apiSecret: string;
  signatureFormat: JournalPosSignatureFormat;
  bodyText?: string;
  timestampSeconds?: number;
}): Record<string, string> {
  const ts = String(params.timestampSeconds ?? Math.floor(Date.now() / 1000));
  const methodUpper = params.method.toUpperCase();
  const bodyHash = params.bodyText
    ? crypto.createHash('sha256').update(params.bodyText, 'utf8').digest('hex')
    : '';

  let payloadToSign: string;
  switch (params.signatureFormat) {
    case 'timestamp_method_path':
      payloadToSign = `${ts}\n${methodUpper}\n${params.requestPath}${bodyHash ? `\n${bodyHash}` : ''}`;
      break;
    case 'timestamp_path':
      payloadToSign = `${ts}:${params.requestPath}`;
      break;
    case 'timestamp_only':
      payloadToSign = ts;
      break;
    case 'method_path_timestamp':
    default:
      payloadToSign = `${methodUpper}\n${params.requestPath}\n${ts}${bodyHash ? `\n${bodyHash}` : ''}`;
      break;
  }

  const signature = crypto
    .createHmac('sha256', params.apiSecret)
    .update(payloadToSign, 'utf8')
    .digest('hex');

  return {
    Accept: 'application/json',
    'X-Api-Key': params.apiKey,
    'X-Timestamp': ts,
    'X-Signature': signature,
  };
}

export function verifyWebhookSignature(params: {
  rawBody: string;
  signatureHeader: string;
  timestampHeader: string;
  webhookSecret: string;
}): { valid: boolean; reason?: string } {
  const { rawBody, signatureHeader, timestampHeader, webhookSecret } = params;
  if (!webhookSecret || webhookSecret.length < 8) {
    return { valid: false, reason: 'WEBHOOK_SECRET_NOT_CONFIGURED' };
  }
  const cleanSig = signatureHeader.trim().replace(/^sha256=/i, '');
  if (!cleanSig || !/^[a-fA-F0-9]{64}$/.test(cleanSig)) {
    return { valid: false, reason: 'INVALID_SIGNATURE_FORMAT' };
  }

  if (timestampHeader) {
    const parsedTs = Number(timestampHeader);
    if (!Number.isFinite(parsedTs)) {
      return { valid: false, reason: 'INVALID_TIMESTAMP' };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const tsSec = parsedTs > 10_000_000_000 ? Math.floor(parsedTs / 1000) : Math.floor(parsedTs);
    if (Math.abs(nowSec - tsSec) > 300) {
      return { valid: false, reason: 'TIMESTAMP_OUT_OF_WINDOW' };
    }
  }

  const candidates = [
    timestampHeader ? `${timestampHeader}.${rawBody}` : rawBody,
    timestampHeader ? `${timestampHeader}\n${rawBody}` : rawBody,
    rawBody,
  ];

  const providedBuf = Buffer.from(cleanSig.toLowerCase(), 'utf8');
  for (const candidate of candidates) {
    const expectedHex = crypto
      .createHmac('sha256', webhookSecret)
      .update(candidate, 'utf8')
      .digest('hex');
    const expectedBuf = Buffer.from(expectedHex, 'utf8');
    if (
      providedBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(providedBuf, expectedBuf)
    ) {
      return { valid: true };
    }
  }

  return { valid: false, reason: 'SIGNATURE_MISMATCH' };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchJournalPosWithRetry(params: {
  creds: JournalPosServerCredentials;
  endpointPath: string;
  queryParams?: Record<string, string | number | undefined>;
  maxRetries?: number;
  timeoutMs?: number;
  signPathOverride?: string;
}): Promise<{
  ok: boolean;
  status: number;
  latencyMs: number;
  data: unknown;
  rawText: string;
  errorMessage?: string;
  endpointUrl: string;
}> {
  const {
    creds,
    endpointPath,
    queryParams,
    maxRetries = 3,
    timeoutMs = 12_000,
    signPathOverride,
  } = params;
  const cleanEndpoint = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
  const fullUrl = new URL(`${creds.baseUrl}${cleanEndpoint}`);
  if (fullUrl.hostname.toLowerCase() !== ALLOWED_JOURNAL_POS_HOST || fullUrl.protocol !== 'https:') {
    throw new Error('Request keluar diblokir: hanya https://journal.alpa.gdn yang diizinkan.');
  }

  if (queryParams) {
    for (const [k, v] of Object.entries(queryParams)) {
      if (v !== undefined && v !== '') {
        fullUrl.searchParams.set(k, String(v));
      }
    }
  }

  const requestPathWithQuery = signPathOverride || `${fullUrl.pathname}${fullUrl.search}`;
  const startedAt = Date.now();
  let lastStatus = 0;
  let lastRawText = '';
  let lastError = '';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = buildSignedHeaders({
        method: 'GET',
        requestPath: requestPathWithQuery,
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
        signatureFormat: creds.signatureFormat,
      });

      const res = await fetch(fullUrl.toString(), {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);

      lastStatus = res.status;
      lastRawText = await res.text();
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      const trimmedRaw = lastRawText.trim();
      const looksLikeHtml =
        contentType.includes('text/html') ||
        /^<!doctype\s+html/i.test(trimmedRaw) ||
        /^<html[\s>]/i.test(trimmedRaw);

      let parsed: unknown = null;
      if (!looksLikeHtml && trimmedRaw) {
        try {
          parsed = JSON.parse(trimmedRaw);
        } catch {
          parsed = null;
        }
      }

      if (res.ok && !looksLikeHtml && parsed !== null) {
        return {
          ok: true,
          status: res.status,
          latencyMs: Date.now() - startedAt,
          data: parsed,
          rawText: lastRawText,
          endpointUrl: fullUrl.toString(),
        };
      }

      if (res.ok && looksLikeHtml) {
        return {
          ok: false,
          status: res.status,
          latencyMs: Date.now() - startedAt,
          data: null,
          rawText: lastRawText.slice(0, 300),
          errorMessage:
            'Endpoint JOURNAL POS mengembalikan halaman HTML (halaman login/redirect), bukan JSON API. Periksa JOURNAL_POS_BASE_URL (harus https://journal.alpa.gdn/web) serta API Key & Secret.',
          endpointUrl: fullUrl.toString(),
        };
      }

      const apiErrObj =
        parsed && typeof parsed === 'object'
          ? ((parsed as Record<string, unknown>).error as Record<string, unknown> | undefined)
          : undefined;
      const apiMsg =
        (apiErrObj && typeof apiErrObj.message === 'string' && apiErrObj.message) ||
        (parsed && typeof (parsed as Record<string, unknown>).message === 'string'
          ? String((parsed as Record<string, unknown>).message)
          : `HTTP ${res.status}`);
      lastError = apiMsg;

      // Retry only on 429 or 5xx transient server failures
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        await sleep(attempt * 800);
        continue;
      }

      return {
        ok: false,
        status: res.status,
        latencyMs: Date.now() - startedAt,
        data: parsed,
        rawText: lastRawText,
        errorMessage: apiMsg,
        endpointUrl: fullUrl.toString(),
      };
    } catch (err) {
      clearTimeout(timer);
      lastError = err instanceof Error ? err.message : 'Koneksi ke JOURNAL POS terputus.';
      if (attempt < maxRetries) {
        await sleep(attempt * 800);
        continue;
      }
    }
  }

  return {
    ok: false,
    status: lastStatus,
    latencyMs: Date.now() - startedAt,
    data: null,
    rawText: lastRawText,
    errorMessage: lastError || 'Gagal menghubungi API JOURNAL POS.',
    endpointUrl: fullUrl.toString(),
  };
}

/**
 * Automatically probes all supported HMAC canonical signature formats against
 * https://journal.alpa.gdn/web/api/v1/ping (falling back to /api/v1/products?limit=1)
 * so the integration locks onto the exact signing scheme accepted by JOURNAL POS.
 */
export async function probeJournalPosSignatureFormat(
  creds: JournalPosServerCredentials
): Promise<{
  ok: boolean;
  detectedSignatureFormat: JournalPosSignatureFormat;
  status: number;
  latencyMs: number;
  endpointUrl: string;
  errorMessage?: string;
}> {
  const allFormats: JournalPosSignatureFormat[] = [
    creds.signatureFormat,
    ...(
      [
        'method_path_timestamp',
        'timestamp_method_path',
        'timestamp_path',
        'timestamp_only',
      ] as JournalPosSignatureFormat[]
    ).filter((f) => f !== creds.signatureFormat),
  ];

  let lastResult = {
    ok: false,
    status: 0,
    latencyMs: 0,
    endpointUrl: `${creds.baseUrl}/api/v1/ping`,
    errorMessage: 'Koneksi gagal.',
  };

  for (const format of allFormats) {
    const candidateCreds: JournalPosServerCredentials = {
      ...creds,
      signatureFormat: format,
    };

    let res = await fetchJournalPosWithRetry({
      creds: candidateCreds,
      endpointPath: '/api/v1/ping',
      maxRetries: 1,
      timeoutMs: 8_000,
    });

    if (!res.ok && res.status === 404) {
      res = await fetchJournalPosWithRetry({
        creds: candidateCreds,
        endpointPath: '/api/v1/products',
        queryParams: { limit: 1, per_page: 1 },
        maxRetries: 1,
        timeoutMs: 8_000,
      });
    }

    lastResult = {
      ok: res.ok,
      status: res.status,
      latencyMs: res.latencyMs,
      endpointUrl: res.endpointUrl,
      errorMessage: res.errorMessage || 'Koneksi gagal.',
    };

    if (res.ok) {
      return {
        ok: true,
        detectedSignatureFormat: format,
        status: res.status,
        latencyMs: res.latencyMs,
        endpointUrl: res.endpointUrl,
      };
    }

    // Only continue probing other signature formats on 401/403 authentication errors
    if (res.status !== 401 && res.status !== 403) {
      break;
    }
  }

  return {
    ok: false,
    detectedSignatureFormat: creds.signatureFormat,
    status: lastResult.status,
    latencyMs: lastResult.latencyMs,
    endpointUrl: lastResult.endpointUrl,
    errorMessage: lastResult.errorMessage,
  };
}

/**
 * Parses CSV / semicolon-CSV / TSV text exported from JOURNAL POS web dashboard
 * into an array of raw product objects compatible with mapJournalPosRawProduct.
 */
export function parseJournalPosTabularText(rawText: string): Record<string, unknown>[] {
  const cleaned = rawText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!cleaned) return [];

  const firstLine = cleaned.split('\n')[0] || '';
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const semiCount = (firstLine.match(/;/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;
  const delimiter =
    tabCount >= semiCount && tabCount >= commaCount && tabCount > 0
      ? '\t'
      : semiCount > commaCount
        ? ';'
        : ',';

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    const next = cleaned[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        currentField += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        currentField += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      currentRow.push(currentField.trim());
      currentField = '';
    } else if (ch === '\n') {
      currentRow.push(currentField.trim());
      if (currentRow.some((cell) => cell.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentField = '';
    } else {
      currentField += ch;
    }
  }
  currentRow.push(currentField.trim());
  if (currentRow.some((cell) => cell.length > 0)) {
    rows.push(currentRow);
  }

  if (rows.length < 2) return [];

  const headers = rows[0].map((h) =>
    h
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
  );

  const items: Record<string, unknown>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const obj: Record<string, unknown> = {};
    let hasAnyValue = false;
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      if (!key) continue;
      const val = (cells[c] ?? '').trim();
      if (val !== '') {
        obj[key] = val;
        hasAnyValue = true;
      }
    }
    if (hasAnyValue) {
      items.push(obj);
    }
  }
  return items;
}

function pickFirst(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
      return obj[key];
    }
  }
  return undefined;
}

function parseNumberSafe(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^0-9.,-]/g, '').replace(/,/g, '');
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function parseBooleanSafe(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'active', 'aktif', 'enabled', 'on', 'ya'].includes(v)) {
      return true;
    }
    if (['0', 'false', 'no', 'inactive', 'tidak aktif', 'nonaktif', 'disabled', 'off'].includes(v)) {
      return false;
    }
  }
  return fallback;
}

function sanitizeImageUrl(rawUrl: unknown, baseUrl: string): string {
  const fallbackImg = '/assets/placeholder-product.svg';
  if (typeof rawUrl !== 'string') return fallbackImg;
  const trimmed = rawUrl.trim();
  if (!trimmed) return fallbackImg;

  if (trimmed.startsWith('https://')) {
    return trimmed.slice(0, 1000);
  }
  if (trimmed.startsWith('http://journal.alpa.gdn/')) {
    return `https://${trimmed.slice('http://'.length)}`.slice(0, 1000);
  }
  if (trimmed.startsWith('/')) {
    // Resolve relative path from JOURNAL POS host cleanly
    try {
      const origin = new URL(baseUrl).origin;
      return `${origin}${trimmed}`.slice(0, 1000);
    } catch {
      return trimmed.slice(0, 1000);
    }
  }
  if (/^[a-zA-Z0-9._/-]+\.(?:jpg|jpeg|png|webp|gif)(?:\?.*)?$/i.test(trimmed)) {
    return `${baseUrl.replace(/\/+$/, '')}/${trimmed.replace(/^\/+/, '')}`.slice(0, 1000);
  }
  return fallbackImg;
}

function cleanText(value: unknown, maxLen: number): string {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, maxLen);
}

/**
 * Extracts array of raw product objects from common REST API response envelopes:
 * - { data: [...] }
 * - { data: { items: [...] } }
 * - { products: [...] }
 * - { items: [...] }
 * - [ ... ]
 */
export function extractRawProductsList(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === 'object' && !Array.isArray(item))
    );
  }
  if (!payload || typeof payload !== 'object') return [];
  const root = payload as Record<string, unknown>;

  const directKeys = ['products', 'items', 'records', 'rows', 'results', 'data'];
  for (const key of directKeys) {
    const val = root[key];
    if (Array.isArray(val)) {
      return val.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === 'object' && !Array.isArray(item))
      );
    }
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const nested = val as Record<string, unknown>;
      for (const nestedKey of ['items', 'products', 'records', 'rows', 'data']) {
        if (Array.isArray(nested[nestedKey])) {
          return (nested[nestedKey] as unknown[]).filter(
            (item): item is Record<string, unknown> =>
              Boolean(item && typeof item === 'object' && !Array.isArray(item))
          );
        }
      }
    }
  }

  // Single product webhook payload
  if (
    root.product &&
    typeof root.product === 'object' &&
    !Array.isArray(root.product)
  ) {
    return [root.product as Record<string, unknown>];
  }
  if (
    'sku' in root ||
    'product_id' in root ||
    'item_name' in root ||
    'name' in root ||
    'nama_produk' in root
  ) {
    return [root];
  }

  return [];
}

/**
 * Maps all 18 required JOURNAL POS columns into strictly separated public storefront data
 * and Admin-only private cost data.
 */
export function mapJournalPosRawProduct(
  raw: Record<string, unknown>,
  baseUrl: string = DEFAULT_JOURNAL_POS_BASE_URL,
  exchangeRateKhr: number = DEFAULT_EXCHANGE_RATE_KHR
): { ok: true; record: MappedJournalPosRecord } | { ok: false; error: string } {
  const warnings: string[] = [];

  // 1. ID Produk
  const externalId = cleanText(
    pickFirst(raw, ['id', 'product_id', 'item_id', 'external_id', 'externalId', 'id_produk']),
    120
  );

  // 2. SKU / Kode Produk
  let sku = cleanText(
    pickFirst(raw, ['sku', 'code', 'item_code', 'product_code', 'kode_produk', 'kode']),
    64
  );

  // 3. Barcode
  const barcode = cleanText(
    pickFirst(raw, ['barcode', 'ean', 'upc', 'barcode_number', 'kode_barcode']),
    80
  );

  if (!sku && externalId) {
    sku = `JPOS-${externalId}`.slice(0, 64);
    warnings.push('SKU kosong, dibuat otomatis dari ID Produk.');
  } else if (!sku && barcode) {
    sku = barcode.slice(0, 64);
  }

  // 4. Nama Item / Nama Produk
  const name = cleanText(
    pickFirst(raw, ['name', 'item_name', 'product_name', 'title', 'nama_produk', 'nama_item']),
    160
  );

  if (!name) {
    return {
      ok: false,
      error: `Produk (ID: ${externalId || '-'}, SKU: ${sku || '-'}) tidak memiliki nama item.`,
    };
  }
  if (!externalId && !sku) {
    return {
      ok: false,
      error: `Produk "${name}" wajib memiliki minimal ID Produk atau SKU untuk pencocokan.`,
    };
  }

  const effectiveRate = exchangeRateKhr > 0 ? exchangeRateKhr : DEFAULT_EXCHANGE_RATE_KHR;

  // 5. Harga Jual USD & 6. Harga Jual KHR
  let priceUsd = parseNumberSafe(
    pickFirst(raw, [
      'price_usd',
      'selling_price_usd',
      'sell_price_usd',
      'harga_jual_usd',
      'priceUsd',
      'price',
      'selling_price',
      'sell_price',
      'unit_price',
      'retail_price',
      'regular_price',
      'sale_price',
      'harga_jual',
      'harga_satuan',
      'harga',
    ]),
    0
  );

  const rawPriceKhr = parseNumberSafe(
    pickFirst(raw, [
      'price_khr',
      'selling_price_khr',
      'sell_price_khr',
      'harga_jual_khr',
      'harga_khr',
      'price_riel',
      'riel_price',
      'priceKhr',
    ]),
    0
  );
  let priceKhr = rawPriceKhr;
  const hasExplicitKhrPrice = rawPriceKhr > 0;

  if (priceUsd <= 0 && priceKhr > 0) {
    priceUsd = Math.max(0.01, Math.round((priceKhr / effectiveRate) * 100) / 100);
  }
  if (priceKhr <= 0 && priceUsd > 0) {
    priceKhr = Math.round((priceUsd * effectiveRate) / 100) * 100;
  }
  if (priceUsd < 0.01) {
    return {
      ok: false,
      error: `Produk "${name}" (SKU: ${sku}) memiliki harga jual <= 0.`,
    };
  }
  priceUsd = Math.round(priceUsd * 100) / 100;

  // 7. Harga Modal / Harga Beli (Admin-Only -> strictly placed in privateCostMeta!)
  let costPriceUsd = parseNumberSafe(
    pickFirst(raw, [
      'cost_price_usd',
      'buy_price_usd',
      'purchase_price_usd',
      'cost_price',
      'buy_price',
      'cost',
      'harga_modal_usd',
      'harga_beli_usd',
      'harga_modal',
      'harga_beli',
    ]),
    0
  );
  let costPriceKhr = parseNumberSafe(
    pickFirst(raw, [
      'cost_price_khr',
      'buy_price_khr',
      'purchase_price_khr',
      'harga_modal_khr',
      'harga_beli_khr',
    ]),
    0
  );
  if (costPriceUsd <= 0 && costPriceKhr > 0) {
    costPriceUsd = Math.round((costPriceKhr / effectiveRate) * 100) / 100;
  }
  if (costPriceKhr <= 0 && costPriceUsd > 0) {
    costPriceKhr = Math.round((costPriceUsd * effectiveRate) / 100) * 100;
  }
  costPriceUsd = Math.max(0, Math.round(costPriceUsd * 100) / 100);
  costPriceKhr = Math.max(0, Math.round(costPriceKhr));

  // 8. Link URL Gambar Produk & 9. Foto Produk
  const rawImage = pickFirst(raw, [
    'image_url',
    'imageUrl',
    'photo_url',
    'photoUrl',
    'photo',
    'image',
    'thumbnail',
    'foto_produk',
    'gambar',
    'link_gambar',
  ]);
  const imageUrl = sanitizeImageUrl(rawImage, baseUrl);
  if (imageUrl === '/assets/placeholder-product.svg') {
    warnings.push('Foto produk tidak ditemukan, menggunakan gambar default.');
  }

  // 10. Jumlah Stok
  const rawStock = parseNumberSafe(
    pickFirst(raw, [
      'stock',
      'qty',
      'quantity',
      'stock_qty',
      'qty_on_hand',
      'on_hand',
      'available_stock',
      'jumlah_stok',
      'stok',
      'inventory',
    ]),
    0
  );
  const stock = Math.max(0, Math.min(1_000_000, Math.floor(rawStock)));

  // 11. Deskripsi Produk
  let description = cleanText(
    pickFirst(raw, ['description', 'desc', 'product_description', 'deskripsi', 'deskripsi_produk', 'notes']),
    1500
  );
  if (description.length < 2) {
    description = `${name} — Produk resmi dari katalog JOURNAL POS.`;
  }

  // 12. Kategori Produk
  const rawCategoryObj = raw.category;
  const categoryNameRaw =
    rawCategoryObj && typeof rawCategoryObj === 'object' && !Array.isArray(rawCategoryObj)
      ? pickFirst(rawCategoryObj as Record<string, unknown>, ['name', 'title', 'nama'])
      : pickFirst(raw, ['category_name', 'category', 'kategori', 'kategori_produk']);
  let category = cleanText(categoryNameRaw, 60);
  if (category.length < 2) {
    category = 'Umum';
  }

  // 13. Satuan Produk (PCS, BOX, PACK, KG, LITER, dll.)
  const rawUnitObj = raw.unit;
  const unitRaw =
    rawUnitObj && typeof rawUnitObj === 'object' && !Array.isArray(rawUnitObj)
      ? pickFirst(rawUnitObj as Record<string, unknown>, ['code', 'name', 'symbol'])
      : pickFirst(raw, ['unit', 'uom', 'unit_name', 'satuan', 'satuan_produk']);
  const unit = normalizeProductUnit(unitRaw);

  // 14. Status Produk (Aktif / Tidak Aktif)
  const rawActive = pickFirst(raw, ['is_active', 'isActive', 'active', 'status', 'status_produk']);
  const isActive = parseBooleanSafe(rawActive, true);

  // 15. Status Promosi, 16. Harga Promosi, 17. Periode Promosi
  const promoObj =
    raw.promotion && typeof raw.promotion === 'object' && !Array.isArray(raw.promotion)
      ? (raw.promotion as Record<string, unknown>)
      : null;

  let promoPriceUsd = parseNumberSafe(
    pickFirst(raw, [
      'promo_price_usd',
      'promoPriceUsd',
      'promo_price',
      'discount_price_usd',
      'discount_price',
      'harga_promosi_usd',
      'harga_promosi',
    ]) ?? (promoObj ? pickFirst(promoObj, ['price_usd', 'promo_price_usd', 'promo_price', 'price']) : undefined),
    0
  );
  let promoPriceKhr = parseNumberSafe(
    pickFirst(raw, [
      'promo_price_khr',
      'promoPriceKhr',
      'discount_price_khr',
      'harga_promosi_khr',
    ]) ?? (promoObj ? pickFirst(promoObj, ['price_khr', 'promo_price_khr']) : undefined),
    0
  );
  let promoDiscountPercent = parseNumberSafe(
    pickFirst(raw, [
      'promo_discount_percent',
      'discount_percent',
      'discount',
      'diskon_persen',
    ]) ?? (promoObj ? pickFirst(promoObj, ['discount_percent', 'discount']) : undefined),
    0
  );

  if (promoPriceUsd <= 0 && promoPriceKhr > 0) {
    promoPriceUsd = Math.round((promoPriceKhr / effectiveRate) * 100) / 100;
  }
  if (promoPriceUsd <= 0 && promoDiscountPercent > 0 && promoDiscountPercent < 100) {
    promoPriceUsd = Math.max(
      0.01,
      Math.round(priceUsd * (1 - promoDiscountPercent / 100) * 100) / 100
    );
  }
  if (promoPriceUsd > 0 && promoPriceUsd < priceUsd) {
    promoPriceUsd = Math.round(promoPriceUsd * 100) / 100;
    if (promoPriceKhr <= 0) {
      promoPriceKhr = Math.round((promoPriceUsd * effectiveRate) / 100) * 100;
    }
    if (promoDiscountPercent <= 0) {
      promoDiscountPercent = Math.min(
        99,
        Math.max(1, Math.round(((priceUsd - promoPriceUsd) / priceUsd) * 100))
      );
    }
  } else {
    promoPriceUsd = 0;
    promoPriceKhr = 0;
  }

  const rawPromoActive =
    pickFirst(raw, ['promo_active', 'promoActive', 'is_promo', 'isPromo', 'status_promosi']) ??
    (promoObj ? pickFirst(promoObj, ['is_active', 'active', 'status']) : undefined);
  const promoActive =
    rawPromoActive !== undefined
      ? parseBooleanSafe(rawPromoActive, false) && promoPriceUsd > 0 && promoPriceUsd < priceUsd
      : promoPriceUsd > 0 && promoPriceUsd < priceUsd;

  const promoStartDate = cleanText(
    pickFirst(raw, ['promo_start_date', 'promoStartDate', 'promo_start', 'periode_mulai']) ??
      (promoObj ? pickFirst(promoObj, ['start_date', 'starts_at', 'start']) : undefined),
    40
  );
  const promoEndDate = cleanText(
    pickFirst(raw, ['promo_end_date', 'promoEndDate', 'promo_end', 'periode_selesai']) ??
      (promoObj ? pickFirst(promoObj, ['end_date', 'ends_at', 'end']) : undefined),
    40
  );
  const promoLabel = cleanText(
    pickFirst(raw, ['promo_label', 'promoLabel', 'promo_title', 'label_promosi']) ??
      (promoObj ? pickFirst(promoObj, ['label', 'title', 'name']) : undefined),
    60
  ) || (promoActive ? (promoDiscountPercent > 0 ? `DISCOUNT ${promoDiscountPercent}%` : 'PROMOTION') : '');

  // 18. Tanggal Update Produk
  const sourceUpdatedAt =
    cleanText(
      pickFirst(raw, [
        'updated_at',
        'updatedAt',
        'modified_at',
        'last_updated',
        'tanggal_update',
        'tanggal_update_produk',
      ]),
      64
    ) || new Date().toISOString();

  return {
    ok: true,
    record: {
      publicProduct: {
        externalId: externalId || sku,
        sku,
        barcode,
        name,
        price: priceUsd,
        priceKhr: Math.round(priceKhr),
        imageUrl,
        stock,
        description,
        category,
        unit,
        isActive,
        promoActive,
        promoPriceUsd,
        promoPriceKhr: Math.round(promoPriceKhr),
        promoDiscountPercent: Math.min(99, Math.max(0, Math.round(promoDiscountPercent))),
        promoStartDate,
        promoEndDate,
        promoLabel,
        syncSource: 'journal_pos',
        sourceUpdatedAt,
      },
      privateCostMeta: {
        externalId: externalId || sku,
        sku,
        costPriceUsd,
        costPriceKhr,
        sourceUpdatedAt,
      },
      hasExplicitKhrPrice,
      warnings,
    },
  };
}

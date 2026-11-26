/**
 * Automatic Bulk Marketplace Database Importer (CSV / Excel-CSV / TSV / JSON)
 * Supports exports from Shopee, Tokopedia, Lazada, TikTok Shop, WooCommerce, Shopify,
 * Excel spreadsheets, and generic POS databases — merges automatically into Firestore
 * without duplicating existing items and replacing stock/price directly from the imported file.
 */

import { doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { db } from './firebase';
import { normalizeProductUnit, USD_TO_KHR_RATE } from './catalogSeed';
import { optimizeProductImagesBatchOnBackend } from './productImageOptimizerClient';
import { FIELD_LIMITS, type Product, type ProductUnit, type StoreCategory } from '../types/marketplace';

export const PLACEHOLDER_PRODUCT_IMAGE_URL = '/assets/placeholder-product.svg';

export type ImportSourceCurrency = 'USD' | 'IDR' | 'KHR' | 'THB' | 'MYR';

export type DuplicateImportStrategy = 'price_stock_only' | 'update' | 'skip';

export interface ParsedExternalProduct {
  rowIndex: number;
  name: string;
  sku: string;
  barcode: string;
  category: string;
  description: string;
  rawPrice: number;
  priceUsd: number;
  hasPriceValue: boolean;
  stock: number;
  hasStockValue: boolean;
  unit: ProductUnit;
  imageUrl: string;
  needsImage: boolean;
  preservedExistingPhoto?: boolean;
  isActive: boolean;
  existingMatchId: string | null;
  existingPriceUsd?: number;
  existingStock?: number;
  action: 'insert' | 'update';
}

export interface ParseMarketplaceDatabaseResult {
  items: ParsedExternalProduct[];
  skippedRows: string[];
  duplicateRowsInFileCount: number;
  detectedFormat: 'json' | 'csv' | 'tsv';
  detectedColumns: string[];
  preservedPhotoCount: number;
  detectedAlpamartExport: boolean;
}

export interface BulkMergeResult {
  insertedCount: number;
  updatedCount: number;
  skippedCount: number;
  createdCategories: string[];
  needsImageCount: number;
  preservedPhotoCount: number;
}

export const DEFAULT_CURRENCY_TO_USD_RATES: Record<ImportSourceCurrency, number> = {
  USD: 1,
  IDR: 16000,
  KHR: 4000,
  THB: 35,
  MYR: 4.5,
};

function normalizeHeader(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeNameKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeCodeKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

function hasRawCellValue(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  if (typeof raw === 'number') return Number.isFinite(raw);
  return String(raw).trim() !== '';
}

function parseNumericValue(raw: unknown): number {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : 0;
  }
  if (typeof raw !== 'string') return 0;
  let cleaned = raw
    .replace(/rp\.?|usd|khr|thb|rm|idr|\$|฿/gi, '')
    .replace(/\s+/g, '')
    .trim();
  if (!cleaned) return 0;

  // Handle thousand separators like "15.000" or "15,000" vs decimal "1.50" or "1,50"
  const dotCount = (cleaned.match(/\./g) || []).length;
  const commaCount = (cleaned.match(/,/g) || []).length;

  if (dotCount > 1 && commaCount === 0) {
    cleaned = cleaned.replace(/\./g, '');
  } else if (commaCount > 1 && dotCount === 0) {
    cleaned = cleaned.replace(/,/g, '');
  } else if (dotCount === 1 && commaCount === 1) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (dotCount === 1 && commaCount === 0) {
    const afterDot = cleaned.split('.')[1] || '';
    if (afterDot.length === 3 && cleaned.split('.')[0].length >= 1) {
      // Likely Indonesian thousand separator e.g. 15.000
      cleaned = cleaned.replace('.', '');
    }
  } else if (commaCount === 1 && dotCount === 0) {
    const afterComma = cleaned.split(',')[1] || '';
    if (afterComma.length === 3) {
      cleaned = cleaned.replace(',', '');
    } else {
      cleaned = cleaned.replace(',', '.');
    }
  }

  cleaned = cleaned.replace(/[^0-9.-]/g, '');
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseActiveStatus(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  const str = String(raw ?? '').trim().toLowerCase();
  if (!str) return true;
  if (
    ['false', '0', 'nonaktif', 'tidak aktif', 'inactive', 'draft', 'archived', 'arsip', 'off', 'no', 'habis'].includes(
      str
    )
  ) {
    return false;
  }
  return true;
}

function sanitizeImageUrl(raw: unknown): { url: string; needsImage: boolean } {
  const str = typeof raw === 'string' ? raw.trim() : '';
  if (!str) {
    return { url: PLACEHOLDER_PRODUCT_IMAGE_URL, needsImage: true };
  }
  // Support embedded base64 photos exported from a friend's ALPAMART database backup JSON
  if (
    /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(str) &&
    str.length >= 30 &&
    str.length <= 245000
  ) {
    return { url: str, needsImage: false };
  }
  // If multiple comma/pipe separated image URLs (common in Shopee/Tokopedia exports), pick first valid https URL
  const firstCandidate = str.split(/[\n,|;]+/)[0]?.trim() || '';
  if (
    firstCandidate.length >= 10 &&
    firstCandidate.length <= 1000 &&
    /^https:\/\/[^\s]+$/i.test(firstCandidate)
  ) {
    return { url: firstCandidate, needsImage: false };
  }
  if (
    firstCandidate.length >= 4 &&
    firstCandidate.length <= 1000 &&
    firstCandidate.startsWith('/') &&
    !firstCandidate.startsWith('//')
  ) {
    return {
      url: firstCandidate,
      needsImage: firstCandidate === PLACEHOLDER_PRODUCT_IMAGE_URL,
    };
  }
  return { url: PLACEHOLDER_PRODUCT_IMAGE_URL, needsImage: true };
}

function detectCsvDelimiter(text: string): ',' | ';' | '\t' {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) || '';
  let commas = 0;
  let semis = 0;
  let tabs = 0;
  let inQuotes = false;
  for (let i = 0; i < firstLine.length; i++) {
    const ch = firstLine[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes) {
      if (ch === ',') commas++;
      else if (ch === ';') semis++;
      else if (ch === '\t') tabs++;
    }
  }
  if (tabs >= commas && tabs >= semis && tabs > 0) return '\t';
  if (semis > commas) return ';';
  return ',';
}

function parseDelimitedRows(text: string, delimiter: ',' | ';' | '\t'): string[][] {
  const cleaned = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    const next = cleaned[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        row.push(cell.trim());
        cell = '';
      } else if (ch === '\r' && next === '\n') {
        row.push(cell.trim());
        rows.push(row);
        row = [];
        cell = '';
        i++;
      } else if (ch === '\n' || ch === '\r') {
        row.push(cell.trim());
        rows.push(row);
        row = [];
        cell = '';
      } else {
        cell += ch;
      }
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

function pickField(record: Record<string, unknown>, aliases: string[]): unknown {
  const entries = Object.entries(record);
  // 1. Exact normalized match
  for (const alias of aliases) {
    for (const [k, v] of entries) {
      if (normalizeHeader(k) === alias && v !== undefined && v !== null && String(v).trim() !== '') {
        return v;
      }
    }
  }
  // 2. Partial includes match
  for (const alias of aliases) {
    if (alias.length < 3) continue;
    for (const [k, v] of entries) {
      const nk = normalizeHeader(k);
      if (nk.includes(alias) && v !== undefined && v !== null && String(v).trim() !== '') {
        return v;
      }
    }
  }
  return '';
}

function generateAutoSku(name: string, index: number): string {
  const prefix = name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 5) || 'IMP';
  return `IMP-${prefix}-${String(index + 1).padStart(3, '0')}`;
}

export function isProductNeedingImage(imageUrl: string | undefined | null): boolean {
  const trimmed = (imageUrl || '').trim();
  if (!trimmed) return true;
  return (
    trimmed === PLACEHOLDER_PRODUCT_IMAGE_URL ||
    trimmed.includes('placeholder-product')
  );
}

/**
 * Parses CSV, TSV, or JSON product database files from other marketplaces.
 * Strictly deduplicates both against existing catalog products AND duplicate rows inside the same file.
 */
export function parseExternalMarketplaceDatabase(params: {
  rawText: string;
  existingProducts: Product[];
  sourceCurrency: ImportSourceCurrency;
  conversionRateToUsd: number;
  defaultCategory?: string;
  preserveExistingPhotos?: boolean;
}): ParseMarketplaceDatabaseResult {
  const {
    rawText,
    existingProducts,
    sourceCurrency,
    conversionRateToUsd,
    preserveExistingPhotos = true,
  } = params;
  const defaultCategory = (params.defaultCategory || 'Kebutuhan Harian').trim() || 'Kebutuhan Harian';
  const safeRate =
    sourceCurrency === 'USD'
      ? 1
      : Number.isFinite(conversionRateToUsd) && conversionRateToUsd > 0
        ? conversionRateToUsd
        : DEFAULT_CURRENCY_TO_USD_RATES[sourceCurrency];

  const trimmed = rawText.replace(/^\uFEFF/, '').trim();
  let rawRecords: Record<string, unknown>[] = [];
  let detectedFormat: 'json' | 'csv' | 'tsv' = 'csv';
  let detectedColumns: string[] = [];
  let detectedAlpamartExport = false;

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    detectedFormat = 'json';
    const parsed = JSON.parse(trimmed) as unknown;
    let arr: unknown[] = [];
    if (Array.isArray(parsed)) {
      arr = parsed;
    } else if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const fromBackupCollections =
        obj.collections && typeof obj.collections === 'object'
          ? (obj.collections as Record<string, unknown>).products
          : null;
      if (Array.isArray(fromBackupCollections)) {
        detectedAlpamartExport = true;
      }
      const nested =
        fromBackupCollections ||
        obj.products ||
        obj.items ||
        obj.data ||
        obj.rows ||
        obj.catalog;
      if (Array.isArray(nested)) {
        arr = nested;
      }
    }
    rawRecords = arr.filter(
      (x): x is Record<string, unknown> => Boolean(x && typeof x === 'object' && !Array.isArray(x))
    );
    if (rawRecords.length > 0) {
      detectedColumns = Object.keys(rawRecords[0]);
      if (
        !detectedAlpamartExport &&
        rawRecords.some(
          (r) =>
            'priceKhr' in r ||
            ('imageUrl' in r && 'sku' in r && 'isActive' in r && 'price' in r)
        )
      ) {
        detectedAlpamartExport = true;
      }
    }
  } else {
    const delimiter = detectCsvDelimiter(trimmed);
    detectedFormat = delimiter === '\t' ? 'tsv' : 'csv';
    const matrix = parseDelimitedRows(trimmed, delimiter);
    if (matrix.length >= 2) {
      // Shopee/Tokopedia exports sometimes have 1-2 info rows before real header; detect header row
      let headerIdx = 0;
      for (let i = 0; i < Math.min(5, matrix.length - 1); i++) {
        const joined = matrix[i].map(normalizeHeader).join(' ');
        if (
          joined.includes('nama') ||
          joined.includes('name') ||
          joined.includes('title') ||
          joined.includes('sku') ||
          joined.includes('harga') ||
          joined.includes('price')
        ) {
          headerIdx = i;
          break;
        }
      }
      const headers = matrix[headerIdx].map((h, idx) => h.trim() || `col_${idx + 1}`);
      detectedColumns = headers;
      for (let r = headerIdx + 1; r < matrix.length; r++) {
        const row = matrix[r];
        const obj: Record<string, unknown> = {};
        for (let c = 0; c < headers.length; c++) {
          obj[headers[c]] = row[c] ?? '';
        }
        rawRecords.push(obj);
      }
    }
  }

  // Index existing products for strict duplicate-safe matching (ID -> ExternalID -> SKU -> Barcode -> Normalized Name)
  const existingById = new Map<string, Product>();
  const existingByExternalId = new Map<string, Product>();
  const existingBySku = new Map<string, Product>();
  const existingByBarcode = new Map<string, Product>();
  const existingByName = new Map<string, Product>();
  for (const p of existingProducts) {
    if (p.id) existingById.set(p.id.trim(), p);
    if (p.externalId) existingByExternalId.set(normalizeCodeKey(p.externalId), p);
    if (p.sku) existingBySku.set(normalizeCodeKey(p.sku), p);
    if (p.barcode) existingByBarcode.set(normalizeCodeKey(p.barcode), p);
    if (p.name) existingByName.set(normalizeNameKey(p.name), p);
  }

  const items: ParsedExternalProduct[] = [];
  const skippedRows: string[] = [];
  let duplicateRowsInFileCount = 0;

  // Intra-file deduplication maps -> index into `items`
  const batchIndexByExistingId = new Map<string, number>();
  const batchIndexBySku = new Map<string, number>();
  const batchIndexByBarcode = new Map<string, number>();
  const batchIndexByName = new Map<string, number>();

  for (let i = 0; i < rawRecords.length; i++) {
    const rec = rawRecords[i];
    const nameRaw = String(
      pickField(rec, [
        'nama produk',
        'nama item',
        'product name',
        'item name',
        'ps product name',
        'et name',
        'nama',
        'name',
        'title',
        'produk',
      ]) || ''
    ).trim();

    if (!nameRaw || nameRaw.length < 1) {
      skippedRows.push(`Baris #${i + 1}: Nama produk kosong.`);
      continue;
    }

    const name = nameRaw.slice(0, FIELD_LIMITS.PRODUCT_NAME_MAX);
    const rawSku = String(
      pickField(rec, [
        'sku',
        'sku induk',
        'parent sku',
        'kode produk',
        'kode item',
        'item code',
        'product code',
        'variant sku',
        'kode',
        'code',
      ]) || ''
    ).trim();

    const barcode = String(
      pickField(rec, ['barcode', 'ean', 'upc', 'gtin', 'kode batang']) || ''
    )
      .trim()
      .slice(0, 80);

    const rawId = String(pickField(rec, ['id', 'productid', 'product id']) || '').trim();
    const rawExternalId = String(pickField(rec, ['externalid', 'external id']) || '').trim();

    const candidateSku = (rawSku || generateAutoSku(name, i)).slice(0, FIELD_LIMITS.SKU_MAX);

    const matchById = rawId ? existingById.get(rawId) : undefined;
    const matchByExternalId = rawExternalId
      ? existingByExternalId.get(normalizeCodeKey(rawExternalId))
      : undefined;
    const matchBySku = rawSku ? existingBySku.get(normalizeCodeKey(rawSku)) : undefined;
    const matchByBarcode = barcode ? existingByBarcode.get(normalizeCodeKey(barcode)) : undefined;
    const matchByName = existingByName.get(normalizeNameKey(name));
    const matched =
      matchById || matchByExternalId || matchBySku || matchByBarcode || matchByName || null;

    const rawCategory = String(
      pickField(rec, [
        'kategori',
        'kategori produk',
        'category',
        'etalase',
        'nama etalase',
        'department',
        'jenis',
        'group',
      ]) || ''
    ).trim();
    const category = (rawCategory.length >= 2 ? rawCategory : matched?.category || defaultCategory).slice(
      0,
      FIELD_LIMITS.CATEGORY_NAME_MAX
    );

    const rawPriceVal = pickField(rec, [
      'harga jual usd',
      'price usd',
      'harga jual',
      'harga rp',
      'harga',
      'price',
      'selling price',
      'regular price',
      'harga normal',
      'harga satuan',
      'ps price',
    ]);
    const hasPriceCell = hasRawCellValue(rawPriceVal);
    const rawPrice = parseNumericValue(rawPriceVal);
    let priceUsd = sourceCurrency === 'USD' ? rawPrice : rawPrice / safeRate;
    const hasValidPriceValue = hasPriceCell && Number.isFinite(priceUsd) && priceUsd >= 0.01;
    if (!hasValidPriceValue) {
      priceUsd = matched ? matched.price : 1.0;
    }
    priceUsd = Math.min(100_000_000, Math.max(0.01, Number(priceUsd.toFixed(2))));

    const rawStockVal = pickField(rec, [
      'stok',
      'stock',
      'jumlah stok',
      'sisa stok',
      'qty',
      'quantity',
      'persediaan',
      'ps stock',
      'available',
    ]);
    const hasStockCell = hasRawCellValue(rawStockVal);
    const parsedStock = Math.trunc(parseNumericValue(rawStockVal));
    // EXACT stock replacement from imported CSV/Excel (NEVER additive!)
    const stock = hasStockCell
      ? Math.min(1_000_000, Math.max(0, Number.isFinite(parsedStock) ? parsedStock : 0))
      : matched
        ? matched.stock
        : 10;

    const rawUnit = String(
      pickField(rec, ['satuan', 'unit', 'uom', 'kemasan']) || matched?.unit || 'PCS'
    ).trim();
    const unit = normalizeProductUnit(rawUnit);

    const rawDesc = String(
      pickField(rec, [
        'deskripsi produk',
        'deskripsi',
        'description',
        'ps product description',
        'keterangan',
        'detail',
        'spesifikasi',
      ]) || ''
    ).trim();
    const description = (
      rawDesc.length >= 2
        ? rawDesc
        : matched?.description || `${name} (${category}) — tersedia di ALPAMART TRIMULIA ONLINE.`
    ).slice(0, FIELD_LIMITS.DESCRIPTION_MAX);

    const rawImg = pickField(rec, [
      'imageurl',
      'image url',
      'url gambar',
      'link gambar',
      'foto produk 1',
      'foto produk',
      'gambar',
      'image',
      'photo',
      'thumbnail',
      'ps item cover image',
    ]);
    const { url: imageUrl, needsImage } = sanitizeImageUrl(rawImg);

    const rawStatus = pickField(rec, [
      'status produk',
      'status',
      'isactive',
      'is active',
      'aktif',
      'active',
    ]);
    const isActive = parseActiveStatus(rawStatus);

    // ALWAYS protect registered catalog photos on matched existing products when preserveExistingPhotos is true!
    const existingHasRegisteredPhoto = Boolean(
      matched?.imageUrl && !isProductNeedingImage(matched.imageUrl)
    );
    const shouldPreserveExistingPhoto = Boolean(
      matched && existingHasRegisteredPhoto && (preserveExistingPhotos || needsImage)
    );

    const resolvedSku = matched?.sku || candidateSku;
    const resolvedBarcode = barcode || matched?.barcode || '';
    const skuKey = normalizeCodeKey(resolvedSku);
    const barcodeKey = resolvedBarcode ? normalizeCodeKey(resolvedBarcode) : '';
    const nameKey = normalizeNameKey(name);

    const entry: ParsedExternalProduct = {
      rowIndex: i + 1,
      name,
      sku: resolvedSku,
      barcode: resolvedBarcode,
      category,
      description,
      rawPrice,
      priceUsd,
      hasPriceValue: hasValidPriceValue,
      stock,
      hasStockValue: hasStockCell,
      unit,
      imageUrl: shouldPreserveExistingPhoto && matched ? matched.imageUrl : imageUrl,
      needsImage: shouldPreserveExistingPhoto ? false : needsImage,
      preservedExistingPhoto: shouldPreserveExistingPhoto,
      isActive,
      existingMatchId: matched ? matched.id : null,
      existingPriceUsd: matched ? matched.price : undefined,
      existingStock: matched ? matched.stock : undefined,
      action: matched ? 'update' : 'insert',
    };

    // Deduplicate rows within the same uploaded CSV/Excel file (never create double entries!)
    const existingBatchIdx =
      (matched && batchIndexByExistingId.get(matched.id)) ??
      (rawSku ? batchIndexBySku.get(normalizeCodeKey(rawSku)) : undefined) ??
      (barcodeKey ? batchIndexByBarcode.get(barcodeKey) : undefined) ??
      batchIndexByName.get(nameKey);

    if (existingBatchIdx !== undefined) {
      duplicateRowsInFileCount += 1;
      const prev = items[existingBatchIdx];
      // Replace with latest row's exact price & stock (never add stocks together!)
      items[existingBatchIdx] = {
        ...prev,
        priceUsd: entry.hasPriceValue ? entry.priceUsd : prev.priceUsd,
        rawPrice: entry.hasPriceValue ? entry.rawPrice : prev.rawPrice,
        hasPriceValue: prev.hasPriceValue || entry.hasPriceValue,
        stock: entry.hasStockValue ? entry.stock : prev.stock,
        hasStockValue: prev.hasStockValue || entry.hasStockValue,
        barcode: entry.barcode || prev.barcode,
        imageUrl: prev.preservedExistingPhoto
          ? prev.imageUrl
          : !entry.needsImage
            ? entry.imageUrl
            : prev.imageUrl,
        needsImage: prev.preservedExistingPhoto ? false : prev.needsImage && entry.needsImage,
      };
      continue;
    }

    const nextIdx = items.length;
    items.push(entry);
    if (matched) batchIndexByExistingId.set(matched.id, nextIdx);
    if (skuKey) batchIndexBySku.set(skuKey, nextIdx);
    if (barcodeKey) batchIndexByBarcode.set(barcodeKey, nextIdx);
    if (nameKey) batchIndexByName.set(nameKey, nextIdx);
  }

  const preservedPhotoCount = items.filter((item) => item.preservedExistingPhoto).length;

  return {
    items,
    skippedRows,
    duplicateRowsInFileCount,
    detectedFormat,
    detectedColumns,
    preservedPhotoCount,
    detectedAlpamartExport,
  };
}

/**
 * Generates a ready-to-use CSV template that Admin can open in Excel/Google Sheets
 * or use as reference for marketplace imports.
 */
export function buildMarketplaceImportTemplateCsv(): string {
  const header = [
    'SKU',
    'Nama Produk',
    'Kategori',
    'Harga',
    'Stok',
    'Satuan',
    'Deskripsi',
    'URL Gambar (Boleh Kosong)',
    'Status',
  ].join(',');
  const sample1 = [
    'MKT-001',
    '"Indomie Goreng Original 85g"',
    '"Mie & Bahan Pokok"',
    '0.50',
    '120',
    'PCS',
    '"Mie instan goreng favorit rasa original siap antar cepat."',
    '',
    'Aktif',
  ].join(',');
  const sample2 = [
    'MKT-002',
    '"Teh Botol Sosro Kotak 250ml"',
    '"Minuman"',
    '0.75',
    '80',
    'PACK',
    '"Minuman teh melati segar kemasan kotak praktis."',
    '',
    'Aktif',
  ].join(',');
  return `\uFEFF${header}\n${sample1}\n${sample2}\n`;
}

/**
 * Merges parsed external marketplace products into Firestore in safe batches:
 * - Default mode (`price_stock_only`): Never duplicates existing items; updates ONLY price, priceKhr, and exact stock from file (no addition!).
 * - Inserts genuinely new items that do not exist yet in the catalog.
 */
export async function mergeExternalProductsToFirestore(params: {
  items: ParsedExternalProduct[];
  existingCategories: StoreCategory[];
  duplicateStrategy: DuplicateImportStrategy;
  exchangeRateKhr?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<BulkMergeResult> {
  const {
    items,
    existingCategories,
    duplicateStrategy,
    exchangeRateKhr = USD_TO_KHR_RATE,
    onProgress,
  } = params;

  const safeKhrRate =
    Number.isFinite(exchangeRateKhr) && exchangeRateKhr >= 100 && exchangeRateKhr <= 100_000
      ? exchangeRateKhr
      : USD_TO_KHR_RATE;

  const existingCategoryNamesLower = new Set(
    existingCategories.map((c) => c.name.trim().toLowerCase())
  );
  const categoriesToCreate: string[] = [];
  let nextSortOrder =
    existingCategories.reduce((max, c) => Math.max(max, c.sortOrder || 0), 0) + 1;

  for (const item of items) {
    // Under price_stock_only or skip, do NOT create extra categories for already-existing products
    if (item.existingMatchId && duplicateStrategy !== 'update') {
      continue;
    }
    const key = item.category.trim().toLowerCase();
    if (key.length >= 2 && !existingCategoryNamesLower.has(key)) {
      existingCategoryNamesLower.add(key);
      categoriesToCreate.push(item.category.trim());
    }
  }

  // 1. Auto-create missing categories first
  if (categoriesToCreate.length > 0) {
    const catBatch = writeBatch(db);
    for (const catName of categoriesToCreate) {
      const safeSlug = catName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 32);
      const catId = `cat_imp_${safeSlug || 'cat'}_${Math.random().toString(36).slice(2, 6)}`;
      catBatch.set(doc(db, 'categories', catId), {
        id: catId,
        name: catName.slice(0, FIELD_LIMITS.CATEGORY_NAME_MAX),
        sortOrder: Math.min(1000, nextSortOrder++),
        isActive: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    await catBatch.commit();
  }

  // 2. Batch write products (max 200 per batch to stay well under Firestore 500-op limit)
  const CHUNK_SIZE = 200;
  let insertedCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  let needsImageCount = 0;
  let preservedPhotoCount = 0;
  let processed = 0;

  for (let start = 0; start < items.length; start += CHUNK_SIZE) {
    const chunk = items.slice(start, start + CHUNK_SIZE);

    // Only optimize images for newly inserted items or full-update items with new photos
    const itemsToOptimize = chunk
      .filter(
        (item) =>
          !(item.existingMatchId && duplicateStrategy !== 'update') &&
          !item.needsImage &&
          !item.preservedExistingPhoto
      )
      .map((item) => ({
        key: `row_${item.rowIndex}`,
        imageInput: item.imageUrl,
      }));
    const optimizedImageMap =
      itemsToOptimize.length > 0
        ? await optimizeProductImagesBatchOnBackend(itemsToOptimize)
        : new Map<string, string>();

    const batch = writeBatch(db);
    let opsInBatch = 0;

    for (const item of chunk) {
      const resolvedPriceKhr = Math.round(item.priceUsd * safeKhrRate);

      if (item.existingMatchId) {
        if (duplicateStrategy === 'skip') {
          skippedCount += 1;
          processed += 1;
          continue;
        }

        if (duplicateStrategy === 'price_stock_only') {
          // STRICT: Do NOT insert duplicate; ONLY update price, priceKhr, and EXACT stock from CSV (no addition!)
          const priceStockPayload: Record<string, unknown> = {
            price: item.priceUsd,
            priceKhr: resolvedPriceKhr,
            stock: item.stock,
            updatedAt: serverTimestamp(),
          };
          batch.update(doc(db, 'products', item.existingMatchId), priceStockPayload);
          updatedCount += 1;
          if (item.preservedExistingPhoto) {
            preservedPhotoCount += 1;
          }
          opsInBatch += 1;
          processed += 1;
          continue;
        }

        // Full update mode (still exact stock replacement, never additive, and protects registered photos)
        const resolvedImageUrl = item.preservedExistingPhoto
          ? item.imageUrl
          : optimizedImageMap.get(`row_${item.rowIndex}`) || item.imageUrl;

        const updatePayload: Record<string, unknown> = {
          name: item.name,
          sku: item.sku,
          category: item.category,
          description: item.description,
          price: item.priceUsd,
          priceKhr: resolvedPriceKhr,
          unit: item.unit,
          stock: item.stock,
          isActive: item.isActive,
          updatedAt: serverTimestamp(),
        };
        if (item.preservedExistingPhoto) {
          preservedPhotoCount += 1;
        } else {
          updatePayload.imageUrl = resolvedImageUrl;
        }
        if (item.barcode) {
          updatePayload.barcode = item.barcode;
        }
        batch.update(doc(db, 'products', item.existingMatchId), updatePayload);
        updatedCount += 1;
        if (item.needsImage) needsImageCount += 1;
        opsInBatch += 1;
      } else {
        const resolvedImageUrl =
          optimizedImageMap.get(`row_${item.rowIndex}`) || item.imageUrl;
        const productId = `prod_imp_${Date.now().toString(36)}_${Math.random()
          .toString(36)
          .slice(2, 7)}`;
        const createPayload: Record<string, unknown> = {
          id: productId,
          name: item.name,
          sku: item.sku,
          category: item.category,
          description: item.description,
          price: item.priceUsd,
          priceKhr: resolvedPriceKhr,
          unit: item.unit,
          stock: item.stock,
          imageUrl: resolvedImageUrl,
          isActive: item.isActive,
          syncSource: 'manual',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
        if (item.barcode) {
          createPayload.barcode = item.barcode;
        }
        batch.set(doc(db, 'products', productId), createPayload);
        insertedCount += 1;
        if (item.needsImage) needsImageCount += 1;
        opsInBatch += 1;
      }
      processed += 1;
    }

    if (opsInBatch > 0) {
      await batch.commit();
    }
    onProgress?.(processed, items.length);
  }

  return {
    insertedCount,
    updatedCount,
    skippedCount,
    createdCategories: categoriesToCreate,
    needsImageCount,
    preservedPhotoCount,
  };
}

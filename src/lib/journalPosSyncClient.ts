import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  writeBatch,
} from 'firebase/firestore';
import type {
  JournalPosConfig,
  JournalPosConnectionStatus,
  JournalPosSignatureFormat,
  JournalPosSyncLog,
  Product,
  StoreCategory,
} from '../types/marketplace';
import { db } from './firebase';
import type { MappedJournalPosRecord } from './journalPosAdapter';
import { isProductNeedingImage } from './marketplaceBulkImport';
import { optimizeProductImagesBatchOnBackend } from './productImageOptimizerClient';

export const DEFAULT_JOURNAL_POS_CONFIG: JournalPosConfig = {
  id: 'journalPos',
  sourceBaseUrl: 'https://journal.alpa.gdn/web',
  autoSyncEnabled: false,
  syncIntervalSeconds: 60,
  signatureFormat: 'method_path_timestamp',
  connectionStatus: 'ERROR',
  lastConnectionMessage: 'Menunggu konfigurasi API Key & Secret JOURNAL POS di backend.',
  lastSyncAt: '',
  lastSyncMode: 'manual',
  lastSuccessCount: 0,
  lastFailedCount: 0,
  lastUpdatedCount: 0,
  lastInsertedCount: 0,
  lastErrorDetail: '',
  permanentStoreUrl: '',
  updatedBy: 'system',
};

export interface JournalPosPriceChangeEntry {
  productId: string;
  sku: string;
  name: string;
  oldPrice: number;
  newPrice: number;
  oldPriceKhr: number;
  newPriceKhr: number;
  oldStock?: number;
  newStock?: number;
}

export interface SyncExecutionResult {
  status: 'UPDATED' | 'ERROR';
  totalProcessed: number;
  successCount: number;
  insertedCount: number;
  updatedCount: number;
  skippedUnmatchedCount: number;
  priceChangedCount: number;
  stockChangedCount: number;
  priceChanges: JournalPosPriceChangeEntry[];
  failedCount: number;
  categoriesAdded: number;
  changedSkus: string[];
  errors: string[];
  summary: string;
  syncedAtIso: string;
}

function normalizeNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeBarcodeKey(barcode: string): string {
  return barcode.trim().replace(/\s+/g, '').toLowerCase();
}

function makeDeterministicProductId(externalId: string, sku: string): string {
  const raw = (externalId || sku || `${Date.now()}`)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  const safe = raw.length >= 2 ? raw : `item_${Date.now()}`;
  return `jpos_${safe}`;
}

function makeDeterministicCategoryId(categoryName: string): string {
  const slug = categoryName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return `cat_jpos_${slug || 'umum'}`;
}

/**
 * Applies mapped JOURNAL POS product records into Firestore safely:
 * - Matches existing products by externalId first, then SKU (case-insensitive)
 * - UPDATEs existing product document (preserving id, createdAt, lastOrderId)
 * - INSERTs new product document if not found
 * - Isolates costPriceUsd / costPriceKhr strictly into Admin-only /productPrivateMeta/{productId}
 * - Auto-registers missing categories in /categories
 * - NEVER touches /orders, /users, /deliveryAccounts, or non-mapped product fields
 * - Records immutable sync log in /journalPosSyncLogs and updates /integrationConfig/journalPos
 */
export async function applyJournalPosRecordsToFirestore(params: {
  records: MappedJournalPosRecord[];
  parseErrors?: string[];
  existingProducts: Product[];
  existingCategories: StoreCategory[];
  trigger: JournalPosSyncLog['trigger'];
  adminEmail: string;
  currentConfig: JournalPosConfig;
  exchangeRateKhr?: number;
  priceAndStockOnly?: boolean;
  skipUnmatchedNewItems?: boolean;
}): Promise<SyncExecutionResult> {
  const {
    records,
    parseErrors = [],
    existingProducts,
    existingCategories,
    trigger,
    adminEmail,
    currentConfig,
    exchangeRateKhr,
    priceAndStockOnly = false,
    skipUnmatchedNewItems = false,
  } = params;

  const liveRate =
    typeof exchangeRateKhr === 'number' && Number.isFinite(exchangeRateKhr) && exchangeRateKhr >= 1
      ? exchangeRateKhr
      : 0;

  const byExternalId = new Map<string, Product>();
  const bySkuLower = new Map<string, Product>();
  const byBarcodeKey = new Map<string, Product>();
  const byNameKey = new Map<string, Product>();
  for (const prod of existingProducts) {
    if (prod.externalId && prod.externalId.trim()) {
      byExternalId.set(prod.externalId.trim().toLowerCase(), prod);
    }
    if (prod.sku && prod.sku.trim()) {
      bySkuLower.set(prod.sku.trim().toLowerCase(), prod);
    }
    if (prod.barcode && normalizeBarcodeKey(prod.barcode).length >= 4) {
      byBarcodeKey.set(normalizeBarcodeKey(prod.barcode), prod);
    }
    if (prod.name && normalizeNameKey(prod.name).length >= 2) {
      byNameKey.set(normalizeNameKey(prod.name), prod);
    }
  }

  const existingCategoryNames = new Set(
    existingCategories.map((c) => c.name.trim().toLowerCase())
  );
  const newCategoriesToCreate = new Map<string, string>();

  let insertedCount = 0;
  let updatedCount = 0;
  let skippedUnmatchedCount = 0;
  let priceChangedCount = 0;
  let stockChangedCount = 0;
  let failedCount = parseErrors.length;
  const errors: string[] = [...parseErrors];
  const changedSkus: string[] = [];
  const priceChanges: JournalPosPriceChangeEntry[] = [];

  // Process in safe Firestore batch chunks (max 150 records * 2 writes = 300 ops < 500 limit)
  const CHUNK_SIZE = 150;
  for (let offset = 0; offset < records.length; offset += CHUNK_SIZE) {
    const chunk = records.slice(offset, offset + CHUNK_SIZE);

    // Automatically optimize product images on backend so synced items fit consistently in display box
    const optimizedImageMap = await optimizeProductImagesBatchOnBackend(
      chunk.map((item, idx) => ({
        key: `${offset + idx}`,
        imageInput: item.publicProduct.imageUrl,
      }))
    );

    const batch = writeBatch(db);
    let batchWrites = 0;

    for (let idx = 0; idx < chunk.length; idx++) {
      const item = chunk[idx];
      const pub = item.publicProduct;
      const priv = item.privateCostMeta;
      const resolvedImageUrl = optimizedImageMap.get(`${offset + idx}`) || pub.imageUrl;

      // Recalculate secondary KHR price using live Master Data exchange rate when Journal POS did not send explicit KHR
      const resolvedPriceKhr =
        !item.hasExplicitKhrPrice && liveRate > 0
          ? Math.round((pub.price * liveRate) / 100) * 100
          : pub.priceKhr;
      const resolvedPromoPriceKhr =
        pub.promoActive && pub.promoPriceUsd > 0
          ? !item.hasExplicitKhrPrice && liveRate > 0
            ? Math.round((pub.promoPriceUsd * liveRate) / 100) * 100
            : pub.promoPriceKhr
          : 0;

      try {
        const extKey = pub.externalId.trim().toLowerCase();
        const skuKey = pub.sku.trim().toLowerCase();
        const barcodeKey = normalizeBarcodeKey(pub.barcode || '');
        const nameKey = normalizeNameKey(pub.name || '');

        const matched =
          (extKey && byExternalId.get(extKey)) ||
          (skuKey && bySkuLower.get(skuKey)) ||
          (barcodeKey.length >= 4 && byBarcodeKey.get(barcodeKey)) ||
          (nameKey.length >= 2 && byNameKey.get(nameKey)) ||
          null;

        const targetId = matched
          ? matched.id
          : makeDeterministicProductId(pub.externalId, pub.sku);

        const productRef = doc(db, 'products', targetId);
        const privateRef = doc(db, 'productPrivateMeta', targetId);

        if (matched) {
          // Preserve existing registered catalog photo so sync never erases or overwrites registered images
          const existingHasPhoto = Boolean(
            matched.imageUrl && !isProductNeedingImage(matched.imageUrl)
          );
          const finalImageUrl = existingHasPhoto ? matched.imageUrl : resolvedImageUrl;

          const oldPrice = Number(matched.price) || 0;
          const oldPriceKhr = Number(matched.priceKhr) || 0;
          const oldStock = Number(matched.stock) || 0;
          const isPriceChanged =
            Math.abs(oldPrice - pub.price) >= 0.005 ||
            (resolvedPriceKhr > 0 && Math.abs(oldPriceKhr - resolvedPriceKhr) >= 1);
          const isStockChanged = oldStock !== pub.stock;

          if (isPriceChanged) {
            priceChangedCount += 1;
          }
          if (isStockChanged) {
            stockChangedCount += 1;
          }
          if ((isPriceChanged || isStockChanged) && priceChanges.length < 40) {
            priceChanges.push({
              productId: targetId,
              sku: pub.sku || matched.sku,
              name: priceAndStockOnly ? matched.name : pub.name,
              oldPrice,
              newPrice: pub.price,
              oldPriceKhr,
              newPriceKhr: resolvedPriceKhr,
              oldStock,
              newStock: pub.stock,
            });
          }

          // UPDATE existing product (strictly mapped fields only; replaces stock verbatim — never additive)
          batch.update(productRef, {
            name: priceAndStockOnly ? matched.name : pub.name,
            sku: matched.sku || pub.sku,
            barcode: pub.barcode || matched.barcode || '',
            externalId: pub.externalId || matched.externalId || '',
            category: priceAndStockOnly ? matched.category : pub.category,
            description: priceAndStockOnly ? matched.description : pub.description,
            price: pub.price,
            priceKhr: resolvedPriceKhr,
            unit: priceAndStockOnly ? matched.unit || pub.unit : pub.unit,
            stock: pub.stock,
            imageUrl: finalImageUrl,
            isActive: pub.isActive,
            promoActive: pub.promoActive,
            promoPriceUsd: pub.promoPriceUsd,
            promoPriceKhr: resolvedPromoPriceKhr,
            promoDiscountPercent: pub.promoDiscountPercent,
            promoStartDate: pub.promoStartDate,
            promoEndDate: pub.promoEndDate,
            promoLabel: pub.promoLabel,
            syncSource: 'journal_pos',
            sourceUpdatedAt: pub.sourceUpdatedAt,
            updatedAt: serverTimestamp(),
          });
          batchWrites += 1;
          updatedCount += 1;
        } else if (skipUnmatchedNewItems) {
          // Anti-double / existing-only mode: skip items not yet in catalog
          skippedUnmatchedCount += 1;
          continue;
        } else {
          // INSERT new product
          batch.set(productRef, {
            id: targetId,
            name: pub.name,
            sku: pub.sku,
            barcode: pub.barcode,
            externalId: pub.externalId,
            category: pub.category,
            description: pub.description,
            price: pub.price,
            priceKhr: resolvedPriceKhr,
            unit: pub.unit,
            stock: pub.stock,
            imageUrl: resolvedImageUrl,
            isActive: pub.isActive,
            promoActive: pub.promoActive,
            promoPriceUsd: pub.promoPriceUsd,
            promoPriceKhr: resolvedPromoPriceKhr,
            promoDiscountPercent: pub.promoDiscountPercent,
            promoStartDate: pub.promoStartDate,
            promoEndDate: pub.promoEndDate,
            promoLabel: pub.promoLabel,
            syncSource: 'journal_pos',
            sourceUpdatedAt: pub.sourceUpdatedAt,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          batchWrites += 1;
          insertedCount += 1;
          // Track newly inserted product in lookup maps to prevent duplicates within the same sync run
          const placeholderProd = { id: targetId, ...pub, priceKhr: resolvedPriceKhr } as Product;
          if (extKey) byExternalId.set(extKey, placeholderProd);
          if (skuKey) bySkuLower.set(skuKey, placeholderProd);
          if (barcodeKey.length >= 4) byBarcodeKey.set(barcodeKey, placeholderProd);
          if (nameKey.length >= 2) byNameKey.set(nameKey, placeholderProd);
        }

        // Write Admin-only Cost Price strictly to /productPrivateMeta/{productId}
        batch.set(privateRef, {
          productId: targetId,
          sku: priv.sku,
          externalId: priv.externalId,
          costPriceUsd: priv.costPriceUsd,
          costPriceKhr: priv.costPriceKhr,
          sourceUpdatedAt: priv.sourceUpdatedAt,
          updatedAt: serverTimestamp(),
        });
        batchWrites += 1;

        if (changedSkus.length < 50) {
          changedSkus.push(pub.sku);
        }

        // Queue new category creation if needed
        const targetCategoryName = matched && priceAndStockOnly ? matched.category : pub.category;
        const catLower = targetCategoryName.trim().toLowerCase();
        if (catLower && !existingCategoryNames.has(catLower)) {
          existingCategoryNames.add(catLower);
          newCategoriesToCreate.set(
            makeDeterministicCategoryId(targetCategoryName),
            targetCategoryName
          );
        }
      } catch (err) {
        failedCount += 1;
        errors.push(
          `SKU ${pub.sku}: ${err instanceof Error ? err.message : 'Gagal memetakan dokumen Firestore.'}`
        );
      }
    }

    if (batchWrites > 0) {
      await batch.commit();
    }
  }

  // Create any newly discovered categories in /categories
  let categoriesAdded = 0;
  if (newCategoriesToCreate.size > 0) {
    const catBatch = writeBatch(db);
    let sortOffset = existingCategories.length + 1;
    for (const [catId, catName] of newCategoriesToCreate.entries()) {
      const catRef = doc(db, 'categories', catId);
      const existingSnap = await getDoc(catRef).catch(() => null);
      if (!existingSnap?.exists()) {
        catBatch.set(catRef, {
          id: catId,
          name: catName.slice(0, 60),
          sortOrder: Math.min(1000, sortOffset++),
          isActive: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        categoriesAdded += 1;
      }
    }
    if (categoriesAdded > 0) {
      await catBatch.commit();
    }
  }

  const successCount = insertedCount + updatedCount;
  const totalProcessed = successCount + failedCount;
  const syncedAtIso = new Date().toISOString();
  const status: 'UPDATED' | 'ERROR' =
    failedCount > 0 && successCount === 0 ? 'ERROR' : 'UPDATED';
  const summary =
    `Sinkronisasi (${trigger}): ${successCount} berhasil (${insertedCount} baru, ${updatedCount} diperbarui` +
    (priceChangedCount > 0 ? `, ${priceChangedCount} harga berubah` : '') +
    (stockChangedCount > 0 ? `, ${stockChangedCount} stok diganti persis sesuai Journal POS` : '') +
    (skippedUnmatchedCount > 0 ? `, ${skippedUnmatchedCount} item luar katalog dilewati` : '') +
    `), ${failedCount} gagal.` +
    (categoriesAdded > 0 ? ` +${categoriesAdded} kategori baru.` : '');
  const errorDetail = errors.slice(0, 8).join(' | ').slice(0, 980);

  // Append immutable sync audit log
  const logId = `jsync_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await setDoc(doc(db, 'journalPosSyncLogs', logId), {
    id: logId,
    trigger,
    status,
    totalProcessed,
    successCount,
    insertedCount,
    updatedCount,
    failedCount,
    summary: summary.slice(0, 400),
    errorDetail,
    changedSkus: changedSkus.slice(0, 50),
    createdBy: adminEmail.slice(0, 128),
    createdAt: serverTimestamp(),
  });

  // Update persistent integrationConfig/journalPos
  await saveJournalPosConfig(
    {
      ...currentConfig,
      connectionStatus: status,
      lastConnectionMessage: summary.slice(0, 290),
      lastSyncAt: syncedAtIso,
      lastSyncMode: trigger,
      lastSuccessCount: successCount,
      lastFailedCount: failedCount,
      lastUpdatedCount: updatedCount,
      lastInsertedCount: insertedCount,
      lastErrorDetail: errorDetail,
    },
    adminEmail
  );

  return {
    status,
    totalProcessed,
    successCount,
    insertedCount,
    updatedCount,
    skippedUnmatchedCount,
    priceChangedCount,
    stockChangedCount,
    priceChanges,
    failedCount,
    categoriesAdded,
    changedSkus,
    errors,
    summary,
    syncedAtIso,
  };
}

export async function saveJournalPosConfig(
  config: Partial<JournalPosConfig>,
  adminEmail: string
): Promise<void> {
  const merged: JournalPosConfig = {
    ...DEFAULT_JOURNAL_POS_CONFIG,
    ...config,
    id: 'journalPos',
  };

  const validSourceUrl = merged.sourceBaseUrl.startsWith('https://journal.alpa.gdn')
    ? merged.sourceBaseUrl.slice(0, 200)
    : DEFAULT_JOURNAL_POS_CONFIG.sourceBaseUrl;
  const validPermanentUrl =
    merged.permanentStoreUrl && merged.permanentStoreUrl.startsWith('https://')
      ? merged.permanentStoreUrl.slice(0, 240)
      : '';

  const allowedStatus: JournalPosConnectionStatus[] = ['ONLINE', 'SYNCING', 'ERROR', 'UPDATED'];
  const connectionStatus = allowedStatus.includes(merged.connectionStatus)
    ? merged.connectionStatus
    : 'ERROR';

  const allowedFormats: JournalPosSignatureFormat[] = [
    'method_path_timestamp',
    'timestamp_method_path',
    'timestamp_path',
    'timestamp_only',
  ];
  const signatureFormat = allowedFormats.includes(merged.signatureFormat)
    ? merged.signatureFormat
    : 'method_path_timestamp';

  await setDoc(doc(db, 'integrationConfig', 'journalPos'), {
    id: 'journalPos',
    sourceBaseUrl: validSourceUrl,
    autoSyncEnabled: Boolean(merged.autoSyncEnabled),
    syncIntervalSeconds: Math.min(3600, Math.max(30, Math.floor(merged.syncIntervalSeconds || 60))),
    signatureFormat,
    connectionStatus,
    lastConnectionMessage: (merged.lastConnectionMessage || '').slice(0, 300),
    lastSyncAt: (merged.lastSyncAt || '').slice(0, 64),
    lastSyncMode: merged.lastSyncMode || 'manual',
    lastSuccessCount: Math.max(0, Math.floor(merged.lastSuccessCount || 0)),
    lastFailedCount: Math.max(0, Math.floor(merged.lastFailedCount || 0)),
    lastUpdatedCount: Math.max(0, Math.floor(merged.lastUpdatedCount || 0)),
    lastInsertedCount: Math.max(0, Math.floor(merged.lastInsertedCount || 0)),
    lastErrorDetail: (merged.lastErrorDetail || '').slice(0, 1000),
    permanentStoreUrl: validPermanentUrl,
    updatedBy: (adminEmail || 'admin').slice(0, 128),
    updatedAt: serverTimestamp(),
  });
}

export async function recordJournalPosErrorLog(params: {
  trigger: JournalPosSyncLog['trigger'];
  summary: string;
  errorDetail: string;
  adminEmail: string;
  currentConfig: JournalPosConfig;
}): Promise<void> {
  const { trigger, summary, errorDetail, adminEmail, currentConfig } = params;
  const logId = `jsync_err_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await setDoc(doc(db, 'journalPosSyncLogs', logId), {
    id: logId,
    trigger,
    status: 'ERROR',
    totalProcessed: 0,
    successCount: 0,
    insertedCount: 0,
    updatedCount: 0,
    failedCount: 1,
    summary: summary.slice(0, 400),
    errorDetail: errorDetail.slice(0, 1000),
    changedSkus: [],
    createdBy: adminEmail.slice(0, 128),
    createdAt: serverTimestamp(),
  });

  await saveJournalPosConfig(
    {
      ...currentConfig,
      connectionStatus: 'ERROR',
      lastConnectionMessage: summary.slice(0, 290),
      lastErrorDetail: errorDetail.slice(0, 980),
    },
    adminEmail
  );
}

export async function fetchAllCategoriesOnce(): Promise<StoreCategory[]> {
  const snap = await getDocs(collection(db, 'categories'));
  return snap.docs.map((d) => d.data() as StoreCategory);
}

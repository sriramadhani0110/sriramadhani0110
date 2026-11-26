/**
 * Server-Side Journal POS -> Firestore Synchronizer (Firebase Admin SDK)
 *
 * Updates product prices, KHR conversions, stock quantities, and promotion flags
 * directly in Firestore without requiring any browser or manual admin click.
 * All 4 portals (Pelanggan, Deliveri, Admin, Master Data) immediately reflect
 * price & stock changes in real time via Firestore listeners.
 */

import { FieldValue } from 'firebase-admin/firestore';
import type {
  JournalPosSignatureFormat,
  JournalPosSyncTrigger,
} from '../types/marketplace.ts';
import {
  getAdminFirestore,
  isFirestoreIamPermissionError,
} from './firebaseAdminServer.ts';
import {
  DEFAULT_EXCHANGE_RATE_KHR,
  DEFAULT_JOURNAL_POS_BASE_URL,
  type MappedJournalPosRecord,
} from './journalPosAdapter.ts';
import { optimizeProductImageForDisplayBox } from './serverProductImageOptimizer.ts';

export interface ServerJournalPosPriceChange {
  productId: string;
  sku: string;
  name: string;
  oldPrice: number;
  newPrice: number;
  oldPriceKhr: number;
  newPriceKhr: number;
  oldStock: number;
  newStock: number;
}

export interface ServerFirestoreSyncResult {
  ok: boolean;
  iamPermissionDenied?: boolean;
  status: 'UPDATED' | 'NO_CHANGES' | 'ERROR';
  totalProcessed: number;
  successCount: number;
  insertedCount: number;
  updatedCount: number;
  unchangedCount: number;
  priceChangedCount: number;
  stockChangedCount: number;
  priceChanges: ServerJournalPosPriceChange[];
  failedCount: number;
  categoriesAdded: number;
  changedSkus: string[];
  errors: string[];
  summary: string;
  syncedAtIso: string;
  exchangeRateUsed: number;
}

interface ExistingFirestoreProduct {
  id: string;
  name: string;
  sku: string;
  barcode: string;
  externalId: string;
  category: string;
  description: string;
  price: number;
  priceKhr: number;
  unit: string;
  stock: number;
  imageUrl: string;
  isActive: boolean;
  promoActive: boolean;
  promoPriceUsd: number;
  promoPriceKhr: number;
  promoDiscountPercent: number;
  promoStartDate: string;
  promoEndDate: string;
  promoLabel: string;
}

function normalizeNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeBarcodeKey(barcode: string): string {
  return barcode.trim().replace(/\s+/g, '').toLowerCase();
}

function isProductNeedingImage(imageUrl?: string): boolean {
  const clean = (imageUrl || '').trim();
  if (!clean) return true;
  return (
    clean === '/assets/placeholder-product.svg' ||
    clean.includes('placeholder-product')
  );
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

async function resolveSafeProductImageServer(rawImageUrl: string): Promise<string> {
  const trimmed = (rawImageUrl || '').trim();
  if (!trimmed || isProductNeedingImage(trimmed)) {
    return '/assets/placeholder-product.svg';
  }
  if (trimmed.startsWith('data:image/')) {
    return trimmed;
  }
  if (trimmed.startsWith('https://')) {
    try {
      const optimized = await optimizeProductImageForDisplayBox(trimmed, { boxSize: 480 });
      if (optimized.ok && optimized.imageUrl) {
        return optimized.imageUrl;
      }
    } catch {
      // Keep original HTTPS image URL if optimization fails
    }
    return trimmed.slice(0, 1000);
  }
  if (trimmed.startsWith('/')) {
    return trimmed.slice(0, 1000);
  }
  return '/assets/placeholder-product.svg';
}

/**
 * Reads the live Master Data exchange rate from Firestore (/storeConfig/master)
 * so Journal POS price conversions always stay synchronized with Master Data.
 */
export async function fetchLiveMasterExchangeRateServer(
  fallbackRate = DEFAULT_EXCHANGE_RATE_KHR
): Promise<number> {
  try {
    const db = getAdminFirestore();
    const snap = await db.collection('storeConfig').doc('master').get();
    if (snap.exists) {
      const rate = Number(snap.data()?.exchangeRate);
      if (Number.isFinite(rate) && rate >= 1 && rate <= 1_000_000) {
        return rate;
      }
    }
  } catch {
    // Fall back safely
  }
  return fallbackRate;
}

/**
 * Directly applies Journal POS product records (price, KHR, stock, promos, private cost)
 * to Firestore on the server using Firebase Admin SDK.
 *
 * Security & data integrity guarantees:
 * - Never exposes costPriceUsd / costPriceKhr in /products (strictly isolated in /productPrivateMeta)
 * - Never overwrites registered product photos on existing catalog items
 * - Never touches /orders, /users, /adminAccounts, or /deliveryAccounts
 * - Skips unchanged existing products when onlyChanged=true to minimize write traffic
 * - Appends an immutable audit entry in /journalPosSyncLogs and updates /integrationConfig/journalPos
 */
export async function syncJournalPosRecordsToFirestoreServer(params: {
  records: MappedJournalPosRecord[];
  parseErrors?: string[];
  trigger: JournalPosSyncTrigger;
  actorEmail: string;
  sourceBaseUrl?: string;
  signatureFormat?: JournalPosSignatureFormat;
  syncIntervalSeconds?: number;
  exchangeRateKhr?: number;
  onlyChanged?: boolean;
  priceAndStockOnly?: boolean;
}): Promise<ServerFirestoreSyncResult> {
  const {
    records,
    parseErrors = [],
    trigger,
    actorEmail,
    sourceBaseUrl = DEFAULT_JOURNAL_POS_BASE_URL,
    signatureFormat = 'method_path_timestamp',
    syncIntervalSeconds = 60,
    onlyChanged = false,
    priceAndStockOnly = false,
  } = params;

  const syncedAtIso = new Date().toISOString();

  try {
    const db = getAdminFirestore();

    const liveRate =
      typeof params.exchangeRateKhr === 'number' &&
      Number.isFinite(params.exchangeRateKhr) &&
      params.exchangeRateKhr >= 1
        ? params.exchangeRateKhr
        : await fetchLiveMasterExchangeRateServer(DEFAULT_EXCHANGE_RATE_KHR);

    // 1. Load existing products, categories, and current integration config
    const [productsSnap, categoriesSnap, integrationSnap] = await Promise.all([
      db.collection('products').get(),
      db.collection('categories').get(),
      db.collection('integrationConfig').doc('journalPos').get(),
    ]);

    const byExternalId = new Map<string, ExistingFirestoreProduct>();
    const bySkuLower = new Map<string, ExistingFirestoreProduct>();
    const byBarcodeKey = new Map<string, ExistingFirestoreProduct>();
    const byNameKey = new Map<string, ExistingFirestoreProduct>();

    for (const docSnap of productsSnap.docs) {
      const d = docSnap.data() as Record<string, unknown>;
      const prod: ExistingFirestoreProduct = {
        id: docSnap.id,
        name: String(d.name || ''),
        sku: String(d.sku || ''),
        barcode: String(d.barcode || ''),
        externalId: String(d.externalId || ''),
        category: String(d.category || 'Umum'),
        description: String(d.description || ''),
        price: Number(d.price) || 0,
        priceKhr: Number(d.priceKhr) || 0,
        unit: String(d.unit || 'PCS'),
        stock: Number(d.stock) || 0,
        imageUrl: String(d.imageUrl || ''),
        isActive: d.isActive !== false,
        promoActive: Boolean(d.promoActive),
        promoPriceUsd: Number(d.promoPriceUsd) || 0,
        promoPriceKhr: Number(d.promoPriceKhr) || 0,
        promoDiscountPercent: Number(d.promoDiscountPercent) || 0,
        promoStartDate: String(d.promoStartDate || ''),
        promoEndDate: String(d.promoEndDate || ''),
        promoLabel: String(d.promoLabel || ''),
      };

      if (prod.externalId.trim()) {
        byExternalId.set(prod.externalId.trim().toLowerCase(), prod);
      }
      if (prod.sku.trim()) {
        bySkuLower.set(prod.sku.trim().toLowerCase(), prod);
      }
      const bcKey = normalizeBarcodeKey(prod.barcode);
      if (bcKey.length >= 4) {
        byBarcodeKey.set(bcKey, prod);
      }
      const nmKey = normalizeNameKey(prod.name);
      if (nmKey.length >= 2) {
        byNameKey.set(nmKey, prod);
      }
    }

    const existingCategoryNames = new Set<string>();
    for (const catSnap of categoriesSnap.docs) {
      const name = String(catSnap.data()?.name || '').trim().toLowerCase();
      if (name) existingCategoryNames.add(name);
    }
    const newCategoriesToCreate = new Map<string, string>();

    let insertedCount = 0;
    let updatedCount = 0;
    let unchangedCount = 0;
    let priceChangedCount = 0;
    let stockChangedCount = 0;
    let failedCount = parseErrors.length;
    const errors: string[] = [...parseErrors];
    const changedSkus: string[] = [];
    const priceChanges: ServerJournalPosPriceChange[] = [];

    const CHUNK_SIZE = 150;
    for (let offset = 0; offset < records.length; offset += CHUNK_SIZE) {
      const chunk = records.slice(offset, offset + CHUNK_SIZE);
      const batch = db.batch();
      let batchOps = 0;

      for (const item of chunk) {
        const pub = item.publicProduct;
        const priv = item.privateCostMeta;

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

          const productRef = db.collection('products').doc(targetId);
          const privateRef = db.collection('productPrivateMeta').doc(targetId);

          if (matched) {
            const existingHasPhoto = !isProductNeedingImage(matched.imageUrl);
            const isPriceChanged =
              Math.abs(matched.price - pub.price) >= 0.005 ||
              (resolvedPriceKhr > 0 && Math.abs(matched.priceKhr - resolvedPriceKhr) >= 1);
            const isStockChanged = matched.stock !== pub.stock;
            const isPromoChanged =
              matched.promoActive !== pub.promoActive ||
              Math.abs(matched.promoPriceUsd - pub.promoPriceUsd) >= 0.005 ||
              matched.promoDiscountPercent !== pub.promoDiscountPercent ||
              matched.promoStartDate !== pub.promoStartDate ||
              matched.promoEndDate !== pub.promoEndDate ||
              matched.promoLabel !== pub.promoLabel;
            const isStatusChanged = matched.isActive !== pub.isActive;
            const isMetaChanged =
              !priceAndStockOnly &&
              (matched.name !== pub.name ||
                matched.category !== pub.category ||
                matched.description !== pub.description ||
                matched.unit !== pub.unit ||
                (pub.barcode && matched.barcode !== pub.barcode));

            if (
              onlyChanged &&
              !isPriceChanged &&
              !isStockChanged &&
              !isPromoChanged &&
              !isStatusChanged &&
              !isMetaChanged
            ) {
              unchangedCount += 1;
              continue;
            }

            const finalImageUrl = existingHasPhoto
              ? matched.imageUrl
              : await resolveSafeProductImageServer(pub.imageUrl);

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
                oldPrice: matched.price,
                newPrice: pub.price,
                oldPriceKhr: matched.priceKhr,
                newPriceKhr: resolvedPriceKhr,
                oldStock: matched.stock,
                newStock: pub.stock,
              });
            }

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
              updatedAt: FieldValue.serverTimestamp(),
            });
            batchOps += 1;
            updatedCount += 1;
          } else {
            const finalImageUrl = await resolveSafeProductImageServer(pub.imageUrl);
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
              createdAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            });
            batchOps += 1;
            insertedCount += 1;

            const insertedPlaceholder: ExistingFirestoreProduct = {
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
              imageUrl: finalImageUrl,
              isActive: pub.isActive,
              promoActive: pub.promoActive,
              promoPriceUsd: pub.promoPriceUsd,
              promoPriceKhr: resolvedPromoPriceKhr,
              promoDiscountPercent: pub.promoDiscountPercent,
              promoStartDate: pub.promoStartDate,
              promoEndDate: pub.promoEndDate,
              promoLabel: pub.promoLabel,
            };
            if (extKey) byExternalId.set(extKey, insertedPlaceholder);
            if (skuKey) bySkuLower.set(skuKey, insertedPlaceholder);
            if (barcodeKey.length >= 4) byBarcodeKey.set(barcodeKey, insertedPlaceholder);
            if (nameKey.length >= 2) byNameKey.set(nameKey, insertedPlaceholder);
          }

          // Admin-only Cost Price strictly isolated into /productPrivateMeta/{productId}
          batch.set(privateRef, {
            productId: targetId,
            sku: priv.sku,
            externalId: priv.externalId,
            costPriceUsd: priv.costPriceUsd,
            costPriceKhr: priv.costPriceKhr,
            sourceUpdatedAt: priv.sourceUpdatedAt,
            updatedAt: FieldValue.serverTimestamp(),
          });
          batchOps += 1;

          if (changedSkus.length < 50) {
            changedSkus.push(pub.sku);
          }

          const targetCategoryName =
            matched && priceAndStockOnly ? matched.category : pub.category;
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

      if (batchOps > 0) {
        await batch.commit();
      }
    }

    // Create newly discovered categories in /categories
    let categoriesAdded = 0;
    if (newCategoriesToCreate.size > 0) {
      const catBatch = db.batch();
      let sortOffset = existingCategoryNames.size + 1;
      for (const [catId, catName] of newCategoriesToCreate.entries()) {
        const catRef = db.collection('categories').doc(catId);
        const existingSnap = await catRef.get().catch(() => null);
        if (!existingSnap?.exists) {
          catBatch.set(catRef, {
            id: catId,
            name: catName.slice(0, 60),
            sortOrder: Math.min(1000, sortOffset++),
            isActive: true,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
          categoriesAdded += 1;
        }
      }
      if (categoriesAdded > 0) {
        await catBatch.commit();
      }
    }

    const successCount = insertedCount + updatedCount;
    const totalProcessed = successCount + unchangedCount + failedCount;
    const isNoChangesOnly = onlyChanged && successCount === 0 && failedCount === 0;
    const status: 'UPDATED' | 'NO_CHANGES' | 'ERROR' =
      failedCount > 0 && successCount === 0
        ? 'ERROR'
        : isNoChangesOnly
          ? 'NO_CHANGES'
          : 'UPDATED';

    const summary = isNoChangesOnly
      ? `Sinkronisasi Backend (${trigger}): ${unchangedCount} produk sudah sesuai dengan Journal POS (tidak ada perubahan harga/stok).`
      : `Sinkronisasi Backend (${trigger}): ${successCount} diperbarui ke Firestore (${insertedCount} baru, ${updatedCount} update` +
        (priceChangedCount > 0 ? `, ${priceChangedCount} harga berubah otomatis` : '') +
        (stockChangedCount > 0 ? `, ${stockChangedCount} stok berubah` : '') +
        `), ${failedCount} gagal.` +
        (categoriesAdded > 0 ? ` +${categoriesAdded} kategori baru.` : '');

    const errorDetail = errors.slice(0, 8).join(' | ').slice(0, 980);

    // Only write audit log + config update when something actually changed or when triggered manually/webhook
    if (!isNoChangesOnly || trigger !== 'polling') {
      const logId = `jsync_srv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      await db.collection('journalPosSyncLogs').doc(logId).set({
        id: logId,
        trigger,
        status: status === 'ERROR' ? 'ERROR' : 'UPDATED',
        totalProcessed,
        successCount,
        insertedCount,
        updatedCount,
        failedCount,
        summary: summary.slice(0, 400),
        errorDetail,
        changedSkus: changedSkus.slice(0, 50),
        createdBy: (actorEmail || 'journal-pos-backend@system').slice(0, 128),
        createdAt: FieldValue.serverTimestamp(),
      });

      const prevCfg = (integrationSnap.exists ? integrationSnap.data() : {}) as Record<
        string,
        unknown
      >;
      const validSourceUrl = sourceBaseUrl.startsWith('https://journal.alpa.gdn')
        ? sourceBaseUrl.slice(0, 200)
        : DEFAULT_JOURNAL_POS_BASE_URL;
      const validPermanentUrl =
        typeof prevCfg.permanentStoreUrl === 'string' &&
        prevCfg.permanentStoreUrl.startsWith('https://')
          ? prevCfg.permanentStoreUrl.slice(0, 240)
          : '';

      await db.collection('integrationConfig').doc('journalPos').set({
        id: 'journalPos',
        sourceBaseUrl: validSourceUrl,
        autoSyncEnabled:
          typeof prevCfg.autoSyncEnabled === 'boolean' ? prevCfg.autoSyncEnabled : true,
        syncIntervalSeconds: Math.min(
          3600,
          Math.max(30, Math.floor(Number(prevCfg.syncIntervalSeconds) || syncIntervalSeconds || 60))
        ),
        signatureFormat:
          typeof prevCfg.signatureFormat === 'string'
            ? prevCfg.signatureFormat
            : signatureFormat,
        connectionStatus: status === 'ERROR' ? 'ERROR' : 'UPDATED',
        lastConnectionMessage: summary.slice(0, 300),
        lastSyncAt: syncedAtIso,
        lastSyncMode: trigger,
        lastSuccessCount: successCount,
        lastFailedCount: failedCount,
        lastUpdatedCount: updatedCount,
        lastInsertedCount: insertedCount,
        lastErrorDetail: errorDetail,
        permanentStoreUrl: validPermanentUrl,
        updatedBy: (actorEmail || 'journal-pos-backend@system').slice(0, 128),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    return {
      ok: status !== 'ERROR',
      status,
      totalProcessed,
      successCount,
      insertedCount,
      updatedCount,
      unchangedCount,
      priceChangedCount,
      stockChangedCount,
      priceChanges,
      failedCount,
      categoriesAdded,
      changedSkus,
      errors,
      summary,
      syncedAtIso,
      exchangeRateUsed: liveRate,
    };
  } catch (err) {
    const iamDenied = isFirestoreIamPermissionError(err);
    const errMsg = iamDenied
      ? 'Akses tulis Firestore dari server backend belum diizinkan (IAM roles/datastore.user belum diberikan ke akun layanan runtime pada proyek Firebase Anda).'
      : err instanceof Error
        ? err.message
        : 'Gagal menulis pembaruan Journal POS ke Firestore dari backend.';

    return {
      ok: false,
      iamPermissionDenied: iamDenied,
      status: 'ERROR',
      totalProcessed: records.length,
      successCount: 0,
      insertedCount: 0,
      updatedCount: 0,
      unchangedCount: 0,
      priceChangedCount: 0,
      stockChangedCount: 0,
      priceChanges: [],
      failedCount: records.length || 1,
      categoriesAdded: 0,
      changedSkus: [],
      errors: [errMsg],
      summary: errMsg,
      syncedAtIso,
      exchangeRateUsed: params.exchangeRateKhr || DEFAULT_EXCHANGE_RATE_KHR,
    };
  }
}

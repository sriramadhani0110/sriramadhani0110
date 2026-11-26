/**
 * Server-side Service Layer for JOURNAL POS Integration
 * Connects to JOURNAL_POS_BASE_URL using credentials strictly from process.env
 * and manages a periodic 1-minute (60,000 ms) product synchronization poller.
 */

import type { JournalPosSignatureFormat } from '../types/marketplace.ts';
import {
  DEFAULT_EXCHANGE_RATE_KHR,
  extractRawProductsList,
  fetchJournalPosWithRetry,
  getJournalPosServerCredentials,
  mapJournalPosRawProduct,
  probeJournalPosSignatureFormat,
  type MappedJournalPosRecord,
} from './journalPosAdapter.ts';
import {
  syncJournalPosRecordsToFirestoreServer,
  type ServerFirestoreSyncResult,
} from './journalPosFirestoreServerSync.ts';

export const DEFAULT_POLL_INTERVAL_MS = 60_000; // 1 minute
export const MIN_POLL_INTERVAL_MS = 30_000;
export const MAX_POLL_INTERVAL_MS = 3_600_000;

export interface FetchJournalPosProductsParams {
  signatureFormat?: string;
  sampleLimit?: number;
  exchangeRateKhr?: number;
  maxPages?: number;
}

export interface FetchJournalPosProductsResult {
  ok: boolean;
  httpStatus?: number;
  endpointUrl: string;
  latencyMs: number;
  totalFetched: number;
  records: MappedJournalPosRecord[];
  parseErrors: string[];
  reason?: string;
  message?: string;
}

export interface JournalPosPollerSnapshot {
  fetchedAt: string | null;
  snapshotVersion: string;
  endpointUrl: string;
  latencyMs: number;
  totalFetched: number;
  records: MappedJournalPosRecord[];
  parseErrors: string[];
}

export type ServerFirestoreSyncState =
  | 'IDLE'
  | 'SYNCED'
  | 'NO_CHANGES'
  | 'IAM_REQUIRED'
  | 'ERROR';

export interface JournalPosServiceStatus {
  enabled: boolean;
  running: boolean;
  credentialsConfigured: boolean;
  baseUrl: string;
  intervalMs: number;
  intervalSeconds: number;
  signatureFormat: JournalPosSignatureFormat;
  status: 'ONLINE' | 'SYNCING' | 'ERROR' | 'STANDBY';
  runCount: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  lastFetchedCount: number;
  lastError: string;
  firestoreSyncStatus: ServerFirestoreSyncState;
  lastFirestoreSyncAt: string | null;
  lastFirestorePriceChanges: number;
  lastFirestoreStockChanges: number;
  lastFirestoreSummary: string;
  lastFirestoreError: string;
}

/**
 * Fetches all (or sampled) products from JOURNAL_POS_BASE_URL/api/v1/products
 * using server-side process.env API credentials with automatic retries & pagination.
 */
export async function fetchJournalPosProductsService(
  params: FetchJournalPosProductsParams = {}
): Promise<FetchJournalPosProductsResult> {
  let creds;
  try {
    creds = getJournalPosServerCredentials(params.signatureFormat);
  } catch (err) {
    return {
      ok: false,
      endpointUrl: '',
      latencyMs: 0,
      totalFetched: 0,
      records: [],
      parseErrors: [],
      reason: 'INVALID_BASE_URL',
      message:
        err instanceof Error
          ? err.message
          : 'Konfigurasi URL JOURNAL_POS_BASE_URL tidak valid.',
    };
  }

  const defaultEndpoint = `${creds.baseUrl}/api/v1/products`;

  if (!creds.apiKey || !creds.apiSecret) {
    return {
      ok: false,
      endpointUrl: defaultEndpoint,
      latencyMs: 0,
      totalFetched: 0,
      records: [],
      parseErrors: [],
      reason: 'CREDENTIALS_MISSING',
      message:
        'JOURNAL_POS_API_KEY dan JOURNAL_POS_API_SECRET belum dikonfigurasi di Secrets server. Tambahkan kredensial resmi di panel Secrets agar sinkronisasi otomatis 1 menit berjalan.',
    };
  }

  const exchangeRateKhr =
    typeof params.exchangeRateKhr === 'number' && params.exchangeRateKhr >= 1000
      ? params.exchangeRateKhr
      : DEFAULT_EXCHANGE_RATE_KHR;
  const sampleLimit =
    typeof params.sampleLimit === 'number' && params.sampleLimit > 0
      ? Math.min(50, Math.floor(params.sampleLimit))
      : 0;
  const maxPages =
    sampleLimit > 0
      ? 1
      : Math.min(20, Math.max(1, Number(params.maxPages) || 10));

  const rawItems: Record<string, unknown>[] = [];
  let totalLatencyMs = 0;
  let lastEndpointUrl = defaultEndpoint;

  for (let page = 1; page <= maxPages; page++) {
    let result = await fetchJournalPosWithRetry({
      creds,
      endpointPath: '/api/v1/products',
      queryParams:
        sampleLimit > 0
          ? { page: 1, limit: sampleLimit, per_page: sampleLimit }
          : { page, limit: 100, per_page: 100 },
      maxRetries: 3,
      timeoutMs: 15_000,
    });
    totalLatencyMs += result.latencyMs;
    lastEndpointUrl = result.endpointUrl;

    // On page 1 HTTP 401/403, automatically probe alternate HMAC signature formats
    if (!result.ok && page === 1 && (result.status === 401 || result.status === 403)) {
      const probed = await probeJournalPosSignatureFormat(creds);
      if (probed.ok && probed.detectedSignatureFormat !== creds.signatureFormat) {
        creds = { ...creds, signatureFormat: probed.detectedSignatureFormat };
        pollerSignatureFormat = probed.detectedSignatureFormat;
        result = await fetchJournalPosWithRetry({
          creds,
          endpointPath: '/api/v1/products',
          queryParams:
            sampleLimit > 0
              ? { page: 1, limit: sampleLimit, per_page: sampleLimit }
              : { page, limit: 100, per_page: 100 },
          maxRetries: 2,
          timeoutMs: 15_000,
        });
        totalLatencyMs += result.latencyMs;
        lastEndpointUrl = result.endpointUrl;
      }
    }

    if (!result.ok) {
      if (page === 1) {
        return {
          ok: false,
          httpStatus: result.status,
          endpointUrl: result.endpointUrl,
          latencyMs: totalLatencyMs,
          totalFetched: 0,
          records: [],
          parseErrors: [],
          reason:
            result.status === 401 || result.status === 403
              ? 'UNAUTHORIZED'
              : 'FETCH_FAILED',
          message: `Gagal mengambil katalog dari JOURNAL POS (HTTP ${result.status || 'NETWORK'}): ${result.errorMessage || 'Koneksi gagal.'}`,
        };
      }
      break;
    }

    const pageItems = extractRawProductsList(result.data);
    if (pageItems.length === 0) {
      break;
    }
    rawItems.push(...pageItems);

    if (sampleLimit > 0 || pageItems.length < 100) {
      break;
    }
  }

  const slicedItems = sampleLimit > 0 ? rawItems.slice(0, sampleLimit) : rawItems;
  const records: MappedJournalPosRecord[] = [];
  const parseErrors: string[] = [];

  for (let i = 0; i < slicedItems.length; i++) {
    const mapped = mapJournalPosRawProduct(
      slicedItems[i],
      creds.baseUrl,
      exchangeRateKhr
    );
    if (mapped.ok) {
      records.push(mapped.record);
    } else {
      parseErrors.push(`Baris #${i + 1}: ${mapped.error}`);
    }
  }

  return {
    ok: true,
    httpStatus: 200,
    endpointUrl: lastEndpointUrl,
    latencyMs: totalLatencyMs,
    totalFetched: slicedItems.length,
    records,
    parseErrors,
  };
}

// =========================================================================
// Periodic 1-Minute Server Poller State
// =========================================================================
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollerEnabled = false;
let pollerRunning = false;
let pollerIntervalMs = DEFAULT_POLL_INTERVAL_MS;
let pollerSignatureFormat: JournalPosSignatureFormat = 'method_path_timestamp';
let pollerExchangeRateKhr = DEFAULT_EXCHANGE_RATE_KHR;
let pollerStatus: 'ONLINE' | 'SYNCING' | 'ERROR' | 'STANDBY' = 'STANDBY';
let pollerRunCount = 0;
let pollerLastRunAt: string | null = null;
let pollerLastSuccessAt: string | null = null;
let pollerNextRunAt: string | null = null;
let pollerLastError = '';
let lastCommittedSnapshotVersion = '';
let firestoreSyncStatus: ServerFirestoreSyncState = 'IDLE';
let lastFirestoreSyncAt: string | null = null;
let lastFirestorePriceChanges = 0;
let lastFirestoreStockChanges = 0;
let lastFirestoreSummary = '';
let lastFirestoreError = '';

let latestSnapshot: JournalPosPollerSnapshot = {
  fetchedAt: null,
  snapshotVersion: '',
  endpointUrl: '',
  latencyMs: 0,
  totalFetched: 0,
  records: [],
  parseErrors: [],
};

function computeSnapshotVersion(records: MappedJournalPosRecord[]): string {
  if (records.length === 0) return '';
  let hash = 2166136261;
  for (const r of records) {
    const p = r.publicProduct;
    const sig = `${p.externalId}|${p.sku}|${p.price}|${p.priceKhr}|${p.stock}|${p.isActive ? 1 : 0}|${p.promoActive ? 1 : 0}|${p.promoPriceUsd}|${p.sourceUpdatedAt}`;
    for (let i = 0; i < sig.length; i++) {
      hash ^= sig.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
  }
  return `${records.length}_${hash.toString(16)}`;
}

function computeNextRunIso(): string | null {
  if (!pollerEnabled) return null;
  return new Date(Date.now() + pollerIntervalMs).toISOString();
}

export async function runJournalPosPollCycle(
  overrideExchangeRateKhr?: number,
  options?: { forceFirestoreWrite?: boolean; actorEmail?: string }
): Promise<
  FetchJournalPosProductsResult & {
    firestoreSync?: ServerFirestoreSyncResult;
  }
> {
  if (
    typeof overrideExchangeRateKhr === 'number' &&
    Number.isFinite(overrideExchangeRateKhr) &&
    overrideExchangeRateKhr >= 1000
  ) {
    pollerExchangeRateKhr = overrideExchangeRateKhr;
  }

  if (pollerRunning) {
    return {
      ok: true,
      endpointUrl: latestSnapshot.endpointUrl,
      latencyMs: latestSnapshot.latencyMs,
      totalFetched: latestSnapshot.totalFetched,
      records: latestSnapshot.records,
      parseErrors: latestSnapshot.parseErrors,
      message: 'Siklus pengambilan data sedang berlangsung.',
    };
  }

  pollerRunning = true;
  pollerStatus = 'SYNCING';
  pollerLastRunAt = new Date().toISOString();
  pollerRunCount += 1;

  try {
    const res = await fetchJournalPosProductsService({
      signatureFormat: pollerSignatureFormat,
      exchangeRateKhr: pollerExchangeRateKhr,
    });

    let firestoreSync: ServerFirestoreSyncResult | undefined;

    if (res.ok) {
      pollerStatus = 'ONLINE';
      pollerLastSuccessAt = new Date().toISOString();
      pollerLastError = '';
      const nextVersion = computeSnapshotVersion(res.records);
      latestSnapshot = {
        fetchedAt: pollerLastSuccessAt,
        snapshotVersion: nextVersion,
        endpointUrl: res.endpointUrl,
        latencyMs: res.latencyMs,
        totalFetched: res.totalFetched,
        records: res.records,
        parseErrors: res.parseErrors,
      };

      const shouldCommitToFirestore =
        res.records.length > 0 &&
        (options?.forceFirestoreWrite === true ||
          nextVersion !== lastCommittedSnapshotVersion ||
          firestoreSyncStatus === 'IDLE');

      if (shouldCommitToFirestore) {
        const creds = getJournalPosServerCredentials(pollerSignatureFormat);
        firestoreSync = await syncJournalPosRecordsToFirestoreServer({
          records: res.records,
          parseErrors: res.parseErrors,
          trigger: options?.forceFirestoreWrite ? 'manual' : 'polling',
          actorEmail: options?.actorEmail || 'journal-pos-backend@system',
          sourceBaseUrl: creds.baseUrl,
          signatureFormat: pollerSignatureFormat,
          syncIntervalSeconds: Math.round(pollerIntervalMs / 1000),
          onlyChanged: !options?.forceFirestoreWrite,
        });

        if (firestoreSync.ok) {
          lastCommittedSnapshotVersion = nextVersion;
          lastFirestoreSyncAt = firestoreSync.syncedAtIso;
          lastFirestorePriceChanges = firestoreSync.priceChangedCount;
          lastFirestoreStockChanges = firestoreSync.stockChangedCount;
          lastFirestoreSummary = firestoreSync.summary;
          lastFirestoreError = '';
          firestoreSyncStatus =
            firestoreSync.status === 'NO_CHANGES' ? 'NO_CHANGES' : 'SYNCED';
        } else if (firestoreSync.iamPermissionDenied) {
          firestoreSyncStatus = 'IAM_REQUIRED';
          lastFirestoreError = firestoreSync.summary;
        } else {
          firestoreSyncStatus = 'ERROR';
          lastFirestoreError = firestoreSync.summary;
        }
      }
    } else {
      pollerStatus = res.reason === 'CREDENTIALS_MISSING' ? 'STANDBY' : 'ERROR';
      pollerLastError = res.message || 'Gagal mengambil data produk berkala.';
    }

    pollerNextRunAt = computeNextRunIso();
    return { ...res, firestoreSync };
  } catch (err) {
    pollerStatus = 'ERROR';
    pollerLastError =
      err instanceof Error ? err.message : 'Kesalahan tak terduga saat polling JOURNAL POS.';
    pollerNextRunAt = computeNextRunIso();
    return {
      ok: false,
      endpointUrl: latestSnapshot.endpointUrl,
      latencyMs: 0,
      totalFetched: 0,
      records: [],
      parseErrors: [],
      reason: 'POLL_EXCEPTION',
      message: pollerLastError,
    };
  } finally {
    pollerRunning = false;
  }
}

export function startJournalPosPeriodicSync(options?: {
  intervalMs?: number;
  signatureFormat?: string;
  exchangeRateKhr?: number;
  runImmediately?: boolean;
}): JournalPosServiceStatus {
  const requestedMs = Number(options?.intervalMs);
  if (Number.isFinite(requestedMs) && requestedMs > 0) {
    pollerIntervalMs = Math.min(
      MAX_POLL_INTERVAL_MS,
      Math.max(MIN_POLL_INTERVAL_MS, Math.round(requestedMs))
    );
  } else {
    pollerIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  }

  if (options?.signatureFormat) {
    const creds = getJournalPosServerCredentials(options.signatureFormat);
    pollerSignatureFormat = creds.signatureFormat;
  }

  if (
    typeof options?.exchangeRateKhr === 'number' &&
    Number.isFinite(options.exchangeRateKhr) &&
    options.exchangeRateKhr >= 1000
  ) {
    pollerExchangeRateKhr = options.exchangeRateKhr;
  }

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  pollerEnabled = true;
  pollerNextRunAt = computeNextRunIso();

  pollTimer = setInterval(() => {
    void runJournalPosPollCycle();
  }, pollerIntervalMs);

  // Do not block Node.js process shutdown
  if (typeof pollTimer.unref === 'function') {
    pollTimer.unref();
  }

  if (options?.runImmediately !== false) {
    void runJournalPosPollCycle();
  }

  return getJournalPosServiceStatus();
}

export function stopJournalPosPeriodicSync(): JournalPosServiceStatus {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  pollerEnabled = false;
  pollerNextRunAt = null;
  if (!pollerRunning) {
    pollerStatus = 'STANDBY';
  }
  return getJournalPosServiceStatus();
}

export function initJournalPosServiceOnBoot(): void {
  try {
    const creds = getJournalPosServerCredentials();
    pollerSignatureFormat = creds.signatureFormat;
    if (creds.apiKey.length >= 6 && creds.apiSecret.length >= 6) {
      startJournalPosPeriodicSync({
        intervalMs: DEFAULT_POLL_INTERVAL_MS,
        signatureFormat: creds.signatureFormat,
        runImmediately: true,
      });
    } else {
      pollerStatus = 'STANDBY';
      pollerLastError =
        'Menunggu JOURNAL_POS_API_KEY & JOURNAL_POS_API_SECRET di environment server untuk polling otomatis 1 menit.';
    }
  } catch (err) {
    pollerStatus = 'ERROR';
    pollerLastError =
      err instanceof Error ? err.message : 'Konfigurasi JOURNAL_POS_BASE_URL tidak valid.';
  }
}

export function getJournalPosServiceStatus(): JournalPosServiceStatus {
  let baseUrl = 'https://journal.alpa.gdn/web';
  let credentialsConfigured = false;
  try {
    const creds = getJournalPosServerCredentials(pollerSignatureFormat);
    baseUrl = creds.baseUrl;
    credentialsConfigured = creds.apiKey.length >= 6 && creds.apiSecret.length >= 6;
  } catch {
    // Keep fallback
  }

  return {
    enabled: pollerEnabled,
    running: pollerRunning,
    credentialsConfigured,
    baseUrl,
    intervalMs: pollerIntervalMs,
    intervalSeconds: Math.round(pollerIntervalMs / 1000),
    signatureFormat: pollerSignatureFormat,
    status: pollerStatus,
    runCount: pollerRunCount,
    lastRunAt: pollerLastRunAt,
    lastSuccessAt: pollerLastSuccessAt,
    nextRunAt: pollerNextRunAt,
    lastFetchedCount: latestSnapshot.records.length,
    lastError: pollerLastError,
    firestoreSyncStatus,
    lastFirestoreSyncAt,
    lastFirestorePriceChanges,
    lastFirestoreStockChanges,
    lastFirestoreSummary,
    lastFirestoreError,
  };
}

export function getLatestPolledSnapshot(): JournalPosPollerSnapshot {
  return {
    ...latestSnapshot,
    records: [...latestSnapshot.records],
    parseErrors: [...latestSnapshot.parseErrors],
  };
}

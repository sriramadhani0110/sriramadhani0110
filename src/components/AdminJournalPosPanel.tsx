import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Archive,
  Check,
  CheckCircle2,
  Clock,
  Cloud,
  Copy,
  Database,
  Download,
  ExternalLink,
  FileJson,
  FolderArchive,
  KeyRound,
  Link2,
  Lock,
  Play,
  RefreshCw,
  ShieldCheck,
  Upload,
  Webhook,
} from 'lucide-react';
import type { User } from 'firebase/auth';
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
} from 'firebase/firestore';
import type {
  BackupArchiveRecord,
  JournalPosConfig,
  JournalPosConnectionStatus,
  JournalPosSignatureFormat,
  JournalPosSyncLog,
  Product,
  ProductPrivateMeta,
  StoreCategory,
} from '../types/marketplace';
import { db } from '../lib/firebase';
import { formatKHR, formatUSD, getShareableOrigin } from '../lib/catalogSeed';
import type { MappedJournalPosRecord } from '../lib/journalPosAdapter';
import {
  applyJournalPosRecordsToFirestore,
  DEFAULT_JOURNAL_POS_CONFIG,
  recordJournalPosErrorLog,
  saveJournalPosConfig,
  type JournalPosPriceChangeEntry,
} from '../lib/journalPosSyncClient';
import { exportMasterFirestoreBackup } from '../lib/masterBackupExport';

interface AdminJournalPosPanelProps {
  user: User;
  products: Product[];
  categories: StoreCategory[];
  exchangeRateKhr?: number;
}

interface BackendPollerStatus {
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
  firestoreSyncStatus?: 'IDLE' | 'SYNCED' | 'NO_CHANGES' | 'IAM_REQUIRED' | 'ERROR';
  lastFirestoreSyncAt?: string | null;
  lastFirestorePriceChanges?: number;
  lastFirestoreStockChanges?: number;
  lastFirestoreSummary?: string;
  lastFirestoreError?: string;
}

interface BackendStatusResponse {
  ok: boolean;
  baseUrl: string;
  apiKeyConfigured: boolean;
  apiSecretConfigured: boolean;
  webhookSecretConfigured: boolean;
  signatureFormat: JournalPosSignatureFormat;
  discoveredEndpoints: {
    ping: string;
    products: string;
    requiredHeaders: string[];
  };
  webhookEndpointUrl: string;
  pendingWebhookCount: number;
  pollerStatus?: BackendPollerStatus;
}

interface QueuedWebhookEventPayload {
  eventId: string;
  receivedAt: string;
  eventType: string;
  records: MappedJournalPosRecord[];
  parseErrors: string[];
}

const MAPPED_18_FIELDS = [
  { no: 1, source: 'ID Produk', target: 'products.externalId', scope: 'Publik (Kunci Match)' },
  { no: 2, source: 'SKU / Kode Produk', target: 'products.sku', scope: 'Publik (Kunci Match)' },
  { no: 3, source: 'Barcode', target: 'products.barcode', scope: 'Publik' },
  { no: 4, source: 'Nama Item / Produk', target: 'products.name', scope: 'Publik' },
  { no: 5, source: 'Harga Jual USD', target: 'products.price', scope: 'Publik' },
  { no: 6, source: 'Harga Jual KHR', target: 'products.priceKhr', scope: 'Publik' },
  { no: 7, source: 'Harga Modal / Beli', target: 'productPrivateMeta.costPrice*', scope: 'KHUSUS ADMIN' },
  { no: 8, source: 'Link URL Gambar', target: 'products.imageUrl', scope: 'Publik' },
  { no: 9, source: 'Foto Produk', target: 'products.imageUrl', scope: 'Publik' },
  { no: 10, source: 'Jumlah Stok', target: 'products.stock', scope: 'Publik' },
  { no: 11, source: 'Deskripsi Produk', target: 'products.description', scope: 'Publik' },
  { no: 12, source: 'Kategori Produk', target: 'products.category + categories', scope: 'Publik' },
  { no: 13, source: 'Satuan Produk', target: 'products.unit', scope: 'Publik' },
  { no: 14, source: 'Status Produk', target: 'products.isActive', scope: 'Publik (Nonaktif = Sembunyi)' },
  { no: 15, source: 'Status Promosi', target: 'products.promoActive', scope: 'Publik' },
  { no: 16, source: 'Harga Promosi', target: 'products.promoPriceUsd/Khr', scope: 'Publik' },
  { no: 17, source: 'Periode Promosi', target: 'products.promoStart/EndDate', scope: 'Publik' },
  { no: 18, source: 'Tanggal Update Produk', target: 'products.sourceUpdatedAt', scope: 'Publik + Audit' },
];

function formatDateTimeId(isoOrTs: unknown): string {
  if (!isoOrTs) return 'Belum pernah';
  try {
    if (typeof isoOrTs === 'string') {
      const d = new Date(isoOrTs);
      if (Number.isNaN(d.getTime())) return isoOrTs;
      return d.toLocaleString('id-ID', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    }
    if (typeof isoOrTs === 'object' && isoOrTs !== null && 'toDate' in isoOrTs) {
      const d = (isoOrTs as { toDate: () => Date }).toDate();
      return d.toLocaleString('id-ID', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    }
  } catch {
    return String(isoOrTs);
  }
  return 'Belum pernah';
}

type SafeApiJsonResult<T> =
  | { ok: true; data: T }
  | { ok: false; isHtml: boolean; status: number; message: string };

async function safeParseApiJson<T>(
  res: Response,
  endpointLabel: string
): Promise<SafeApiJsonResult<T>> {
  const rawText = await res.text();
  const trimmed = rawText.trim();
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const looksLikeHtml =
    contentType.includes('text/html') ||
    /^<!doctype\s+html/i.test(trimmed) ||
    /^<html[\s>]/i.test(trimmed);

  if (looksLikeHtml) {
    const isAppShell =
      trimmed.includes('id="root"') ||
      trimmed.toLowerCase().includes('alpamart');
    const message = isAppShell
      ? `Server backend (${endpointLabel}) mengembalikan halaman HTML, bukan data JSON (HTTP ${res.status}). Pastikan Anda membuka aplikasi pada URL server aktif (bukan file statis/ZIP), lalu klik "Muat Ulang Halaman" agar tersambung ke server terbaru.`
      : `Sesi server preview (${endpointLabel}) sedang memuat ulang atau butuh refresh (HTTP ${res.status}). Klik "Muat Ulang Halaman" lalu coba kembali.`;
    return { ok: false, isHtml: true, status: res.status, message };
  }

  if (!trimmed) {
    return {
      ok: false,
      isHtml: false,
      status: res.status,
      message: `Server backend (${endpointLabel}) mengembalikan respons kosong (HTTP ${res.status}).`,
    };
  }

  try {
    return { ok: true, data: JSON.parse(trimmed) as T };
  } catch {
    return {
      ok: false,
      isHtml: false,
      status: res.status,
      message: `Respons server (${endpointLabel}) bukan format JSON yang valid (HTTP ${res.status}). Coba muat ulang halaman dan ulangi lagi.`,
    };
  }
}

export function AdminJournalPosPanel({
  user,
  products,
  categories,
  exchangeRateKhr = 4000,
}: AdminJournalPosPanelProps) {
  const adminEmail = user.email || 'admin@alpamart.online';

  const [config, setConfig] = useState<JournalPosConfig>(DEFAULT_JOURNAL_POS_CONFIG);
  const [backendStatus, setBackendStatus] = useState<BackendStatusResponse | null>(null);
  const [syncLogs, setSyncLogs] = useState<JournalPosSyncLog[]>([]);
  const [privateMetas, setPrivateMetas] = useState<ProductPrivateMeta[]>([]);
  const [backupRecords, setBackupRecords] = useState<BackupArchiveRecord[]>([]);

  const [liveStatus, setLiveStatus] = useState<JournalPosConnectionStatus>('ERROR');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [bannerFeedback, setBannerFeedback] = useState<{
    type: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [jsonInput, setJsonInput] = useState('');
  const [priceAndStockOnlyImport, setPriceAndStockOnlyImport] = useState(true);
  const [skipUnmatchedImport, setSkipUnmatchedImport] = useState(true);
  const [recentPriceChanges, setRecentPriceChanges] = useState<JournalPosPriceChangeEntry[]>([]);
  const [showJsonImporter, setShowJsonImporter] = useState(false);
  const [showMappingTable, setShowMappingTable] = useState(false);

  const [permanentUrlDraft, setPermanentUrlDraft] = useState('');
  const [autoSaveState, setAutoSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const initialLoadedRef = useRef(false);
  const syncingRef = useRef(false);
  const importerSectionRef = useRef<HTMLDivElement | null>(null);

  const getAuthHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const token = await user.getIdToken();
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }, [user]);

  const refreshBackendStatus = useCallback(async () => {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('/api/journal-pos/status', {
        headers,
        credentials: 'same-origin',
      });
      if (!res.ok) return;
      const parsed = await safeParseApiJson<BackendStatusResponse>(
        res,
        '/api/journal-pos/status'
      );
      if (parsed.ok && parsed.data.ok) {
        setBackendStatus(parsed.data);
      }
    } catch {
      // Ignore transient status fetch failure
    }
  }, [getAuthHeaders]);

  // Subscribe to persistent Firestore /integrationConfig/journalPos
  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, 'integrationConfig', 'journalPos'),
      (snap) => {
        if (snap.exists()) {
          const loaded = {
            ...DEFAULT_JOURNAL_POS_CONFIG,
            ...(snap.data() as Partial<JournalPosConfig>),
          };
          setConfig(loaded);
          if (!syncingRef.current) {
            setLiveStatus(loaded.connectionStatus);
          }
          if (!initialLoadedRef.current) {
            setPermanentUrlDraft(
              loaded.permanentStoreUrl || getShareableOrigin()
            );
            initialLoadedRef.current = true;
          }
        } else if (!initialLoadedRef.current) {
          setPermanentUrlDraft(getShareableOrigin());
          initialLoadedRef.current = true;
        }
      },
      () => {
        // Keep default config
      }
    );
    return () => unsub();
  }, []);

  // Subscribe to immutable /journalPosSyncLogs
  useEffect(() => {
    const q = query(
      collection(db, 'journalPosSyncLogs'),
      orderBy('createdAt', 'desc'),
      limit(20)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setSyncLogs(snap.docs.map((d) => d.data() as JournalPosSyncLog));
      },
      () => {
        setSyncLogs([]);
      }
    );
    return () => unsub();
  }, []);

  // Subscribe to Admin-only /productPrivateMeta (Cost / Buy Prices)
  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, 'productPrivateMeta'),
      (snap) => {
        setPrivateMetas(snap.docs.map((d) => d.data() as ProductPrivateMeta));
      },
      () => {
        setPrivateMetas([]);
      }
    );
    return () => unsub();
  }, []);

  // Subscribe to /backupArchives
  useEffect(() => {
    const q = query(
      collection(db, 'backupArchives'),
      orderBy('createdAt', 'desc'),
      limit(10)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setBackupRecords(snap.docs.map((d) => d.data() as BackupArchiveRecord));
      },
      () => {
        setBackupRecords([]);
      }
    );
    return () => unsub();
  }, []);

  useEffect(() => {
    void refreshBackendStatus();
  }, [refreshBackendStatus]);

  // Auto-save Permanent Store URL to Firestore after 1.5s idle
  useEffect(() => {
    if (!initialLoadedRef.current) return;
    const trimmed = permanentUrlDraft.trim();
    if (trimmed === (config.permanentStoreUrl || '')) return;
    if (trimmed && !trimmed.startsWith('https://')) return;

    setAutoSaveState('saving');
    const timer = setTimeout(() => {
      void saveJournalPosConfig(
        { ...config, permanentStoreUrl: trimmed },
        adminEmail
      )
        .then(() => {
          setAutoSaveState('saved');
          setTimeout(() => setAutoSaveState('idle'), 2500);
        })
        .catch(() => {
          setAutoSaveState('idle');
        });
    }, 1500);
    return () => clearTimeout(timer);
  }, [permanentUrlDraft, config, adminEmail]);

  const handleCopy = (key: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 2000);
  };

  const handleTestConnection = async () => {
    setBusyAction('test');
    setLiveStatus('SYNCING');
    setBannerFeedback(null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('/api/journal-pos/test-connection', {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        body: JSON.stringify({ signatureFormat: config.signatureFormat }),
      });
      const parsed = await safeParseApiJson<{
        ok: boolean;
        connectionStatus?: JournalPosConnectionStatus;
        detectedSignatureFormat?: JournalPosSignatureFormat;
        message?: string;
        reason?: string;
      }>(res, '/api/journal-pos/test-connection');

      if (!parsed.ok) {
        setLiveStatus('ERROR');
        setBannerFeedback({ type: 'error', text: parsed.message });
        return;
      }

      const data = parsed.data;
      const nextStatus: JournalPosConnectionStatus = data.ok ? 'ONLINE' : 'ERROR';
      const resolvedSigFormat = data.detectedSignatureFormat || config.signatureFormat;
      setLiveStatus(nextStatus);
      await saveJournalPosConfig(
        {
          ...config,
          signatureFormat: resolvedSigFormat,
          autoSyncEnabled: data.ok ? true : config.autoSyncEnabled,
          connectionStatus: nextStatus,
          lastConnectionMessage: data.message || (data.ok ? 'Koneksi berhasil.' : 'Koneksi gagal.'),
          lastErrorDetail: data.ok ? '' : data.message || 'Koneksi gagal.',
        },
        adminEmail
      );
      setBannerFeedback({
        type: data.ok ? 'success' : 'error',
        text: data.ok
          ? `${data.message || 'Koneksi ke JOURNAL POS ONLINE.'} Auto-Sync otomatis diaktifkan untuk seluruh akun.`
          : data.message || 'Gagal terhubung ke JOURNAL POS.',
      });
      await refreshBackendStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gagal menghubungi server backend.';
      setLiveStatus('ERROR');
      setBannerFeedback({ type: 'error', text: msg });
    } finally {
      setBusyAction(null);
    }
  };

  const runApiSync = useCallback(
    async (mode: 'manual' | 'sample_test' | 'polling') => {
      if (syncingRef.current) return;
      syncingRef.current = true;
      setBusyAction(mode);
      setLiveStatus('SYNCING');
      if (mode !== 'polling') {
        setBannerFeedback(null);
      }

      try {
        const headers = await getAuthHeaders();
        const requestBody = JSON.stringify({
          signatureFormat: config.signatureFormat,
          sampleLimit: mode === 'sample_test' ? 5 : 0,
          exchangeRateKhr,
          onlyChanged: mode === 'polling',
        });

        let res = await fetch('/api/journal-pos/sync-now', {
          method: 'POST',
          headers,
          credentials: 'same-origin',
          body: requestBody,
        });

        type SyncApiPayload = {
          ok: boolean;
          mode?: 'server_direct' | 'client_fallback';
          iamPermissionDenied?: boolean;
          message?: string;
          reason?: string;
          firestoreSync?: {
            ok: boolean;
            status: JournalPosConnectionStatus;
            summary: string;
            priceChanges?: JournalPosPriceChangeEntry[];
            priceChangedCount?: number;
            stockChangedCount?: number;
          };
          pollerStatus?: BackendPollerStatus;
          records?: MappedJournalPosRecord[];
          parseErrors?: string[];
        };

        let parsed = await safeParseApiJson<SyncApiPayload>(res, '/api/journal-pos/sync-now');

        // Automatic fallback to /api/journal-pos/fetch-products if an older instance doesn't serve /sync-now yet
        let usedLegacyFetchEndpoint = false;
        if (!parsed.ok && (parsed.status === 404 || parsed.isHtml)) {
          const fallbackRes = await fetch('/api/journal-pos/fetch-products', {
            method: 'POST',
            headers,
            credentials: 'same-origin',
            body: requestBody,
          });
          const fallbackParsed = await safeParseApiJson<SyncApiPayload>(
            fallbackRes,
            '/api/journal-pos/fetch-products'
          );
          if (fallbackParsed.ok) {
            res = fallbackRes;
            parsed = fallbackParsed;
            usedLegacyFetchEndpoint = true;
          }
        }

        if (!parsed.ok) {
          setLiveStatus('ERROR');
          await recordJournalPosErrorLog({
            trigger: mode,
            summary: `Sinkronisasi ${mode} gagal: respons server bukan JSON.`,
            errorDetail: parsed.message,
            adminEmail,
            currentConfig: config,
          });
          if (mode !== 'polling') {
            setBannerFeedback({ type: 'error', text: parsed.message });
          }
          return;
        }

        const data = parsed.data;

        if (data.pollerStatus) {
          setBackendStatus((prev) =>
            prev ? { ...prev, pollerStatus: data.pollerStatus } : prev
          );
        }

        // 1. Direct Backend -> Firestore sync succeeded (no browser write needed)
        if (res.ok && data.ok && data.mode === 'server_direct' && data.firestoreSync) {
          if (
            Array.isArray(data.firestoreSync.priceChanges) &&
            data.firestoreSync.priceChanges.length > 0
          ) {
            setRecentPriceChanges(data.firestoreSync.priceChanges);
          }
          setLiveStatus(data.firestoreSync.status || 'UPDATED');
          setBannerFeedback({
            type: 'success',
            text:
              data.firestoreSync.summary ||
              data.message ||
              'Sinkronisasi langsung server ke Firestore selesai. Semua portal pelanggan otomatis ter-update.',
          });
          void refreshBackendStatus();
          return;
        }

        // 2. Seamless client fallback if IAM is pending OR legacy /fetch-products returned records
        if (
          res.ok &&
          Array.isArray(data.records) &&
          (data.iamPermissionDenied || (usedLegacyFetchEndpoint && data.ok))
        ) {
          const result = await applyJournalPosRecordsToFirestore({
            records: data.records,
            parseErrors: data.parseErrors || [],
            existingProducts: products,
            existingCategories: categories,
            trigger: mode,
            adminEmail,
            currentConfig: config,
            exchangeRateKhr,
          });
          if (result.priceChanges.length > 0) {
            setRecentPriceChanges(result.priceChanges);
          }
          setLiveStatus(result.status);
          setBannerFeedback({
            type: result.status === 'UPDATED' ? 'success' : 'error',
            text: data.iamPermissionDenied
              ? `${result.summary} (Catatan: tambahkan peran IAM Cloud Datastore User agar server dapat memperbarui Firestore otomatis 24/7 tanpa browser dibuka.)`
              : result.summary,
          });
          void refreshBackendStatus();
          return;
        }

        // 3. Real API fetch or sync error
        const errMsg = data.message || 'Gagal mengambil data produk dari JOURNAL POS.';
        setLiveStatus('ERROR');
        await recordJournalPosErrorLog({
          trigger: mode,
          summary: `Sinkronisasi ${mode} gagal: API JOURNAL POS tidak merespons sukses.`,
          errorDetail: errMsg,
          adminEmail,
          currentConfig: config,
        });
        if (mode !== 'polling') {
          setBannerFeedback({ type: 'error', text: errMsg });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Terjadi kesalahan saat sinkronisasi.';
        setLiveStatus('ERROR');
        await recordJournalPosErrorLog({
          trigger: mode,
          summary: `Sinkronisasi ${mode} terputus.`,
          errorDetail: errMsg,
          adminEmail,
          currentConfig: config,
        }).catch(() => undefined);
        if (mode !== 'polling') {
          setBannerFeedback({ type: 'error', text: errMsg });
        }
      } finally {
        syncingRef.current = false;
        setBusyAction(null);
      }
    },
    [
      adminEmail,
      categories,
      config,
      exchangeRateKhr,
      getAuthHeaders,
      products,
      refreshBackendStatus,
    ]
  );

  // Drain incoming verified real-time webhook queue from backend into Firestore
  const drainWebhookQueue = useCallback(async () => {
    if (syncingRef.current) return;
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('/api/journal-pos/webhook-events', {
        headers,
        credentials: 'same-origin',
      });
      if (!res.ok) return;
      const parsed = await safeParseApiJson<{ ok?: boolean; events?: QueuedWebhookEventPayload[] }>(
        res,
        '/api/journal-pos/webhook-events'
      );
      if (!parsed.ok) return;
      const data = parsed.data;
      if (!data.ok || !Array.isArray(data.events) || data.events.length === 0) return;

      syncingRef.current = true;
      setLiveStatus('SYNCING');
      const allRecords: MappedJournalPosRecord[] = [];
      const allErrors: string[] = [];
      const eventIds: string[] = [];

      for (const evt of data.events) {
        eventIds.push(evt.eventId);
        allRecords.push(...(evt.records || []));
        allErrors.push(...(evt.parseErrors || []));
      }

      if (allRecords.length > 0) {
        const result = await applyJournalPosRecordsToFirestore({
          records: allRecords,
          parseErrors: allErrors,
          existingProducts: products,
          existingCategories: categories,
          trigger: 'webhook',
          adminEmail,
          currentConfig: config,
          exchangeRateKhr,
        });
        if (result.priceChanges.length > 0) {
          setRecentPriceChanges(result.priceChanges);
        }
        setLiveStatus(result.status);
        setBannerFeedback({
          type: 'success',
          text: `Webhook Real-Time diterima: ${result.summary}`,
        });
      }

      await fetch('/api/journal-pos/webhook-events/ack', {
        method: 'POST',
        headers,
        body: JSON.stringify({ eventIds }),
      });
      await refreshBackendStatus();
    } catch {
      // Ignore silent background webhook drain error
    } finally {
      syncingRef.current = false;
    }
  }, [adminEmail, categories, config, getAuthHeaders, products, refreshBackendStatus]);

  // Auto-Sync scheduler: prioritize real-time webhook drain (15s) + fallback API polling (every 60s)
  useEffect(() => {
    if (!config.autoSyncEnabled) return;
    const webhookTimer = setInterval(() => {
      void drainWebhookQueue();
    }, 15_000);

    const pollIntervalMs = Math.max(30, config.syncIntervalSeconds || 60) * 1000;
    const pollTimer = setInterval(() => {
      if (backendStatus?.apiKeyConfigured && backendStatus?.apiSecretConfigured) {
        void runApiSync('polling');
      }
    }, pollIntervalMs);

    return () => {
      clearInterval(webhookTimer);
      clearInterval(pollTimer);
    };
  }, [
    backendStatus?.apiKeyConfigured,
    backendStatus?.apiSecretConfigured,
    config.autoSyncEnabled,
    config.syncIntervalSeconds,
    drainWebhookQueue,
    runApiSync,
  ]);

  const handleToggleAutoSync = async () => {
    const nextVal = !config.autoSyncEnabled;
    await saveJournalPosConfig({ ...config, autoSyncEnabled: nextVal }, adminEmail);
    setBannerFeedback({
      type: 'info',
      text: nextVal
        ? `Sinkronisasi Otomatis AKTIF (Webhook Real-Time + Polling ${config.syncIntervalSeconds || 60} detik).`
        : 'Sinkronisasi Otomatis DINONAKTIFKAN.',
    });
  };

  const handleChangeSignatureFormat = async (nextFmt: JournalPosSignatureFormat) => {
    await saveJournalPosConfig({ ...config, signatureFormat: nextFmt }, adminEmail);
    setBannerFeedback({
      type: 'info',
      text: `Format tanda tangan HMAC disimpan permanen: ${nextFmt}`,
    });
  };

  const handleChangeInterval = async (seconds: number) => {
    await saveJournalPosConfig({ ...config, syncIntervalSeconds: seconds }, adminEmail);
  };

  const handleControlBackendPoller = async (payload: {
    enabled?: boolean;
    intervalSeconds?: number;
    triggerNow?: boolean;
  }) => {
    setBusyAction('backend_poller');
    setBannerFeedback(null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('/api/journal-pos/scheduler', {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        body: JSON.stringify({
          ...payload,
          signatureFormat: config.signatureFormat,
          exchangeRateKhr,
        }),
      });
      const parsed = await safeParseApiJson<{
        ok?: boolean;
        message?: string;
        pollerStatus?: BackendPollerStatus;
      }>(res, '/api/journal-pos/scheduler');
      if (!parsed.ok) {
        setBannerFeedback({ type: 'error', text: parsed.message });
        return;
      }
      const data = parsed.data;
      if (data.pollerStatus) {
        setBackendStatus((prev) =>
          prev ? { ...prev, pollerStatus: data.pollerStatus } : prev
        );
      }
      setBannerFeedback({
        type: data.ok ? 'success' : 'error',
        text:
          data.message ||
          (payload.enabled === false
            ? 'Layanan polling berkala server (1 menit) dihentikan.'
            : 'Layanan polling berkala server (setiap 1 menit) diaktifkan.'),
      });
      await refreshBackendStatus();
    } catch (err) {
      setBannerFeedback({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Gagal mengatur layanan polling berkala server.',
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleApplyServerSnapshot = async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setBusyAction('apply_snapshot');
    setLiveStatus('SYNCING');
    setBannerFeedback(null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('/api/journal-pos/latest-snapshot', {
        headers,
        credentials: 'same-origin',
      });
      const parsed = await safeParseApiJson<{
        ok?: boolean;
        snapshot?: {
          fetchedAt: string | null;
          records: MappedJournalPosRecord[];
          parseErrors: string[];
        };
      }>(res, '/api/journal-pos/latest-snapshot');
      if (!parsed.ok) {
        setLiveStatus('ERROR');
        setBannerFeedback({ type: 'error', text: parsed.message });
        return;
      }
      const data = parsed.data;
      const records = data.snapshot?.records || [];
      if (!data.ok || records.length === 0) {
        setLiveStatus('ERROR');
        setBannerFeedback({
          type: 'error',
          text: 'Belum ada snapshot produk tersimpan di server. Pastikan JOURNAL_POS_API_KEY & JOURNAL_POS_API_SECRET sudah diisi lalu jalankan polling server.',
        });
        return;
      }

      const result = await applyJournalPosRecordsToFirestore({
        records,
        parseErrors: data.snapshot?.parseErrors || [],
        existingProducts: products,
        existingCategories: categories,
        trigger: 'polling',
        adminEmail,
        currentConfig: config,
        exchangeRateKhr,
      });
      if (result.priceChanges.length > 0) {
        setRecentPriceChanges(result.priceChanges);
      }
      setLiveStatus(result.status);
      setBannerFeedback({
        type: result.status === 'UPDATED' ? 'success' : 'error',
        text: `Snapshot Server Diterapkan: ${result.summary}`,
      });
    } catch (err) {
      setLiveStatus('ERROR');
      setBannerFeedback({
        type: 'error',
        text:
          err instanceof Error
            ? err.message
            : 'Gagal menerapkan snapshot server ke Firestore.',
      });
    } finally {
      syncingRef.current = false;
      setBusyAction(null);
    }
  };

  const handleImportJournalJson = async () => {
    if (!jsonInput.trim()) {
      setBannerFeedback({
        type: 'error',
        text: 'Tempelkan atau unggah file JSON produk resmi dari JOURNAL POS terlebih dahulu.',
      });
      return;
    }
    setBusyAction('json_import');
    setLiveStatus('SYNCING');
    setBannerFeedback(null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('/api/journal-pos/parse-json', {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        body: JSON.stringify({ rawJson: jsonInput, exchangeRateKhr }),
      });
      const parsed = await safeParseApiJson<{
        ok: boolean;
        message?: string;
        records?: MappedJournalPosRecord[];
        parseErrors?: string[];
      }>(res, '/api/journal-pos/parse-json');

      if (!parsed.ok) {
        setLiveStatus('ERROR');
        setBannerFeedback({ type: 'error', text: parsed.message });
        return;
      }
      const data = parsed.data;

      if (!res.ok || !data.ok) {
        setLiveStatus('ERROR');
        setBannerFeedback({
          type: 'error',
          text: data.message || 'Gagal memvalidasi JSON JOURNAL POS.',
        });
        return;
      }

      const result = await applyJournalPosRecordsToFirestore({
        records: data.records || [],
        parseErrors: data.parseErrors || [],
        existingProducts: products,
        existingCategories: categories,
        trigger: 'json_import',
        adminEmail,
        currentConfig: config,
        exchangeRateKhr,
        priceAndStockOnly: priceAndStockOnlyImport,
        skipUnmatchedNewItems: skipUnmatchedImport,
      });
      if (result.priceChanges.length > 0) {
        setRecentPriceChanges(result.priceChanges);
      }
      setLiveStatus(result.status);
      setBannerFeedback({
        type: result.status === 'UPDATED' ? 'success' : 'error',
        text: result.summary,
      });
      setJsonInput('');
      setShowJsonImporter(false);
    } catch (err) {
      setLiveStatus('ERROR');
      setBannerFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal memproses JSON JOURNAL POS.',
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleJsonFileUpload = (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setJsonInput(reader.result);
      }
    };
    reader.readAsText(file);
  };

  const handleMasterBackup = async (format: 'json' | 'zip') => {
    setBusyAction(`backup_${format}`);
    setBannerFeedback(null);
    try {
      const res = await exportMasterFirestoreBackup({
        format,
        adminEmail,
      });
      setBannerFeedback({
        type: 'success',
        text: `Backup Master ${format.toUpperCase()} berhasil diunduh (${res.filename} · ${res.totalDocuments} dokumen dari ${res.collectionsIncluded.length} koleksi).`,
      });
    } catch (err) {
      setBannerFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Gagal mengekspor backup data master.',
      });
    } finally {
      setBusyAction(null);
    }
  };

  const costMetaByProductId = useMemo(() => {
    const map = new Map<string, ProductPrivateMeta>();
    for (const m of privateMetas) {
      map.set(m.productId, m);
    }
    return map;
  }, [privateMetas]);

  const syncedProductsList = useMemo(
    () => products.filter((p) => p.syncSource === 'journal_pos' || costMetaByProductId.has(p.id)),
    [products, costMetaByProductId]
  );

  const statusBadgeStyle = (() => {
    switch (liveStatus) {
      case 'ONLINE':
        return 'bg-emerald-100 text-emerald-800 border-emerald-300';
      case 'SYNCING':
        return 'bg-blue-100 text-blue-800 border-blue-300';
      case 'UPDATED':
        return 'bg-teal-100 text-teal-800 border-teal-300';
      case 'ERROR':
      default:
        return 'bg-red-100 text-red-800 border-red-300';
    }
  })();

  const statusLabelDesc: Record<JournalPosConnectionStatus, string> = {
    ONLINE: 'Koneksi berhasil ke JOURNAL POS',
    SYNCING: 'Sedang menyinkronkan data produk...',
    ERROR: 'Koneksi bermasalah / kredensial API belum aktif',
    UPDATED: 'Data produk berhasil diperbarui',
  };

  const credsReady = Boolean(
    backendStatus?.apiKeyConfigured && backendStatus?.apiSecretConfigured
  );

  return (
    <div className="space-y-6">
      {/* Header & Live Status Indicator */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="font-display text-xl font-bold text-slate-900">
                INTEGRASI JOURNAL POS
              </h2>
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono font-bold border rounded-md ${statusBadgeStyle}`}
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    liveStatus === 'SYNCING'
                      ? 'bg-blue-600 animate-ping'
                      : liveStatus === 'ONLINE'
                        ? 'bg-emerald-600'
                        : liveStatus === 'UPDATED'
                          ? 'bg-teal-600'
                          : 'bg-red-600'
                  }`}
                />
                {liveStatus}
              </span>
            </div>
            <p className="text-sm text-slate-600">
              Master Database Sumber:{' '}
              <span className="font-mono font-semibold text-blue-700">
                https://journal.alpa.gdn/web/
              </span>{' '}
              → ALPAMART TRIMULIA ONLINE ({statusLabelDesc[liveStatus]})
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={handleTestConnection}
              className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
            >
              <Activity className={`w-4 h-4 ${busyAction === 'test' ? 'animate-spin' : ''}`} />
              Tes Koneksi API
            </button>
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => void runApiSync('sample_test')}
              className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" />
              Uji 5 Produk
            </button>
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => void runApiSync('manual')}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-red-600 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${busyAction === 'manual' ? 'animate-spin' : ''}`} />
              SINKRONKAN SEKARANG
            </button>
          </div>
        </div>

        {bannerFeedback && (
          <div
            className={`p-3.5 rounded-lg border text-sm flex items-start gap-2.5 ${
              bannerFeedback.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : bannerFeedback.type === 'error'
                  ? 'bg-red-50 border-red-200 text-red-900'
                  : 'bg-blue-50 border-blue-200 text-blue-900'
            }`}
          >
            {bannerFeedback.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600" />
            ) : (
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-600" />
            )}
            <div className="flex-1 space-y-2">
              <p className="leading-relaxed">{bannerFeedback.text}</p>
              {bannerFeedback.type === 'error' &&
                (bannerFeedback.text.includes('Muat Ulang') ||
                  bannerFeedback.text.includes('HTML') ||
                  bannerFeedback.text.includes('JSON')) && (
                  <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-red-700 hover:bg-red-800 text-white rounded-md cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Muat Ulang Halaman
                  </button>
                )}
            </div>
          </div>
        )}

        {/* KPI Counters (Features 7, 8, 9, 10) */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Produk Berhasil
            </p>
            <p className="mt-1 font-mono text-2xl font-bold text-emerald-700 tabular-nums">
              {config.lastSuccessCount}
            </p>
          </div>
          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Produk Diperbarui
            </p>
            <p className="mt-1 font-mono text-2xl font-bold text-blue-700 tabular-nums">
              {config.lastUpdatedCount}
              <span className="text-xs font-normal text-slate-500 ml-1.5">
                (+{config.lastInsertedCount} baru)
              </span>
            </p>
          </div>
          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Produk Gagal
            </p>
            <p className="mt-1 font-mono text-2xl font-bold text-red-600 tabular-nums">
              {config.lastFailedCount}
            </p>
          </div>
          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg col-span-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Waktu Sinkronisasi Terakhir
            </p>
            <p className="mt-1 text-sm font-semibold text-slate-900 flex items-center gap-1.5">
              <Clock className="w-4 h-4 text-blue-700 shrink-0" />
              {formatDateTimeId(config.lastSyncAt)}
            </p>
            <p className="text-[11px] text-slate-500 mt-0.5 truncate">
              Mode terakhir: {config.lastSyncMode || 'manual'} · Total katalog: {products.length} item
            </p>
          </div>
        </div>

        {/* Error Detail Box (Feature 11) */}
        {config.lastErrorDetail && (
          <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg space-y-1">
            <p className="text-xs font-bold text-red-800 flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4" />
              Detail Kesalahan Sinkronisasi Terakhir
            </p>
            <p className="text-xs font-mono text-red-900 break-words leading-relaxed">
              {config.lastErrorDetail}
            </p>
          </div>
        )}
      </div>

      {/* Section 1: Hubungkan Akun JOURNAL POS + Auto Sync ON/OFF */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-blue-700" />
              1. Hubungkan Akun JOURNAL POS (Backend Secrets)
            </h3>
            <span
              className={`text-[11px] font-mono font-bold px-2 py-0.5 rounded border ${
                credsReady
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : 'bg-amber-50 text-amber-800 border-amber-200'
              }`}
            >
              {credsReady ? 'API KEY AKTIF' : 'BELUM TERKONFIGURASI'}
            </span>
          </div>

          <p className="text-xs text-slate-600 leading-relaxed">
            Endpoint resmi JOURNAL POS yang terverifikasi aktif:{' '}
            <code className="px-1.5 py-0.5 bg-slate-100 rounded text-slate-800">
              GET https://journal.alpa.gdn/web/api/v1/products
            </code>{' '}
            (wajib header <code className="text-slate-800">X-Api-Key</code>,{' '}
            <code className="text-slate-800">X-Timestamp</code>,{' '}
            <code className="text-slate-800">X-Signature</code>). Demi keamanan, API Key & Secret
            disimpan hanya di <strong>Secrets server</strong> — tidak pernah di browser.
          </p>

          <div className="space-y-2 text-xs">
            <div className="flex items-center justify-between p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
              <span className="font-mono text-slate-700">JOURNAL_POS_API_KEY</span>
              <span
                className={`font-semibold ${
                  backendStatus?.apiKeyConfigured ? 'text-emerald-700' : 'text-red-600'
                }`}
              >
                {backendStatus?.apiKeyConfigured ? 'Tersimpan di Server' : 'Belum Diisi'}
              </span>
            </div>
            <div className="flex items-center justify-between p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
              <span className="font-mono text-slate-700">JOURNAL_POS_API_SECRET</span>
              <span
                className={`font-semibold ${
                  backendStatus?.apiSecretConfigured ? 'text-emerald-700' : 'text-red-600'
                }`}
              >
                {backendStatus?.apiSecretConfigured ? 'Tersimpan di Server' : 'Belum Diisi'}
              </span>
            </div>
            <div className="flex items-center justify-between p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
              <span className="font-mono text-slate-700">JOURNAL_POS_WEBHOOK_SECRET</span>
              <span
                className={`font-semibold ${
                  backendStatus?.webhookSecretConfigured ? 'text-emerald-700' : 'text-amber-700'
                }`}
              >
                {backendStatus?.webhookSecretConfigured ? 'Aktif (HMAC-SHA256)' : 'Opsional / Belum Diisi'}
              </span>
            </div>
          </div>

          {!credsReady && (
            <div className="p-3.5 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-950 space-y-2.5">
              <p className="font-bold text-blue-900">
                Belum Tahu API Key Journal POS? Ini 2 Cara Mudah Sync Stok Sekarang:
              </p>
              <div className="p-2.5 bg-white border border-blue-200 rounded-md space-y-1.5">
                <p className="font-bold text-emerald-800">
                  Cara 1 — Langsung Jalan Sekarang TANPA API Key (Export CSV/JSON):
                </p>
                <p className="text-[11px] text-slate-700 leading-relaxed">
                  Login ke{' '}
                  <a
                    href="https://journal.alpa.gdn/web/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold text-blue-700 underline inline-flex items-center gap-0.5"
                  >
                    journal.alpa.gdn/web/
                    <ExternalLink className="w-3 h-3" />
                  </a>{' '}
                  lalu export daftar produk/stok (CSV/JSON), kemudian unggah di sini — stok langsung diganti persis sesuai Journal POS tanpa dobel produk.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setShowJsonImporter(true);
                    setTimeout(() => {
                      importerSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }, 60);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-md cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5" />
                  Upload File Stok Journal POS Sekarang (Tanpa API Key)
                </button>
              </div>

              <div className="p-2.5 bg-white border border-blue-200 rounded-md space-y-1.5">
                <p className="font-bold text-blue-900">
                  Cara 2 — Otomatis 24 Jam Tiap 1 Menit (Cukup Minta 2 Kode ke Admin/IT Journal):
                </p>
                <p className="text-[11px] text-slate-700 leading-relaxed">
                  Server <code className="px-1 bg-slate-100 rounded">journal.alpa.gdn</code> dikunci demi keamanan toko Anda.{' '}
                  <strong>JOURNAL_POS_WEBHOOK_SECRET TIDAK WAJIB (boleh kosong)</strong> — cukup minta 2 kode saja (
                  <code className="px-1 bg-slate-100 rounded">JOURNAL_POS_API_KEY</code> &amp;{' '}
                  <code className="px-1 bg-slate-100 rounded">JOURNAL_POS_API_SECRET</code>), lalu tempel di{' '}
                  <strong>Settings → Secrets</strong> AI Studio. Setelah ditempel, sync otomatis 1 menit langsung aktif sendiri!
                </p>
                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  <button
                    type="button"
                    onClick={() => {
                      const webhookUrl =
                        backendStatus?.webhookEndpointUrl ||
                        `${getShareableOrigin()}/api/journal-pos/webhook`;
                      const templateMsg = [
                        'Halo Admin / Tim IT Journal POS (journal.alpa.gdn),',
                        'Mohon bantuannya untuk mengirimkan kredensial API resmi toko ALPAMART TRIMULIA agar stok & harga di website online kami bisa sinkron otomatis setiap menit:',
                        '1. POS API Key (untuk header X-Api-Key)',
                        '2. POS API Secret (untuk tanda tangan X-Signature)',
                        '3. (Opsional) Webhook Secret — jika tersedia, mohon arahkan Webhook ke URL:',
                        webhookUrl,
                        'Terima kasih banyak!',
                      ].join('\n');
                      handleCopy('ask_it_template', templateMsg);
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold text-white bg-blue-700 hover:bg-blue-800 rounded-md cursor-pointer"
                  >
                    {copiedKey === 'ask_it_template' ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    {copiedKey === 'ask_it_template'
                      ? 'Pesan Disalin — Tinggal Kirim WA/Telegram!'
                      : 'Salin Pesan Minta API Key ke Admin / IT Journal'}
                  </button>
                  <a
                    href="https://journal.alpa.gdn/web/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-md"
                  >
                    Buka journal.alpa.gdn
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>
            </div>
          )}

          <div className="space-y-1.5 pt-1">
            <label className="text-xs font-semibold text-slate-700 block">
              Format Canonical X-Signature (HMAC-SHA256)
            </label>
            <select
              value={config.signatureFormat}
              onChange={(e) =>
                void handleChangeSignatureFormat(e.target.value as JournalPosSignatureFormat)
              }
              className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-300 rounded-lg text-slate-900"
            >
              <option value="method_path_timestamp">METHOD\nPATH\nTIMESTAMP (Default)</option>
              <option value="timestamp_method_path">TIMESTAMP\nMETHOD\nPATH</option>
              <option value="timestamp_path">TIMESTAMP:PATH</option>
              <option value="timestamp_only">TIMESTAMP</option>
            </select>
            <p className="text-[11px] text-slate-500">
              Sesuaikan dengan spesifikasi HMAC resmi dari tim developer JOURNAL POS jika tes koneksi mengembalikan 401.
            </p>
          </div>
        </div>

        {/* Auto-Sync & Real-Time Webhook */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <Webhook className="w-4 h-4 text-blue-700" />
              2. Auto-Sync (Webhook Real-Time + Polling)
            </h3>
            <button
              type="button"
              onClick={() => void handleToggleAutoSync()}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition-colors cursor-pointer ${
                config.autoSyncEnabled
                  ? 'bg-emerald-600 text-white border-emerald-600'
                  : 'bg-slate-100 text-slate-700 border-slate-300 hover:bg-slate-200'
              }`}
            >
              Auto-Sync: {config.autoSyncEnabled ? 'ON' : 'OFF'}
            </button>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-700 block">
              URL Endpoint Webhook Real-Time (Daftarkan di JOURNAL POS)
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={
                  backendStatus?.webhookEndpointUrl ||
                  `${getShareableOrigin()}/api/journal-pos/webhook`
                }
                className="flex-1 px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-300 rounded-lg text-slate-800"
              />
              <button
                type="button"
                onClick={() =>
                  handleCopy(
                    'webhook',
                    backendStatus?.webhookEndpointUrl ||
                      `${getShareableOrigin()}/api/journal-pos/webhook`
                  )
                }
                className="inline-flex items-center gap-1 px-3 py-2 text-xs font-semibold bg-slate-900 text-white rounded-lg hover:bg-blue-700 cursor-pointer shrink-0"
              >
                {copiedKey === 'webhook' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedKey === 'webhook' ? 'Disalin' : 'Salin'}
              </button>
            </div>
            <p className="text-[11px] text-slate-500">
              Antrian Webhook masuk saat ini:{' '}
              <span className="font-mono font-bold text-slate-800">
                {backendStatus?.pendingWebhookCount ?? 0}
              </span>{' '}
              event.{' '}
              {(backendStatus?.pendingWebhookCount ?? 0) > 0 && (
                <button
                  type="button"
                  onClick={() => void drainWebhookQueue()}
                  className="text-blue-700 font-semibold underline ml-1 cursor-pointer"
                >
                  Proses Sekarang
                </button>
              )}
            </p>
          </div>

          <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-100">
            <div>
              <p className="text-xs font-semibold text-slate-800">
                Interval Polling Cadangan (Fallback)
              </p>
              <p className="text-[11px] text-slate-500">
                Aktif otomatis jika Webhook tidak dikirim oleh JOURNAL POS.
              </p>
            </div>
            <select
              value={config.syncIntervalSeconds || 60}
              onChange={(e) => void handleChangeInterval(Number(e.target.value))}
              className="px-3 py-1.5 text-xs font-mono bg-slate-50 border border-slate-300 rounded-lg text-slate-900"
            >
              <option value={60}>Setiap 1 Menit (60 dtk)</option>
              <option value={120}>Setiap 2 Menit</option>
              <option value={300}>Setiap 5 Menit</option>
              <option value={600}>Setiap 10 Menit</option>
            </select>
          </div>

          {/* Backend Service Layer 1-Minute Periodic Poller Card */}
          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="space-y-0.5">
                <p className="text-xs font-bold text-slate-900">
                  Layanan Backend Auto-Fetch (JOURNAL_POS_BASE_URL · Setiap 1 Menit)
                </p>
                <p className="text-[11px] font-mono text-slate-600">
                  {backendStatus?.pollerStatus?.baseUrl || 'https://journal.alpa.gdn/web'} · Interval:{' '}
                  {backendStatus?.pollerStatus?.intervalSeconds ?? 60} detik · Siklus:{' '}
                  {backendStatus?.pollerStatus?.runCount ?? 0}x
                </p>
              </div>
              <span
                className={`px-2 py-0.5 text-[10px] font-mono font-bold rounded border ${
                  backendStatus?.pollerStatus?.enabled && backendStatus?.pollerStatus?.status === 'ONLINE'
                    ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                    : backendStatus?.pollerStatus?.status === 'SYNCING'
                      ? 'bg-blue-100 text-blue-800 border-blue-300'
                      : backendStatus?.pollerStatus?.status === 'ERROR'
                        ? 'bg-red-100 text-red-800 border-red-300'
                        : 'bg-amber-50 text-amber-800 border-amber-200'
                }`}
              >
                {backendStatus?.pollerStatus?.enabled
                  ? `AKTIF (${backendStatus.pollerStatus.status})`
                  : 'STANDBY'}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-600">
              <div>
                Fetch terakhir:{' '}
                <strong className="text-slate-800">
                  {formatDateTimeId(backendStatus?.pollerStatus?.lastRunAt)}
                </strong>
              </div>
              <div>
                Snapshot server:{' '}
                <strong className="font-mono text-blue-700">
                  {backendStatus?.pollerStatus?.lastFetchedCount ?? 0} produk
                </strong>
              </div>
            </div>

            {/* Direct Server -> Firestore Auto-Sync Status */}
            <div className="p-2.5 bg-white border border-slate-200 rounded-md space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] font-bold text-slate-800 flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5 text-blue-700" />
                  Auto-Sync Langsung Backend → Firestore (24/7)
                </span>
                <span
                  className={`px-2 py-0.5 text-[10px] font-mono font-bold rounded border ${
                    backendStatus?.pollerStatus?.firestoreSyncStatus === 'SYNCED' ||
                    backendStatus?.pollerStatus?.firestoreSyncStatus === 'NO_CHANGES'
                      ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                      : backendStatus?.pollerStatus?.firestoreSyncStatus === 'IAM_REQUIRED'
                        ? 'bg-amber-50 text-amber-800 border-amber-200'
                        : backendStatus?.pollerStatus?.firestoreSyncStatus === 'ERROR'
                          ? 'bg-red-50 text-red-700 border-red-200'
                          : 'bg-slate-100 text-slate-600 border-slate-200'
                  }`}
                >
                  {backendStatus?.pollerStatus?.firestoreSyncStatus === 'SYNCED'
                    ? 'TERUPDATE OTOMATIS'
                    : backendStatus?.pollerStatus?.firestoreSyncStatus === 'NO_CHANGES'
                      ? 'SINKRON (TERKINI)'
                      : backendStatus?.pollerStatus?.firestoreSyncStatus === 'IAM_REQUIRED'
                        ? 'PERLU IZIN IAM'
                        : backendStatus?.pollerStatus?.firestoreSyncStatus === 'ERROR'
                          ? 'GANGGUAN'
                          : 'SIAP'}
                </span>
              </div>
              <p className="text-[11px] text-slate-600 leading-relaxed">
                {backendStatus?.pollerStatus?.lastFirestoreSummary ||
                  'Saat harga atau stok berubah di Journal POS, server langsung memperbarui Firestore sehingga portal Pelanggan, Deliveri, Admin, dan Master otomatis ikut berubah tanpa membuka browser.'}
              </p>
              {backendStatus?.pollerStatus?.lastFirestoreSyncAt && (
                <p className="text-[10px] font-mono text-slate-500">
                  Update Firestore terakhir:{' '}
                  {formatDateTimeId(backendStatus.pollerStatus.lastFirestoreSyncAt)}
                  {typeof backendStatus.pollerStatus.lastFirestorePriceChanges === 'number' &&
                  backendStatus.pollerStatus.lastFirestorePriceChanges > 0
                    ? ` · ${backendStatus.pollerStatus.lastFirestorePriceChanges} harga berubah`
                    : ''}
                  {typeof backendStatus.pollerStatus.lastFirestoreStockChanges === 'number' &&
                  backendStatus.pollerStatus.lastFirestoreStockChanges > 0
                    ? ` · ${backendStatus.pollerStatus.lastFirestoreStockChanges} stok berubah`
                    : ''}
                </p>
              )}
              {backendStatus?.pollerStatus?.lastFirestoreError && (
                <p className="text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-1 leading-relaxed">
                  {backendStatus.pollerStatus.lastFirestoreError}
                </p>
              )}
            </div>

            {backendStatus?.pollerStatus?.lastError && (
              <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5 leading-relaxed">
                {backendStatus.pollerStatus.lastError}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() =>
                  void handleControlBackendPoller({
                    enabled: !backendStatus?.pollerStatus?.enabled,
                    intervalSeconds: config.syncIntervalSeconds || 60,
                  })
                }
                className={`px-3 py-1.5 text-[11px] font-bold rounded-lg border transition-colors cursor-pointer disabled:opacity-50 ${
                  backendStatus?.pollerStatus?.enabled
                    ? 'bg-slate-800 text-white border-slate-800 hover:bg-red-700'
                    : 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700'
                }`}
              >
                {backendStatus?.pollerStatus?.enabled
                  ? 'Hentikan Poller Server'
                  : 'Aktifkan Poller 1 Menit'}
              </button>
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => void handleControlBackendPoller({ triggerNow: true })}
                className="px-3 py-1.5 text-[11px] font-semibold text-slate-800 bg-white hover:bg-slate-100 border border-slate-300 rounded-lg cursor-pointer disabled:opacity-50"
              >
                Ambil Data Sekarang
              </button>
              {(backendStatus?.pollerStatus?.lastFetchedCount ?? 0) > 0 && (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => void handleApplyServerSnapshot()}
                  className="px-3 py-1.5 text-[11px] font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer disabled:opacity-50"
                >
                  Terapkan Snapshot ke Katalog
                </button>
              )}
            </div>
          </div>

          {/* Permanent Store URL Saver */}
          <div className="pt-3 border-t border-slate-100 space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                <Link2 className="w-3.5 h-3.5 text-blue-700" />
                Link URL Permanen Toko (Tersimpan Otomatis)
              </label>
              <span className="text-[11px] font-medium text-emerald-700">
                {autoSaveState === 'saving'
                  ? 'Menyimpan...'
                  : autoSaveState === 'saved'
                    ? 'Tersimpan permanen'
                    : 'Auto-Save Aktif'}
              </span>
            </div>
            <input
              type="url"
              value={permanentUrlDraft}
              onChange={(e) => setPermanentUrlDraft(e.target.value)}
              placeholder="https://ais-pre-..."
              className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-300 rounded-lg text-slate-900"
            />
          </div>
        </div>
      </div>

      {/* Section 2: Sinkronisasi Semua Produk & Uji Import JSON Resmi + Pemetaan 18 Kolom */}
      <div ref={importerSectionRef} className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-900">
              3. Sinkronisasi Semua Produk & Validasi Pemetaan 18 Kolom
            </h3>
            <p className="text-xs text-slate-600 mt-0.5">
              Pencocokan otomatis berbasis ID Produk / SKU / Barcode / Nama — stok langsung diganti persis sesuai Journal POS (tidak ditambah &amp; tanpa duplikat).
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowMappingTable((v) => !v)}
              className="px-3 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
            >
              {showMappingTable ? 'Sembunyikan' : 'Lihat'} 18 Kolom
            </button>
            <button
              type="button"
              onClick={() => setShowJsonImporter((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              Import Export JOURNAL POS (CSV / JSON)
            </button>
          </div>
        </div>

        {recentPriceChanges.length > 0 && (
          <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-lg space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-bold text-emerald-900">
                Harga &amp; Stok Terbaru yang Otomatis Diperbarui di Semua Akun ({recentPriceChanges.length} item)
              </p>
              <button
                type="button"
                onClick={() => setRecentPriceChanges([])}
                className="text-[11px] font-semibold text-emerald-700 hover:underline cursor-pointer"
              >
                Tutup
              </button>
            </div>
            <div className="overflow-x-auto bg-white border border-emerald-200 rounded-md">
              <table className="w-full text-xs text-left">
                <thead className="bg-emerald-50/70 text-emerald-900 border-b border-emerald-200">
                  <tr>
                    <th className="py-1.5 px-2.5">SKU</th>
                    <th className="py-1.5 px-2.5">Produk</th>
                    <th className="py-1.5 px-2.5">Harga Lama → Baru</th>
                    <th className="py-1.5 px-2.5">Stok Lama → Baru</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-emerald-100">
                  {recentPriceChanges.map((item) => (
                    <tr key={item.productId}>
                      <td className="py-1.5 px-2.5 font-mono text-slate-600">{item.sku}</td>
                      <td className="py-1.5 px-2.5 font-semibold text-slate-900">{item.name}</td>
                      <td className="py-1.5 px-2.5 font-mono">
                        <span className="text-slate-400 line-through mr-1.5">
                          {formatUSD(item.oldPrice)}
                        </span>
                        <span className="font-bold text-emerald-700">
                          {formatUSD(item.newPrice)}
                        </span>{' '}
                        <span className="text-[10px] font-normal text-slate-500">
                          ({formatKHR(item.newPriceKhr)})
                        </span>
                      </td>
                      <td className="py-1.5 px-2.5 font-mono">
                        {typeof item.newStock === 'number' ? (
                          <span>
                            <span className="text-slate-400 mr-1">{item.oldStock ?? '—'}</span>
                            <span className="text-slate-400 mr-1">→</span>
                            <strong className="text-blue-700">{item.newStock}</strong>
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {showMappingTable && (
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                <tr>
                  <th className="py-2 px-3">#</th>
                  <th className="py-2 px-3">Kolom JOURNAL POS</th>
                  <th className="py-2 px-3">Field ALPAMART TRIMULIA ONLINE</th>
                  <th className="py-2 px-3">Visibilitas & Keamanan</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {MAPPED_18_FIELDS.map((row) => (
                  <tr key={row.no} className={row.no === 7 ? 'bg-amber-50/70' : ''}>
                    <td className="py-2 px-3 font-mono text-slate-500">{row.no}</td>
                    <td className="py-2 px-3 font-semibold text-slate-900">{row.source}</td>
                    <td className="py-2 px-3 font-mono text-blue-700">{row.target}</td>
                    <td className="py-2 px-3">
                      {row.no === 7 ? (
                        <span className="inline-flex items-center gap-1 font-bold text-amber-800">
                          <Lock className="w-3 h-3" /> {row.scope}
                        </span>
                      ) : (
                        <span className="text-slate-600">{row.scope}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {showJsonImporter && (
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold text-slate-800">
                Unggah atau tempel file export <strong>CSV, TSV, atau JSON</strong> dari{' '}
                <code className="px-1 bg-white rounded">journal.alpa.gdn/web/</code> — otomatis mencocokkan ID, SKU, Barcode, atau Nama dan memperbarui harga ke seluruh akun tanpa menghapus foto produk:
              </p>
              <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-white border border-slate-300 rounded-lg hover:bg-slate-100 cursor-pointer">
                <FileJson className="w-3.5 h-3.5 text-blue-700" />
                Pilih File .csv / .json
                <input
                  type="file"
                  accept=".json,.csv,.tsv,.txt,application/json,text/csv"
                  className="hidden"
                  onChange={(e) => handleJsonFileUpload(e.target.files?.[0] || null)}
                />
              </label>
            </div>
            <div className="flex flex-col gap-2">
              <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={priceAndStockOnlyImport}
                  onChange={(e) => setPriceAndStockOnlyImport(e.target.checked)}
                  className="rounded border-slate-300 text-blue-700 focus:ring-blue-700"
                />
                <span>
                  <strong>Mode Update Harga &amp; Stok Saja</strong> (stok diganti persis sesuai file, foto &amp; kategori lama tetap aman)
                </span>
              </label>
              <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={skipUnmatchedImport}
                  onChange={(e) => setSkipUnmatchedImport(e.target.checked)}
                  className="rounded border-slate-300 text-blue-700 focus:ring-blue-700"
                />
                <span>
                  <strong>Jangan Tambah Produk Baru (Anti-Dobel)</strong> — hanya perbarui stok &amp; harga produk yang sudah terdaftar di katalog
                </span>
              </label>
            </div>
            <textarea
              rows={5}
              value={jsonInput}
              onChange={(e) => setJsonInput(e.target.value)}
              placeholder='Tempelkan CSV (contoh: sku,barcode,name,price_usd,stock) atau JSON resmi dari https://journal.alpa.gdn/web/'
              className="w-full p-3 text-xs font-mono bg-white border border-slate-300 rounded-lg text-slate-900"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowJsonImporter(false)}
                className="px-3 py-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => void handleImportJournalJson()}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${busyAction === 'json_import' ? 'animate-spin' : ''}`} />
                Validasi &amp; Update Stok + Harga Semua Akun
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Section 3: Admin-Only Cost Price & Margin Table (Strictly isolated in /productPrivateMeta) */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <Lock className="w-4 h-4 text-amber-600" />
              Harga Modal / Harga Beli & Margin (Khusus Administrasi)
            </h3>
            <p className="text-xs text-slate-600 mt-0.5">
              Tersimpan terpisah di koleksi <code className="font-mono">/productPrivateMeta</code> yang terkunci hanya untuk Admin — tidak pernah dikirim ke browser pelanggan.
            </p>
          </div>
          <span className="text-xs font-mono font-semibold text-slate-600">
            {syncedProductsList.length} produk tersinkronisasi
          </span>
        </div>

        {syncedProductsList.length === 0 ? (
          <div className="p-6 text-center bg-slate-50 border border-dashed border-slate-300 rounded-lg text-xs text-slate-500">
            Belum ada produk yang disinkronkan dari JOURNAL POS. Setelah API Key & Secret dikonfigurasi atau JSON resmi diimpor, data harga modal & margin akan muncul di tabel khusus Admin ini.
          </div>
        ) : (
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                <tr>
                  <th className="py-2.5 px-3">SKU / ID</th>
                  <th className="py-2.5 px-3">Nama Produk</th>
                  <th className="py-2.5 px-3">Harga Modal (Admin)</th>
                  <th className="py-2.5 px-3">Harga Jual (USD / KHR)</th>
                  <th className="py-2.5 px-3">Margin</th>
                  <th className="py-2.5 px-3">Stok & Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {syncedProductsList.slice(0, 30).map((prod) => {
                  const meta = costMetaByProductId.get(prod.id);
                  const costUsd = meta?.costPriceUsd ?? 0;
                  const marginUsd = prod.price - costUsd;
                  return (
                    <tr key={prod.id}>
                      <td className="py-2.5 px-3 font-mono text-slate-600">
                        <div>{prod.sku}</div>
                        {prod.barcode && (
                          <div className="text-[10px] text-slate-400">BC: {prod.barcode}</div>
                        )}
                      </td>
                      <td className="py-2.5 px-3 font-semibold text-slate-900">
                        <div>{prod.name}</div>
                        <div className="text-[11px] font-normal text-slate-500">
                          {prod.category} · {prod.unit || 'PCS'}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 font-mono font-semibold text-amber-800">
                        {costUsd > 0 ? formatUSD(costUsd) : '—'}
                        {meta?.costPriceKhr ? (
                          <div className="text-[10px] text-slate-500">
                            {formatKHR(meta.costPriceKhr)}
                          </div>
                        ) : null}
                      </td>
                      <td className="py-2.5 px-3 font-mono font-semibold text-blue-700">
                        {formatUSD(prod.price)}
                        <div className="text-[10px] text-red-600">
                          {formatKHR(prod.priceKhr || Math.round(prod.price * exchangeRateKhr))}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 font-mono font-semibold text-emerald-700">
                        {costUsd > 0 ? `+${formatUSD(marginUsd)}` : '—'}
                      </td>
                      <td className="py-2.5 px-3">
                        <span className="font-mono font-semibold text-slate-800">
                          {prod.stock} {prod.unit || 'PCS'}
                        </span>
                        <span
                          className={`ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded ${
                            prod.isActive
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-slate-200 text-slate-600'
                          }`}
                        >
                          {prod.isActive ? 'AKTIF' : 'NONAKTIF'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Section 4: Riwayat Sinkronisasi (Feature 6) */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
          <Database className="w-4 h-4 text-blue-700" />
          Riwayat Sinkronisasi JOURNAL POS (Audit Log Permanen)
        </h3>
        {syncLogs.length === 0 ? (
          <p className="text-xs text-slate-500 py-4 text-center bg-slate-50 rounded-lg border border-slate-200">
            Belum ada riwayat sinkronisasi tercatat.
          </p>
        ) : (
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                <tr>
                  <th className="py-2 px-3">Waktu</th>
                  <th className="py-2 px-3">Pemicu</th>
                  <th className="py-2 px-3">Status</th>
                  <th className="py-2 px-3">Berhasil / Update / Gagal</th>
                  <th className="py-2 px-3">Ringkasan & Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {syncLogs.map((log) => (
                  <tr key={log.id}>
                    <td className="py-2 px-3 whitespace-nowrap text-slate-600">
                      {formatDateTimeId(log.createdAt)}
                    </td>
                    <td className="py-2 px-3 font-mono uppercase text-[11px] text-slate-700">
                      {log.trigger}
                    </td>
                    <td className="py-2 px-3">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                          log.status === 'ERROR'
                            ? 'bg-red-100 text-red-700'
                            : 'bg-emerald-100 text-emerald-700'
                        }`}
                      >
                        {log.status}
                      </span>
                    </td>
                    <td className="py-2 px-3 font-mono tabular-nums whitespace-nowrap">
                      <span className="text-emerald-700 font-semibold">{log.successCount}</span>
                      {' / '}
                      <span className="text-blue-700 font-semibold">{log.updatedCount}</span>
                      {' / '}
                      <span className="text-red-600 font-semibold">{log.failedCount}</span>
                    </td>
                    <td className="py-2 px-3 text-slate-700 max-w-md">
                      <div>{log.summary}</div>
                      {log.errorDetail && (
                        <div className="text-[11px] font-mono text-red-600 mt-0.5 break-words">
                          {log.errorDetail}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Section 5: Backup Data Master (JSON / ZIP) + Firebase Cloud Functions 24-Hour GCS Scheduler */}
      <div className="bg-slate-900 text-white rounded-xl p-5 sm:p-6 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-base font-bold flex items-center gap-2">
              <Cloud className="w-5 h-5 text-sky-400" />
              Backup Data Master Firestore (JSON / ZIP & Scheduler 24 Jam GCS)
            </h3>
            <p className="text-xs text-slate-300 leading-relaxed max-w-2xl">
              Unduh seluruh koleksi Firestore (produk, harga modal, kategori, promo, pesanan, banner, konfigurasi, akun, dan log sinkronisasi) ke file JSON atau arsip ZIP kapan saja. Fungsi scheduler otomatis server-side (<code className="text-sky-300">scheduledDailyFirestoreBackup</code> setiap 24 jam pukul 02:00 ke Google Cloud Storage) telah disiapkan di folder <code className="text-sky-300">functions/</code>.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => void handleMasterBackup('json')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded-lg cursor-pointer disabled:opacity-50"
            >
              <Download className="w-4 h-4 text-sky-400" />
              {busyAction === 'backup_json' ? 'Mengekspor...' : 'Backup Master (.JSON)'}
            </button>
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => void handleMasterBackup('zip')}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-lg cursor-pointer disabled:opacity-50"
            >
              <FolderArchive className="w-4 h-4" />
              {busyAction === 'backup_zip' ? 'Membuat ZIP...' : 'Ekstra Backup Master (.ZIP)'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <div className="p-3.5 bg-slate-800/80 border border-slate-700 rounded-lg space-y-1">
            <p className="font-semibold text-sky-300 flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4" />
              Jadwal Cloud Functions v2 (Setiap 24 Jam)
            </p>
            <p className="text-slate-300">
              Schedule: <code className="text-white">0 2 * * *</code> (02:00 Asia/Phnom_Penh) · Region:{' '}
              <code className="text-white">asia-northeast1</code>
            </p>
            <p className="text-slate-400">
              Deploy dari CLI Firebase: <code className="text-sky-200">cd functions && npm install && npm run deploy</code>
            </p>
          </div>
          <div className="p-3.5 bg-slate-800/80 border border-slate-700 rounded-lg space-y-1">
            <p className="font-semibold text-emerald-300 flex items-center gap-1.5">
              <Archive className="w-4 h-4" />
              Riwayat Backup Terakhir ({backupRecords.length})
            </p>
            {backupRecords.length === 0 ? (
              <p className="text-slate-400">Belum ada backup yang diekspor.</p>
            ) : (
              <ul className="space-y-1 text-slate-300">
                {backupRecords.slice(0, 3).map((rec) => (
                  <li key={rec.id} className="flex items-center justify-between gap-2">
                    <span className="font-mono uppercase text-[11px] text-sky-300">
                      {rec.format}
                    </span>
                    <span className="truncate">
                      {rec.totalDocuments} dok · {(rec.fileSizeBytes / 1024).toFixed(1)} KB
                    </span>
                    <span className="text-slate-400 whitespace-nowrap">
                      {formatDateTimeId(rec.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

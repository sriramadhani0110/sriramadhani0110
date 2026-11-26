import { useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../lib/firebase';
import type { MappedJournalPosRecord } from '../lib/journalPosAdapter';
import {
  applyJournalPosRecordsToFirestore,
  DEFAULT_JOURNAL_POS_CONFIG,
  fetchAllCategoriesOnce,
} from '../lib/journalPosSyncClient';
import type { JournalPosConfig, Product, StoreCategory } from '../types/marketplace';

interface UseJournalPosGlobalSyncParams {
  user: User | null;
  isMaster: boolean;
  products: Product[];
  categories: StoreCategory[];
  exchangeRateKhr: number;
}

interface SnapshotApiResponse {
  ok?: boolean;
  pollerStatus?: {
    enabled?: boolean;
    credentialsConfigured?: boolean;
    status?: string;
    lastFetchedCount?: number;
    firestoreSyncStatus?: string;
  };
  snapshot?: {
    fetchedAt: string | null;
    snapshotVersion?: string;
    records: MappedJournalPosRecord[];
    parseErrors: string[];
  };
}

interface WebhookEventsApiResponse {
  ok?: boolean;
  events?: {
    eventId: string;
    receivedAt: string;
    eventType: string;
    records: MappedJournalPosRecord[];
    parseErrors: string[];
  }[];
}

/**
 * Global background Journal POS synchronizer mounted at App root whenever a Master user
 * is logged in on ANY portal or tab.
 *
 * Whenever Journal POS sends a real-time webhook OR the server's 1-minute poller
 * detects a new price/stock snapshot, this hook automatically commits the updates
 * to Firestore so Pelanggan, Deliveri, Admin, and Master Data ALL update live.
 */
export function useJournalPosGlobalSync({
  user,
  isMaster,
  products,
  categories,
  exchangeRateKhr,
}: UseJournalPosGlobalSyncParams): {
  syncToast: string | null;
  dismissSyncToast: () => void;
} {
  const [journalConfig, setJournalConfig] = useState<JournalPosConfig>(
    DEFAULT_JOURNAL_POS_CONFIG
  );
  const [syncToast, setSyncToast] = useState<string | null>(null);

  const productsRef = useRef<Product[]>(products);
  const categoriesRef = useRef<StoreCategory[]>(categories);
  const configRef = useRef<JournalPosConfig>(journalConfig);
  const exchangeRateRef = useRef<number>(exchangeRateKhr);
  const busyRef = useRef(false);
  const lastAppliedSnapshotKeyRef = useRef<string>('');
  const toastTimerRef = useRef<number | null>(null);

  useEffect(() => {
    productsRef.current = products;
  }, [products]);

  useEffect(() => {
    categoriesRef.current = categories;
  }, [categories]);

  useEffect(() => {
    configRef.current = journalConfig;
  }, [journalConfig]);

  useEffect(() => {
    exchangeRateRef.current = exchangeRateKhr;
  }, [exchangeRateKhr]);

  const showToast = (msg: string) => {
    setSyncToast(msg);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setSyncToast(null);
    }, 6000);
  };

  // Listen to persistent /integrationConfig/journalPos when Master is signed in
  useEffect(() => {
    if (!user || !isMaster) return;
    const unsub = onSnapshot(
      doc(db, 'integrationConfig', 'journalPos'),
      (snap) => {
        if (snap.exists()) {
          setJournalConfig({
            ...DEFAULT_JOURNAL_POS_CONFIG,
            ...(snap.data() as Partial<JournalPosConfig>),
          });
        }
      },
      () => {
        // Ignore transient permission or network hiccups
      }
    );
    return () => unsub();
  }, [user, isMaster]);

  // Background drain loop for real-time webhooks & server 1-minute poller snapshots
  useEffect(() => {
    if (!user || !isMaster) return;

    const runBackgroundCheck = async () => {
      if (busyRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

      busyRef.current = true;
      try {
        const token = await user.getIdToken();
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        };
        const adminEmail = user.email || 'master@alpamart.online';

        // 1. Always drain real-time incoming webhooks from https://journal.alpa.gdn/web/
        const whRes = await fetch('/api/journal-pos/webhook-events', {
          headers,
          credentials: 'same-origin',
        });
        const whContentType = (whRes.headers.get('content-type') || '').toLowerCase();
        if (whRes.ok && whContentType.includes('application/json')) {
          const whData = (await whRes.json()) as WebhookEventsApiResponse;
          if (whData.ok && Array.isArray(whData.events) && whData.events.length > 0) {
            const allRecords: MappedJournalPosRecord[] = [];
            const allErrors: string[] = [];
            const eventIds: string[] = [];
            for (const evt of whData.events) {
              eventIds.push(evt.eventId);
              allRecords.push(...(evt.records || []));
              allErrors.push(...(evt.parseErrors || []));
            }

            if (allRecords.length > 0) {
              const liveCats =
                categoriesRef.current.length > 0
                  ? categoriesRef.current
                  : await fetchAllCategoriesOnce();
              const result = await applyJournalPosRecordsToFirestore({
                records: allRecords,
                parseErrors: allErrors,
                existingProducts: productsRef.current,
                existingCategories: liveCats,
                trigger: 'webhook',
                adminEmail,
                currentConfig: configRef.current,
                exchangeRateKhr: exchangeRateRef.current,
              });
              if (result.priceChangedCount > 0 || result.updatedCount > 0 || result.insertedCount > 0) {
                showToast(
                  result.priceChangedCount > 0
                    ? `Journal POS: ${result.priceChangedCount} harga produk otomatis diperbarui di semua akun.`
                    : `Journal POS Webhook: ${result.successCount} produk tersinkronisasi ke semua akun.`
                );
              }
            }

            await fetch('/api/journal-pos/webhook-events/ack', {
              method: 'POST',
              headers,
              body: JSON.stringify({ eventIds }),
            });
          }
        }

        // 2. Check server's latest 1-minute poller snapshot and auto-apply if anything changed
        const snapRes = await fetch('/api/journal-pos/latest-snapshot', {
          headers,
          credentials: 'same-origin',
        });
        const snapContentType = (snapRes.headers.get('content-type') || '').toLowerCase();
        if (!snapRes.ok || !snapContentType.includes('application/json')) return;
        const snapData = (await snapRes.json()) as SnapshotApiResponse;
        const snapshot = snapData.snapshot;
        const credentialsConfigured = Boolean(snapData.pollerStatus?.credentialsConfigured);

        if (
          !credentialsConfigured ||
          !snapshot ||
          !snapshot.fetchedAt ||
          !Array.isArray(snapshot.records) ||
          snapshot.records.length === 0
        ) {
          return;
        }

        const snapshotKey = snapshot.snapshotVersion
          ? `${snapshot.snapshotVersion}`
          : snapshot.fetchedAt;

        // Skip if we already applied this exact snapshot version in this browser session
        if (snapshotKey === lastAppliedSnapshotKeyRef.current) {
          return;
        }

        // Skip redundant client-side writes when the backend server already synced this snapshot directly to Firestore
        const serverSyncState = snapData.pollerStatus?.firestoreSyncStatus;
        if (serverSyncState === 'SYNCED' || serverSyncState === 'NO_CHANGES') {
          lastAppliedSnapshotKeyRef.current = snapshotKey;
          return;
        }

        // Only auto-apply if autoSyncEnabled is ON or server poller is actively enabled
        const shouldAutoApply =
          Boolean(configRef.current.autoSyncEnabled) ||
          Boolean(snapData.pollerStatus?.enabled);
        if (!shouldAutoApply) {
          return;
        }

        // Avoid re-applying an older snapshot already saved to Firestore
        const lastSyncMs = configRef.current.lastSyncAt
          ? Date.parse(configRef.current.lastSyncAt)
          : 0;
        const fetchedMs = Date.parse(snapshot.fetchedAt);
        if (Number.isFinite(lastSyncMs) && Number.isFinite(fetchedMs) && fetchedMs <= lastSyncMs) {
          lastAppliedSnapshotKeyRef.current = snapshotKey;
          return;
        }

        const liveCats =
          categoriesRef.current.length > 0
            ? categoriesRef.current
            : await fetchAllCategoriesOnce();
        const result = await applyJournalPosRecordsToFirestore({
          records: snapshot.records,
          parseErrors: snapshot.parseErrors || [],
          existingProducts: productsRef.current,
          existingCategories: liveCats,
          trigger: 'polling',
          adminEmail,
          currentConfig: configRef.current,
          exchangeRateKhr: exchangeRateRef.current,
        });
        lastAppliedSnapshotKeyRef.current = snapshotKey;

        if (result.priceChangedCount > 0) {
          showToast(
            `Update Otomatis Journal POS: ${result.priceChangedCount} harga produk langsung berganti di semua akun.`
          );
        }
      } catch {
        // Silent background resilience
      } finally {
        busyRef.current = false;
      }
    };

    const initialTimer = window.setTimeout(() => {
      void runBackgroundCheck();
    }, 3500);

    const intervalId = window.setInterval(() => {
      void runBackgroundCheck();
    }, 20_000);

    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(intervalId);
    };
  }, [user, isMaster]);

  return {
    syncToast,
    dismissSyncToast: () => setSyncToast(null),
  };
}

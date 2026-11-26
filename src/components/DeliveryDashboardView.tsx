import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  Check,
  CheckCircle2,
  Clock,
  CloudOff,
  Copy,
  Download,
  Eye,
  ExternalLink,
  FileUp,
  Image as ImageIcon,
  Loader2,
  MapPin,
  MessageCircle,
  Package,
  PackageCheck,
  RefreshCw,
  Search,
  Send,
  Share2,
  Truck,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type { User } from 'firebase/auth';
import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import type {
  DeliveryFeedOrder,
  Order,
  OrderStatus,
  StoreHoursConfig,
  StoreMasterConfig,
} from '../types/marketplace';
import {
  db,
  fetchDeliveryFeedViaRest,
  fetchDeliveryRosterViaRest,
  isIosDevice,
} from '../lib/firebase';
import {
  copyTextToClipboard,
  DEFAULT_DELIVERY_FEED_KEY,
  formatAmountByCurrency,
  formatTimestamp,
  getShareablePortalUrl,
  getTelegramContactHref,
  normalizeProductUnit,
  ORDER_STATUS_META,
  STORE_NAME,
} from '../lib/catalogSeed';
import {
  DEFAULT_MASTER_CONFIG,
  prepareProofAttachmentFile,
  THEME_ACCENT_STYLES,
} from '../lib/storeDefaults';
import { downloadSinglePortalDomainZip } from '../lib/portalZipExport';
import {
  getAllQueuedProofs,
  loadCachedDeliveryOrders,
  removeQueuedProof,
  saveCachedDeliveryOrders,
  saveQueuedProof,
  type QueuedDeliveryProof,
} from '../lib/offlineProofQueue';
import { getResilientItem, setResilientItem } from '../lib/sessionStorage';
import { ProofAttachmentPreview } from './ProofAttachmentPreview';
import {
  buildTelegramOrderMeta,
  canUseNativeFileShare,
  dispatchDeliveredTelegramNotification,
  shareProofAndMessageNatively,
  triggerProofFileDownload,
  type TelegramDispatchResult,
  type TelegramOrderMeta,
} from '../lib/telegramNotify';

interface DeliveryDashboardViewProps {
  user: User | null;
  isDelivery: boolean;
  deliveryEmailHash: string;
  storeName?: string;
  masterConfig?: StoreMasterConfig;
  storeHoursConfig?: StoreHoursConfig;
}

const DELIVERY_KEY_STORAGE = 'alpamart_delivery_feed_key_v1';

type DisplayDeliveryOrder = DeliveryFeedOrder;

function getUrlDeliveryKey(): string {
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams(window.location.search);
  const raw = (params.get('key') || '').trim();
  if (raw.length >= 24 && /^[a-zA-Z0-9_-]+$/.test(raw)) {
    return raw;
  }
  return '';
}

function getStoredDeliveryKey(): string {
  try {
    const raw = (getResilientItem(DELIVERY_KEY_STORAGE) || '').trim();
    if (raw.length >= 24 && /^[a-zA-Z0-9_-]+$/.test(raw)) {
      return raw;
    }
  } catch {
    // ignore
  }
  return '';
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error('NETWORK_TIMEOUT'));
    }, ms);
    promise.then(
      (val) => {
        window.clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function syncProofEntryToFirestore(
  entry: QueuedDeliveryProof
): Promise<void> {
  const payload: Record<string, unknown> = {
    status: entry.targetStatus,
    deliveryProofImageUrl: entry.proofDataUrl,
    updatedAt: serverTimestamp(),
  };

  if (entry.isInFeed && entry.feedKey) {
    try {
      const batch = writeBatch(db);
      batch.update(
        doc(db, 'deliveryFeeds', entry.feedKey, 'orders', entry.orderId),
        payload
      );
      batch.update(doc(db, 'orders', entry.orderId), payload);
      await withTimeout(batch.commit(), 12000);
      return;
    } catch (batchErr) {
      // Fallback: if batch failed (e.g. legacy order missing or offline race),
      // try updating deliveryFeed first, then orders doc individually.
      const msg =
        batchErr instanceof Error ? batchErr.message.toLowerCase() : '';
      if (
        msg.includes('network_timeout') ||
        msg.includes('unavailable') ||
        msg.includes('offline')
      ) {
        throw batchErr;
      }

      await withTimeout(
        updateDoc(
          doc(db, 'deliveryFeeds', entry.feedKey, 'orders', entry.orderId),
          payload
        ),
        12000
      );
      try {
        await withTimeout(
          updateDoc(doc(db, 'orders', entry.orderId), payload),
          8000
        );
      } catch {
        // Feed update succeeded; admin/order doc may already be synced or legacy-only
      }
      return;
    }
  }

  await withTimeout(
    updateDoc(doc(db, 'orders', entry.orderId), payload),
    12000
  );
}

export function DeliveryDashboardView({
  user,
  isDelivery,
  deliveryEmailHash,
  storeName,
  masterConfig,
}: DeliveryDashboardViewProps) {
  const master = masterConfig || DEFAULT_MASTER_CONFIG;
  const activeTheme =
    THEME_ACCENT_STYLES[master.themeAccent] || THEME_ACCENT_STYLES.blue_red;
  const activeStoreName =
    (masterConfig?.storeName || storeName || STORE_NAME).trim() || STORE_NAME;
  const [feedOrders, setFeedOrders] = useState<DisplayDeliveryOrder[]>(() =>
    loadCachedDeliveryOrders()
  );
  const [legacyAuthOrders, setLegacyAuthOrders] = useState<DisplayDeliveryOrder[]>([]);
  const [activeFeedKey, setActiveFeedKey] = useState<string>(
    () => getUrlDeliveryKey() || getStoredDeliveryKey() || DEFAULT_DELIVERY_FEED_KEY
  );
  const [loading, setLoading] = useState<boolean>(
    () => loadCachedDeliveryOrders().length === 0
  );
  const [statusFilter, setStatusFilter] = useState<'all' | OrderStatus>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedDeliveryUrl, setCopiedDeliveryUrl] = useState(false);

  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine !== false : true
  );
  const [queuedProofs, setQueuedProofs] = useState<QueuedDeliveryProof[]>([]);
  const [syncingQueue, setSyncingQueue] = useState(false);

  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'upload' | 'confirm' | null>(null);
  const [proofFeedback, setProofFeedback] = useState<
    Record<string, { tone: 'ok' | 'warn' | 'err'; text: string }>
  >({});

  const [telegramDispatchByOrder, setTelegramDispatchByOrder] = useState<
    Record<string, TelegramDispatchResult>
  >({});
  const [sendingTelegramOrderId, setSendingTelegramOrderId] = useState<string | null>(
    null
  );
  const [copiedTelegramMsgId, setCopiedTelegramMsgId] = useState<string | null>(null);
  const [shareNoticeByOrder, setShareNoticeByOrder] = useState<Record<string, string>>({});

  const syncingRef = useRef(false);

  const triggerTelegramDeliveredDispatch = useCallback(
    async (
      meta: TelegramOrderMeta,
      feedKey: string,
      proofDataUrl: string,
      forceResend = false
    ): Promise<TelegramDispatchResult> => {
      setSendingTelegramOrderId(meta.orderId);
      try {
        const result = await dispatchDeliveredTelegramNotification({
          meta,
          feedKey,
          proofDataUrl,
          forceResend,
        });
        setTelegramDispatchByOrder((prev) => ({
          ...prev,
          [meta.orderId]: result,
        }));
        if (result.fallbackRequired && result.messageText) {
          copyTextToClipboard(result.messageText).catch(() => {});
        }
        return result;
      } finally {
        setSendingTelegramOrderId((prev) => (prev === meta.orderId ? null : prev));
      }
    },
    []
  );

  // Track device network status (works on Safari iPhone, Android, Tablet, Windows)
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Load any locally queued offline proofs on startup
  useEffect(() => {
    let active = true;
    getAllQueuedProofs().then((items) => {
      if (active) setQueuedProofs(items);
    });
    return () => {
      active = false;
    };
  }, []);

  // Subscribe in REAL TIME to storeMeta/deliveryRoster so any Master/Admin feed key rotation propagates immediately
  useEffect(() => {
    const fromUrl = getUrlDeliveryKey();
    const stored = getStoredDeliveryKey();

    if (fromUrl) {
      try {
        setResilientItem(DELIVERY_KEY_STORAGE, fromUrl, { allowCookie: true });
      } catch {
        // ignore
      }
      setActiveFeedKey(fromUrl);
    }

    let cancelled = false;
    const applyRosterKey = (rawKey: unknown) => {
      if (cancelled) return;
      const rosterKey = typeof rawKey === 'string' ? rawKey.trim() : '';
      if (rosterKey.length >= 24 && /^[a-zA-Z0-9_-]+$/.test(rosterKey)) {
        try {
          setResilientItem(DELIVERY_KEY_STORAGE, rosterKey, { allowCookie: true });
        } catch {
          // ignore
        }
        setActiveFeedKey(rosterKey);
      } else if (!fromUrl) {
        setActiveFeedKey(stored || DEFAULT_DELIVERY_FEED_KEY);
      }
    };

    // Fast REST fallback on iPhone/iPad Safari & mobile networks where WebChannel may stall
    void fetchDeliveryRosterViaRest().then((restRoster) => {
      if (restRoster?.directAccessKey) {
        applyRosterKey(restRoster.directAccessKey);
      }
    });

    const unsubscribe = onSnapshot(
      doc(db, 'storeMeta', 'deliveryRoster'),
      (rosterSnap) => {
        applyRosterKey(rosterSnap.exists() ? rosterSnap.data().directAccessKey : '');
      },
      () => {
        if (!fromUrl) {
          setActiveFeedKey(stored || DEFAULT_DELIVERY_FEED_KEY);
        }
      }
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Subscribe in real time to 1-Click Delivery Feed (with REST + local cache fallback for iPhone/Android)
  useEffect(() => {
    if (!activeFeedKey) return;
    let cancelled = false;
    let receivedLiveSnapshot = false;
    const colRef = collection(db, 'deliveryFeeds', activeFeedKey, 'orders');

    const loadViaRestFallback = async () => {
      try {
        const restList = await fetchDeliveryFeedViaRest<DisplayDeliveryOrder>(activeFeedKey);
        if (cancelled) return;
        if (restList.length > 0 || !receivedLiveSnapshot) {
          setFeedOrders((prev) => (restList.length > 0 || prev.length === 0 ? restList : prev));
          if (restList.length > 0) {
            saveCachedDeliveryOrders(restList);
          }
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    };

    // On iOS Safari, kick off REST immediately in parallel so Kurir sees orders within 1-2s
    if (isIosDevice()) {
      void loadViaRestFallback();
    }

    const failSafeTimer = window.setTimeout(() => {
      if (!receivedLiveSnapshot) {
        void loadViaRestFallback();
      } else if (!cancelled) {
        setLoading(false);
      }
    }, 3200);

    const unsubscribe = onSnapshot(
      colRef,
      (snap) => {
        window.clearTimeout(failSafeTimer);
        const list = snap.docs.map((d) => d.data() as DeliveryFeedOrder);
        if (list.length > 0 || !snap.metadata.fromCache) {
          receivedLiveSnapshot = true;
          setFeedOrders(list);
          saveCachedDeliveryOrders(list);
        }
        setLoading(false);
      },
      () => {
        window.clearTimeout(failSafeTimer);
        void loadViaRestFallback();
      }
    );

    return () => {
      cancelled = true;
      window.clearTimeout(failSafeTimer);
      unsubscribe();
    };
  }, [activeFeedKey]);

  // Also merge legacy Google-authenticated delivery orders if signed in
  useEffect(() => {
    if (!user || !isDelivery || !deliveryEmailHash) {
      setLegacyAuthOrders([]);
      return;
    }

    const q = query(
      collection(db, 'orders'),
      where('deliveryEmailHashes', 'array-contains', deliveryEmailHash)
    );

    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs.map((d) => d.data() as Order);
        setLegacyAuthOrders(list);
      },
      () => {
        setLegacyAuthOrders([]);
      }
    );

    return () => unsubscribe();
  }, [user, isDelivery, deliveryEmailHash]);

  // Flush queued offline proofs/confirmations automatically when internet is back
  const flushOfflineQueue = useCallback(async () => {
    if (syncingRef.current) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

    const pending = await getAllQueuedProofs();
    if (pending.length === 0) {
      setQueuedProofs([]);
      return;
    }

    syncingRef.current = true;
    setSyncingQueue(true);
    try {
      for (const item of pending) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          break;
        }
        try {
          await syncProofEntryToFirestore(item);
          await removeQueuedProof(item.orderId);

          let tgTextSuffix = '';
          if (item.targetStatus === 'completed' && item.telegramMeta) {
            const tgRes = await triggerTelegramDeliveredDispatch(
              item.telegramMeta,
              item.feedKey || DEFAULT_DELIVERY_FEED_KEY,
              item.proofDataUrl,
              false
            );
            tgTextSuffix = tgRes.sentToCustomer
              ? ` Notifikasi & foto bukti otomatis terkirim ke Telegram pelanggan (${item.telegramMeta.customerPhone}).`
              : ` Panel kirim notifikasi & foto ke Telegram pelanggan (${item.telegramMeta.customerPhone}) siap di bawah.`;
          }

          setProofFeedback((prev) => ({
            ...prev,
            [item.orderId]: {
              tone: 'ok',
              text:
                item.targetStatus === 'completed'
                  ? `Sinkronisasi berhasil! Status "Sudah Diterima Pelanggan" & bukti langsung ter-update di akun Admin.${tgTextSuffix}`
                  : 'Sinkronisasi berhasil! Foto/file bukti tersimpan di server (Keterangan: Belum Diterima Pelanggan).',
            },
          }));
        } catch (err) {
          const updatedItem: QueuedDeliveryProof = {
            ...item,
            lastError: err instanceof Error ? err.message : 'Menunggu koneksi stabil',
          };
          await saveQueuedProof(updatedItem);
        }
      }
      const remaining = await getAllQueuedProofs();
      setQueuedProofs(remaining);
    } finally {
      syncingRef.current = false;
      setSyncingQueue(false);
    }
  }, [triggerTelegramDeliveredDispatch]);

  // Auto-sync queue whenever connection comes back, tab becomes visible, or every 15s
  useEffect(() => {
    if (isOnline && queuedProofs.length > 0) {
      flushOfflineQueue();
    }
  }, [isOnline, queuedProofs.length, flushOfflineQueue]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && navigator.onLine !== false) {
        flushOfflineQueue();
      }
    };
    const interval = window.setInterval(() => {
      if (navigator.onLine !== false) {
        flushOfflineQueue();
      }
    }, 15000);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [flushOfflineQueue]);

  const queuedByOrderId = useMemo(() => {
    const map = new Map<string, QueuedDeliveryProof>();
    for (const q of queuedProofs) {
      map.set(q.orderId, q);
    }
    return map;
  }, [queuedProofs]);

  const feedOrderIdSet = useMemo(
    () => new Set(feedOrders.map((o) => o.id)),
    [feedOrders]
  );

  // Merge live orders with any locally queued offline proofs so UI reflects changes immediately
  const orders = useMemo(() => {
    const map = new Map<string, DisplayDeliveryOrder>();
    for (const o of legacyAuthOrders) map.set(o.id, o);
    for (const o of feedOrders) map.set(o.id, o);

    return Array.from(map.values())
      .map((o) => {
        const queued = queuedByOrderId.get(o.id);
        if (!queued) return o;
        return {
          ...o,
          status:
            queued.targetStatus === 'completed'
              ? ('completed' as OrderStatus)
              : o.status === 'pending' || o.status === 'processing'
                ? ('shipped' as OrderStatus)
                : o.status,
          deliveryProofImageUrl: queued.proofDataUrl || o.deliveryProofImageUrl,
        };
      })
      .sort((a, b) => {
        const ta = a.createdAt?.toMillis?.() ?? 0;
        const tb = b.createdAt?.toMillis?.() ?? 0;
        return tb - ta;
      });
  }, [feedOrders, legacyAuthOrders, queuedByOrderId]);

  const filteredOrders = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return orders.filter((o) => {
      const matchesStatus = statusFilter === 'all' || o.status === statusFilter;
      const matchesQuery =
        !q ||
        o.orderNumber.toLowerCase().includes(q) ||
        o.customerName.toLowerCase().includes(q) ||
        o.customerPhone.toLowerCase().includes(q) ||
        o.trackingNumber.toLowerCase().includes(q) ||
        (o.locationCoords || '').toLowerCase().includes(q);
      return matchesStatus && matchesQuery;
    });
  }, [orders, statusFilter, searchTerm]);

  const stats = useMemo(() => {
    const pendingCount = orders.filter((o) => o.status === 'pending').length;
    const processingCount = orders.filter((o) => o.status === 'processing').length;
    const shippedCount = orders.filter((o) => o.status === 'shipped').length;
    const completedCount = orders.filter((o) => o.status === 'completed').length;
    const cancelledCount = orders.filter((o) => o.status === 'cancelled').length;
    const nonCancelled = orders.length - cancelledCount;
    const completionRate =
      nonCancelled > 0 ? Math.round((completedCount / nonCancelled) * 100) : 0;

    return {
      total: orders.length,
      waitingAndPrep: pendingCount + processingCount,
      shippedCount,
      completedCount,
      cancelledCount,
      completionRate,
    };
  }, [orders]);

  const getMapsHref = (order: DisplayDeliveryOrder) => {
    if (order.locationUrl && order.locationUrl.startsWith('https://')) {
      return order.locationUrl;
    }
    if (order.locationCoords) {
      return `https://www.google.com/maps?q=${encodeURIComponent(order.locationCoords)}`;
    }
    const queryText = [order.shippingAddress, order.city, order.postalCode]
      .filter(Boolean)
      .join(', ');
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(queryText)}`;
  };

  const handleCopyRecipient = async (order: DisplayDeliveryOrder) => {
    const lines = [
      `Order: ${order.orderNumber}`,
      `Status: ${ORDER_STATUS_META[order.status].label}`,
      `Penerima: ${order.customerName}`,
      `Telegram: ${order.customerPhone}`,
      order.shippingAddress || order.city || order.postalCode
        ? `Alamat: ${[order.shippingAddress, order.city, order.postalCode].filter(Boolean).join(', ')}`
        : null,
      order.locationCoords ? `GPS: ${order.locationCoords}` : null,
      `Google Maps: ${getMapsHref(order)}`,
    ]
      .filter(Boolean)
      .join('\n');

    await copyTextToClipboard(lines);
    setCopiedId(order.id);
    setTimeout(() => setCopiedId((prev) => (prev === order.id ? null : prev)), 1800);
  };

  const handleCopyDeliveryPortalUrl = async () => {
    const url = getShareablePortalUrl('delivery', master.permanentStoreUrl);
    await copyTextToClipboard(url);
    setCopiedDeliveryUrl(true);
    setTimeout(() => setCopiedDeliveryUrl(false), 2000);
  };

  // STEP 1: Upload & Save Photo or File (works 100% OFFLINE & ONLINE) -> Status stays "Belum Diterima"
  const handleSaveProofAttachment = async (
    order: DisplayDeliveryOrder,
    file: File | null
  ) => {
    if (!file) return;
    if (order.status === 'cancelled') return;

    setBusyOrderId(order.id);
    setBusyAction('upload');
    setProofFeedback((prev) => {
      const next = { ...prev };
      delete next[order.id];
      return next;
    });

    try {
      // 100% local compression/encoding — requires ZERO internet connection
      const prepared = await prepareProofAttachmentFile(file);
      const isInFeed = Boolean(activeFeedKey && feedOrderIdSet.has(order.id));
      const nextStatus: 'shipped' | 'completed' =
        order.status === 'completed' ? 'completed' : 'shipped';

      const entry: QueuedDeliveryProof = {
        orderId: order.id,
        orderNumber: order.orderNumber,
        feedKey: activeFeedKey || DEFAULT_DELIVERY_FEED_KEY,
        isInFeed,
        targetStatus: nextStatus,
        proofDataUrl: prepared.dataUrl,
        fileName: prepared.fileName,
        mimeType: prepared.mimeType,
        createdAtMs: Date.now(),
      };

      // Always persist locally FIRST so nothing is ever lost even without signal
      await saveQueuedProof(entry);
      const updatedQueue = await getAllQueuedProofs();
      setQueuedProofs(updatedQueue);

      const currentlyOnline =
        typeof navigator === 'undefined' || navigator.onLine !== false;

      if (!currentlyOnline) {
        setProofFeedback((prev) => ({
          ...prev,
          [order.id]: {
            tone: 'warn',
            text: 'Foto/file tersimpan di HP (Mode Offline) · Keterangan: BELUM DITERIMA. Akan otomatis terkirim begitu jaringan aktif.',
          },
        }));
        return;
      }

      try {
        await syncProofEntryToFirestore(entry);
        await removeQueuedProof(order.id);
        setQueuedProofs(await getAllQueuedProofs());
        setProofFeedback((prev) => ({
          ...prev,
          [order.id]: {
            tone: 'ok',
            text:
              nextStatus === 'completed'
                ? 'Foto/file bukti berhasil disimpan dan ter-update di akun Admin.'
                : 'Foto/file bukti berhasil disimpan! Keterangan saat ini: BELUM DITERIMA. Klik tombol "Sudah Diterima Pelanggan" jika barang sudah diserahkan.',
          },
        }));
      } catch {
        // Keep safely queued locally instead of failing!
        setProofFeedback((prev) => ({
          ...prev,
          [order.id]: {
            tone: 'warn',
            text: 'Sinyal sedang lemah/putus — foto/file sudah AMAN tersimpan di perangkat (Keterangan: BELUM DITERIMA) dan akan otomatis terkirim saat jaringan stabil.',
          },
        }));
      }
    } catch (err) {
      setProofFeedback((prev) => ({
        ...prev,
        [order.id]: {
          tone: 'err',
          text:
            err instanceof Error
              ? err.message
              : 'File tidak dapat diproses. Pilih foto (JPG/PNG/WebP/HEIC) atau PDF (maks. 250 KB).',
        },
      }));
    } finally {
      setBusyOrderId((prev) => (prev === order.id ? null : prev));
      setBusyAction(null);
    }
  };

  // STEP 2: Courier clicks "Sudah Diterima Pelanggan" -> Updates Admin immediately & auto-notifies Customer Telegram
  const handleConfirmCustomerReceived = async (order: DisplayDeliveryOrder) => {
    if (order.status === 'cancelled') return;

    setBusyOrderId(order.id);
    setBusyAction('confirm');
    setProofFeedback((prev) => {
      const next = { ...prev };
      delete next[order.id];
      return next;
    });

    try {
      const existingQueued = queuedByOrderId.get(order.id);
      const proofDataUrl =
        existingQueued?.proofDataUrl || order.deliveryProofImageUrl || '';
      const isInFeed = Boolean(activeFeedKey && feedOrderIdSet.has(order.id));
      const feedKey = activeFeedKey || DEFAULT_DELIVERY_FEED_KEY;
      const telegramMeta = buildTelegramOrderMeta(order, activeStoreName);

      const entry: QueuedDeliveryProof = {
        orderId: order.id,
        orderNumber: order.orderNumber,
        feedKey,
        isInFeed,
        targetStatus: 'completed',
        proofDataUrl,
        fileName: existingQueued?.fileName || 'bukti-pengiriman',
        mimeType: existingQueued?.mimeType || 'image/jpeg',
        createdAtMs: Date.now(),
        telegramMeta,
      };

      await saveQueuedProof(entry);
      setQueuedProofs(await getAllQueuedProofs());

      const currentlyOnline =
        typeof navigator === 'undefined' || navigator.onLine !== false;

      if (!currentlyOnline) {
        setProofFeedback((prev) => ({
          ...prev,
          [order.id]: {
            tone: 'warn',
            text: `Tercatat "Sudah Diterima Pelanggan" di perangkat (Mode Offline). Status ke Admin & notifikasi Telegram ke ${order.customerPhone} akan otomatis terkirim begitu jaringan aktif.`,
          },
        }));
        return;
      }

      try {
        await syncProofEntryToFirestore(entry);
        await removeQueuedProof(order.id);
        setQueuedProofs(await getAllQueuedProofs());

        // Automatically dispatch delivered notification + proof image to Customer Telegram
        const tgResult = await triggerTelegramDeliveredDispatch(
          telegramMeta,
          feedKey,
          proofDataUrl,
          false
        );

        setProofFeedback((prev) => ({
          ...prev,
          [order.id]: {
            tone: 'ok',
            text: tgResult.sentToCustomer
              ? `Pesanan SUDAH DITERIMA pelanggan — ter-update di akun Admin & notifikasi + foto bukti otomatis terkirim ke Telegram pelanggan (${order.customerPhone})!`
              : tgResult.sentToAdminGroup
                ? `Pesanan SUDAH DITERIMA & ter-update di Admin (salinan foto & notif terkirim ke grup Telegram toko). Lanjutkan kirim ke chat pelanggan (${order.customerPhone}) lewat tombol Telegram di bawah.`
                : `Pesanan SUDAH DITERIMA & ter-update di akun Admin! Panel kirim notifikasi + foto bukti ke Telegram pelanggan (${order.customerPhone}) sudah disiapkan di bawah.`,
          },
        }));
      } catch {
        setProofFeedback((prev) => ({
          ...prev,
          [order.id]: {
            tone: 'warn',
            text: `Konfirmasi "Sudah Diterima" tersimpan di antrean perangkat karena jaringan belum stabil — status ke Admin & notifikasi Telegram (${order.customerPhone}) akan otomatis dikirim saat sinyal kembali.`,
          },
        }));
      }
    } finally {
      setBusyOrderId((prev) => (prev === order.id ? null : prev));
      setBusyAction(null);
    }
  };

  const handleManualTelegramDispatch = async (
    order: DisplayDeliveryOrder,
    forceResend = true
  ) => {
    const existingQueued = queuedByOrderId.get(order.id);
    const proofDataUrl =
      existingQueued?.proofDataUrl || order.deliveryProofImageUrl || '';
    const feedKey = activeFeedKey || DEFAULT_DELIVERY_FEED_KEY;
    const telegramMeta = buildTelegramOrderMeta(order, activeStoreName);
    await triggerTelegramDeliveredDispatch(
      telegramMeta,
      feedKey,
      proofDataUrl,
      forceResend
    );
  };

  const handleNativeShareToTelegram = async (
    order: DisplayDeliveryOrder,
    messageText: string
  ) => {
    const proofDataUrl =
      queuedByOrderId.get(order.id)?.proofDataUrl ||
      order.deliveryProofImageUrl ||
      '';
    const outcome = await shareProofAndMessageNatively(
      messageText,
      proofDataUrl,
      order.orderNumber
    );
    if (outcome === 'shared') {
      setShareNoticeByOrder((prev) => ({
        ...prev,
        [order.id]: `Notifikasi & foto bukti dibagikan ke Telegram pelanggan (${order.customerPhone}).`,
      }));
    } else if (outcome === 'unsupported') {
      setShareNoticeByOrder((prev) => ({
        ...prev,
        [order.id]:
          'Browser desktop tidak mendukung bagikan file langsung — gunakan tombol "Buka Chat Telegram" & "Unduh Foto Bukti".',
      }));
    }
  };

  const handleCopyTelegramMessage = async (orderId: string, text: string) => {
    await copyTextToClipboard(text);
    setCopiedTelegramMsgId(orderId);
    window.setTimeout(() => {
      setCopiedTelegramMsgId((prev) => (prev === orderId ? null : prev));
    }, 1800);
  };

  return (
    <div className="min-h-screen bg-transparent">
      <div className={`h-1.5 w-full ${activeTheme.topBar}`} />
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        {/* Top Header */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start gap-3.5 min-w-0">
            <img
              src={master.storeLogoUrl || DEFAULT_MASTER_CONFIG.storeLogoUrl}
              alt={activeStoreName}
              referrerPolicy="no-referrer"
              onError={(e) => {
                const img = e.currentTarget;
                if (!img.dataset.fallbackApplied) {
                  img.dataset.fallbackApplied = '1';
                  img.src = DEFAULT_MASTER_CONFIG.storeLogoUrl;
                }
              }}
              className="w-11 h-11 rounded-xl object-contain bg-white border border-slate-200 p-1 shrink-0"
            />
            <div className="space-y-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-semibold text-red-600">
                  Portal Kurir Delivery · 1-Klik Tanpa Email
                </span>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1 font-semibold text-blue-700">
                  <Eye className="w-3.5 h-3.5" />
                  <span>Foto/File Bukti (Bisa Offline) &amp; Konfirmasi Diterima</span>
                </span>
              </div>
              <h1 className="font-display text-2xl font-bold text-slate-900">
                Daftar Pengiriman · {activeStoreName}
              </h1>
              <p className="text-xs text-slate-600">
                Unggah foto atau file bukti meskipun <strong>tanpa jaringan (offline)</strong>. Setelah disimpan, keterangan masih <strong>Belum Diterima</strong> — saat tombol <strong>Sudah Diterima Pelanggan</strong> diklik, status langsung ter-update di akun Admin sekaligus <strong>mengirim notifikasi &amp; foto bukti ke Telegram pelanggan</strong> yang dimasukkan saat checkout.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <span
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border rounded-lg whitespace-nowrap ${
                isOnline
                  ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                  : 'text-amber-800 bg-amber-50 border-amber-300'
              }`}
            >
              {isOnline ? (
                <>
                  <Wifi className="w-3.5 h-3.5" />
                  <span>Online Real-Time</span>
                </>
              ) : (
                <>
                  <WifiOff className="w-3.5 h-3.5" />
                  <span>Mode Offline (Tetap Bisa Upload)</span>
                </>
              )}
            </span>
            <button
              type="button"
              onClick={handleCopyDeliveryPortalUrl}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 cursor-pointer whitespace-nowrap"
            >
              {copiedDeliveryUrl ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Link Delivery Disalin</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Salin Link 1-Klik Kurir</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() =>
                downloadSinglePortalDomainZip('delivery', {
                  storeName: activeStoreName,
                  customBaseOrigin: master.permanentStoreUrl,
                })
              }
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download ZIP Deliveri</span>
            </button>
          </div>
        </div>

        {/* Offline Queue / Auto-Sync Status Banner */}
        {(!isOnline || queuedProofs.length > 0) && (
          <div
            className={`p-4 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
              !isOnline
                ? 'bg-amber-50 border-amber-300 text-amber-950'
                : 'bg-blue-50 border-blue-200 text-blue-950'
            }`}
          >
            <div className="flex items-start gap-2.5 text-xs leading-relaxed">
              <CloudOff className="w-4 h-4 shrink-0 mt-0.5 text-amber-700" />
              <div className="space-y-0.5">
                <p className="font-bold">
                  {!isOnline
                    ? 'Jaringan Internet Sedang Tidak Aktif — Mode Offline Aktif'
                    : `${queuedProofs.length} Bukti/Konfirmasi Menunggu Sinkronisasi ke Akun Admin`}
                </p>
                <p className="opacity-90">
                  {!isOnline
                    ? `Anda tetap dapat mengambil foto, memilih file, dan menekan "Sudah Diterima". ${
                        queuedProofs.length > 0
                          ? `Saat ini ada ${queuedProofs.length} data tersimpan aman di perangkat dan akan otomatis terkirim begitu jaringan kembali.`
                          : 'Semua foto/file akan disimpan aman di perangkat dan otomatis terkirim saat sinyal kembali.'
                      }`
                    : 'Koneksi internet sudah aktif. Sistem sedang menyinkronkan data offline ke server Admin secara otomatis.'}
                </p>
              </div>
            </div>

            {queuedProofs.length > 0 && (
              <button
                type="button"
                disabled={!isOnline || syncingQueue}
                onClick={() => flushOfflineQueue()}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${syncingQueue ? 'animate-spin' : ''}`}
                />
                <span>
                  {syncingQueue
                    ? 'Menyinkronkan...'
                    : `Kirim Antrean (${queuedProofs.length})`}
                </span>
              </button>
            )}
          </div>
        )}

        {/* Delivery History Statistics Strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs text-slate-500">Total Riwayat Pesanan</p>
            <p className="font-mono tabular-nums text-2xl font-bold text-slate-900 mt-1">
              {stats.total}
            </p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs text-slate-500">Menunggu / Diproses</p>
            <p className="font-mono tabular-nums text-2xl font-bold text-amber-600 mt-1">
              {stats.waitingAndPrep}
            </p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs text-slate-500">Sedang Dikirim / Belum Diterima</p>
            <p className="font-mono tabular-nums text-2xl font-bold text-blue-700 mt-1">
              {stats.shippedCount}
            </p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs text-slate-500">Sudah Diterima (Selesai)</p>
            <div className="flex items-baseline gap-2 mt-1">
              <p className="font-mono tabular-nums text-2xl font-bold text-emerald-700">
                {stats.completedCount}
              </p>
              <span className="font-mono text-xs font-semibold text-emerald-700">
                ({stats.completionRate}%)
              </span>
            </div>
          </div>
        </div>

        {/* Filter & Search Bar */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-center gap-1 p-1 bg-white border border-slate-200 rounded-lg overflow-x-auto w-fit max-w-full">
            {(
              [
                ['all', 'Semua'],
                ['pending', 'Menunggu'],
                ['processing', 'Diproses'],
                ['shipped', 'Dikirim'],
                ['completed', 'Selesai'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setStatusFilter(key)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  statusFilter === key
                    ? 'bg-blue-700 text-white'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Cari nomor order, penerima, Telegram..."
              className="w-full md:w-72 pl-9 pr-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
            />
          </div>
        </div>

        {/* Orders & Recipient Addresses List */}
        {loading ? (
          <div className="space-y-4">
            {Array.from({ length: 3 }).map((_, idx) => (
              <div
                key={idx}
                className="h-44 bg-white border border-slate-200 rounded-xl animate-pulse"
              />
            ))}
          </div>
        ) : filteredOrders.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-12 text-center space-y-2">
            <Truck className="w-9 h-9 text-slate-300 mx-auto" />
            <p className="text-sm font-semibold text-slate-900">
              Belum ada pesanan masuk untuk pengiriman
            </p>
            <p className="text-xs text-slate-500 max-w-md mx-auto">
              Setiap pesanan pelanggan yang berhasil checkout akan otomatis muncul di daftar ini beserta alamat dan lokasi GPS penerima.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {filteredOrders.map((order) => {
              const statusMeta = ORDER_STATUS_META[order.status];
              const hasLegacyTextAddress = Boolean(
                order.shippingAddress || order.city || order.postalCode
              );
              const mapsHref = getMapsHref(order);
              const queuedItem = queuedByOrderId.get(order.id);
              const hasSavedProof = Boolean(order.deliveryProofImageUrl);
              const isBusyThis = busyOrderId === order.id;

              return (
                <article
                  key={order.id}
                  className="bg-white border border-slate-200 rounded-xl overflow-hidden"
                >
                  {/* Order Top Header */}
                  <div className="px-5 py-3.5 bg-slate-50/70 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-3 text-xs">
                      <span className="font-mono font-bold text-slate-900 text-sm">
                        {order.orderNumber}
                      </span>
                      <span aria-hidden="true" className="text-slate-300">·</span>
                      <span className="text-slate-500">
                        Dibuat: {formatTimestamp(order.createdAt)}
                      </span>
                      {order.trackingNumber && (
                        <>
                          <span aria-hidden="true" className="text-slate-300">·</span>
                          <span className="font-mono font-semibold text-blue-700">
                            Resi: {order.trackingNumber}
                          </span>
                        </>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-mono font-bold text-emerald-700">
                        FREE DELIVERY
                      </span>
                      <span aria-hidden="true" className="text-slate-300">·</span>
                      {order.status !== 'completed' &&
                        order.status !== 'cancelled' &&
                        hasSavedProof && (
                          <span className="px-2.5 py-0.5 font-semibold border rounded-md bg-amber-50 text-amber-800 border-amber-300">
                            Belum Diterima
                          </span>
                        )}
                      <span
                        className={`px-2.5 py-0.5 font-semibold border rounded-md ${statusMeta.toneClass}`}
                      >
                        {order.status === 'completed'
                          ? 'Sudah Diterima (Selesai)'
                          : statusMeta.label}
                      </span>
                    </div>
                  </div>

                  {/* Live Status Update Banner */}
                  <div className="px-5 py-2 bg-blue-50/40 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
                    <span className="inline-flex items-center gap-1.5 font-medium text-slate-700">
                      <Clock className="w-3.5 h-3.5 text-blue-700 shrink-0" />
                      <span>
                        Pembaruan Status Terakhir:{' '}
                        <strong className="text-slate-900">
                          {formatTimestamp(order.updatedAt || order.createdAt)}
                        </strong>
                      </span>
                    </span>
                    <span className="text-slate-600">
                      {queuedItem ? (
                        <span className="font-semibold text-amber-800">
                          Tersimpan Offline · Menunggu sinyal untuk sinkron ke Admin
                        </span>
                      ) : order.status === 'completed' ? (
                        <span className="font-semibold text-emerald-700">
                          Sudah Diterima Pelanggan · Ter-update di Akun Admin
                        </span>
                      ) : hasSavedProof ? (
                        <span className="font-semibold text-amber-800">
                          Foto/File Tersimpan · Keterangan: Belum Diterima
                        </span>
                      ) : (
                        '1) Simpan Foto/File Bukti (Bisa Offline) → 2) Klik Sudah Diterima'
                      )}
                    </span>
                  </div>

                  {/* Two-Column Body: Left = Recipient Address & GPS, Right = Order Items */}
                  <div className="p-5 grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Recipient & Address / GPS Location */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <h2 className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                          <MapPin className="w-4 h-4 text-red-600 shrink-0" />
                          <span>Data &amp; Alamat Penerima</span>
                        </h2>
                        <button
                          type="button"
                          onClick={() => handleCopyRecipient(order)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-md hover:bg-slate-100 cursor-pointer"
                        >
                          {copiedId === order.id ? (
                            <>
                              <Check className="w-3.5 h-3.5 text-emerald-600" />
                              <span>Tersalin</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5" />
                              <span>Salin Lokasi</span>
                            </>
                          )}
                        </button>
                      </div>

                      <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-2 text-xs">
                        <p className="text-sm font-bold text-slate-900">
                          {order.customerName}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <MessageCircle className="w-3.5 h-3.5 text-sky-600 shrink-0" />
                          <span className="text-slate-500">Telegram:</span>
                          {getTelegramContactHref(order.customerPhone) ? (
                            <a
                              href={getTelegramContactHref(order.customerPhone)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-mono font-semibold text-blue-700 hover:underline inline-flex items-center gap-1"
                            >
                              <span>{order.customerPhone}</span>
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          ) : (
                            <span className="font-mono font-semibold text-slate-800">
                              {order.customerPhone}
                            </span>
                          )}
                        </div>

                        {hasLegacyTextAddress && (
                          <p className="text-slate-700 leading-relaxed">
                            {[order.shippingAddress, order.city, order.postalCode]
                              .filter(Boolean)
                              .join(', ')}
                          </p>
                        )}

                        {order.locationDetail && (
                          <p className="text-slate-600">
                            Patokan: {order.locationDetail}
                          </p>
                        )}

                        {order.locationCoords && (
                          <p className="font-mono text-blue-700">
                            Lokasi GPS: {order.locationCoords}
                          </p>
                        )}

                        {order.locationImageUrl && (
                          <div className="pt-1 space-y-1">
                            <p className="text-[11px] font-semibold text-slate-700">
                              Foto Lokasi Penerima:
                            </p>
                            <img
                              src={order.locationImageUrl}
                              alt={`Foto lokasi ${order.customerName}`}
                              className="w-full max-h-48 object-cover rounded-lg border border-slate-200 bg-white"
                            />
                          </div>
                        )}

                        <div className="pt-1">
                          <a
                            href={mapsHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                            <span>Buka Lokasi GPS di Peta</span>
                          </a>
                        </div>
                      </div>
                    </div>

                    {/* Order Items & Payment Info */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <h2 className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                          <Package className="w-4 h-4 text-blue-700 shrink-0" />
                          <span>Rincian Pesanan</span>
                        </h2>
                        <span
                          className={`font-mono text-xs font-bold ${
                            order.currency === 'KHR'
                              ? 'text-red-600'
                              : 'text-blue-700'
                          }`}
                        >
                          {order.paymentMethod} ({order.currency}) ·{' '}
                          {formatAmountByCurrency(
                            order.totalAmount,
                            order.currency || 'USD'
                          )}
                        </span>
                      </div>

                      <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
                        {order.items.map((item) => (
                          <div
                            key={item.productId}
                            className="px-3.5 py-2.5 flex items-center justify-between gap-3 text-xs"
                          >
                            <div className="min-w-0">
                              <p className="font-semibold text-slate-900 truncate">
                                {item.name}
                              </p>
                              <p className="font-mono text-[11px] text-slate-500">
                                {item.sku}
                              </p>
                            </div>
                            <span className="font-mono tabular-nums font-bold text-slate-900 shrink-0">
                              {item.quantity} {normalizeProductUnit(item.unit)}
                            </span>
                          </div>
                        ))}
                      </div>

                      {order.notes && (
                        <p className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                          Catatan: {order.notes}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* 2-Step Delivery Proof (Offline-Capable) & Customer Received Confirmation */}
                  {order.status !== 'cancelled' && (
                    <div className="px-5 pb-5 space-y-3">
                      {proofFeedback[order.id] && (
                        <div
                          className={`px-3.5 py-2.5 rounded-lg border text-xs font-medium flex items-start gap-2 ${
                            proofFeedback[order.id].tone === 'ok'
                              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                              : proofFeedback[order.id].tone === 'warn'
                                ? 'bg-amber-50 border-amber-300 text-amber-950'
                                : 'bg-rose-50 border-rose-200 text-rose-800'
                          }`}
                        >
                          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                          <span>{proofFeedback[order.id].text}</span>
                        </div>
                      )}

                      {order.status !== 'completed' ? (
                        <div
                          className={`p-4 border rounded-xl space-y-4 ${
                            hasSavedProof
                              ? 'bg-amber-50/70 border-amber-300'
                              : 'bg-slate-50 border-slate-200'
                          }`}
                        >
                          {/* Step 1 Header & Upload Controls */}
                          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                            <div className="space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="text-sm font-bold text-slate-900 flex items-center gap-2">
                                  <Camera className="w-4 h-4 text-blue-700 shrink-0" />
                                  <span>
                                    {hasSavedProof
                                      ? 'Foto / File Bukti Tersimpan'
                                      : 'Langkah 1 · Foto / Unggah File Bukti Pengiriman'}
                                  </span>
                                </p>
                                {hasSavedProof && (
                                  <span className="px-2 py-0.5 text-[11px] font-bold rounded bg-amber-200/80 text-amber-950 border border-amber-300">
                                    Keterangan: BELUM DITERIMA
                                  </span>
                                )}
                                {queuedItem && (
                                  <span className="px-2 py-0.5 text-[11px] font-semibold rounded bg-blue-100 text-blue-900 border border-blue-200">
                                    Tersimpan Offline
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-slate-700 leading-relaxed">
                                {hasSavedProof
                                  ? 'Bukti foto/file sudah tersimpan dengan keterangan BELUM DITERIMA. Jika barang sudah diserahkan kepada pelanggan, klik tombol "Sudah Diterima Pelanggan" di bawah agar langsung ter-update di akun Admin.'
                                  : 'Ambil foto atau pilih file (Foto/PDF) — tetap bisa disimpan meski tanpa jaringan (offline). Setelah disimpan, keterangan tetap BELUM DITERIMA sampai Anda menekan tombol Sudah Diterima.'}
                              </p>
                            </div>

                            {/* Camera / Gallery / File Buttons */}
                            <div className="flex flex-wrap items-center gap-2 shrink-0">
                              <label
                                className={`inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 text-xs font-bold text-white rounded-lg transition-colors shadow-xs whitespace-nowrap ${
                                  isBusyThis && busyAction === 'upload'
                                    ? 'bg-blue-700/70 cursor-wait'
                                    : 'bg-blue-700 hover:bg-blue-800 cursor-pointer'
                                }`}
                              >
                                {isBusyThis && busyAction === 'upload' ? (
                                  <>
                                    <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                                    <span>Menyimpan...</span>
                                  </>
                                ) : (
                                  <>
                                    <Camera className="w-4 h-4 shrink-0" />
                                    <span>
                                      {hasSavedProof ? 'Foto Ulang' : 'Foto & Simpan'}
                                    </span>
                                  </>
                                )}
                                <input
                                  type="file"
                                  accept="image/*"
                                  capture="environment"
                                  disabled={busyOrderId !== null}
                                  onChange={(e) => {
                                    const f = e.target.files?.[0] || null;
                                    e.target.value = '';
                                    handleSaveProofAttachment(order, f);
                                  }}
                                  className="hidden"
                                />
                              </label>

                              <label
                                className={`inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg transition-colors whitespace-nowrap ${
                                  busyOrderId !== null
                                    ? 'opacity-50 cursor-not-allowed'
                                    : 'hover:bg-slate-100 cursor-pointer'
                                }`}
                              >
                                <ImageIcon className="w-3.5 h-3.5 shrink-0 text-blue-700" />
                                <span>Galeri</span>
                                <input
                                  type="file"
                                  accept="image/*"
                                  disabled={busyOrderId !== null}
                                  onChange={(e) => {
                                    const f = e.target.files?.[0] || null;
                                    e.target.value = '';
                                    handleSaveProofAttachment(order, f);
                                  }}
                                  className="hidden"
                                />
                              </label>

                              <label
                                className={`inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg transition-colors whitespace-nowrap ${
                                  busyOrderId !== null
                                    ? 'opacity-50 cursor-not-allowed'
                                    : 'hover:bg-slate-100 cursor-pointer'
                                }`}
                              >
                                <FileUp className="w-3.5 h-3.5 shrink-0 text-red-600" />
                                <span>Pilih File</span>
                                <input
                                  type="file"
                                  accept="image/*,application/pdf,.pdf,.jpg,.jpeg,.png,.webp,.heic,.heif"
                                  disabled={busyOrderId !== null}
                                  onChange={(e) => {
                                    const f = e.target.files?.[0] || null;
                                    e.target.value = '';
                                    handleSaveProofAttachment(order, f);
                                  }}
                                  className="hidden"
                                />
                              </label>
                            </div>
                          </div>

                          {/* Saved Proof Preview (while status is Belum Diterima) */}
                          {hasSavedProof && order.deliveryProofImageUrl && (
                            <div className="pt-3 border-t border-amber-200/80 space-y-2">
                              <p className="text-xs font-semibold text-amber-950">
                                Preview Bukti Tersimpan (Keterangan: Belum Diterima Pelanggan):
                              </p>
                              <ProofAttachmentPreview
                                dataUrl={order.deliveryProofImageUrl}
                                orderNumber={order.orderNumber}
                                maxHeightClass="max-h-56"
                              />
                            </div>
                          )}

                          {/* Step 2: Confirm Received by Customer -> Direct Update to Admin + Auto Telegram Notify */}
                          <div className="pt-3 border-t border-slate-200/90 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                            <div className="text-xs text-slate-700 space-y-0.5">
                              <p className="font-bold text-slate-900">
                                Langkah 2 · Konfirmasi Barang Sudah Diterima Pelanggan
                              </p>
                              <p className="text-slate-600">
                                Status <strong>{order.orderNumber}</strong> langsung ter-update di akun Admin dan notifikasi + foto bukti otomatis dikirim ke Telegram pelanggan (<strong>{order.customerPhone}</strong>).
                              </p>
                            </div>
                            <button
                              type="button"
                              disabled={busyOrderId !== null}
                              onClick={() => handleConfirmCustomerReceived(order)}
                              className={`inline-flex items-center justify-center gap-2 px-5 py-3 text-xs sm:text-sm font-bold text-white rounded-lg shadow-sm transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 ${
                                isBusyThis && busyAction === 'confirm'
                                  ? 'bg-emerald-600/70 cursor-wait'
                                  : 'bg-emerald-600 hover:bg-emerald-700'
                              }`}
                            >
                              {isBusyThis && busyAction === 'confirm' ? (
                                <>
                                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                                  <span>Memperbarui &amp; Kirim Telegram...</span>
                                </>
                              ) : (
                                <>
                                  <PackageCheck className="w-4 h-4 shrink-0" />
                                  <span>Sudah Diterima Pelanggan</span>
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl space-y-3">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                            <span className="inline-flex items-center gap-1.5 font-bold text-emerald-900">
                              <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                              <span>
                                Sudah Diterima Pelanggan · Selesai Diantar
                                {queuedItem
                                  ? ' (Menunggu Sinyal untuk Sync ke Admin)'
                                  : ' · Ter-update di Akun Admin'}
                              </span>
                            </span>
                            <span className="font-mono text-emerald-800">
                              Selesai: {formatTimestamp(order.updatedAt || order.createdAt)}
                            </span>
                          </div>

                          {order.deliveryProofImageUrl ? (
                            <ProofAttachmentPreview
                              dataUrl={order.deliveryProofImageUrl}
                              orderNumber={order.orderNumber}
                              maxHeightClass="max-h-60"
                            />
                          ) : (
                            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                              <p className="text-xs text-emerald-800">
                                Belum ada lampiran foto/file bukti. Anda tetap bisa melampirkan bukti:
                              </p>
                              <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-900 bg-white border border-emerald-300 rounded-lg hover:bg-emerald-100 cursor-pointer">
                                <Camera className="w-3.5 h-3.5" />
                                <span>Lampirkan Foto / File</span>
                                <input
                                  type="file"
                                  accept="image/*,application/pdf,.pdf,.jpg,.jpeg,.png,.webp,.heic,.heif"
                                  disabled={busyOrderId !== null}
                                  onChange={(e) => {
                                    const f = e.target.files?.[0] || null;
                                    e.target.value = '';
                                    handleSaveProofAttachment(order, f);
                                  }}
                                  className="hidden"
                                />
                              </label>
                            </div>
                          )}

                          {/* Customer Telegram Delivery Notification Status & 1-Tap Handoff */}
                          {(() => {
                            const tgResult = telegramDispatchByOrder[order.id];
                            const isSendingTg = sendingTelegramOrderId === order.id;
                            const proofUrl = order.deliveryProofImageUrl || '';
                            const supportsNativeFileShare =
                              Boolean(proofUrl) &&
                              canUseNativeFileShare(proofUrl, order.orderNumber);

                            if (tgResult?.sentToCustomer) {
                              return (
                                <div className="pt-2 border-t border-emerald-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 text-xs">
                                  <div className="flex items-start gap-2 text-emerald-900">
                                    <Send className="w-4 h-4 text-[#0088cc] shrink-0 mt-0.5" />
                                    <span>
                                      <strong>Notifikasi &amp; Foto Bukti Otomatis Terkirim</strong> ke Telegram pelanggan (
                                      <span className="font-mono font-semibold">
                                        {order.customerPhone}
                                      </span>
                                      ).
                                    </span>
                                  </div>
                                  <button
                                    type="button"
                                    disabled={isSendingTg}
                                    onClick={() => handleManualTelegramDispatch(order, true)}
                                    className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#0088cc] bg-white border border-sky-200 rounded-lg hover:bg-sky-50 cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50"
                                  >
                                    {isSendingTg ? (
                                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    ) : (
                                      <Send className="w-3.5 h-3.5" />
                                    )}
                                    <span>Kirim Ulang Telegram</span>
                                  </button>
                                </div>
                              );
                            }

                            if (tgResult?.fallbackRequired) {
                              return (
                                <div className="p-3.5 bg-sky-50 border border-sky-200 rounded-lg space-y-3 text-xs">
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="space-y-1">
                                      <p className="font-bold text-sky-950 flex items-center gap-1.5">
                                        <Send className="w-4 h-4 text-[#0088cc] shrink-0" />
                                        <span>
                                          Kirim Notifikasi &amp; Foto Bukti ke Telegram Pelanggan ({order.customerPhone})
                                        </span>
                                      </p>
                                      <p className="text-sky-900/90 leading-relaxed">
                                        {tgResult.botConfigured
                                          ? 'Akun Telegram pelanggan belum memulai percakapan dengan Bot toko, sehingga pesan tidak dapat dikirim diam-diam oleh Telegram. Klik tombol di bawah untuk langsung kirim notifikasi & foto ke chat pelanggan.'
                                          : 'Bot kirim otomatis latar belakang belum diaktifkan di server. Pesan notifikasi sudah disiapkan — klik tombol di bawah untuk langsung kirim foto & notifikasi ke Telegram pelanggan.'}
                                      </p>
                                    </div>
                                  </div>

                                  {shareNoticeByOrder[order.id] && (
                                    <p className="text-[11px] font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-2.5 py-1.5">
                                      {shareNoticeByOrder[order.id]}
                                    </p>
                                  )}

                                  <div className="flex flex-wrap items-center gap-2">
                                    {supportsNativeFileShare && (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          handleNativeShareToTelegram(
                                            order,
                                            tgResult.messageText
                                          )
                                        }
                                        className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-bold text-white bg-[#0088cc] hover:bg-[#0077b5] rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                                      >
                                        <Share2 className="w-3.5 h-3.5 shrink-0" />
                                        <span>Kirim Foto &amp; Notif ke Telegram</span>
                                      </button>
                                    )}

                                    {tgResult.directTelegramUrl && (
                                      <a
                                        href={tgResult.directTelegramUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className={`inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-bold rounded-lg transition-colors whitespace-nowrap ${
                                          supportsNativeFileShare
                                            ? 'text-[#0088cc] bg-white border border-sky-300 hover:bg-sky-100'
                                            : 'text-white bg-[#0088cc] hover:bg-[#0077b5]'
                                        }`}
                                      >
                                        <Send className="w-3.5 h-3.5 shrink-0" />
                                        <span>
                                          Buka Chat Telegram ({order.customerPhone})
                                        </span>
                                        <ExternalLink className="w-3 h-3 shrink-0" />
                                      </a>
                                    )}

                                    {proofUrl && (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          triggerProofFileDownload(
                                            proofUrl,
                                            order.orderNumber
                                          )
                                        }
                                        className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 cursor-pointer whitespace-nowrap"
                                      >
                                        <Download className="w-3.5 h-3.5 shrink-0 text-blue-700" />
                                        <span>Simpan Foto Bukti</span>
                                      </button>
                                    )}

                                    <button
                                      type="button"
                                      onClick={() =>
                                        handleCopyTelegramMessage(
                                          order.id,
                                          tgResult.messageText
                                        )
                                      }
                                      className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 cursor-pointer whitespace-nowrap"
                                    >
                                      {copiedTelegramMsgId === order.id ? (
                                        <>
                                          <Check className="w-3.5 h-3.5 text-emerald-600" />
                                          <span>Pesan Disalin</span>
                                        </>
                                      ) : (
                                        <>
                                          <Copy className="w-3.5 h-3.5" />
                                          <span>Salin Pesan</span>
                                        </>
                                      )}
                                    </button>

                                    <button
                                      type="button"
                                      disabled={isSendingTg}
                                      onClick={() =>
                                        handleManualTelegramDispatch(order, true)
                                      }
                                      className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-sky-900 bg-white border border-sky-200 rounded-lg hover:bg-sky-100 cursor-pointer whitespace-nowrap disabled:opacity-50"
                                    >
                                      {isSendingTg ? (
                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      ) : (
                                        <RefreshCw className="w-3.5 h-3.5" />
                                      )}
                                      <span>Coba Kirim Otomatis</span>
                                    </button>
                                  </div>
                                </div>
                              );
                            }

                            return (
                              <div className="pt-2 border-t border-emerald-200/80 flex flex-wrap items-center justify-between gap-2 text-xs">
                                <span className="text-emerald-900">
                                  Telegram Pelanggan:{' '}
                                  <strong className="font-mono">{order.customerPhone}</strong>
                                </span>
                                <button
                                  type="button"
                                  disabled={isSendingTg || !isOnline}
                                  onClick={() => handleManualTelegramDispatch(order, true)}
                                  className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-bold text-white bg-[#0088cc] hover:bg-[#0077b5] rounded-lg transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
                                >
                                  {isSendingTg ? (
                                    <>
                                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      <span>Mengirim ke Telegram...</span>
                                    </>
                                  ) : (
                                    <>
                                      <Send className="w-3.5 h-3.5" />
                                      <span>Kirim Notif &amp; Foto ke Telegram Pelanggan</span>
                                    </>
                                  )}
                                </button>
                              </div>
                            );
                          })()}
                        </div>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

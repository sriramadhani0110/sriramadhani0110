import type { DeliveryFeedOrder } from '../types/marketplace';
import type { TelegramOrderMeta } from './telegramNotify';

export interface QueuedDeliveryProof {
  orderId: string;
  orderNumber: string;
  feedKey: string;
  isInFeed: boolean;
  targetStatus: 'shipped' | 'completed';
  proofDataUrl: string;
  fileName: string;
  mimeType: string;
  createdAtMs: number;
  lastError?: string;
  telegramMeta?: TelegramOrderMeta;
}

const IDB_NAME = 'alpamart_offline_delivery_v1';
const IDB_STORE = 'pending_proofs';
const LS_QUEUE_KEY = 'alpamart_offline_proof_queue_v1';
const LS_ORDERS_CACHE_KEY = 'alpamart_cached_delivery_orders_v1';

function openOfflineDb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !('indexedDB' in window)) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = window.indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'orderId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function readLsQueue(): QueuedDeliveryProof[] {
  try {
    const raw = localStorage.getItem(LS_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is QueuedDeliveryProof =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof item.orderId === 'string' &&
        typeof item.proofDataUrl === 'string'
    );
  } catch {
    return [];
  }
}

function writeLsQueue(items: QueuedDeliveryProof[]): void {
  try {
    localStorage.setItem(LS_QUEUE_KEY, JSON.stringify(items));
  } catch {
    // Ignore storage quota errors if IndexedDB holds the payload
  }
}

export async function getAllQueuedProofs(): Promise<QueuedDeliveryProof[]> {
  const db = await openOfflineDb();
  if (!db) {
    return readLsQueue();
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const idbItems = Array.isArray(req.result)
          ? (req.result as QueuedDeliveryProof[])
          : [];
        const lsItems = readLsQueue();
        const merged = new Map<string, QueuedDeliveryProof>();
        for (const item of lsItems) merged.set(item.orderId, item);
        for (const item of idbItems) merged.set(item.orderId, item);
        resolve(
          Array.from(merged.values()).sort((a, b) => a.createdAtMs - b.createdAtMs)
        );
      };
      req.onerror = () => resolve(readLsQueue());
    } catch {
      resolve(readLsQueue());
    }
  });
}

export async function saveQueuedProof(entry: QueuedDeliveryProof): Promise<void> {
  const currentLs = readLsQueue().filter((x) => x.orderId !== entry.orderId);
  currentLs.push(entry);
  writeLsQueue(currentLs);

  const db = await openOfflineDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      store.put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function removeQueuedProof(orderId: string): Promise<void> {
  const nextLs = readLsQueue().filter((x) => x.orderId !== orderId);
  writeLsQueue(nextLs);

  const db = await openOfflineDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      store.delete(orderId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

interface SerializedCachedOrder {
  order: Omit<DeliveryFeedOrder, 'createdAt' | 'updatedAt'>;
  createdAtMs: number;
  updatedAtMs: number;
}

export function saveCachedDeliveryOrders(orders: DeliveryFeedOrder[]): void {
  try {
    // Store lightweight snapshot (trim large inline location images if total payload is huge)
    const serialized: SerializedCachedOrder[] = orders.slice(0, 60).map((o) => {
      const createdAtMs = o.createdAt?.toMillis?.() ?? 0;
      const updatedAtMs = o.updatedAt?.toMillis?.() ?? createdAtMs;
      return {
        order: {
          id: o.id,
          orderNumber: o.orderNumber,
          customerName: o.customerName,
          customerPhone: o.customerPhone,
          shippingAddress: o.shippingAddress || '',
          city: o.city || '',
          postalCode: o.postalCode || '',
          locationDetail: o.locationDetail || '',
          locationCoords: o.locationCoords || '',
          locationUrl: o.locationUrl || '',
          locationImageUrl: '',
          deliveryProofImageUrl: o.deliveryProofImageUrl || '',
          paymentMethod: o.paymentMethod,
          currency: o.currency,
          shippingMethod: o.shippingMethod,
          notes: o.notes || '',
          items: o.items,
          totalAmount: o.totalAmount,
          trackingNumber: o.trackingNumber || '',
          status: o.status,
        },
        createdAtMs,
        updatedAtMs,
      };
    });
    localStorage.setItem(LS_ORDERS_CACHE_KEY, JSON.stringify(serialized));
  } catch {
    // Retry without inline proof images if storage is near quota
    try {
      const minimal: SerializedCachedOrder[] = orders.slice(0, 40).map((o) => {
        const createdAtMs = o.createdAt?.toMillis?.() ?? 0;
        const updatedAtMs = o.updatedAt?.toMillis?.() ?? createdAtMs;
        return {
          order: {
            id: o.id,
            orderNumber: o.orderNumber,
            customerName: o.customerName,
            customerPhone: o.customerPhone,
            shippingAddress: o.shippingAddress || '',
            city: o.city || '',
            postalCode: o.postalCode || '',
            locationDetail: o.locationDetail || '',
            locationCoords: o.locationCoords || '',
            locationUrl: o.locationUrl || '',
            locationImageUrl: '',
            deliveryProofImageUrl: '',
            paymentMethod: o.paymentMethod,
            currency: o.currency,
            shippingMethod: o.shippingMethod,
            notes: o.notes || '',
            items: o.items,
            totalAmount: o.totalAmount,
            trackingNumber: o.trackingNumber || '',
            status: o.status,
          },
          createdAtMs,
          updatedAtMs,
        };
      });
      localStorage.setItem(LS_ORDERS_CACHE_KEY, JSON.stringify(minimal));
    } catch {
      // Ignore quota errors
    }
  }
}

export function loadCachedDeliveryOrders(): DeliveryFeedOrder[] {
  try {
    const raw = localStorage.getItem(LS_ORDERS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is SerializedCachedOrder =>
          Boolean(item?.order) && typeof item.order.id === 'string'
      )
      .map((item) => ({
        ...item.order,
        createdAt: item.createdAtMs
          ? ({ toMillis: () => item.createdAtMs, toDate: () => new Date(item.createdAtMs) } as DeliveryFeedOrder['createdAt'])
          : null,
        updatedAt: item.updatedAtMs
          ? ({ toMillis: () => item.updatedAtMs, toDate: () => new Date(item.updatedAtMs) } as DeliveryFeedOrder['updatedAt'])
          : null,
      }));
  } catch {
    return [];
  }
}

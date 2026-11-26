import type { StoreCheckoutConfig, StoreMasterConfig } from '../types/marketplace';

const CHANNEL_NAME = 'alpamart_cross_account_sync_v1';

export type CrossTabEvent =
  | { type: 'cart_updated'; timestamp: number }
  | { type: 'guest_orders_updated'; timestamp: number }
  | { type: 'revision_broadcast'; source: string; timestamp: number }
  | { type: 'app_version_updated'; version: string; timestamp: number };

let sharedChannel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
    return null;
  }
  if (!sharedChannel) {
    try {
      sharedChannel = new BroadcastChannel(CHANNEL_NAME);
    } catch {
      return null;
    }
  }
  return sharedChannel;
}

export type CrossTabEventInput =
  | { type: 'cart_updated' }
  | { type: 'guest_orders_updated' }
  | { type: 'revision_broadcast'; source: string }
  | { type: 'app_version_updated'; version: string };

export function broadcastCrossTabEvent(event: CrossTabEventInput): void {
  const payload = { ...event, timestamp: Date.now() } as CrossTabEvent;
  try {
    getChannel()?.postMessage(payload);
  } catch {
    // Ignore restricted/private-mode BroadcastChannel failures
  }
}

export function subscribeCrossTabEvents(
  handler: (event: CrossTabEvent) => void
): () => void {
  const channel = getChannel();
  if (!channel) return () => undefined;
  const listener = (msg: MessageEvent<CrossTabEvent>) => {
    if (msg.data && typeof msg.data.type === 'string') {
      handler(msg.data);
    }
  };
  channel.addEventListener('message', listener);
  return () => {
    channel.removeEventListener('message', listener);
  };
}

function extractTimestampMs(ts: unknown): number {
  if (!ts) return 0;
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (typeof ts === 'object' && ts !== null) {
    const maybe = ts as { toMillis?: () => number; seconds?: number };
    if (typeof maybe.toMillis === 'function') {
      try {
        return maybe.toMillis();
      } catch {
        return 0;
      }
    }
    if (typeof maybe.seconds === 'number' && Number.isFinite(maybe.seconds)) {
      return maybe.seconds * 1000;
    }
  }
  return 0;
}

/**
 * Unifies Master Data config and Checkout config so any exchange rate revision
 * in either Master Data or Checkout Settings immediately reflects across ALL accounts.
 */
export function resolveEffectiveMasterConfig(
  masterConfig: StoreMasterConfig,
  checkoutConfig?: StoreCheckoutConfig | null
): StoreMasterConfig {
  const base: StoreMasterConfig = { ...masterConfig };

  if (
    base.primaryCurrencyCode === 'USD' &&
    base.secondaryCurrencyCode === 'KHR' &&
    checkoutConfig &&
    Number.isFinite(checkoutConfig.exchangeRateKhr) &&
    checkoutConfig.exchangeRateKhr >= 1000 &&
    checkoutConfig.exchangeRateKhr <= 10000
  ) {
    const masterMissingRate = !Number.isFinite(base.exchangeRate) || base.exchangeRate <= 0;
    const masterTs = extractTimestampMs(base.updatedAt);
    const checkoutTs = extractTimestampMs(checkoutConfig.updatedAt);
    if (masterMissingRate || (checkoutTs > 0 && checkoutTs > masterTs)) {
      return {
        ...base,
        exchangeRate: checkoutConfig.exchangeRateKhr,
      };
    }
  }

  return base;
}

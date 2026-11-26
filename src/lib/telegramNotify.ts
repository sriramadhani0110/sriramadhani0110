import type { DeliveryFeedOrder } from '../types/marketplace';
import {
  formatAmountByCurrency,
  normalizeProductUnit,
  STORE_NAME,
} from './catalogSeed';

export interface TelegramOrderMeta {
  orderId: string;
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  itemsSummary: string;
  totalDisplay: string;
  storeName: string;
}

export interface TelegramDispatchResult {
  sentViaBot: boolean;
  sentToCustomer: boolean;
  sentToAdminGroup: boolean;
  botConfigured: boolean;
  fallbackRequired: boolean;
  reason: string;
  botUsername: string;
  directTelegramUrl: string;
  messageText: string;
  customerTelegramLabel: string;
  hasProofAttachment: boolean;
  dispatchedAtMs: number;
}

export function buildTelegramOrderMeta(
  order: DeliveryFeedOrder,
  storeName?: string
): TelegramOrderMeta {
  const safeStore = (storeName || STORE_NAME).trim() || STORE_NAME;
  const itemsSummary = order.items
    .map((item) => `• ${item.name} (${item.quantity} ${normalizeProductUnit(item.unit)})`)
    .join('\n');
  const totalDisplay = `${order.paymentMethod} (${order.currency || 'USD'}) · ${formatAmountByCurrency(
    order.totalAmount,
    order.currency || 'USD'
  )}`;

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    itemsSummary,
    totalDisplay,
    storeName: safeStore,
  };
}

export function buildDeliveredTelegramMessage(
  meta: TelegramOrderMeta,
  hasProofAttachment: boolean
): string {
  const nowStr = new Intl.DateTimeFormat('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date());

  const lines = [
    '✅ PESANAN SUDAH DITERIMA PELANGGAN',
    '',
    `Toko: ${meta.storeName}`,
    `No. Pesanan: ${meta.orderNumber}`,
    `Penerima: ${meta.customerName}`,
    'Status: Sudah Diterima Pelanggan (Selesai)',
    `Waktu Diterima: ${nowStr}`,
    `Total: ${meta.totalDisplay}`,
    '',
    'Rincian Pesanan:',
    meta.itemsSummary || '-',
    '',
    hasProofAttachment
      ? '📸 Foto/bukti pengiriman terlampir bersama pesan ini.'
      : null,
    `Terima kasih telah berbelanja di ${meta.storeName}!`,
  ].filter((line): line is string => line !== null);

  return lines.join('\n').slice(0, 1000);
}

/**
 * Normalizes a customer's checkout Telegram input (@username, t.me/..., or phone number)
 * into a strictly validated https://t.me/... deep link with pre-filled notification text.
 */
export function buildDirectTelegramNotifyUrl(
  rawContact: string,
  messageText?: string
): string {
  const raw = (rawContact || '').trim();
  if (!raw) return '';

  let cleaned = raw
    .replace(/^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\//i, '')
    .replace(/^(?:t\.me|telegram\.me)\//i, '')
    .split(/[?#]/)[0]
    .replace(/\/+$/, '')
    .trim();

  if (!cleaned) return '';

  let targetSegment = '';

  if (cleaned.startsWith('@')) {
    const uname = cleaned.replace(/^@+/, '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 64);
    if (uname.length >= 3) {
      targetSegment = uname;
    }
  } else if (/^[a-zA-Z][a-zA-Z0-9_]{3,63}$/.test(cleaned)) {
    targetSegment = cleaned;
  } else if (!/[a-zA-Z]/.test(cleaned)) {
    let digits = cleaned.replace(/\D/g, '');
    if (cleaned.startsWith('+')) {
      // keep international digits
    } else if (digits.startsWith('00')) {
      digits = digits.slice(2);
    } else if (digits.startsWith('08') && digits.length >= 10 && digits.length <= 13) {
      digits = `62${digits.slice(1)}`;
    } else if (digits.startsWith('0') && digits.length >= 9 && digits.length <= 10) {
      digits = `855${digits.slice(1)}`;
    }
    if (digits.length >= 7 && digits.length <= 16) {
      targetSegment = `+${digits}`;
    }
  }

  if (!targetSegment) return '';

  const baseUrl = `https://t.me/${targetSegment}`;
  if (!/^https:\/\/t\.me\/[a-zA-Z0-9_+]+$/.test(baseUrl)) {
    return '';
  }

  if (messageText && messageText.trim()) {
    return `${baseUrl}?text=${encodeURIComponent(messageText.trim().slice(0, 950))}`;
  }
  return baseUrl;
}

export function dataUrlToProofFile(
  dataUrl: string,
  orderNumber: string
): File | null {
  try {
    const match = dataUrl.match(
      /^data:(image\/(?:jpeg|jpg|png|webp|gif)|application\/pdf);base64,([A-Za-z0-9+/=\r\n]+)$/
    );
    if (!match) return null;

    const mimeType = match[1].toLowerCase();
    const base64 = match[2].replace(/\s+/g, '');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const ext =
      mimeType === 'application/pdf'
        ? 'pdf'
        : mimeType === 'image/png'
          ? 'png'
          : mimeType === 'image/webp'
            ? 'webp'
            : 'jpg';
    const slug = orderNumber.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'order';
    return new File([bytes], `bukti-${slug}.${ext}`, { type: mimeType });
  } catch {
    return null;
  }
}

export function canUseNativeFileShare(proofDataUrl: string, orderNumber: string): boolean {
  if (
    typeof navigator === 'undefined' ||
    typeof navigator.share !== 'function' ||
    typeof navigator.canShare !== 'function'
  ) {
    return false;
  }
  const file = dataUrlToProofFile(proofDataUrl, orderNumber);
  if (!file) return false;
  try {
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export async function shareProofAndMessageNatively(
  messageText: string,
  proofDataUrl: string,
  orderNumber: string
): Promise<'shared' | 'cancelled' | 'unsupported'> {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
    return 'unsupported';
  }

  const file = proofDataUrl ? dataUrlToProofFile(proofDataUrl, orderNumber) : null;
  try {
    if (file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
      await navigator.share({
        title: `Bukti Pengiriman ${orderNumber}`,
        text: messageText,
        files: [file],
      });
      return 'shared';
    }
    await navigator.share({
      title: `Notifikasi Pesanan ${orderNumber}`,
      text: messageText,
    });
    return 'shared';
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return 'cancelled';
    }
    return 'unsupported';
  }
}

export function triggerProofFileDownload(
  proofDataUrl: string,
  orderNumber: string
): boolean {
  const file = dataUrlToProofFile(proofDataUrl, orderNumber);
  if (!file) return false;
  try {
    const objectUrl = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = file.name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    window.setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
    }, 1500);
    return true;
  } catch {
    return false;
  }
}

export async function dispatchDeliveredTelegramNotification(params: {
  meta: TelegramOrderMeta;
  feedKey: string;
  proofDataUrl: string;
  forceResend?: boolean;
}): Promise<TelegramDispatchResult> {
  const hasProofAttachment = Boolean(params.proofDataUrl);
  const messageText = buildDeliveredTelegramMessage(params.meta, hasProofAttachment);
  const directTelegramUrl = buildDirectTelegramNotifyUrl(
    params.meta.customerPhone,
    messageText
  );

  const fallbackResult = (
    reason: string,
    botConfigured = false,
    botUsername = '',
    sentToAdminGroup = false
  ): TelegramDispatchResult => ({
    sentViaBot: sentToAdminGroup,
    sentToCustomer: false,
    sentToAdminGroup,
    botConfigured,
    fallbackRequired: true,
    reason,
    botUsername,
    directTelegramUrl,
    messageText,
    customerTelegramLabel: params.meta.customerPhone,
    hasProofAttachment,
    dispatchedAtMs: Date.now(),
  });

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return fallbackResult('OFFLINE');
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 14_000);

  try {
    const response = await fetch('/api/telegram/notify-delivered', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: params.meta.orderId,
        orderNumber: params.meta.orderNumber,
        feedKey: params.feedKey,
        customerName: params.meta.customerName,
        customerPhone: params.meta.customerPhone,
        messageText,
        proofDataUrl: params.proofDataUrl || '',
        forceResend: Boolean(params.forceResend),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return fallbackResult(`HTTP_${response.status}`);
    }

    const data = (await response.json()) as {
      ok?: boolean;
      sentViaBot?: boolean;
      sentToCustomer?: boolean;
      sentToAdminGroup?: boolean;
      botConfigured?: boolean;
      botUsername?: string;
      reason?: string;
    };

    const sentToCustomer = Boolean(data.sentToCustomer);
    const sentToAdminGroup = Boolean(data.sentToAdminGroup);

    return {
      sentViaBot: Boolean(data.sentViaBot),
      sentToCustomer,
      sentToAdminGroup,
      botConfigured: Boolean(data.botConfigured),
      fallbackRequired: !sentToCustomer,
      reason: data.reason || (sentToCustomer ? 'SENT' : 'BOT_NOT_CONFIGURED'),
      botUsername: data.botUsername || '',
      directTelegramUrl,
      messageText,
      customerTelegramLabel: params.meta.customerPhone,
      hasProofAttachment,
      dispatchedAtMs: Date.now(),
    };
  } catch {
    return fallbackResult('SERVER_UNAVAILABLE');
  } finally {
    window.clearTimeout(timer);
  }
}

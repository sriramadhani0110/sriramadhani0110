import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  writeBatch,
} from 'firebase/firestore';
import type { Timestamp } from 'firebase/firestore';
import type {
  AutomationSettings,
  CurrencyCode,
  Order,
  OrderStatus,
  PaymentMethod,
  Product,
  ProductCategory,
  ProductUnit,
  Promotion,
  ShippingMethod,
  StoreCategory,
} from '../types/marketplace';
import { PRODUCT_UNITS } from '../types/marketplace';
import { db, handleFirestoreError, OperationType } from './firebase';
import { getResilientItem, setResilientItem } from './sessionStorage';
import { broadcastCrossTabEvent } from './crossAccountSync';

export const STORE_NAME = 'ALPAMART TRIMUIA ONLAINE';
export const STORE_LINK = 'Alpamarttm.strore/Onaline/';
export const BOOTSTRAPPED_ADMIN_EMAIL = 'tmalpamartt@gmail.com';
export const MASTER_DATA_EMAIL = 'hananbintang30@gmail.com';
export const DEFAULT_DELIVERY_FEED_KEY = 'alpamart_kurir_feed_2026_trimuia_v1';

export const PORTAL_PATHS = {
  customer: '/Alpamart-tm.pelanggan',
  admin: '/Alpamart.tm-Admin',
  delivery: '/Alpamart.tm.deliveri',
  master: '/master',
} as const;

export function isMasterEmail(email?: string | null): boolean {
  const clean = (email || '').trim().toLowerCase();
  return clean === MASTER_DATA_EMAIL || clean === BOOTSTRAPPED_ADMIN_EMAIL;
}

export function normalizeProductUnit(raw: unknown): ProductUnit {
  const val = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if ((PRODUCT_UNITS as string[]).includes(val)) {
    return val as ProductUnit;
  }
  if (val === 'PC' || val === 'PIECE' || val === 'EA' || val === 'EACH') return 'PCS';
  if (val === 'PK' || val === 'PKT' || val === 'BUNGKUS') return 'PACK';
  if (val === 'BX' || val === 'KOTAK') return 'BOX';
  if (val === 'KILO' || val === 'KILOGRAM') return 'KG';
  if (val === 'L' || val === 'LTR' || val === 'LITRE') return 'LITER';
  if (val === 'BTL' || val === 'BOTTLE') return 'BOTOL';
  if (val === 'CARTON' || val === 'KARTON') return 'CTN';
  if (val === 'GRAM' || val === 'G') return 'GR';
  return 'PCS';
}

export function getProductKhrPrice(
  product: Pick<Product, 'price' | 'priceKhr'>,
  exchangeRate = USD_TO_KHR_RATE
): number {
  if (typeof product.priceKhr === 'number' && Number.isFinite(product.priceKhr) && product.priceKhr > 0) {
    return Math.round(product.priceKhr);
  }
  return Math.round(product.price * exchangeRate);
}

export function isProductSyncedPromoActive(
  product: Pick<
    Product,
    'price' | 'promoActive' | 'promoPriceUsd' | 'promoDiscountPercent' | 'promoStartDate' | 'promoEndDate'
  >
): boolean {
  if (!product.promoActive) return false;
  const hasLowerPrice =
    typeof product.promoPriceUsd === 'number' &&
    product.promoPriceUsd > 0 &&
    product.promoPriceUsd < product.price;
  const hasDiscountPct =
    typeof product.promoDiscountPercent === 'number' &&
    product.promoDiscountPercent > 0;
  if (!hasLowerPrice && !hasDiscountPct) return false;

  const nowMs = Date.now();
  if (product.promoStartDate) {
    const startMs = Date.parse(product.promoStartDate);
    if (!Number.isNaN(startMs) && nowMs < startMs) return false;
  }
  if (product.promoEndDate) {
    const endMs = Date.parse(product.promoEndDate);
    if (!Number.isNaN(endMs) && nowMs > endMs + 86_400_000) return false;
  }
  return true;
}

/**
 * Returns the active origin of the running storefront/portal.
 * Note: Private AI Studio dev preview origins (`ais-dev-...`) require developer authentication
 * and cannot be opened publicly by other phones until the app is deployed/shared.
 */
export function isPrivateDevPreviewOrigin(): boolean {
  if (typeof window === 'undefined' || !window.location.origin) return false;
  return window.location.origin.startsWith('https://ais-dev-');
}

export function getShareableOrigin(): string {
  if (typeof window === 'undefined' || !window.location.origin) {
    return 'https://alpamart.trimuia.online';
  }
  const rawOrigin = window.location.origin;
  if (rawOrigin.startsWith('https://ais-dev-')) {
    return rawOrigin.replace(/^https:\/\/ais-dev-/, 'https://ais-pre-');
  }
  return rawOrigin;
}

export function normalizePureOrigin(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.origin;
    }
  } catch {
    // fallback below
  }
  return trimmed.split(/[?#]/)[0].replace(/\/+$/, '');
}

export function getShareablePortalUrl(
  mode: 'customer' | 'delivery' | 'admin' | 'master',
  customOrigin?: string
): string {
  const base = normalizePureOrigin(customOrigin || getShareableOrigin()) || getShareableOrigin();
  if (mode === 'customer') return `${base}/`;
  if (mode === 'delivery') return `${base}/kurir`;
  return `${base}/${mode}`;
}

export function isLikelyTelegramBotContact(raw: string): boolean {
  const trimmed = (raw || '').trim();
  if (!trimmed) return false;
  const cleaned = trimmed
    .replace(/^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\//i, '')
    .replace(/^(?:t\.me|telegram\.me)\//i, '')
    .split(/[?#]/)[0]
    .replace(/\/+$/, '')
    .replace(/^@+/, '')
    .trim();
  return /^[a-zA-Z][a-zA-Z0-9_]{3,63}$/.test(cleaned) && /bot$/i.test(cleaned);
}

export function getTelegramContactHref(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';

  const cleaned = trimmed
    .replace(/^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\//i, '')
    .replace(/^(?:t\.me|telegram\.me)\//i, '')
    .split(/[?#]/)[0]
    .replace(/\/+$/, '')
    .trim();

  if (!cleaned) return '';

  // Explicitly @username or a single valid Telegram username (no spaces, starts with letter)
  if (cleaned.startsWith('@')) {
    const cleanHandle = cleaned.replace(/^@+/, '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 64);
    return cleanHandle.length >= 3 ? `https://t.me/${cleanHandle}` : '';
  }
  if (/^[a-zA-Z][a-zA-Z0-9_]{3,63}$/.test(cleaned)) {
    return `https://t.me/${cleaned}`;
  }

  // Phone number input (avoid mangling display names with spaces into unrelated usernames/bots)
  if (/[a-zA-Z]/.test(cleaned)) {
    return '';
  }

  const digits = cleaned.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 16) return '';

  if (cleaned.startsWith('+')) {
    return `https://t.me/+${digits}`;
  }
  if (digits.startsWith('00')) {
    return `https://t.me/+${digits.slice(2)}`;
  }
  // Indonesian mobile numbers (08xxxxxxxxxx, typically 10-13 digits)
  if (digits.startsWith('08') && digits.length >= 10 && digits.length <= 13) {
    return `https://t.me/+62${digits.slice(1)}`;
  }
  // Cambodian local mobile numbers (0xx..., typically 9-10 digits)
  if (digits.startsWith('0') && digits.length >= 9 && digits.length <= 10) {
    return `https://t.me/+855${digits.slice(1)}`;
  }
  return `https://t.me/+${digits}`;
}

export function generateDeliveryFeedKey(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let rand = '';
  for (let i = 0; i < 24; i++) {
    rand += chars[Math.floor(Math.random() * chars.length)];
  }
  return `kurir_${rand}`;
}

export const ADMIN_ROLE_TEMPLATES: {
  id: string;
  roleLabel: string;
  summary: string;
}[] = [
  {
    id: 'admin_utama',
    roleLabel: 'Admin Utama',
    summary: 'Akses penuh pesanan, stok, promo, kurir, laporan CSV & printer',
  },
  {
    id: 'kasir_printer',
    roleLabel: 'Kasir & Printer Bill',
    summary: 'Terima pesanan masuk, cetak struk Bluetooth & update status',
  },
  {
    id: 'operator_pesanan',
    roleLabel: 'Operator Pesanan',
    summary: 'Verifikasi bayar QR/CASH, cek lokasi GPS & koordinasi kurir',
  },
  {
    id: 'manajer_stok',
    roleLabel: 'Manajer Produk & Promo',
    summary: 'Kelola harga produk, stok barang, kategori & diskon toko',
  },
];

/** Exchange rate used for CASH (KHR) vs QR (USD) pricing */
export const USD_TO_KHR_RATE = 4100;

export const INITIAL_CATEGORIES: Omit<StoreCategory, 'createdAt' | 'updatedAt'>[] = [
  { id: 'cat_minuman', name: 'Minuman', sortOrder: 1, isActive: true },
  { id: 'cat_makanan_snack', name: 'Makanan & Snack', sortOrder: 2, isActive: true },
  { id: 'cat_mie_instan', name: 'Mie Instan', sortOrder: 3, isActive: true },
  { id: 'cat_sembako', name: 'Sembako', sortOrder: 4, isActive: true },
  { id: 'cat_kebutuhan_harian', name: 'Kebutuhan Harian', sortOrder: 5, isActive: true },
];

export const PRODUCT_CATEGORIES: ('Semua' | ProductCategory)[] = [
  'Semua',
  ...INITIAL_CATEGORIES.map((c) => c.name),
];

export const ABA_MERCHANT = {
  brand: "ABA' PAY",
  tagline: 'Scan. Pay. Done.',
  merchantName: 'ALPAMART_TM BY J.P',
  accountHolder: 'PADDY JULIUS',
  accountNumber: '009975101',
  network: 'KHQR',
} as const;

export const SHIPPING_OPTIONS: {
  method: ShippingMethod;
  label: string;
  costUsd: number;
  eta: string;
}[] = [
  {
    method: 'FREE DELIVERY',
    label: 'FREE DELIVERY',
    costUsd: 0,
    eta: 'Gratis ongkir · Diantar langsung ke titik lokasi GPS Anda',
  },
];

export const INITIAL_PRODUCTS: Omit<Product, 'createdAt' | 'updatedAt'>[] = [];

export const DEFAULT_AUTOMATION_SETTINGS: Omit<AutomationSettings, 'updatedAt'> = {
  id: 'roboto',
  autoConfirmOrders: true,
  autoGenerateResi: true,
  autoDeductStock: true,
  lowStockThreshold: 5,
  defaultCourierPrefix: 'ALP',
  updatedBy: BOOTSTRAPPED_ADMIN_EMAIL,
};

export const DEFAULT_STORE_SUPPORT = {
  id: 'telegram' as const,
  telegramUsername: '',
  adminDisplayName: 'Admin ALPAMART TRIMUIA ONLAINE',
  greetingMessage:
    'Halo Admin ALPAMART TRIMUIA ONLAINE, saya ingin menanyakan status pesanan saya.',
  updatedBy: BOOTSTRAPPED_ADMIN_EMAIL,
};

export function normalizeWhatsAppNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith('08')) return `62${digits.slice(1)}`;
  if (digits.startsWith('0')) return digits.slice(1);
  return digits;
}

export function normalizeTelegramHandle(raw: string): string {
  let cleaned = raw.trim();
  if (!cleaned) return '';
  cleaned = cleaned
    .replace(/^https?:\/\/(www\.)?(t\.me|telegram\.me)\//i, '')
    .replace(/^(t\.me|telegram\.me)\//i, '')
    .split(/[?#]/)[0]
    .replace(/\/+$/, '')
    .replace(/^@+/, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('+')) {
    const digits = cleaned.replace(/\D/g, '');
    return digits ? `+${digits}` : '';
  }
  return cleaned.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 64);
}

const GUEST_ID_STORAGE_KEY = 'alpamart_guest_customer_id_v1';
const GUEST_ORDERS_STORAGE_KEY = 'alpamart_guest_orders_v1';
const GUEST_PROFILE_STORAGE_KEY = 'alpamart_guest_profile_v1';

export interface GuestOrderRef {
  id: string;
  orderNumber: string;
}

export interface GuestProfileDraft {
  name: string;
  phone: string;
  locationCoords: string;
  locationUrl: string;
}

function randomAlnum(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const arr = new Uint8Array(length);
    crypto.getRandomValues(arr);
    for (let i = 0; i < length; i++) {
      result += chars[arr[i] % chars.length];
    }
    return result;
  }
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

export function getOrCreateGuestCustomerId(): string {
  try {
    const existing = getResilientItem(GUEST_ID_STORAGE_KEY);
    if (existing && /^guest_[a-zA-Z0-9_\-]{8,64}$/.test(existing)) {
      return existing;
    }
    const created = `guest_${randomAlnum(18)}`;
    setResilientItem(GUEST_ID_STORAGE_KEY, created, { allowCookie: true });
    return created;
  } catch {
    return `guest_${randomAlnum(18)}`;
  }
}

export function generateGuestOrderId(): string {
  return `ord_${Date.now()}_${randomAlnum(12)}`;
}

export function getGuestOrderRefs(): GuestOrderRef[] {
  try {
    const raw = getResilientItem(GUEST_ORDERS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is GuestOrderRef =>
        Boolean(item) &&
        typeof item.id === 'string' &&
        item.id.length >= 20 &&
        typeof item.orderNumber === 'string'
    );
  } catch {
    return [];
  }
}

export function saveGuestOrderRef(id: string, orderNumber: string): void {
  try {
    const current = getGuestOrderRefs().filter((item) => item.id !== id);
    const next = [{ id, orderNumber }, ...current].slice(0, 25);
    setResilientItem(GUEST_ORDERS_STORAGE_KEY, JSON.stringify(next), {
      allowCookie: true,
    });
    window.dispatchEvent(new Event('alpamart_guest_orders_updated'));
    broadcastCrossTabEvent({ type: 'guest_orders_updated' });
  } catch {
    // ignore storage limits
  }
}

export function getGuestProfileDraft(): GuestProfileDraft | null {
  try {
    const raw = getResilientItem(GUEST_PROFILE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      name: typeof parsed.name === 'string' ? parsed.name : '',
      phone: typeof parsed.phone === 'string' ? parsed.phone : '',
      locationCoords:
        typeof parsed.locationCoords === 'string' ? parsed.locationCoords : '',
      locationUrl:
        typeof parsed.locationUrl === 'string' ? parsed.locationUrl : '',
    };
  } catch {
    return null;
  }
}

export function saveGuestProfileDraft(draft: GuestProfileDraft): void {
  try {
    setResilientItem(GUEST_PROFILE_STORAGE_KEY, JSON.stringify(draft), {
      allowCookie: true,
    });
  } catch {
    // ignore storage limits
  }
}

export function convertUsdToKhr(usd: number): number {
  return Math.round(usd * USD_TO_KHR_RATE);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function sha256PureJs(ascii: string): string {
  const bytes = new TextEncoder().encode(ascii);
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const H = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];

  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  const w = new Uint32Array(64);
  const rotr = (n: number, x: number) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(7, w[i - 15]) ^ rotr(18, w[i - 15]) ^ (w[i - 15] >>> 3);
      const s1 = rotr(17, w[i - 2]) ^ rotr(19, w[i - 2]) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }

  return H.map((x) => x.toString(16).padStart(8, '0')).join('');
}

export async function sha256Hex(value: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function') {
    try {
      const bytes = new TextEncoder().encode(value);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      return sha256PureJs(value);
    }
  }
  return sha256PureJs(value);
}

/**
 * Cross-browser clipboard copy that works on all phone brands (iOS Safari, Android Chrome,
 * Samsung Internet, Xiaomi Mi Browser, Oppo/Vivo WebViews).
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back to execCommand below
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export type CsvExportPeriod = 'daily' | 'weekly' | 'monthly' | 'all';

export function filterOrdersByCsvPeriod(
  orders: Order[],
  period: CsvExportPeriod
): Order[] {
  if (period === 'all') return orders;
  const now = new Date();
  let cutoffMs = 0;
  if (period === 'daily') {
    cutoffMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  } else if (period === 'weekly') {
    cutoffMs = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  } else if (period === 'monthly') {
    cutoffMs = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  }
  return orders.filter((o) => {
    const ms = o.createdAt?.toMillis?.() ?? 0;
    return ms >= cutoffMs;
  });
}

function escapeCsvCell(raw: unknown): string {
  const str = String(raw ?? '').replace(/\r?\n/g, ' ').trim();
  const safe = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function exportOrdersToCsv(
  orders: Order[],
  period: CsvExportPeriod
): { count: number; filename: string } {
  const filtered = filterOrdersByCsvPeriod(orders, period);
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const periodSlug =
    period === 'daily'
      ? 'harian'
      : period === 'weekly'
        ? 'mingguan_7hari'
        : period === 'monthly'
          ? 'bulanan_30hari'
          : 'semua';
  const filename = `laporan_pesanan_${periodSlug}_${y}-${m}-${d}.csv`;

  const headers = [
    'No',
    'Kode Order',
    'Tanggal Dibuat',
    'Terakhir Diperbarui',
    'Status',
    'Nama Pelanggan',
    'Telegram (Username / No. HP)',
    'Email',
    'Metode Pembayaran',
    'Mata Uang',
    'Subtotal',
    'Ongkos Kirim',
    'Total Tagihan',
    'Rincian Produk',
    'Total Qty',
    'Nomor Resi',
    'Layanan Kirim',
    'Lokasi GPS',
    'Tautan Peta',
    'Catatan',
  ];

  let activeCount = 0;
  let totalUsdQr = 0;
  let totalKhrCash = 0;

  const rows = filtered.map((order, idx) => {
    const cur = order.currency || 'USD';
    const isActive = order.status !== 'cancelled';
    if (isActive) {
      activeCount += 1;
      if (cur === 'KHR') totalKhrCash += order.totalAmount;
      else totalUsdQr += order.totalAmount;
    }
    const itemsSummary = order.items
      .map((it) => `${it.name} (${it.quantity} ${normalizeProductUnit(it.unit)})`)
      .join('; ');
    const totalQty = order.items.reduce((sum, it) => sum + it.quantity, 0);

    return [
      idx + 1,
      order.orderNumber,
      formatTimestamp(order.createdAt),
      formatTimestamp(order.updatedAt || order.createdAt),
      ORDER_STATUS_META[order.status]?.label || order.status,
      order.customerName,
      order.customerPhone,
      order.customerEmail,
      order.paymentMethod,
      cur,
      order.subtotal,
      order.shippingCost,
      order.totalAmount,
      itemsSummary,
      totalQty,
      order.trackingNumber || '-',
      order.shippingMethod || 'FREE DELIVERY',
      order.locationCoords || '',
      order.locationUrl || '',
      order.notes || '',
    ]
      .map(escapeCsvCell)
      .join(',');
  });

  const periodTitle =
    period === 'daily'
      ? 'Harian (Hari Ini)'
      : period === 'weekly'
        ? 'Mingguan (7 Hari Terakhir)'
        : period === 'monthly'
          ? 'Bulanan (30 Hari Terakhir)'
          : 'Semua Riwayat';

  const summaryRows = [
    '',
    [
      'RINGKASAN PEMBUKUAN',
      STORE_NAME,
      `Periode: ${periodTitle}`,
      `Total Pesanan: ${filtered.length}`,
      `Pesanan Aktif (Non-Batal): ${activeCount}`,
      `Total QR (USD): ${totalUsdQr.toFixed(2)}`,
      `Total CASH (KHR): ${Math.round(totalKhrCash)}`,
    ]
      .map(escapeCsvCell)
      .join(','),
  ];

  // UTF-8 BOM ensures Excel / Google Sheets / WPS Mobile render columns & Indonesian text cleanly
  const csvContent =
    '\uFEFF' + [headers.map(escapeCsvCell).join(','), ...rows, ...summaryRows].join('\r\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, 1500);

  return { count: filtered.length, filename };
}

/**
 * Parses flexible decimal/dot/comma numeric strings for product selling price (USD).
 * Examples: "1.5" -> 1.5, "12,50" -> 12.5, "1.500.000" -> 1500000.
 */
export function parseDecimalPrice(raw: string): number {
  const cleaned = raw.trim().replace(/\s+/g, '');
  if (!cleaned) return NaN;
  const dotCount = (cleaned.match(/\./g) || []).length;
  let normalized = cleaned;
  if (dotCount > 1 && !cleaned.includes(',')) {
    normalized = cleaned.replace(/\./g, '');
  } else {
    normalized = cleaned.replace(/,/g, '.');
  }
  const num = Number(normalized);
  if (!Number.isFinite(num)) return NaN;
  return Number(num.toFixed(2));
}

export function formatUSD(usd: number): string {
  const hasDecimals = Math.abs(usd % 1) > 0.001;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(usd);
}

export function formatKHR(khr: number): string {
  return `${new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0,
  }).format(Math.round(khr))} KHR`;
}

export function formatAmountByCurrency(
  amount: number,
  currency: CurrencyCode,
  customSymbol?: string
): string {
  if (currency === 'KHR') return formatKHR(amount);
  if (currency === 'USD') return formatUSD(amount);
  if (currency === 'IDR') {
    const sym = customSymbol?.trim() || 'Rp';
    return `${sym} ${new Intl.NumberFormat('id-ID', {
      maximumFractionDigits: 0,
    }).format(Math.round(amount))}`;
  }
  if (currency === 'VND') {
    const sym = customSymbol?.trim() || '₫';
    return `${new Intl.NumberFormat('vi-VN', {
      maximumFractionDigits: 0,
    }).format(Math.round(amount))} ${sym}`;
  }
  const hasDecimals = Math.abs(amount % 1) > 0.001;
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(amount);
  const defaultSym =
    currency === 'THB'
      ? '฿'
      : currency === 'MYR'
        ? 'RM'
        : currency === 'SGD'
          ? 'S$'
          : currency;
  const sym = customSymbol?.trim() || defaultSym;
  return `${sym}${sym.length > 1 ? ' ' : ''}${formatted}`;
}

export function getCurrencyForPayment(method: PaymentMethod): CurrencyCode {
  return method === 'CASH' ? 'KHR' : 'USD';
}

export function formatTimestamp(ts?: Timestamp | null): string {
  if (!ts) return 'Baru saja';
  try {
    return new Intl.DateTimeFormat('id-ID', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(ts.toDate());
  } catch {
    return 'Baru saja';
  }
}

export function generateOrderNumber(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `ALP-${y}${m}${d}-${rand}`;
}

export function generateTrackingNumber(prefix = 'ALP'): string {
  const cleanPrefix =
    prefix
      .replace(/[^a-zA-Z0-9]/g, '')
      .toUpperCase()
      .slice(0, 6) || 'ALP';
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${cleanPrefix}-${rand}-${num}`;
}

export const ORDER_STATUS_META: Record<
  OrderStatus,
  { label: string; description: string; toneClass: string }
> = {
  pending: {
    label: 'Menunggu Verifikasi',
    description: 'Pesanan telah diterima dan masuk ke antrean Admin.',
    toneClass: 'text-amber-700 bg-amber-50 border-amber-200',
  },
  processing: {
    label: 'Sedang Diproses',
    description: 'Pesanan telah diverifikasi dan sedang disiapkan untuk pengiriman.',
    toneClass: 'text-blue-700 bg-blue-50 border-blue-200',
  },
  shipped: {
    label: 'Dikirim',
    description: 'Paket telah diserahkan ke kurir dengan nomor resi aktif.',
    toneClass: 'text-indigo-700 bg-indigo-50 border-indigo-200',
  },
  completed: {
    label: 'Selesai',
    description: 'Pesanan telah diterima pelanggan dan transaksi tuntas.',
    toneClass: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  },
  cancelled: {
    label: 'Dibatalkan',
    description: 'Pesanan dibatalkan sebelum pengiriman.',
    toneClass: 'text-rose-700 bg-rose-50 border-rose-200',
  },
};

export const INITIAL_PROMOTIONS: Omit<Promotion, 'createdAt' | 'updatedAt'>[] = [];

export type PromoScheduleStatus = 'inactive' | 'scheduled' | 'active' | 'expired';

export interface PromoScheduleInfo {
  status: PromoScheduleStatus;
  startMs: number | null;
  endMs: number | null;
  isWithinPeriod: boolean;
  isScheduled: boolean;
  isExpired: boolean;
  startLabel: string | null;
  endLabel: string | null;
  periodLabel: string;
  remainingLabel: string | null;
}

export function parsePromoBoundaryMs(
  dateStr: string | undefined,
  boundary: 'start' | 'end'
): number | null {
  const raw = (dateStr || '').trim();
  if (!raw) return null;

  // Date-only format YYYY-MM-DD -> local start or end of day
  const dateOnlyMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const y = Number(dateOnlyMatch[1]);
    const m = Number(dateOnlyMatch[2]) - 1;
    const d = Number(dateOnlyMatch[3]);
    const dt =
      boundary === 'start'
        ? new Date(y, m, d, 0, 0, 0, 0)
        : new Date(y, m, d, 23, 59, 59, 999);
    const ms = dt.getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  // Local datetime format YYYY-MM-DDTHH:mm(:ss)?
  const localDtMatch = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/
  );
  if (localDtMatch) {
    const y = Number(localDtMatch[1]);
    const m = Number(localDtMatch[2]) - 1;
    const d = Number(localDtMatch[3]);
    const hh = Number(localDtMatch[4]);
    const mm = Number(localDtMatch[5]);
    const ss = localDtMatch[6] ? Number(localDtMatch[6]) : boundary === 'end' ? 59 : 0;
    const ms = new Date(y, m, d, hh, mm, ss, boundary === 'end' ? 999 : 0).getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatPromoDateTime(dateStr: string | undefined): string | null {
  const raw = (dateStr || '').trim();
  if (!raw) return null;
  const ms = parsePromoBoundaryMs(raw, 'start');
  if (ms === null) return raw;
  const hasTime = /[T ]\d{2}:\d{2}/.test(raw);
  return new Intl.DateTimeFormat('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...(hasTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(new Date(ms));
}

export function getPromotionScheduleInfo(
  promo: Pick<Promotion, 'isActive' | 'startDate' | 'endDate'>,
  nowMs: number = Date.now()
): PromoScheduleInfo {
  const startMs = parsePromoBoundaryMs(promo.startDate, 'start');
  const endMs = parsePromoBoundaryMs(promo.endDate, 'end');
  const startLabel = formatPromoDateTime(promo.startDate);
  const endLabel = formatPromoDateTime(promo.endDate);

  const isScheduled = startMs !== null && nowMs < startMs;
  const isExpired = endMs !== null && nowMs > endMs;
  const isWithinPeriod = !isScheduled && !isExpired;

  let status: PromoScheduleStatus = 'active';
  if (isExpired) {
    status = 'expired';
  } else if (!promo.isActive) {
    status = 'inactive';
  } else if (isScheduled) {
    status = 'scheduled';
  } else {
    status = 'active';
  }

  let periodLabel = 'Berlaku terus (tanpa batas waktu)';
  if (startLabel && endLabel) {
    periodLabel = `${startLabel} – ${endLabel}`;
  } else if (startLabel) {
    periodLabel = `Mulai ${startLabel}`;
  } else if (endLabel) {
    periodLabel = `Berlaku s/d ${endLabel}`;
  }

  let remainingLabel: string | null = null;
  if (isExpired) {
    remainingLabel = 'Periode berakhir';
  } else if (isScheduled && startMs !== null) {
    const diffMin = Math.max(1, Math.ceil((startMs - nowMs) / 60_000));
    const days = Math.floor(diffMin / 1440);
    const hours = Math.floor((diffMin % 1440) / 60);
    const mins = diffMin % 60;
    remainingLabel =
      days > 0
        ? `Mulai ${days} hari ${hours} jam lagi`
        : hours > 0
          ? `Mulai ${hours} jam ${mins} menit lagi`
          : `Mulai ${mins} menit lagi`;
  } else if (endMs !== null) {
    const diffMin = Math.max(1, Math.ceil((endMs - nowMs) / 60_000));
    const days = Math.floor(diffMin / 1440);
    const hours = Math.floor((diffMin % 1440) / 60);
    const mins = diffMin % 60;
    remainingLabel =
      days > 0
        ? `Sisa ${days} hari ${hours} jam`
        : hours > 0
          ? `Sisa ${hours} jam ${mins} menit`
          : `Sisa ${mins} menit`;
  }

  return {
    status,
    startMs,
    endMs,
    isWithinPeriod,
    isScheduled,
    isExpired,
    startLabel,
    endLabel,
    periodLabel,
    remainingLabel,
  };
}

export function isPromotionCurrentlyActive(
  promo: Pick<Promotion, 'isActive' | 'startDate' | 'endDate'>,
  nowMs: number = Date.now()
): boolean {
  if (!promo.isActive) return false;
  const info = getPromotionScheduleInfo(promo, nowMs);
  return info.status === 'active';
}

export function isProductExpiredByPromo(
  productId: string,
  promotions: Promotion[],
  nowMs: number = Date.now()
): boolean {
  return promotions.some((promo) => {
    if (promo.productId !== productId) return false;
    if (!promo.endDate || promo.autoZeroStockOnExpiry === false) return false;
    if (promo.expiredStockZeroedAt) return false;
    return getPromotionScheduleInfo(promo, nowMs).isExpired;
  });
}

export function getEffectiveProductStock(
  product: Pick<Product, 'id' | 'stock'>,
  promotions: Promotion[],
  nowMs: number = Date.now()
): number {
  if (isProductExpiredByPromo(product.id, promotions, nowMs)) {
    return 0;
  }
  return Math.max(0, Math.trunc(Number(product.stock) || 0));
}

export function formatComboInstruction(
  buyQty: number,
  getQty: number,
  unit: string
): string {
  const safeBuy = Math.max(1, Math.trunc(buyQty));
  const safeGet = Math.max(1, Math.trunc(getQty));
  const bundleSize = safeBuy + safeGet;
  return `Paket Combo Beli ${safeBuy} Free ${safeGet}: Pelanggan wajib masukkan ${bundleSize} ${unit} (kelipatan ${bundleSize} ${unit}) ke keranjang — stok berkurang ${bundleSize} ${unit} dan Anda cukup bayar harga ${safeBuy} ${unit} (gratis ${safeGet} ${unit}).`;
}

export interface ProductPromoSummary {
  effectiveUnitUsd: number;
  lineTotalUsd: number;
  paidQty: number;
  stockDeductQty: number;
  discountPromo: Promotion | null;
  comboPromo: Promotion | null;
  comboBundleSize: number;
  comboCompleteBundles: number;
  comboFreeQty: number;
  comboShortfallQty: number;
  comboInstructionText: string | null;
  bogoPromo: Promotion | null;
  bonusFreeQty: number;
  promoBadgeText: string | null;
}

export function computePromoForProduct(
  product: Pick<
    Product,
    | 'id'
    | 'price'
    | 'unit'
    | 'promoActive'
    | 'promoPriceUsd'
    | 'promoDiscountPercent'
    | 'promoStartDate'
    | 'promoEndDate'
    | 'promoLabel'
  >,
  quantity: number,
  promotions: Promotion[],
  nowMs: number = Date.now()
): ProductPromoSummary {
  const safeQty = Math.max(0, Math.trunc(Number(quantity) || 0));
  const unit = normalizeProductUnit(product.unit);

  const activeForProduct = promotions.filter(
    (p) => p.productId === product.id && isPromotionCurrentlyActive(p, nowMs)
  );
  const discountPromo =
    activeForProduct.find(
      (p) => p.promoType === 'discount' && p.discountPercent > 0
    ) || null;
  const comboPromo =
    activeForProduct.find(
      (p) => p.promoType === 'combo' && p.buyQty >= 1 && p.getQty >= 1
    ) || null;
  const bogoPromo = !comboPromo
    ? activeForProduct.find(
        (p) => p.promoType === 'buy_x_get_y' && p.buyQty >= 1 && p.getQty >= 1
      ) || null
    : null;

  let effectiveUnitUsd = product.price;
  let effectiveDiscountPercent = 0;

  if (discountPromo) {
    effectiveUnitUsd = Math.max(
      0.01,
      Number((product.price * (1 - discountPromo.discountPercent / 100)).toFixed(2))
    );
    effectiveDiscountPercent = discountPromo.discountPercent;
  } else if (isProductSyncedPromoActive(product)) {
    if (
      typeof product.promoPriceUsd === 'number' &&
      product.promoPriceUsd > 0 &&
      product.promoPriceUsd < product.price
    ) {
      effectiveUnitUsd = Number(product.promoPriceUsd.toFixed(2));
      effectiveDiscountPercent = Math.max(
        1,
        Math.round(((product.price - effectiveUnitUsd) / product.price) * 100)
      );
    } else if (
      typeof product.promoDiscountPercent === 'number' &&
      product.promoDiscountPercent > 0
    ) {
      effectiveDiscountPercent = Math.min(90, Math.round(product.promoDiscountPercent));
      effectiveUnitUsd = Math.max(
        0.01,
        Number((product.price * (1 - effectiveDiscountPercent / 100)).toFixed(2))
      );
    }
  }

  let comboBundleSize = 0;
  let comboCompleteBundles = 0;
  let comboFreeQty = 0;
  let comboShortfallQty = 0;
  let comboInstructionText: string | null = null;
  let paidQty = safeQty;
  let stockDeductQty = safeQty;
  let bonusFreeQty = 0;

  if (comboPromo) {
    comboBundleSize = comboPromo.buyQty + comboPromo.getQty;
    comboCompleteBundles = Math.floor(safeQty / comboBundleSize);
    const remainder = safeQty % comboBundleSize;
    comboFreeQty = comboCompleteBundles * comboPromo.getQty;
    paidQty = safeQty - comboFreeQty;
    comboShortfallQty = remainder === 0 ? 0 : comboBundleSize - remainder;
    // Stock changes by exact total inputted qty (e.g. 3 pcs for Beli 1 Free 2), customer pays only paidQty (e.g. 1 pcs)
    stockDeductQty = safeQty;
    comboInstructionText = formatComboInstruction(
      comboPromo.buyQty,
      comboPromo.getQty,
      unit
    );
  } else if (bogoPromo) {
    bonusFreeQty = Math.floor(safeQty / bogoPromo.buyQty) * bogoPromo.getQty;
    paidQty = safeQty;
    stockDeductQty = safeQty + bonusFreeQty;
  }

  const lineTotalUsd = Number((effectiveUnitUsd * paidQty).toFixed(2));

  let promoBadgeText: string | null = null;
  if (comboPromo) {
    const comboLabel = `COMBO · Beli ${comboPromo.buyQty} Free ${comboPromo.getQty} (Input ${comboBundleSize} ${unit}, Bayar ${comboPromo.buyQty})`;
    promoBadgeText =
      effectiveDiscountPercent > 0
        ? `DISKON ${effectiveDiscountPercent}% + ${comboLabel}`
        : comboLabel;
  } else if (effectiveDiscountPercent > 0 && bogoPromo) {
    promoBadgeText = `DISCOUNT ${effectiveDiscountPercent}% + Beli ${bogoPromo.buyQty} Gratis ${bogoPromo.getQty}`;
  } else if (effectiveDiscountPercent > 0) {
    promoBadgeText =
      product.promoLabel && product.promoLabel.trim()
        ? `${product.promoLabel.trim()} · DISCOUNT ${effectiveDiscountPercent}%`
        : `DISCOUNT ${effectiveDiscountPercent}%`;
  } else if (bogoPromo) {
    promoBadgeText = `PROMOTION · Buy ${bogoPromo.buyQty} Get ${bogoPromo.getQty}`;
  }

  return {
    effectiveUnitUsd,
    lineTotalUsd,
    paidQty,
    stockDeductQty,
    discountPromo,
    comboPromo,
    comboBundleSize,
    comboCompleteBundles,
    comboFreeQty,
    comboShortfallQty,
    comboInstructionText,
    bogoPromo,
    bonusFreeQty,
    promoBadgeText,
  };
}

export async function seedInitialCatalogForAdmin(adminEmail: string): Promise<void> {
  if (!isMasterEmail(adminEmail)) return;
  try {
    if (INITIAL_PRODUCTS.length > 0) {
      const prodSnap = await getDocs(collection(db, 'products'));
      if (prodSnap.empty) {
        const batch = writeBatch(db);
        for (const item of INITIAL_PRODUCTS) {
          const ref = doc(db, 'products', item.id);
          batch.set(ref, {
            ...item,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
        await batch.commit();
      }
    }

    const catSnap = await getDocs(collection(db, 'categories'));
    if (catSnap.empty) {
      const catBatch = writeBatch(db);
      for (const cat of INITIAL_CATEGORIES) {
        const ref = doc(db, 'categories', cat.id);
        catBatch.set(ref, {
          ...cat,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      await catBatch.commit();
    }

    const settingsRef = doc(db, 'automationSettings', 'roboto');
    const settingsSnap = await getDoc(settingsRef);
    if (!settingsSnap.exists()) {
      await setDoc(settingsRef, {
        ...DEFAULT_AUTOMATION_SETTINGS,
        updatedBy: adminEmail,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'products');
  }
}

import type { Timestamp } from 'firebase/firestore';

export type ProductCategory = string;

export type ProductUnit =
  | 'PCS'
  | 'PACK'
  | 'BOX'
  | 'KG'
  | 'LITER'
  | 'RENTENG'
  | 'COMBO'
  | 'BKS'
  | 'BOTOL'
  | 'DUS'
  | 'UNIT'
  | 'SET'
  | 'CTN'
  | 'GR'
  | 'ML';

export const PRODUCT_UNITS: ProductUnit[] = [
  'PCS',
  'PACK',
  'BOX',
  'KG',
  'LITER',
  'RENTENG',
  'COMBO',
  'BKS',
  'BOTOL',
  'DUS',
  'UNIT',
  'SET',
  'CTN',
  'GR',
  'ML',
];

export interface StoreCategory {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export type PaymentMethod = 'CASH' | 'QR';

export type CurrencyCode = 'KHR' | 'USD' | 'IDR' | 'THB' | 'MYR' | 'SGD' | 'VND';

export type ThemeAccent =
  | 'blue_red'
  | 'emerald'
  | 'indigo'
  | 'amber'
  | 'rose'
  | 'slate';

export type ShippingMethod =
  | 'FREE DELIVERY'
  | 'ROBOTO Express'
  | 'Reguler'
  | 'Same Day';

export type OrderStatus =
  | 'pending'
  | 'processing'
  | 'shipped'
  | 'completed'
  | 'cancelled';

export interface Product {
  id: string;
  name: string;
  sku: string;
  barcode?: string;
  externalId?: string;
  category: ProductCategory;
  description: string;
  /** Base selling price in USD */
  price: number;
  /** Optional explicit synced selling price in KHR from JOURNAL POS */
  priceKhr?: number;
  unit?: ProductUnit;
  stock: number;
  imageUrl: string;
  isActive: boolean;
  /** Synced promotion metadata (never includes private cost price) */
  promoActive?: boolean;
  promoPriceUsd?: number;
  promoPriceKhr?: number;
  promoDiscountPercent?: number;
  promoStartDate?: string;
  promoEndDate?: string;
  promoLabel?: string;
  syncSource?: 'manual' | 'journal_pos';
  sourceUpdatedAt?: string;
  lastOrderId?: string;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

/** Strictly Admin-only private product metadata (cost/buy price is NEVER stored in /products) */
export interface ProductPrivateMeta {
  id: string;
  productId: string;
  externalId?: string;
  sku: string;
  barcode?: string;
  costPriceUsd: number;
  costPriceKhr: number;
  sourceUpdatedAt?: string;
  updatedAt?: Timestamp | null;
}

export interface CartItem {
  product: Product;
  quantity: number;
}

export interface OrderItem {
  productId: string;
  name: string;
  sku: string;
  /** Unit price in the order's payment currency (KHR for CASH, USD for QR) */
  price: number;
  unit?: ProductUnit;
  quantity: number;
  imageUrl: string;
}

export interface Order {
  id: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  shippingAddress: string;
  city: string;
  postalCode: string;
  locationDetail?: string;
  locationCoords?: string;
  locationUrl?: string;
  locationImageUrl?: string;
  deliveryProofImageUrl?: string;
  paymentMethod: PaymentMethod;
  currency: CurrencyCode;
  shippingMethod: ShippingMethod;
  notes: string;
  items: OrderItem[];
  subtotal: number;
  shippingCost: number;
  totalAmount: number;
  trackingNumber: string;
  status: OrderStatus;
  autoProcessed: boolean;
  deliveryEmailHashes?: string[];
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface DeliveryAccount {
  id: string;
  name: string;
  email: string;
  emailHash: string;
  phone: string;
  isActive: boolean;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface DeliveryRoster {
  id: 'deliveryRoster';
  activeEmailHashes: string[];
  directAccessKey?: string;
  updatedBy: string;
  updatedAt?: Timestamp | null;
}

export interface AdminAccount {
  id: string;
  name: string;
  email: string;
  roleLabel: string;
  phone: string;
  isActive: boolean;
  addedBy: string;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface DeliveryFeedOrder {
  id: string;
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  shippingAddress: string;
  city: string;
  postalCode: string;
  locationDetail?: string;
  locationCoords?: string;
  locationUrl?: string;
  locationImageUrl?: string;
  deliveryProofImageUrl?: string;
  paymentMethod: PaymentMethod;
  currency: CurrencyCode;
  shippingMethod: ShippingMethod;
  notes: string;
  items: OrderItem[];
  totalAmount: number;
  trackingNumber: string;
  status: OrderStatus;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface StoreSupportConfig {
  id: 'telegram';
  telegramUsername: string;
  adminDisplayName: string;
  greetingMessage: string;
  updatedBy: string;
  updatedAt?: Timestamp | null;
}

export interface AutomationSettings {
  id: string;
  autoConfirmOrders: boolean;
  autoGenerateResi: boolean;
  autoDeductStock: boolean;
  lowStockThreshold: number;
  defaultCourierPrefix: string;
  updatedBy: string;
  updatedAt?: Timestamp | null;
}

export interface AutomationLog {
  id: string;
  orderId: string;
  orderNumber: string;
  action: string;
  detail: string;
  status: 'success' | 'warning';
  createdAt?: Timestamp | null;
}

export type PromoType = 'discount' | 'buy_x_get_y' | 'combo';

export interface Promotion {
  id: string;
  title: string;
  description: string;
  promoType: PromoType;
  productId: string;
  discountPercent: number;
  buyQty: number;
  getQty: number;
  startDate?: string;
  endDate?: string;
  autoZeroStockOnExpiry?: boolean;
  expiredStockZeroedAt?: string;
  isActive: boolean;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface UserProfile {
  uid: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  postalCode: string;
  locationDetail?: string;
  locationCoords?: string;
  locationUrl?: string;
  updatedAt?: Timestamp | null;
}

export type BannerCtaTarget = 'catalog' | 'promo' | 'search' | 'orders' | 'none';

export interface StoreBanner {
  id: string;
  kicker: string;
  title: string;
  subtitle: string;
  imageUrl: string;
  ctaLabel: string;
  ctaTarget: BannerCtaTarget;
  sortOrder: number;
  isActive: boolean;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface StoreCheckoutConfig {
  id: 'checkout';
  cartTitle: string;
  cartNotice: string;
  minOrderUsd: number;
  checkoutButtonLabel: string;
  checkoutHeading: string;
  checkoutIntro: string;
  shippingLabel: string;
  shippingEta: string;
  shippingCostUsd: number;
  requireGpsLocation: boolean;
  allowLocationPhoto: boolean;
  showNotesField: boolean;
  contactFieldLabel: string;
  contactFieldPlaceholder: string;
  submitButtonLabel: string;
  enableCashPayment: boolean;
  cashTitle: string;
  cashDescription: string;
  enableQrPayment: boolean;
  qrTitle: string;
  qrDescription: string;
  exchangeRateKhr: number;
  paymentProviderName: string;
  paymentTagline: string;
  merchantName: string;
  accountHolder: string;
  accountNumber: string;
  paymentNetwork: string;
  paymentQrImageUrl: string;
  qrInstructionText: string;
  successTitle: string;
  successMessage: string;
  updatedBy: string;
  updatedAt?: Timestamp | null;
}

export interface StoreMasterConfig {
  id: 'master';
  storeName: string;
  storeTagline: string;
  storeLogoUrl: string;
  footerText: string;
  primaryCurrencyCode: CurrencyCode;
  primaryCurrencySymbol: string;
  secondaryCurrencyCode: CurrencyCode;
  secondaryCurrencySymbol: string;
  exchangeRate: number;
  themeAccent: ThemeAccent;
  storeAddress: string;
  storeHours: string;
  telegramOrderUrl: string;
  permanentStoreUrl?: string;
  announcementBarText: string;
  maintenanceMode: boolean;
  updatedBy: string;
  updatedAt?: Timestamp | null;
}

export type StoreHoursMode = 'auto' | 'force_open' | 'force_closed';

export interface StoreHoursConfig {
  id: 'hours';
  enabled: boolean;
  mode: StoreHoursMode;
  openTime: string;
  closeTime: string;
  timezoneLabel: string;
  openDaysText: string;
  blockCheckoutWhenClosed: boolean;
  closedTitle: string;
  closedMessage: string;
  openNotice: string;
  updatedBy: string;
  updatedAt?: Timestamp | null;
}

export type BackgroundDisplayMode = 'watermark_center' | 'watermark_tile' | 'cover';

export interface StoreBackgroundConfig {
  id: 'background';
  imageUrl: string;
  displayMode: BackgroundDisplayMode;
  opacity: number;
  enabled: boolean;
  updatedBy: string;
  updatedAt?: Timestamp | null;
}

export type JournalPosConnectionStatus =
  | 'ONLINE'
  | 'SYNCING'
  | 'ERROR'
  | 'UPDATED';

export type JournalPosSignatureFormat =
  | 'method_path_timestamp'
  | 'timestamp_method_path'
  | 'timestamp_path'
  | 'timestamp_only';

export type JournalPosSyncTrigger =
  | 'webhook'
  | 'polling'
  | 'manual'
  | 'sample_test'
  | 'json_import';

export interface JournalPosConfig {
  id: 'journalPos';
  sourceBaseUrl: string;
  autoSyncEnabled: boolean;
  syncIntervalSeconds: number;
  signatureFormat: JournalPosSignatureFormat;
  connectionStatus: JournalPosConnectionStatus;
  lastConnectionMessage?: string;
  lastSyncAt?: string;
  lastSyncMode?: JournalPosSyncTrigger;
  lastSuccessCount: number;
  lastFailedCount: number;
  lastUpdatedCount: number;
  lastInsertedCount: number;
  lastErrorDetail?: string;
  permanentStoreUrl?: string;
  updatedBy: string;
  updatedAt?: Timestamp | null;
}

export interface JournalPosSyncLog {
  id: string;
  trigger: JournalPosSyncTrigger;
  status: 'ONLINE' | 'UPDATED' | 'ERROR';
  totalProcessed: number;
  successCount: number;
  insertedCount: number;
  updatedCount: number;
  failedCount: number;
  summary: string;
  errorDetail?: string;
  changedSkus?: string[];
  createdBy: string;
  createdAt?: Timestamp | null;
}

export interface BackupArchiveRecord {
  id: string;
  format: 'json' | 'zip' | 'gcs_scheduled';
  totalDocuments: number;
  collectionsIncluded: string[];
  fileSizeBytes: number;
  createdBy: string;
  createdAt?: Timestamp | null;
}

export const FIELD_LIMITS = {
  NAME_MIN: 2,
  NAME_MAX: 100,
  PRODUCT_NAME_MAX: 120,
  CATEGORY_NAME_MIN: 2,
  CATEGORY_NAME_MAX: 60,
  SKU_MAX: 40,
  DESCRIPTION_MAX: 1000,
  PROMO_TITLE_MAX: 120,
  PROMO_DESC_MAX: 400,
  PHONE_MIN: 3,
  PHONE_MAX: 64,
  TELEGRAM_USERNAME_MAX: 64,
  ADMIN_DISPLAY_NAME_MAX: 80,
  GREETING_MAX: 240,
  ADDRESS_MIN: 8,
  ADDRESS_MAX: 400,
  CITY_MIN: 2,
  CITY_MAX: 80,
  POSTAL_MIN: 4,
  POSTAL_MAX: 12,
  LOCATION_DETAIL_MAX: 240,
  LOCATION_COORDS_MAX: 80,
  LOCATION_URL_MAX: 300,
  NOTES_MAX: 300,
  MAX_ORDER_ITEMS: 20,
} as const;

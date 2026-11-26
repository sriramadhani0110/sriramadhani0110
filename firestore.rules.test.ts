/**
 * Security Rules TDD Verification Suite ("Dirty Dozen" Payloads)
 * Intended for validation against Firebase Emulator Suite / @firebase/rules-unit-testing.
 */

export interface DirtyDozenCase {
  id: number;
  name: string;
  collection: string;
  operation: 'create' | 'update' | 'get' | 'list' | 'delete';
  expected: 'PERMISSION_DENIED';
  payload: Record<string, unknown>;
}

export const DIRTY_DOZEN_PAYLOADS: DirtyDozenCase[] = [
  {
    id: 1,
    name: 'Shadow Field Injection on Order Create',
    collection: 'orders/order_bad_1',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    payload: { id: 'order_bad_1', isAdmin: true, status: 'pending' },
  },
  {
    id: 2,
    name: 'Identity Spoofing on Order Create',
    collection: 'orders/order_bad_2',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    payload: { id: 'order_bad_2', customerId: 'someone_else', status: 'pending' },
  },
  {
    id: 3,
    name: 'State Shortcutting on Order Create',
    collection: 'orders/order_bad_3',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    payload: { id: 'order_bad_3', status: 'completed' },
  },
  {
    id: 4,
    name: 'Timestamp Tampering on Order Create',
    collection: 'orders/order_bad_4',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    payload: { id: 'order_bad_4', createdAt: '2020-01-01T00:00:00.000Z' },
  },
  {
    id: 5,
    name: 'ID Poisoning with 200-char Path Variable',
    collection: `orders/${'a'.repeat(200)}`,
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    payload: { id: 'a'.repeat(200) },
  },
  {
    id: 6,
    name: 'Customer Product Price Tampering',
    collection: 'products/prod_1',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
    payload: { price: 100, stock: 5 },
  },
  {
    id: 7,
    name: 'Orphan Stock Griefing without Atomic Order',
    collection: 'products/prod_1',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
    payload: { stock: 0, lastOrderId: 'fake_order_id' },
  },
  {
    id: 8,
    name: 'Unverified Admin Email Spoof',
    collection: 'automationSettings/roboto',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
    payload: { autoConfirmOrders: false },
  },
  {
    id: 9,
    name: 'Non-Owner Order List Scrape',
    collection: 'orders',
    operation: 'list',
    expected: 'PERMISSION_DENIED',
    payload: {},
  },
  {
    id: 10,
    name: 'Customer Terminal State Re-open',
    collection: 'orders/order_completed',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
    payload: { status: 'pending' },
  },
  {
    id: 11,
    name: 'Self-Assigned Admin Escalation',
    collection: 'admins/attacker_uid',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    payload: { uid: 'attacker_uid', email: 'attacker@example.com' },
  },
  {
    id: 12,
    name: 'Automation Audit Log Deletion',
    collection: 'automationLogs/log_1',
    operation: 'delete',
    expected: 'PERMISSION_DENIED',
    payload: {},
  },
  {
    id: 13,
    name: 'Delivery Account Order Mutation Attempt',
    collection: 'orders/order_1',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
    payload: { status: 'completed' },
  },
  {
    id: 14,
    name: 'Customer Delivery Email Hash Injection on Order Create',
    collection: 'orders/order_bad_hash',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    payload: { id: 'order_bad_hash', deliveryEmailHashes: ['0'.repeat(64)] },
  },
  {
    id: 15,
    name: 'Non-Admin Telegram Support Username Hijack',
    collection: 'storeSupport/telegram',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
    payload: { id: 'telegram', telegramUsername: 'attacker_handle' },
  },
];

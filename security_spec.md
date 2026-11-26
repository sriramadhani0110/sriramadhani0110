# Security Specification & Payload-First TDD (`ALPAMART TRIMUIA ONLAINE`)

## 1. Data Invariants
1. **Product Catalog Integrity**: Only admins may create, delete, or alter product metadata (`price`, `name`, `sku`, `category`). Signed-in verified customers may only decrement `stock` during an atomic checkout transaction where `getAfter(/databases/$(database)/documents/orders/$(incoming().lastOrderId))` verifies a valid order owned by `request.auth.uid` at `request.time`.
2. **Order Ownership & PII Isolation**: Every order in `/orders/{orderId}` must bind `customerId == request.auth.uid` (when verified) or a client-generated `guest_[a-zA-Z0-9_-]{8,64}` token with a high-entropy `orderId.size() >= 20` (for no-email direct customer checkout), start in `status == 'pending'`, and use `request.time` for `createdAt`/`updatedAt`. `list` queries are strictly restricted to the verified owner, bootstrapped Admin, or active Delivery account listed in `deliveryEmailHashes`.
3. **Terminal State Locking**: Orders in `'completed'` or `'cancelled'` status cannot be mutated by customers; only admins can override states.
4. **ROBOTO Automation & Audit Integrity**: `/automationSettings/{settingId}` and `/automationLogs/{logId}` writes are strictly restricted to verified admins. Audit logs are append-only (`update`/`delete` forbidden).
5. **Private Profile Isolation**: Customer shipping PII in `/users/{uid}/private/profile` is readable/writable strictly by `request.auth.uid == uid` (or admin read).
6. **Read-Only Delivery Account Isolation**: Delivery accounts registered in `/deliveryAccounts/{accountId}` (by verified Admin only) can ONLY read (`get`/`list`) orders whose `deliveryEmailHashes` matches `hashing.sha256(request.auth.token.email.lower()).toHexString().lower()`, which is atomically stamped on order creation from `/storeMeta/deliveryRoster`. Delivery accounts CANNOT create, update, or delete orders, products, categories, promotions, automation settings, or admin accounts.
7. **Telegram Store Support Integrity**: `/storeSupport/telegram` holds the public Admin Telegram support contact for the floating customer chat widget. Only verified Admins may create or update it; `list` and `delete` are forbidden.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Shadow Field Injection on Order Create**: `{ ..., isAdmin: true, discountOverride: 999999 }` -> Rejected by `data.keys().hasOnly(...)`.
2. **Identity Spoofing on Order Create**: `{ ..., customerId: "victim_uid_123" }` -> Rejected by `incoming().customerId == request.auth.uid`.
3. **State Shortcutting on Order Create**: `{ ..., status: "completed" }` -> Rejected by `incoming().status == 'pending'`.
4. **Timestamp Tampering on Order Create**: `{ ..., createdAt: "2020-01-01T00:00:00Z" }` -> Rejected by `incoming().createdAt == request.time`.
5. **Unbounded Array / Resource Poisoning on Order Create**: `items` array with 25 elements or >128 char `orderId` -> Rejected by `isValidId(orderId)` and `items.size() <= 20`.
6. **Price / Total Tampering on Product Update by Customer**: Customer sends `{ price: 1, stock: 5 }` -> Rejected by `affectedKeys().hasOnly(['stock', 'lastOrderId', 'updatedAt'])`.
7. **Orphan Stock Griefing without Order**: Customer decrements `stock` with fake `lastOrderId: "nonexistent"` -> Rejected by `getAfter(/databases/$(database)/documents/orders/$(incoming().lastOrderId))`.
8. **Email Spoofing Attack**: Token has `email: "tmalpamartt@gmail.com"` with `email_verified: false` -> Rejected by `request.auth.token.email_verified == true`.
9. **PII Blanket Read on Orders**: Non-owner authenticated customer calls `get` or `list` on all `/orders` -> Rejected by `resource.data.customerId == request.auth.uid || isBootstrappedAdmin() || isDeliveryListedOnOrder(resource.data)`.
10. **Terminal State Re-opening by Customer**: Customer updates a `completed` order back to `pending` -> Rejected by `existing().status == 'pending' && incoming().status == 'cancelled'`.
11. **Self-Assigned Admin or Delivery Escalation**: Regular user writes `/admins/$(request.auth.uid)` or `/deliveryAccounts/fake_id` -> Rejected by `isBootstrappedAdmin()` / `isAdmin()`.
12. **Delivery Order Status Mutation**: Delivery account attempts `update` on `/orders/{orderId}` (`{ status: 'completed' }`) -> Rejected because Delivery has zero write permissions on `/orders`.
13. **Delivery Hash Injection on Order Create**: Customer passes their own email hash in `deliveryEmailHashes` -> Rejected by exact match against `/storeMeta/deliveryRoster`.
14. **Telegram Support Hijack by Non-Admin**: Customer writes `/storeSupport/telegram` with attacker username -> Rejected by `isAdmin()`.

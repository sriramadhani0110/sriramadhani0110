import { useEffect, useMemo, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  Clock,
  ExternalLink,
  MapPin,
  PackageCheck,
  Printer,
  Search,
  Truck,
  XCircle,
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
} from 'firebase/firestore';
import type { Order, OrderStatus, StoreMasterConfig } from '../types/marketplace';
import {
  db,
  handleFirestoreError,
  OperationType,
} from '../lib/firebase';
import {
  formatAmountByCurrency,
  formatTimestamp,
  getGuestOrderRefs,
  normalizeProductUnit,
  ORDER_STATUS_META,
  STORE_LINK,
} from '../lib/catalogSeed';
import { DEFAULT_MASTER_CONFIG } from '../lib/storeDefaults';
import { ProductImage } from './ProductImage';
import { ProofAttachmentPreview } from './ProofAttachmentPreview';
import type { ActivePage } from './Navbar';

interface OrderTrackingViewProps {
  user: User | null;
  masterConfig?: StoreMasterConfig;
  onNavigate: (page: ActivePage) => void;
}

const PIPELINE_STEPS: { key: OrderStatus; label: string }[] = [
  { key: 'pending', label: 'Menunggu' },
  { key: 'processing', label: 'Sedang Diproses' },
  { key: 'shipped', label: 'Dikirim' },
  { key: 'completed', label: 'Selesai' },
];

const STATUS_DESCRIPTIONS: Record<OrderStatus, string> = {
  pending: 'Pesanan masuk dan menunggu konfirmasi dari Admin toko.',
  processing: 'Pesanan sedang diproses oleh toko & disiapkan untuk pengiriman.',
  shipped: 'Kurir sedang dalam perjalanan (FREE DELIVERY) menuju lokasi GPS Anda.',
  completed: 'Pesanan telah selesai diterima. Terima kasih telah berbelanja!',
  cancelled: 'Pesanan ini telah dibatalkan.',
};

export function OrderTrackingView({
  user,
  masterConfig,
  onNavigate,
}: OrderTrackingViewProps) {
  const master = masterConfig || DEFAULT_MASTER_CONFIG;
  const [authOrders, setAuthOrders] = useState<Order[]>([]);
  const [guestOrders, setGuestOrders] = useState<Order[]>([]);
  const [guestRefVersion, setGuestRefVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  useEffect(() => {
    const onUpdated = () => setGuestRefVersion((v) => v + 1);
    window.addEventListener('alpamart_guest_orders_updated', onUpdated);
    return () =>
      window.removeEventListener('alpamart_guest_orders_updated', onUpdated);
  }, []);

  // Real-time listeners for guest orders placed from this browser (no email needed)
  useEffect(() => {
    const refs = getGuestOrderRefs();
    if (refs.length === 0) {
      setGuestOrders([]);
      return;
    }

    const unsubs = refs.map((ref) =>
      onSnapshot(
        doc(db, 'orders', ref.id),
        (snap) => {
          if (!snap.exists()) return;
          const ord = snap.data() as Order;
          setGuestOrders((prev) => {
            const others = prev.filter((p) => p.id !== ord.id);
            return [ord, ...others];
          });
        },
        () => {
          // Ignore deleted/inaccessible order
        }
      )
    );

    return () => {
      unsubs.forEach((u) => u());
    };
  }, [guestRefVersion]);

  useEffect(() => {
    if (!user) {
      setAuthOrders([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const q = query(
      collection(db, 'orders'),
      where('customerId', '==', user.uid)
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const list: Order[] = snapshot.docs.map((d) => d.data() as Order);
        setAuthOrders(list);
        setLoading(false);
      },
      (error) => {
        setLoading(false);
        handleFirestoreError(error, OperationType.LIST, 'orders');
      }
    );

    return () => unsubscribe();
  }, [user]);

  const orders = useMemo(() => {
    const map = new Map<string, Order>();
    for (const o of guestOrders) map.set(o.id, o);
    for (const o of authOrders) map.set(o.id, o);
    return Array.from(map.values()).sort((a, b) => {
      const ta = a.createdAt?.toMillis?.() ?? 0;
      const tb = b.createdAt?.toMillis?.() ?? 0;
      return tb - ta;
    });
  }, [guestOrders, authOrders]);

  const filteredOrders = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return orders;
    return orders.filter(
      (o) =>
        o.orderNumber.toLowerCase().includes(q) ||
        o.trackingNumber.toLowerCase().includes(q) ||
        o.items.some((item) => item.name.toLowerCase().includes(q))
    );
  }, [orders, searchTerm]);

  const customerStats = useMemo(() => {
    const primaryCode = master.primaryCurrencyCode || 'USD';
    const secondaryCode = master.secondaryCurrencyCode || 'KHR';
    const activeCount = orders.filter(
      (o) =>
        o.status === 'pending' ||
        o.status === 'processing' ||
        o.status === 'shipped'
    ).length;
    const completedCount = orders.filter((o) => o.status === 'completed').length;
    const nonCancelled = orders.filter((o) => o.status !== 'cancelled');
    const totalPrimary = nonCancelled
      .filter((o) => (o.currency || primaryCode) === primaryCode)
      .reduce((acc, o) => acc + o.totalAmount, 0);
    const totalSecondary = nonCancelled
      .filter((o) => o.currency === secondaryCode)
      .reduce((acc, o) => acc + o.totalAmount, 0);
    return {
      total: orders.length,
      activeCount,
      completedCount,
      primaryCode,
      secondaryCode,
      totalPrimary,
      totalSecondary,
    };
  }, [orders, master.primaryCurrencyCode, master.secondaryCurrencyCode]);

  const handleCancelOrder = async (order: Order) => {
    if (order.status !== 'pending') return;
    setCancellingId(order.id);
    try {
      await updateDoc(doc(db, 'orders', order.id), {
        status: 'cancelled',
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `orders/${order.id}`);
    } finally {
      setCancellingId(null);
    }
  };

  const renderStatusIcon = (status: OrderStatus) => {
    switch (status) {
      case 'pending':
        return <Clock className="w-4 h-4 shrink-0" />;
      case 'processing':
        return <PackageCheck className="w-4 h-4 shrink-0" />;
      case 'shipped':
        return <Truck className="w-4 h-4 shrink-0" />;
      case 'completed':
        return <CheckCircle2 className="w-4 h-4 shrink-0" />;
      case 'cancelled':
        return <XCircle className="w-4 h-4 shrink-0" />;
    }
  };

  const getStepIndex = (status: OrderStatus): number => {
    if (status === 'pending') return 0;
    if (status === 'processing') return 1;
    if (status === 'shipped') return 2;
    if (status === 'completed') return 3;
    return -1;
  };

  return (
    <div className="min-h-screen bg-transparent py-10">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
        {/* Header Bar */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h1 className="font-display text-2xl sm:text-3xl font-bold text-slate-900">
              Lacak &amp; Riwayat Pesanan Saya
            </h1>
            <p className="text-sm text-slate-600">
              Pantau pembaruan status real-time dan statistik riwayat pesanan Anda di {master.storeName}.
            </p>
          </div>

          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg whitespace-nowrap shrink-0">
            Lacak Langsung Tanpa Email
          </span>
        </div>

        {/* Customer Order History Statistics Strip */}
            {!loading && orders.length > 0 && (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 no-print">
                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <p className="text-xs text-slate-500">Total Riwayat Pesanan</p>
                  <p className="font-mono tabular-nums text-2xl font-bold text-slate-900 mt-1">
                    {customerStats.total}
                  </p>
                </div>
                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <p className="text-xs text-slate-500">Sedang Berjalan</p>
                  <p className="font-mono tabular-nums text-2xl font-bold text-blue-700 mt-1">
                    {customerStats.activeCount}
                  </p>
                </div>
                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <p className="text-xs text-slate-500">Pesanan Selesai</p>
                  <p className="font-mono tabular-nums text-2xl font-bold text-emerald-700 mt-1">
                    {customerStats.completedCount}
                  </p>
                </div>
                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <p className="text-xs text-slate-500">Total Belanja Anda</p>
                  <p className="font-mono tabular-nums text-sm font-bold text-blue-700 mt-1">
                    {formatAmountByCurrency(
                      customerStats.totalPrimary,
                      customerStats.primaryCode,
                      master.primaryCurrencySymbol
                    )}
                  </p>
                  <p className="font-mono tabular-nums text-xs font-semibold text-red-600">
                    {formatAmountByCurrency(
                      customerStats.totalSecondary,
                      customerStats.secondaryCode,
                      master.secondaryCurrencySymbol
                    )}
                  </p>
                </div>
              </div>
            )}

            {/* Search & Action Toolbar */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 no-print">
              <div className="relative flex-1 max-w-md">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Cari nomor pesanan (ALP-...) atau resi..."
                  aria-label="Cari pesanan"
                  className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                />
              </div>

              <button
                type="button"
                onClick={() => onNavigate('catalog')}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Buka Catalog
              </button>
            </div>

            {loading ? (
              <div className="space-y-4">
                {Array.from({ length: 2 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-44 bg-white border border-slate-200 rounded-xl animate-pulse"
                  />
                ))}
              </div>
            ) : filteredOrders.length === 0 ? (
              <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-3">
                <p className="text-base font-semibold text-slate-900">
                  Belum ada pesanan ditemukan
                </p>
                <p className="text-sm text-slate-600">
                  Pesanan yang Anda checkout akan langsung muncul di sini secara real-time.
                </p>
                <button
                  type="button"
                  onClick={() => onNavigate('catalog')}
                  className="mt-2 px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded-lg hover:bg-blue-800 cursor-pointer"
                >
                  Belanja di Catalog
                </button>
              </div>
            ) : (
              <div className="space-y-6">
                {filteredOrders.map((order) => {
                  const statusMeta = ORDER_STATUS_META[order.status];
                  const activeStep = getStepIndex(order.status);
                  const currency = order.currency || 'USD';

                  return (
                    <article
                      key={order.id}
                      className="bg-white border border-slate-200 rounded-xl overflow-hidden"
                    >
                      {/* Top Meta Header */}
                      <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
                        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
                          <span className="font-mono font-semibold text-slate-900 text-sm">
                            {order.orderNumber}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>Dibuat: {formatTimestamp(order.createdAt)}</span>
                          <span aria-hidden="true">·</span>
                          <span>{order.shippingMethod}</span>
                          {order.trackingNumber && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono text-blue-700 font-medium">
                                Resi: {order.trackingNumber}
                              </span>
                            </>
                          )}
                        </div>

                        <div
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold border rounded-md ${statusMeta.toneClass}`}
                        >
                          {renderStatusIcon(order.status)}
                          <span>{statusMeta.label}</span>
                        </div>
                      </div>

                      <div className="p-6 space-y-6">
                        {/* Live Status Update Timeline Banner */}
                        <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                          <p className="font-medium text-slate-800">
                            {STATUS_DESCRIPTIONS[order.status]}
                          </p>
                          <span className="font-mono text-slate-500 whitespace-nowrap shrink-0">
                            Diperbarui: {formatTimestamp(order.updatedAt || order.createdAt)}
                          </span>
                        </div>

                        {/* Delivery Proof Photo / File from Courier */}
                        {order.deliveryProofImageUrl && (
                          <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-lg space-y-2">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                              <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-900">
                                <Camera className="w-4 h-4 text-emerald-700 shrink-0" />
                                <span>
                                  {order.status === 'completed'
                                    ? 'Bukti Pesanan Sudah Diterima Pelanggan'
                                    : 'Bukti Foto Kurir · Belum Diterima Pelanggan'}
                                </span>
                              </span>
                              <span className="font-mono text-emerald-800">
                                {formatTimestamp(order.updatedAt || order.createdAt)}
                              </span>
                            </div>
                            <ProofAttachmentPreview
                              dataUrl={order.deliveryProofImageUrl}
                              orderNumber={order.orderNumber}
                              maxHeightClass="max-h-64"
                            />
                          </div>
                        )}

                        {/* Order Status Progress Bar */}
                        {order.status !== 'cancelled' && (
                          <div className="grid grid-cols-4 gap-2">
                            {PIPELINE_STEPS.map((st, index) => {
                              const done = activeStep >= index;
                              return (
                                <div key={st.key} className="space-y-1.5">
                                  <div
                                    className={`h-1.5 rounded-full transition-colors ${
                                      done ? 'bg-blue-700' : 'bg-slate-200'
                                    }`}
                                  />
                                  <p
                                    className={`text-xs ${
                                      done
                                        ? 'font-semibold text-slate-900'
                                        : 'text-slate-400'
                                    }`}
                                  >
                                    {st.label}
                                  </p>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {/* Items */}
                        <div className="divide-y divide-slate-100 border-t border-b border-slate-100">
                          {order.items.map((item) => (
                            <div
                              key={item.productId}
                              className="py-3 flex items-center justify-between gap-4"
                            >
                              <div className="flex items-center gap-3 min-w-0">
                                <div className="w-12 h-10 rounded-md overflow-hidden bg-slate-100 shrink-0">
                                  <ProductImage
                                    src={item.imageUrl}
                                    alt={item.name}
                                    className="w-full h-full object-cover"
                                  />
                                </div>
                                <div className="min-w-0">
                                  <p className="text-sm font-medium text-slate-900 truncate">
                                    {item.name}
                                  </p>
                                  <p className="text-xs text-slate-500 font-mono tabular-nums">
                                    {item.quantity} {normalizeProductUnit(item.unit)} ×{' '}
                                    {formatAmountByCurrency(item.price, currency)}
                                  </p>
                                </div>
                              </div>
                              <span className="font-mono tabular-nums text-sm font-medium text-slate-900 shrink-0">
                                {formatAmountByCurrency(
                                  item.price * item.quantity,
                                  currency
                                )}
                              </span>
                            </div>
                          ))}
                        </div>

                        {/* Address & Total Summary */}
                        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
                          <div className="text-xs text-slate-600 space-y-1 max-w-md">
                            <p className="font-semibold text-slate-900">
                              Penerima: {order.customerName} (Telegram: {order.customerPhone})
                            </p>
                            {(order.shippingAddress || order.city || order.postalCode) && (
                              <p>
                                {[order.shippingAddress, order.city, order.postalCode]
                                  .filter(Boolean)
                                  .join(', ')}
                              </p>
                            )}
                            {order.locationDetail && (
                              <p className="text-slate-700 inline-flex items-center gap-1">
                                <MapPin className="w-3.5 h-3.5 text-red-600 shrink-0" />
                                <span>{order.locationDetail}</span>
                              </p>
                            )}
                            {(order.locationCoords || order.locationUrl) && (
                              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                                <MapPin className="w-3.5 h-3.5 text-red-600 shrink-0" />
                                {order.locationCoords && (
                                  <span className="font-mono text-blue-700">
                                    GPS: {order.locationCoords}
                                  </span>
                                )}
                                {order.locationUrl && (
                                  <a
                                    href={order.locationUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 text-blue-700 hover:underline font-medium"
                                  >
                                    <ExternalLink className="w-3 h-3" />
                                    <span>Lihat Lokasi</span>
                                  </a>
                                )}
                              </div>
                            )}
                            <p className="text-slate-500">
                              Pembayaran: {order.paymentMethod} ({currency}) ·{' '}
                              {order.shippingCost === 0 ? (
                                <span className="font-semibold text-emerald-700">
                                  Free Delivery
                                </span>
                              ) : (
                                formatAmountByCurrency(order.shippingCost, currency)
                              )}{' '}
                              ·{' '}
                              {masterConfig?.permanentStoreUrl
                                ? masterConfig.permanentStoreUrl.replace(/^https?:\/\//i, '')
                                : STORE_LINK}
                            </p>
                          </div>

                          <div className="flex flex-col sm:items-end gap-2">
                            <div className="text-right">
                              <span className="text-xs text-slate-500 block">
                                Total Pembayaran ({currency})
                              </span>
                              <span
                                className={`font-mono tabular-nums text-lg font-bold ${
                                  currency === 'KHR' ? 'text-red-600' : 'text-blue-700'
                                }`}
                              >
                                {formatAmountByCurrency(order.totalAmount, currency)}
                              </span>
                            </div>

                            <div className="flex items-center gap-2 no-print">
                              <button
                                type="button"
                                onClick={() => window.print()}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors cursor-pointer"
                              >
                                <Printer className="w-3.5 h-3.5" />
                                <span>Cetak Faktur</span>
                              </button>

                              {user && order.status === 'pending' && order.customerId === user.uid && (
                                <button
                                  type="button"
                                  disabled={cancellingId === order.id}
                                  onClick={() => handleCancelOrder(order)}
                                  className="px-3 py-1.5 text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-lg hover:bg-rose-100 transition-colors cursor-pointer disabled:opacity-50"
                                >
                                  {cancellingId === order.id
                                    ? 'Membatalkan...'
                                    : 'Batalkan'}
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
      </div>
    </div>
  );
}

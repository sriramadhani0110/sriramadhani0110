import { useMemo, useState } from 'react';
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  RotateCcw,
  Search,
  TrendingUp,
} from 'lucide-react';
import type {
  CurrencyCode,
  Order,
  OrderStatus,
  PaymentMethod,
  StoreMasterConfig,
} from '../types/marketplace';
import { formatAmountByCurrency } from '../lib/catalogSeed';
import { DEFAULT_MASTER_CONFIG } from '../lib/storeDefaults';

interface AdminDailyOrderHistoryPanelProps {
  orders: Order[];
  masterConfig?: StoreMasterConfig;
  onSelectOrder: (order: Order) => void;
  onNotify?: (message: string) => void;
}

type DateRangePreset = 'today' | 'yesterday' | 'last7' | 'last30' | 'this_month' | 'all' | 'custom';

interface DailyBucket {
  dateKey: string; // YYYY-MM-DD
  labelShort: string;
  labelFull: string;
  totalOrders: number;
  activeOrders: number;
  completedOrders: number;
  cancelledOrders: number;
  pendingOrders: number;
  totalUnits: number;
  qrRevenue: number;
  cashRevenue: number;
  qrCount: number;
  cashCount: number;
  orders: Order[];
}

const STATUS_LABELS: Record<OrderStatus, { label: string; textClass: string }> = {
  pending: { label: 'Menunggu', textClass: 'text-amber-700' },
  processing: { label: 'Diproses', textClass: 'text-blue-700' },
  shipped: { label: 'Dikirim', textClass: 'text-indigo-700' },
  completed: { label: 'Selesai', textClass: 'text-emerald-700' },
  cancelled: { label: 'Dibatalkan', textClass: 'text-rose-700' },
};

function toLocalDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shiftDateKey(dateKey: string, deltaDays: number): string {
  const parts = dateKey.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    return toLocalDateKey(new Date());
  }
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  d.setDate(d.getDate() + deltaDays);
  return toLocalDateKey(d);
}

function getOrderCreatedDate(order: Order): Date | null {
  const ts = order.createdAt as
    | { toDate?: () => Date; seconds?: number }
    | null
    | undefined;
  if (!ts) return null;
  if (typeof ts.toDate === 'function') {
    try {
      const d = ts.toDate();
      return Number.isNaN(d.getTime()) ? null : d;
    } catch {
      return null;
    }
  }
  if (typeof ts.seconds === 'number' && Number.isFinite(ts.seconds)) {
    const d = new Date(ts.seconds * 1000);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function formatDateShortId(dateKey: string): string {
  const parts = dateKey.split('-').map(Number);
  if (parts.length !== 3) return dateKey;
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
}

function formatDateFullId(dateKey: string): string {
  const parts = dateKey.split('-').map(Number);
  if (parts.length !== 3) return dateKey;
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  return d.toLocaleDateString('id-ID', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatOrderTime(d: Date | null): string {
  if (!d) return '—';
  return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

function csvCell(value: string | number | null | undefined): string {
  const s = String(value ?? '').replace(/\r?\n/g, ' ');
  if (/[",]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function AdminDailyOrderHistoryPanel({
  orders,
  masterConfig,
  onSelectOrder,
  onNotify,
}: AdminDailyOrderHistoryPanelProps) {
  const activeMaster = masterConfig || DEFAULT_MASTER_CONFIG;
  const todayKey = useMemo(() => toLocalDateKey(new Date()), []);

  const [preset, setPreset] = useState<DateRangePreset>('last7');
  const [dateFrom, setDateFrom] = useState<string>(() => shiftDateKey(todayKey, -6));
  const [dateTo, setDateTo] = useState<string>(todayKey);
  const [focusedDateKey, setFocusedDateKey] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | OrderStatus>('all');
  const [paymentFilter, setPaymentFilter] = useState<'all' | PaymentMethod>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const applyPreset = (nextPreset: DateRangePreset) => {
    setPreset(nextPreset);
    setFocusedDateKey(null);
    if (nextPreset === 'today') {
      setDateFrom(todayKey);
      setDateTo(todayKey);
    } else if (nextPreset === 'yesterday') {
      const y = shiftDateKey(todayKey, -1);
      setDateFrom(y);
      setDateTo(y);
    } else if (nextPreset === 'last7') {
      setDateFrom(shiftDateKey(todayKey, -6));
      setDateTo(todayKey);
    } else if (nextPreset === 'last30') {
      setDateFrom(shiftDateKey(todayKey, -29));
      setDateTo(todayKey);
    } else if (nextPreset === 'this_month') {
      const now = new Date();
      const firstOfMonth = toLocalDateKey(new Date(now.getFullYear(), now.getMonth(), 1));
      setDateFrom(firstOfMonth);
      setDateTo(todayKey);
    } else if (nextPreset === 'all') {
      setDateFrom('');
      setDateTo('');
    }
  };

  const handleSingleDayStep = (deltaDays: number) => {
    const base = focusedDateKey || dateFrom || todayKey;
    const nextDay = shiftDateKey(base, deltaDays);
    setPreset('custom');
    setDateFrom(nextDay);
    setDateTo(nextDay);
    setFocusedDateKey(null);
  };

  // Pre-annotate orders with local date key & timestamp
  const indexedOrders = useMemo(() => {
    return orders.map((order) => {
      const created = getOrderCreatedDate(order);
      const dateKey = created ? toLocalDateKey(created) : '';
      return { order, created, dateKey };
    });
  }, [orders]);

  // Range-filtered orders (before focusedDateKey drill-down)
  const rangeOrders = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const minKey = dateFrom && dateTo && dateFrom > dateTo ? dateTo : dateFrom;
    const maxKey = dateFrom && dateTo && dateFrom > dateTo ? dateFrom : dateTo;

    return indexedOrders.filter(({ order, dateKey }) => {
      if (minKey && (!dateKey || dateKey < minKey)) return false;
      if (maxKey && (!dateKey || dateKey > maxKey)) return false;
      if (statusFilter !== 'all' && order.status !== statusFilter) return false;
      if (paymentFilter !== 'all' && order.paymentMethod !== paymentFilter) return false;
      if (q) {
        const matchesOrder =
          order.orderNumber.toLowerCase().includes(q) ||
          order.customerName.toLowerCase().includes(q) ||
          (order.customerPhone || '').toLowerCase().includes(q) ||
          (order.shippingAddress || '').toLowerCase().includes(q) ||
          order.items.some((it) => it.name.toLowerCase().includes(q));
        if (!matchesOrder) return false;
      }
      return true;
    });
  }, [indexedOrders, dateFrom, dateTo, statusFilter, paymentFilter, searchQuery]);

  // Build daily buckets for chart + daily breakdown table
  const dailyBuckets = useMemo<DailyBucket[]>(() => {
    const map = new Map<string, DailyBucket>();

    const ensureBucket = (dk: string): DailyBucket => {
      let existing = map.get(dk);
      if (!existing) {
        existing = {
          dateKey: dk,
          labelShort: formatDateShortId(dk),
          labelFull: formatDateFullId(dk),
          totalOrders: 0,
          activeOrders: 0,
          completedOrders: 0,
          cancelledOrders: 0,
          pendingOrders: 0,
          totalUnits: 0,
          qrRevenue: 0,
          cashRevenue: 0,
          qrCount: 0,
          cashCount: 0,
          orders: [],
        };
        map.set(dk, existing);
      }
      return existing;
    };

    // Fill continuous days when range is <= 31 days so zero-order days are clearly visible on the daily performance chart
    if (dateFrom && dateTo) {
      const startKey = dateFrom <= dateTo ? dateFrom : dateTo;
      const endKey = dateFrom <= dateTo ? dateTo : dateFrom;
      const sParts = startKey.split('-').map(Number);
      const eParts = endKey.split('-').map(Number);
      const sDate = new Date(sParts[0], sParts[1] - 1, sParts[2]);
      const eDate = new Date(eParts[0], eParts[1] - 1, eParts[2]);
      const diffDays = Math.round((eDate.getTime() - sDate.getTime()) / 86_400_000);
      if (diffDays >= 0 && diffDays <= 31) {
        for (let i = 0; i <= diffDays; i++) {
          ensureBucket(shiftDateKey(startKey, i));
        }
      }
    }

    for (const { order, dateKey } of rangeOrders) {
      if (!dateKey) continue;
      const b = ensureBucket(dateKey);
      b.totalOrders += 1;
      b.orders.push(order);

      const units = order.items.reduce((acc, it) => acc + Math.max(0, Number(it.quantity) || 0), 0);
      if (order.status === 'cancelled') {
        b.cancelledOrders += 1;
      } else {
        b.activeOrders += 1;
        b.totalUnits += units;
        if (order.status === 'completed') b.completedOrders += 1;
        if (order.status === 'pending') b.pendingOrders += 1;
        const cur: CurrencyCode = order.currency || (order.paymentMethod === 'CASH' ? 'KHR' : 'USD');
        if (cur === activeMaster.secondaryCurrencyCode || order.paymentMethod === 'CASH') {
          b.cashRevenue += Number(order.totalAmount) || 0;
          b.cashCount += 1;
        } else {
          b.qrRevenue += Number(order.totalAmount) || 0;
          b.qrCount += 1;
        }
      }
    }

    return Array.from(map.values()).sort((a, b) => b.dateKey.localeCompare(a.dateKey));
  }, [rangeOrders, dateFrom, dateTo, activeMaster.secondaryCurrencyCode]);

  // Chart buckets in chronological order (oldest -> newest, capped at latest 31 days)
  const chartBuckets = useMemo(() => {
    return [...dailyBuckets].reverse().slice(-31);
  }, [dailyBuckets]);

  const maxChartOrders = useMemo(() => {
    return Math.max(1, ...chartBuckets.map((b) => b.totalOrders));
  }, [chartBuckets]);

  // Orders shown in the detailed table (optionally drilled down to focusedDateKey)
  const visibleOrders = useMemo(() => {
    if (!focusedDateKey) return rangeOrders;
    return rangeOrders.filter((row) => row.dateKey === focusedDateKey);
  }, [rangeOrders, focusedDateKey]);

  // Summary KPIs for the currently active view (respecting focusedDateKey if clicked)
  const summary = useMemo(() => {
    let total = 0;
    let completed = 0;
    let active = 0;
    let cancelled = 0;
    let totalUnits = 0;
    let qrRevenue = 0;
    let qrCount = 0;
    let cashRevenue = 0;
    let cashCount = 0;
    const productMap = new Map<string, { name: string; qty: number; orderCount: number }>();

    for (const { order } of visibleOrders) {
      total += 1;
      if (order.status === 'cancelled') {
        cancelled += 1;
        continue;
      }
      active += 1;
      if (order.status === 'completed') completed += 1;

      const cur: CurrencyCode = order.currency || (order.paymentMethod === 'CASH' ? 'KHR' : 'USD');
      if (cur === activeMaster.secondaryCurrencyCode || order.paymentMethod === 'CASH') {
        cashRevenue += Number(order.totalAmount) || 0;
        cashCount += 1;
      } else {
        qrRevenue += Number(order.totalAmount) || 0;
        qrCount += 1;
      }

      const seenInOrder = new Set<string>();
      for (const item of order.items) {
        const qty = Math.max(0, Number(item.quantity) || 0);
        totalUnits += qty;
        const key = item.productId || item.name;
        const entry = productMap.get(key) || { name: item.name, qty: 0, orderCount: 0 };
        entry.qty += qty;
        if (!seenInOrder.has(key)) {
          entry.orderCount += 1;
          seenInOrder.add(key);
        }
        productMap.set(key, entry);
      }
    }

    const completionRate = active > 0 ? Math.round((completed / active) * 100) : 0;
    const avgQr = qrCount > 0 ? qrRevenue / qrCount : 0;
    const avgCash = cashCount > 0 ? Math.round(cashRevenue / cashCount) : 0;
    const topProducts = Array.from(productMap.values())
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 6);

    return {
      total,
      completed,
      active,
      cancelled,
      totalUnits,
      qrRevenue,
      qrCount,
      cashRevenue,
      cashCount,
      completionRate,
      avgQr,
      avgCash,
      topProducts,
    };
  }, [visibleOrders, activeMaster.secondaryCurrencyCode]);

  const handleExportRangeCsv = () => {
    if (visibleOrders.length === 0) {
      onNotify?.('Tidak ada pesanan pada tanggal yang dipilih untuk diekspor ke CSV.');
      return;
    }

    const headers = [
      'Tanggal',
      'Jam',
      'No Order',
      'Nama Pelanggan',
      'No Telepon',
      'Metode Pembayaran',
      'Mata Uang',
      'Total',
      'Status',
      'Jumlah Item',
      'Daftar Produk',
    ];

    const rows = visibleOrders.map(({ order, created, dateKey }) => {
      const cur: CurrencyCode = order.currency || (order.paymentMethod === 'CASH' ? 'KHR' : 'USD');
      const qtySum = order.items.reduce((acc, it) => acc + (Number(it.quantity) || 0), 0);
      const itemText = order.items.map((it) => `${it.name} x${it.quantity}`).join(' | ');
      return [
        dateKey || '-',
        formatOrderTime(created),
        order.orderNumber,
        order.customerName,
        order.customerPhone || '-',
        order.paymentMethod,
        cur,
        order.totalAmount,
        STATUS_LABELS[order.status]?.label || order.status,
        qtySum,
        itemText,
      ]
        .map(csvCell)
        .join(',');
    });

    const csvContent = `\uFEFF${headers.join(',')}\n${rows.join('\n')}`;
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const labelSuffix = focusedDateKey
      ? focusedDateKey
      : dateFrom && dateTo
        ? `${dateFrom}_sd_${dateTo}`
        : 'semua-tanggal';
    const link = document.createElement('a');
    link.href = url;
    link.download = `riwayat-pesanan-${labelSuffix}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    onNotify?.(`Berhasil mengekspor ${visibleOrders.length} pesanan (${labelSuffix}) ke CSV.`);
  };

  const activeRangeTitle = focusedDateKey
    ? formatDateFullId(focusedDateKey)
    : dateFrom && dateTo
      ? dateFrom === dateTo
        ? formatDateFullId(dateFrom)
        : `${formatDateShortId(dateFrom)} – ${formatDateShortId(dateTo)}`
      : 'Semua Tanggal';

  const isSingleDayView = Boolean(focusedDateKey) || (Boolean(dateFrom) && dateFrom === dateTo);

  return (
    <div className="space-y-6">
      {/* Filter & Date Navigation Toolbar */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              Monitor Performa Penjualan Harian &amp; Riwayat per Tanggal
            </h2>
            <p className="text-sm text-slate-600 mt-0.5">
              Periode aktif: <strong className="text-slate-900">{activeRangeTitle}</strong>
              {' · '}
              <span className="font-mono tabular-nums text-slate-700">
                {visibleOrders.length} pesanan
              </span>
            </p>
          </div>

          {/* Preset Segmented Controls */}
          <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit">
            {(
              [
                ['today', 'Hari Ini'],
                ['yesterday', 'Kemarin'],
                ['last7', '7 Hari'],
                ['last30', '30 Hari'],
                ['this_month', 'Bulan Ini'],
                ['all', 'Semua'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => applyPreset(key)}
                className={`px-3.5 py-2 text-xs sm:text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  preset === key && !focusedDateKey
                    ? 'bg-white text-slate-900 shadow-xs font-semibold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Date Picker, Stepper, Status/Payment Filters & Search */}
        <div className="pt-4 border-t border-slate-100 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-12 gap-3 items-end">
          <div className="xl:col-span-3 flex items-end gap-2">
            <div className="flex-1 min-w-0">
              <label
                htmlFor="daily-history-from"
                className="block text-xs font-semibold text-slate-600 mb-1"
              >
                Dari Tanggal
              </label>
              <input
                id="daily-history-from"
                type="date"
                value={dateFrom}
                onChange={(e) => {
                  setPreset('custom');
                  setFocusedDateKey(null);
                  setDateFrom(e.target.value);
                }}
                className="w-full px-3 py-2 text-sm font-mono text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>
            <div className="flex items-center gap-1 shrink-0 pb-0.5">
              <button
                type="button"
                title="Mundur 1 hari"
                onClick={() => handleSingleDayStep(-1)}
                className="p-2 text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                title="Maju 1 hari"
                onClick={() => handleSingleDayStep(1)}
                className="p-2 text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="xl:col-span-2">
            <label
              htmlFor="daily-history-to"
              className="block text-xs font-semibold text-slate-600 mb-1"
            >
              Sampai Tanggal
            </label>
            <input
              id="daily-history-to"
              type="date"
              value={dateTo}
              onChange={(e) => {
                setPreset('custom');
                setFocusedDateKey(null);
                setDateTo(e.target.value);
              }}
              className="w-full px-3 py-2 text-sm font-mono text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>

          <div className="xl:col-span-2">
            <label
              htmlFor="daily-history-status"
              className="block text-xs font-semibold text-slate-600 mb-1"
            >
              Status Pesanan
            </label>
            <select
              id="daily-history-status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'all' | OrderStatus)}
              className="w-full px-3 py-2 text-sm text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 cursor-pointer"
            >
              <option value="all">Semua Status</option>
              <option value="pending">Menunggu</option>
              <option value="processing">Diproses</option>
              <option value="shipped">Dikirim</option>
              <option value="completed">Selesai</option>
              <option value="cancelled">Dibatalkan</option>
            </select>
          </div>

          <div className="xl:col-span-2">
            <label
              htmlFor="daily-history-payment"
              className="block text-xs font-semibold text-slate-600 mb-1"
            >
              Pembayaran
            </label>
            <select
              id="daily-history-payment"
              value={paymentFilter}
              onChange={(e) => setPaymentFilter(e.target.value as 'all' | PaymentMethod)}
              className="w-full px-3 py-2 text-sm text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600 cursor-pointer"
            >
              <option value="all">Semua (QR &amp; CASH)</option>
              <option value="QR">QR ({activeMaster.primaryCurrencyCode})</option>
              <option value="CASH">CASH ({activeMaster.secondaryCurrencyCode})</option>
            </select>
          </div>

          <div className="xl:col-span-3 flex items-end gap-2">
            <div className="flex-1 min-w-0">
              <label
                htmlFor="daily-history-search"
                className="block text-xs font-semibold text-slate-600 mb-1"
              >
                Cari Order / Pelanggan
              </label>
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="daily-history-search"
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="No order, nama, HP..."
                  className="w-full pl-9 pr-3 py-2 text-sm text-slate-900 bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            </div>
            <button
              type="button"
              onClick={handleExportRangeCsv}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Download className="w-4 h-4" />
              <span>CSV</span>
            </button>
          </div>
        </div>

        {focusedDateKey && (
          <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-sm">
            <p className="text-slate-700">
              Menampilkan rincian khusus tanggal{' '}
              <strong className="text-blue-700">{formatDateFullId(focusedDateKey)}</strong>
            </p>
            <button
              type="button"
              onClick={() => setFocusedDateKey(null)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Kembali ke Rentang Penuh</span>
            </button>
          </div>
        )}
      </section>

      {/* 4-Column Daily Performance KPI Strip */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-1.5">
          <p className="text-xs font-semibold text-slate-500">Total Pesanan</p>
          <p className="font-mono tabular-nums text-3xl font-bold text-slate-900">
            {summary.total}
          </p>
          <p className="text-xs sm:text-sm text-slate-600 tabular-nums">
            <span className="text-emerald-700 font-semibold">{summary.completed} selesai</span>
            {' · '}
            <span>{Math.max(0, summary.active - summary.completed)} proses</span>
            {' · '}
            <span className="text-rose-600">{summary.cancelled} batal</span>
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-1.5">
          <p className="text-xs font-semibold text-slate-500">
            Omzet QR ({activeMaster.primaryCurrencyCode})
          </p>
          <p className="font-mono tabular-nums text-2xl sm:text-3xl font-bold text-blue-700">
            {formatAmountByCurrency(
              summary.qrRevenue,
              activeMaster.primaryCurrencyCode,
              activeMaster.primaryCurrencySymbol
            )}
          </p>
          <p className="text-xs sm:text-sm text-slate-600 font-mono tabular-nums">
            {summary.qrCount} transaksi · rata-rata{' '}
            {formatAmountByCurrency(
              summary.avgQr,
              activeMaster.primaryCurrencyCode,
              activeMaster.primaryCurrencySymbol
            )}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-1.5">
          <p className="text-xs font-semibold text-slate-500">
            Omzet CASH ({activeMaster.secondaryCurrencyCode})
          </p>
          <p className="font-mono tabular-nums text-2xl sm:text-3xl font-bold text-red-600">
            {formatAmountByCurrency(
              summary.cashRevenue,
              activeMaster.secondaryCurrencyCode,
              activeMaster.secondaryCurrencySymbol
            )}
          </p>
          <p className="text-xs sm:text-sm text-slate-600 font-mono tabular-nums">
            {summary.cashCount} transaksi · rata-rata{' '}
            {formatAmountByCurrency(
              summary.avgCash,
              activeMaster.secondaryCurrencyCode,
              activeMaster.secondaryCurrencySymbol
            )}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-1.5">
          <p className="text-xs font-semibold text-slate-500">
            Produk Terjual &amp; Penyelesaian
          </p>
          <p className="font-mono tabular-nums text-3xl font-bold text-slate-900">
            {summary.totalUnits}{' '}
            <span className="text-base font-medium text-slate-500">unit</span>
          </p>
          <p className="text-xs sm:text-sm text-slate-600 tabular-nums">
            Tingkat selesai:{' '}
            <strong className="font-mono text-emerald-700">{summary.completionRate}%</strong>
            {' · '}
            <span className="font-mono">{dailyBuckets.length} hari</span>
          </p>
        </div>
      </section>

      {/* Daily Trend Bar Chart + Top Selling Products */}
      <section className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-stretch">
        <div className="xl:col-span-8 bg-white border border-slate-200 rounded-xl p-5 sm:p-6 flex flex-col justify-between gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-base font-bold text-slate-900">
                Grafik Performa Pesanan Harian
              </h3>
              <p className="text-xs sm:text-sm text-slate-500">
                Klik batang tanggal untuk memfokuskan daftar pesanan di hari tersebut.
              </p>
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-600">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-blue-600 inline-block" />
                Aktif / Selesai
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-slate-300 inline-block" />
                Dibatalkan
              </span>
            </div>
          </div>

          {chartBuckets.length === 0 ? (
            <div className="py-12 text-center text-sm text-slate-500">
              Belum ada data pesanan pada rentang tanggal ini.
            </div>
          ) : (
            <div className="overflow-x-auto pb-2">
              <div className="min-w-[540px] flex items-end gap-1.5 pt-4 border-b border-slate-200">
                {chartBuckets.map((bucket) => {
                  const chartHeight = 148;
                  const totalBarH =
                    bucket.totalOrders > 0
                      ? Math.max(14, Math.round((bucket.totalOrders / maxChartOrders) * chartHeight))
                      : 4;
                  const activeBarH =
                    bucket.totalOrders > 0
                      ? Math.round((bucket.activeOrders / bucket.totalOrders) * totalBarH)
                      : 0;
                  const cancelBarH = Math.max(0, totalBarH - activeBarH);
                  const isSelected = focusedDateKey === bucket.dateKey;

                  return (
                    <button
                      key={bucket.dateKey}
                      type="button"
                      onClick={() =>
                        setFocusedDateKey((prev) =>
                          prev === bucket.dateKey ? null : bucket.dateKey
                        )
                      }
                      title={`${bucket.labelFull}: ${bucket.totalOrders} pesanan (${bucket.completedOrders} selesai)`}
                      className={`group flex-1 min-w-[34px] flex flex-col items-center gap-1.5 rounded-t-lg px-0.5 pt-1 transition-colors cursor-pointer ${
                        isSelected ? 'bg-blue-50/90' : 'hover:bg-slate-50'
                      }`}
                    >
                      <span
                        className={`font-mono tabular-nums text-xs font-semibold ${
                          bucket.totalOrders > 0
                            ? isSelected
                              ? 'text-blue-700'
                              : 'text-slate-700'
                            : 'text-slate-300'
                        }`}
                      >
                        {bucket.totalOrders}
                      </span>
                      <svg
                        viewBox={`0 0 32 ${chartHeight}`}
                        className="w-8 h-36 overflow-visible"
                        aria-hidden="true"
                      >
                        {bucket.totalOrders === 0 ? (
                          <rect
                            x="3"
                            y={chartHeight - 4}
                            width="26"
                            height="4"
                            rx="2"
                            className="fill-slate-200"
                          />
                        ) : (
                          <>
                            {cancelBarH > 0 && (
                              <rect
                                x="3"
                                y={chartHeight - totalBarH}
                                width="26"
                                height={cancelBarH}
                                rx="4"
                                className="fill-slate-300"
                              />
                            )}
                            {activeBarH > 0 && (
                              <rect
                                x="3"
                                y={chartHeight - activeBarH}
                                width="26"
                                height={activeBarH}
                                rx="4"
                                className={
                                  isSelected
                                    ? 'fill-blue-700'
                                    : 'fill-blue-600 group-hover:fill-blue-700'
                                }
                              />
                            )}
                          </>
                        )}
                      </svg>
                      <span
                        className={`font-mono text-xs whitespace-nowrap pb-1.5 ${
                          isSelected ? 'font-bold text-blue-700' : 'text-slate-600'
                        }`}
                      >
                        {bucket.labelShort}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Top Products Sold on Selected Date/Range */}
        <div className="xl:col-span-4 bg-white border border-slate-200 rounded-xl p-5 sm:p-6 flex flex-col gap-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-base font-bold text-slate-900">Produk Terlaris</h3>
              <p className="text-xs sm:text-sm text-slate-500">
                Berdasarkan unit terjual di periode ini
              </p>
            </div>
            <TrendingUp className="w-5 h-5 text-emerald-600 shrink-0" />
          </div>

          {summary.topProducts.length === 0 ? (
            <div className="flex-1 flex items-center justify-center py-8 text-sm text-slate-500 text-center">
              Belum ada produk terjual pada tanggal yang dipilih.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {summary.topProducts.map((prod, idx) => (
                <div
                  key={`${prod.name}-${idx}`}
                  className="py-2.5 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900 truncate">
                      {idx + 1}. {prod.name}
                    </p>
                    <p className="text-xs text-slate-500 tabular-nums">
                      Muncul di {prod.orderCount} pesanan
                    </p>
                  </div>
                  <span className="font-mono tabular-nums text-sm font-bold text-blue-700 shrink-0">
                    {prod.qty} unit
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Daily Performance Summary Table (Date-by-Date) */}
      {!isSingleDayView && dailyBuckets.length > 0 && (
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 sm:px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-base font-bold text-slate-900">
                Rekap Penjualan Harian per Tanggal
              </h3>
              <p className="text-xs sm:text-sm text-slate-500">
                Ringkasan performa harian dari terbaru ke terlama — klik tanggal untuk melihat pesanan hari itu.
              </p>
            </div>
            <span className="font-mono tabular-nums text-xs sm:text-sm text-slate-600">
              {dailyBuckets.length} hari tercatat
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs sm:text-sm font-semibold text-slate-700">
                  <th className="py-3.5 px-4 whitespace-nowrap">Tanggal</th>
                  <th className="py-3.5 px-4 text-right whitespace-nowrap">Pesanan</th>
                  <th className="py-3.5 px-4 text-right whitespace-nowrap">Selesai</th>
                  <th className="py-3.5 px-4 text-right whitespace-nowrap">Batal</th>
                  <th className="py-3.5 px-4 text-right whitespace-nowrap">Unit</th>
                  <th className="py-3.5 px-4 text-right whitespace-nowrap">
                    Omzet QR ({activeMaster.primaryCurrencyCode})
                  </th>
                  <th className="py-3.5 px-4 text-right whitespace-nowrap">
                    Omzet CASH ({activeMaster.secondaryCurrencyCode})
                  </th>
                  <th className="py-3.5 px-4 text-right whitespace-nowrap">Rincian</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {dailyBuckets.map((b) => {
                  const isFocused = focusedDateKey === b.dateKey;
                  return (
                    <tr
                      key={b.dateKey}
                      onClick={() =>
                        setFocusedDateKey((prev) => (prev === b.dateKey ? null : b.dateKey))
                      }
                      className={`transition-colors cursor-pointer ${
                        isFocused ? 'bg-blue-50/70' : 'hover:bg-slate-50/90'
                      }`}
                    >
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <span className="font-semibold text-slate-900">{b.labelFull}</span>
                        <span className="ml-2 font-mono text-xs text-slate-400">{b.dateKey}</span>
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums font-bold text-slate-900">
                        {b.totalOrders}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums text-emerald-700 font-semibold">
                        {b.completedOrders}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums text-rose-600">
                        {b.cancelledOrders}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-700">
                        {b.totalUnits}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums font-semibold text-blue-700 whitespace-nowrap">
                        {formatAmountByCurrency(
                          b.qrRevenue,
                          activeMaster.primaryCurrencyCode,
                          activeMaster.primaryCurrencySymbol
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums font-semibold text-red-600 whitespace-nowrap">
                        {formatAmountByCurrency(
                          b.cashRevenue,
                          activeMaster.secondaryCurrencyCode,
                          activeMaster.secondaryCurrencySymbol
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setFocusedDateKey(b.dateKey);
                          }}
                          className="px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors cursor-pointer"
                        >
                          Lihat Hari Ini
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Detailed Order History Table for Active Date(s) */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 sm:px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-slate-900">
              Daftar Riwayat Pesanan — {activeRangeTitle}
            </h3>
            <p className="text-xs sm:text-sm text-slate-500 tabular-nums">
              Menampilkan {visibleOrders.length} transaksi sesuai filter tanggal &amp; status.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {focusedDateKey && (
              <button
                type="button"
                onClick={() => setFocusedDateKey(null)}
                className="px-3 py-1.5 text-xs sm:text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
              >
                Tampilkan Semua Hari
              </button>
            )}
            <button
              type="button"
              onClick={handleExportRangeCsv}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs sm:text-sm font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
            >
              <Download className="w-4 h-4" />
              <span>Export CSV Tanggal Ini</span>
            </button>
          </div>
        </div>

        {visibleOrders.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <Calendar className="w-10 h-10 text-slate-300 mx-auto" />
            <p className="text-base font-semibold text-slate-800">
              Tidak ada pesanan pada {activeRangeTitle}
            </p>
            <p className="text-sm text-slate-500 max-w-md mx-auto">
              Coba ganti rentang tanggal, pilih preset 7 Hari / 30 Hari, atau reset filter status dan pencarian.
            </p>
            <button
              type="button"
              onClick={() => {
                applyPreset('last30');
                setStatusFilter('all');
                setPaymentFilter('all');
                setSearchQuery('');
              }}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" />
              <span>Tampilkan 30 Hari Terakhir</span>
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs sm:text-sm font-semibold text-slate-700">
                  <th className="py-3.5 px-4 whitespace-nowrap">Tanggal &amp; Jam</th>
                  <th className="py-3.5 px-4 whitespace-nowrap">No. Order</th>
                  <th className="py-3.5 px-4">Pelanggan</th>
                  <th className="py-3.5 px-4">Ringkasan Item</th>
                  <th className="py-3.5 px-4 whitespace-nowrap">Pembayaran</th>
                  <th className="py-3.5 px-4 text-right whitespace-nowrap">Total</th>
                  <th className="py-3.5 px-4 whitespace-nowrap">Status</th>
                  <th className="py-3.5 px-4 text-right whitespace-nowrap">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {visibleOrders.map(({ order, created, dateKey }) => {
                  const cur: CurrencyCode =
                    order.currency || (order.paymentMethod === 'CASH' ? 'KHR' : 'USD');
                  const statusMeta = STATUS_LABELS[order.status] || {
                    label: order.status,
                    textClass: 'text-slate-700',
                  };
                  const itemUnits = order.items.reduce(
                    (acc, it) => acc + (Number(it.quantity) || 0),
                    0
                  );
                  const firstItem = order.items[0]?.name || '-';
                  const extraItems = Math.max(0, order.items.length - 1);

                  return (
                    <tr key={order.id} className="hover:bg-slate-50/90 transition-colors">
                      <td className="py-3.5 px-4 font-mono tabular-nums text-slate-700 whitespace-nowrap">
                        <span className="font-semibold text-slate-900">
                          {dateKey ? formatDateShortId(dateKey) : '-'}
                        </span>
                        <span className="text-slate-400"> · </span>
                        <span>{formatOrderTime(created)}</span>
                      </td>
                      <td className="py-3.5 px-4 font-mono font-bold text-slate-900 whitespace-nowrap">
                        {order.orderNumber}
                      </td>
                      <td className="py-3.5 px-4 min-w-[180px]">
                        <p className="font-semibold text-slate-900">{order.customerName}</p>
                        <p className="text-xs font-mono text-slate-500">
                          {order.customerPhone || '—'}
                        </p>
                      </td>
                      <td className="py-3.5 px-4 min-w-[220px]">
                        <p className="text-slate-800 line-clamp-1">
                          {firstItem}
                          {extraItems > 0 ? ` (+${extraItems} produk lain)` : ''}
                        </p>
                        <p className="text-xs text-slate-500 tabular-nums">
                          {itemUnits} unit total
                        </p>
                      </td>
                      <td className="py-3.5 px-4 font-mono text-xs sm:text-sm text-slate-700 whitespace-nowrap">
                        {order.paymentMethod} ({cur})
                      </td>
                      <td
                        className={`py-3.5 px-4 text-right font-mono tabular-nums font-bold whitespace-nowrap ${
                          cur === activeMaster.secondaryCurrencyCode ||
                          order.paymentMethod === 'CASH'
                            ? 'text-red-600'
                            : 'text-blue-700'
                        }`}
                      >
                        {formatAmountByCurrency(order.totalAmount, cur)}
                      </td>
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <span className={`font-semibold ${statusMeta.textClass}`}>
                          {statusMeta.label}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => onSelectOrder(order)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs sm:text-sm font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors cursor-pointer"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>Detail</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

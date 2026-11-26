import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, ExternalLink, MessageCircle, Send, X } from 'lucide-react';
import type { User } from 'firebase/auth';
import { collection, doc, onSnapshot, query, where } from 'firebase/firestore';
import type { Order, StoreSupportConfig } from '../types/marketplace';
import { db } from '../lib/firebase';
import {
  BOOTSTRAPPED_ADMIN_EMAIL,
  copyTextToClipboard,
  DEFAULT_STORE_SUPPORT,
  getGuestOrderRefs,
  normalizeTelegramHandle,
  ORDER_STATUS_META,
  STORE_NAME,
} from '../lib/catalogSeed';

interface TelegramFloatingChatProps {
  user: User | null;
}

function TelegramIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 0 0-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38Z" />
    </svg>
  );
}

export function TelegramFloatingChat({ user }: TelegramFloatingChatProps) {
  const [open, setOpen] = useState(false);
  const [support, setSupport] = useState<StoreSupportConfig>({
    ...DEFAULT_STORE_SUPPORT,
    updatedAt: null,
  });
  const [authOrders, setAuthOrders] = useState<Order[]>([]);
  const [guestOrders, setGuestOrders] = useState<Order[]>([]);
  const [guestRefVersion, setGuestRefVersion] = useState(0);
  const [selectedOrderId, setSelectedOrderId] = useState('');
  const [customOrderNumber, setCustomOrderNumber] = useState('');
  const [customMessage, setCustomMessage] = useState('');
  const [copiedMsg, setCopiedMsg] = useState(false);

  // Listen to public Admin Telegram support configuration
  useEffect(() => {
    const unsubscribe = onSnapshot(
      doc(db, 'storeSupport', 'telegram'),
      (snap) => {
        if (snap.exists()) {
          setSupport(snap.data() as StoreSupportConfig);
        }
      },
      () => {
        // Fallback silently to default if not configured yet
      }
    );
    return () => unsubscribe();
  }, []);

  // Refresh guest order refs whenever a guest submits a new order
  useEffect(() => {
    const onUpdated = () => setGuestRefVersion((v) => v + 1);
    window.addEventListener('alpamart_guest_orders_updated', onUpdated);
    return () =>
      window.removeEventListener('alpamart_guest_orders_updated', onUpdated);
  }, []);

  // Listen to guest orders saved locally on this device (no email/login needed)
  useEffect(() => {
    const refs = getGuestOrderRefs().slice(0, 8);
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
          // Ignore individual read issues
        }
      )
    );

    return () => {
      unsubs.forEach((u) => u());
    };
  }, [guestRefVersion]);

  // Listen to signed-in customer's own orders as well if logged in
  useEffect(() => {
    if (!user) {
      setAuthOrders([]);
      return;
    }

    const q = query(
      collection(db, 'orders'),
      where('customerId', '==', user.uid)
    );
    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        setAuthOrders(snap.docs.map((d) => d.data() as Order));
      },
      () => {
        setAuthOrders([]);
      }
    );
    return () => unsubscribe();
  }, [user]);

  const orders = useMemo(() => {
    const map = new Map<string, Order>();
    for (const o of guestOrders) map.set(o.id, o);
    for (const o of authOrders) map.set(o.id, o);
    return Array.from(map.values())
      .sort((a, b) => {
        const ta = a.createdAt?.toMillis?.() ?? 0;
        const tb = b.createdAt?.toMillis?.() ?? 0;
        return tb - ta;
      })
      .slice(0, 8);
  }, [guestOrders, authOrders]);

  useEffect(() => {
    if (orders.length > 0 && !selectedOrderId) {
      setSelectedOrderId(orders[0].id);
    }
  }, [orders, selectedOrderId]);

  const selectedOrder = useMemo(
    () => orders.find((o) => o.id === selectedOrderId) || null,
    [orders, selectedOrderId]
  );

  const defaultComposedMessage = useMemo(() => {
    const greeting =
      support.greetingMessage?.trim() || DEFAULT_STORE_SUPPORT.greetingMessage;
    const orderNum =
      selectedOrder?.orderNumber || customOrderNumber.trim();
    const statusText = selectedOrder
      ? ` (Status di sistem: ${ORDER_STATUS_META[selectedOrder.status].label})`
      : '';
    const senderName = selectedOrder?.customerName
      ? `\nNama Penerima: ${selectedOrder.customerName}`
      : '';

    if (orderNum) {
      return `${greeting}\nNomor Pesanan: ${orderNum}${statusText}${senderName}`;
    }
    return greeting;
  }, [support.greetingMessage, selectedOrder, customOrderNumber]);

  const finalMessage = customMessage.trim() || defaultComposedMessage;
  const tgHandle = useMemo(
    () => normalizeTelegramHandle(support.telegramUsername || ''),
    [support.telegramUsername]
  );
  const tgHref = tgHandle
    ? `https://t.me/${tgHandle}?text=${encodeURIComponent(finalMessage)}`
    : '';

  const handleCopyMessage = async () => {
    await copyTextToClipboard(finalMessage);
    setCopiedMsg(true);
    setTimeout(() => setCopiedMsg(false), 1800);
  };

  return (
    <div className="fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom))] right-4 sm:right-5 z-50 no-print flex flex-col items-end gap-3">
      {open && (
        <div
          className="w-[calc(100vw-2rem)] max-w-sm bg-white border border-slate-200 rounded-2xl shadow-2xl overflow-hidden"
          role="dialog"
          aria-label="Chat Telegram Admin"
        >
          {/* Header */}
          <div className="px-4 py-3.5 bg-[#006699] text-white flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-full bg-[#229ED9] text-white flex items-center justify-center shrink-0">
                <TelegramIcon className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold truncate">
                  {support.adminDisplayName || `Admin ${STORE_NAME}`}
                </p>
                <p className="text-[11px] text-sky-100 truncate">
                  Tanya status pesanan langsung ke Admin via Telegram
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Tutup chat Telegram"
              className="p-1 text-white/80 hover:text-white rounded-lg hover:bg-white/10 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Body */}
          <div className="p-4 space-y-3.5 text-xs">
            {orders.length > 0 ? (
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  Pilih Pesanan yang Ditanyakan
                </label>
                <select
                  value={selectedOrderId}
                  onChange={(e) => setSelectedOrderId(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#229ED9]"
                >
                  {orders.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.orderNumber} · {ORDER_STATUS_META[o.status].label}
                    </option>
                  ))}
                  <option value="">-- Pertanyaan Umum / Order Lain --</option>
                </select>
              </div>
            ) : (
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  Nomor Pesanan (Opsional)
                </label>
                <input
                  type="text"
                  maxLength={40}
                  value={customOrderNumber}
                  onChange={(e) => setCustomOrderNumber(e.target.value)}
                  placeholder="Contoh: ALP-20261122-1234"
                  className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#229ED9]"
                />
              </div>
            )}

            <div>
              <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                Pesan ke Admin
              </label>
              <textarea
                rows={3}
                maxLength={240}
                value={customMessage}
                onChange={(e) => setCustomMessage(e.target.value)}
                placeholder={defaultComposedMessage}
                className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#229ED9]"
              />
            </div>

            {tgHref ? (
              <div className="space-y-2">
                <a
                  href={tgHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-bold text-white bg-[#0088cc] hover:bg-[#0077b5] rounded-lg transition-colors"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>Kirim Chat via Telegram</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
                <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                  <span className="font-mono truncate">
                    Telegram Admin:{' '}
                    {tgHandle.startsWith('+') ? tgHandle : `@${tgHandle}`}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyMessage}
                    className="inline-flex items-center gap-1 px-2 py-0.5 font-medium text-slate-700 bg-slate-100 rounded hover:bg-slate-200 cursor-pointer shrink-0"
                  >
                    {copiedMsg ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-600" />
                        <span>Tersalin</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Salin Pesan</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            ) : (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg space-y-2">
                <p className="text-[11px] text-amber-900 leading-relaxed">
                  Username Telegram Admin belum diisi oleh pengelola toko. Admin dapat mengisi username Telegram di menu{' '}
                  <strong>Admin &rarr; Akun Admin</strong> agar tombol ini langsung terhubung ke Telegram.
                </p>
                <div className="flex items-center justify-between gap-2 pt-1">
                  <span className="font-mono text-[11px] text-slate-700 truncate">
                    {BOOTSTRAPPED_ADMIN_EMAIL}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyMessage}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100 cursor-pointer shrink-0"
                  >
                    {copiedMsg ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-600" />
                        <span>Tersalin</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Salin Pesan</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Floating Telegram Trigger Button */}
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label="Chat Telegram Admin untuk tanya status pesanan"
        className="inline-flex items-center gap-2.5 pl-3.5 pr-4 py-3 rounded-full bg-[#0088cc] hover:bg-[#0077b5] text-white shadow-lg hover:shadow-xl transition-all cursor-pointer border border-white/30"
      >
        {open ? (
          <MessageCircle className="w-5 h-5 shrink-0" />
        ) : (
          <TelegramIcon className="w-5 h-5 shrink-0" />
        )}
        <span className="text-xs font-bold tracking-tight whitespace-nowrap">
          Chat Admin Telegram
        </span>
      </button>
    </div>
  );
}

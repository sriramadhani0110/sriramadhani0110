import { useEffect, useState } from 'react';
import {
  Bluetooth,
  CheckCircle2,
  MapPin,
  Printer,
  X,
} from 'lucide-react';
import type { Order } from '../types/marketplace';
import {
  formatAmountByCurrency,
  formatTimestamp,
  normalizeProductUnit,
  ORDER_STATUS_META,
  STORE_NAME,
} from '../lib/catalogSeed';
import {
  printOrderViaBluetooth,
  type PrinterSettings,
} from '../lib/thermalPrinter';

interface ThermalBillModalProps {
  order: Order | null;
  isAutoTriggered?: boolean;
  autoPrintStatus?: string | null;
  settings: PrinterSettings;
  connectedPrinterName: string | null;
  onClose: () => void;
}

export function ThermalBillModal({
  order,
  isAutoTriggered = false,
  autoPrintStatus,
  settings,
  connectedPrinterName,
  onClose,
}: ThermalBillModalProps) {
  const [printingBt, setPrintingBt] = useState(false);
  const [localMsg, setLocalMsg] = useState<string | null>(null);

  useEffect(() => {
    setLocalMsg(null);
  }, [order?.id]);

  if (!order) return null;

  const cur = order.currency || 'USD';

  const handleBluetoothPrint = async () => {
    setLocalMsg(null);
    if (!connectedPrinterName) {
      setLocalMsg(
        'Printer Bluetooth belum terhubung. Hubungkan di tab "Setting Printer" atau gunakan tombol Cetak Browser di samping.'
      );
      return;
    }
    setPrintingBt(true);
    const res = await printOrderViaBluetooth(order, settings);
    setPrintingBt(false);
    setLocalMsg(
      res.ok
        ? `Bill ${order.orderNumber} berhasil dicetak ke ${connectedPrinterName} (${settings.copies}x).`
        : res.error || 'Gagal mencetak ke Printer Bluetooth.'
    );
  };

  const handleBrowserPrint = () => {
    document.body.classList.add('printing-thermal-bill');
    const cleanup = () => {
      document.body.classList.remove('printing-thermal-bill');
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    window.print();
    setTimeout(cleanup, 1500);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Struk Bill ${order.orderNumber}`}
    >
      <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full max-h-[92vh] overflow-y-auto shadow-2xl">
        {/* Top Modal Header (Hidden on print) */}
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3 no-print">
          <div>
            <p className="text-[11px] font-bold text-emerald-700">
              {isAutoTriggered
                ? 'PESANAN BARU MASUK · BILL OTOMATIS'
                : 'STRUK / BILL PESANAN'}
            </p>
            <h3 className="font-mono text-sm font-bold text-slate-900">
              {order.orderNumber}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup bill"
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Status Banner */}
        {(autoPrintStatus || localMsg) && (
          <div className="mx-5 mt-4 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-start gap-2 no-print">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <span>{localMsg || autoPrintStatus}</span>
          </div>
        )}

        {/* Printable Thermal Receipt Sheet */}
        <div className="p-5 flex justify-center">
          <div
            id="thermal-bill-sheet"
            className={`bg-white border border-slate-300 rounded-lg p-4 font-mono text-xs text-slate-900 leading-relaxed ${
              settings.paperWidth === '80mm' ? 'w-full max-w-[320px]' : 'w-full max-w-[260px]'
            }`}
          >
            <div className="text-center border-b border-dashed border-slate-400 pb-2.5">
              <p className="font-bold text-sm uppercase tracking-tight">
                {settings.storeHeader || STORE_NAME}
              </p>
              <p className="text-[10px] text-slate-600 mt-0.5">
                {settings.storeSubheader}
              </p>
            </div>

            <div className="py-2.5 border-b border-dashed border-slate-400 space-y-0.5 text-[11px]">
              <p className="font-bold">ORDER : {order.orderNumber}</p>
              <p>WAKTU : {formatTimestamp(order.createdAt)}</p>
              <p>STATUS: {ORDER_STATUS_META[order.status]?.label || order.status}</p>
              <p>
                BAYAR : {order.paymentMethod} ({cur})
              </p>
              <p>KIRIM : {order.shippingMethod || 'FREE DELIVERY'}</p>
              {order.trackingNumber && <p>RESI  : {order.trackingNumber}</p>}
            </div>

            <div className="py-2.5 border-b border-dashed border-slate-400 space-y-0.5 text-[11px]">
              <p className="font-bold">PENERIMA &amp; LOKASI GPS</p>
              <p>Nama     : {order.customerName}</p>
              <p>Telegram : {order.customerPhone}</p>
              {order.locationCoords && (
                <p className="break-all">GPS  : {order.locationCoords}</p>
              )}
              {order.locationDetail && <p>Patokan: {order.locationDetail}</p>}
              {order.shippingAddress && <p>Alamat : {order.shippingAddress}</p>}
            </div>

            <div className="py-2.5 border-b border-dashed border-slate-400 space-y-1.5 text-[11px]">
              <p className="font-bold">RINCIAN ITEM</p>
              {order.items.map((item) => (
                <div key={item.productId}>
                  <p className="font-semibold">{item.name}</p>
                  <div className="flex justify-between gap-2">
                    <span>
                      {item.quantity} {normalizeProductUnit(item.unit)} × {formatAmountByCurrency(item.price, cur)}
                    </span>
                    <span className="font-semibold">
                      {formatAmountByCurrency(item.price * item.quantity, cur)}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <div className="py-2.5 border-b border-dashed border-slate-400 space-y-1 text-[11px]">
              <div className="flex justify-between">
                <span>Subtotal</span>
                <span>{formatAmountByCurrency(order.subtotal, cur)}</span>
              </div>
              <div className="flex justify-between">
                <span>Ongkir</span>
                <span>
                  {order.shippingCost === 0
                    ? 'FREE DELIVERY'
                    : formatAmountByCurrency(order.shippingCost, cur)}
                </span>
              </div>
              <div className="flex justify-between font-bold text-sm pt-1 border-t border-dashed border-slate-300">
                <span>TOTAL</span>
                <span>{formatAmountByCurrency(order.totalAmount, cur)}</span>
              </div>
            </div>

            {order.notes && (
              <div className="py-2 border-b border-dashed border-slate-400 text-[10px]">
                <p>Catatan: {order.notes}</p>
              </div>
            )}

            <p className="text-center text-[10px] text-slate-600 pt-2.5">
              {settings.footerNote}
            </p>
          </div>
        </div>

        {/* Action Buttons (Hidden on print) */}
        <div className="px-5 py-4 bg-slate-50 border-t border-slate-200 space-y-2.5 no-print">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button
              type="button"
              disabled={printingBt}
              onClick={handleBluetoothPrint}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer disabled:opacity-60"
            >
              <Bluetooth className="w-4 h-4" />
              <span>
                {printingBt
                  ? 'Mencetak Bluetooth...'
                  : 'Cetak Printer Bluetooth'}
              </span>
            </button>
            <button
              type="button"
              onClick={handleBrowserPrint}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-xs font-semibold text-slate-800 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg cursor-pointer"
            >
              <Printer className="w-4 h-4" />
              <span>Cetak Browser / AirPrint</span>
            </button>
          </div>

          {order.locationUrl && (
            <a
              href={order.locationUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100"
            >
              <MapPin className="w-3.5 h-3.5" />
              <span>Buka Lokasi GPS Penerima di Google Maps</span>
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

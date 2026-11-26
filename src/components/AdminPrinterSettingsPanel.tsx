import { useState } from 'react';
import {
  Bell,
  Bluetooth,
  BluetoothConnected,
  BluetoothOff,
  CheckCircle2,
  Printer,
  RotateCcw,
  Smartphone,
  Sparkles,
} from 'lucide-react';
import {
  connectBluetoothPrinter,
  DEFAULT_PRINTER_SETTINGS,
  disconnectBluetoothPrinter,
  isWebBluetoothSupported,
  playNewOrderChime,
  printTestViaBluetooth,
  type PaperWidth,
  type PrinterMode,
  type PrinterSettings,
} from '../lib/thermalPrinter';
import { STORE_NAME } from '../lib/catalogSeed';

interface AdminPrinterSettingsPanelProps {
  settings: PrinterSettings;
  connectedPrinterName: string | null;
  onUpdateSettings: (next: PrinterSettings) => void;
  onPrinterConnectionChange: (name: string | null) => void;
  onTriggerBrowserTestPrint: () => void;
}

export function AdminPrinterSettingsPanel({
  settings,
  connectedPrinterName,
  onUpdateSettings,
  onPrinterConnectionChange,
  onTriggerBrowserTestPrint,
}: AdminPrinterSettingsPanelProps) {
  const [connecting, setConnecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{
    tone: 'ok' | 'err' | 'info';
    text: string;
  } | null>(null);

  const btSupported = isWebBluetoothSupported();

  const handleConnect = async () => {
    setStatusMsg(null);
    setConnecting(true);
    const res = await connectBluetoothPrinter(() => {
      onPrinterConnectionChange(null);
      setStatusMsg({
        tone: 'info',
        text: 'Koneksi Printer Bluetooth terputus. Nyalakan printer lalu klik Sambungkan lagi.',
      });
    });
    setConnecting(false);
    if (res.ok && res.deviceName) {
      onPrinterConnectionChange(res.deviceName);
      onUpdateSettings({
        ...settings,
        mode: 'bluetooth',
        lastDeviceName: res.deviceName,
      });
      setStatusMsg({
        tone: 'ok',
        text: `Printer Bluetooth "${res.deviceName}" berhasil terhubung! Setiap pelanggan checkout, bill akan otomatis tercetak.`,
      });
    } else {
      setStatusMsg({
        tone: 'err',
        text: res.error || 'Gagal menyambungkan Printer Bluetooth.',
      });
    }
  };

  const handleDisconnect = () => {
    disconnectBluetoothPrinter();
    onPrinterConnectionChange(null);
    setStatusMsg({
      tone: 'info',
      text: 'Printer Bluetooth diputuskan.',
    });
  };

  const handleTestBluetooth = async () => {
    setStatusMsg(null);
    if (!connectedPrinterName) {
      setStatusMsg({
        tone: 'err',
        text: 'Sambungkan Printer Bluetooth terlebih dahulu sebelum tes cetak.',
      });
      return;
    }
    setTesting(true);
    const res = await printTestViaBluetooth(settings);
    setTesting(false);
    if (res.ok) {
      setStatusMsg({
        tone: 'ok',
        text: `Struk tes berhasil dikirim ke "${connectedPrinterName}".`,
      });
    } else {
      setStatusMsg({
        tone: 'err',
        text: res.error || 'Gagal mengirim tes cetak ke Printer Bluetooth.',
      });
    }
  };

  const updateField = <K extends keyof PrinterSettings>(
    key: K,
    value: PrinterSettings[K]
  ) => {
    onUpdateSettings({ ...settings, [key]: value });
  };

  return (
    <div className="space-y-6">
      {/* Top Connection & Auto-Print Status Banner */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-100">
          <div className="flex items-start gap-3">
            <div
              className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                connectedPrinterName
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-blue-50 text-blue-700'
              }`}
            >
              {connectedPrinterName ? (
                <BluetoothConnected className="w-5 h-5" />
              ) : (
                <Bluetooth className="w-5 h-5" />
              )}
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">
                Setting Printer Bluetooth &amp; Auto-Print Bill Checkout
              </h2>
              <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">
                Hubungkan printer thermal Bluetooth (58mm / 80mm seperti Xprinter, RPP02N, EPPOS, Zjiang, Panda). Saat pelanggan checkout, bill pesanan otomatis keluar &amp; tercetak.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {connectedPrinterName ? (
              <>
                <span className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Terhubung: {connectedPrinterName}</span>
                </span>
                <button
                  type="button"
                  disabled={testing}
                  onClick={handleTestBluetooth}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer disabled:opacity-60"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>{testing ? 'Mencetak...' : 'Tes Cetak Bluetooth'}</span>
                </button>
                <button
                  type="button"
                  onClick={handleDisconnect}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 hover:bg-rose-100 rounded-lg cursor-pointer"
                >
                  <BluetoothOff className="w-3.5 h-3.5" />
                  <span>Putuskan</span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={connecting}
                  onClick={handleConnect}
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-blue-700 hover:bg-red-600 rounded-lg transition-colors cursor-pointer disabled:opacity-60"
                >
                  <Bluetooth className="w-4 h-4" />
                  <span>
                    {connecting
                      ? 'Mencari Printer Bluetooth...'
                      : 'Sambungkan Printer Bluetooth'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={onTriggerBrowserTestPrint}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Tes Bill Browser</span>
                </button>
              </>
            )}
          </div>
        </div>

        {statusMsg && (
          <div
            className={`p-3.5 rounded-lg border text-xs leading-relaxed ${
              statusMsg.tone === 'ok'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                : statusMsg.tone === 'err'
                  ? 'bg-rose-50 border-rose-200 text-rose-800'
                  : 'bg-blue-50 border-blue-200 text-blue-800'
            }`}
          >
            {statusMsg.text}
          </div>
        )}

        {!btSupported && (
          <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 flex items-start gap-2.5">
            <Smartphone className="w-4 h-4 shrink-0 mt-0.5 text-amber-700" />
            <div className="space-y-1">
              <p className="font-bold">
                Info Perangkat: Web Bluetooth tidak tersedia di browser ini (misal iPhone Safari)
              </p>
              <p className="leading-relaxed">
                Untuk cetak langsung ke Printer Thermal Bluetooth tanpa aplikasi tambahan, buka halaman Admin di <strong>Google Chrome (HP Android / Laptop)</strong>. Atau pilih <strong>Mode Print Browser / AirPrint</strong> di bawah agar popup bill tetap otomatis keluar dan bisa langsung dicetak di semua HP termasuk iPhone.
              </p>
            </div>
          </div>
        )}

        {/* Mode & Paper Settings */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="block text-xs font-bold text-slate-800">
                Mode Cetak Otomatis saat Pelanggan Checkout
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {(
                  [
                    [
                      'bluetooth',
                      'Bluetooth Thermal (ESC/POS)',
                      'Cetak langsung ke printer Bluetooth 58mm/80mm tanpa dialog.',
                    ],
                    [
                      'browser',
                      'Print Browser / AirPrint',
                      'Otomatis buka dialog cetak thermal (cocok untuk semua HP/iPhone/PC).',
                    ],
                  ] as [PrinterMode, string, string][]
                ).map(([m, title, desc]) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => updateField('mode', m)}
                    className={`p-3.5 rounded-xl border text-left transition-colors cursor-pointer ${
                      settings.mode === m
                        ? 'border-blue-700 bg-blue-50/70 ring-1 ring-blue-700'
                        : 'border-slate-200 bg-white hover:bg-slate-50'
                    }`}
                  >
                    <p className="text-xs font-bold text-slate-900">{title}</p>
                    <p className="text-[11px] text-slate-600 mt-1 leading-relaxed">
                      {desc}
                    </p>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Lebar Kertas Thermal
                </label>
                <select
                  value={settings.paperWidth}
                  onChange={(e) =>
                    updateField('paperWidth', e.target.value as PaperWidth)
                  }
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                >
                  <option value="58mm">58 mm (Standar Mini Bluetooth)</option>
                  <option value="80mm">80 mm (Kasir Besar)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Jumlah Rangkap Bill
                </label>
                <select
                  value={String(settings.copies)}
                  onChange={(e) =>
                    updateField('copies', e.target.value === '2' ? 2 : 1)
                  }
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                >
                  <option value="1">1 Rangkap (Kasir / Paket)</option>
                  <option value="2">2 Rangkap (Kasir + Kurir Delivery)</option>
                </select>
              </div>
            </div>

            {/* Auto-Print Toggles */}
            <div className="space-y-2.5 pt-1">
              <label className="flex items-start justify-between gap-3 p-3.5 bg-emerald-50/60 border border-emerald-200 rounded-xl cursor-pointer">
                <div>
                  <p className="text-xs font-bold text-emerald-950">
                    Auto-Print Bill Otomatis saat Pelanggan Checkout
                  </p>
                  <p className="text-[11px] text-emerald-800 mt-0.5">
                    Begitu ada pesanan baru masuk, sistem langsung mencetak struk ke Printer Bluetooth (atau membuka cetak otomatis).
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={settings.autoPrintOnCheckout}
                  onChange={(e) =>
                    updateField('autoPrintOnCheckout', e.target.checked)
                  }
                  className="mt-0.5 w-4 h-4 accent-emerald-600 cursor-pointer shrink-0"
                />
              </label>

              <label className="flex items-start justify-between gap-3 p-3.5 bg-slate-50 border border-slate-200 rounded-xl cursor-pointer">
                <div>
                  <p className="text-xs font-bold text-slate-900">
                    Tampilkan Popup Bill di Layar Admin saat Order Masuk
                  </p>
                  <p className="text-[11px] text-slate-600 mt-0.5">
                    Struk pesanan langsung muncul di layar agar Admin bisa cek cepat atau cetak ulang 1 klik.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={settings.autoOpenBillPopup}
                  onChange={(e) =>
                    updateField('autoOpenBillPopup', e.target.checked)
                  }
                  className="mt-0.5 w-4 h-4 accent-blue-700 cursor-pointer shrink-0"
                />
              </label>

              <div className="flex items-center justify-between gap-3 p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
                <label className="flex items-start gap-2.5 cursor-pointer flex-1">
                  <input
                    type="checkbox"
                    checked={settings.soundAlert}
                    onChange={(e) => updateField('soundAlert', e.target.checked)}
                    className="mt-0.5 w-4 h-4 accent-blue-700 cursor-pointer shrink-0"
                  />
                  <div>
                    <p className="text-xs font-bold text-slate-900">
                      Bunyi Bel Kasir saat Pesanan Baru Masuk
                    </p>
                    <p className="text-[11px] text-slate-600">
                      Memberi tanda suara agar Admin langsung tahu ada checkout baru.
                    </p>
                  </div>
                </label>
                <button
                  type="button"
                  onClick={() => playNewOrderChime()}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-blue-700 bg-white border border-blue-200 rounded-lg hover:bg-blue-50 cursor-pointer shrink-0"
                >
                  <Bell className="w-3 h-3" />
                  <span>Tes Bunyi</span>
                </button>
              </div>
            </div>

            {/* Header & Footer Template */}
            <div className="space-y-3 pt-2 border-t border-slate-100">
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold text-slate-800">
                  Template Teks Struk / Bill
                </p>
                <button
                  type="button"
                  onClick={() =>
                    onUpdateSettings({
                      ...DEFAULT_PRINTER_SETTINGS,
                      lastDeviceName: settings.lastDeviceName,
                    })
                  }
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-slate-800 cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Reset Default</span>
                </button>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Judul Toko di Atas Struk
                </label>
                <input
                  type="text"
                  maxLength={60}
                  value={settings.storeHeader}
                  onChange={(e) => updateField('storeHeader', e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Subjudul / Info Layanan
                </label>
                <input
                  type="text"
                  maxLength={80}
                  value={settings.storeSubheader}
                  onChange={(e) =>
                    updateField('storeSubheader', e.target.value)
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Catatan Bawah Struk (Footer)
                </label>
                <input
                  type="text"
                  maxLength={120}
                  value={settings.footerNote}
                  onChange={(e) => updateField('footerNote', e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
                />
              </div>
            </div>
          </div>

          {/* Live Thermal Receipt Preview */}
          <div className="bg-slate-100 border border-slate-200 rounded-xl p-5 flex flex-col items-center justify-center space-y-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
              <Sparkles className="w-3.5 h-3.5 text-blue-700" />
              <span>Preview Struk Thermal ({settings.paperWidth})</span>
            </div>

            <div
              className={`bg-white border border-slate-300 shadow-sm rounded p-4 font-mono text-[11px] text-slate-900 leading-snug ${
                settings.paperWidth === '80mm' ? 'w-full max-w-[300px]' : 'w-full max-w-[240px]'
              }`}
            >
              <div className="text-center border-b border-dashed border-slate-400 pb-2">
                <p className="font-bold text-xs uppercase">
                  {settings.storeHeader || STORE_NAME}
                </p>
                <p className="text-[10px] text-slate-600 mt-0.5">
                  {settings.storeSubheader}
                </p>
              </div>
              <div className="py-2 border-b border-dashed border-slate-400 space-y-0.5 text-[10px]">
                <p className="font-bold">BILL ORDER: ALP-20261122-001</p>
                <p>Bayar : QR (USD) · FREE DELIVERY</p>
                <p>Nama  : Budi Santoso</p>
                <p>Telp  : 081234567890</p>
                <p>GPS   : 11.556400, 104.928200</p>
              </div>
              <div className="py-2 border-b border-dashed border-slate-400 space-y-1 text-[10px]">
                <div>
                  <p>Kopi Susu Kemasan</p>
                  <div className="flex justify-between">
                    <span>  2 x $2.50</span>
                    <span>$5.00</span>
                  </div>
                </div>
                <div>
                  <p>Air Mineral 1.5L</p>
                  <div className="flex justify-between">
                    <span>  1 x $1.00</span>
                    <span>$1.00</span>
                  </div>
                </div>
              </div>
              <div className="py-2 border-b border-dashed border-slate-400 space-y-0.5 text-[10px]">
                <div className="flex justify-between">
                  <span>Ongkir</span>
                  <span>FREE DELIVERY</span>
                </div>
                <div className="flex justify-between font-bold text-xs pt-1">
                  <span>TOTAL</span>
                  <span>$6.00</span>
                </div>
              </div>
              <p className="text-center text-[10px] text-slate-600 pt-2">
                {settings.footerNote}
              </p>
            </div>

            <p className="text-[11px] text-slate-500 text-center max-w-xs leading-relaxed">
              Biarkan halaman Admin tetap terbuka di HP/Tablet/Laptop kasir agar setiap pelanggan checkout, bill langsung otomatis tercetak.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

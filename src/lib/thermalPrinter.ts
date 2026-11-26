import type { Order } from '../types/marketplace';
import {
  formatAmountByCurrency,
  formatTimestamp,
  normalizeProductUnit,
  ORDER_STATUS_META,
  STORE_NAME,
} from './catalogSeed';

export type PrinterMode = 'bluetooth' | 'browser';
export type PaperWidth = '58mm' | '80mm';

export interface PrinterSettings {
  mode: PrinterMode;
  paperWidth: PaperWidth;
  autoPrintOnCheckout: boolean;
  autoOpenBillPopup: boolean;
  soundAlert: boolean;
  copies: 1 | 2;
  storeHeader: string;
  storeSubheader: string;
  footerNote: string;
  lastDeviceName: string;
}

export const DEFAULT_PRINTER_SETTINGS: PrinterSettings = {
  mode: 'bluetooth',
  paperWidth: '58mm',
  autoPrintOnCheckout: true,
  autoOpenBillPopup: true,
  soundAlert: true,
  copies: 1,
  storeHeader: STORE_NAME,
  storeSubheader: 'FREE DELIVERY · CASH (KHR) & QR ABA (USD)',
  footerNote: 'Terima kasih telah berbelanja di ALPAMART TRIMUIA ONLAINE!',
  lastDeviceName: '',
};

const PRINTER_STORAGE_KEY = 'alpamart_admin_printer_settings_v1';

export function loadPrinterSettings(): PrinterSettings {
  try {
    const raw = localStorage.getItem(PRINTER_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PRINTER_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<PrinterSettings>;
    return {
      mode: parsed.mode === 'browser' ? 'browser' : 'bluetooth',
      paperWidth: parsed.paperWidth === '80mm' ? '80mm' : '58mm',
      autoPrintOnCheckout: parsed.autoPrintOnCheckout !== false,
      autoOpenBillPopup: parsed.autoOpenBillPopup !== false,
      soundAlert: parsed.soundAlert !== false,
      copies: parsed.copies === 2 ? 2 : 1,
      storeHeader:
        typeof parsed.storeHeader === 'string' && parsed.storeHeader.trim()
          ? parsed.storeHeader.trim()
          : DEFAULT_PRINTER_SETTINGS.storeHeader,
      storeSubheader:
        typeof parsed.storeSubheader === 'string' && parsed.storeSubheader.trim()
          ? parsed.storeSubheader.trim()
          : DEFAULT_PRINTER_SETTINGS.storeSubheader,
      footerNote:
        typeof parsed.footerNote === 'string'
          ? parsed.footerNote.trim()
          : DEFAULT_PRINTER_SETTINGS.footerNote,
      lastDeviceName:
        typeof parsed.lastDeviceName === 'string' ? parsed.lastDeviceName : '',
    };
  } catch {
    return { ...DEFAULT_PRINTER_SETTINGS };
  }
}

export function savePrinterSettings(settings: PrinterSettings): void {
  try {
    localStorage.setItem(PRINTER_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore storage errors
  }
}

// Common BLE GATT Service UUIDs used by 58mm & 80mm thermal Bluetooth printers
// (Xprinter, RPP02N, EPPOS, Zjiang, Panda, Gprinter, BellaV, Star, Epson, etc.)
const THERMAL_PRINTER_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  '0000fee7-0000-1000-8000-00805f9b34fb',
  '0000af30-0000-1000-8000-00805f9b34fb',
  '0000ae30-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
];

interface MinimalBluetoothCharacteristic {
  properties?: {
    write?: boolean;
    writeWithoutResponse?: boolean;
  };
  writeValueWithoutResponse?: (value: BufferSource) => Promise<void>;
  writeValue?: (value: BufferSource) => Promise<void>;
}

interface MinimalBluetoothService {
  getCharacteristics: () => Promise<MinimalBluetoothCharacteristic[]>;
}

interface MinimalBluetoothServer {
  connected: boolean;
  connect: () => Promise<MinimalBluetoothServer>;
  disconnect: () => void;
  getPrimaryServices: () => Promise<MinimalBluetoothService[]>;
}

interface MinimalBluetoothDevice {
  id: string;
  name?: string;
  gatt?: MinimalBluetoothServer;
  addEventListener: (event: string, listener: () => void) => void;
}

interface NavigatorWithBluetooth {
  bluetooth?: {
    requestDevice: (options: {
      acceptAllDevices: boolean;
      optionalServices: string[];
    }) => Promise<MinimalBluetoothDevice>;
  };
}

let activeDevice: MinimalBluetoothDevice | null = null;
let activeCharacteristic: MinimalBluetoothCharacteristic | null = null;
let disconnectCallback: (() => void) | null = null;

export function isWebBluetoothSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  return Boolean((navigator as unknown as NavigatorWithBluetooth).bluetooth);
}

export function getConnectedPrinterName(): string | null {
  if (activeDevice && activeDevice.gatt?.connected && activeCharacteristic) {
    return activeDevice.name || 'Printer Thermal Bluetooth';
  }
  return null;
}

export function disconnectBluetoothPrinter(): void {
  try {
    if (activeDevice?.gatt?.connected) {
      activeDevice.gatt.disconnect();
    }
  } catch {
    // ignore
  }
  activeDevice = null;
  activeCharacteristic = null;
}

export async function connectBluetoothPrinter(
  onDisconnected?: () => void
): Promise<{ ok: boolean; deviceName?: string; error?: string }> {
  if (!isWebBluetoothSupported()) {
    return {
      ok: false,
      error:
        'Browser ini belum mendukung Web Bluetooth langsung (contoh: iPhone Safari). Gunakan Google Chrome di Android/Laptop untuk Bluetooth langsung, atau pilih Mode "Print Browser / AirPrint" agar struk tetap otomatis keluar di semua HP.',
    };
  }

  try {
    const bt = (navigator as unknown as NavigatorWithBluetooth).bluetooth!;
    const device = await bt.requestDevice({
      acceptAllDevices: true,
      optionalServices: THERMAL_PRINTER_SERVICES,
    });

    if (!device.gatt) {
      return {
        ok: false,
        error: 'Perangkat Bluetooth yang dipilih tidak mendukung layanan GATT Printer Thermal.',
      };
    }

    const server = await device.gatt.connect();
    const services = await server.getPrimaryServices();

    let foundChar: MinimalBluetoothCharacteristic | null = null;
    for (const service of services) {
      try {
        const chars = await service.getCharacteristics();
        for (const ch of chars) {
          if (ch.properties?.writeWithoutResponse || ch.properties?.write) {
            foundChar = ch;
            break;
          }
        }
        if (foundChar) break;
      } catch {
        // skip restricted service
      }
    }

    if (!foundChar) {
      server.disconnect();
      return {
        ok: false,
        error:
          'Printer tersambung tetapi saluran cetak ESC/POS tidak ditemukan. Pastikan memilih perangkat Printer Thermal Bluetooth (58mm/80mm) yang sedang menyala.',
      };
    }

    activeDevice = device;
    activeCharacteristic = foundChar;
    disconnectCallback = onDisconnected || null;

    device.addEventListener('gattserverdisconnected', () => {
      activeCharacteristic = null;
      if (disconnectCallback) disconnectCallback();
    });

    return {
      ok: true,
      deviceName: device.name || 'Printer Thermal Bluetooth',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/cancel|abort/i.test(message)) {
      return {
        ok: false,
        error: 'Pemilihan printer Bluetooth dibatalkan.',
      };
    }
    return {
      ok: false,
      error: `Gagal menyambungkan Printer Bluetooth: ${message}`,
    };
  }
}

function sanitizeAscii(text: string): string {
  return text
    .replace(/[·•]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7E\n]/g, ' ');
}

function padLine(left: string, right: string, width: number): string {
  const cleanL = sanitizeAscii(left);
  const cleanR = sanitizeAscii(right);
  const spaceCount = Math.max(1, width - cleanL.length - cleanR.length);
  if (cleanL.length + cleanR.length + 1 > width) {
    const maxL = Math.max(4, width - cleanR.length - 1);
    return `${cleanL.slice(0, maxL)} ${cleanR}`;
  }
  return `${cleanL}${' '.repeat(spaceCount)}${cleanR}`;
}

function wrapLines(text: string, width: number): string[] {
  const clean = sanitizeAscii(text).trim();
  if (!clean) return [];
  const words = clean.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    if (!current) {
      current = w;
    } else if (current.length + 1 + w.length <= width) {
      current += ` ${w}`;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

class EscPosBuilder {
  private chunks: number[] = [];

  raw(...bytes: number[]): this {
    this.chunks.push(...bytes);
    return this;
  }

  init(): this {
    return this.raw(0x1b, 0x40);
  }

  align(mode: 'left' | 'center' | 'right'): this {
    const code = mode === 'center' ? 1 : mode === 'right' ? 2 : 0;
    return this.raw(0x1b, 0x61, code);
  }

  bold(on: boolean): this {
    return this.raw(0x1b, 0x45, on ? 1 : 0);
  }

  size(normalOrDouble: 'normal' | 'doubleHeight' | 'double'): this {
    const code =
      normalOrDouble === 'double'
        ? 0x11
        : normalOrDouble === 'doubleHeight'
          ? 0x01
          : 0x00;
    return this.raw(0x1d, 0x21, code);
  }

  line(text = ''): this {
    const clean = sanitizeAscii(text);
    for (let i = 0; i < clean.length; i++) {
      this.chunks.push(clean.charCodeAt(i) & 0x7f);
    }
    this.chunks.push(0x0a);
    return this;
  }

  divider(width: number, char = '-'): this {
    return this.line(char.repeat(width));
  }

  feed(lines = 3): this {
    return this.raw(0x1b, 0x64, lines);
  }

  cut(): this {
    return this.raw(0x1d, 0x56, 0x42, 0x00);
  }

  toUint8Array(): Uint8Array {
    return new Uint8Array(this.chunks);
  }
}

export function buildOrderEscPosBytes(
  order: Order,
  settings: PrinterSettings
): Uint8Array {
  const width = settings.paperWidth === '80mm' ? 46 : 32;
  const cur = order.currency || 'USD';
  const b = new EscPosBuilder();

  b.init()
    .align('center')
    .bold(true)
    .size('doubleHeight')
    .line(settings.storeHeader || STORE_NAME)
    .size('normal')
    .bold(false);

  for (const sub of wrapLines(settings.storeSubheader, width)) {
    b.line(sub);
  }

  b.divider(width, '=')
    .align('left')
    .bold(true)
    .line(`BILL ORDER: ${order.orderNumber}`)
    .bold(false)
    .line(`Waktu : ${formatTimestamp(order.createdAt)}`)
    .line(`Status: ${ORDER_STATUS_META[order.status]?.label || order.status}`)
    .line(`Bayar : ${order.paymentMethod} (${cur})`)
    .line(`Kirim : ${order.shippingMethod || 'FREE DELIVERY'}`);

  if (order.trackingNumber) {
    b.line(`Resi  : ${order.trackingNumber}`);
  }

  b.divider(width, '-')
    .bold(true)
    .line('PENERIMA & LOKASI GPS')
    .bold(false)
    .line(`Nama  : ${order.customerName}`)
    .line(`Tele  : ${order.customerPhone}`);

  if (order.locationCoords) {
    b.line(`GPS   : ${order.locationCoords}`);
  }
  if (order.locationDetail) {
    for (const l of wrapLines(`Patokan: ${order.locationDetail}`, width)) {
      b.line(l);
    }
  }
  if (order.shippingAddress) {
    for (const l of wrapLines(`Alamat: ${order.shippingAddress}`, width)) {
      b.line(l);
    }
  }

  b.divider(width, '-')
    .bold(true)
    .line('RINCIAN PESANAN')
    .bold(false);

  for (const item of order.items) {
    for (const l of wrapLines(item.name, width)) {
      b.line(l);
    }
    const unitStr = formatAmountByCurrency(item.price, cur);
    const lineTotalStr = formatAmountByCurrency(item.price * item.quantity, cur);
    const unitLabel = normalizeProductUnit(item.unit);
    b.line(padLine(`  ${item.quantity} ${unitLabel} x ${unitStr}`, lineTotalStr, width));
  }

  b.divider(width, '-')
    .line(padLine('Subtotal', formatAmountByCurrency(order.subtotal, cur), width))
    .line(
      padLine(
        'Ongkir',
        order.shippingCost === 0
          ? 'FREE DELIVERY'
          : formatAmountByCurrency(order.shippingCost, cur),
        width
      )
    )
    .divider(width, '=')
    .bold(true)
    .size('doubleHeight')
    .line(padLine('TOTAL', formatAmountByCurrency(order.totalAmount, cur), width))
    .size('normal')
    .bold(false)
    .divider(width, '=');

  if (order.notes) {
    for (const l of wrapLines(`Catatan: ${order.notes}`, width)) {
      b.line(l);
    }
    b.divider(width, '-');
  }

  b.align('center');
  for (const f of wrapLines(settings.footerNote, width)) {
    b.line(f);
  }
  b.feed(4).cut();

  return b.toUint8Array();
}

export function buildTestReceiptEscPosBytes(
  settings: PrinterSettings
): Uint8Array {
  const width = settings.paperWidth === '80mm' ? 46 : 32;
  const nowStr = new Date().toLocaleString('id-ID');
  const b = new EscPosBuilder();

  b.init()
    .align('center')
    .bold(true)
    .size('doubleHeight')
    .line(settings.storeHeader || STORE_NAME)
    .size('normal')
    .bold(false)
    .line('TES CETAK PRINTER BLUETOOTH')
    .divider(width, '=')
    .align('left')
    .line(`Lebar Kertas : ${settings.paperWidth}`)
    .line(`Auto-Print   : ${settings.autoPrintOnCheckout ? 'AKTIF' : 'NONAKTIF'}`)
    .line(`Rangkap      : ${settings.copies}x`)
    .line(`Waktu Tes    : ${nowStr}`)
    .divider(width, '-')
    .align('center')
    .bold(true)
    .line('KONEKSI PRINTER BERHASIL!')
    .bold(false)
    .line('Bill akan otomatis tercetak')
    .line('setiap pelanggan checkout.')
    .feed(4)
    .cut();

  return b.toUint8Array();
}

async function sendBytesInChunks(payload: Uint8Array): Promise<void> {
  if (!activeCharacteristic || !activeDevice?.gatt?.connected) {
    throw new Error('Printer Bluetooth belum terhubung.');
  }

  const chunkSize = 100;
  for (let offset = 0; offset < payload.length; offset += chunkSize) {
    const slice = payload.slice(offset, offset + chunkSize);
    if (
      activeCharacteristic.properties?.writeWithoutResponse &&
      activeCharacteristic.writeValueWithoutResponse
    ) {
      await activeCharacteristic.writeValueWithoutResponse(slice);
    } else if (activeCharacteristic.writeValue) {
      await activeCharacteristic.writeValue(slice);
    } else {
      throw new Error('Karakteristik Bluetooth tidak mendukung penulisan data.');
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

export async function printOrderViaBluetooth(
  order: Order,
  settings: PrinterSettings
): Promise<{ ok: boolean; error?: string }> {
  try {
    const payload = buildOrderEscPosBytes(order, settings);
    const copies = settings.copies === 2 ? 2 : 1;
    for (let i = 0; i < copies; i++) {
      await sendBytesInChunks(payload);
      if (i + 1 < copies) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : 'Gagal mencetak struk ke Printer Bluetooth.',
    };
  }
}

export async function printTestViaBluetooth(
  settings: PrinterSettings
): Promise<{ ok: boolean; error?: string }> {
  try {
    const payload = buildTestReceiptEscPosBytes(settings);
    await sendBytesInChunks(payload);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : 'Gagal mencetak struk tes ke Printer Bluetooth.',
    };
  }
}

/**
 * Plays a short pleasant two-tone POS chime when a new customer order arrives.
 */
export function playNewOrderChime(): void {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const notes = [880, 1174.66];
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.14);
      gain.gain.setValueAtTime(0.001, now + idx * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.16, now + idx * 0.14 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.14 + 0.24);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.14);
      osc.stop(now + idx * 0.14 + 0.26);
    });
  } catch {
    // ignore autoplay restriction if tab has not interacted yet
  }
}

import { useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Database,
  FileSpreadsheet,
  Globe,
  Image as ImageIcon,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { doc, serverTimestamp, updateDoc, writeBatch } from 'firebase/firestore';
import type { Product } from '../types/marketplace';
import { db } from '../lib/firebase';
import {
  isProductNeedingImage,
  PLACEHOLDER_PRODUCT_IMAGE_URL,
} from '../lib/marketplaceBulkImport';
import { broadcastCrossTabEvent } from '../lib/crossAccountSync';

function buildSafeProductImageUrl(raw: string): string {
  const trimmed = (raw || '').trim();
  if (
    trimmed.startsWith('data:image/') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('/assets/')
  ) {
    return trimmed;
  }
  return PLACEHOLDER_PRODUCT_IMAGE_URL;
}

interface AdminBarcodeAutoImageModalProps {
  isOpen: boolean;
  products: Product[];
  onClose: () => void;
  onNotify?: (message: string) => void;
}

interface ParsedInputRow {
  barcode: string;
  name: string;
  matchedProduct: Product | null;
}

interface ProcessedResultRow {
  key: string;
  productId: string | null;
  productName: string;
  barcode: string;
  status: 'saved' | 'skipped_has_photo' | 'not_found' | 'unmatched_catalog' | 'reverted';
  imageUrl?: string;
  matchedName?: string;
  source?: string;
  matchConfidence?: 'exact_barcode' | 'exact_kps_name' | 'verified_name';
  reason?: string;
}

function normalizeLookupText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/^\s*\d{1,5}\s*[-.:/]\s*/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBarcodeKey(raw?: string): string[] {
  if (!raw) return [];
  const compact = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (!compact) return [];
  const out = new Set<string>([compact]);
  const withoutPrefix = compact.replace(
    /^(?:PCS|IND|KHS|BOX|SLOP|PKT|PCK|ID|KH|PR|ST|PK|R|S|V|B)[-_:]*/i,
    ''
  );
  if (withoutPrefix.length >= 4) out.add(withoutPrefix);
  const digits = withoutPrefix.replace(/[^0-9]/g, '');
  if (digits.length >= 8) {
    out.add(digits);
    const trimmedZero = digits.replace(/^0+/, '');
    if (trimmedZero.length >= 8) out.add(trimmedZero);
    if (digits.length === 11) {
      out.add(`0${digits}`);
      out.add(`00${digits}`);
    } else if (digits.length === 12) {
      out.add(`0${digits}`);
    }
  }
  return Array.from(out);
}

function parseBarcodeNameList(rawText: string): Array<{ barcode: string; name: string }> {
  const lines = rawText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');
  const rows: Array<{ barcode: string; name: string }> = [];
  const seen = new Set<string>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let barcode = '';
    let name = '';

    if (line.includes('\t')) {
      const parts = line.split('\t').map((s) => s.trim());
      barcode = parts[0] || '';
      name = parts.slice(1).join(' ').trim();
    } else if (line.includes(';')) {
      const parts = line.split(';').map((s) => s.trim());
      barcode = parts[0] || '';
      name = parts.slice(1).join(' ').trim();
    } else if (line.includes(',')) {
      const firstComma = line.indexOf(',');
      barcode = line.slice(0, firstComma).replace(/^"|"$/g, '').trim();
      name = line.slice(firstComma + 1).replace(/^"|"$/g, '').trim();
    } else {
      const m = line.match(/^([A-Za-z0-9._-]{3,32})\s{2,}(.+)$/);
      if (m) {
        barcode = m[1].trim();
        name = m[2].trim();
      } else {
        name = line;
      }
    }

    // Skip header lines
    const lowerB = barcode.toLowerCase();
    const lowerN = name.toLowerCase();
    if (
      (lowerB === 'barcode' || lowerB === 'kode' || lowerB === 'sku') &&
      (lowerN.includes('nama') || lowerN.includes('produk') || lowerN.includes('name'))
    ) {
      continue;
    }

    if (!barcode && !name) continue;
    const dedupeKey = `${barcode.toUpperCase()}|${normalizeLookupText(name)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    rows.push({ barcode: barcode.slice(0, 80), name: name.slice(0, 160) });
  }

  return rows;
}

export function AdminBarcodeAutoImageModal({
  isOpen,
  products,
  onClose,
  onNotify,
}: AdminBarcodeAutoImageModalProps) {
  const [mode, setMode] = useState<'catalog_kps' | 'paste_list'>('catalog_kps');
  const [sourceScope, setSourceScope] = useState<'kps_first' | 'kps_only'>('kps_first');
  const [strictBarcodeOnly, setStrictBarcodeOnly] = useState(false);
  const [skipExistingPhotos, setSkipExistingPhotos] = useState(true);
  const [saveMissingBarcodes, setSaveMissingBarcodes] = useState(true);
  const [pasteInput, setPasteInput] = useState('');
  const [running, setRunning] = useState(false);
  const [loadingKpsIndex, setLoadingKpsIndex] = useState(false);
  const [kpsStatus, setKpsStatus] = useState<{
    totalProductsIndexed: number;
    totalPages: number;
  } | null>(null);
  const [kpsError, setKpsError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0, currentLabel: '' });
  const [results, setResults] = useState<ProcessedResultRow[]>([]);
  const [resultFilter, setResultFilter] = useState<'all' | 'saved' | 'not_found'>('all');
  const [revertingId, setRevertingId] = useState<string | null>(null);
  const cancelRef = useRef(false);

  // Build fast catalog lookup maps for matching pasted Barcode + Nama lists without duplicating products
  const catalogIndex = useMemo(() => {
    const byCode = new Map<string, Product>();
    const byExactName = new Map<string, Product>();
    for (const p of products) {
      for (const code of [
        ...normalizeBarcodeKey(p.barcode),
        ...normalizeBarcodeKey(p.sku),
      ]) {
        if (!byCode.has(code)) byCode.set(code, p);
      }
      const normName = normalizeLookupText(p.name);
      if (normName && !byExactName.has(normName)) {
        byExactName.set(normName, p);
      }
    }
    return { byCode, byExactName };
  }, [products]);

  const parsedPastedRows = useMemo<ParsedInputRow[]>(() => {
    if (mode !== 'paste_list' || !pasteInput.trim()) return [];
    const rawRows = parseBarcodeNameList(pasteInput);
    return rawRows.map((row) => {
      let matched: Product | null = null;
      for (const key of normalizeBarcodeKey(row.barcode)) {
        const hit = catalogIndex.byCode.get(key);
        if (hit) {
          matched = hit;
          break;
        }
      }
      if (!matched && row.name) {
        const norm = normalizeLookupText(row.name);
        if (norm) {
          matched = catalogIndex.byExactName.get(norm) || null;
        }
      }
      return {
        barcode: row.barcode,
        name: row.name,
        matchedProduct: matched,
      };
    });
  }, [mode, pasteInput, catalogIndex]);

  const catalogTargets = useMemo(() => {
    if (skipExistingPhotos) {
      return products.filter((p) => isProductNeedingImage(p.imageUrl));
    }
    return products;
  }, [products, skipExistingPhotos]);

  const stats = useMemo(() => {
    let saved = 0;
    let notFound = 0;
    let skippedHasPhoto = 0;
    let unmatchedCatalog = 0;
    for (const r of results) {
      if (r.status === 'saved') saved += 1;
      else if (r.status === 'not_found') notFound += 1;
      else if (r.status === 'skipped_has_photo') skippedHasPhoto += 1;
      else if (r.status === 'unmatched_catalog') unmatchedCatalog += 1;
    }
    return { saved, notFound, skippedHasPhoto, unmatchedCatalog };
  }, [results]);

  const filteredResults = useMemo(() => {
    if (resultFilter === 'saved') {
      return results.filter((r) => r.status === 'saved' || r.status === 'reverted');
    }
    if (resultFilter === 'not_found') {
      return results.filter(
        (r) => r.status === 'not_found' || r.status === 'unmatched_catalog'
      );
    }
    return results;
  }, [results, resultFilter]);

  if (!isOpen) return null;

  const warmKpsIndex = async (forceRefresh = false): Promise<boolean> => {
    setLoadingKpsIndex(true);
    setKpsError(null);
    try {
      const resp = await fetch(
        `/api/catalog/alpamartkps-status${forceRefresh ? '?refresh=1' : ''}`
      );
      const data = (await resp.json().catch(() => null)) as {
        ok?: boolean;
        totalProductsIndexed?: number;
        totalPages?: number;
        reason?: string;
      } | null;
      if (!resp.ok || !data?.ok) {
        setKpsError(data?.reason || 'Gagal menyambung ke katalog alpamartkps.store.');
        return false;
      }
      setKpsStatus({
        totalProductsIndexed: Number(data.totalProductsIndexed || 0),
        totalPages: Number(data.totalPages || 0),
      });
      return true;
    } catch {
      setKpsError('Koneksi ke server pencari foto terganggu. Coba ulangi.');
      return false;
    } finally {
      setLoadingKpsIndex(false);
    }
  };

  const handleFileUpload = async (file: File | null) => {
    if (!file) return;
    const text = await file.text();
    setPasteInput(text);
  };

  const handleStartAutoSync = async () => {
    if (running) return;
    cancelRef.current = false;
    setRunning(true);
    setResults([]);

    // Pre-load the 2,136-item alpamartkps.store index once before processing batch
    await warmKpsIndex(false);

    if (cancelRef.current) {
      setRunning(false);
      return;
    }

    type QueueItem = {
      key: string;
      product: Product | null;
      barcode: string;
      sku: string;
      name: string;
    };

    const queue: QueueItem[] =
      mode === 'catalog_kps'
        ? catalogTargets.map((p) => ({
            key: p.id,
            product: p,
            barcode: p.barcode || '',
            sku: p.sku || '',
            name: p.name,
          }))
        : parsedPastedRows.map((row, idx) => ({
            key: `${idx}-${row.barcode}-${row.name}`,
            product: row.matchedProduct,
            barcode: row.barcode || row.matchedProduct?.barcode || '',
            sku: row.matchedProduct?.sku || '',
            name: row.name || row.matchedProduct?.name || '',
          }));

    if (queue.length === 0) {
      setRunning(false);
      return;
    }

    setProgress({
      done: 0,
      total: queue.length,
      currentLabel: 'Mencocokkan seluruh produk dengan katalog alpamartkps.store...',
    });

    const initialResults: ProcessedResultRow[] = [];
    const eligibleItems: Array<{ queueIdx: number; item: QueueItem }> = [];
    const missingBarcodePatches: Array<{ productId: string; barcode: string }> = [];

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      if (!item.product) {
        initialResults.push({
          key: item.key,
          productId: null,
          productName: item.name || item.barcode,
          barcode: item.barcode,
          status: 'unmatched_catalog',
          reason: 'Belum ada di katalog ALPAMART TRIMULIA ONLAINE (tidak dibuat duplikat).',
        });
        continue;
      }

      if (skipExistingPhotos && !isProductNeedingImage(item.product.imageUrl)) {
        if (
          mode === 'paste_list' &&
          saveMissingBarcodes &&
          item.barcode &&
          !item.product.barcode
        ) {
          missingBarcodePatches.push({
            productId: item.product.id,
            barcode: item.barcode.slice(0, 80),
          });
        }
        initialResults.push({
          key: item.key,
          productId: item.product.id,
          productName: item.product.name,
          barcode: item.barcode || item.product.barcode || '',
          status: 'skipped_has_photo',
          imageUrl: item.product.imageUrl,
          reason: 'Sudah punya foto aktif (tidak ditimpa).',
        });
        continue;
      }

      eligibleItems.push({ queueIdx: i, item });
    }

    let savedTotal = 0;
    const processedResults: ProcessedResultRow[] = [...initialResults];
    const matchedEligibleIndices = new Set<number>();
    let permissionErrorSeen = false;

    // Stage 1: Ultra-Fast Batch Match against all 2,138 alpamartkps.store products in 1 request
    if (eligibleItems.length > 0 && !cancelRef.current) {
      try {
        const batchResp = await fetch('/api/catalog/alpamartkps-match-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            strictBarcodeOnly,
            items: eligibleItems.map(({ item }) => ({
              id: item.product!.id,
              barcode: item.barcode,
              sku: item.sku,
              name: item.name,
            })),
          }),
        });

        const batchData = (await batchResp.json().catch(() => null)) as {
          ok?: boolean;
          totalKpsIndexed?: number;
          totalPages?: number;
          matches?: Array<{
            index: number;
            id: string;
            imageUrl: string;
            matchedName: string;
            matchedBarcode: string;
            confidence: 'exact_barcode' | 'exact_kps_name' | 'verified_name';
            source: string;
          }>;
        } | null;

        if (batchResp.ok && batchData?.ok && Array.isArray(batchData.matches)) {
          if (batchData.totalKpsIndexed) {
            setKpsStatus({
              totalProductsIndexed: batchData.totalKpsIndexed,
              totalPages: batchData.totalPages || 0,
            });
          }

          const matchesToCommit = batchData.matches;
          const CHUNK_SIZE = 150;
          for (let start = 0; start < matchesToCommit.length; start += CHUNK_SIZE) {
            if (cancelRef.current) break;
            const chunk = matchesToCommit.slice(start, start + CHUNK_SIZE);
            setProgress({
              done: Math.min(queue.length, initialResults.length + start),
              total: queue.length,
              currentLabel: `Menyimpan batch foto KPS ${start + 1}–${Math.min(
                start + chunk.length,
                matchesToCommit.length
              )} dari ${matchesToCommit.length} ke database semua akun...`,
            });

            const batch = writeBatch(db);
            for (const m of chunk) {
              const target = eligibleItems[m.index];
              if (!target?.item.product) continue;
              const patch: Record<string, unknown> = {
                imageUrl: buildSafeProductImageUrl(m.imageUrl),
                updatedAt: serverTimestamp(),
              };
              if (
                mode === 'paste_list' &&
                saveMissingBarcodes &&
                target.item.barcode &&
                !target.item.product.barcode
              ) {
                patch.barcode = target.item.barcode.slice(0, 80);
              }
              batch.update(doc(db, 'products', target.item.product.id), patch);
            }

            try {
              await batch.commit();
              for (const m of chunk) {
                const target = eligibleItems[m.index];
                if (!target?.item.product) continue;
                matchedEligibleIndices.add(m.index);
                savedTotal += 1;
                processedResults.unshift({
                  key: target.item.key,
                  productId: target.item.product.id,
                  productName: target.item.product.name,
                  barcode: target.item.barcode || target.item.product.barcode || '',
                  status: 'saved',
                  imageUrl: m.imageUrl,
                  matchedName: m.matchedName,
                  source: m.source,
                  matchConfidence: m.confidence,
                });
              }
              setResults([...processedResults]);
            } catch (err: unknown) {
              const errText = err instanceof Error ? err.message : String(err || '');
              if (/permission|missing or insufficient/i.test(errText)) {
                permissionErrorSeen = true;
              }
              console.error('Batch KPS image commit failed:', errText);
              break;
            }
          }
        }
      } catch (err: unknown) {
        console.error('Batch KPS match request failed:', err);
      }
    }

    // Commit any missing barcodes from skipped rows in fast chunks
    if (missingBarcodePatches.length > 0 && !permissionErrorSeen && !cancelRef.current) {
      const CHUNK_SIZE = 150;
      for (let start = 0; start < missingBarcodePatches.length; start += CHUNK_SIZE) {
        const chunk = missingBarcodePatches.slice(start, start + CHUNK_SIZE);
        try {
          const batch = writeBatch(db);
          for (const p of chunk) {
            batch.update(doc(db, 'products', p.productId), {
              barcode: p.barcode,
              updatedAt: serverTimestamp(),
            });
          }
          await batch.commit();
        } catch {
          // non-fatal
        }
      }
    }

    // Stage 2: Optional OpenFoodFacts barcode fallback for remaining unmatched retail-barcode items
    const remainingItems = eligibleItems.filter((_, idx) => !matchedEligibleIndices.has(idx));
    const canRunGlobalFallback = sourceScope === 'kps_first' && !permissionErrorSeen;
    let rateLimited = false;

    for (let rIdx = 0; rIdx < remainingItems.length; rIdx++) {
      if (cancelRef.current) break;
      const { item } = remainingItems[rIdx];
      const prod = item.product!;
      const numericBarcode = (item.barcode || prod.barcode || '').replace(/[^0-9]/g, '');
      const hasRetailBarcode = numericBarcode.length >= 8 && numericBarcode.length <= 14;

      if (!canRunGlobalFallback || !hasRetailBarcode || rateLimited) {
        if (
          mode === 'paste_list' &&
          saveMissingBarcodes &&
          item.barcode &&
          !prod.barcode &&
          !permissionErrorSeen
        ) {
          try {
            await updateDoc(doc(db, 'products', prod.id), {
              barcode: item.barcode.slice(0, 80),
              updatedAt: serverTimestamp(),
            });
          } catch {
            // non-fatal
          }
        }
        processedResults.push({
          key: item.key,
          productId: prod.id,
          productName: prod.name,
          barcode: item.barcode || prod.barcode || '',
          status: 'not_found',
          reason: permissionErrorSeen
            ? 'Izin database ditolak: pastikan masuk menggunakan akun Master (tmalpamartt@gmail.com / Hananbintang30@gmail.com).'
            : 'Belum ada foto 100% cocok di alpamartkps.store (dilewati agar tidak salah gambar).',
        });
        continue;
      }

      setProgress({
        done: Math.min(queue.length, initialResults.length + matchedEligibleIndices.size + rIdx),
        total: queue.length,
        currentLabel: `Cek barcode global: ${prod.name} (${numericBarcode})`,
      });

      try {
        const resp = await fetch('/api/catalog/auto-fetch-product-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            barcode: numericBarcode,
            sku: item.sku,
            name: item.name,
            category: prod.category,
            strictBarcodeOnly: true,
            kpsOnly: false,
          }),
        });
        if (resp.status === 429) {
          rateLimited = true;
          processedResults.push({
            key: item.key,
            productId: prod.id,
            productName: prod.name,
            barcode: item.barcode || prod.barcode || '',
            status: 'not_found',
            reason: 'Batas pencarian barcode global tercapai; foto KPS sudah tersimpan.',
          });
          continue;
        }
        const data = (await resp.json().catch(() => null)) as {
          found?: boolean;
          imageUrl?: string;
          matchedName?: string;
          source?: string;
          matchConfidence?: 'exact_barcode' | 'exact_kps_name' | 'verified_name';
          reason?: string;
        } | null;

        if (resp.ok && data?.found && data.imageUrl) {
          const patch: Record<string, unknown> = {
            imageUrl: buildSafeProductImageUrl(data.imageUrl),
            updatedAt: serverTimestamp(),
          };
          if (mode === 'paste_list' && saveMissingBarcodes && item.barcode && !prod.barcode) {
            patch.barcode = item.barcode.slice(0, 80);
          }
          await updateDoc(doc(db, 'products', prod.id), patch);
          savedTotal += 1;
          processedResults.unshift({
            key: item.key,
            productId: prod.id,
            productName: prod.name,
            barcode: item.barcode || prod.barcode || '',
            status: 'saved',
            imageUrl: data.imageUrl,
            matchedName: data.matchedName,
            source: data.source,
            matchConfidence: data.matchConfidence,
          });
          setResults([...processedResults]);
        } else {
          processedResults.push({
            key: item.key,
            productId: prod.id,
            productName: prod.name,
            barcode: item.barcode || prod.barcode || '',
            status: 'not_found',
            reason:
              data?.reason ||
              'Belum ada foto yang 100% cocok (dilewati agar tidak salah gambar).',
          });
        }
      } catch {
        processedResults.push({
          key: item.key,
          productId: prod.id,
          productName: prod.name,
          barcode: item.barcode || prod.barcode || '',
          status: 'not_found',
          reason: 'Koneksi sempat terputus saat mengambil foto barcode global.',
        });
      }

      if (!cancelRef.current && rIdx < remainingItems.length - 1) {
        await new Promise((r) => window.setTimeout(r, 150));
      }
    }

    setResults([...processedResults]);
    setProgress({ done: queue.length, total: queue.length, currentLabel: 'Selesai' });
    setRunning(false);
    if (savedTotal > 0) {
      broadcastCrossTabEvent({ type: 'revision_broadcast', source: 'admin' });
      onNotify?.(
        `Berhasil menyalin ${savedTotal} foto produk akurat ke ALPAMART TRIMULIA ONLAINE (tampil langsung di semua akun & portal).`
      );
    }
  };

  const handleRevertProductImage = async (row: ProcessedResultRow) => {
    if (!row.productId || revertingId) return;
    setRevertingId(row.productId);
    try {
      await updateDoc(doc(db, 'products', row.productId), {
        imageUrl: PLACEHOLDER_PRODUCT_IMAGE_URL,
        updatedAt: serverTimestamp(),
      });
      broadcastCrossTabEvent({ type: 'revision_broadcast', source: 'admin' });
      setResults((prev) =>
        prev.map((item) =>
          item.key === row.key
            ? {
                ...item,
                status: 'reverted',
                reason: 'Foto dibatalkan & dikembalikan ke kosong untuk upload manual.',
              }
            : item
        )
      );
    } finally {
      setRevertingId(null);
    }
  };

  const queueCount =
    mode === 'catalog_kps' ? catalogTargets.length : parsedPastedRows.length;
  const matchedPastedCount = parsedPastedRows.filter((r) => Boolean(r.matchedProduct)).length;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6">
      <div className="bg-white border border-slate-200 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3 bg-slate-50">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-blue-700 text-white flex items-center justify-center shrink-0">
              <ImageIcon className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="font-display text-base sm:text-lg font-bold text-slate-900 truncate">
                Salin Gambar Produk Otomatis · AlpaMart KPS &amp; Barcode Akurat
              </h2>
              <p className="text-xs text-slate-600">
                Tarik foto langsung dari <span className="font-semibold text-blue-700">alpamartkps.store</span> berdasarkan Barcode &amp; Nama Produk (anti salah gambar).
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={running}
            onClick={onClose}
            aria-label="Tutup modal"
            className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-200 rounded-lg cursor-pointer disabled:opacity-40"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto space-y-5 flex-1">
          {/* AlpaMart KPS Live Connection Strip */}
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 text-xs text-blue-950">
              <Globe className="w-4 h-4 text-blue-700 shrink-0" />
              <div>
                <p className="font-semibold">
                  Sumber Utama: https://alpamartkps.store/
                  {kpsStatus
                    ? ` · ${kpsStatus.totalProductsIndexed.toLocaleString('id-ID')} foto produk siap disalin`
                    : ''}
                </p>
                <p className="text-blue-800">
                  Mencocokkan Barcode persis, Nama Produk persis, serta verifikasi merek &amp; rasa agar tidak pernah salah gambar.
                </p>
                {kpsError && <p className="text-rose-700 font-semibold mt-0.5">{kpsError}</p>}
              </div>
            </div>
            <button
              type="button"
              disabled={loadingKpsIndex || running}
              onClick={() => void warmKpsIndex(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-800 bg-white border border-blue-200 hover:bg-blue-100 rounded-lg cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingKpsIndex ? 'animate-spin' : ''}`} />
              <span>{loadingKpsIndex ? 'Memuat Katalog KPS...' : 'Muat Indeks KPS'}</span>
            </button>
          </div>

          {/* Mode Tabs */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <button
              type="button"
              disabled={running}
              onClick={() => setMode('catalog_kps')}
              className={`p-3.5 rounded-xl border text-left transition-colors cursor-pointer ${
                mode === 'catalog_kps'
                  ? 'border-blue-700 bg-blue-50/70'
                  : 'border-slate-200 bg-white hover:bg-slate-50'
              }`}
            >
              <div className="flex items-center gap-2 font-semibold text-sm text-slate-900">
                <Database className="w-4 h-4 text-blue-700" />
                <span>1. Salin ke Semua Produk Katalog Aktif</span>
              </div>
              <p className="text-xs text-slate-600 mt-1">
                Otomatis memeriksa {catalogTargets.length} produk di katalog Anda lalu menyalin foto cocok dari alpamartkps.store.
              </p>
            </button>

            <button
              type="button"
              disabled={running}
              onClick={() => setMode('paste_list')}
              className={`p-3.5 rounded-xl border text-left transition-colors cursor-pointer ${
                mode === 'paste_list'
                  ? 'border-blue-700 bg-blue-50/70'
                  : 'border-slate-200 bg-white hover:bg-slate-50'
              }`}
            >
              <div className="flex items-center gap-2 font-semibold text-sm text-slate-900">
                <FileSpreadsheet className="w-4 h-4 text-emerald-700" />
                <span>2. Tempel / Upload Daftar Barcode + Nama</span>
              </div>
              <p className="text-xs text-slate-600 mt-1">
                Tempel daftar Excel/TSV (<span className="font-mono">Barcode [TAB] Nama Produk</span>) untuk lengkapi barcode &amp; gambar sekaligus.
              </p>
            </button>
          </div>

          {/* Paste / Upload Box (Mode 2) */}
          {mode === 'paste_list' && (
            <div className="space-y-2.5 bg-slate-50 border border-slate-200 rounded-xl p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="text-xs font-semibold text-slate-800">
                  Tempel Daftar Barcode &amp; Nama Produk (atau pilih file .txt / .csv / .tsv)
                </label>
                <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg cursor-pointer">
                  <span>Pilih File</span>
                  <input
                    type="file"
                    accept=".txt,.csv,.tsv"
                    className="hidden"
                    disabled={running}
                    onChange={(e) => void handleFileUpload(e.target.files?.[0] || null)}
                  />
                </label>
              </div>
              <textarea
                rows={5}
                disabled={running}
                value={pasteInput}
                onChange={(e) => setPasteInput(e.target.value)}
                placeholder={'Contoh:\n8996001600207\tTEH PUCUK 500ML\n89686010947\tINDOMIE MI GORENG 85GR\n8999999002503\tBANGO KECAP MANIS 385ML'}
                className="w-full p-3 text-xs font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
              />
              {parsedPastedRows.length > 0 && (
                <p className="text-xs text-slate-700">
                  Terbaca <span className="font-bold">{parsedPastedRows.length}</span> baris ·{' '}
                  <span className="font-bold text-emerald-700">
                    {matchedPastedCount} cocok dengan produk katalog Anda
                  </span>{' '}
                  (item belum ada tidak dibuat duplikat).
                </p>
              )}
            </div>
          )}

          {/* Anti-Wrong-Image Accuracy Controls */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2 text-xs font-bold text-slate-900">
              <ShieldCheck className="w-4 h-4 text-emerald-700" />
              <span>Pengaturan Akurasi (Anti Salah Gambar)</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <label className="flex items-start gap-2.5 p-2.5 rounded-lg border border-slate-200 cursor-pointer hover:bg-slate-50">
                <input
                  type="radio"
                  name="sourceScope"
                  checked={sourceScope === 'kps_only'}
                  disabled={running}
                  onChange={() => setSourceScope('kps_only')}
                  className="mt-0.5"
                />
                <span>
                  <strong className="block text-slate-900">Khusus dari alpamartkps.store Saja</strong>
                  <span className="text-slate-600">
                    Hanya menyalin foto resmi dari katalog alpamartkps.store (paling cepat &amp; seragam).
                  </span>
                </span>
              </label>

              <label className="flex items-start gap-2.5 p-2.5 rounded-lg border border-slate-200 cursor-pointer hover:bg-slate-50">
                <input
                  type="radio"
                  name="sourceScope"
                  checked={sourceScope === 'kps_first'}
                  disabled={running}
                  onChange={() => setSourceScope('kps_first')}
                  className="mt-0.5"
                />
                <span>
                  <strong className="block text-slate-900">AlpaMart KPS Utama + Database Barcode</strong>
                  <span className="text-slate-600">
                    Ambil dari alpamartkps.store dulu, jika belum ada lanjut cari di database barcode global.
                  </span>
                </span>
              </label>
            </div>

            <div className="flex flex-wrap gap-4 pt-1 text-xs text-slate-700">
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={skipExistingPhotos}
                  disabled={running}
                  onChange={(e) => setSkipExistingPhotos(e.target.checked)}
                />
                <span>Jangan timpa produk yang sudah punya foto</span>
              </label>

              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={strictBarcodeOnly}
                  disabled={running}
                  onChange={(e) => setStrictBarcodeOnly(e.target.checked)}
                />
                <span>Hanya Barcode &amp; Nama Persis 100% (tanpa tebak kemiripan)</span>
              </label>

              {mode === 'paste_list' && (
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={saveMissingBarcodes}
                    disabled={running}
                    onChange={(e) => setSaveMissingBarcodes(e.target.checked)}
                  />
                  <span>Otomatis lengkapi kolom Barcode pada produk yang cocok</span>
                </label>
              )}
            </div>
          </div>

          {/* Action Bar & Live Progress */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-slate-600">
              Target diproses:{' '}
              <span className="font-mono font-bold text-slate-900">{queueCount}</span> item
            </div>
            <div className="flex items-center gap-2">
              {running ? (
                <button
                  type="button"
                  onClick={() => {
                    cancelRef.current = true;
                  }}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-lg cursor-pointer"
                >
                  <Square className="w-3.5 h-3.5" />
                  <span>Hentikan Proses</span>
                </button>
              ) : (
                <button
                  type="button"
                  disabled={queueCount === 0}
                  onClick={() => void handleStartAutoSync()}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg cursor-pointer disabled:opacity-50"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>Mulai Salin Foto Sekarang ({queueCount})</span>
                </button>
              )}
            </div>
          </div>

          {progress.total > 0 && (
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-slate-900 truncate max-w-md">
                  {running
                    ? `Memproses (${progress.done}/${progress.total}): ${progress.currentLabel}`
                    : `Selesai memeriksa ${progress.done} dari ${progress.total} item`}
                </span>
                <div className="flex items-center gap-3 font-mono text-[11px]">
                  <span className="font-semibold text-emerald-700">
                    Tersimpan: {stats.saved}
                  </span>
                  <span className="font-semibold text-slate-600">
                    Belum Ada: {stats.notFound}
                  </span>
                  {stats.skippedHasPhoto > 0 && (
                    <span className="text-blue-700">Sudah Ada: {stats.skippedHasPhoto}</span>
                  )}
                </div>
              </div>
              <progress
                max={Math.max(1, progress.total)}
                value={progress.done}
                className="w-full h-2 rounded-full overflow-hidden accent-blue-700"
              />
            </div>
          )}

          {/* Visual Verification Results */}
          {results.length > 0 && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-bold text-slate-900">
                  Hasil Verifikasi Visual (Klik Hapus jika ada foto yang ingin diganti manual)
                </p>
                <div className="flex items-center gap-1.5 text-xs">
                  {(
                    [
                      ['all', `Semua (${results.length})`],
                      ['saved', `Berhasil (${stats.saved})`],
                      ['not_found', `Belum Ada (${stats.notFound + stats.unmatchedCatalog})`],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setResultFilter(key)}
                      className={`px-2.5 py-1 rounded-md font-medium cursor-pointer ${
                        resultFilter === key
                          ? 'bg-blue-700 text-white'
                          : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="border border-slate-200 rounded-xl divide-y divide-slate-100 max-h-72 overflow-y-auto">
                {filteredResults.slice(0, 120).map((row) => (
                  <div
                    key={row.key}
                    className="p-3 flex items-center justify-between gap-3 hover:bg-slate-50"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-12 h-12 rounded-lg border border-slate-200 bg-white flex items-center justify-center overflow-hidden shrink-0">
                        {row.imageUrl && row.status !== 'reverted' ? (
                          <img
                            src={row.imageUrl}
                            alt={row.productName}
                            className="w-full h-full object-contain p-0.5"
                          />
                        ) : (
                          <ImageIcon className="w-5 h-5 text-slate-300" />
                        )}
                      </div>
                      <div className="min-w-0 space-y-0.5">
                        <p className="text-xs font-semibold text-slate-900 truncate">
                          {row.productName}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                          {row.barcode && (
                            <span className="font-mono text-slate-700">{row.barcode}</span>
                          )}
                          {row.status === 'saved' && (
                            <>
                              <span className="inline-flex items-center gap-1 font-semibold text-emerald-700">
                                <CheckCircle2 className="w-3 h-3" />
                                <span>
                                  {row.matchConfidence === 'exact_barcode'
                                    ? 'BARCODE PERSIS'
                                    : row.matchConfidence === 'exact_kps_name'
                                      ? 'NAMA PERSIS KPS'
                                      : 'NAMA TERVERIFIKASI'}
                                </span>
                              </span>
                              {row.matchedName && (
                                <span className="truncate max-w-xs text-slate-600">
                                  Cocok: {row.matchedName}
                                </span>
                              )}
                            </>
                          )}
                          {row.status !== 'saved' && row.reason && (
                            <span className="text-slate-500">{row.reason}</span>
                          )}
                        </div>
                      </div>
                    </div>

                    {row.status === 'saved' && row.productId && (
                      <button
                        type="button"
                        disabled={revertingId === row.productId}
                        onClick={() => void handleRevertProductImage(row)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg shrink-0 cursor-pointer disabled:opacity-50"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>Batalkan</span>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-between text-xs text-slate-600">
          <span>
            Foto yang tersimpan langsung ter-sinkron ke seluruh portal (Pelanggan, Admin, Delivery, Master).
          </span>
          <button
            type="button"
            disabled={running}
            onClick={onClose}
            className="px-4 py-1.5 font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg cursor-pointer disabled:opacity-40"
          >
            Tutup
          </button>
        </div>
      </div>
    </div>
  );
}

const KPS_ORIGIN = 'https://alpamartkps.store';
const KPS_USER_AGENT = 'AlpamartTrimuiaCatalog/1.2 (https://alpamart.trimuia.online)';
const KPS_PAGE_TIMEOUT_MS = 8_000;
const KPS_INDEX_TTL_MS = 60 * 60_000; // 1 hour cache
const KPS_MAX_PAGES = 140;
const KPS_CONCURRENCY = 8;

export interface AlpamartKpsCatalogEntry {
  code: string;
  normalizedCodes: string[];
  name: string;
  exactNormName: string;
  tokens: string[];
  sizes: string[];
  isBulkPack: boolean;
  imageUrl: string;
}

export interface AlpamartKpsCatalogIndex {
  fetchedAt: number;
  totalPages: number;
  entries: AlpamartKpsCatalogEntry[];
  byCode: Map<string, AlpamartKpsCatalogEntry>;
  byExactNormName: Map<string, AlpamartKpsCatalogEntry>;
}

export type KpsMatchConfidence = 'exact_barcode' | 'exact_kps_name' | 'verified_name';

export interface AlpamartKpsMatchResult {
  entry: AlpamartKpsCatalogEntry;
  confidence: KpsMatchConfidence;
  sourceLabel: string;
  matchedBarcode?: string;
}

let cachedIndex: AlpamartKpsCatalogIndex | null = null;
let inflightIndexPromise: Promise<AlpamartKpsCatalogIndex> | null = null;

function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeCodeVariants(raw?: string): string[] {
  if (!raw) return [];
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed) return [];

  const variants = new Set<string>();
  const compact = trimmed.replace(/\s+/g, '');
  if (compact.length >= 4) {
    variants.add(compact);
  }

  // Strip common POS/store prefixes (PCS, IND, ID, KH, BOX, SLOP, R, S, V, B)
  const withoutPrefix = compact.replace(
    /^(?:PCS|IND|KHS|BOX|SLOP|PKT|PCK|ID|KH|PR|ST|PK|R|S|V|B)[-_:]*/i,
    ''
  );
  if (withoutPrefix.length >= 5) {
    variants.add(withoutPrefix);
  }

  const digits = withoutPrefix.replace(/[^0-9]/g, '');
  if (digits.length >= 8 && digits.length <= 14) {
    variants.add(digits);
    const noLeadingZero = digits.replace(/^0+/, '');
    if (noLeadingZero.length >= 8) {
      variants.add(noLeadingZero);
    }
    if (digits.length === 11) {
      variants.add(`0${digits}`);
      variants.add(`00${digits}`);
    } else if (digits.length === 12) {
      variants.add(`0${digits}`);
    } else if (digits.length === 13 && digits.startsWith('0')) {
      variants.add(digits.slice(1));
    } else if (digits.length === 14 && digits.startsWith('0')) {
      variants.add(digits.slice(1));
    }
  }

  return Array.from(variants);
}

function normalizeExactName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/^\s*\d{1,5}\s*[-.:/]\s*/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const BULK_PACK_RE = /\b(box|dus|ctn|karton|slop|renceng|renteng|lusin|lsn|pak|pack|isi\s*\d+\s*pcs)\b/i;

function isBulkPackagingName(raw: string): boolean {
  return BULK_PACK_RE.test(raw);
}

function extractSizeTokens(raw: string): string[] {
  const sizes = new Set<string>();
  const matches = raw
    .toLowerCase()
    .matchAll(/\b(\d+(?:[.,]\d+)?)\s*(ml|l|ltr|liter|g|gr|gram|kg|mg|oz|s|m|l|xl|xxl|pcs|sachet|sct)\b/gi);
  for (const m of matches) {
    const num = m[1].replace(',', '.');
    let unit = m[2].toLowerCase();
    if (unit === 'gr' || unit === 'gram') unit = 'g';
    if (unit === 'ltr' || unit === 'liter') unit = 'l';
    if (unit === 'sct') unit = 'sachet';
    sizes.add(`${num}${unit}`);
  }
  return Array.from(sizes);
}

const KPS_NOISE_TOKENS = new Set<string>([
  'ls',
  'cmd',
  'ind',
  'kh',
  'khs',
  'tp',
  'tidak',
  'pakai',
  'pcs',
  'pc',
  'btl',
  'botol',
  'bks',
  'bungkus',
  'kaleng',
  'klg',
  'can',
  'cup',
  'pouch',
  'rasa',
  'dan',
  'and',
  'with',
  'the',
  'for',
  'isi',
  'new',
  'baru',
]);

function extractNameTokens(raw: string): string[] {
  const cleaned = raw
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/^\s*\d{1,5}\s*[-.:/]\s*/g, ' ')
    .replace(/\b\d+\s*(?:x|\*)\s*\d+\s*(?:ml|l|g|gr|kg|pcs|sachet)?\b/gi, ' ')
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:ml|l|ltr|liter|g|gr|gram|kg|oz|mg|pcs|pc|btl|botol|bks|sachet)\b/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return [];
  const out: string[] = [];
  for (const tok of cleaned.split(' ')) {
    if (tok.length < 2) continue;
    if (/^\d+$/.test(tok)) continue;
    if (KPS_NOISE_TOKENS.has(tok)) continue;
    if (!out.includes(tok)) out.push(tok);
  }
  return out;
}

const KPS_CONFLICT_GROUPS: Array<Record<string, string[]>> = [
  {
    goreng: ['goreng', 'fried', 'migoreng'],
    soto: ['soto'],
    kari: ['kari', 'curry'],
    ayambawang: ['ayam bawang'],
    kaldu: ['kaldu'],
    bakso: ['bakso', 'baso'],
    seblak: ['seblak'],
    tomyum: ['tomyum', 'tom yum'],
    laksa: ['laksa'],
    rendang: ['rendang'],
    aceh: ['aceh'],
    geprek: ['geprek'],
    rica: ['rica'],
    empal: ['empal'],
    rawon: ['rawon'],
    cakalang: ['cakalang'],
    kuah: ['kuah', 'rebus'],
  },
  {
    kecap: ['kecap', 'soy sauce', 'k/manis'],
    sambal: ['sambal', 'chili', 'chilli'],
    saustomat: ['saus tomat', 'tomato', 'ketchup'],
    saustiram: ['saus tiram', 'oyster'],
    teriyaki: ['teriyaki'],
    mayo: ['mayonais', 'mayonnaise', 'mayo'],
    cuka: ['cuka'],
  },
  {
    coklat: ['coklat', 'cokelat', 'chocolate', 'choco'],
    strawberry: ['strawberry', 'stroberi', 'stoberi'],
    vanilla: ['vanilla', 'vanila'],
    matcha: ['matcha', 'greentea', 'green tea', 'teh hijau'],
    taro: ['taro', 'talas'],
    melon: ['melon'],
    jeruk: ['jeruk', 'orange', 'yuzu'],
    lemon: ['lemon'],
    lime: ['lime', 'nipis'],
    apel: ['apel', 'apple'],
    mangga: ['mangga', 'mango'],
    anggur: ['anggur', 'grape'],
    leci: ['leci', 'lychee'],
    blueberry: ['blueberry', 'bluberi'],
    pisang: ['pisang', 'banana'],
    kelapa: ['kelapa', 'coconut', 'coco'],
    kopi: ['kopi', 'coffee', 'espresso', 'latte', 'cappuccino', 'mocca', 'moka'],
    pandan: ['pandan'],
    kacang: ['kacang', 'peanut'],
    almond: ['almond'],
    hazelnut: ['hazelnut'],
    caramel: ['caramel', 'karamel'],
    mint: ['mint', 'menthol'],
    madu: ['madu', 'honey'],
    jahe: ['jahe', 'ginger'],
    jasmine: ['jasmine', 'melati'],
    jambu: ['jambu', 'guava'],
    nanas: ['nanas', 'pineapple'],
    sirsak: ['sirsak'],
    keju: ['keju', 'cheese', 'cheddar'],
    balado: ['balado'],
    bbq: ['bbq', 'barbeque', 'barbecue'],
    seaweed: ['seaweed', 'rumput laut', 'nori'],
    jagung: ['jagung', 'corn'],
    sapi: ['sapi', 'beef'],
    ayam: ['ayam', 'chicken'],
    udang: ['udang', 'shrimp'],
    original: ['original', 'ori', 'classic', 'plain', 'tawar'],
  },
  {
    manis: ['manis', 'sweet'],
    pedas: ['pedas', 'spicy', 'hot', 'dower', 'cabe', 'cabai'],
    asin: ['asin', 'salted'],
  },
  {
    zero: ['zero', 'sugar free', 'no sugar', 'less sugar', 'tanpa gula'],
    fullcream: ['full cream', 'fullcream'],
    lowfat: ['low fat', 'lowfat', 'skim'],
  },
  {
    shampoo: ['shampoo', 'sampo'],
    conditioner: ['conditioner', 'kondisioner'],
    serum: ['serum'],
    toner: ['toner'],
    facialwash: ['facial wash', 'face wash', 'facial foam', 'sabun muka', 'cleanser'],
    micellar: ['micellar'],
    lotion: ['lotion'],
    bodywash: ['body wash', 'shower', 'sabun mandi'],
    scrub: ['scrub', 'lulur'],
    deodorant: ['roll on', 'roll-on', 'deodorant', 'deo'],
    spray: ['body mist', 'parfum', 'perfume', 'cologne'],
    sunscreen: ['sunscreen', 'sunblock'],
    daycream: ['day cream', 'siang'],
    nightcream: ['night cream', 'malam'],
    toothpaste: ['pasta gigi', 'toothpaste'],
    toothbrush: ['sikat gigi', 'toothbrush'],
    mouthwash: ['mouthwash'],
  },
  {
    men: ['men', 'pria'],
    women: ['women', 'wanita'],
    baby: ['baby', 'bayi'],
    kids: ['kids', 'anak'],
  },
];

function hasKpsVariantConflict(queryRaw: string, candidateRaw: string): boolean {
  const pad = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9/]+/g, ' ').trim()} `;
  const qPad = pad(queryRaw);
  const cPad = pad(candidateRaw);

  for (let i = 0; i < KPS_CONFLICT_GROUPS.length; i++) {
    const group = KPS_CONFLICT_GROUPS[i];
    const qHits = new Set<string>();
    const cHits = new Set<string>();
    for (const [key, terms] of Object.entries(group)) {
      if (terms.some((t) => qPad.includes(` ${t} `))) qHits.add(key);
      if (terms.some((t) => cPad.includes(` ${t} `))) cHits.add(key);
    }
    if (qHits.size > 0 && cHits.size > 0) {
      let shared = false;
      for (const k of qHits) {
        if (cHits.has(k)) {
          shared = true;
          break;
        }
      }
      if (!shared) return true;
    } else if (qHits.size > 0 && cHits.size === 0 && i <= 5) {
      if (!(qHits.size === 1 && qHits.has('original'))) return true;
    } else if (i === 4 && qHits.has('zero') !== cHits.has('zero')) {
      return true;
    }
  }
  return false;
}

function parseKpsHtmlEntries(html: string): {
  entries: AlpamartKpsCatalogEntry[];
  maxPage: number;
} {
  const entries: AlpamartKpsCatalogEntry[] = [];
  const seenImages = new Set<string>();

  const imgRegex = /<img\s+[^>]*src="(\/uploads\/p\/([^"]+))"[^>]*alt="([^"]*)"[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = imgRegex.exec(html)) !== null) {
    const relSrc = match[1];
    const filename = match[2];
    const rawAlt = decodeHtmlEntities(match[3] || '');
    if (!relSrc || !filename || seenImages.has(relSrc)) continue;
    seenImages.add(relSrc);

    // Extract code from filename like "8996001600207-1795177053.jpg" or "MIESEDUH10947-1795595419.jpg"
    const baseNoExt = filename.replace(/\.[a-z0-9]+$/i, '');
    const code = baseNoExt.replace(/-\d{8,}$/, '').trim();
    const fullImageUrl = `${KPS_ORIGIN}${relSrc}`;
    const exactNormName = normalizeExactName(rawAlt);

    entries.push({
      code,
      normalizedCodes: normalizeCodeVariants(code),
      name: rawAlt || code,
      exactNormName,
      tokens: extractNameTokens(rawAlt),
      sizes: extractSizeTokens(rawAlt),
      isBulkPack: isBulkPackagingName(rawAlt),
      imageUrl: fullImageUrl,
    });
  }

  let maxPage = 1;
  const pageRegex = /href="\/\?[^"]*page=(\d+)/gi;
  let pm: RegExpExecArray | null;
  while ((pm = pageRegex.exec(html)) !== null) {
    const num = Number(pm[1]);
    if (Number.isInteger(num) && num > maxPage && num <= KPS_MAX_PAGES) {
      maxPage = num;
    }
  }

  return { entries, maxPage };
}

async function fetchKpsHtml(pathWithQuery: string): Promise<string | null> {
  const url = `${KPS_ORIGIN}${pathWithQuery}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KPS_PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': KPS_USER_AGENT,
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function buildAlpamartKpsIndex(): Promise<AlpamartKpsCatalogIndex> {
  const firstHtml = await fetchKpsHtml('/?lang=id&page=1');
  if (!firstHtml) {
    return {
      fetchedAt: Date.now(),
      totalPages: 0,
      entries: [],
      byCode: new Map(),
      byExactNormName: new Map(),
    };
  }

  const firstParsed = parseKpsHtmlEntries(firstHtml);
  const totalPages = Math.min(Math.max(1, firstParsed.maxPage), KPS_MAX_PAGES);

  const allEntries: AlpamartKpsCatalogEntry[] = [...firstParsed.entries];
  const remainingPages: number[] = [];
  for (let p = 2; p <= totalPages; p++) {
    remainingPages.push(p);
  }

  // Fetch remaining pages in polite parallel batches
  for (let i = 0; i < remainingPages.length; i += KPS_CONCURRENCY) {
    const batch = remainingPages.slice(i, i + KPS_CONCURRENCY);
    const htmlList = await Promise.all(
      batch.map((p) => fetchKpsHtml(`/?lang=id&page=${p}`))
    );
    for (const html of htmlList) {
      if (!html) continue;
      const parsed = parseKpsHtmlEntries(html);
      allEntries.push(...parsed.entries);
    }
  }

  // Deduplicate and build fast O(1) lookup tables
  const uniqueByImage = new Map<string, AlpamartKpsCatalogEntry>();
  const byCode = new Map<string, AlpamartKpsCatalogEntry>();
  const byExactNormName = new Map<string, AlpamartKpsCatalogEntry>();

  for (const entry of allEntries) {
    if (!uniqueByImage.has(entry.imageUrl)) {
      uniqueByImage.set(entry.imageUrl, entry);
    }
    for (const variant of entry.normalizedCodes) {
      if (!byCode.has(variant)) {
        byCode.set(variant, entry);
      }
    }
    if (entry.exactNormName && !byExactNormName.has(entry.exactNormName)) {
      byExactNormName.set(entry.exactNormName, entry);
    }
  }

  return {
    fetchedAt: Date.now(),
    totalPages,
    entries: Array.from(uniqueByImage.values()),
    byCode,
    byExactNormName,
  };
}

/**
 * Returns the cached in-memory catalog index of `https://alpamartkps.store/`
 * (auto-refreshes every 60 minutes, deduplicates concurrent builds).
 */
export async function getAlpamartKpsCatalogIndex(
  forceRefresh = false
): Promise<AlpamartKpsCatalogIndex> {
  const now = Date.now();
  if (!forceRefresh && cachedIndex && now - cachedIndex.fetchedAt < KPS_INDEX_TTL_MS && cachedIndex.entries.length > 0) {
    return cachedIndex;
  }

  if (!inflightIndexPromise) {
    inflightIndexPromise = buildAlpamartKpsIndex()
      .then((idx) => {
        if (idx.entries.length > 0) {
          cachedIndex = idx;
        }
        return idx;
      })
      .finally(() => {
        inflightIndexPromise = null;
      });
  }

  return inflightIndexPromise;
}

/**
 * Strictly matches a product against the `https://alpamartkps.store/` catalog index:
 * 1. Exact Barcode / SKU match (handles leading zeros and store prefixes like PCS/IND/ID/R/S/V)
 * 2. Exact normalized name match (identical product title on AlpaMart KPS)
 * 3. Strict brand + variant + packaging + size-aware name match (only when !strictBarcodeOnly)
 */
export function matchProductInAlpamartKpsIndex(
  index: AlpamartKpsCatalogIndex,
  query: {
    barcode?: string;
    sku?: string;
    name?: string;
    strictBarcodeOnly?: boolean;
  }
): AlpamartKpsMatchResult | null {
  if (!index || index.entries.length === 0) return null;

  const rawBarcode = (query.barcode || '').trim();
  const rawSku = (query.sku || '').trim();
  const rawName = (query.name || '').trim();

  // Stage 1: Exact Barcode / SKU Match
  const codeCandidates = [
    ...normalizeCodeVariants(rawBarcode),
    ...normalizeCodeVariants(rawSku),
  ];
  for (const code of codeCandidates) {
    const hit = index.byCode.get(code);
    if (hit) {
      return {
        entry: hit,
        confidence: 'exact_barcode',
        sourceLabel: 'AlpaMart KPS (Barcode Persis)',
        matchedBarcode: hit.code,
      };
    }
  }

  if (!rawName || rawName.length < 2) return null;

  // Stage 2: Exact Normalized Name Match (e.g. "TEH PUCUK 500ML" === "TEH PUCUK 500ML")
  const exactNorm = normalizeExactName(rawName);
  if (exactNorm.length >= 3) {
    const exactHit = index.byExactNormName.get(exactNorm);
    if (exactHit) {
      return {
        entry: exactHit,
        confidence: 'exact_kps_name',
        sourceLabel: 'AlpaMart KPS (Nama Persis)',
        matchedBarcode: exactHit.code,
      };
    }
  }

  if (query.strictBarcodeOnly) {
    return null;
  }

  // Stage 3: Strict Brand + Variant + Packaging + Size-Aware Name Match
  const qTokens = extractNameTokens(rawName);
  if (qTokens.length < 2) return null;

  const qSizes = extractSizeTokens(rawName);
  const qBulk = isBulkPackagingName(rawName);

  let best: { score: number; entry: AlpamartKpsCatalogEntry } | null = null;

  for (const entry of index.entries) {
    if (entry.tokens.length < 2) continue;

    // Never confuse single pack with BOX/DUS/SLOP carton packaging
    if (qBulk !== entry.isBulkPack) continue;

    // Lead/brand token must match
    const cTokenSet = new Set(entry.tokens);
    const hasLeadToken =
      cTokenSet.has(qTokens[0]) ||
      entry.tokens.some(
        (t) =>
          qTokens[0].length >= 4 &&
          (t.startsWith(qTokens[0]) || qTokens[0].startsWith(t))
      );
    if (!hasLeadToken) continue;

    // Zero flavor/variant/product-type conflict
    if (hasKpsVariantConflict(rawName, entry.name)) continue;

    // Compute bidirectional token overlap (precision & recall)
    let qMatched = 0;
    for (const qt of qTokens) {
      if (
        cTokenSet.has(qt) ||
        (qt.length >= 4 && entry.tokens.some((ct) => ct.startsWith(qt) || qt.startsWith(ct)))
      ) {
        qMatched += 1;
      }
    }
    const qCoverage = qMatched / qTokens.length;
    if (qCoverage < 0.78) continue;

    const qTokenSet = new Set(qTokens);
    let cMatched = 0;
    for (const ct of entry.tokens) {
      if (
        qTokenSet.has(ct) ||
        (ct.length >= 4 && qTokens.some((qt) => qt.startsWith(ct) || ct.startsWith(qt)))
      ) {
        cMatched += 1;
      }
    }
    const cCoverage = cMatched / entry.tokens.length;
    if (cCoverage < 0.65) continue;

    // Size check: if both specify sizes and none match, penalize/reject unless exact tokens match 100%
    let sizeBonus = 0;
    if (qSizes.length > 0 && entry.sizes.length > 0) {
      const sameSize = qSizes.some((s) => entry.sizes.includes(s));
      if (sameSize) {
        sizeBonus = 0.15;
      } else {
        // Different sizes (e.g. 500ml vs 1500ml or 69gr vs 129gr) -> only allow if 100% identical tokens, else skip
        if (qCoverage < 1.0 || cCoverage < 0.85) continue;
        sizeBonus = -0.1;
      }
    }

    // Strict numeric range/size guard (e.g. "SIZE 42-43" must never match "SIZE 40-41" or "NO 2" vs "NO 3")
    const qRangeNums = rawName.toLowerCase().match(/\b\d{1,3}\s*[-/]\s*\d{1,3}\b/g);
    const cRangeNums = entry.name.toLowerCase().match(/\b\d{1,3}\s*[-/]\s*\d{1,3}\b/g);
    if (qRangeNums && cRangeNums) {
      const normQ = qRangeNums.map((s) => s.replace(/\s+/g, ''));
      const normC = cRangeNums.map((s) => s.replace(/\s+/g, ''));
      if (!normQ.some((r) => normC.includes(r))) continue;
    }

    const totalScore = qCoverage * 0.6 + cCoverage * 0.4 + sizeBonus;
    if (totalScore < 0.78) continue;

    if (!best || totalScore > best.score) {
      best = { score: totalScore, entry };
    }
  }

  if (!best) return null;

  return {
    entry: best.entry,
    confidence: 'verified_name',
    sourceLabel: 'AlpaMart KPS (Nama Terverifikasi)',
    matchedBarcode: best.entry.code,
  };
}

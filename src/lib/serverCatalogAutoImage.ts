import {
  DEFAULT_DISPLAY_BOX_SIZE,
  optimizeProductImageForDisplayBox,
} from './serverProductImageOptimizer.ts';
import {
  getAlpamartKpsCatalogIndex,
  matchProductInAlpamartKpsIndex,
} from './serverAlpamartKpsImageSync.ts';

const LOOKUP_TIMEOUT_MS = 6_500;
const USER_AGENT = 'AlpamartTrimuiaCatalog/1.2 (https://alpamart.trimuia.online)';
const CACHE_TTL_MS = 30 * 60_000;
const MAX_CACHE_ENTRIES = 2_000;

const ALLOWED_IMAGE_HOSTS = new Set<string>([
  'alpamartkps.store',
  'images.openfoodfacts.org',
  'images.openbeautyfacts.org',
  'images.openproductsfacts.org',
  'static.openfoodfacts.org',
  'static.openbeautyfacts.org',
  'static.openproductsfacts.org',
]);

interface OpenFactsProductRecord {
  code?: string;
  product_name?: string;
  product_name_id?: string;
  product_name_en?: string;
  brands?: string;
  image_front_url?: string;
  image_url?: string;
  image_front_small_url?: string;
}

export type ImageMatchConfidence = 'exact_barcode' | 'exact_kps_name' | 'verified_name';

interface CandidateMatch {
  imageUrl: string;
  matchedName: string;
  source: string;
  confidence: ImageMatchConfidence;
  matchedBarcode?: string;
}

export interface AutoFetchProductImageInput {
  barcode?: string;
  sku?: string;
  name?: string;
  category?: string;
  /**
   * When true, only exact retail barcode matches are accepted (100% anti-wrong-image mode).
   * When false (default), falls back to strict brand + variant verified name matching.
   */
  strictBarcodeOnly?: boolean;
  /**
   * When true, only searches https://alpamartkps.store/ (AlpaMart KPS catalog) and skips OpenFoodFacts.
   */
  kpsOnly?: boolean;
}

export type AutoFetchProductImageOutcome =
  | {
      ok: true;
      found: true;
      imageUrl: string;
      source: string;
      matchedName: string;
      matchedBarcode?: string;
      matchConfidence: ImageMatchConfidence;
      sizeKb: number;
    }
  | {
      ok: true;
      found: false;
      reason: string;
    };

interface BarcodeCandidate {
  code: string;
  isExact: boolean;
}

interface CacheEntry {
  expiresAt: number;
  outcome: AutoFetchProductImageOutcome;
}

const lookupCache = new Map<string, CacheEntry>();

function readCache(key: string): AutoFetchProductImageOutcome | null {
  const entry = lookupCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    lookupCache.delete(key);
    return null;
  }
  return entry.outcome;
}

function writeCache(key: string, outcome: AutoFetchProductImageOutcome): void {
  if (lookupCache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = lookupCache.keys().next().value;
    if (firstKey) lookupCache.delete(firstKey);
  }
  lookupCache.set(key, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    outcome,
  });
}

function cleanShort(val: unknown, maxLen: number): string {
  if (typeof val !== 'string') return '';
  return val.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

/**
 * Builds retail EAN/UPC barcode lookup candidates while strictly ignoring short
 * store-internal codes (like `607`, `1112`, `74253`, `NB015`) that would collide
 * with unrelated products in global barcode databases.
 */
export function buildRetailBarcodeCandidates(
  barcode?: string,
  sku?: string
): BarcodeCandidate[] {
  const seen = new Set<string>();
  const candidates: BarcodeCandidate[] = [];

  const pushCandidate = (code: string, isExact: boolean) => {
    if (!/^\d{8,14}$/.test(code)) return;
    if (seen.has(code)) return;
    seen.add(code);
    candidates.push({ code, isExact });
  };

  const inspectRaw = (raw?: string) => {
    if (!raw) return;
    const trimmed = raw.trim().toUpperCase();
    if (!trimmed) return;

    // Strip common POS/store prefixes (PCS885..., IND899..., ID899..., KH..., R893..., S899..., V899..., B899...)
    const withoutPrefix = trimmed.replace(
      /^(?:PCS|IND|KHS|BOX|SLOP|PKT|PCK|ID|KH|PR|ST|PK|R|S|V|B)[-_:\s]*/i,
      ''
    );

    const digits = withoutPrefix.replace(/[^0-9]/g, '');
    const hadPrefix = withoutPrefix !== trimmed;

    // Only accept genuine retail barcode lengths:
    // - 8 digits (EAN-8)
    // - 11 digits (UPC/EAN stripped of 1-2 leading zeros, e.g. Indofood 89686010947 -> 0089686010947 / 089686010947)
    // - 12 digits (UPC-A / EAN-13 missing leading zero, e.g. 711844110052 -> 0711844110052)
    // - 13 digits (standard EAN-13, e.g. 8996001600207)
    // - 14 digits (GTIN-14 carton/case)
    if (digits.length === 13) {
      pushCandidate(digits, !hadPrefix);
      return;
    }

    if (digits.length === 12) {
      pushCandidate(`0${digits}`, !hadPrefix);
      pushCandidate(digits, !hadPrefix);
      return;
    }

    if (digits.length === 11) {
      pushCandidate(`00${digits}`, false);
      pushCandidate(`0${digits}`, false);
      pushCandidate(digits, false);
      return;
    }

    if (digits.length === 8) {
      pushCandidate(digits, !hadPrefix);
      return;
    }

    if (digits.length === 14) {
      pushCandidate(digits, !hadPrefix);
      if (digits.startsWith('0')) {
        pushCandidate(digits.slice(1), !hadPrefix);
      }
    }
  };

  inspectRaw(barcode);
  inspectRaw(sku);

  return candidates;
}

function isAllowedCandidateImageUrl(rawUrl: unknown): rawUrl is string {
  if (typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();
  if (!trimmed.startsWith('https://')) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    if (parsed.port && parsed.port !== '443') return false;
    return ALLOWED_IMAGE_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function pickBestRecordImage(rec?: OpenFactsProductRecord | null): string | null {
  if (!rec) return null;
  const candidates = [rec.image_front_url, rec.image_url, rec.image_front_small_url];
  for (const url of candidates) {
    if (isAllowedCandidateImageUrl(url)) {
      return url.trim();
    }
  }
  return null;
}

// Items that are local/fresh/hardware/voucher/clothing and should NEVER use grocery name-search fallback
const NON_DATABASE_PRODUCT_PATTERNS = [
  /\b(voucher|pulsa|metfone|cellcard|smart\s*\$|topup|top\s*up|kartu\s*perdana|simcard)\b/i,
  /\b(tshirt|t-shirt|kaos|baju|celana|sandal|sepatu|topi|jas\s*hujan|payung|tas\s*belanja)\b/i,
  /\b(hook\s*rack|hanger|gantungan|sapu|pel\s*lantai|ember|gayung|baskom|keranjang|rak\s*\d|jemuran|keset)\b/i,
  /\b(piring|mangkok|mangkuk|gelas\s*kaca|sendok|garpu|pisau\s*dapur|gunting|talenan|wajan|panci|kompor|gas\s*kaleng)\b/i,
  /\b(kupas|potong|timbang|curah|eceran|kiloan|bolen|kue\s*basah|gorengan|nasi\s*kotak|ayam\s*potong|daging\s*segar|ikan\s*segar|sayur\s*segar)\b/i,
  /\b(plastik\s*kresek|kantong\s*plastik|kardus|lakban|tali\s*rafia|baterai\s*jam|lampu\s*led|kabel\s*data|charger|headset|earphone|korek\s*api|gas\s*korek)\b/i,
];

function isNonDatabaseLocalItem(rawName: string): boolean {
  return NON_DATABASE_PRODUCT_PATTERNS.some((re) => re.test(rawName));
}

const NOISE_TOKENS = new Set<string>([
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
  'pack',
  'pak',
  'box',
  'slop',
  'renceng',
  'renteng',
  'sachet',
  'sct',
  'btl',
  'botol',
  'bks',
  'bungkus',
  'ctn',
  'dus',
  'karton',
  'lsn',
  'lusin',
  'kaleng',
  'klg',
  'can',
  'cup',
  'pouch',
  'refill',
  'refile',
  'isi',
  'promo',
  'combo',
  'free',
  'gratis',
  'diskon',
  'baru',
  'new',
  'murah',
  'besar',
  'kecil',
  'sedang',
  'mini',
  'jumbo',
  'family',
  'ekonomis',
  'special',
  'spesial',
  'import',
  'lokal',
  'rasa',
  'flavour',
  'flavor',
  'with',
  'and',
  'dan',
  'the',
  'for',
  'all',
  'in',
  'of',
  'to',
]);

// Mutually exclusive variant/flavor/type groups to prevent wrong product photos
const CONFLICT_GROUPS: Array<Record<string, string[]>> = [
  // Noodle/soup styles
  {
    goreng: ['goreng', 'fried', 'migoreng'],
    soto: ['soto'],
    kari: ['kari', 'curry'],
    ayambawang: ['ayam bawang', 'bawang'],
    kaldu: ['kaldu'],
    bakso: ['bakso', 'baso'],
    seblak: ['seblak'],
    tomyum: ['tomyum', 'tom yum'],
    laksa: ['laksa'],
    rendang: ['rendang'],
    aceh: ['aceh'],
    geprek: ['geprek'],
    empal: ['empal'],
    rawon: ['rawon'],
    cakalang: ['cakalang'],
    kuah: ['kuah', 'soup', 'rebus'],
  },
  // Condiments & sauces
  {
    kecap: ['kecap', 'soy sauce', 'k/manis'],
    sambal: ['sambal', 'chili sauce', 'chilli sauce'],
    saustomat: ['saus tomat', 'tomato sauce', 'ketchup'],
    saustiram: ['saus tiram', 'oyster'],
    teriyaki: ['teriyaki'],
    mayo: ['mayonais', 'mayonnaise', 'mayo'],
    cuka: ['cuka', 'vinegar'],
  },
  // Sweet & drink flavors
  {
    coklat: ['coklat', 'cokelat', 'chocolate', 'choco', 'cocoa', 'cacao'],
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
    leci: ['leci', 'lychee', 'litchi'],
    blueberry: ['blueberry', 'bluberi'],
    pisang: ['pisang', 'banana'],
    kelapa: ['kelapa', 'coconut', 'coco'],
    kopi: ['kopi', 'coffee', 'espresso', 'latte', 'cappuccino', 'mocca', 'moka', 'americano'],
    pandan: ['pandan'],
    kacang: ['kacang', 'peanut'],
    almond: ['almond'],
    hazelnut: ['hazelnut'],
    caramel: ['caramel', 'karamel'],
    mint: ['mint', 'menthol', 'peppermint'],
    madu: ['madu', 'honey'],
    jahe: ['jahe', 'ginger'],
    jasmine: ['jasmine', 'melati'],
    blackcurrant: ['blackcurrant', 'currant'],
    jambu: ['jambu', 'guava'],
    nanas: ['nanas', 'pineapple'],
    sirsak: ['sirsak', 'soursop'],
    markisa: ['markisa', 'passion'],
    kurma: ['kurma', 'dates'],
    tiramisu: ['tiramisu'],
    redvelvet: ['red velvet', 'redvelvet'],
    keju: ['keju', 'cheese', 'cheddar'],
    balado: ['balado'],
    bbq: ['bbq', 'barbeque', 'barbecue'],
    seaweed: ['seaweed', 'rumput laut', 'nori'],
    jagung: ['jagung', 'corn'],
    sapi: ['sapi', 'beef'],
    ayam: ['ayam', 'chicken'],
    udang: ['udang', 'shrimp', 'prawn'],
    original: ['original', 'ori', 'classic', 'klasik', 'plain', 'tawar'],
  },
  // Taste intensity
  {
    manis: ['manis', 'sweet'],
    pedas: ['pedas', 'spicy', 'hot', 'extra pedas', 'cabai', 'cabe', 'chili', 'chilli'],
    asin: ['asin', 'salted', 'salty'],
  },
  // Sugar / diet variants
  {
    zero: ['zero', 'sugar free', 'no sugar', 'tanpa gula', 'less sugar', 'low sugar', 'diet'],
    fullcream: ['full cream', 'fullcream'],
    lowfat: ['low fat', 'lowfat', 'skim'],
  },
  // Personal care & household product types
  {
    shampoo: ['shampoo', 'sampo'],
    conditioner: ['conditioner', 'kondisioner'],
    hairmask: ['hair mask', 'creambath'],
    serum: ['serum'],
    toner: ['toner'],
    facialwash: ['facial wash', 'face wash', 'facial foam', 'sabun muka', 'cleanser'],
    micellar: ['micellar'],
    lotion: ['lotion', 'body cream'],
    bodywash: ['body wash', 'shower', 'sabun mandi', 'bath soap'],
    scrub: ['scrub', 'lulur'],
    deodorant: ['roll on', 'roll-on', 'deodorant', 'deo'],
    spray: ['body mist', 'parfum', 'perfume', 'cologne', 'eau de'],
    sunscreen: ['sunscreen', 'sunblock', 'spf'],
    daycream: ['day cream', 'siang'],
    nightcream: ['night cream', 'malam'],
    toothpaste: ['pasta gigi', 'toothpaste', 'odol'],
    toothbrush: ['sikat gigi', 'toothbrush'],
    mouthwash: ['mouthwash', 'obat kumur'],
  },
  // Target demographic
  {
    men: ['men', 'pria', 'for men', 'male'],
    women: ['women', 'wanita', 'for women', 'female'],
    baby: ['baby', 'bayi', 'infant', 'newborn'],
    kids: ['kids', 'anak', 'junior'],
  },
];

function normalizeForTokens(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\b\d+\s*(?:x|\*)\s*\d+\s*(?:ml|l|ltr|g|gr|gram|kg|pcs|pack|btl|sachet)?\b/gi, ' ')
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:ml|l|ltr|liter|g|gr|gram|kg|oz|mg|cm|mm|pcs|pc|pack|box|btl|botol|dus|ctn|renteng|renceng|bks|sachet|slop|lsn)\b/gi, ' ')
    .replace(/^\s*\d{1,5}\s*[-.:/]\s*/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMeaningfulTokens(raw: string): string[] {
  const norm = normalizeForTokens(raw);
  if (!norm) return [];
  const rawTokens = norm.split(' ');
  const out: string[] = [];
  for (const tok of rawTokens) {
    if (tok.length < 2) continue;
    if (/^\d+$/.test(tok)) continue;
    if (NOISE_TOKENS.has(tok)) continue;
    if (!out.includes(tok)) {
      out.push(tok);
    }
  }
  return out;
}

function detectConflictKeys(text: string): Array<Set<string>> {
  const padded = ` ${text.toLowerCase().replace(/[^a-z0-9/]+/g, ' ').trim()} `;
  return CONFLICT_GROUPS.map((group) => {
    const matched = new Set<string>();
    for (const [key, terms] of Object.entries(group)) {
      for (const term of terms) {
        if (padded.includes(` ${term} `)) {
          matched.add(key);
          break;
        }
      }
    }
    return matched;
  });
}

/**
 * Returns true if query and candidate explicitly disagree on a flavor, variant,
 * sauce/noodle type, personal care product type, or demographic.
 */
function hasVariantOrTypeConflict(queryText: string, candidateText: string): boolean {
  const qGroups = detectConflictKeys(queryText);
  const cGroups = detectConflictKeys(candidateText);

  for (let i = 0; i < CONFLICT_GROUPS.length; i++) {
    const qSet = qGroups[i];
    const cSet = cGroups[i];
    if (qSet.size === 0) continue;

    // If query explicitly specifies a variant in this group:
    // 1. If candidate specifies a DIFFERENT variant in the same group without sharing any of query's variants -> CONFLICT!
    if (cSet.size > 0) {
      let hasShared = false;
      for (const k of qSet) {
        if (cSet.has(k)) {
          hasShared = true;
          break;
        }
      }
      if (!hasShared) return true;
    } else {
      // For noodle/sauce/flavor/personal-care groups, if query specifies a specific flavor
      // (not "original") and candidate has no variant label at all, reject to avoid showing generic/wrong flavor.
      if (i <= 5) {
        const onlyOriginal = qSet.size === 1 && qSet.has('original');
        if (!onlyOriginal) return true;
      }
    }
  }

  // Also reject if query did NOT ask for a specific diet/zero/spicy/flavor variant that dominates the candidate
  // e.g. Query "COCA COLA" vs Candidate "Coca Cola Zero Sugar"
  const qZero = qGroups[4].has('zero');
  const cZero = cGroups[4].has('zero');
  if (qZero !== cZero) return true;

  return false;
}

function buildSearchQueriesFromName(rawName: string): string[] {
  const tokens = extractMeaningfulTokens(rawName);
  if (tokens.length < 2) return [];

  const fullQuery = tokens.slice(0, 5).join(' ');
  const queries: string[] = [fullQuery];

  if (tokens.length >= 4) {
    const coreQuery = tokens.slice(0, 3).join(' ');
    if (coreQuery !== fullQuery) {
      queries.push(coreQuery);
    }
  }

  return queries.slice(0, 2);
}

function buildCandidateHaystack(record: OpenFactsProductRecord): string {
  return [
    record.product_name_id || '',
    record.product_name || '',
    record.product_name_en || '',
    record.brands || '',
  ]
    .join(' ')
    .trim();
}

function scoreStrictNameMatch(
  rawQueryName: string,
  queryTokens: string[],
  record: OpenFactsProductRecord
): number {
  if (queryTokens.length < 2) return 0;

  const haystackRaw = buildCandidateHaystack(record);
  if (!haystackRaw) return 0;

  // Hard guard 1: Never allow flavor/variant/product-type conflict
  if (hasVariantOrTypeConflict(rawQueryName, haystackRaw)) {
    return 0;
  }

  const haystackNorm = ` ${normalizeForTokens(haystackRaw)} `;
  const haystackTokens = new Set(extractMeaningfulTokens(haystackRaw));

  const tokenMatches = (tok: string): boolean => {
    if (haystackTokens.has(tok)) return true;
    if (tok.length >= 4 && haystackNorm.includes(` ${tok}`)) return true;
    return false;
  };

  // Hard guard 2: Brand / lead token (token[0]) MUST match in candidate name or brands
  if (!tokenMatches(queryTokens[0])) {
    return 0;
  }

  let hits = 0;
  for (const tok of queryTokens) {
    if (tokenMatches(tok)) {
      hits += 1;
    }
  }

  const pureRatio = hits / queryTokens.length;

  // Hard guard 3: Require very high pure token overlap BEFORE any image bonus
  // - 2 tokens -> must match both (1.0)
  // - 3 tokens -> must match at least 2.5+ (all 3, or 2 of 3 only if brands also match AND 0 conflict -> require >= 0.78, i.e. 3/3)
  // - 4+ tokens -> require >= 0.75 (e.g. 3/4 or 4/5)
  const minPureRatio = queryTokens.length <= 3 ? 0.8 : 0.75;
  if (pureRatio < minPureRatio) {
    return 0;
  }

  // Tie-breaker bonus only for already-verified matches
  const frontBonus = isAllowedCandidateImageUrl(record.image_front_url) ? 0.05 : 0;
  return pureRatio + frontBonus;
}

/**
 * Sanity check for barcode lookup results when using padded/prefix-stripped
 * barcode variants (non-exact): ensures we don't accidentally attach a totally
 * unrelated product if a store's stripped/padded code happens to collide.
 */
function isBarcodeRecordCompatibleWithName(
  rawName: string,
  record: OpenFactsProductRecord,
  isExactBarcode: boolean
): boolean {
  if (!rawName || rawName.trim().length < 2) return true;
  const haystack = buildCandidateHaystack(record);
  if (!haystack) return true;

  // For exact EAN-13 / EAN-8 / 12-digit UPC barcodes, trust the official GS1 barcode
  // unless there is an egregious cross-category mismatch on a padded/prefix-stripped variant.
  if (isExactBarcode) {
    return true;
  }

  // For padded 11-digit or prefix-stripped codes, verify at least one meaningful word overlaps
  // OR there is no conflicting variant/flavor.
  if (hasVariantOrTypeConflict(rawName, haystack)) {
    return false;
  }

  const qTokens = extractMeaningfulTokens(rawName);
  if (qTokens.length === 0) return true;

  const hNorm = ` ${normalizeForTokens(haystack)} `;
  const hasAnySharedToken = qTokens.some(
    (t) => t.length >= 3 && hNorm.includes(` ${t.slice(0, Math.min(t.length, 5))}`)
  );
  return hasAnySharedToken;
}

async function fetchJsonWithTimeout<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function lookupBySingleBarcode(
  candidateBarcode: BarcodeCandidate,
  cleanName: string
): Promise<CandidateMatch | null> {
  const fields =
    'code,product_name,product_name_id,product_name_en,brands,image_front_url,image_url,image_front_small_url';
  const encodedCode = encodeURIComponent(candidateBarcode.code);
  const sources: Array<{ label: string; url: string }> = [
    {
      label: 'Open Food Facts (Barcode Persis)',
      url: `https://world.openfoodfacts.org/api/v2/product/${encodedCode}.json?fields=${fields}`,
    },
    {
      label: 'Open Beauty Facts (Barcode Persis)',
      url: `https://world.openbeautyfacts.org/api/v2/product/${encodedCode}.json?fields=${fields}`,
    },
    {
      label: 'Open Products Facts (Barcode Persis)',
      url: `https://world.openproductsfacts.org/api/v2/product/${encodedCode}.json?fields=${fields}`,
    },
  ];

  const results = await Promise.all(
    sources.map(async (src) => {
      const data = await fetchJsonWithTimeout<{
        status?: number;
        product?: OpenFactsProductRecord;
      }>(src.url);
      if (!data || data.status !== 1 || !data.product) return null;
      const img = pickBestRecordImage(data.product);
      if (!img) return null;
      if (
        !isBarcodeRecordCompatibleWithName(
          cleanName,
          data.product,
          candidateBarcode.isExact
        )
      ) {
        return null;
      }
      const matchedName =
        cleanShort(
          data.product.product_name_id ||
            data.product.product_name ||
            data.product.product_name_en ||
            candidateBarcode.code,
          120
        ) || candidateBarcode.code;
      return {
        imageUrl: img,
        matchedName,
        source: src.label,
        confidence: 'exact_barcode',
        matchedBarcode: candidateBarcode.code,
      } satisfies CandidateMatch;
    })
  );

  for (const hit of results) {
    if (hit) return hit;
  }
  return null;
}

async function lookupByBarcodeCandidates(
  candidates: BarcodeCandidate[],
  cleanName: string
): Promise<CandidateMatch | null> {
  for (const cand of candidates) {
    const hit = await lookupBySingleBarcode(cand, cleanName);
    if (hit) return hit;
  }
  return null;
}

async function lookupByStrictProductName(
  rawName: string
): Promise<CandidateMatch | null> {
  if (isNonDatabaseLocalItem(rawName)) {
    return null;
  }

  const queryTokens = extractMeaningfulTokens(rawName);
  if (queryTokens.length < 2) {
    return null;
  }

  const queries = buildSearchQueriesFromName(rawName);
  if (queries.length === 0) return null;

  const fields =
    'code,product_name,product_name_id,product_name_en,brands,image_front_url,image_url,image_front_small_url';

  for (const q of queries) {
    const encoded = encodeURIComponent(q);
    const endpoints: Array<{ label: string; url: string }> = [
      {
        label: 'Open Food Facts ID (Nama Terverifikasi)',
        url: `https://id.openfoodfacts.org/cgi/search.pl?search_terms=${encoded}&search_simple=1&action=process&json=1&page_size=8&fields=${fields}`,
      },
      {
        label: 'Open Food Facts Global (Nama Terverifikasi)',
        url: `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encoded}&search_simple=1&action=process&json=1&page_size=8&fields=${fields}`,
      },
      {
        label: 'Open Beauty Facts (Nama Terverifikasi)',
        url: `https://world.openbeautyfacts.org/cgi/search.pl?search_terms=${encoded}&search_simple=1&action=process&json=1&page_size=6&fields=${fields}`,
      },
    ];

    const settled = await Promise.all(
      endpoints.map(async (ep) => {
        const data = await fetchJsonWithTimeout<{
          products?: OpenFactsProductRecord[];
        }>(ep.url);
        if (!data || !Array.isArray(data.products)) return null;

        let best: { score: number; match: CandidateMatch } | null = null;
        for (const rec of data.products) {
          const img = pickBestRecordImage(rec);
          if (!img) continue;
          const score = scoreStrictNameMatch(rawName, queryTokens, rec);
          if (score <= 0) continue;

          const matchedName =
            cleanShort(
              rec.product_name_id || rec.product_name || rec.product_name_en || q,
              120
            ) || q;
          if (!best || score > best.score) {
            best = {
              score,
              match: {
                imageUrl: img,
                matchedName,
                source: ep.label,
                confidence: 'verified_name',
                matchedBarcode: cleanShort(rec.code, 30) || undefined,
              },
            };
          }
        }
        return best;
      })
    );

    let overallBest: { score: number; match: CandidateMatch } | null = null;
    for (const item of settled) {
      if (item && (!overallBest || item.score > overallBest.score)) {
        overallBest = item;
      }
    }
    if (overallBest) {
      return overallBest.match;
    }
  }

  return null;
}

/**
 * Automatically looks up an accurate retail product packaging image from free
 * public barcode databases (Open Food Facts / Open Beauty Facts / Open Products Facts).
 *
 * Anti-Wrong-Image Guarantee:
 * 1. Ignores short store-internal codes (< 8 digits) to avoid barcode collisions.
 * 2. Normalizes 11/12-digit UPC/EAN codes with leading zeros and prefixed codes (PCS/IND/ID/R/S/V).
 * 3. In name fallback mode, enforces mandatory brand match, zero flavor/variant/type conflict,
 *    and >= 75-80% pure token overlap. Unmatched items cleanly return found: false.
 */
export async function autoFetchCatalogProductImage(
  input: AutoFetchProductImageInput
): Promise<AutoFetchProductImageOutcome> {
  const cleanName = cleanShort(input.name, 120);
  const cleanBarcode = cleanShort(input.barcode, 40);
  const cleanSku = cleanShort(input.sku, 40);
  const strictBarcodeOnly = Boolean(input.strictBarcodeOnly);
  const kpsOnly = Boolean(input.kpsOnly);

  const barcodeCandidates = buildRetailBarcodeCandidates(cleanBarcode, cleanSku);

  if (
    barcodeCandidates.length === 0 &&
    !cleanBarcode &&
    !cleanSku &&
    cleanName.length < 2
  ) {
    return {
      ok: true,
      found: false,
      reason: 'Masukkan barcode atau nama produk terlebih dahulu.',
    };
  }

  const cacheKey = [
    kpsOnly ? 'kps' : 'all',
    strictBarcodeOnly ? 'strict' : 'hybrid',
    cleanBarcode.toUpperCase(),
    cleanSku.toUpperCase(),
    cleanName.toLowerCase(),
  ].join('|');

  const cached = readCache(cacheKey);
  if (cached) {
    return cached;
  }

  let candidate: CandidateMatch | null = null;

  // Stage 0 (Highest Priority): Official AlpaMart KPS catalog (https://alpamartkps.store/)
  // Matches exact barcode/SKU (including leading zeros & store codes like MIESEDUH...),
  // exact normalized product name, or strict brand + variant + size match.
  try {
    const kpsIndex = await getAlpamartKpsCatalogIndex();
    const kpsMatch = matchProductInAlpamartKpsIndex(kpsIndex, {
      barcode: cleanBarcode,
      sku: cleanSku,
      name: cleanName,
      strictBarcodeOnly,
    });
    if (kpsMatch && isAllowedCandidateImageUrl(kpsMatch.entry.imageUrl)) {
      candidate = {
        imageUrl: kpsMatch.entry.imageUrl,
        matchedName: kpsMatch.entry.name,
        source: kpsMatch.sourceLabel,
        confidence: kpsMatch.confidence,
        matchedBarcode: kpsMatch.matchedBarcode,
      };
    }
  } catch {
    // Non-fatal: continue to Stage 1/2 fallback unless kpsOnly is requested
  }

  // Stage 1: Public Retail Barcode Databases (Open Food / Beauty / Products Facts)
  if (!candidate && !kpsOnly && barcodeCandidates.length > 0) {
    candidate = await lookupByBarcodeCandidates(barcodeCandidates, cleanName);
  }

  // Stage 2: Strict Brand + Variant Verified Name Match (only when !strictBarcodeOnly && !kpsOnly)
  if (!candidate && !kpsOnly && !strictBarcodeOnly && cleanName.length >= 3) {
    candidate = await lookupByStrictProductName(cleanName);
  }

  if (!candidate) {
    const primaryCode = barcodeCandidates[0]?.code || cleanBarcode || cleanSku;
    const missOutcome: AutoFetchProductImageOutcome = {
      ok: true,
      found: false,
      reason: kpsOnly
        ? `Produk "${cleanName || primaryCode || '-'}" belum tersedia di katalog alpamartkps.store (dilewati agar tidak salah gambar).`
        : strictBarcodeOnly
          ? `Barcode ${primaryCode || '-'} belum tersedia fotonya di alpamartkps.store / database barcode (dilewati agar tidak salah gambar).`
          : primaryCode
            ? `Belum ditemukan foto yang 100% cocok untuk barcode ${primaryCode} / "${cleanName || '-'}" (dilewati agar tidak salah gambar).`
            : `Belum ditemukan foto yang 100% cocok untuk "${cleanName}" (dilewati agar tidak salah gambar).`,
    };
    writeCache(cacheKey, missOutcome);
    return missOutcome;
  }

  const optimized = await optimizeProductImageForDisplayBox(candidate.imageUrl, {
    boxSize: DEFAULT_DISPLAY_BOX_SIZE,
  });

  if (!optimized.ok) {
    const failOutcome: AutoFetchProductImageOutcome = {
      ok: true,
      found: false,
      reason: 'Foto ditemukan tetapi gagal diproses menjadi ukuran katalog.',
    };
    return failOutcome;
  }

  const successOutcome: AutoFetchProductImageOutcome = {
    ok: true,
    found: true,
    imageUrl: optimized.imageUrl,
    source: candidate.source,
    matchedName: candidate.matchedName,
    matchedBarcode: candidate.matchedBarcode,
    matchConfidence: candidate.confidence,
    sizeKb: optimized.sizeKb,
  };
  writeCache(cacheKey, successOutcome);
  return successOutcome;
}

export type PortalZipTarget = 'customer' | 'delivery' | 'admin' | 'master';

export interface SinglePortalDomainZipOptions {
  portal: PortalZipTarget;
  storeName: string;
  storeTagline?: string;
  origin: string;
}

export interface CustomerDomainZipOptions {
  storeName: string;
  storeTagline?: string;
  origin: string;
}

export interface ZipEntry {
  name: string;
  content: string | Uint8Array;
  compressed?: Uint8Array;
  method?: 0 | 8;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function getDosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

/**
 * Pure isomorphic PKZIP archive builder (STORE method 0, UTF-8 filenames).
 * Runs identically in both Node.js and all modern browsers with zero external deps.
 */
export function buildZipArchiveBytes(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const now = new Date();
  const { dosTime, dosDate } = getDosDateTime(now);

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const rawBytes =
      entry.content instanceof Uint8Array
        ? entry.content
        : encoder.encode(entry.content);
    const crc = crc32(rawBytes);
    const uncompressedSize = rawBytes.length;
    const useDeflate =
      entry.method === 8 &&
      entry.compressed instanceof Uint8Array &&
      entry.compressed.length < uncompressedSize;
    const method = useDeflate ? 8 : 0;
    const payloadBytes = useDeflate ? entry.compressed! : rawBytes;
    const compressedSize = payloadBytes.length;

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compressedSize, true);
    lv.setUint32(22, uncompressedSize, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, payloadBytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // Universal MS-DOS / PKZIP 2.0 for 100% Android, iOS, Windows & macOS compatibility
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compressedSize, true);
    cv.setUint32(24, uncompressedSize, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0x00000020, true); // Standard readable archive file attribute
    cv.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);

    centralParts.push(centralHeader);
    offset += localHeader.length + payloadBytes.length;
  }

  let centralSize = 0;
  for (const part of centralParts) {
    centralSize += part.length;
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const totalLength = offset + centralSize + eocd.length;
  const archive = new Uint8Array(totalLength);
  let cursor = 0;
  for (const part of localParts) {
    archive.set(part, cursor);
    cursor += part.length;
  }
  for (const part of centralParts) {
    archive.set(part, cursor);
    cursor += part.length;
  }
  archive.set(eocd, cursor);

  return archive;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeZipOrigin(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.origin;
    }
  } catch {
    // fallback below
  }
  return trimmed.split(/[?#]/)[0].replace(/\/+$/, '');
}

export const PORTAL_META: Record<
  PortalZipTarget,
  {
    fileTag: string;
    guideFile: string;
    titlePrefix: string;
    label: string;
    themeColor: string;
    defaultDesc: (storeName: string) => string;
    portalQuery: '' | 'delivery' | 'admin' | 'master';
    isolationNote: string;
  }
> = {
  customer: {
    fileTag: 'Website_Pelanggan',
    guideFile: 'PANDUAN_PASANG_WEBSITE_PELANGGAN.txt',
    titlePrefix: '',
    label: 'Website Pelanggan (Toko Online)',
    themeColor: '#1d4ed8',
    defaultDesc: (storeName) =>
      `Belanja online resmi di ${storeName} — Free Delivery & checkout instan tanpa login.`,
    portalQuery: '',
    isolationNote:
      'File ZIP ini 100% KHUSUS Website Pelanggan (Toko Online). Tidak ada halaman atau tautan portal lain di dalamnya.',
  },
  delivery: {
    fileTag: 'Website_Deliveri',
    guideFile: 'PANDUAN_PASANG_WEBSITE_DELIVERI.txt',
    titlePrefix: 'Kurir Deliveri — ',
    label: 'Website Kurir Deliveri',
    themeColor: '#1d4ed8',
    defaultDesc: (storeName) =>
      `Portal khusus Kurir Deliveri ${storeName} — daftar pengantaran, navigasi GPS, dan bukti kirim foto.`,
    portalQuery: 'delivery',
    isolationNote:
      'File ZIP ini 100% KHUSUS Website Kurir Deliveri (1 website = 1 file ZIP tersendiri, tidak digabungkan dengan akun lain).',
  },
  admin: {
    fileTag: 'Website_Admin',
    guideFile: 'PANDUAN_PASANG_WEBSITE_ADMIN.txt',
    titlePrefix: 'Admin — ',
    label: 'Website Pengelola Admin',
    themeColor: '#0f172a',
    defaultDesc: (storeName) =>
      `Dashboard khusus Admin ${storeName} — pesanan, katalog, promosi, scanner barcode, dan cetak struk.`,
    portalQuery: 'admin',
    isolationNote:
      'File ZIP ini 100% KHUSUS Website Admin (1 website = 1 file ZIP tersendiri, tidak digabungkan dengan akun lain).',
  },
  master: {
    fileTag: 'Website_Master_Data',
    guideFile: 'PANDUAN_PASANG_WEBSITE_MASTER.txt',
    titlePrefix: 'Master Data — ',
    label: 'Website Master Data',
    themeColor: '#d97706',
    defaultDesc: (storeName) =>
      `Portal khusus Master Data ${storeName} — kendali penuh identitas toko, mata uang, kurs, tema, dan backup.`,
    portalQuery: 'master',
    isolationNote:
      'File ZIP ini 100% KHUSUS Website Master Data (1 website = 1 file ZIP tersendiri, tidak digabungkan dengan akun lain).',
  },
};

/**
 * Builds a strictly isolated, auto-updating standalone domain ZIP for ONE single website/portal.
 * 1 Website = 1 File ZIP (Pelanggan, Deliveri, Admin, or Master — NEVER combined).
 * Once uploaded to any custom domain host (Netlify, Vercel, Cloudflare Pages, cPanel),
 * all updates (products, stock, prices, currencies, rates, promos, orders, features)
 * automatically reflect live without ever needing to re-upload the ZIP.
 */
export function buildSinglePortalDomainZipPackage(
  opts: SinglePortalDomainZipOptions
): {
  bytes: Uint8Array;
  filename: string;
  origin: string;
  fileCount: number;
  portal: PortalZipTarget;
  portalLabel: string;
} {
  const meta = PORTAL_META[opts.portal];
  const cleanOrigin = normalizeZipOrigin(opts.origin);
  const targetBaseUrl = meta.portalQuery
    ? `${cleanOrigin}/?portal=${meta.portalQuery}`
    : `${cleanOrigin}/`;

  const pageTitle = meta.titlePrefix
    ? `${meta.titlePrefix}${opts.storeName}`
    : opts.storeName;
  const pageDesc =
    opts.portal === 'customer' && opts.storeTagline?.trim()
      ? opts.storeTagline.trim()
      : meta.defaultDesc(opts.storeName);

  const safeTitle = escapeHtml(pageTitle);
  const safeDesc = escapeHtml(pageDesc);
  const safeTargetUrl = escapeHtml(targetBaseUrl);

  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const buildStamp = `${y}${m}${d}-${hh}${mm}`;
  const buildDisplay = `${y}-${m}-${d} ${hh}:${mm}`;
  const bustTargetUrl = meta.portalQuery
    ? `${cleanOrigin}/?portal=${meta.portalQuery}&_v=${buildStamp}`
    : `${cleanOrigin}/?_v=${buildStamp}`;
  const safeBustTargetUrl = escapeHtml(bustTargetUrl);

  const indexHtml = `<!doctype html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate" />
  <meta http-equiv="Pragma" content="no-cache" />
  <meta http-equiv="Expires" content="0" />
  <title>${safeTitle}</title>
  <meta name="description" content="${safeDesc}" />
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeDesc}" />
  <meta property="og:image" content="${escapeHtml(cleanOrigin)}/assets/alpamart-logo-512.png?v=${buildStamp}" />
  <meta property="og:type" content="website" />
  <meta name="theme-color" content="${meta.themeColor}" />
  <link rel="icon" type="image/png" sizes="64x64" href="${escapeHtml(cleanOrigin)}/favicon.png?v=${buildStamp}" />
  <link rel="icon" type="image/jpeg" href="${escapeHtml(cleanOrigin)}/assets/aistudio/ALPA_17db3f6e.jpg?v=${buildStamp}" />
  <link rel="shortcut icon" href="${escapeHtml(cleanOrigin)}/favicon.png?v=${buildStamp}" />
  <link rel="apple-touch-icon" sizes="192x192" href="${escapeHtml(cleanOrigin)}/assets/alpamart-logo-192.png?v=${buildStamp}" />
  <link rel="manifest" href="/manifest.json" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%;
      height: 100%;
      background: #f1f5f9;
      color: #0f172a;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    #launcher-shell {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      z-index: 5;
      background: #f1f5f9;
    }
    .launcher-card {
      width: 100%;
      max-width: 460px;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08);
    }
    .launcher-bar { height: 6px; background: ${meta.themeColor}; }
    .launcher-body { padding: 24px 22px; }
    .launcher-badge {
      font-size: 11px;
      font-weight: 700;
      color: ${meta.themeColor};
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 6px;
    }
    .launcher-title { font-size: 20px; font-weight: 700; margin-bottom: 8px; line-height: 1.3; }
    .launcher-desc { font-size: 13px; color: #475569; line-height: 1.55; margin-bottom: 14px; }
    .launcher-url {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11.5px;
      background: #f8fafc;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      padding: 9px 11px;
      word-break: break-all;
      color: #0f172a;
      margin-bottom: 14px;
    }
    .launcher-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 11px 16px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 700;
      text-decoration: none;
      cursor: pointer;
      border: 1px solid transparent;
    }
    .btn-primary { background: ${meta.themeColor}; color: #ffffff; flex: 1; min-width: 160px; }
    .btn-secondary { background: #f8fafc; color: #0f172a; border-color: #cbd5e1; }
    #portal-frame {
      position: fixed;
      inset: 0;
      width: 100%;
      height: 100dvh;
      border: 0;
      display: none;
      background: #ffffff;
      z-index: 10;
    }
    #fallback-bar {
      position: fixed;
      left: 50%;
      bottom: 14px;
      transform: translateX(-50%);
      background: rgba(15, 23, 42, 0.92);
      color: #ffffff;
      padding: 9px 13px;
      border-radius: 10px;
      font-size: 12px;
      display: none;
      align-items: center;
      gap: 10px;
      box-shadow: 0 10px 25px rgba(15, 23, 42, 0.25);
      z-index: 20;
      max-width: calc(100vw - 24px);
    }
    #fallback-bar a {
      color: #ffffff;
      background: ${meta.themeColor};
      padding: 6px 12px;
      border-radius: 6px;
      text-decoration: none;
      font-weight: 700;
      white-space: nowrap;
    }
  </style>
</head>
<body>
  <main id="launcher-shell">
    <div class="launcher-card">
      <div class="launcher-bar"></div>
      <div class="launcher-body">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
          <img
            src="${escapeHtml(cleanOrigin)}/assets/aistudio/ALPA_17db3f6e.jpg?v=${buildStamp}"
            alt="${safeTitle}"
            referrerpolicy="no-referrer"
            onerror="this.style.display='none'"
            style="width:52px;height:52px;border-radius:12px;object-fit:contain;border:1px solid #e2e8f0;background:#fff;padding:3px;flex-shrink:0;"
          />
          <div>
            <div class="launcher-badge" style="margin-bottom:2px;">${escapeHtml(meta.label)} · Auto-Update</div>
            <h1 class="launcher-title" style="margin-bottom:0;">${safeTitle}</h1>
          </div>
        </div>
        <p class="launcher-desc">${safeDesc}</p>
        <div class="launcher-url" id="url-preview">${safeTargetUrl}</div>
        <p style="font-size:11.5px;color:#64748b;margin-bottom:14px;">Versi Paket: <strong>${buildDisplay}</strong> · Selalu memuat versi publik terbaru tanpa cache lama.</p>
        <div class="launcher-actions">
          <a id="open-now-btn" class="btn btn-primary" href="${safeBustTargetUrl}">Buka Website Terbaru</a>
          <a id="open-tab-btn" class="btn btn-secondary" href="${safeBustTargetUrl}" target="_blank" rel="noopener noreferrer">Tab Baru</a>
        </div>
      </div>
    </div>
  </main>

  <iframe
    id="portal-frame"
    title="${safeTitle}"
    allow="geolocation *; camera *; microphone *; clipboard-write *; fullscreen *"
    allowfullscreen
    referrerpolicy="no-referrer-when-downgrade"
  ></iframe>

  <div id="fallback-bar">
    <span>Tampilan belum muncul?</span>
    <a id="direct-link" href="${safeBustTargetUrl}" rel="noopener noreferrer">Buka Langsung</a>
  </div>

  <script>
    (function () {
      var ORIGIN = ${JSON.stringify(cleanOrigin)};
      var LOCKED_PORTAL = ${JSON.stringify(meta.portalQuery)};
      var openNowBtn = document.getElementById('open-now-btn');
      var openTabBtn = document.getElementById('open-tab-btn');
      var urlPreview = document.getElementById('url-preview');

      function buildLockedTargetUrl(withCacheBust) {
        var params = new URLSearchParams(window.location.search || '');
        params.delete('portal');
        params.delete('site');
        params.delete('_v');
        if (LOCKED_PORTAL) {
          params.set('portal', LOCKED_PORTAL);
        }
        if (withCacheBust) {
          params.set('_v', String(Date.now()));
        }
        var qs = params.toString();
        return qs ? ORIGIN + '/?' + qs : ORIGIN + '/';
      }

      var cleanDisplayUrl = ${JSON.stringify(targetBaseUrl)};
      var targetUrl = ${JSON.stringify(bustTargetUrl)};
      try {
        cleanDisplayUrl = buildLockedTargetUrl(false);
        targetUrl = buildLockedTargetUrl(true);
      } catch (e) {}

      if (openNowBtn) openNowBtn.href = targetUrl;
      if (openTabBtn) openTabBtn.href = targetUrl;
      if (urlPreview) urlPreview.textContent = cleanDisplayUrl;

      // When opened locally from Phone/PC Files app (file:// or content://),
      // keep the launcher card visible so 1 tap opens directly in Chrome/Safari cleanly.
      var isHttpHost = window.location.protocol === 'http:' || window.location.protocol === 'https:';
      if (!isHttpHost) {
        return;
      }

      // Guard against infinite self-loop if ORIGIN equals the current hosting domain.
      if (window.location.origin && window.location.origin.toLowerCase() === ORIGIN.toLowerCase()) {
        return;
      }

      // Direct top-level navigation avoids Google Cloud Run CSP frame-ancestors iframe blocking.
      window.location.replace(targetUrl);
    })();
  </script>
</body>
</html>`;

  const manifestJson = JSON.stringify(
    {
      name: pageTitle,
      short_name: pageTitle.slice(0, 22),
      description: pageDesc,
      start_url: '/',
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: meta.themeColor,
      lang: 'id',
      icons: [
        {
          src: `${cleanOrigin}/assets/alpamart-logo-192.png`,
          sizes: '192x192',
          type: 'image/png',
          purpose: 'any maskable',
        },
        {
          src: `${cleanOrigin}/assets/alpamart-logo-512.png`,
          sizes: '512x512',
          type: 'image/png',
          purpose: 'any maskable',
        },
      ],
    },
    null,
    2
  );

  const redirectsFile = `/* /index.html 200\n`;

  const vercelJson = JSON.stringify(
    {
      rewrites: [{ source: '/(.*)', destination: '/index.html' }],
      headers: [
        {
          source: '/index.html',
          headers: [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }],
        },
      ],
    },
    null,
    2
  );

  const netlifyToml = `[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200

[[headers]]
  for = "/index.html"
  [headers.values]
    Cache-Control = "no-cache, no-store, must-revalidate"
`;

  const htaccess = `<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteCond %{HTTPS} !=on
  RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule ^ index.html [L]
</IfModule>
<IfModule mod_headers.c>
  <FilesMatch "\\.(html)$">
    Header set Cache-Control "no-cache, no-store, must-revalidate"
  </FilesMatch>
</IfModule>
`;

  const openDirectTxt = [
    `BUKA ${meta.label.toUpperCase()} LANGSUNG DI BROWSER HP (CHROME / SAFARI)`,
    `====================================================================`,
    ``,
    `LINK WEBSITE AKTIF:`,
    `${targetBaseUrl}`,
    ``,
    `PENTING UNTUK PENGGUNA HANDPHONE (ANDROID / IPHONE):`,
    `- Android & iPhone memblokir akses file index.html lokal (file:// / content://)`,
    `  yang dibuka langsung dari dalam aplikasi File Manager / ZIP.`,
    `- Untuk membuka di HP, cukup SALIN / KLIK link HTTPS di atas langsung di`,
    `  Google Chrome atau Safari, lalu pilih "Tambahkan ke Layar Utama".`,
    `- File ZIP ini dirancang untuk di-upload ke hosting domain Anda sendiri`,
    `  (Netlify Drop, Vercel, Cloudflare Pages, atau cPanel public_html).`,
  ].join('\r\n');

  const guideTxt = [
    `PANDUAN PASANG DOMAIN — ${meta.label.toUpperCase()} (AUTO-UPDATE OTOMATIS)`,
    `Toko   : ${opts.storeName}`,
    `Portal : ${meta.label}`,
    `Server : ${targetBaseUrl}`,
    `Tanggal: ${y}-${m}-${d}`,
    `====================================================================`,
    ``,
    `1. TERPISAH KHUSUS 1 WEBSITE = 1 FILE ZIP:`,
    `   ${meta.isolationNote}`,
    ``,
    `2. OTOMATIS TER-UPDATE KESELURUHANNYA SELAMANYA:`,
    `   Setiap ada perubahan produk, foto, stok, harga, kurs/mata uang,`,
    `   promosi, pesanan, atau pembaruan fitur, website pada domain ini`,
    `   OTOMATIS tersinkronisasi tanpa perlu upload ulang file ZIP.`,
    ``,
    `3. CARA PASANG DI DOMAIN ANDA (PILIH SALAH SATU):`,
    `   - NETLIFY DROP / CLOUDFLARE PAGES (GRATIS):`,
    `     Ekstrak ZIP ini -> drag & drop foldernya -> hubungkan Custom Domain.`,
    `   - CPANEL / HOSTING DOMAIN SENDIRI:`,
    `     Upload file ZIP ini ke folder public_html domain Anda -> klik Extract`,
    `     -> pastikan index.html berada langsung di public_html`,
    `     -> (opsional) ubah nama file htaccess_cpanel.txt menjadi .htaccess`,
    `     -> aktifkan HTTPS/SSL.`,
    `   - VERCEL:`,
    `     Upload folder hasil ekstrak ke Vercel -> hubungkan Custom Domain.`,
    ``,
    `4. CARA BUKA DI HANDPHONE (ANDROID / IPHONE):`,
    `   Jangan buka index.html langsung dari aplikasi File Manager / ZIP karena`,
    `   sistem keamanan HP memblokir file HTML lokal. Buka langsung link HTTPS ini`,
    `   di Google Chrome / Safari: ${targetBaseUrl}`,
    ...(opts.portal === 'admin' || opts.portal === 'master'
      ? [
          ``,
          `5. CATATAN LOGIN GOOGLE DI DOMAIN SENDIRI:`,
          `   Tambahkan domain Anda ke Firebase Console -> Authentication -> Settings`,
          `   -> Authorized domains agar tombol Login Google aktif di domain baru.`,
        ]
      : []),
    ``,
    `SELESAI! ${meta.label} siap online secara terpisah & selalu update otomatis.`,
  ].join('\r\n');

  const entries: ZipEntry[] = [
    { name: 'BUKA_WEBSITE_DISINI.txt', content: openDirectTxt },
    { name: 'index.html', content: indexHtml },
    { name: 'manifest.json', content: manifestJson },
    { name: '_redirects', content: redirectsFile },
    { name: 'vercel.json', content: vercelJson },
    { name: 'netlify.toml', content: netlifyToml },
    { name: 'htaccess_cpanel.txt', content: htaccess },
    { name: meta.guideFile, content: guideTxt },
  ];

  const bytes = buildZipArchiveBytes(entries);
  const safeSlug =
    opts.storeName
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'ALPAMART_TRIMUIA';
  const filename = `${safeSlug}_${meta.fileTag}_AutoUpdate_${y}-${m}-${d}_${hh}${mm}.zip`;

  return {
    bytes,
    filename,
    origin: cleanOrigin,
    fileCount: entries.length,
    portal: opts.portal,
    portalLabel: meta.label,
  };
}

export function buildCustomerDomainZipPackage(opts: CustomerDomainZipOptions): {
  bytes: Uint8Array;
  filename: string;
  origin: string;
  fileCount: number;
} {
  return buildSinglePortalDomainZipPackage({
    portal: 'customer',
    storeName: opts.storeName,
    storeTagline: opts.storeTagline,
    origin: opts.origin,
  });
}

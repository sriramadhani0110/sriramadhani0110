import 'dotenv/config';
import express, { type Request } from 'express';
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'fs';
import net from 'node:net';
import path from 'path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'url';
import {
  buildSinglePortalDomainZipPackage,
  buildZipArchiveBytes,
  PORTAL_META,
  type PortalZipTarget,
  type ZipEntry,
} from './src/lib/portalZipBuilder.ts';
import {
  DEFAULT_EXCHANGE_RATE_KHR,
  extractRawProductsList,
  fetchJournalPosWithRetry,
  getJournalPosServerCredentials,
  mapJournalPosRawProduct,
  parseJournalPosTabularText,
  probeJournalPosSignatureFormat,
  type MappedJournalPosRecord,
  verifyWebhookSignature,
} from './src/lib/journalPosAdapter.ts';
import {
  fetchJournalPosProductsService,
  getJournalPosServiceStatus,
  getLatestPolledSnapshot,
  initJournalPosServiceOnBoot,
  runJournalPosPollCycle,
  startJournalPosPeriodicSync,
  stopJournalPosPeriodicSync,
} from './src/lib/journalPosService.ts';
import {
  DEFAULT_DISPLAY_BOX_SIZE,
  optimizeProductImageForDisplayBox,
} from './src/lib/serverProductImageOptimizer.ts';
import { autoFetchCatalogProductImage } from './src/lib/serverCatalogAutoImage.ts';
import { getAdminAuth } from './src/lib/firebaseAdminServer.ts';
import { syncJournalPosRecordsToFirestoreServer } from './src/lib/journalPosFirestoreServerSync.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IS_PROD = process.env.NODE_ENV === 'production';
const PORT = IS_PROD ? Number(process.env.PORT) || 3000 : 3000;

interface FirebaseAppletConfig {
  projectId: string;
  apiKey: string;
  firestoreDatabaseId?: string;
}

function loadFirebaseAppletConfig(): FirebaseAppletConfig {
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, 'firebase-applet-config.json'), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<FirebaseAppletConfig>;
    return {
      projectId: parsed.projectId || 'gen-lang-client-0316275418',
      apiKey: parsed.apiKey || '',
      firestoreDatabaseId: parsed.firestoreDatabaseId || '(default)',
    };
  } catch {
    return {
      projectId: 'gen-lang-client-0316275418',
      apiKey: '',
      firestoreDatabaseId: '(default)',
    };
  }
}

const FIREBASE_CONFIG = loadFirebaseAppletConfig();
const BOOTSTRAPPED_ADMIN_EMAILS = new Set([
  'hananbintang30@gmail.com',
  'tmalpamartt@gmail.com',
]);

interface QueuedWebhookEvent {
  eventId: string;
  receivedAt: string;
  eventType: string;
  records: MappedJournalPosRecord[];
  parseErrors: string[];
}

const pendingWebhookQueue: QueuedWebhookEvent[] = [];
const MAX_PENDING_WEBHOOK_EVENTS = 100;

interface RequestWithRawBody extends Request {
  rawBody?: string;
}

async function verifyFirebaseAdminRequest(
  req: Request
): Promise<{ ok: true; email: string; uid: string } | { ok: false; status: number; reason: string }> {
  const authHeader = req.get('authorization') || '';
  const match = authHeader.match(/^Bearer\s+([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$/);
  if (!match) {
    return { ok: false, status: 401, reason: 'AUTH_TOKEN_REQUIRED' };
  }
  const idToken = match[1];

  try {
    let uid = '';
    let email = '';
    let emailVerified = false;

    // 1. Cryptographically verify Firebase ID token using Firebase Admin SDK (no IAM needed)
    try {
      const decoded = await getAdminAuth().verifyIdToken(idToken);
      uid = decoded.uid || '';
      email = decoded.email || '';
      emailVerified = Boolean(decoded.email_verified);
    } catch {
      // Fallback to Firebase Identity Toolkit lookup when running without public key fetch
      if (!FIREBASE_CONFIG.apiKey) {
        return { ok: false, status: 401, reason: 'INVALID_FIREBASE_TOKEN' };
      }
      const lookupRes = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(FIREBASE_CONFIG.apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        }
      );
      if (!lookupRes.ok) {
        return { ok: false, status: 401, reason: 'INVALID_FIREBASE_TOKEN' };
      }
      const lookupData = (await lookupRes.json()) as {
        users?: Array<{ localId?: string; email?: string; emailVerified?: boolean }>;
      };
      const user = lookupData.users?.[0];
      uid = user?.localId || '';
      email = user?.email || '';
      emailVerified = Boolean(user?.emailVerified);
    }

    if (!uid || !email || !emailVerified) {
      return { ok: false, status: 403, reason: 'EMAIL_NOT_VERIFIED' };
    }

    const emailLower = email.trim().toLowerCase();
    if (BOOTSTRAPPED_ADMIN_EMAILS.has(emailLower)) {
      return { ok: true, email: emailLower, uid };
    }

    // Check registered active admin in Firestore using the caller's own verified ID token
    const emailHash = crypto.createHash('sha256').update(emailLower, 'utf8').digest('hex');
    const dbId = FIREBASE_CONFIG.firestoreDatabaseId || '(default)';
    const adminDocUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      FIREBASE_CONFIG.projectId
    )}/databases/${encodeURIComponent(dbId)}/documents/adminAccounts/${emailHash}`;
    const docRes = await fetch(adminDocUrl, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (docRes.ok) {
      const docJson = (await docRes.json()) as {
        fields?: { isActive?: { booleanValue?: boolean } };
      };
      if (docJson.fields?.isActive?.booleanValue === true) {
        return { ok: true, email: emailLower, uid };
      }
    }

    return { ok: false, status: 403, reason: 'ADMIN_ROLE_REQUIRED' };
  } catch {
    return { ok: false, status: 401, reason: 'TOKEN_VERIFICATION_FAILED' };
  }
}

// Lightweight in-memory rate limiting & deduplication for Telegram dispatch
const ipWindowHits = new Map<string, number[]>();
const orderLastSentAt = new Map<string, number>();

// Cached mapping from Telegram Bot getUpdates (username / phone / order start param -> chat_id)
interface TelegramDirectoryCache {
  fetchedAt: number;
  byUsername: Map<string, string>;
  byPhoneDigits: Map<string, string>;
  byOrderRef: Map<string, string>;
}

const directoryCache: TelegramDirectoryCache = {
  fetchedAt: 0,
  byUsername: new Map(),
  byPhoneDigits: new Map(),
  byOrderRef: new Map(),
};

const FEED_KEY_PATTERN = /^[a-zA-Z0-9_-]{24,80}$/;
const PROOF_DATA_URL_PATTERN =
  /^data:(image\/(?:jpeg|jpg|png|webp|gif)|application\/pdf);base64,([A-Za-z0-9+/=\r\n]+)$/;

function cleanShortString(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, maxLen);
}

function normalizeTelegramLookup(raw: string): {
  usernameLower: string;
  phoneDigits: string;
  directChatId: string;
} {
  let cleaned = raw.trim();
  cleaned = cleaned
    .replace(/^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\//i, '')
    .replace(/^(?:t\.me|telegram\.me)\//i, '')
    .split(/[?#]/)[0]
    .replace(/\/+$/, '');

  // Explicit numeric Telegram chat ID prefix e.g. "id:123456789" or "-100123456789"
  const explicitIdMatch = cleaned.match(/^(?:id:|chat:)?(-?\d{6,15})$/i);
  const digitsOnly = cleaned.replace(/\D/g, '');

  // Normalize Indonesian local 08... to 628... as well
  let phoneDigits = digitsOnly;
  if (phoneDigits.startsWith('00')) {
    phoneDigits = phoneDigits.slice(2);
  } else if (phoneDigits.startsWith('08')) {
    phoneDigits = `62${phoneDigits.slice(1)}`;
  }

  let directChatId = '';
  if (explicitIdMatch && !cleaned.startsWith('+') && !cleaned.startsWith('0')) {
    directChatId = explicitIdMatch[1];
  }

  const withoutAt = cleaned.replace(/^@+/, '');
  const usernameLower =
    /^[a-zA-Z][a-zA-Z0-9_]{3,63}$/.test(withoutAt) ? withoutAt.toLowerCase() : '';

  return { usernameLower, phoneDigits, directChatId };
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const windowMs = 60_000;
  const hits = (ipWindowHits.get(ip) || []).filter((ts) => now - ts < windowMs);
  if (hits.length >= 20) {
    ipWindowHits.set(ip, hits);
    return false;
  }
  hits.push(now);
  ipWindowHits.set(ip, hits);
  return true;
}

async function refreshTelegramDirectory(botToken: string, force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - directoryCache.fetchedAt < 10_000) {
    return;
  }
  directoryCache.fetchedAt = now;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(
      `https://api.telegram.org/bot${encodeURIComponent(botToken)}/getUpdates?limit=100`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return;

    const data = (await res.json()) as {
      ok?: boolean;
      result?: Array<{
        message?: {
          text?: string;
          chat?: { id?: number | string; username?: string };
          from?: { id?: number | string; username?: string };
          contact?: { phone_number?: string; user_id?: number | string };
        };
      }>;
    };

    if (!data.ok || !Array.isArray(data.result)) return;

    for (const update of data.result) {
      const msg = update.message;
      if (!msg?.chat?.id) continue;
      const chatIdStr = String(msg.chat.id);

      if (msg.chat.username) {
        directoryCache.byUsername.set(msg.chat.username.toLowerCase(), chatIdStr);
      }
      if (msg.from?.username) {
        directoryCache.byUsername.set(msg.from.username.toLowerCase(), chatIdStr);
      }
      if (msg.contact?.phone_number) {
        const digits = msg.contact.phone_number.replace(/\D/g, '');
        if (digits.length >= 7) {
          directoryCache.byPhoneDigits.set(digits, chatIdStr);
          directoryCache.byPhoneDigits.set(digits.slice(-9), chatIdStr);
        }
      }
      if (typeof msg.text === 'string' && msg.text.startsWith('/start')) {
        const arg = msg.text.replace(/^\/start\s*/i, '').trim();
        if (arg) {
          directoryCache.byOrderRef.set(arg.toLowerCase(), chatIdStr);
          const argDigits = arg.replace(/\D/g, '');
          if (argDigits.length >= 7) {
            directoryCache.byPhoneDigits.set(argDigits, chatIdStr);
            directoryCache.byPhoneDigits.set(argDigits.slice(-9), chatIdStr);
          }
        }
      }
    }
  } catch {
    // Ignore transient Telegram polling errors
  }
}

async function sendTelegramPayload(
  botToken: string,
  chatId: string,
  captionText: string,
  proofDataUrl: string,
  orderNumber: string
): Promise<{ ok: boolean; errorDescription?: string }> {
  const safeBaseUrl = `https://api.telegram.org/bot${encodeURIComponent(botToken)}`;
  const proofMatch = proofDataUrl ? proofDataUrl.match(PROOF_DATA_URL_PATTERN) : null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

  try {
    if (proofMatch) {
      const mimeType = proofMatch[1].toLowerCase();
      const base64Body = proofMatch[2].replace(/\s+/g, '');
      const buffer = Buffer.from(base64Body, 'base64');
      const isPdf = mimeType === 'application/pdf';
      const ext = isPdf
        ? 'pdf'
        : mimeType === 'image/png'
          ? 'png'
          : mimeType === 'image/webp'
            ? 'webp'
            : 'jpg';
      const safeOrderSlug = orderNumber.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'order';
      const fileName = `bukti-${safeOrderSlug}.${ext}`;

      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('caption', captionText.slice(0, 1020));
      const blob = new Blob([buffer], { type: mimeType });

      if (isPdf) {
        form.append('document', blob, fileName);
      } else {
        form.append('photo', blob, fileName);
      }

      const endpoint = isPdf ? `${safeBaseUrl}/sendDocument` : `${safeBaseUrl}/sendPhoto`;
      const res = await fetch(endpoint, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        description?: string;
      };
      return {
        ok: Boolean(res.ok && json.ok),
        errorDescription: json.description,
      };
    }

    const res = await fetch(`${safeBaseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: captionText.slice(0, 4000),
      }),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
    };
    return {
      ok: Boolean(res.ok && json.ok),
      errorDescription: json.description,
    };
  } catch (err) {
    return {
      ok: false,
      errorDescription: err instanceof Error ? err.message : 'Telegram request failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use((_req, res, next) => {
    // Allow Firebase Google Sign-In popup communication on modern Android Chrome & iOS Safari
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    next();
  });
  // =========================================================================
  // ADMIN CATALOG AUTOMATIC IMAGE OPTIMIZATION & CONSISTENT DISPLAY BOX ROUTES
  // Mounted before global 2mb JSON limit with route-scoped 12mb cap for raw photos
  // =========================================================================
  const imageUploadJsonParser = express.json({ limit: '12mb' });
  const publicAssetsDir = path.resolve(__dirname, 'public');

  app.post('/api/admin/products/optimize-image', imageUploadJsonParser, async (req, res) => {
    const authCheck = await verifyFirebaseAdminRequest(req);
    if (!authCheck.ok) {
      res.status(authCheck.status).json({ ok: false, reason: authCheck.reason });
      return;
    }

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      imageInput?: unknown;
      boxSize?: unknown;
      paddingRatio?: unknown;
    };

    if (typeof body.imageInput !== 'string') {
      res.status(400).json({
        ok: false,
        reason: 'MISSING_IMAGE_INPUT',
        message: 'Field imageInput wajib berupa string URL atau data gambar.',
      });
      return;
    }

    const boxSize =
      typeof body.boxSize === 'number' && Number.isFinite(body.boxSize)
        ? body.boxSize
        : DEFAULT_DISPLAY_BOX_SIZE;
    const paddingRatio =
      typeof body.paddingRatio === 'number' && Number.isFinite(body.paddingRatio)
        ? body.paddingRatio
        : undefined;

    const outcome = await optimizeProductImageForDisplayBox(body.imageInput, {
      boxSize,
      paddingRatio,
      publicDir: publicAssetsDir,
    });

    if (!outcome.ok) {
      const status =
        outcome.reason === 'IMAGE_TOO_LARGE'
          ? 413
          : outcome.reason === 'RESTRICTED_HOST_BLOCKED' ||
              outcome.reason === 'RESTRICTED_IP_BLOCKED' ||
              outcome.reason === 'ONLY_HTTPS_URLS_ALLOWED'
            ? 400
            : 422;
      res.status(status).json(outcome);
      return;
    }

    res.json(outcome);
  });

  app.post('/api/admin/products/optimize-images-batch', imageUploadJsonParser, async (req, res) => {
    const authCheck = await verifyFirebaseAdminRequest(req);
    if (!authCheck.ok) {
      res.status(authCheck.status).json({ ok: false, reason: authCheck.reason });
      return;
    }

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      items?: unknown;
      boxSize?: unknown;
      paddingRatio?: unknown;
    };

    if (!Array.isArray(body.items) || body.items.length === 0) {
      res.status(400).json({ ok: false, reason: 'EMPTY_BATCH' });
      return;
    }

    const safeItems = body.items
      .slice(0, 25)
      .filter(
        (entry): entry is { key: string; imageInput: string } =>
          Boolean(entry) &&
          typeof entry === 'object' &&
          typeof (entry as { key?: unknown }).key === 'string' &&
          typeof (entry as { imageInput?: unknown }).imageInput === 'string'
      );

    const boxSize =
      typeof body.boxSize === 'number' && Number.isFinite(body.boxSize)
        ? body.boxSize
        : DEFAULT_DISPLAY_BOX_SIZE;
    const paddingRatio =
      typeof body.paddingRatio === 'number' && Number.isFinite(body.paddingRatio)
        ? body.paddingRatio
        : undefined;

    // Controlled concurrency (4 workers) so server memory & CPU stay flat
    const results: Array<Record<string, unknown>> = new Array(safeItems.length);
    let cursor = 0;
    const workerCount = Math.min(4, safeItems.length);

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (cursor < safeItems.length) {
          const idx = cursor;
          cursor += 1;
          const item = safeItems[idx];
          const outcome = await optimizeProductImageForDisplayBox(item.imageInput, {
            boxSize,
            paddingRatio,
            publicDir: publicAssetsDir,
          });
          results[idx] = { key: item.key, ...outcome };
        }
      })
    );

    res.json({
      ok: true,
      processed: results.length,
      results,
    });
  });

  app.use(
    express.json({
      limit: '2mb',
      verify: (req, _res, buf) => {
        (req as RequestWithRawBody).rawBody = buf.toString('utf8');
      },
    })
  );

  app.get('/api/telegram/status', (_req, res) => {
    const botToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const botUsername = (process.env.VITE_TELEGRAM_BOT_USERNAME || '')
      .trim()
      .replace(/^@+/, '');
    res.json({
      botConfigured: botToken.length > 15,
      botUsername,
    });
  });

  // =========================================================================
  // JOURNAL POS OFFICIAL API & WEBHOOK INTEGRATION ROUTES
  // Secrets stay strictly in server process.env (never exposed to browser)
  // =========================================================================
  app.get('/api/journal-pos/status', async (req, res) => {
    const authCheck = await verifyFirebaseAdminRequest(req);
    if (!authCheck.ok) {
      res.status(authCheck.status).json({ ok: false, reason: authCheck.reason });
      return;
    }

    const creds = getJournalPosServerCredentials();
    const hostHeader = cleanShortString(req.get('host') || '', 180);
    const proto =
      req.protocol === 'https' || hostHeader.endsWith('.run.app') ? 'https' : req.protocol || 'http';
    const rawOrigin = hostHeader
      ? `${proto}://${hostHeader}`
      : (process.env.APP_URL || '').trim();
    const shareableOrigin = rawOrigin.startsWith('https://ais-dev-')
      ? rawOrigin.replace(/^https:\/\/ais-dev-/, 'https://ais-pre-')
      : rawOrigin;

    res.json({
      ok: true,
      baseUrl: creds.baseUrl,
      apiKeyConfigured: creds.apiKey.length >= 6,
      apiSecretConfigured: creds.apiSecret.length >= 6,
      webhookSecretConfigured: creds.webhookSecret.length >= 8,
      signatureFormat: creds.signatureFormat,
      discoveredEndpoints: {
        ping: `${creds.baseUrl}/api/v1/ping`,
        products: `${creds.baseUrl}/api/v1/products`,
        requiredHeaders: ['X-Api-Key', 'X-Timestamp', 'X-Signature'],
      },
      webhookEndpointUrl: shareableOrigin
        ? `${shareableOrigin}/api/journal-pos/webhook`
        : '/api/journal-pos/webhook',
      pendingWebhookCount: pendingWebhookQueue.length,
      pollerStatus: getJournalPosServiceStatus(),
    });
  });

  app.post('/api/journal-pos/scheduler', async (req, res) => {
    const authCheck = await verifyFirebaseAdminRequest(req);
    if (!authCheck.ok) {
      res.status(authCheck.status).json({ ok: false, reason: authCheck.reason });
      return;
    }

    const body = (req.body || {}) as {
      enabled?: boolean;
      intervalSeconds?: number;
      signatureFormat?: string;
      exchangeRateKhr?: number;
      triggerNow?: boolean;
    };

    const safeRate =
      typeof body.exchangeRateKhr === 'number' &&
      Number.isFinite(body.exchangeRateKhr) &&
      body.exchangeRateKhr >= 1000
        ? body.exchangeRateKhr
        : undefined;

    if (body.triggerNow === true) {
      try {
        const cycleResult = await runJournalPosPollCycle(safeRate, {
          forceFirestoreWrite: true,
          actorEmail: authCheck.email,
        });
        res.json({
          ok: cycleResult.ok,
          message:
            cycleResult.firestoreSync?.summary ||
            cycleResult.message ||
            (cycleResult.ok
              ? `Pengambilan berkala berhasil (${cycleResult.records.length} produk).`
              : 'Pengambilan berkala gagal.'),
          pollerStatus: getJournalPosServiceStatus(),
          snapshot: getLatestPolledSnapshot(),
          firestoreSync: cycleResult.firestoreSync || null,
        });
      } catch (err) {
        res.status(500).json({
          ok: false,
          reason: 'SCHEDULER_SYNC_ERROR',
          message:
            err instanceof Error
              ? err.message
              : 'Gagal menjalankan sinkronisasi berkala server.',
          pollerStatus: getJournalPosServiceStatus(),
        });
      }
      return;
    }

    if (body.enabled === false) {
      const status = stopJournalPosPeriodicSync();
      res.json({ ok: true, pollerStatus: status });
      return;
    }

    const intervalSeconds = Number(body.intervalSeconds);
    const intervalMs =
      Number.isFinite(intervalSeconds) && intervalSeconds >= 30
        ? Math.min(3600, Math.round(intervalSeconds)) * 1000
        : 60_000;

    const status = startJournalPosPeriodicSync({
      intervalMs,
      signatureFormat: typeof body.signatureFormat === 'string' ? body.signatureFormat : undefined,
      exchangeRateKhr: safeRate,
      runImmediately: true,
    });
    res.json({ ok: true, pollerStatus: status });
  });

  app.get('/api/journal-pos/latest-snapshot', async (req, res) => {
    const authCheck = await verifyFirebaseAdminRequest(req);
    if (!authCheck.ok) {
      res.status(authCheck.status).json({ ok: false, reason: authCheck.reason });
      return;
    }

    res.json({
      ok: true,
      pollerStatus: getJournalPosServiceStatus(),
      snapshot: getLatestPolledSnapshot(),
    });
  });

  app.post('/api/journal-pos/test-connection', async (req, res) => {
    const authCheck = await verifyFirebaseAdminRequest(req);
    if (!authCheck.ok) {
      res.status(authCheck.status).json({ ok: false, reason: authCheck.reason });
      return;
    }

    const body = (req.body || {}) as { signatureFormat?: string };
    let creds;
    try {
      creds = getJournalPosServerCredentials(body.signatureFormat);
    } catch (err) {
      res.status(400).json({
        ok: false,
        connectionStatus: 'ERROR',
        reason: 'INVALID_BASE_URL',
        message: err instanceof Error ? err.message : 'Konfigurasi URL JOURNAL POS tidak valid.',
      });
      return;
    }

    if (!creds.apiKey || !creds.apiSecret) {
      res.json({
        ok: false,
        connectionStatus: 'ERROR',
        reason: 'CREDENTIALS_MISSING',
        message:
          'API Key dan API Secret JOURNAL POS belum diisi di panel Secrets server (JOURNAL_POS_API_KEY & JOURNAL_POS_API_SECRET). Endpoint resmi https://journal.alpa.gdn/web/api/v1/products mewajibkan header X-Api-Key, X-Timestamp, dan X-Signature.',
        endpointUrl: `${creds.baseUrl}/api/v1/ping`,
      });
      return;
    }

    const probed = await probeJournalPosSignatureFormat(creds);

    if (probed.ok) {
      // Automatically keep backend poller synced with the detected signature format
      startJournalPosPeriodicSync({
        signatureFormat: probed.detectedSignatureFormat,
        runImmediately: false,
      });
      res.json({
        ok: true,
        connectionStatus: 'ONLINE',
        httpStatus: probed.status,
        latencyMs: probed.latencyMs,
        endpointUrl: probed.endpointUrl,
        signatureFormat: probed.detectedSignatureFormat,
        detectedSignatureFormat: probed.detectedSignatureFormat,
        message: `Koneksi resmi ke JOURNAL POS berhasil (HTTP ${probed.status}, ${probed.latencyMs}ms · Format HMAC: ${probed.detectedSignatureFormat}).`,
      });
      return;
    }

    res.json({
      ok: false,
      connectionStatus: 'ERROR',
      httpStatus: probed.status,
      latencyMs: probed.latencyMs,
      endpointUrl: probed.endpointUrl,
      signatureFormat: creds.signatureFormat,
      reason: probed.status === 401 || probed.status === 403 ? 'UNAUTHORIZED' : 'API_ERROR',
      message: `JOURNAL POS menolak/gagal merespons (HTTP ${probed.status || 'NETWORK'}): ${probed.errorMessage || 'Periksa POS API Key dan POS API Secret yang disimpan di panel Secrets server.'}`,
    });
  });

  app.post('/api/journal-pos/fetch-products', async (req, res) => {
    const authCheck = await verifyFirebaseAdminRequest(req);
    if (!authCheck.ok) {
      res.status(authCheck.status).json({ ok: false, reason: authCheck.reason });
      return;
    }

    const body = (req.body || {}) as {
      signatureFormat?: string;
      sampleLimit?: number;
      exchangeRateKhr?: number;
      maxPages?: number;
    };

    const result = await fetchJournalPosProductsService({
      signatureFormat: body.signatureFormat,
      sampleLimit: body.sampleLimit,
      exchangeRateKhr: body.exchangeRateKhr,
      maxPages: body.maxPages,
    });

    if (!result.ok) {
      const statusCode =
        result.reason === 'INVALID_BASE_URL' || result.reason === 'CREDENTIALS_MISSING'
          ? 400
          : 502;
      res.status(statusCode).json(result);
      return;
    }

    res.json(result);
  });

  // End-to-End Secure Backend Sync: Fetches latest prices/stock from Journal POS and writes directly to Firestore
  app.post('/api/journal-pos/sync-now', async (req, res) => {
    try {
      const authCheck = await verifyFirebaseAdminRequest(req);
      if (!authCheck.ok) {
        res.status(authCheck.status).json({ ok: false, reason: authCheck.reason });
        return;
      }

      const body = (req.body || {}) as {
        signatureFormat?: string;
        sampleLimit?: number;
        exchangeRateKhr?: number;
        maxPages?: number;
        onlyChanged?: boolean;
        priceAndStockOnly?: boolean;
      };

      const fetchResult = await fetchJournalPosProductsService({
        signatureFormat: body.signatureFormat,
        sampleLimit: body.sampleLimit,
        exchangeRateKhr: body.exchangeRateKhr,
        maxPages: body.maxPages,
      });

      if (!fetchResult.ok) {
        const statusCode =
          fetchResult.reason === 'INVALID_BASE_URL' || fetchResult.reason === 'CREDENTIALS_MISSING'
            ? 400
            : 502;
        res.status(statusCode).json(fetchResult);
        return;
      }

      const creds = getJournalPosServerCredentials(body.signatureFormat);
      const firestoreSync = await syncJournalPosRecordsToFirestoreServer({
        records: fetchResult.records,
        parseErrors: fetchResult.parseErrors,
        trigger: body.sampleLimit && body.sampleLimit > 0 ? 'sample_test' : 'manual',
        actorEmail: authCheck.email,
        sourceBaseUrl: creds.baseUrl,
        signatureFormat: creds.signatureFormat,
        exchangeRateKhr: body.exchangeRateKhr,
        onlyChanged: Boolean(body.onlyChanged),
        priceAndStockOnly: Boolean(body.priceAndStockOnly),
      });

      res.json({
        ok: firestoreSync.ok,
        mode: firestoreSync.ok ? 'server_direct' : 'client_fallback',
        iamPermissionDenied: Boolean(firestoreSync.iamPermissionDenied),
        endpointUrl: fetchResult.endpointUrl,
        latencyMs: fetchResult.latencyMs,
        totalFetched: fetchResult.totalFetched,
        firestoreSync,
        pollerStatus: getJournalPosServiceStatus(),
        // Include mapped records only when server IAM is not yet granted so the signed-in Master UI can apply them cleanly
        records: firestoreSync.iamPermissionDenied ? fetchResult.records : undefined,
        parseErrors: fetchResult.parseErrors,
        message: firestoreSync.summary,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        reason: 'SYNC_NOW_INTERNAL_ERROR',
        message:
          err instanceof Error
            ? err.message
            : 'Terjadi gangguan internal saat menjalankan sinkronisasi Journal POS.',
      });
    }
  });

  app.post('/api/journal-pos/parse-json', async (req, res) => {
    const authCheck = await verifyFirebaseAdminRequest(req);
    if (!authCheck.ok) {
      res.status(authCheck.status).json({ ok: false, reason: authCheck.reason });
      return;
    }

    const body = (req.body || {}) as { rawJson?: string; exchangeRateKhr?: number };
    const rawText = typeof body.rawJson === 'string' ? body.rawJson.trim() : '';
    if (!rawText) {
      res.status(400).json({
        ok: false,
        message: 'Tempelkan atau unggah file export (JSON, CSV, atau TSV) dari JOURNAL POS terlebih dahulu.',
      });
      return;
    }

    let rawItems: Record<string, unknown>[] = [];
    let detectedFormat: 'json' | 'csv' = 'json';

    if (rawText.startsWith('{') || rawText.startsWith('[')) {
      try {
        const parsed = JSON.parse(rawText) as unknown;
        rawItems = extractRawProductsList(parsed);
        detectedFormat = 'json';
      } catch {
        res.status(400).json({
          ok: false,
          message: 'Format JSON tidak valid. Pastikan file export dari JOURNAL POS utuh.',
        });
        return;
      }
    } else {
      rawItems = parseJournalPosTabularText(rawText);
      detectedFormat = 'csv';
    }

    const creds = getJournalPosServerCredentials();
    const exchangeRateKhr =
      typeof body.exchangeRateKhr === 'number' && body.exchangeRateKhr >= 1000
        ? body.exchangeRateKhr
        : DEFAULT_EXCHANGE_RATE_KHR;

    if (rawItems.length === 0) {
      res.status(400).json({
        ok: false,
        message:
          'Tidak ditemukan daftar produk pada file tersebut. Gunakan file JSON atau CSV/TSV export produk dari JOURNAL POS.',
      });
      return;
    }

    const records: MappedJournalPosRecord[] = [];
    const parseErrors: string[] = [];
    for (let i = 0; i < Math.min(rawItems.length, 2000); i++) {
      const mapped = mapJournalPosRawProduct(rawItems[i], creds.baseUrl, exchangeRateKhr);
      if (mapped.ok) {
        records.push(mapped.record);
      } else {
        parseErrors.push(`Baris #${i + 1}: ${mapped.error}`);
      }
    }

    res.json({
      ok: true,
      detectedFormat,
      totalFetched: rawItems.length,
      records,
      parseErrors,
    });
  });

  // Real-Time Webhook Receiver from JOURNAL POS (HMAC-SHA256 verified -> Direct Firestore Auto-Update)
  app.post('/api/journal-pos/webhook', async (req, res) => {
    const creds = getJournalPosServerCredentials();
    const rawBody = (req as RequestWithRawBody).rawBody || JSON.stringify(req.body || {});
    const signatureHeader =
      req.get('x-signature') ||
      req.get('x-webhook-signature') ||
      req.get('x-hub-signature-256') ||
      '';
    const timestampHeader = req.get('x-timestamp') || req.get('x-webhook-timestamp') || '';

    const verification = verifyWebhookSignature({
      rawBody,
      signatureHeader,
      timestampHeader,
      webhookSecret: creds.webhookSecret,
    });

    if (!verification.valid) {
      const statusCode = verification.reason === 'WEBHOOK_SECRET_NOT_CONFIGURED' ? 503 : 401;
      res.status(statusCode).json({
        ok: false,
        reason: verification.reason || 'INVALID_SIGNATURE',
      });
      return;
    }

    const rawItems = extractRawProductsList(req.body);
    if (rawItems.length === 0) {
      res.status(400).json({ ok: false, reason: 'NO_PRODUCT_DATA' });
      return;
    }

    const records: MappedJournalPosRecord[] = [];
    const parseErrors: string[] = [];
    for (let i = 0; i < Math.min(rawItems.length, 200); i++) {
      const mapped = mapJournalPosRawProduct(rawItems[i], creds.baseUrl, DEFAULT_EXCHANGE_RATE_KHR);
      if (mapped.ok) {
        records.push(mapped.record);
      } else {
        parseErrors.push(`Webhook #${i + 1}: ${mapped.error}`);
      }
    }

    const bodyObj = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const eventType = cleanShortString(bodyObj.event || bodyObj.type || 'product.updated', 60) || 'product.updated';
    const eventId = `wh_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    // Attempt immediate server-side Firestore sync so all portals update instantly without any browser open
    let appliedDirectToFirestore = false;
    let directSummary = '';
    if (records.length > 0) {
      const syncResult = await syncJournalPosRecordsToFirestoreServer({
        records,
        parseErrors,
        trigger: 'webhook',
        actorEmail: 'journal-pos-webhook@system',
        sourceBaseUrl: creds.baseUrl,
        signatureFormat: creds.signatureFormat,
        onlyChanged: true,
      });
      appliedDirectToFirestore = syncResult.ok;
      directSummary = syncResult.summary;
    }

    // Queue fallback only if direct server Firestore write could not complete (e.g. IAM pending)
    if (!appliedDirectToFirestore) {
      pendingWebhookQueue.push({
        eventId,
        receivedAt: new Date().toISOString(),
        eventType,
        records,
        parseErrors,
      });
      if (pendingWebhookQueue.length > MAX_PENDING_WEBHOOK_EVENTS) {
        pendingWebhookQueue.splice(0, pendingWebhookQueue.length - MAX_PENDING_WEBHOOK_EVENTS);
      }
    }

    res.json({
      ok: true,
      eventId,
      appliedDirectToFirestore,
      summary: directSummary || undefined,
      acceptedRecords: records.length,
      parseErrorsCount: parseErrors.length,
    });
  });

  app.get('/api/journal-pos/webhook-events', async (req, res) => {
    const authCheck = await verifyFirebaseAdminRequest(req);
    if (!authCheck.ok) {
      res.status(authCheck.status).json({ ok: false, reason: authCheck.reason });
      return;
    }
    res.json({
      ok: true,
      events: pendingWebhookQueue,
    });
  });

  app.post('/api/journal-pos/webhook-events/ack', async (req, res) => {
    const authCheck = await verifyFirebaseAdminRequest(req);
    if (!authCheck.ok) {
      res.status(authCheck.status).json({ ok: false, reason: authCheck.reason });
      return;
    }
    const body = (req.body || {}) as { eventIds?: unknown };
    const ackIds = new Set(
      Array.isArray(body.eventIds)
        ? body.eventIds.filter((id): id is string => typeof id === 'string')
        : []
    );
    for (let i = pendingWebhookQueue.length - 1; i >= 0; i--) {
      if (ackIds.has(pendingWebhookQueue[i].eventId)) {
        pendingWebhookQueue.splice(i, 1);
      }
    }
    res.json({ ok: true, remaining: pendingWebhookQueue.length });
  });

  const resolveSafeZipOrigin = (req: express.Request): string => {
    const rawQueryOrigin = cleanShortString(req.query.origin, 260);
    if (rawQueryOrigin && /^https?:\/\//i.test(rawQueryOrigin)) {
      try {
        const parsed = new URL(rawQueryOrigin);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
          const cleanOrigin = parsed.origin;
          return cleanOrigin.startsWith('https://ais-dev-')
            ? cleanOrigin.replace(/^https:\/\/ais-dev-/, 'https://ais-pre-')
            : cleanOrigin;
        }
      } catch {
        // fall back to request host
      }
    }

    const hostHeader = cleanShortString(req.get('host') || '', 180);
    const proto =
      req.protocol === 'https' || hostHeader.endsWith('.run.app')
        ? 'https'
        : req.protocol || 'http';
    const rawOrigin = hostHeader
      ? `${proto}://${hostHeader}`
      : (process.env.APP_URL || 'https://alpamart.trimuia.online').trim();
    return rawOrigin.startsWith('https://ais-dev-')
      ? rawOrigin.replace(/^https:\/\/ais-dev-/, 'https://ais-pre-')
      : rawOrigin;
  };

  const sendMobileCompatibleZipResponse = (
    res: express.Response,
    bytes: Uint8Array,
    rawFilename: string
  ): void => {
    const cleaned = (rawFilename || '')
      .trim()
      .replace(/[\r\n\t\\/:"*?<>|]+/g, '-')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '');
    const safeBase = cleaned || 'alpamart-portal';
    const safeFilename = safeBase.toLowerCase().endsWith('.zip')
      ? safeBase
      : `${safeBase}.zip`;

    const zipBuffer = Buffer.from(bytes);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(zipBuffer.length));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`
    );
    res.setHeader('Content-Transfer-Encoding', 'binary');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Disposition, Content-Length, Content-Type'
    );
    res.status(200).send(zipBuffer);
  };

  const collectDistFilesRecursive = (
    rootDir: string,
    currentDir: string,
    out: { relPath: string; fullPath: string }[]
  ): void => {
    const items = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const item of items) {
      if (item.name === '.DS_Store' || item.name.endsWith('.map')) continue;
      const fullPath = path.join(currentDir, item.name);
      const relPath = path.relative(rootDir, fullPath).split(path.sep).join('/');
      if (relPath === 'src' || relPath.startsWith('src/')) continue;
      if (item.isDirectory()) {
        collectDistFilesRecursive(rootDir, fullPath, out);
      } else if (item.isFile()) {
        out.push({ relPath, fullPath });
      }
    }
  };

  const escapeHtmlAttr = (raw: string): string =>
    raw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const toCompressedZipEntry = (
    name: string,
    content: string | Uint8Array
  ): ZipEntry => {
    const rawBuf =
      content instanceof Uint8Array
        ? Buffer.from(content.buffer, content.byteOffset, content.byteLength)
        : Buffer.from(content, 'utf-8');
    const lower = name.toLowerCase();
    const alreadyCompressed =
      lower.endsWith('.jpg') ||
      lower.endsWith('.jpeg') ||
      lower.endsWith('.png') ||
      lower.endsWith('.webp') ||
      lower.endsWith('.gif') ||
      lower.endsWith('.woff2') ||
      lower.endsWith('.zip');
    if (alreadyCompressed || rawBuf.length < 256) {
      return { name, content: new Uint8Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength), method: 0 };
    }
    try {
      const deflated = zlib.deflateRawSync(rawBuf, { level: 6 });
      if (deflated.length < rawBuf.length) {
        return {
          name,
          content: new Uint8Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength),
          compressed: new Uint8Array(deflated.buffer, deflated.byteOffset, deflated.byteLength),
          method: 8,
        };
      }
    } catch {
      // fall back to STORE
    }
    return { name, content: new Uint8Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength), method: 0 };
  };

  const buildStandaloneDistPortalZip = (opts: {
    portal: PortalZipTarget;
    storeName: string;
    storeTagline?: string;
    origin: string;
  }): { bytes: Uint8Array; filename: string; isStandalone: boolean } => {
    const distDir = path.resolve(__dirname, 'dist');
    const distIndexPath = path.join(distDir, 'index.html');
    if (!fs.existsSync(distIndexPath)) {
      const fallback = buildSinglePortalDomainZipPackage(opts);
      return { bytes: fallback.bytes, filename: fallback.filename, isStandalone: false };
    }

    const meta = PORTAL_META[opts.portal];
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const buildDisplay = `${y}-${m}-${d} ${hh}:${mm}`;

    const pageTitle = meta.titlePrefix
      ? `${meta.titlePrefix}${opts.storeName}`
      : `${opts.storeName} — Toko Online Resmi`;
    const pageDesc =
      opts.portal === 'customer' && opts.storeTagline?.trim()
        ? opts.storeTagline.trim()
        : meta.defaultDesc(opts.storeName);

    const targetDirectUrl = meta.portalQuery
      ? `${opts.origin}/?portal=${meta.portalQuery}`
      : `${opts.origin}/`;

    const lockedBootScript = `<script>window.__ALPAMART_LOCKED_PORTAL__=${JSON.stringify(
      opts.portal
    )};window.__ALPAMART_STANDALONE_BUILD__=${JSON.stringify(buildDisplay)};</script>`;

    const bootPlaceholderHtml = `<div data-alpamart-boot="1" style="min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#0f172a;text-align:center;"><div style="width:36px;height:36px;border:3px solid #e2e8f0;border-top-color:${meta.themeColor};border-radius:50%;animation:alpSpin 0.8s linear infinite;margin-bottom:14px;"></div><div style="font-size:15px;font-weight:700;">${escapeHtmlAttr(pageTitle)}</div><div style="font-size:12px;color:#64748b;margin-top:4px;">Memuat website toko secara real-time...</div><style>@keyframes alpSpin{to{transform:rotate(360deg)}}</style></div>`;

    const localFileGuardScript = `<script>
      (function () {
        var root = document.getElementById('root');
        if (!root) return;
        function renderHelpCard(badge, heading, bodyHtml, extraHtml) {
          root.innerHTML =
            '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#0f172a;">' +
            '<div style="max-width:490px;width:100%;background:#ffffff;border:1px solid #cbd5e1;border-radius:16px;overflow:hidden;box-shadow:0 12px 30px rgba(15,23,42,0.08);">' +
            '<div style="height:6px;background:${meta.themeColor};"></div>' +
            '<div style="padding:24px;">' +
            '<p style="font-size:12px;font-weight:700;color:${meta.themeColor};margin:0 0 6px;">' + badge + '</p>' +
            '<h1 style="font-size:19px;font-weight:700;margin:0 0 10px;line-height:1.3;">' + heading + '</h1>' +
            '<p style="font-size:13px;color:#475569;line-height:1.6;margin:0 0 14px;">' + bodyHtml + '</p>' +
            extraHtml +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;">' +
            '<a href="${escapeHtmlAttr(targetDirectUrl)}" style="flex:1;min-width:170px;text-align:center;background:${meta.themeColor};color:#ffffff;padding:11px 16px;border-radius:10px;font-size:13px;font-weight:700;text-decoration:none;">Buka Website Online</a>' +
            '<a href="https://app.netlify.com/drop" target="_blank" rel="noopener noreferrer" style="text-align:center;background:#0f172a;color:#ffffff;padding:11px 16px;border-radius:10px;font-size:13px;font-weight:700;text-decoration:none;">Buka Netlify Drop</a>' +
            '</div></div></div></div>';
        }
        if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') {
          renderHelpCard(
            '${escapeHtmlAttr(meta.label)} · Full Hosting (${buildDisplay})',
            '${escapeHtmlAttr(pageTitle)}',
            'File <strong>index.html</strong> ini dibuka langsung dari penyimpanan HP/PC (<code>file://</code>). Browser memblokir script website dari folder lokal sehingga perlu di-upload ke hosting HTTPS (Netlify / Vercel / cPanel) agar toko tampil penuh.',
            '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px;font-size:12px;color:#334155;line-height:1.6;margin-bottom:16px;">' +
            '<strong>Cara pasang cepat (gratis):</strong><br/>' +
            '1. Ekstrak file ZIP menjadi 1 folder (pastikan langsung berisi <code>index.html</code> dan folder <code>assets</code>).<br/>' +
            '2. Upload <strong>folder hasil ekstrak</strong> ke tab <strong>Deploys</strong> di situs Netlify Anda (atau <strong>app.netlify.com/drop</strong> / cPanel <code>public_html</code>).' +
            '</div>'
          );
          return;
        }
        window.setTimeout(function () {
          if (root.querySelector('[data-alpamart-boot="1"]') || root.childElementCount === 0) {
            renderHelpCard(
              'Periksa Upload Folder Hosting · ${escapeHtmlAttr(meta.label)}',
              'Folder Aset Website Belum Terpasang Lengkap',
              'Halaman <strong>index.html</strong> sudah terbuka, tetapi file aplikasi di folder <code>assets/</code> tidak ditemukan atau koneksi sedang terputus.',
              '<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:12px;font-size:12px;color:#9a3412;line-height:1.6;margin-bottom:16px;">' +
              '<strong>Solusi cepat:</strong> Pastikan saat upload ke Netlify / cPanel, Anda meng-upload <strong>seluruh isi folder hasil ekstrak ZIP</strong> (file <code>index.html</code> + folder <code>assets</code> secara bersamaan), bukan hanya 1 file <code>index.html</code> saja.' +
              '</div>'
            );
          }
        }, 7000);
      })();
    </script>`;

    let html = fs.readFileSync(distIndexPath, 'utf-8');
    html = html.replace(/<head>/i, `<head>\n    ${lockedBootScript}`);
    html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtmlAttr(pageTitle)}</title>`);
    html = html.replace(
      /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i,
      `<meta name="description" content="${escapeHtmlAttr(pageDesc)}" />`
    );
    html = html.replace(
      /<meta\s+property="og:title"\s+content="[^"]*"\s*\/?>/i,
      `<meta property="og:title" content="${escapeHtmlAttr(pageTitle)}" />`
    );
    html = html.replace(
      /<meta\s+property="og:description"\s+content="[^"]*"\s*\/?>/i,
      `<meta property="og:description" content="${escapeHtmlAttr(pageDesc)}" />`
    );
    html = html.replace(
      /<div id="root"><\/div>/i,
      `<div id="root">${bootPlaceholderHtml}</div>\n    ${localFileGuardScript}`
    );

    const entries: ZipEntry[] = [];
    const distFiles: { relPath: string; fullPath: string }[] = [];
    collectDistFilesRecursive(distDir, distDir, distFiles);

    for (const file of distFiles) {
      if (file.relPath === '_redirects') continue;
      if (file.relPath === 'index.html') {
        entries.push(toCompressedZipEntry('index.html', html));
      } else {
        const buf = fs.readFileSync(file.fullPath);
        entries.push(
          toCompressedZipEntry(
            file.relPath,
            new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
          )
        );
      }
    }

    const redirectsFile = `/* /index.html 200\n`;
    const netlifyToml = `[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200

[[headers]]
  for = "/index.html"
  [headers.values]
    Cache-Control = "no-cache, no-store, must-revalidate"
`;
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
      `PAKET FULL WEBSITE MANDIRI — ${meta.label.toUpperCase()}`,
      `Versi Build: ${buildDisplay}`,
      `====================================================================`,
      ``,
      `ISI ZIP INI ADALAH WEBSITE LENGKAP (TANPA IFRAME & ANTI BLOKIR BROWSER):`,
      `- Sudah berisi index.html + seluruh file aplikasi (/assets/*) yang langsung`,
      `  tersambung ke database Firebase toko secara REAL-TIME.`,
      `- Bebas dipasang di domain custom Anda sendiri (Netlify Drop, Vercel,`,
      `  Cloudflare Pages, atau cPanel public_html).`,
      ``,
      `CARA PASANG YANG BENAR (PENTING!):`,
      `1. EKSTRAK FILE ZIP INI TERLEBIH DAHULU MENJADI 1 FOLDER.`,
      `   Pastikan di dalam folder tersebut langsung ada file "index.html" dan folder "assets".`,
      `2. UPLOAD FOLDER HASIL EKSTRAK:`,
      `   - NETLIFY: Buka situs Netlify Anda -> tab Deploys -> tarik FOLDER hasil ekstrak`,
      `     ke kotak "Need to update your site? Drag and drop your site output folder here"`,
      `     (atau buat baru di https://app.netlify.com/drop).`,
      `   - CPANEL: Upload file ZIP ini ke folder public_html -> klik Extract -> pastikan`,
      `     index.html dan folder assets berada langsung di public_html.`,
      ``,
      `LINK CADANGAN SERVER PUBLIK:`,
      `${targetDirectUrl}`,
    ].join('\r\n');

    entries.push(
      toCompressedZipEntry('_redirects', redirectsFile),
      toCompressedZipEntry('netlify.toml', netlifyToml),
      toCompressedZipEntry('vercel.json', vercelJson),
      toCompressedZipEntry('.htaccess', htaccess),
      toCompressedZipEntry('htaccess_cpanel.txt', htaccess),
      toCompressedZipEntry('BUKA_WEBSITE_DISINI.txt', openDirectTxt),
      toCompressedZipEntry(meta.guideFile, openDirectTxt)
    );

    const bytes = buildZipArchiveBytes(entries);
    const safeSlug =
      opts.storeName
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 32) || 'ALPAMART_TRIMULIA';
    const filename = `${safeSlug}_${meta.fileTag}_FullHosting_${y}-${m}-${d}_${hh}${mm}.zip`;

    return { bytes, filename, isStandalone: true };
  };

  app.get('/api/download-portal-zip', (req, res) => {
    const shareableOrigin = resolveSafeZipOrigin(req);
    const storeName =
      cleanShortString(req.query.storeName, 80) || 'ALPAMART TRIMULIA ONLAINE';
    const storeTagline = cleanShortString(req.query.storeTagline, 140) || undefined;

    const rawPortal = String(req.query.portal || 'customer').trim().toLowerCase();
    const portalTarget: PortalZipTarget =
      rawPortal === 'delivery' || rawPortal === 'deliveri'
        ? 'delivery'
        : rawPortal === 'admin'
          ? 'admin'
          : rawPortal === 'master'
            ? 'master'
            : 'customer';

    const pkg = buildStandaloneDistPortalZip({
      portal: portalTarget,
      storeName,
      storeTagline,
      origin: shareableOrigin,
    });

    res.setHeader(
      'X-Zip-Mode',
      pkg.isStandalone ? 'standalone-full-app' : 'redirect-launcher'
    );
    sendMobileCompatibleZipResponse(res, pkg.bytes, pkg.filename);
  });

  const isPrivateOrReservedIp = (ip: string): boolean => {
    const clean = ip.trim().toLowerCase();
    if (!clean) return true;
    if (clean === '::1' || clean === '::' || clean.startsWith('fe80:') || clean.startsWith('fc') || clean.startsWith('fd')) {
      return true;
    }
    const v4Mapped = clean.startsWith('::ffff:') ? clean.slice(7) : clean;
    if (net.isIPv4(v4Mapped)) {
      const parts = v4Mapped.split('.').map(Number);
      if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
      const [a, b] = parts;
      if (a === 0 || a === 10 || a === 127) return true;
      if (a === 169 && b === 254) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 100 && b >= 64 && b <= 127) return true;
      if (a >= 224) return true;
      return false;
    }
    return false;
  };

  app.get('/api/check-domain-live', async (req, res) => {
    const rawUrl = String(req.query.url || '').trim().slice(0, 240);
    if (!rawUrl || !/^https:\/\//i.test(rawUrl)) {
      res.status(400).json({
        ok: false,
        reachable: false,
        reason: 'INVALID_URL',
        message: 'URL wajib diawali https:// dan memiliki nama domain yang valid.',
      });
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      res.status(400).json({
        ok: false,
        reachable: false,
        reason: 'INVALID_URL',
        message: 'Format URL tidak valid.',
      });
      return;
    }

    const hostname = parsed.hostname.toLowerCase();
    if (
      !hostname ||
      !hostname.includes('.') ||
      hostname === 'localhost' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      net.isIP(hostname) !== 0
    ) {
      res.status(400).json({
        ok: false,
        reachable: false,
        reason: 'INVALID_HOST',
        message: 'Gunakan domain publik HTTPS yang valid (bukan IP lokal atau localhost).',
      });
      return;
    }

    try {
      const lookupResults = await dns.promises.lookup(hostname, { all: true });
      if (!lookupResults.length || lookupResults.some((item) => isPrivateOrReservedIp(item.address))) {
        res.status(200).json({
          ok: true,
          reachable: false,
          reason: 'DNS_NOT_FOUND',
          message: `Domain ${hostname} belum diarahkan ke server publik di internet.`,
        });
        return;
      }
    } catch {
      res.status(200).json({
        ok: true,
        reachable: false,
        reason: 'DNS_NOT_FOUND',
        message: `Domain ${hostname} belum terdaftar di DNS internet atau belum terpasang di hosting (Netlify / Vercel / cPanel).`,
      });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const probe = await fetch(parsed.origin, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'AlpamartTrimuliaUrlCheck/1.0' },
      });
      const isOk = probe.status >= 200 && probe.status < 400;
      let htmlSnippet = '';
      if (isOk) {
        try {
          htmlSnippet = (await probe.text()).slice(0, 12000);
        } catch {
          htmlSnippet = '';
        }
      }
      clearTimeout(timer);

      const isLegacyBlockedIframe =
        isOk &&
        htmlSnippet.includes('id="portal-frame"') &&
        htmlSnippet.includes('ais-pre-');

      if (isLegacyBlockedIframe) {
        res.status(200).json({
          ok: true,
          reachable: false,
          status: probe.status,
          reason: 'LEGACY_BLOCKED_IFRAME',
          message: `Domain ${hostname} masih berisi file ZIP LAMA (mode iframe yang diblokir browser). Download ulang ZIP Full Website Mandiri terbaru di bawah, ekstrak menjadi 1 folder, lalu upload ulang (timpa) ke tab Deploys Netlify / cPanel Anda!`,
        });
        return;
      }

      res.status(200).json({
        ok: true,
        reachable: isOk,
        status: probe.status,
        reason: isOk ? 'ONLINE' : 'HTTP_ERROR',
        message: isOk
          ? `Domain ${hostname} AKTIF di internet (HTTP ${probe.status}) dan siap dibuka di browser.`
          : `Domain ${hostname} merespons HTTP ${probe.status} (halaman belum terpasang dengan benar di hosting).`,
      });
    } catch (err) {
      clearTimeout(timer);
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      res.status(200).json({
        ok: true,
        reachable: false,
        reason: isTimeout ? 'TIMEOUT' : 'UNREACHABLE',
        message: isTimeout
          ? `Server ${hostname} tidak merespons (timeout). Pastikan hosting & SSL HTTPS sudah aktif.`
          : `Tidak dapat terhubung ke ${hostname} via HTTPS. Pastikan SSL/HTTPS dan hosting sudah aktif.`,
      });
    }
  });

  app.get('/api/download-customer-domain-zip', (req, res) => {
    const shareableOrigin = resolveSafeZipOrigin(req);
    const storeName =
      cleanShortString(req.query.storeName, 80) || 'ALPAMART TRIMULIA ONLAINE';
    const storeTagline = cleanShortString(req.query.storeTagline, 140) || undefined;

    const queryPortal = String(req.query.portal || req.query.site || '')
      .trim()
      .toLowerCase();
    let activePortal: PortalZipTarget =
      queryPortal === 'delivery' || queryPortal === 'deliveri'
        ? 'delivery'
        : queryPortal === 'admin'
          ? 'admin'
          : queryPortal === 'master'
            ? 'master'
            : 'customer';

    if (!queryPortal) {
      const refHeader = String(req.get('referer') || '');
      try {
        if (refHeader) {
          const refUrl = new URL(refHeader);
          const refPortal = (
            refUrl.searchParams.get('portal') ||
            refUrl.searchParams.get('site') ||
            ''
          ).toLowerCase();
          const refPath = refUrl.pathname.toLowerCase();
          if (refPortal === 'master' || refPath.startsWith('/master')) {
            activePortal = 'master';
          } else if (refPortal === 'admin' || refPath.startsWith('/admin')) {
            activePortal = 'admin';
          } else if (
            refPortal === 'delivery' ||
            refPortal === 'deliveri' ||
            refPath.startsWith('/delivery') ||
            refPath.startsWith('/deliveri')
          ) {
            activePortal = 'delivery';
          }
        }
      } catch {
        // default to customer
      }
    }

    const pkg = buildStandaloneDistPortalZip({
      portal: activePortal,
      storeName,
      storeTagline,
      origin: shareableOrigin,
    });

    res.setHeader(
      'X-Zip-Mode',
      pkg.isStandalone ? 'standalone-full-app' : 'redirect-launcher'
    );
    sendMobileCompatibleZipResponse(res, pkg.bytes, pkg.filename);
  });

  const autoImageRateMap = new Map<string, { count: number; resetAt: number }>();
  const checkAutoImageRateLimit = (ip: string): boolean => {
    const now = Date.now();
    const existing = autoImageRateMap.get(ip);
    if (!existing || now > existing.resetAt) {
      autoImageRateMap.set(ip, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    if (existing.count >= 240) return false;
    existing.count += 1;
    return true;
  };

  app.get('/api/catalog/alpamartkps-status', async (req, res) => {
    const clientIp = req.ip || 'unknown';
    if (!checkAutoImageRateLimit(clientIp)) {
      res.status(429).json({
        ok: false,
        reason: 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.',
      });
      return;
    }
    try {
      const forceRefresh = String(req.query.refresh || '') === '1';
      const { getAlpamartKpsCatalogIndex } = await import(
        './src/lib/serverAlpamartKpsImageSync.ts'
      );
      const index = await getAlpamartKpsCatalogIndex(forceRefresh);
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        sourceUrl: 'https://alpamartkps.store/',
        totalProductsIndexed: index.entries.length,
        totalPages: index.totalPages,
        fetchedAt: new Date(index.fetchedAt).toISOString(),
      });
    } catch {
      res.status(500).json({
        ok: false,
        reason: 'Gagal memuat indeks foto dari alpamartkps.store.',
      });
    }
  });

  app.post('/api/catalog/alpamartkps-match-batch', async (req, res) => {
    const clientIp = req.ip || 'unknown';
    if (!checkAutoImageRateLimit(clientIp)) {
      res.status(429).json({
        ok: false,
        reason: 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.',
      });
      return;
    }

    try {
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
        items?: unknown;
        strictBarcodeOnly?: unknown;
      };
      if (!Array.isArray(body.items) || body.items.length === 0) {
        res.status(400).json({ ok: false, reason: 'EMPTY_ITEMS' });
        return;
      }

      const strictBarcodeOnly = Boolean(body.strictBarcodeOnly);
      const boundedItems = body.items.slice(0, 3000);
      const { getAlpamartKpsCatalogIndex, matchProductInAlpamartKpsIndex } = await import(
        './src/lib/serverAlpamartKpsImageSync.ts'
      );
      const index = await getAlpamartKpsCatalogIndex(false);

      const matches: Array<{
        index: number;
        id: string;
        imageUrl: string;
        matchedName: string;
        matchedBarcode: string;
        confidence: 'exact_barcode' | 'exact_kps_name' | 'verified_name';
        source: string;
      }> = [];

      for (let i = 0; i < boundedItems.length; i++) {
        const rawItem = boundedItems[i];
        if (!rawItem || typeof rawItem !== 'object') continue;
        const item = rawItem as {
          id?: unknown;
          barcode?: unknown;
          sku?: unknown;
          name?: unknown;
        };
        const hit = matchProductInAlpamartKpsIndex(index, {
          barcode: cleanShortString(item.barcode, 40),
          sku: cleanShortString(item.sku, 40),
          name: cleanShortString(item.name, 140),
          strictBarcodeOnly,
        });
        if (
          hit &&
          hit.entry.imageUrl.startsWith('https://alpamartkps.store/uploads/p/') &&
          hit.entry.imageUrl.length <= 1000
        ) {
          matches.push({
            index: i,
            id: cleanShortString(item.id, 120),
            imageUrl: hit.entry.imageUrl,
            matchedName: hit.entry.name,
            matchedBarcode: hit.matchedBarcode || hit.entry.code,
            confidence: hit.confidence,
            source: hit.sourceLabel,
          });
        }
      }

      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        sourceUrl: 'https://alpamartkps.store/',
        totalKpsIndexed: index.entries.length,
        totalPages: index.totalPages,
        requestedCount: boundedItems.length,
        matchedCount: matches.length,
        matches,
      });
    } catch {
      res.status(500).json({
        ok: false,
        reason: 'Gagal mencocokkan batch foto dari alpamartkps.store.',
      });
    }
  });

  app.post('/api/catalog/auto-fetch-product-image', async (req, res) => {
    const clientIp = req.ip || 'unknown';
    if (!checkAutoImageRateLimit(clientIp)) {
      res.status(429).json({
        ok: false,
        found: false,
        reason: 'Terlalu banyak permintaan pencarian foto. Tunggu 1 menit lalu lanjutkan.',
      });
      return;
    }

    try {
      const body = (req.body || {}) as {
        barcode?: unknown;
        sku?: unknown;
        name?: unknown;
        category?: unknown;
        strictBarcodeOnly?: unknown;
        kpsOnly?: unknown;
      };
      const outcome = await autoFetchCatalogProductImage({
        barcode: cleanShortString(body.barcode, 40),
        sku: cleanShortString(body.sku, 40),
        name: cleanShortString(body.name, 120),
        category: cleanShortString(body.category, 60),
        strictBarcodeOnly: Boolean(body.strictBarcodeOnly),
        kpsOnly: Boolean(body.kpsOnly),
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json(outcome);
    } catch {
      res.status(500).json({
        ok: false,
        found: false,
        reason: 'Terjadi gangguan saat mencari foto produk otomatis.',
      });
    }
  });

  app.post('/api/telegram/notify-delivered', async (req, res) => {
    const clientIp = req.ip || 'unknown';
    if (!checkRateLimit(clientIp)) {
      res.status(429).json({
        ok: false,
        sentViaBot: false,
        sentToCustomer: false,
        sentToAdminGroup: false,
        reason: 'RATE_LIMITED',
      });
      return;
    }

    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ ok: false, reason: 'INVALID_BODY' });
      return;
    }

    const orderId = cleanShortString(body.orderId, 80);
    const orderNumber = cleanShortString(body.orderNumber, 40);
    const feedKey = cleanShortString(body.feedKey, 80);
    const customerName = cleanShortString(body.customerName, 120);
    const customerPhone = cleanShortString(body.customerPhone, 80);
    const messageText = cleanShortString(body.messageText, 1200);
    const proofDataUrl = typeof body.proofDataUrl === 'string' ? body.proofDataUrl.trim() : '';
    const forceResend = body.forceResend === true;

    if (!orderId || !orderNumber || !customerName || !customerPhone || !messageText) {
      res.status(400).json({ ok: false, reason: 'MISSING_FIELDS' });
      return;
    }

    if (!FEED_KEY_PATTERN.test(feedKey)) {
      res.status(403).json({ ok: false, reason: 'UNAUTHORIZED_DELIVERY_KEY' });
      return;
    }

    if (proofDataUrl) {
      if (proofDataUrl.length > 420_000 || !PROOF_DATA_URL_PATTERN.test(proofDataUrl)) {
        res.status(400).json({ ok: false, reason: 'INVALID_PROOF_ATTACHMENT' });
        return;
      }
    }

    const botToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const adminChatId = (process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();
    const botUsername = (process.env.VITE_TELEGRAM_BOT_USERNAME || '')
      .trim()
      .replace(/^@+/, '');

    if (!botToken || botToken.length < 15) {
      res.json({
        ok: true,
        sentViaBot: false,
        sentToCustomer: false,
        sentToAdminGroup: false,
        botConfigured: false,
        botUsername,
        reason: 'BOT_NOT_CONFIGURED',
      });
      return;
    }

    // Prevent accidental double-tap duplicates within 12 seconds unless explicit resend
    const lastSent = orderLastSentAt.get(orderId) || 0;
    if (!forceResend && Date.now() - lastSent < 12_000) {
      res.json({
        ok: true,
        sentViaBot: true,
        sentToCustomer: true,
        sentToAdminGroup: Boolean(adminChatId),
        botConfigured: true,
        botUsername,
        reason: 'ALREADY_SENT_RECENTLY',
      });
      return;
    }

    const lookup = normalizeTelegramLookup(customerPhone);
    let resolvedChatId = '';

    // 1. Try direct numeric Telegram Chat ID if customer entered one
    if (lookup.directChatId) {
      resolvedChatId = lookup.directChatId;
    }

    // 2. Otherwise inspect cached Bot getUpdates (username, shared phone contact, or /start orderNumber)
    if (!resolvedChatId) {
      await refreshTelegramDirectory(botToken, false);
      if (lookup.usernameLower && directoryCache.byUsername.has(lookup.usernameLower)) {
        resolvedChatId = directoryCache.byUsername.get(lookup.usernameLower) || '';
      } else if (lookup.phoneDigits && directoryCache.byPhoneDigits.has(lookup.phoneDigits)) {
        resolvedChatId = directoryCache.byPhoneDigits.get(lookup.phoneDigits) || '';
      } else if (
        lookup.phoneDigits.length >= 9 &&
        directoryCache.byPhoneDigits.has(lookup.phoneDigits.slice(-9))
      ) {
        resolvedChatId = directoryCache.byPhoneDigits.get(lookup.phoneDigits.slice(-9)) || '';
      } else if (directoryCache.byOrderRef.has(orderNumber.toLowerCase())) {
        resolvedChatId = directoryCache.byOrderRef.get(orderNumber.toLowerCase()) || '';
      }
    }

    // Refresh once more if not found yet (in case customer just started the bot moments ago)
    if (!resolvedChatId) {
      await refreshTelegramDirectory(botToken, true);
      if (lookup.usernameLower && directoryCache.byUsername.has(lookup.usernameLower)) {
        resolvedChatId = directoryCache.byUsername.get(lookup.usernameLower) || '';
      } else if (lookup.phoneDigits && directoryCache.byPhoneDigits.has(lookup.phoneDigits)) {
        resolvedChatId = directoryCache.byPhoneDigits.get(lookup.phoneDigits) || '';
      } else if (
        lookup.phoneDigits.length >= 9 &&
        directoryCache.byPhoneDigits.has(lookup.phoneDigits.slice(-9))
      ) {
        resolvedChatId = directoryCache.byPhoneDigits.get(lookup.phoneDigits.slice(-9)) || '';
      } else if (directoryCache.byOrderRef.has(orderNumber.toLowerCase())) {
        resolvedChatId = directoryCache.byOrderRef.get(orderNumber.toLowerCase()) || '';
      }
    }

    let sentToCustomer = false;
    let customerReason = 'CUSTOMER_BOT_CHAT_NOT_FOUND';

    if (resolvedChatId) {
      const customerRes = await sendTelegramPayload(
        botToken,
        resolvedChatId,
        messageText,
        proofDataUrl,
        orderNumber
      );
      sentToCustomer = customerRes.ok;
      customerReason = customerRes.ok
        ? 'SENT'
        : customerRes.errorDescription || 'TELEGRAM_API_ERROR';
    }

    let sentToAdminGroup = false;
    if (adminChatId && adminChatId !== resolvedChatId) {
      const adminCaption = `${messageText}\n\nTelegram Pelanggan: ${customerPhone}`;
      const adminRes = await sendTelegramPayload(
        botToken,
        adminChatId,
        adminCaption,
        proofDataUrl,
        orderNumber
      );
      sentToAdminGroup = adminRes.ok;
    }

    if (sentToCustomer) {
      orderLastSentAt.set(orderId, Date.now());
    }

    res.json({
      ok: true,
      sentViaBot: sentToCustomer || sentToAdminGroup,
      sentToCustomer,
      sentToAdminGroup,
      botConfigured: true,
      botUsername,
      reason: sentToCustomer ? 'SENT' : customerReason,
    });
  });

  // Automatically forward customer ABA/QR transfer proof photo + order details to Owner's Telegram
  // Uses server-side TELEGRAM_BOT_TOKEN & TELEGRAM_ADMIN_CHAT_ID (never exposed to browser).
  app.post('/api/telegram/send-payment-proof', async (req, res) => {
    const clientIp = req.ip || 'unknown';
    if (!checkRateLimit(clientIp)) {
      res.status(429).json({
        ok: false,
        sentToOwner: false,
        botConfigured: false,
        reason: 'RATE_LIMITED',
      });
      return;
    }

    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ ok: false, sentToOwner: false, reason: 'INVALID_BODY' });
      return;
    }

    const orderId = cleanShortString(body.orderId, 80);
    const orderNumber = cleanShortString(body.orderNumber, 40);
    const customerName = cleanShortString(body.customerName, 120);
    const customerPhone = cleanShortString(body.customerPhone, 80);
    const totalLabel = cleanShortString(body.totalLabel, 60);
    const itemsText = cleanShortString(body.itemsText, 500);
    const rawLocationUrl = cleanShortString(body.locationUrl, 300);
    const locationUrl = /^https:\/\//i.test(rawLocationUrl) ? rawLocationUrl : '';
    const manualAddress = cleanShortString(body.manualAddress, 250);
    const notes = cleanShortString(body.notes, 300);
    const storeName = cleanShortString(body.storeName, 80) || 'ALPAMART TRIMULIA ONLAINE';
    const proofDataUrl = typeof body.proofDataUrl === 'string' ? body.proofDataUrl.trim() : '';

    if (!orderId || !orderNumber || !customerName || !customerPhone) {
      res.status(400).json({ ok: false, sentToOwner: false, reason: 'MISSING_FIELDS' });
      return;
    }

    if (!proofDataUrl || proofDataUrl.length > 900_000 || !PROOF_DATA_URL_PATTERN.test(proofDataUrl)) {
      res.status(400).json({ ok: false, sentToOwner: false, reason: 'INVALID_PROOF_ATTACHMENT' });
      return;
    }

    const botToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const adminChatId = (process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();

    if (!botToken || botToken.length < 15 || !adminChatId) {
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        sentToOwner: false,
        botConfigured: false,
        reason: 'BOT_OR_OWNER_CHAT_NOT_CONFIGURED',
      });
      return;
    }

    const paymentKey = `pay:${orderId}`;
    const lastSent = orderLastSentAt.get(paymentKey) || 0;
    if (Date.now() - lastSent < 15_000) {
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        sentToOwner: true,
        botConfigured: true,
        reason: 'ALREADY_SENT_RECENTLY',
      });
      return;
    }

    const captionLines = [
      `BUKTI TRANSFER ABA/QR - ${storeName}`,
      `No. Pesanan: ${orderNumber}`,
      `Total Transfer: ${totalLabel || '-'}`,
      `Nama Penerima: ${customerName}`,
      `Kontak Telegram: ${customerPhone}`,
      itemsText ? `Pesanan:\n${itemsText}` : '',
      locationUrl ? `Lokasi GPS: ${locationUrl}` : '',
      manualAddress ? `Alamat/Patokan: ${manualAddress}` : '',
      notes ? `Catatan: ${notes}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const ownerRes = await sendTelegramPayload(
      botToken,
      adminChatId,
      captionLines,
      proofDataUrl,
      orderNumber
    );

    if (ownerRes.ok) {
      orderLastSentAt.set(paymentKey, Date.now());
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      sentToOwner: ownerRes.ok,
      botConfigured: true,
      reason: ownerRes.ok ? 'SENT' : ownerRes.errorDescription || 'TELEGRAM_SEND_FAILED',
    });
  });

  // Zero-permission approximate network location helper for Checkout auto-location
  // (never prompts browser GPS permission dialog; strictly queries hardcoded GeoJS endpoint).
  app.get('/api/location/approx', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const forwarded = String(req.headers['x-forwarded-for'] || '')
        .split(',')[0]
        .trim();
      const rawIp = forwarded || req.ip || '';
      const cleanIp = rawIp.replace(/^::ffff:/, '').trim();
      const isPrivateOrLocal =
        !cleanIp ||
        cleanIp === '127.0.0.1' ||
        cleanIp === '::1' ||
        cleanIp.startsWith('10.') ||
        cleanIp.startsWith('192.168.') ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(cleanIp) ||
        !net.isIP(cleanIp);

      const endpoint = isPrivateOrLocal
        ? 'https://get.geojs.io/v1/ip/geo.json'
        : `https://get.geojs.io/v1/ip/geo/${encodeURIComponent(cleanIp)}.json`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4500);
      try {
        const geoRes = await fetch(endpoint, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!geoRes.ok) {
          res.json({ ok: false });
          return;
        }
        const geo = (await geoRes.json()) as {
          latitude?: string | number;
          longitude?: string | number;
          city?: string;
          region?: string;
          country?: string;
        };
        const latNum = Number(geo.latitude);
        const lngNum = Number(geo.longitude);
        if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
          res.json({ ok: false });
          return;
        }
        const lat = latNum.toFixed(6);
        const lng = lngNum.toFixed(6);
        const label = [geo.city, geo.region, geo.country]
          .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
          .slice(0, 3)
          .join(', ');
        res.json({
          ok: true,
          lat,
          lng,
          coords: `${lat}, ${lng}`,
          mapsUrl: `https://www.google.com/maps?q=${lat},${lng}`,
          label,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      res.json({ ok: false });
    }
  });

  // Live build/server version endpoint so all 4 portals (Customer, Delivery, Admin, Master)
  // automatically detect updates and stay synchronized without stale cached screens.
  const serverBootStamp = Date.now().toString(36);
  const APP_SYNC_EPOCH = '20261126-sync-v16';
  const resolveAppBuildVersion = (): string => {
    try {
      const distIndex = path.resolve(__dirname, 'dist', 'index.html');
      if (IS_PROD && fs.existsSync(distIndex)) {
        const st = fs.statSync(distIndex);
        return `prod-${APP_SYNC_EPOCH}-${st.size}-${Math.trunc(st.mtimeMs)}`;
      }
      const watchedFiles = [
        path.resolve(__dirname, 'index.html'),
        path.resolve(__dirname, 'src', 'App.tsx'),
        path.resolve(__dirname, 'src', 'lib', 'firebase.ts'),
        path.resolve(__dirname, 'src', 'lib', 'storeDefaults.ts'),
        path.resolve(__dirname, 'src', 'lib', 'portalZipBuilder.ts'),
        path.resolve(__dirname, 'src', 'lib', 'portalZipExport.ts'),
        path.resolve(__dirname, 'src', 'components', 'Navbar.tsx'),
        path.resolve(__dirname, 'src', 'components', 'CartCheckoutDrawer.tsx'),
        path.resolve(__dirname, 'src', 'components', 'TelegramFloatingChat.tsx'),
        path.resolve(__dirname, 'src', 'components', 'StorefrontView.tsx'),
        path.resolve(__dirname, 'src', 'components', 'CatalogView.tsx'),
        path.resolve(__dirname, 'src', 'components', 'SearchView.tsx'),
        path.resolve(__dirname, 'src', 'components', 'PromoDiscountView.tsx'),
        path.resolve(__dirname, 'src', 'components', 'ProductSlideNavigator.tsx'),
        path.resolve(__dirname, 'src', 'components', 'PortalSwitcherBar.tsx'),
        path.resolve(__dirname, 'src', 'components', 'AdminDashboardView.tsx'),
        path.resolve(__dirname, 'src', 'components', 'AdminBarcodeAutoImageModal.tsx'),
        path.resolve(__dirname, 'src', 'components', 'MasterDashboardView.tsx'),
        path.resolve(__dirname, 'src', 'components', 'DeliveryDashboardView.tsx'),
      ];
      let latestMtime = 0;
      for (const fp of watchedFiles) {
        if (fs.existsSync(fp)) {
          const mt = Math.trunc(fs.statSync(fp).mtimeMs);
          if (mt > latestMtime) latestMtime = mt;
        }
      }
      return `dev-${APP_SYNC_EPOCH}-${serverBootStamp}-${latestMtime}`;
    } catch {
      return `live-${APP_SYNC_EPOCH}-${serverBootStamp}`;
    }
  };

  app.get('/api/app-version', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.json({
      version: resolveAppBuildVersion(),
      serverTime: Date.now(),
    });
  });

  // Never let unmatched /api/* requests fall through to Vite or index.html (<!doctype html>)
  app.all('/api/*', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(404).json({
      ok: false,
      reason: 'API_ROUTE_NOT_FOUND',
      message: `Endpoint API tidak ditemukan (${req.method} ${req.path}). Muat ulang halaman jika server baru saja diperbarui.`,
    });
  });

  // Ensure any middleware/JSON body parser errors on /api/* always return JSON instead of HTML
  app.use(
    '/api',
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (res.headersSent) {
        next(err);
        return;
      }
      const status =
        typeof err === 'object' &&
        err !== null &&
        'status' in err &&
        typeof (err as { status?: unknown }).status === 'number'
          ? (err as { status: number }).status
          : 500;
      const message =
        err instanceof Error ? err.message : 'Terjadi kesalahan internal pada server API.';
      res.setHeader('Cache-Control', 'no-store');
      res.status(status).json({
        ok: false,
        reason: status === 400 ? 'INVALID_REQUEST_BODY' : 'INTERNAL_API_ERROR',
        message,
      });
    }
  );

  if (!IS_PROD) {
    app.use((req, res, next) => {
      if (req.method === 'GET' && (req.path === '/' || req.headers.accept?.includes('text/html'))) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
      next();
    });
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    const compressibleExt = new Set(['.js', '.css', '.html', '.svg', '.json']);
    const mimeByExt: Record<string, string> = {
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.json': 'application/json; charset=utf-8',
    };

    // Serve gzip-compressed hashed assets with long-term immutable caching
    app.get('/assets/*', (req, res, next) => {
      const acceptEnc = String(req.headers['accept-encoding'] || '');
      if (!acceptEnc.includes('gzip')) {
        next();
        return;
      }
      const rel = req.path.replace(/^\/+/, '');
      const fullPath = path.resolve(distDir, rel);
      if (!fullPath.startsWith(path.join(distDir, 'assets') + path.sep)) {
        next();
        return;
      }
      const ext = path.extname(fullPath).toLowerCase();
      if (!compressibleExt.has(ext) || !fs.existsSync(fullPath)) {
        next();
        return;
      }
      res.setHeader('Content-Type', mimeByExt[ext] || 'application/octet-stream');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      fs.createReadStream(fullPath).pipe(zlib.createGzip({ level: 6 })).pipe(res);
    });

    const isHashedBundle = (fp: string): boolean =>
      /-[a-zA-Z0-9_-]{8,}\.(?:js|css)$/i.test(path.basename(fp));

    app.use(
      express.static(distDir, {
        index: false,
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
          } else if (isHashedBundle(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else {
            res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
          }
        },
      })
    );
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  initJournalPosServiceOnBoot();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

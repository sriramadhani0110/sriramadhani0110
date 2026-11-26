import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface FirebaseAppletRuntimeConfig {
  projectId: string;
  firestoreDatabaseId: string;
}

const PLACEHOLDER_PROJECT_IDS = new Set([
  '',
  'remixed-project-id',
  'your-project-id',
]);

const PLACEHOLDER_DATABASE_IDS = new Set([
  'remixed-firestore-database-id',
  'your-firestore-database-id',
]);

let cachedConfig: FirebaseAppletRuntimeConfig | null = null;
let cachedApp: App | null = null;
let cachedDb: Firestore | null = null;

export function loadFirebaseAppletRuntimeConfig(): FirebaseAppletRuntimeConfig {
  if (cachedConfig) return cachedConfig;

  const configPath = path.resolve(__dirname, '../../firebase-applet-config.json');
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as {
    projectId?: string;
    firestoreDatabaseId?: string;
  };

  const projectId = (parsed.projectId || '').trim();
  const firestoreDatabaseId = (parsed.firestoreDatabaseId || '').trim();

  if (PLACEHOLDER_PROJECT_IDS.has(projectId)) {
    throw new Error(
      'Firebase projectId di firebase-applet-config.json masih placeholder. Lakukan provisioning Firebase terlebih dahulu.'
    );
  }
  if (PLACEHOLDER_DATABASE_IDS.has(firestoreDatabaseId)) {
    throw new Error(
      'Firebase firestoreDatabaseId di firebase-applet-config.json masih placeholder.'
    );
  }

  cachedConfig = {
    projectId,
    firestoreDatabaseId: firestoreDatabaseId || '(default)',
  };
  return cachedConfig;
}

export function getFirebaseAdminApp(): App {
  if (cachedApp) return cachedApp;
  const cfg = loadFirebaseAppletRuntimeConfig();
  cachedApp = getApps().length > 0 ? getApp() : initializeApp({ projectId: cfg.projectId });
  return cachedApp;
}

export function getAdminAuth(): Auth {
  return getAuth(getFirebaseAdminApp());
}

/**
 * Returns the Firestore Admin instance targeting the exact named database configured
 * in firebase-applet-config.json (passing firestoreDatabaseId as the 2nd argument
 * whenever it is set and not '(default)').
 */
export function getAdminFirestore(): Firestore {
  if (cachedDb) return cachedDb;
  const cfg = loadFirebaseAppletRuntimeConfig();
  const app = getFirebaseAdminApp();
  cachedDb =
    cfg.firestoreDatabaseId && cfg.firestoreDatabaseId !== '(default)'
      ? getFirestore(app, cfg.firestoreDatabaseId)
      : getFirestore(app);
  return cachedDb;
}

/**
 * Detects IAM permission denial (gRPC code 7 PERMISSION_DENIED / HTTP 403)
 * when the preview/runtime service account has not yet been granted roles/datastore.user.
 */
export function isFirestoreIamPermissionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const record = err as { code?: unknown; message?: unknown; details?: unknown };
  if (record.code === 7 || record.code === 'permission-denied' || record.code === 'PERMISSION_DENIED') {
    return true;
  }
  const combined = `${String(record.message || '')} ${String(record.details || '')}`.toUpperCase();
  return (
    combined.includes('PERMISSION_DENIED') ||
    combined.includes('MISSING OR INSUFFICIENT PERMISSIONS') ||
    combined.includes('CALLER DOES NOT HAVE PERMISSION')
  );
}

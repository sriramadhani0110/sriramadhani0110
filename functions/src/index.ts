import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { Storage } from '@google-cloud/storage';

initializeApp();

// Matches firebase-applet-config.json firestoreDatabaseId
const FIRESTORE_DATABASE_ID =
  process.env.FIRESTORE_DATABASE_ID ||
  'ai-studio-remixalpamarttri-57703d96-8898-4181-99d8-3391bcd85f46';

const BACKUP_BUCKET_NAME =
  process.env.BACKUP_GCS_BUCKET ||
  'gen-lang-client-0316275418.firebasestorage.app';

const COLLECTIONS_TO_BACKUP = [
  'products',
  'productPrivateMeta',
  'categories',
  'promotions',
  'orders',
  'storeBanners',
  'storeConfig',
  'storeSupport',
  'storeMeta',
  'adminAccounts',
  'deliveryAccounts',
  'automationSettings',
  'automationLogs',
  'integrationConfig',
  'journalPosSyncLogs',
  'backupArchives',
];

function serializeFirestoreValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (val instanceof Timestamp) {
    return val.toDate().toISOString();
  }
  if (Array.isArray(val)) {
    return val.map(serializeFirestoreValue);
  }
  if (typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = serializeFirestoreValue(v);
    }
    return out;
  }
  return val;
}

/**
 * Scheduled every 24 hours (02:00 Asia/Phnom_Penh / UTC+7)
 * Exports all Firestore master collections into a timestamped JSON archive in Google Cloud Storage
 * and logs an immutable audit entry in /backupArchives.
 */
export const scheduledDailyFirestoreBackup = onSchedule(
  {
    schedule: '0 2 * * *',
    timeZone: 'Asia/Phnom_Penh',
    region: 'asia-northeast1',
    memory: '512MiB',
    timeoutSeconds: 300,
    retryCount: 2,
  },
  async () => {
    const db = getFirestore(FIRESTORE_DATABASE_ID);
    const storage = new Storage();
    const bucket = storage.bucket(BACKUP_BUCKET_NAME);

    const now = new Date();
    const dateFolder = now.toISOString().slice(0, 10);
    const timestampSlug = now.toISOString().replace(/[:.]/g, '-');
    const objectPath = `firestore-backups/${dateFolder}/alpamart-master-backup-${timestampSlug}.json`;

    const exportedCollections: Record<string, Record<string, unknown>> = {};
    let totalDocuments = 0;

    for (const colName of COLLECTIONS_TO_BACKUP) {
      try {
        const snap = await db.collection(colName).get();
        const docsMap: Record<string, unknown> = {};
        for (const docSnap of snap.docs) {
          docsMap[docSnap.id] = serializeFirestoreValue(docSnap.data());
          totalDocuments += 1;
        }
        exportedCollections[colName] = docsMap;
      } catch (err) {
        logger.warn(`Collection backup skipped: ${colName}`, err);
        exportedCollections[colName] = {};
      }
    }

    const payload = {
      app: 'ALPAMART TRIMULIA ONLINE',
      databaseId: FIRESTORE_DATABASE_ID,
      exportedAt: now.toISOString(),
      totalDocuments,
      collectionsIncluded: COLLECTIONS_TO_BACKUP,
      collections: exportedCollections,
    };

    const jsonString = JSON.stringify(payload, null, 2);
    const fileBuffer = Buffer.from(jsonString, 'utf8');

    await bucket.file(objectPath).save(fileBuffer, {
      contentType: 'application/json; charset=utf-8',
      resumable: false,
      metadata: {
        cacheControl: 'no-store',
        metadata: {
          databaseId: FIRESTORE_DATABASE_ID,
          totalDocuments: String(totalDocuments),
          exportedAt: now.toISOString(),
        },
      },
    });

    const backupId = `gcs_${Date.now()}`;
    await db.collection('backupArchives').doc(backupId).set({
      id: backupId,
      format: 'gcs_scheduled',
      totalDocuments,
      collectionsIncluded: COLLECTIONS_TO_BACKUP,
      fileSizeBytes: fileBuffer.byteLength,
      createdBy: 'cloud-functions-scheduler@system',
      createdAt: Timestamp.now(),
    });

    logger.info('Scheduled 24h Firestore JSON backup completed', {
      bucket: BACKUP_BUCKET_NAME,
      objectPath,
      totalDocuments,
      fileSizeBytes: fileBuffer.byteLength,
    });
  }
);

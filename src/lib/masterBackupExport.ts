import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  Timestamp,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { db } from './firebase';
import { buildZipArchiveBytes } from './portalZipBuilder';

const SINGLE_DOC_READS: Array<{ col: string; id: string }> = [
  { col: 'storeConfig', id: 'master' },
  { col: 'storeConfig', id: 'checkout' },
  { col: 'storeConfig', id: 'hours' },
  { col: 'storeSupport', id: 'telegram' },
  { col: 'storeMeta', id: 'deliveryRoster' },
  { col: 'automationSettings', id: 'default' },
  { col: 'integrationConfig', id: 'journalPos' },
];

const LIST_COLLECTIONS = [
  'products',
  'productPrivateMeta',
  'categories',
  'promotions',
  'orders',
  'storeBanners',
  'adminAccounts',
  'deliveryAccounts',
  'automationLogs',
  'journalPosSyncLogs',
  'backupArchives',
];

function serializeValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (val instanceof Timestamp) {
    return val.toDate().toISOString();
  }
  if (typeof val === 'object' && 'toDate' in (val as Record<string, unknown>)) {
    const fn = (val as { toDate?: unknown }).toDate;
    if (typeof fn === 'function') {
      try {
        return (fn.call(val) as Date).toISOString();
      } catch {
        return String(val);
      }
    }
  }
  if (Array.isArray(val)) {
    return val.map(serializeValue);
  }
  if (typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = serializeValue(v);
    }
    return out;
  }
  return val;
}

export interface FullBackupExportResult {
  filename: string;
  format: 'json' | 'zip';
  totalDocuments: number;
  collectionsIncluded: string[];
  fileSizeBytes: number;
  exportedAt: string;
}

async function collectFullFirestoreSnapshot(): Promise<{
  exportedAt: string;
  totalDocuments: number;
  collectionsIncluded: string[];
  collectionsData: Record<string, Record<string, unknown>>;
}> {
  const exportedAt = new Date().toISOString();
  const collectionsData: Record<string, Record<string, unknown>> = {};
  const includedSet = new Set<string>();
  let totalDocuments = 0;

  // Read single-doc collections (rules restrict list: if false on these)
  for (const item of SINGLE_DOC_READS) {
    try {
      const snap = await getDoc(doc(db, item.col, item.id));
      if (!collectionsData[item.col]) {
        collectionsData[item.col] = {};
      }
      if (snap.exists()) {
        collectionsData[item.col][snap.id] = serializeValue(snap.data());
        totalDocuments += 1;
        includedSet.add(item.col);
      }
    } catch {
      // Skip restricted or absent optional config docs
    }
  }

  // Read listable collections
  for (const colName of LIST_COLLECTIONS) {
    try {
      const snap = await getDocs(collection(db, colName));
      const docsMap: Record<string, unknown> = {};
      for (const docSnap of snap.docs) {
        docsMap[docSnap.id] = serializeValue(docSnap.data());
        totalDocuments += 1;
      }
      collectionsData[colName] = docsMap;
      includedSet.add(colName);
    } catch {
      // Skip collections if permission not granted for current role
    }
  }

  return {
    exportedAt,
    totalDocuments,
    collectionsIncluded: Array.from(includedSet),
    collectionsData,
  };
}

function triggerBrowserBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Exports all Firestore master collections into either a full JSON file or a structured ZIP bundle
 * (containing individual collection JSON files + combined master_backup.json + restore guide),
 * then logs an immutable audit entry in /backupArchives.
 */
export async function exportMasterFirestoreBackup(params: {
  format: 'json' | 'zip';
  adminEmail: string;
  storeName?: string;
}): Promise<FullBackupExportResult> {
  const { format, adminEmail, storeName = 'ALPAMART TRIMULIA ONLINE' } = params;
  const snapshot = await collectFullFirestoreSnapshot();
  const dateStamp = snapshot.exportedAt.slice(0, 19).replace(/[:T]/g, '-');

  const fullPayload = {
    app: storeName,
    firebaseProjectId: firebaseConfig.projectId,
    firestoreDatabaseId: firebaseConfig.firestoreDatabaseId || '(default)',
    exportedAt: snapshot.exportedAt,
    exportedBy: adminEmail,
    totalDocuments: snapshot.totalDocuments,
    collectionsIncluded: snapshot.collectionsIncluded,
    collections: snapshot.collectionsData,
  };

  const fullJsonText = JSON.stringify(fullPayload, null, 2);
  let filename = '';
  let fileSizeBytes = 0;

  if (format === 'json') {
    filename = `ALPAMART-MASTER-BACKUP-${dateStamp}.json`;
    const blob = new Blob([fullJsonText], { type: 'application/json;charset=utf-8' });
    fileSizeBytes = blob.size;
    triggerBrowserBlobDownload(blob, filename);
  } else {
    filename = `ALPAMART-MASTER-BACKUP-${dateStamp}.zip`;
    const entries: Array<{ name: string; content: string }> = [
      {
        name: 'README-BACKUP-MASTER.txt',
        content: [
          `BACKUP DATA MASTER — ${storeName}`,
          `Waktu Export   : ${snapshot.exportedAt}`,
          `Diekspor oleh  : ${adminEmail}`,
          `Firebase Project: ${firebaseConfig.projectId}`,
          `Database ID    : ${firebaseConfig.firestoreDatabaseId || '(default)'}`,
          `Total Dokumen  : ${snapshot.totalDocuments}`,
          `Koleksi        : ${snapshot.collectionsIncluded.join(', ')}`,
          '',
          'ISI ARSIP ZIP:',
          '- full_master_backup.json : Gabungan seluruh koleksi Firestore dalam 1 file JSON.',
          '- collections/*.json      : File JSON terpisah per koleksi untuk memudahkan audit & pemulihan.',
          '',
          'CATATAN KEAMANAN:',
          'File ini mencakup data administrasi termasuk harga modal (productPrivateMeta) dan riwayat pesanan.',
          'Simpan di Google Drive / Google Cloud Storage pribadi toko dan jangan bagikan ke publik.',
        ].join('\r\n'),
      },
      {
        name: 'full_master_backup.json',
        content: fullJsonText,
      },
    ];

    for (const [colName, docsObj] of Object.entries(snapshot.collectionsData)) {
      entries.push({
        name: `collections/${colName}.json`,
        content: JSON.stringify(docsObj, null, 2),
      });
    }

    const zipBytes = buildZipArchiveBytes(entries);
    fileSizeBytes = zipBytes.byteLength;
    const blob = new Blob([new Uint8Array(zipBytes)], { type: 'application/zip' });
    triggerBrowserBlobDownload(blob, filename);
  }

  // Record audit log in /backupArchives
  try {
    const backupId = `bkp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    await setDoc(doc(db, 'backupArchives', backupId), {
      id: backupId,
      format,
      totalDocuments: snapshot.totalDocuments,
      collectionsIncluded: snapshot.collectionsIncluded.slice(0, 30),
      fileSizeBytes,
      createdBy: (adminEmail || 'admin').slice(0, 128),
      createdAt: serverTimestamp(),
    });
  } catch {
    // Do not fail download if audit record fails
  }

  return {
    filename,
    format,
    totalDocuments: snapshot.totalDocuments,
    collectionsIncluded: snapshot.collectionsIncluded,
    fileSizeBytes,
    exportedAt: snapshot.exportedAt,
  };
}

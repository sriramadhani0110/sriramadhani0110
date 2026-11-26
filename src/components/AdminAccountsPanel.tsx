import { useState } from 'react';
import {
  Check,
  Copy,
  ShieldCheck,
  Trash2,
  UserPlus,
} from 'lucide-react';
import {
  deleteDoc,
  doc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import type { AdminAccount } from '../types/marketplace';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import {
  ADMIN_ROLE_TEMPLATES,
  BOOTSTRAPPED_ADMIN_EMAIL,
  copyTextToClipboard,
  normalizeEmail,
  sha256Hex,
  STORE_NAME,
} from '../lib/catalogSeed';

interface AdminAccountsPanelProps {
  currentAdminEmail: string;
  adminAccounts: AdminAccount[];
  adminPortalUrl: string;
  onNotify: (message: string) => void;
}

export function AdminAccountsPanel({
  currentAdminEmail,
  adminAccounts,
  adminPortalUrl,
  onNotify,
}: AdminAccountsPanelProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [roleLabel, setRoleLabel] = useState(ADMIN_ROLE_TEMPLATES[0].roleLabel);
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleSelectTemplate = (templateRole: string) => {
    setRoleLabel(templateRole);
  };

  const handleAddAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const cleanName = name.trim().slice(0, 100);
    const cleanEmail = normalizeEmail(email).slice(0, 120);
    const cleanRole = roleLabel.trim().slice(0, 60) || 'Admin Toko';
    const cleanPhone = phone.trim().slice(0, 24);

    if (cleanName.length < 2) {
      setFormError('Nama Admin minimal 2 karakter.');
      return;
    }
    if (!cleanEmail || !cleanEmail.includes('@') || cleanEmail.length < 5) {
      setFormError('Masukkan alamat email Google Admin yang valid.');
      return;
    }
    if (cleanEmail === BOOTSTRAPPED_ADMIN_EMAIL) {
      setFormError(
        `Email ${BOOTSTRAPPED_ADMIN_EMAIL} sudah terdaftar sebagai Admin Utama sistem.`
      );
      return;
    }

    setSaving(true);
    try {
      const emailHash = await sha256Hex(cleanEmail);
      const existing = adminAccounts.find((a) => a.id === emailHash);

      if (existing) {
        await updateDoc(doc(db, 'adminAccounts', emailHash), {
          name: cleanName,
          roleLabel: cleanRole,
          phone: cleanPhone,
          isActive: true,
          updatedAt: serverTimestamp(),
        });
        onNotify(`Akun Admin "${cleanName}" (${cleanEmail}) diperbarui & diaktifkan.`);
      } else {
        await setDoc(doc(db, 'adminAccounts', emailHash), {
          id: emailHash,
          name: cleanName,
          email: cleanEmail,
          roleLabel: cleanRole,
          phone: cleanPhone,
          isActive: true,
          addedBy: currentAdminEmail || BOOTSTRAPPED_ADMIN_EMAIL,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        onNotify(
          `Akun Admin baru "${cleanName}" (${cleanEmail}) berhasil ditambahkan! Sekarang email tersebut bisa login di ${adminPortalUrl}.`
        );
      }

      setName('');
      setEmail('');
      setPhone('');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'adminAccounts');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (acc: AdminAccount) => {
    try {
      await updateDoc(doc(db, 'adminAccounts', acc.id), {
        isActive: !acc.isActive,
        updatedAt: serverTimestamp(),
      });
      onNotify(
        `Akun Admin ${acc.email} kini ${!acc.isActive ? 'AKTIF' : 'DINONAKTIFKAN'}.`
      );
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `adminAccounts/${acc.id}`);
    }
  };

  const handleDelete = async (acc: AdminAccount) => {
    try {
      await deleteDoc(doc(db, 'adminAccounts', acc.id));
      onNotify(`Akun Admin ${acc.email} telah dihapus.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `adminAccounts/${acc.id}`);
    }
  };

  const handleCopyInvite = async (acc: AdminAccount) => {
    const invite = [
      `Undangan Akses Admin · ${STORE_NAME}`,
      `Nama: ${acc.name} (${acc.roleLabel})`,
      `Email Google Terdaftar: ${acc.email}`,
      `Link Login Admin: ${adminPortalUrl}`,
      `Tips HP: Buka link di Google Chrome / Safari lalu masuk dengan email Google di atas.`,
    ].join('\n');
    await copyTextToClipboard(invite);
    setCopiedId(acc.id);
    setTimeout(() => setCopiedId((prev) => (prev === acc.id ? null : prev)), 2000);
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
      <div className="flex items-start gap-3 pb-4 border-b border-slate-100">
        <UserPlus className="w-5 h-5 text-blue-700 shrink-0 mt-0.5" />
        <div>
          <h2 className="text-base font-bold text-slate-900">
            Template Tambah &amp; Kelola Akun Admin
          </h2>
          <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">
            Tambahkan rekan pengelola, kasir, atau operator sebagai Akun Admin resmi. Pilih template peran di bawah, masukkan email Google mereka, lalu kirim link portal <span className="font-mono text-slate-900">/admin</span>.
          </p>
        </div>
      </div>

      {/* Quick Role Template Picker */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-slate-700">
          Pilih Template Peran Admin (1-Klik)
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {ADMIN_ROLE_TEMPLATES.map((tpl) => {
            const active = roleLabel === tpl.roleLabel;
            return (
              <button
                key={tpl.id}
                type="button"
                onClick={() => handleSelectTemplate(tpl.roleLabel)}
                className={`p-3 rounded-lg border text-left transition-colors cursor-pointer ${
                  active
                    ? 'border-blue-700 bg-blue-50/70 ring-1 ring-blue-700'
                    : 'border-slate-200 bg-slate-50/60 hover:bg-slate-100'
                }`}
              >
                <p className="text-xs font-bold text-slate-900">
                  {tpl.roleLabel}
                </p>
                <p className="text-[11px] text-slate-600 mt-0.5">
                  {tpl.summary}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Add Admin Form */}
      <form
        onSubmit={handleAddAdmin}
        className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3.5"
      >
        <p className="text-xs font-bold text-slate-900">
          Formulir Tambah Akun Admin Baru
        </p>

        {formError && (
          <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-700">
            {formError}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Nama Admin / Kasir
            </label>
            <input
              type="text"
              required
              minLength={2}
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Contoh: Admin Shift Malam"
              className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Email Google Admin
            </label>
            <input
              type="email"
              required
              maxLength={120}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="contoh: kasir.toko@gmail.com"
              className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Jabatan / Peran
            </label>
            <input
              type="text"
              required
              minLength={2}
              maxLength={60}
              value={roleLabel}
              onChange={(e) => setRoleLabel(e.target.value)}
              placeholder="Admin Utama / Kasir & Printer"
              className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              No. HP / Telegram (Opsional)
            </label>
            <input
              type="text"
              maxLength={24}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="081234567890"
              className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-700"
            />
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-blue-700 hover:bg-red-600 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
          >
            <UserPlus className="w-4 h-4" />
            <span>{saving ? 'Menyimpan...' : 'Tambahkan Akun Admin'}</span>
          </button>
        </div>
      </form>

      {/* Registered Admins Directory */}
      <div className="space-y-2.5">
        <p className="text-xs font-bold text-slate-800">
          Daftar Akun Admin Terdaftar ({adminAccounts.length + 1})
        </p>

        {/* Bootstrapped Primary Owner (Protected) */}
        <div className="p-3.5 bg-blue-50/50 border border-blue-200 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="space-y-0.5 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-blue-700 shrink-0" />
              <span className="text-xs font-bold text-slate-900">
                Pemilik Utama ({STORE_NAME})
              </span>
              <span className="text-[11px] font-semibold text-blue-700">
                · Admin Utama Permanen
              </span>
            </div>
            <p className="font-mono text-xs text-slate-700 truncate">
              {BOOTSTRAPPED_ADMIN_EMAIL}
            </p>
          </div>
          <span className="text-[11px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded whitespace-nowrap self-start sm:self-center">
            Aktif · Utama
          </span>
        </div>

        {adminAccounts.map((acc) => (
          <div
            key={acc.id}
            className="p-3.5 bg-white border border-slate-200 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          >
            <div className="space-y-0.5 min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-bold text-slate-900">{acc.name}</span>
                <span className="text-slate-300">·</span>
                <span className="font-semibold text-blue-700">
                  {acc.roleLabel}
                </span>
                {acc.phone && (
                  <>
                    <span className="text-slate-300">·</span>
                    <span className="font-mono text-slate-500">{acc.phone}</span>
                  </>
                )}
              </div>
              <p className="font-mono text-xs text-slate-600 truncate">
                {acc.email}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => handleCopyInvite(acc)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 cursor-pointer"
              >
                {copiedId === acc.id ? (
                  <>
                    <Check className="w-3 h-3 text-emerald-600" />
                    <span>Undangan Disalin</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    <span>Salin Undangan</span>
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => handleToggleActive(acc)}
                className={`px-2.5 py-1.5 text-[11px] font-semibold rounded-lg border cursor-pointer ${
                  acc.isActive
                    ? 'text-emerald-800 bg-emerald-50 border-emerald-200 hover:bg-emerald-100'
                    : 'text-slate-600 bg-slate-100 border-slate-200 hover:bg-slate-200'
                }`}
              >
                {acc.isActive ? 'Aktif' : 'Nonaktif'}
              </button>
              <button
                type="button"
                onClick={() => handleDelete(acc)}
                aria-label={`Hapus Admin ${acc.email}`}
                className="p-1.5 text-rose-600 bg-rose-50 border border-rose-200 rounded-lg hover:bg-rose-100 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

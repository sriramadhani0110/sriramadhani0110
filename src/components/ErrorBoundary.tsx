import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    let readableMessage = error.message || 'Terjadi kendala pada sistem aplikasi.';
    const lowerRaw = readableMessage.toLowerCase();
    if (
      lowerRaw.includes('resource-exhausted') ||
      lowerRaw.includes('quota') ||
      lowerRaw.includes('kuota')
    ) {
      readableMessage =
        'Website ini 100% gratis tanpa kuota pengguna. Server database cloud sedang padat sementara — silakan muat ulang halaman dalam beberapa saat.';
      return { hasError: true, message: readableMessage };
    }
    try {
      const parsed = JSON.parse(error.message);
      if (parsed && parsed.error) {
        const lowerErr = String(parsed.error).toLowerCase();
        if (lowerErr.includes('resource-exhausted') || lowerErr.includes('quota')) {
          readableMessage =
            'Website ini 100% gratis tanpa kuota pengguna. Server database cloud sedang padat sementara — silakan muat ulang halaman atau order langsung via Telegram toko.';
        } else {
          readableMessage = `Akses database ditolak (${parsed.operationType} · ${parsed.path || 'koleksi'}). Silakan pastikan Anda telah masuk dengan akun yang sesuai.`;
        }
      }
    } catch {
      // keep original message
    }
    return { hasError: true, message: readableMessage };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <div className="flex items-center gap-3 text-rose-700">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <h2 className="text-lg font-semibold text-slate-900">
                Terjadi Gangguan Koneksi
              </h2>
            </div>
            <p className="text-sm text-slate-600 leading-relaxed">
              {this.state.message}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap"
            >
              <RotateCcw className="w-4 h-4" />
              Muat Ulang Halaman
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

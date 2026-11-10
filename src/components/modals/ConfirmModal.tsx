import { X, AlertTriangle } from "lucide-react";
import { ConfirmModalState } from "../../types";

interface Props {
  confirmModal: ConfirmModalState | null;
  onClose: () => void;
  isDark?: boolean;
}

export default function ConfirmModal({ confirmModal, onClose, isDark = true }: Props) {
  if (!confirmModal) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div
        className={`w-80 rounded-xl border p-5 shadow-2xl space-y-4 animate-in zoom-in-95 duration-150 ${
          isDark ? "border-neutral-800 bg-neutral-900 text-neutral-200" : "border-neutral-300 bg-white text-neutral-800"
        }`}
      >
        <div className="flex items-center justify-between border-b pb-2 border-neutral-500/20">
          <div className="flex items-center gap-2 text-rose-500 font-semibold text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{confirmModal.title}</span>
          </div>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-white cursor-pointer transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-xs text-neutral-400 leading-relaxed">{confirmModal.message}</p>
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded border border-neutral-700 text-xs text-neutral-400 hover:bg-neutral-500/10 cursor-pointer transition"
          >
            Annuler
          </button>
          <button
            onClick={() => {
              confirmModal.onConfirm();
              onClose();
            }}
            className="px-3 py-1.5 rounded bg-rose-600 font-semibold text-xs text-white hover:bg-rose-500 cursor-pointer transition active:scale-95"
          >
            Confirmer
          </button>
        </div>
      </div>
    </div>
  );
}


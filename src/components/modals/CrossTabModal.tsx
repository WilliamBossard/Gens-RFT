import { useState } from "react";
import { Send, X } from "lucide-react";
import { CrossTabModalState, TabSession } from "../../types";

interface Props {
  crossTabModal: CrossTabModalState | null;
  onClose: () => void;
  onConfirm: (item: { entry: any; from: "local" | "remote"; fromSessionId?: string }, targetTab: TabSession, neverAskAgain: boolean) => void;
  isDark?: boolean;
}

export default function CrossTabModal({ crossTabModal, onClose, onConfirm, isDark = true }: Props) {
  const [neverAskAgain, setNeverAskAgain] = useState(false);

  if (!crossTabModal) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div
        className={`w-[440px] rounded-xl border p-5 shadow-2xl space-y-4 animate-in zoom-in-95 duration-150 ${
          isDark ? "border-neutral-800 bg-neutral-900 text-neutral-200" : "border-neutral-300 bg-white text-neutral-800"
        }`}
      >
        <div className="flex items-center justify-between border-b border-neutral-500/20 pb-2">
          <div className="flex items-center gap-2 text-sky-500">
            <Send className="h-5 w-5 shrink-0" />
            <span className="font-semibold text-sm">Transfert vers une autre session</span>
          </div>
          <button onClick={onClose} className="text-neutral-400 hover:text-white cursor-pointer transition">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-xs text-neutral-400 leading-relaxed">
          Vous allez envoyer <span className="font-mono text-emerald-400 font-semibold">{crossTabModal.item.entry.name}</span> vers le serveur distant de l'onglet :<br />
          <strong className="text-sky-400 font-semibold">{crossTabModal.targetTab.title}</strong> ({crossTabModal.targetTab.remotePath}).
        </p>

        <label className="flex items-center gap-2 cursor-pointer text-xs text-neutral-400 pt-1">
          <input
            type="checkbox"
            checked={neverAskAgain}
            onChange={(e) => setNeverAskAgain(e.target.checked)}
            className="rounded cursor-pointer"
          />
          <span>Ne plus me demander pour cette session</span>
        </label>

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded border border-neutral-700 text-xs text-neutral-400 hover:bg-neutral-500/10 cursor-pointer"
          >
            Annuler
          </button>
          <button
            onClick={() => {
              onConfirm(crossTabModal.item, crossTabModal.targetTab, neverAskAgain);
              onClose();
            }}
            className="px-4 py-1.5 rounded bg-sky-600 font-semibold text-xs text-white hover:bg-sky-500 cursor-pointer transition active:scale-95"
          >
            Confirmer l'envoi
          </button>
        </div>
      </div>
    </div>
  );
}


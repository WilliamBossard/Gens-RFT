import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";

export interface ConflictModalState {
  filename: string;
  remainingCount?: number;
  onResolve: (action: "overwrite" | "rename" | "skip", applyToAll: boolean) => void;
}

interface Props {
  conflictModal: ConflictModalState | null;
  onClose: () => void;
  isDark?: boolean;
}

export default function ConflictModal({ conflictModal, onClose, isDark = true }: Props) {
  const [applyToAll, setApplyToAll] = useState(false);

  if (!conflictModal) return null;

  const { filename, remainingCount = 1, onResolve } = conflictModal;

  const handleAction = (action: "overwrite" | "rename" | "skip") => {
    onResolve(action, applyToAll);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div
        className={`w-96 rounded-xl border p-5 shadow-2xl space-y-4 animate-in zoom-in-95 duration-150 ${
          isDark ? "border-neutral-800 bg-neutral-900 text-neutral-200" : "border-neutral-300 bg-white text-neutral-800"
        }`}
      >
        <div className="flex items-center justify-between border-b border-neutral-500/20 pb-2">
          <div className="flex items-center gap-2 text-amber-500 font-semibold text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>Conflit de fichier</span>
            {remainingCount > 1 && (
              <span className="text-xs bg-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded-full font-mono">
                {remainingCount} en attente
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-white cursor-pointer transition"
            title="Annuler"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="text-xs text-neutral-400 leading-relaxed">
          Un élément nommé{" "}
          <span className="font-mono text-sky-400 font-semibold">{filename}</span> existe déjà
          dans la destination.
        </p>

        <label className="flex items-center gap-2 cursor-pointer text-xs text-neutral-300 select-none py-1">
          <input
            type="checkbox"
            checked={applyToAll}
            onChange={(e) => setApplyToAll(e.target.checked)}
            className="rounded cursor-pointer"
          />
          <span>Appliquer cette action pour tous les conflits restants</span>
        </label>

        <div className="flex flex-col gap-2 pt-1">
          <button
            onClick={() => handleAction("overwrite")}
            className="w-full py-1.5 rounded bg-rose-600 font-semibold text-xs text-white hover:bg-rose-500 cursor-pointer transition active:scale-95"
          >
            Écraser le fichier cible
          </button>
          <button
            onClick={() => handleAction("rename")}
            className="w-full py-1.5 rounded border border-neutral-700 font-semibold text-xs text-sky-400 hover:bg-neutral-500/10 cursor-pointer transition active:scale-95"
          >
            Renommer automatiquement (copie)
          </button>
          <button
            onClick={() => handleAction("skip")}
            className="w-full py-1.5 rounded border border-neutral-700 text-xs text-neutral-400 hover:bg-neutral-500/10 cursor-pointer transition"
          >
            Ignorer ce fichier
          </button>
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect } from "react";
import { ShieldCheck, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

export interface ChmodModalState {
  path: string;
  name: string;
  octal: string;
}

interface Props {
  chmodModal: ChmodModalState | null;
  onClose: () => void;
  activeTabId: string;
  onSuccess: () => void;
  logMessage: (msg: string) => void;
  isDark?: boolean;
}

export default function ChmodModal({
  chmodModal,
  onClose,
  activeTabId,
  onSuccess,
  logMessage,
  isDark = true,
}: Props) {
  const [octal, setOctal] = useState(chmodModal?.octal || "755");
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (chmodModal) {
      setOctal(chmodModal.octal || "755");
      setApplying(false);
    }
  }, [chmodModal]);

  if (!chmodModal) return null;

  const handleApply = async () => {
    const permVal = parseInt(octal, 8);
    if (isNaN(permVal)) {
      logMessage("Valeur octale invalide (ex: 755 ou 644).");
      return;
    }

    setApplying(true);
    try {
      await invoke("chmod_remote", {
        sessionId: activeTabId,
        path: chmodModal.path,
        permissions: permVal,
      });
      logMessage(`SITE CHMOD ${octal} ${chmodModal.name}`);
      onClose();
      onSuccess();
    } catch (err) {
      logMessage(`550 Échec CHMOD : ${err}`);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-6 animate-in fade-in duration-150">
      <div
        className={`w-80 rounded-xl border p-5 shadow-2xl space-y-4 animate-in zoom-in-95 duration-150 ${
          isDark ? "border-neutral-800 bg-neutral-900 text-neutral-200" : "border-neutral-300 bg-white text-neutral-800"
        }`}
      >
        <div className="flex items-center justify-between border-b border-neutral-500/20 pb-3">
          <span className="font-semibold text-sm flex items-center gap-2 text-sky-500">
            <ShieldCheck className="h-4 w-4" /> Permissions (CHMOD)
          </span>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-white cursor-pointer transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div>
          <div className="text-xs text-neutral-400 mb-1 truncate">{chmodModal.name}</div>
          <label className="block text-xs font-semibold text-neutral-300 mb-1">
            Valeur Octale
          </label>
          <input
            type="text"
            maxLength={4}
            value={octal}
            onChange={(e) => setOctal(e.target.value)}
            className={`w-full text-center font-mono text-lg rounded border py-1.5 text-sky-500 focus:outline-none transition ${
              isDark ? "bg-neutral-950 border-neutral-700" : "bg-neutral-50 border-neutral-300"
            }`}
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded border border-neutral-700 text-xs text-neutral-400 hover:bg-neutral-500/10 cursor-pointer transition"
          >
            Annuler
          </button>
          <button
            disabled={applying}
            onClick={handleApply}
            className="px-3 py-1.5 rounded bg-sky-600 font-semibold text-xs text-white hover:bg-sky-500 cursor-pointer transition active:scale-95 disabled:opacity-50"
          >
            {applying ? "Application..." : "Appliquer"}
          </button>
        </div>
      </div>
    </div>
  );
}


import { Server, X } from "lucide-react";
import { TabPromptModalState, TabSession } from "../../types";

interface Props {
  tabPromptModal: TabPromptModalState | null;
  activeTab: TabSession;
  onClose: () => void;
  onReplaceConnection: () => void;
  onOpenInNewTab: () => void;
  isDark?: boolean;
}

export default function TabPromptModal({
  tabPromptModal,
  activeTab,
  onClose,
  onReplaceConnection,
  onOpenInNewTab,
  isDark = true,
}: Props) {
  if (!tabPromptModal) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div
        className={`w-[450px] rounded-xl border p-5 shadow-2xl space-y-4 animate-in zoom-in-95 duration-150 ${
          isDark ? "border-neutral-800 bg-neutral-900 text-neutral-200" : "border-neutral-300 bg-white text-neutral-800"
        }`}
      >
        <div className="flex items-center justify-between border-b border-neutral-500/20 pb-2">
          <div className="flex items-center gap-2 text-sky-500">
            <Server className="h-5 w-5 shrink-0" />
            <span className="font-semibold text-sm">Connexion déjà établie</span>
          </div>
          <button onClick={onClose} className="text-neutral-400 hover:text-white cursor-pointer transition">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-xs text-neutral-400 leading-relaxed">
          Une connexion est déjà active sur cet onglet (
          <span className="text-sky-400 font-semibold">{activeTab.title}</span>).
          Que souhaitez-vous faire ?
        </p>
        <div className="flex flex-col gap-2 pt-2">
          <button
            onClick={() => {
              onClose();
              onReplaceConnection();
            }}
            className="w-full py-2 rounded bg-amber-600 font-semibold text-xs text-white hover:bg-amber-500 cursor-pointer transition active:scale-95"
          >
            Couper la connexion actuelle et se connecter ici
          </button>
          <button
            onClick={() => {
              onClose();
              onOpenInNewTab();
            }}
            className="w-full py-2 rounded bg-sky-600 font-semibold text-xs text-white hover:bg-sky-500 cursor-pointer transition active:scale-95"
          >
            Ouvrir la connexion dans un nouvel onglet
          </button>
          <button
            onClick={onClose}
            className="w-full py-1.5 rounded border border-neutral-700 text-xs text-neutral-400 hover:bg-neutral-500/10 cursor-pointer transition"
          >
            Annuler
          </button>
        </div>
      </div>
    </div>
  );
}


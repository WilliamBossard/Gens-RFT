import { useState } from "react";
import { Settings, X, Sliders, Folder, Info } from "lucide-react";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  theme: "dark" | "light";
  setTheme: (t: "dark" | "light") => void;
  showHidden: boolean;
  setShowHidden: (val: boolean) => void;
  rememberLocalPath: boolean;
  setRememberLocalPath: (val: boolean) => void;
  rememberRemotePath: boolean;
  setRememberRemotePath: (val: boolean) => void;
  showTreePanels: boolean;
  setShowTreePanels: (val: boolean) => void;
  enableSshTerminal: boolean;
  setEnableSshTerminal: (val: boolean) => void;
  maxConcurrent: string;
  setMaxConcurrent: (val: string) => void;
  isDark?: boolean;
}

export default function SettingsModal({
  isOpen,
  onClose,
  theme,
  setTheme,
  showHidden,
  setShowHidden,
  rememberLocalPath,
  setRememberLocalPath,
  rememberRemotePath,
  setRememberRemotePath,
  showTreePanels,
  setShowTreePanels,
  enableSshTerminal,
  setEnableSshTerminal,
  maxConcurrent,
  setMaxConcurrent,
  isDark = true,
}: Props) {
  const [settingsTab, setSettingsTab] = useState<"general" | "panels" | "about">("general");

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div
        className={`w-[600px] h-[460px] rounded-xl border flex flex-col shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150 ${
          isDark ? "border-neutral-800 bg-neutral-900 text-neutral-200" : "border-neutral-300 bg-white text-neutral-800"
        }`}
      >
        <div className="flex items-center justify-between border-b border-neutral-500/20 px-4 py-3">
          <span className="font-semibold text-sm flex items-center gap-2 text-sky-500">
            <Settings className="h-4 w-4" /> Paramètres
          </span>
          <button onClick={onClose} className="text-neutral-400 hover:text-white cursor-pointer transition">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          <div
            className={`w-44 border-r p-2 space-y-1 ${
              isDark ? "border-neutral-800 bg-neutral-950/40" : "border-neutral-200 bg-neutral-50"
            }`}
          >
            <button
              onClick={() => setSettingsTab("general")}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded text-xs cursor-pointer transition ${
                settingsTab === "general"
                  ? "bg-sky-600 text-white font-medium"
                  : "hover:bg-neutral-500/10 text-neutral-400"
              }`}
            >
              <Sliders className="h-3.5 w-3.5" />
              <span>Affichage & Thème</span>
            </button>
            <button
              onClick={() => setSettingsTab("panels")}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded text-xs cursor-pointer transition ${
                settingsTab === "panels"
                  ? "bg-sky-600 text-white font-medium"
                  : "hover:bg-neutral-500/10 text-neutral-400"
              }`}
            >
              <Folder className="h-3.5 w-3.5" />
              <span>Panneaux & Outils</span>
            </button>
            <button
              onClick={() => setSettingsTab("about")}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded text-xs cursor-pointer transition ${
                settingsTab === "about"
                  ? "bg-sky-600 text-white font-medium"
                  : "hover:bg-neutral-500/10 text-neutral-400"
              }`}
            >
              <Info className="h-3.5 w-3.5" />
              <span>À propos & Màj</span>
            </button>
          </div>

          <div className="flex-1 p-5 overflow-y-auto text-xs space-y-4">
            {settingsTab === "general" && (
              <div className="space-y-4">
                <div>
                  <label className="block font-semibold mb-1 text-neutral-300">Thème de l'interface</label>
                  <select
                    value={theme}
                    onChange={(e) => setTheme(e.target.value as "dark" | "light")}
                    className={`w-full rounded border px-3 py-1.5 focus:outline-none cursor-pointer transition ${
                      isDark ? "bg-neutral-950 border-neutral-700 text-neutral-100" : "bg-neutral-50 border-neutral-300 text-neutral-900"
                    }`}
                  >
                    <option value="dark">Mode Sombre</option>
                    <option value="light">Mode Clair</option>
                  </select>
                </div>

                <div className="border-t pt-3 border-neutral-500/20">
                  <label className="block font-semibold mb-1 text-neutral-300">Fichiers système et cachés</label>
                  <label className="flex items-center gap-2 cursor-pointer mt-2">
                    <input
                      type="checkbox"
                      checked={showHidden}
                      onChange={(e) => setShowHidden(e.target.checked)}
                      className="rounded cursor-pointer"
                    />
                    <span>Afficher les fichiers et répertoires cachés (.dotfiles)</span>
                  </label>
                </div>

                <div className="border-t pt-3 border-neutral-500/20">
                  <label className="block font-semibold mb-1 text-neutral-300">Restauration des chemins</label>
                  <div className="space-y-2 mt-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={rememberLocalPath}
                        onChange={(e) => setRememberLocalPath(e.target.checked)}
                        className="rounded cursor-pointer"
                      />
                      <span>Mémoriser le dernier dossier local au démarrage</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={rememberRemotePath}
                        onChange={(e) => setRememberRemotePath(e.target.checked)}
                        className="rounded cursor-pointer"
                      />
                      <span>Mémoriser le dernier dossier distant par serveur</span>
                    </label>
                  </div>
                </div>
              </div>
            )}

            {settingsTab === "panels" && (
              <div className="space-y-4">
                <div>
                  <label className="block font-semibold mb-1 text-neutral-300">Arborescence des dossiers</label>
                  <label className="flex items-center gap-2 cursor-pointer mt-2">
                    <input
                      type="checkbox"
                      checked={showTreePanels}
                      onChange={(e) => setShowTreePanels(e.target.checked)}
                      className="rounded cursor-pointer"
                    />
                    <span>Afficher les arborescences en arbre au-dessus des listes</span>
                  </label>
                </div>

                <div className="border-t pt-3 border-neutral-500/20">
                  <label className="block font-semibold mb-1 text-neutral-300">Terminal SSH interactif</label>
                  <label className="flex items-center gap-2 cursor-pointer mt-2">
                    <input
                      type="checkbox"
                      checked={enableSshTerminal}
                      onChange={(e) => setEnableSshTerminal(e.target.checked)}
                      className="rounded cursor-pointer"
                    />
                    <span>Activer et intégrer l'émulateur de terminal SSH</span>
                  </label>
                </div>

                <div className="border-t pt-3 border-neutral-500/20">
                  <label className="block font-semibold mb-1 text-neutral-300">Transferts concurrents</label>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={maxConcurrent}
                    onChange={(e) => setMaxConcurrent(e.target.value)}
                    className={`w-full rounded border px-3 py-1.5 focus:outline-none transition ${
                      isDark ? "bg-neutral-950 border-neutral-700 text-neutral-100" : "bg-neutral-50 border-neutral-300 text-neutral-900"
                    }`}
                  />
                </div>
              </div>
            )}

            {settingsTab === "about" && (
              <div className="space-y-4">
                <div>
                  <h4 className="font-semibold text-neutral-200">Gens-RFT Desktop</h4>
                  <p className="text-neutral-400 mt-1">Version : 1.0.0 (Release Build)</p>
                  <p className="text-neutral-500 text-[11px] mt-1">
                    Client SFTP / FTP / SSH haute performance basé sur Tauri v2 et Rust.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end p-3 border-t border-neutral-500/20">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded bg-sky-600 font-semibold text-xs text-white hover:bg-sky-500 cursor-pointer transition active:scale-95"
          >
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}


import { useState, useEffect, useRef } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { decryptVaultData, exportVaultData } from "../../utils/cryptoVault";
import {
  SlidersHorizontal,
  X,
  Plus,
  Trash2,
  Server,
  FileUp,
  FileDown,
  FolderOpen,
} from "lucide-react";

export interface SiteProfile {
  id: string;
  name: string;
  protocol: "SFTP" | "FTP" | "FTPS";
  host: string;
  port: string;
  authType: "password" | "key";
  username: string;
  password?: string;
  keyPath?: string;
  passphrase?: string;
  lastRemotePath?: string;
  lastLocalPath?: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  sites: SiteProfile[];
  setSites: (sites: SiteProfile[]) => void;
  onConnect: (site: SiteProfile) => void;
  isDark: boolean;
  logMessage: (msg: string) => void;
}

export default function SiteManagerModal({
  isOpen,
  onClose,
  sites,
  setSites,
  onConnect,
  isDark,
  logMessage,
}: Props) {
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(sites[0]?.id || null);
  const [siteForm, setSiteForm] = useState<SiteProfile>(
    sites[0] || {
      id: "",
      name: "Nouveau serveur",
      protocol: "SFTP",
      host: "",
      port: "22",
      authType: "password",
      username: "",
      password: "",
    }
  );

  const prevIsOpenRef = useRef(false);

  useEffect(() => {
    // Ne synchroniser à l'ouverture que si la modale vient de s'ouvrir
    if (isOpen && !prevIsOpenRef.current) {
      if (selectedSiteId) {
        const found = sites.find((s) => s.id === selectedSiteId);
        if (found) {
          setSiteForm(found);
          prevIsOpenRef.current = true;
          return;
        }
      }
      if (sites.length > 0) {
        setSelectedSiteId(sites[0].id);
        setSiteForm(sites[0]);
      } else {
        setSelectedSiteId(null);
      }
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, sites, selectedSiteId]);

  const handleSelectSite = (site: SiteProfile) => {
    if (selectedSiteId && siteForm.id === selectedSiteId) {
      setSites(sites.map((s) => (s.id === selectedSiteId ? siteForm : s)));
    }
    setSelectedSiteId(site.id);
    setSiteForm(site);
  };

  if (!isOpen) return null;

  const handleExportWithPicker = async () => {
    try {
      const defaultFileName = `gens_rft_sites_${new Date().toISOString().slice(0, 10)}.json`;
      const filePath = await save({
        filters: [{ name: "Fichier JSON", extensions: ["json"] }],
        defaultPath: defaultFileName,
      });

      if (filePath) {
        // Chiffrement AES-GCM portable pour protéger les mots de passe et identifiants
        const encryptedContent = await exportVaultData(sites);
        await invoke("export_sites_to_path", { filePath, jsonContent: encryptedContent });
        logMessage(`Serveurs exportés de manière sécurisée (chiffrée) vers : ${filePath}`);
      }
    } catch (err) {
      logMessage(`Erreur export : ${err}`);
    }
  };

  const handleImport = (file: File) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const raw = (e.target?.result as string).trim();
        let parsed: any;
        if (raw.startsWith("enc:")) {
          parsed = await decryptVaultData<SiteProfile[]>(raw, []);
        } else {
          parsed = JSON.parse(raw);
        }
        if (!Array.isArray(parsed)) throw new Error("Format de fichier non valide.");
        const map = new Map<string, SiteProfile>();
        sites.forEach((s) => map.set(s.id, s));
        parsed.forEach((s: SiteProfile) => {
          if (s.name && s.host) {
            const id = s.id || `site_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
            map.set(id, { ...s, id });
          }
        });
        const updated = Array.from(map.values());
        setSites(updated);
        logMessage(`Import réussi : ${updated.length} profils chargés.`);
      } catch (err) {
        logMessage(`Erreur import : ${err}`);
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div
        className={`flex h-[520px] w-[750px] flex-col rounded-xl border shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150 ${
          isDark ? "border-neutral-800 bg-neutral-900 text-neutral-200" : "border-neutral-300 bg-white text-neutral-800"
        }`}
      >
        <div className="flex items-center justify-between border-b border-neutral-500/20 px-4 py-3">
          <span className="font-semibold text-sm flex items-center gap-2 text-sky-500">
            <SlidersHorizontal className="h-4 w-4" />
            Gestionnaire de sites
          </span>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-200 cursor-pointer transition">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          <div
            className={`w-56 border-r border-neutral-500/20 p-3 flex flex-col justify-between ${
              isDark ? "bg-neutral-950/40" : "bg-neutral-50"
            }`}
          >
            <div className="space-y-1 overflow-y-auto">
              <div className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider mb-2">
                Mes Serveurs
              </div>
              {sites.map((site) => (
                <div
                  key={site.id}
                  onClick={() => handleSelectSite(site)}
                  className={`flex items-center gap-2 px-2.5 py-1.5 rounded cursor-pointer text-xs transition ${
                    selectedSiteId === site.id
                      ? "bg-sky-600 text-white font-medium"
                      : "hover:bg-neutral-500/10 text-neutral-400"
                  }`}
                >
                  <Server className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{site.name}</span>
                </div>
              ))}
            </div>

            <div className="space-y-2 pt-2 border-t border-neutral-500/20">
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    const newSite: SiteProfile = {
                      id: Date.now().toString(),
                      name: `Serveur ${sites.length + 1}`,
                      protocol: "SFTP",
                      host: "",
                      port: "22",
                      authType: "password",
                      username: "",
                      password: "",
                    };
                    setSites([...sites, newSite]);
                    setSelectedSiteId(newSite.id);
                    setSiteForm(newSite);
                  }}
                  className="flex flex-1 items-center justify-center gap-1 py-1.5 rounded border border-neutral-700 hover:bg-neutral-500/10 text-xs cursor-pointer transition active:scale-95"
                >
                  <Plus className="h-3 w-3" /> Nouveau
                </button>
                {selectedSiteId && (
                  <button
                    onClick={() => {
                      setSites(sites.filter((s) => s.id !== selectedSiteId));
                      setSelectedSiteId(null);
                    }}
                    className="px-2 py-1.5 rounded border border-rose-500/30 text-rose-500 hover:bg-rose-500/10 text-xs cursor-pointer transition active:scale-95"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              <div className="flex gap-2">
                <label className="flex flex-1 items-center justify-center gap-1 py-1 rounded border border-neutral-700 hover:bg-neutral-500/10 text-[11px] text-neutral-300 cursor-pointer transition">
                  <FileUp className="h-3 w-3 text-sky-400" />
                  <span>Importer</span>
                  <input
                    type="file"
                    accept=".json"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleImport(file);
                    }}
                  />
                </label>
                <button
                  onClick={handleExportWithPicker}
                  className="flex flex-1 items-center justify-center gap-1 py-1 rounded border border-neutral-700 hover:bg-neutral-500/10 text-[11px] text-neutral-300 cursor-pointer transition"
                >
                  <FileDown className="h-3 w-3 text-emerald-400" />
                  <span>Exporter</span>
                </button>
              </div>
            </div>
          </div>

          <div className="flex-1 p-5 overflow-y-auto space-y-4 text-xs">
            {selectedSiteId ? (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-neutral-400 mb-1">Nom du profil</label>
                    <input
                      type="text"
                      value={siteForm.name}
                      onChange={(e) => setSiteForm({ ...siteForm, name: e.target.value })}
                      className={`w-full rounded border px-3 py-1.5 focus:outline-none transition ${
                        isDark ? "bg-neutral-950 border-neutral-700 text-neutral-100" : "bg-neutral-50 border-neutral-300 text-neutral-900"
                      }`}
                    />
                  </div>
                  <div>
                    <label className="block text-neutral-400 mb-1">Protocole</label>
                    <select
                      value={siteForm.protocol}
                      onChange={(e) => {
                        const prot = e.target.value as "SFTP" | "FTP" | "FTPS";
                        setSiteForm({
                          ...siteForm,
                          protocol: prot,
                          port: prot === "SFTP" ? "22" : "21",
                        });
                      }}
                      className={`w-full rounded border px-3 py-1.5 focus:outline-none cursor-pointer transition ${
                        isDark ? "bg-neutral-950 border-neutral-700 text-neutral-100" : "bg-neutral-50 border-neutral-300 text-neutral-900"
                      }`}
                    >
                      <option value="SFTP">SFTP - SSH File Transfer</option>
                      <option value="FTPS">FTPS - FTP sécurisé (TLS/SSL)</option>
                      <option value="FTP">FTP - File Transfer Protocol (non chiffré)</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div className="col-span-2">
                    <label className="block text-neutral-400 mb-1">Hôte / IP</label>
                    <input
                      type="text"
                      placeholder="192.168.1.100 ou sftp.domaine.com"
                      value={siteForm.host}
                      onChange={(e) => setSiteForm({ ...siteForm, host: e.target.value })}
                      className={`w-full rounded border px-3 py-1.5 focus:outline-none transition ${
                        isDark ? "bg-neutral-950 border-neutral-700 text-neutral-100" : "bg-neutral-50 border-neutral-300 text-neutral-900"
                      }`}
                    />
                  </div>
                  <div>
                    <label className="block text-neutral-400 mb-1">Port</label>
                    <input
                      type="text"
                      value={siteForm.port}
                      onChange={(e) => setSiteForm({ ...siteForm, port: e.target.value })}
                      className={`w-full rounded border px-3 py-1.5 text-center focus:outline-none transition ${
                        isDark ? "bg-neutral-950 border-neutral-700 text-neutral-100" : "bg-neutral-50 border-neutral-300 text-neutral-900"
                      }`}
                    />
                  </div>
                </div>

                <div className="border-t border-neutral-500/20 pt-3">
                  <label className="block text-neutral-400 mb-2 font-medium">Type d'authentification</label>
                  <div className="flex gap-4 mb-3">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="auth"
                        checked={siteForm.authType === "password"}
                        onChange={() => setSiteForm({ ...siteForm, authType: "password" })}
                        className="cursor-pointer"
                      />
                      <span>Mot de passe</span>
                    </label>
                    {siteForm.protocol === "SFTP" && (
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="auth"
                          checked={siteForm.authType === "key"}
                          onChange={() => setSiteForm({ ...siteForm, authType: "key" })}
                          className="cursor-pointer"
                        />
                        <span>Clé SSH privée</span>
                      </label>
                    )}
                  </div>

                  <div className="space-y-3">
                    <div>
                      <label className="block text-neutral-400 mb-1">Nom d'utilisateur</label>
                      <input
                        type="text"
                        placeholder="root"
                        value={siteForm.username}
                        onChange={(e) => setSiteForm({ ...siteForm, username: e.target.value })}
                        className={`w-full rounded border px-3 py-1.5 focus:outline-none transition ${
                          isDark ? "bg-neutral-950 border-neutral-700 text-neutral-100" : "bg-neutral-50 border-neutral-300 text-neutral-900"
                        }`}
                      />
                    </div>

                    {siteForm.authType === "password" ? (
                      <div>
                        <label className="block text-neutral-400 mb-1">Mot de passe</label>
                        <input
                          type="password"
                          value={siteForm.password || ""}
                          onChange={(e) => setSiteForm({ ...siteForm, password: e.target.value })}
                          className={`w-full rounded border px-3 py-1.5 focus:outline-none transition ${
                            isDark ? "bg-neutral-950 border-neutral-700 text-neutral-100" : "bg-neutral-50 border-neutral-300 text-neutral-900"
                          }`}
                        />
                      </div>
                    ) : (
                      <>
                        <div>
                          <label className="block text-neutral-400 mb-1">Chemin de la clé privée</label>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              placeholder="C:\Users\William\.ssh\id_ed25519"
                              value={siteForm.keyPath || ""}
                              onChange={(e) => setSiteForm({ ...siteForm, keyPath: e.target.value })}
                              className={`flex-1 rounded border px-3 py-1.5 font-mono text-[11px] focus:outline-none transition ${
                                isDark ? "bg-neutral-950 border-neutral-700 text-neutral-100" : "bg-neutral-50 border-neutral-300 text-neutral-900"
                              }`}
                            />
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  const selected = await open({
                                    multiple: false,
                                    directory: false,
                                    title: "Sélectionner la clé privée SSH",
                                  });
                                  if (selected && typeof selected === "string") {
                                    setSiteForm({ ...siteForm, keyPath: selected });
                                  }
                                } catch (err) {
                                  logMessage(`Erreur sélection clé : ${err}`);
                                }
                              }}
                              className="px-2.5 py-1.5 rounded border border-neutral-700 hover:bg-neutral-800 text-neutral-300 text-xs flex items-center gap-1 cursor-pointer transition"
                              title="Parcourir les fichiers"
                            >
                              <FolderOpen className="h-3.5 w-3.5" />
                              <span>Parcourir</span>
                            </button>
                          </div>
                        </div>
                        <div>
                          <label className="block text-neutral-400 mb-1">Passphrase</label>
                          <input
                            type="password"
                            value={siteForm.passphrase || ""}
                            onChange={(e) => setSiteForm({ ...siteForm, passphrase: e.target.value })}
                            className={`w-full rounded border px-3 py-1.5 focus:outline-none transition ${
                              isDark ? "bg-neutral-950 border-neutral-700 text-neutral-100" : "bg-neutral-50 border-neutral-300 text-neutral-900"
                            }`}
                          />
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="flex h-full items-center justify-center text-neutral-500">
                Sélectionnez un site ou cliquez sur Nouveau
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-neutral-500/20 px-4 py-3">
          <button
            onClick={() => {
              if (selectedSiteId) {
                setSites(sites.map((s) => (s.id === selectedSiteId ? siteForm : s)));
                logMessage("Profil sauvegardé.");
              }
            }}
            className="px-3 py-1.5 rounded border border-neutral-700 text-xs hover:bg-neutral-500/10 cursor-pointer transition active:scale-95"
          >
            Enregistrer
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded border border-neutral-700 text-xs hover:bg-neutral-500/10 cursor-pointer transition"
            >
              Fermer
            </button>
            <button
              onClick={() => {
                if (selectedSiteId) {
                  setSites(sites.map((s) => (s.id === selectedSiteId ? siteForm : s)));
                  onConnect(siteForm);
                  onClose();
                }
              }}
              className="px-4 py-1.5 rounded bg-sky-600 font-semibold text-xs text-white hover:bg-sky-500 cursor-pointer transition active:scale-95"
            >
              Connexion
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

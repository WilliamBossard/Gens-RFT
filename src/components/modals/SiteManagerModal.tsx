import { useState, useEffect, useRef } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import {
  SiteProfileSummary,
  decryptVaultDataStrict,
  exportVaultEncryptedToPath,
  isPasswordProtectedExport,
  saveSiteProfile,
  deleteSiteProfile,
  importVaultProfiles,
  getSiteSecretsForEdit,
} from "../../utils/cryptoVault";
import {
  SlidersHorizontal,
  X,
  Plus,
  Trash2,
  Server,
  FileUp,
  FileDown,
  FolderOpen,
  Eye,
} from "lucide-react";

export type { SiteProfileSummary };

interface Props {
  isOpen: boolean;
  onClose: () => void;
  sites: SiteProfileSummary[];
  setSites: (sites: SiteProfileSummary[]) => void;
  onConnect: (site: SiteProfileSummary) => void;
  isDark: boolean;
  logMessage: (msg: string) => void;
  vaultLoadFailed?: boolean;
}

const EMPTY_SITE_FORM: SiteProfileSummary = {
  id: "",
  name: "Nouveau serveur",
  protocol: "SFTP",
  host: "",
  port: "22",
  authType: "password",
  username: "",
  hasPassword: false,
  hasPassphrase: false,
};

export default function SiteManagerModal({
  isOpen,
  onClose,
  sites,
  setSites,
  onConnect,
  isDark,
  logMessage,
  vaultLoadFailed = false,
}: Props) {
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(sites[0]?.id || null);
  const [siteForm, setSiteForm] = useState<SiteProfileSummary>(sites[0] || EMPTY_SITE_FORM);
  const [passwordInput, setPasswordInput] = useState("");
  const [passphraseInput, setPassphraseInput] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [clearPassphrase, setClearPassphrase] = useState(false);
  const [secretsRevealed, setSecretsRevealed] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [pendingSwitchSite, setPendingSwitchSite] = useState<SiteProfileSummary | null>(null);

  const prevIsOpenRef = useRef(false);
  const [vaultPwdPrompt, setVaultPwdPrompt] = useState<{
    mode: "export" | "import";
    pendingRaw?: string;
  } | null>(null);
  const [vaultPwdInput, setVaultPwdInput] = useState("");
  const [vaultPwdError, setVaultPwdError] = useState("");
  const [plaintextImportPending, setPlaintextImportPending] = useState<string | null>(null);

  const resetSecretInputs = () => {
    setPasswordInput("");
    setPassphraseInput("");
    setClearPassword(false);
    setClearPassphrase(false);
    setSecretsRevealed(false);
    setIsDirty(false);
    setPendingSwitchSite(null);
  };

  const updateSiteForm = (next: SiteProfileSummary) => {
    setSiteForm(next);
    setIsDirty(true);
  };

  useEffect(() => {
    // Ne synchroniser à l'ouverture que si la modale vient de s'ouvrir
    if (isOpen && !prevIsOpenRef.current) {
      resetSecretInputs();
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
        setSiteForm(EMPTY_SITE_FORM);
      }
    }
    if (!isOpen && prevIsOpenRef.current) {
      resetSecretInputs();
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, sites, selectedSiteId]);

  const applySwitchSite = (site: SiteProfileSummary) => {
    resetSecretInputs();
    setSelectedSiteId(site.id);
    setSiteForm(site);
  };

  const handleSelectSite = (site: SiteProfileSummary) => {
    if (site.id === selectedSiteId) return;
    if (isDirty) {
      setPendingSwitchSite(site);
      return;
    }
    applySwitchSite(site);
  };

  const saveCurrentForm = async (): Promise<SiteProfileSummary | null> => {
    if (vaultLoadFailed) {
      logMessage("Sauvegarde bloquée : le coffre initial n'a pas pu être déchiffré (protection anti-écrasement).");
      return null;
    }
    if (!selectedSiteId) return null;
    const updatedList = await saveSiteProfile({
      id: siteForm.id || selectedSiteId,
      name: siteForm.name,
      protocol: siteForm.protocol,
      host: siteForm.host,
      port: siteForm.port,
      authType: siteForm.protocol === "SFTP" ? siteForm.authType : "password",
      username: siteForm.username,
      password: secretsRevealed || passwordInput.length > 0 ? passwordInput : undefined,
      clearPassword,
      keyPath: siteForm.keyPath,
      passphrase: secretsRevealed || passphraseInput.length > 0 ? passphraseInput : undefined,
      clearPassphrase,
      lastRemotePath: siteForm.lastRemotePath,
      lastLocalPath: siteForm.lastLocalPath,
      acceptInvalidCerts: !!siteForm.acceptInvalidCerts,
    });
    setSites(updatedList);
    const saved = updatedList.find((s) => s.id === selectedSiteId) || siteForm;
    setSiteForm(saved);
    resetSecretInputs();
    return saved;
  };

  if (!isOpen) return null;

  const runExportWithPassword = async (password: string) => {
    if (vaultLoadFailed) {
      logMessage("Export annulé : le coffre n'est pas chargé.");
      return;
    }
    try {
      const defaultFileName = `gens_rft_sites_${new Date().toISOString().slice(0, 10)}.json`;
      const filePath = await save({
        filters: [{ name: "Fichier JSON", extensions: ["json"] }],
        defaultPath: defaultFileName,
      });

      if (filePath) {
        await exportVaultEncryptedToPath(filePath, password);
        logMessage(`Serveurs exportés avec chiffrement vers : ${filePath}`);
      }
    } catch (err) {
      logMessage(`Erreur export : ${err}`);
    }
  };

  const handleExportWithPicker = () => {
    setVaultPwdInput("");
    setVaultPwdError("");
    setVaultPwdPrompt({ mode: "export" });
  };

  const applyImportedRaw = async (raw: string, password?: string) => {
    if (vaultLoadFailed) {
      logMessage("Import annulé : le coffre initial est verrouillé.");
      return;
    }
    try {
      let parsed: unknown;
      if (raw.startsWith("enc:")) {
        if (!isPasswordProtectedExport(raw)) {
          throw new Error("Ce format de fichier chiffré interne ne peut pas être importé sans mot de passe.");
        }
        parsed = await decryptVaultDataStrict<unknown[]>(raw, password);
        if (!Array.isArray(parsed)) {
          throw new Error("Déchiffrement impossible (mot de passe incorrect ou format invalide).");
        }
      } else {
        parsed = JSON.parse(raw);
      }
      if (!Array.isArray(parsed)) throw new Error("Format de fichier non valide.");
      const updated = await importVaultProfiles(parsed);
      setSites(updated);
      resetSecretInputs();
      if (updated.length > 0) {
        setSelectedSiteId(updated[0].id);
        setSiteForm(updated[0]);
      } else {
        setSelectedSiteId(null);
        setSiteForm(EMPTY_SITE_FORM);
      }
      logMessage(`Import réussi : ${updated.length} profils chargés.`);
    } catch (err) {
      logMessage(`Erreur import : ${err}`);
    }
  };

  const handleImport = (file: File) => {
    const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
    if (file.size > MAX_IMPORT_BYTES) {
      logMessage("Erreur import : fichier trop volumineux (> 10 Mo).");
      return;
    }
    const reader = new FileReader();
    reader.onload = async (e) => {
      const raw = ((e.target?.result as string) || "").trim();
      if (isPasswordProtectedExport(raw)) {
        setVaultPwdInput("");
        setVaultPwdError("");
        setVaultPwdPrompt({ mode: "import", pendingRaw: raw });
        return;
      }
      if (!raw.startsWith("enc:")) {
        setPlaintextImportPending(raw);
        return;
      }
      await applyImportedRaw(raw);
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
                  onClick={async () => {
                    if (vaultLoadFailed) {
                      logMessage("Création bloquée : coffre verrouillé.");
                      return;
                    }
                    try {
                      const newId =
                        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
                          ? crypto.randomUUID()
                          : Date.now().toString();
                      const updated = await saveSiteProfile({
                        id: newId,
                        name: `Serveur ${sites.length + 1}`,
                        protocol: "SFTP",
                        host: "",
                        port: "22",
                        authType: "password",
                        username: "",
                        clearPassword: false,
                        clearPassphrase: false,
                        acceptInvalidCerts: false,
                      });
                      setSites(updated);
                      const created = updated.find((s) => s.id === newId);
                      resetSecretInputs();
                      setSelectedSiteId(newId);
                      if (created) setSiteForm(created);
                    } catch (err) {
                      logMessage(`Erreur création profil : ${err}`);
                    }
                  }}
                  className="flex flex-1 items-center justify-center gap-1 py-1.5 rounded border border-neutral-700 hover:bg-neutral-500/10 text-xs cursor-pointer transition active:scale-95"
                >
                  <Plus className="h-3 w-3" /> Nouveau
                </button>
                {selectedSiteId && (
                  <button
                    onClick={async () => {
                      if (vaultLoadFailed || !selectedSiteId) return;
                      try {
                        const remaining = await deleteSiteProfile(selectedSiteId);
                        setSites(remaining);
                        resetSecretInputs();
                        setSelectedSiteId(remaining[0]?.id || null);
                        setSiteForm(remaining[0] || EMPTY_SITE_FORM);
                      } catch (err) {
                        logMessage(`Erreur suppression profil : ${err}`);
                      }
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
                      e.target.value = "";
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
                      onChange={(e) => updateSiteForm({ ...siteForm, name: e.target.value })}
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
                        updateSiteForm({
                          ...siteForm,
                          protocol: prot,
                          port: prot === "SFTP" ? "22" : "21",
                          authType: prot === "SFTP" ? siteForm.authType : "password",
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

                {siteForm.protocol === "FTPS" && (
                  <label className="flex items-center gap-2 cursor-pointer text-[11px] text-amber-400">
                    <input
                      type="checkbox"
                      checked={!!siteForm.acceptInvalidCerts}
                      onChange={(e) =>
                        updateSiteForm({ ...siteForm, acceptInvalidCerts: e.target.checked })
                      }
                      className="rounded cursor-pointer"
                    />
                    <span>Accepter les certificats TLS auto-signés ou invalides (non recommandé)</span>
                  </label>
                )}

                <div className="grid grid-cols-3 gap-4">
                  <div className="col-span-2">
                    <label className="block text-neutral-400 mb-1">Hôte / IP</label>
                    <input
                      type="text"
                      placeholder="192.168.1.100 ou sftp.domaine.com"
                      value={siteForm.host}
                      onChange={(e) => updateSiteForm({ ...siteForm, host: e.target.value })}
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
                      onChange={(e) => updateSiteForm({ ...siteForm, port: e.target.value })}
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
                        onChange={() => updateSiteForm({ ...siteForm, authType: "password" })}
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
                          onChange={() => updateSiteForm({ ...siteForm, authType: "key" })}
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
                        onChange={(e) => updateSiteForm({ ...siteForm, username: e.target.value })}
                        className={`w-full rounded border px-3 py-1.5 focus:outline-none transition ${
                          isDark ? "bg-neutral-950 border-neutral-700 text-neutral-100" : "bg-neutral-50 border-neutral-300 text-neutral-900"
                        }`}
                      />
                    </div>

                    {siteForm.authType === "password" ? (
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <label className="text-neutral-400">
                            Mot de passe
                            {siteForm.hasPassword && !clearPassword && !secretsRevealed && (
                              <span className="ml-2 text-[10px] text-emerald-400">(enregistré dans le coffre)</span>
                            )}
                            {clearPassword && (
                              <span className="ml-2 text-[10px] text-amber-400">(sera effacé à l'enregistrement)</span>
                            )}
                          </label>
                          {siteForm.hasPassword && !secretsRevealed && (
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={async () => {
                                  if (!selectedSiteId) return;
                                  try {
                                    const sec = await getSiteSecretsForEdit(selectedSiteId);
                                    setPasswordInput(sec.password);
                                    setPassphraseInput(sec.passphrase);
                                    setSecretsRevealed(true);
                                    setClearPassword(false);
                                    setClearPassphrase(false);
                                  } catch (err) {
                                    logMessage(`Erreur lecture coffre : ${err}`);
                                  }
                                }}
                                className="flex items-center gap-1 text-[10px] text-sky-400 hover:text-sky-300 cursor-pointer"
                              >
                                <Eye className="h-3 w-3" />
                                <span>Modifier / Révéler</span>
                              </button>
                              {!clearPassword && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setPasswordInput("");
                                    setClearPassword(true);
                                    setIsDirty(true);
                                  }}
                                  className="text-[10px] text-rose-400 hover:text-rose-300 cursor-pointer"
                                >
                                  Effacer
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                        <input
                          type="password"
                          placeholder={
                            siteForm.hasPassword && !clearPassword && !secretsRevealed
                              ? "•••••••• (laisser vide pour conserver l'actuel)"
                              : "Saisir un mot de passe"
                          }
                          value={passwordInput}
                          onChange={(e) => {
                            setPasswordInput(e.target.value);
                            setIsDirty(true);
                            if (clearPassword && e.target.value.length > 0) setClearPassword(false);
                          }}
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
                              onChange={(e) => updateSiteForm({ ...siteForm, keyPath: e.target.value })}
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
                                    updateSiteForm({ ...siteForm, keyPath: selected });
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
                          <div className="flex items-center justify-between mb-1">
                            <label className="text-neutral-400">
                              Passphrase
                              {siteForm.hasPassphrase && !clearPassphrase && !secretsRevealed && (
                                <span className="ml-2 text-[10px] text-emerald-400">(enregistrée dans le coffre)</span>
                              )}
                            </label>
                            {siteForm.hasPassphrase && !secretsRevealed && (
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={async () => {
                                    if (!selectedSiteId) return;
                                    try {
                                      const sec = await getSiteSecretsForEdit(selectedSiteId);
                                      setPasswordInput(sec.password);
                                      setPassphraseInput(sec.passphrase);
                                      setSecretsRevealed(true);
                                      setClearPassword(false);
                                      setClearPassphrase(false);
                                    } catch (err) {
                                      logMessage(`Erreur lecture coffre : ${err}`);
                                    }
                                  }}
                                  className="flex items-center gap-1 text-[10px] text-sky-400 hover:text-sky-300 cursor-pointer"
                                >
                                  <Eye className="h-3 w-3" />
                                  <span>Modifier / Révéler</span>
                                </button>
                                {!clearPassphrase && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setPassphraseInput("");
                                      setClearPassphrase(true);
                                      setIsDirty(true);
                                    }}
                                    className="text-[10px] text-rose-400 hover:text-rose-300 cursor-pointer"
                                  >
                                    Effacer
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                          <input
                            type="password"
                            placeholder={
                              siteForm.hasPassphrase && !clearPassphrase && !secretsRevealed
                                ? "•••••••• (laisser vide pour conserver l'actuelle)"
                                : "Passphrase optionnelle"
                            }
                            value={passphraseInput}
                            onChange={(e) => {
                              setPassphraseInput(e.target.value);
                              setIsDirty(true);
                              if (clearPassphrase && e.target.value.length > 0) setClearPassphrase(false);
                            }}
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
            onClick={async () => {
              try {
                const saved = await saveCurrentForm();
                if (saved) {
                  logMessage("Profil sauvegardé.");
                }
              } catch (err) {
                logMessage(`Erreur sauvegarde profil : ${err}`);
              }
            }}
            className="px-3 py-1.5 rounded border border-neutral-700 text-xs hover:bg-neutral-500/10 cursor-pointer transition active:scale-95"
          >
            Enregistrer
          </button>
          <div className="flex gap-2">
            <button
              onClick={() => {
                resetSecretInputs();
                onClose();
              }}
              className="px-3 py-1.5 rounded border border-neutral-700 text-xs hover:bg-neutral-500/10 cursor-pointer transition"
            >
              Fermer
            </button>
            <button
              onClick={async () => {
                if (!selectedSiteId) return;
                try {
                  const targetSite = !vaultLoadFailed ? await saveCurrentForm() : siteForm;
                  if (targetSite) {
                    onConnect(targetSite);
                    onClose();
                  }
                } catch (err) {
                  logMessage(`Erreur connexion profil : ${err}`);
                }
              }}
              className="px-4 py-1.5 rounded bg-sky-600 font-semibold text-xs text-white hover:bg-sky-500 cursor-pointer transition active:scale-95"
            >
              Connexion
            </button>
          </div>
        </div>

        {plaintextImportPending !== null && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
            <div
              className={`w-80 rounded-xl border p-4 shadow-2xl space-y-3 ${
                isDark
                  ? "bg-neutral-900 border-neutral-700 text-neutral-200"
                  : "bg-white border-neutral-300 text-neutral-800"
              }`}
            >
              <h4 className="font-semibold text-xs text-amber-400">
                Fichier d'import non chiffré
              </h4>
              <p className="text-[11px] text-neutral-400">
                Ce fichier JSON contient des profils en clair (non protégés par mot de passe). Voulez-vous tout de même importer ces serveurs dans votre coffre chiffré local ?
              </p>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => setPlaintextImportPending(null)}
                  className="px-3 py-1 rounded border border-neutral-700 text-xs text-neutral-400 hover:bg-neutral-500/10 cursor-pointer"
                >
                  Annuler
                </button>
                <button
                  onClick={async () => {
                    const raw = plaintextImportPending;
                    setPlaintextImportPending(null);
                    await applyImportedRaw(raw);
                  }}
                  className="px-3 py-1 rounded bg-amber-600 hover:bg-amber-500 font-semibold text-xs text-white cursor-pointer"
                >
                  Importer quand même
                </button>
              </div>
            </div>
          </div>
        )}

        {vaultPwdPrompt && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
            <div
              className={`w-80 rounded-xl border p-4 shadow-2xl space-y-3 ${
                isDark
                  ? "bg-neutral-900 border-neutral-700 text-neutral-200"
                  : "bg-white border-neutral-300 text-neutral-800"
              }`}
            >
              <h4 className="font-semibold text-xs text-sky-400">
                {vaultPwdPrompt.mode === "export"
                  ? "Mot de passe d'export (obligatoire)"
                  : "Fichier protégé par mot de passe"}
              </h4>
              <p className="text-[11px] text-neutral-400">
                {vaultPwdPrompt.mode === "export"
                  ? "Saisissez un mot de passe (minimum 8 caractères) pour chiffrer vos identifiants exportés."
                  : "Saisissez le mot de passe utilisé lors de l'export de ce fichier."}
              </p>
              <input
                type="password"
                autoFocus
                placeholder="Mot de passe..."
                value={vaultPwdInput}
                onChange={(e) => {
                  setVaultPwdInput(e.target.value);
                  setVaultPwdError("");
                }}
                onKeyDown={async (e) => {
                  if (e.key === "Enter") {
                    const p = vaultPwdPrompt;
                    if (p.mode === "export" && vaultPwdInput.trim().length < 8) {
                      setVaultPwdError("Minimum 8 caractères requis.");
                      return;
                    }
                    setVaultPwdPrompt(null);
                    if (p.mode === "export") {
                      await runExportWithPassword(vaultPwdInput);
                    } else if (p.pendingRaw) {
                      await applyImportedRaw(p.pendingRaw, vaultPwdInput);
                    }
                  } else if (e.key === "Escape") {
                    setVaultPwdPrompt(null);
                  }
                }}
                className={`w-full rounded border px-2.5 py-1.5 text-xs focus:outline-none ${
                  isDark
                    ? "bg-neutral-950 border-neutral-700 text-neutral-100"
                    : "bg-neutral-50 border-neutral-300 text-neutral-900"
                }`}
              />
              {vaultPwdError && (
                <p className="text-[11px] text-rose-400">{vaultPwdError}</p>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => setVaultPwdPrompt(null)}
                  className="px-3 py-1 rounded border border-neutral-700 text-xs text-neutral-400 hover:bg-neutral-500/10 cursor-pointer"
                >
                  Annuler
                </button>
                <button
                  onClick={async () => {
                    const p = vaultPwdPrompt;
                    if (p.mode === "export" && vaultPwdInput.trim().length < 8) {
                      setVaultPwdError("Minimum 8 caractères requis.");
                      return;
                    }
                    setVaultPwdPrompt(null);
                    if (p.mode === "export") {
                      await runExportWithPassword(vaultPwdInput);
                    } else if (p.pendingRaw) {
                      await applyImportedRaw(p.pendingRaw, vaultPwdInput);
                    }
                  }}
                  className="px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 font-semibold text-xs text-white cursor-pointer"
                >
                  Confirmer
                </button>
              </div>
            </div>
          </div>
        )}
        {pendingSwitchSite && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
            <div
              className={`w-80 rounded-xl border p-4 shadow-2xl space-y-3 ${
                isDark
                  ? "bg-neutral-900 border-neutral-700 text-neutral-200"
                  : "bg-white border-neutral-300 text-neutral-800"
              }`}
            >
              <h4 className="font-semibold text-xs text-amber-400">
                Modifications non enregistrées
              </h4>
              <p className="text-[11px] text-neutral-400">
                Le profil actuel contient des modifications non sauvegardées. Voulez-vous les enregistrer avant de changer de serveur ?
              </p>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => setPendingSwitchSite(null)}
                  className="px-2.5 py-1 rounded border border-neutral-700 text-xs text-neutral-400 hover:bg-neutral-500/10 cursor-pointer"
                >
                  Annuler
                </button>
                <button
                  onClick={() => {
                    const next = pendingSwitchSite;
                    applySwitchSite(next);
                  }}
                  className="px-2.5 py-1 rounded border border-rose-500/40 text-xs text-rose-400 hover:bg-rose-500/10 cursor-pointer"
                >
                  Ignorer
                </button>
                <button
                  onClick={async () => {
                    const next = pendingSwitchSite;
                    try {
                      await saveCurrentForm();
                      applySwitchSite(next);
                    } catch (err) {
                      logMessage(`Erreur sauvegarde profil : ${err}`);
                      setPendingSwitchSite(null);
                    }
                  }}
                  className="px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 font-semibold text-xs text-white cursor-pointer"
                >
                  Enregistrer
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

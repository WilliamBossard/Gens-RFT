import {
  FilePlus,
  FolderPlus,
  RefreshCw,
  FileEdit,
  ExternalLink,
  FolderArchive,
  Archive,
  Download,
  Calculator,
  ShieldCheck,
  Edit2,
  Upload,
  Trash2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { ContextMenuState, FileEntry, TabSession } from "../../types";
import { isArchiveFile, isEditableTextFile } from "../../utils/fileHelpers";
import { EditorModalState } from "../modals/FileEditorModal";
import { ChmodModalState } from "../modals/ChmodModal";

interface Props {
  isDark: boolean;
  contextMenu: ContextMenuState | null;
  onClose: () => void;
  activeTab: TabSession;
  currentPath: string;
  files: FileEntry[];
  selectedLocalPaths: Set<string>;
  setSelectedLocalPaths: (val: Set<string>) => void;
  selectedRemotePaths: Set<string>;
  setSelectedRemotePaths: (val: Set<string>) => void;
  onNavigateLocal: (targetPath?: string) => void;
  onNavigateRemote: (targetPath?: string) => void;
  onCheckAndEnqueueTransfer: (
    filename: string,
    sourcePath: string,
    destDir: string,
    direction: "upload" | "download",
    isDir: boolean,
    destSessionId?: string
  ) => void;
  onPromptInputModal: (modal: {
    title: string;
    label: string;
    value: string;
    onConfirm: (val: string) => void;
  }) => void;
  onPromptConfirmModal: (modal: {
    title: string;
    message: string;
    onConfirm: () => void;
  }) => void;
  setEditorModal: (modal: EditorModalState | null) => void;
  setChmodModal: (modal: ChmodModalState | null) => void;
  logMessage: (msg: string) => void;
}

export default function FileContextMenu({
  isDark,
  contextMenu,
  onClose,
  activeTab,
  currentPath,
  files,
  selectedLocalPaths,
  setSelectedLocalPaths,
  selectedRemotePaths,
  setSelectedRemotePaths,
  onNavigateLocal,
  onNavigateRemote,
  onCheckAndEnqueueTransfer,
  onPromptInputModal,
  onPromptConfirmModal,
  setEditorModal,
  setChmodModal,
  logMessage,
}: Props) {
  if (!contextMenu) return null;

  return (
    <div
      style={{
        top: `${Math.min(window.innerHeight - 280, contextMenu.y)}px`,
        left: `${Math.min(window.innerWidth - 220, contextMenu.x)}px`,
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      className={`fixed z-[100] min-w-56 rounded-lg border py-1 shadow-2xl text-xs backdrop-blur-md animate-in fade-in zoom-in-95 duration-100 ${
        isDark ? "border-neutral-800 bg-neutral-900/95 text-neutral-200" : "border-neutral-300 bg-white/95 text-neutral-800"
      }`}
    >
      {contextMenu.entry === null ? (
        <>
          <div className="px-3 py-1 text-[10px] uppercase font-bold text-neutral-500 tracking-wider">
            {contextMenu.isRemote ? "Dossier Distant" : "Dossier Local"}
          </div>
          <button
            onClick={() => {
              const isRem = contextMenu.isRemote;
              onClose();
              onPromptInputModal({
                title: isRem ? "Nouveau fichier distant" : "Nouveau fichier local",
                label: "Nom du fichier avec extension (ex: index.html, style.css, script.py) :",
                value: "nouveau_fichier.txt",
                onConfirm: async (val) => {
                  if (!val.trim()) return;
                  const fileName = val.trim();
                  if (isRem) {
                    const target = activeTab.remotePath.endsWith("/")
                      ? `${activeTab.remotePath}${fileName}`
                      : `${activeTab.remotePath}/${fileName}`;
                    try {
                      await invoke("save_remote_file_text", {
                        sessionId: activeTab.id,
                        remotePath: target,
                        content: "",
                      });
                      logMessage(`Fichier distant créé : ${target}`);
                      onNavigateRemote(activeTab.remotePath);
                    } catch (err) {
                      logMessage(`Erreur création fichier distant : ${err}`);
                    }
                  } else {
                    const cleanPath = currentPath.replace(/[\\/]+$/, "");
                    const target = `${cleanPath}\\${fileName}`;
                    try {
                      await invoke("create_local_file", { path: target });
                      logMessage(`Fichier local créé : ${target}`);
                      onNavigateLocal(currentPath);
                    } catch (err) {
                      logMessage(`Erreur création fichier local : ${err}`);
                    }
                  }
                },
              });
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-sky-500/20 cursor-pointer text-emerald-400"
          >
            <FilePlus className="h-3.5 w-3.5" />
            <span>Nouveau fichier...</span>
          </button>

          <button
            onClick={() => {
              const isRem = contextMenu.isRemote;
              onClose();
              onPromptInputModal({
                title: isRem ? "Nouveau dossier distant" : "Nouveau dossier local",
                label: "Nom du dossier :",
                value: "nouveau_dossier",
                onConfirm: async (val) => {
                  if (!val.trim()) return;
                  const dirName = val.trim();
                  if (isRem) {
                    const target = activeTab.remotePath.endsWith("/")
                      ? `${activeTab.remotePath}${dirName}`
                      : `${activeTab.remotePath}/${dirName}`;
                    try {
                      await invoke("create_remote_dir", {
                        sessionId: activeTab.id,
                        path: target,
                      });
                      logMessage(`MKD ${target}`);
                      onNavigateRemote(activeTab.remotePath);
                    } catch (err) {
                      logMessage(`Erreur création dossier distant : ${err}`);
                    }
                  } else {
                    const cleanPath = currentPath.replace(/[\\/]+$/, "");
                    const target = `${cleanPath}\\${dirName}`;
                    try {
                      await invoke("create_local_dir", { path: target });
                      logMessage(`Dossier local créé : ${target}`);
                      onNavigateLocal(currentPath);
                    } catch (err) {
                      logMessage(`Erreur création dossier local : ${err}`);
                    }
                  }
                },
              });
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-sky-500/20 cursor-pointer text-amber-400"
          >
            <FolderPlus className="h-3.5 w-3.5" />
            <span>Nouveau dossier...</span>
          </button>

          <div className="my-1 border-t border-neutral-500/20" />

          <button
            onClick={() => {
              const isRem = contextMenu.isRemote;
              onClose();
              if (isRem) {
                onNavigateRemote(activeTab.remotePath);
              } else {
                onNavigateLocal(currentPath);
              }
              logMessage("Répertoire actualisé.");
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-sky-500/20 cursor-pointer text-neutral-300"
          >
            <RefreshCw className="h-3.5 w-3.5 text-sky-400" />
            <span>Actualiser (F5)</span>
          </button>
        </>
      ) : contextMenu.isRemote ? (
        <>
          {!contextMenu.entry.is_dir && (
            <>
              {isEditableTextFile(contextMenu.entry.name) && (
                <button
                  onClick={async () => {
                    const entry = contextMenu.entry!;
                    onClose();
                    logMessage(`Lecture de "${entry.name}" pour édition...`);
                    try {
                      const res = await invoke<{ content: string; is_lossy: boolean }>("read_remote_file_text", {
                        sessionId: activeTab.id,
                        remotePath: entry.path,
                      });
                      setEditorModal({
                        path: entry.path,
                        filename: entry.name,
                        content: res.content,
                        originalContent: res.content,
                        isLossy: res.is_lossy,
                        saving: false,
                      });
                    } catch (err) {
                      logMessage(`Erreur lecture : ${err}`);
                    }
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-sky-500/20 cursor-pointer text-sky-400"
                >
                  <FileEdit className="h-3.5 w-3.5" />
                  <span>Éditer dans Gens-RFT</span>
                </button>
              )}
              <button
                onClick={async () => {
                  const entry = contextMenu.entry!;
                  onClose();
                  logMessage(`Téléchargement temporaire et ouverture de "${entry.name}"...`);
                  try {
                    const tempPath = await invoke<string>("open_remote_with_system", {
                      sessionId: activeTab.id,
                      remotePath: entry.path,
                    });
                    logMessage(`Fichier ouvert : ${tempPath}`);
                  } catch (err) {
                    logMessage(`Erreur d'ouverture : ${err}`);
                  }
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-sky-500/20 cursor-pointer"
              >
                <ExternalLink className="h-3.5 w-3.5 text-amber-500" />
                <span>Ouvrir avec Windows...</span>
              </button>
            </>
          )}

          {/* Compression / Décompression distante (SFTP / SSH uniquement) */}
          {activeTab.protocol === "SFTP" && (
            isArchiveFile(contextMenu.entry.name) ? (
              <button
                onClick={async () => {
                  const entry = contextMenu.entry!;
                  onClose();
                  logMessage(`Extraction distante de "${entry.name}"...`);
                  try {
                    await invoke("extract_remote", {
                      sessionId: activeTab.id,
                      parentDir: activeTab.remotePath,
                      archiveName: entry.name,
                    });
                    logMessage(`Archive "${entry.name}" extraite.`);
                    onNavigateRemote(activeTab.remotePath);
                  } catch (err) {
                    logMessage(`Échec extraction distante : ${err}`);
                  }
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-sky-500/20 cursor-pointer text-amber-400"
              >
                <FolderArchive className="h-3.5 w-3.5" />
                <span>Décompresser ici</span>
              </button>
            ) : (
              <button
                onClick={async () => {
                  const entry = contextMenu.entry!;
                  onClose();
                  logMessage(`Compression de "${entry.name}" en tar.gz...`);
                  try {
                    const res = await invoke<string>("compress_remote", {
                      sessionId: activeTab.id,
                      parentDir: activeTab.remotePath,
                      itemName: entry.name,
                      format: "tar.gz",
                    });
                    logMessage(`Archive créée : ${res}`);
                    onNavigateRemote(activeTab.remotePath);
                  } catch (err) {
                    logMessage(`Échec compression distante : ${err}`);
                  }
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-sky-500/20 cursor-pointer"
              >
                <Archive className="h-3.5 w-3.5 text-amber-500" />
                <span>Compresser (.tar.gz)</span>
              </button>
            )
          )}

          <button
            onClick={() => {
              const entry = contextMenu.entry!;
              let itemsToDownload: FileEntry[] = [];
              if (selectedRemotePaths.has(entry.path) && selectedRemotePaths.size > 1) {
                itemsToDownload = activeTab.remoteFiles.filter((f) => selectedRemotePaths.has(f.path));
              } else {
                itemsToDownload = [entry];
              }
              onClose();
              for (const it of itemsToDownload) {
                onCheckAndEnqueueTransfer(it.name, it.path, currentPath, "download", it.is_dir);
              }
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-sky-500/20 cursor-pointer"
          >
            <Download className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
            <span>
              {selectedRemotePaths.size > 1 && selectedRemotePaths.has(contextMenu.entry.path)
                ? `Télécharger les ${selectedRemotePaths.size} éléments`
                : "Télécharger"}
            </span>
          </button>
          {activeTab.protocol === "SFTP" && (
            <button
              onClick={async () => {
                const entry = contextMenu.entry!;
                onClose();
                logMessage(`Calcul de la taille pour "${entry.name}"...`);
                try {
                  const out = await invoke<string>("get_remote_size", {
                    sessionId: activeTab.id,
                    remotePath: entry.path,
                  });
                  logMessage(`Taille (${entry.name}) : ${out.trim()}`);
                } catch (err) {
                  logMessage(`Erreur calcul taille : ${err}`);
                }
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-sky-500/20 cursor-pointer"
            >
              <Calculator className="h-3.5 w-3.5 text-indigo-500" />
              <span>Calculer la taille</span>
            </button>
          )}
          <button
            onClick={() => {
              const currentOctal = contextMenu.entry!.permissions
                ? (contextMenu.entry!.permissions & 0o777).toString(8)
                : "755";
              setChmodModal({
                path: contextMenu.entry!.path,
                name: contextMenu.entry!.name,
                octal: currentOctal,
              });
              onClose();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-sky-500/20 cursor-pointer"
          >
            <ShieldCheck className="h-3.5 w-3.5 text-sky-500" />
            <span>Permissions (CHMOD)</span>
          </button>

          <button
            onClick={() => {
              const entry = contextMenu.entry!;
              onClose();
              onPromptInputModal({
                title: "Renommer l'élément distant",
                label: "Nouveau nom :",
                value: entry.name,
                onConfirm: async (val) => {
                  if (!val.trim() || val.trim() === entry.name) return;
                  const newName = val.trim();
                  const parent = entry.path.split("/").slice(0, -1).join("/") || "/";
                  const newPath = parent.endsWith("/") ? `${parent}${newName}` : `${parent}/${newName}`;
                  try {
                    await invoke("rename_remote", {
                      sessionId: activeTab.id,
                      oldPath: entry.path,
                      newPath,
                    });
                    logMessage(`Renommé à distance : ${entry.name} -> ${newName}`);
                    onNavigateRemote(activeTab.remotePath);
                  } catch (err) {
                    logMessage(`Erreur renommage distant : ${err}`);
                  }
                },
              });
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-sky-500/20 cursor-pointer"
          >
            <Edit2 className="h-3.5 w-3.5 text-sky-400" />
            <span>Renommer (F2)</span>
          </button>
        </>
      ) : (
        <>
          {/* Compression / Décompression locale */}
          {isArchiveFile(contextMenu.entry.name) ? (
            <button
              onClick={async () => {
                const entry = contextMenu.entry!;
                onClose();
                logMessage(`Extraction locale de "${entry.name}"...`);
                try {
                  await invoke("extract_local", { path: entry.path });
                  logMessage(`Archive locale extraite.`);
                  onNavigateLocal(currentPath);
                } catch (err) {
                  logMessage(`Erreur extraction locale : ${err}`);
                }
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-sky-500/20 cursor-pointer text-amber-400"
            >
              <FolderArchive className="h-3.5 w-3.5" />
              <span>Extraire ici (ZIP)</span>
            </button>
          ) : (
            <button
              onClick={async () => {
                const entry = contextMenu.entry!;
                onClose();
                logMessage(`Compression locale de "${entry.name}"...`);
                try {
                  const res = await invoke<string>("compress_local", { path: entry.path, format: "zip" });
                  logMessage(`Archive créée : ${res}`);
                  onNavigateLocal(currentPath);
                } catch (err) {
                  logMessage(`Erreur compression locale : ${err}`);
                }
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-sky-500/20 cursor-pointer"
            >
              <Archive className="h-3.5 w-3.5 text-amber-500" />
              <span>Compresser en .zip</span>
            </button>
          )}

          <button
            onClick={() => {
              const entry = contextMenu.entry!;
              let itemsToUpload: FileEntry[] = [];
              if (selectedLocalPaths.has(entry.path) && selectedLocalPaths.size > 1) {
                itemsToUpload = files.filter((f) => selectedLocalPaths.has(f.path));
              } else {
                itemsToUpload = [entry];
              }
              onClose();
              for (const it of itemsToUpload) {
                onCheckAndEnqueueTransfer(it.name, it.path, activeTab.remotePath, "upload", it.is_dir);
              }
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-sky-500/20 cursor-pointer"
          >
            <Upload className="h-3.5 w-3.5 text-sky-500 shrink-0" />
            <span>
              {selectedLocalPaths.size > 1 && selectedLocalPaths.has(contextMenu.entry.path)
                ? `Envoyer les ${selectedLocalPaths.size} éléments`
                : "Envoyer sur le serveur actif"}
            </span>
          </button>

          <button
            onClick={() => {
              const entry = contextMenu.entry!;
              onClose();
              onPromptInputModal({
                title: "Renommer l'élément local",
                label: "Nouveau nom :",
                value: entry.name,
                onConfirm: async (val) => {
                  if (!val.trim() || val.trim() === entry.name) return;
                  const newName = val.trim();
                  const sep = entry.path.includes("/") ? "/" : "\\";
                  const parent = entry.path.split(sep).slice(0, -1).join(sep);
                  const newPath = `${parent}${sep}${newName}`;
                  try {
                    await invoke("rename_local", { oldPath: entry.path, newPath });
                    logMessage(`Renommé en local : ${entry.name} -> ${newName}`);
                    onNavigateLocal(currentPath);
                  } catch (err) {
                    logMessage(`Erreur renommage local : ${err}`);
                  }
                },
              });
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-sky-500/20 cursor-pointer"
          >
            <Edit2 className="h-3.5 w-3.5 text-sky-400" />
            <span>Renommer (F2)</span>
          </button>
        </>
      )}

      {contextMenu.entry !== null && (
        <>
          <div className="my-1 border-t border-neutral-500/20" />

          <button
            onClick={() => {
              const entry = contextMenu.entry!;
              const isRem = contextMenu.isRemote;
              const selectedPaths = isRem ? selectedRemotePaths : selectedLocalPaths;
              const currentList = isRem ? activeTab.remoteFiles : files;

              let itemsToDelete: FileEntry[] = [];
              if (selectedPaths.has(entry.path) && selectedPaths.size > 1) {
                itemsToDelete = currentList.filter((f) => selectedPaths.has(f.path));
              } else {
                itemsToDelete = [entry];
              }

              onClose();
              onPromptConfirmModal({
                title: "Suppression définitive",
                message:
                  itemsToDelete.length === 1
                    ? `Supprimer "${itemsToDelete[0].name}" ? Cette action est irréversible.`
                    : `Supprimer ces ${itemsToDelete.length} éléments définitivement ?`,
                onConfirm: async () => {
                  for (const it of itemsToDelete) {
                    try {
                      if (isRem) {
                        await invoke("delete_remote", {
                          sessionId: activeTab.id,
                          path: it.path,
                          isDir: it.is_dir,
                        });
                        logMessage(`DELE ${it.path}`);
                      } else {
                        await invoke("delete_local", { path: it.path, isDir: it.is_dir });
                        logMessage(`Suppression locale : ${it.path}`);
                      }
                    } catch (err) {
                      logMessage(`Erreur suppression ${it.name} : ${err}`);
                    }
                  }
                  if (isRem) {
                    setSelectedRemotePaths(new Set());
                    onNavigateRemote(activeTab.remotePath);
                  } else {
                    setSelectedLocalPaths(new Set());
                    onNavigateLocal(currentPath);
                  }
                },
              });
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-rose-500 hover:bg-rose-500/20 cursor-pointer font-medium"
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" />
            <span>
              {(contextMenu.isRemote ? selectedRemotePaths : selectedLocalPaths).size > 1 &&
              (contextMenu.isRemote ? selectedRemotePaths : selectedLocalPaths).has(contextMenu.entry.path)
                ? `Supprimer les ${(contextMenu.isRemote ? selectedRemotePaths : selectedLocalPaths).size} éléments (Suppr)`
                : "Supprimer (Suppr)"}
            </span>
          </button>
        </>
      )}
    </div>
  );
}


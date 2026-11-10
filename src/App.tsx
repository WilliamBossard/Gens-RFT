import { useEffect, useState, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

import SiteManagerModal, { SiteProfile } from "./components/modals/SiteManagerModal";
import ChmodModal, { ChmodModalState } from "./components/modals/ChmodModal";
import ConflictModal from "./components/modals/ConflictModal";
import FileEditorModal, { EditorModalState } from "./components/modals/FileEditorModal";
import SettingsModal from "./components/modals/SettingsModal";
import ConfirmModal from "./components/modals/ConfirmModal";
import InputModal from "./components/modals/InputModal";
import CrossTabModal from "./components/modals/CrossTabModal";
import TabPromptModal from "./components/modals/TabPromptModal";

import QuickConnectBar from "./components/panels/QuickConnectBar";
import SessionTabs from "./components/panels/SessionTabs";
import LocalPane from "./components/panels/LocalPane";
import RemotePane from "./components/panels/RemotePane";
import BottomPanel from "./components/panels/BottomPanel";
import FileContextMenu from "./components/panels/FileContextMenu";

import { encryptVaultData, decryptVaultData } from "./utils/cryptoVault";
import { useTransferStore } from "./store/useTransferStore";
import {
  FileEntry,
  TransferProgress,
  TabSession,
  QuickHistoryItem,
  SortField,
  SortOrder,
  PendingConflict,
  ConfirmModalState,
  InputModalState,
  CrossTabModalState,
  TabPromptModalState,
  ContextMenuState,
} from "./types";

export default function App() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    return (localStorage.getItem("gens_rft_theme") as "dark" | "light") || "dark";
  });

  const isDark = theme === "dark";

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
      root.style.colorScheme = "dark";
    } else {
      root.classList.remove("dark");
      root.style.colorScheme = "light";
    }
    localStorage.setItem("gens_rft_theme", theme);
  }, [theme]);

  const [showHidden, setShowHidden] = useState(false);
  const [showTreePanels, setShowTreePanels] = useState(true);
  const [enableSshTerminal, setEnableSshTerminal] = useState(true);
  const [maxConcurrent, setMaxConcurrent] = useState("2");

  const [rememberLocalPath, setRememberLocalPath] = useState<boolean>(() => {
    const v = localStorage.getItem("gens_rft_opt_remember_local");
    return v !== null ? JSON.parse(v) : true;
  });
  const [rememberRemotePath, setRememberRemotePath] = useState<boolean>(() => {
    const v = localStorage.getItem("gens_rft_opt_remember_remote");
    return v !== null ? JSON.parse(v) : true;
  });

  const [skipCrossTabConfirm, setSkipCrossTabConfirm] = useState<boolean>(() => {
    return localStorage.getItem("gens_rft_skip_cross_confirm") === "true";
  });

  // Store Zustand
  const {
    queue,
    addToQueue,
    updateProgress,
    markStatus,
  } = useTransferStore();

  // Sessions / Onglets
  const [tabs, setTabs] = useState<TabSession[]>([
    {
      id: "tab_1",
      title: "Session 1",
      isConnected: false,
      protocol: "SFTP",
      host: "",
      port: "22",
      username: "",
      remotePath: "/",
      remoteFiles: [],
      remoteHistory: ["/"],
      remoteHistoryIndex: 0,
    },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>("tab_1");
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabTitle, setEditingTabTitle] = useState("");

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) || tabs[0],
    [tabs, activeTabId]
  );

  const [localPaneWidth, setLocalPaneWidth] = useState(50);
  const [treeHeight, setTreeHeight] = useState(130);
  const [bottomHeight, setBottomHeight] = useState(180);

  // Connexion rapide
  const [quickHost, setQuickHost] = useState("");
  const [quickPort, setQuickPort] = useState("22");
  const [quickUser, setQuickUser] = useState("");
  const [quickPass, setQuickPass] = useState("");
  const [showQuickHistoryDropdown, setShowQuickHistoryDropdown] = useState(false);
  const [quickHistory, setQuickHistory] = useState<QuickHistoryItem[]>(() => {
    try {
      const saved = localStorage.getItem("gens_rft_quick_history");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // Explorateur local
  const [currentPath, setCurrentPath] = useState<string>("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [drives, setDrives] = useState<string[]>([]);
  const [sysFolders, setSysFolders] = useState<Record<string, string>>({});
  const [isEditingLocalPath, setIsEditingLocalPath] = useState(false);
  const [localPathInput, setLocalPathInput] = useState("");

  // Explorateur distant
  const [isEditingRemotePath, setIsEditingRemotePath] = useState(false);
  const [remotePathInput, setRemotePathInput] = useState(activeTab.remotePath);
  const [bookmarks, setBookmarks] = useState<string[]>(() => {
    const saved = localStorage.getItem("gens_rft_bookmarks");
    return saved ? JSON.parse(saved) : ["/var/log", "/home", "/etc"];
  });
  const [showBookmarksMenu, setShowBookmarksMenu] = useState(false);

  // Drag & drop
  const [draggedItem, setDraggedItem] = useState<{ entry: FileEntry; from: "local" | "remote"; fromSessionId?: string } | null>(null);
  const [isOverLocal, setIsOverLocal] = useState(false);
  const [isOverRemote, setIsOverRemote] = useState(false);

  // Filtres & tris
  const [localSearch, setLocalSearch] = useState("");
  const [remoteSearch, setRemoteSearch] = useState("");
  const [localSort, setLocalSort] = useState<{ field: SortField; order: SortOrder }>({ field: "name", order: "asc" });
  const [remoteSort, setRemoteSort] = useState<{ field: SortField; order: SortOrder }>({ field: "name", order: "asc" });

  // Sélections et panneau actif
  const [selectedLocalPaths, setSelectedLocalPaths] = useState<Set<string>>(new Set());
  const [selectedRemotePaths, setSelectedRemotePaths] = useState<Set<string>>(new Set());
  const [activePane, setActivePane] = useState<"local" | "remote">("local");

  const processedLocalFiles = useMemo(() => {
    return files
      .filter((f) => (showHidden ? true : !f.name.startsWith(".")))
      .filter((f) => f.name.toLowerCase().includes(localSearch.toLowerCase()))
      .sort((a, b) => {
        if (a.is_dir && !b.is_dir) return -1;
        if (!a.is_dir && b.is_dir) return 1;
        if (localSort.field === "size") {
          return localSort.order === "asc" ? a.size - b.size : b.size - a.size;
        }
        return localSort.order === "asc"
          ? a.name.localeCompare(b.name)
          : b.name.localeCompare(a.name);
      });
  }, [files, showHidden, localSearch, localSort]);

  const processedRemoteFiles = useMemo(() => {
    return activeTab.remoteFiles
      .filter((f) => (showHidden ? true : !f.name.startsWith(".")))
      .filter((f) => f.name.toLowerCase().includes(remoteSearch.toLowerCase()))
      .sort((a, b) => {
        if (a.is_dir && !b.is_dir) return -1;
        if (!a.is_dir && b.is_dir) return 1;
        if (remoteSort.field === "size") {
          return remoteSort.order === "asc" ? a.size - b.size : b.size - a.size;
        }
        return remoteSort.order === "asc"
          ? a.name.localeCompare(b.name)
          : b.name.localeCompare(a.name);
      });
  }, [activeTab.remoteFiles, showHidden, remoteSearch, remoteSort]);

  // Logs & console
  const [logs, setLogs] = useState<string[]>(["Gens-RFT initialisé."]);
  const [activeBottomTab, setActiveBottomTab] = useState<"logs" | "queue" | "terminal">("logs");
  const [bottomOpen, setBottomOpen] = useState(true);

  // Modales
  const [showSettings, setShowSettings] = useState(false);
  const [inputModal, setInputModal] = useState<InputModalState | null>(null);
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState | null>(null);
  const [conflictModal, setConflictModal] = useState<any>(null);
  const [conflictQueue, setConflictQueue] = useState<PendingConflict[]>([]);
  const [chmodModal, setChmodModal] = useState<ChmodModalState | null>(null);
  const [crossTabModal, setCrossTabModal] = useState<CrossTabModalState | null>(null);
  const [tabPromptModal, setTabPromptModal] = useState<TabPromptModalState | null>(null);
  const [editorModal, setEditorModal] = useState<EditorModalState | null>(null);
  const [showSiteManager, setShowSiteManager] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Historique local
  const [localHistory, setLocalHistory] = useState<string[]>([]);
  const [localHistoryIndex, setLocalHistoryIndex] = useState<number>(-1);

  // Sites
  const [sites, setSites] = useState<SiteProfile[]>([]);
  const [isSitesLoaded, setIsSitesLoaded] = useState(false);

  // Références toujours à jour
  const activeTabRef = useRef(activeTab);
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  const currentPathRef = useRef(currentPath);
  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);

  const localPaneWidthRef = useRef(localPaneWidth);
  useEffect(() => {
    localPaneWidthRef.current = localPaneWidth;
  }, [localPaneWidth]);

  const hasLoadedInitialDir = useRef(false);

  const logMessage = (msg: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev.slice(-999), `[${time}] ${msg}`]);
  };

  // Chargement initial des sites
  useEffect(() => {
    let isCancelled = false;
    const loadSecureSites = async () => {
      const saved = localStorage.getItem("gens_rft_sites");
      if (saved) {
        try {
          const decrypted = await decryptVaultData<SiteProfile[]>(saved, []);
          if (!isCancelled) setSites(decrypted);
        } catch {
          try {
            if (!isCancelled) setSites(JSON.parse(saved));
          } catch {}
        }
      }
      if (!isCancelled) setIsSitesLoaded(true);
    };
    loadSecureSites();
    return () => {
      isCancelled = true;
    };
  }, []);

  // Fermer les menus au clic extérieur
  useEffect(() => {
    const handleGlobalClick = () => {
      setContextMenu(null);
    };
    window.addEventListener("click", handleGlobalClick);
    return () => window.removeEventListener("click", handleGlobalClick);
  }, []);

  // Raccourcis claviers globaux
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const targetTag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (targetTag === "input" || targetTag === "textarea") return;

      if (
        showSettings ||
        showSiteManager ||
        conflictModal ||
        chmodModal ||
        editorModal ||
        confirmModal ||
        inputModal ||
        crossTabModal ||
        tabPromptModal
      ) {
        return;
      }

      if (e.key === "F5") {
        e.preventDefault();
        loadLocalDirectory(currentPath);
        if (activeTab.isConnected) {
          loadRemoteDirectory(activeTab.remotePath);
        }
        logMessage("Rafraîchissement des répertoires.");
      } else if (e.key === "Delete" || e.key === "Del") {
        if (activePane === "local" && selectedLocalPaths.size > 0) {
          e.preventDefault();
          const itemsToDelete = files.filter((f) => selectedLocalPaths.has(f.path));
          if (itemsToDelete.length === 0) return;
          setConfirmModal({
            title: "Suppression définitive",
            message:
              itemsToDelete.length === 1
                ? `Supprimer "${itemsToDelete[0].name}" ? Cette action est irréversible.`
                : `Supprimer ces ${itemsToDelete.length} éléments locaux définitivement ?`,
            onConfirm: async () => {
              for (const it of itemsToDelete) {
                try {
                  await invoke("delete_local", { path: it.path, isDir: it.is_dir });
                } catch (err) {
                  logMessage(`Erreur suppression ${it.name} : ${err}`);
                }
              }
              setSelectedLocalPaths(new Set());
              loadLocalDirectory(currentPath);
            },
          });
        } else if (activePane === "remote" && selectedRemotePaths.size > 0 && activeTab.isConnected) {
          e.preventDefault();
          const itemsToDelete = activeTab.remoteFiles.filter((f) => selectedRemotePaths.has(f.path));
          if (itemsToDelete.length === 0) return;
          setConfirmModal({
            title: "Suppression distante",
            message:
              itemsToDelete.length === 1
                ? `Supprimer "${itemsToDelete[0].name}" du serveur ?`
                : `Supprimer ces ${itemsToDelete.length} éléments distants ?`,
            onConfirm: async () => {
              for (const it of itemsToDelete) {
                try {
                  await invoke("delete_remote", {
                    sessionId: activeTab.id,
                    path: it.path,
                    isDir: it.is_dir,
                  });
                } catch (err) {
                  logMessage(`Erreur suppression ${it.name} : ${err}`);
                }
              }
              setSelectedRemotePaths(new Set());
              loadRemoteDirectory(activeTab.remotePath);
            },
          });
        }
      } else if (e.key === "F2") {
        if (activePane === "local" && selectedLocalPaths.size === 1) {
          e.preventDefault();
          const entry = files.find((f) => selectedLocalPaths.has(f.path));
          if (!entry) return;
          setInputModal({
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
                loadLocalDirectory(currentPath);
              } catch (err) {
                logMessage(`Erreur renommage : ${err}`);
              }
            },
          });
        } else if (activePane === "remote" && selectedRemotePaths.size === 1 && activeTab.isConnected) {
          e.preventDefault();
          const entry = activeTab.remoteFiles.find((f) => selectedRemotePaths.has(f.path));
          if (!entry) return;
          setInputModal({
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
                loadRemoteDirectory(activeTab.remotePath);
              } catch (err) {
                logMessage(`Erreur renommage distant : ${err}`);
              }
            },
          });
        }
      } else if (e.ctrlKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        if (activePane === "local") {
          setSelectedLocalPaths(new Set(processedLocalFiles.map((f) => f.path)));
        } else if (activePane === "remote" && activeTab.isConnected) {
          setSelectedRemotePaths(new Set(processedRemoteFiles.map((f) => f.path)));
        }
      } else if (e.key === "Escape") {
        setSelectedLocalPaths(new Set());
        setSelectedRemotePaths(new Set());
        setContextMenu(null);
      } else if (e.ctrlKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        createNewTab();
      } else if (e.ctrlKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (tabs.length > 1) {
          closeTab(activeTabId);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    tabs,
    activeTabId,
    currentPath,
    activeTab.isConnected,
    activeTab.remotePath,
    activePane,
    selectedLocalPaths,
    selectedRemotePaths,
    files,
    activeTab.remoteFiles,
    processedLocalFiles,
    processedRemoteFiles,
    showSettings,
    showSiteManager,
    conflictModal,
    chmodModal,
    editorModal,
    confirmModal,
    inputModal,
    crossTabModal,
    tabPromptModal,
  ]);

  useEffect(() => {
    setRemotePathInput(activeTab.remotePath);
  }, [activeTab.remotePath]);

  // Sauvegarde sécurisée des profils
  useEffect(() => {
    if (!isSitesLoaded) return;
    const saveSecureSites = async () => {
      try {
        const encrypted = await encryptVaultData(sites);
        localStorage.setItem("gens_rft_sites", encrypted);
      } catch {
        localStorage.setItem("gens_rft_sites", JSON.stringify(sites));
      }
    };
    saveSecureSites();
  }, [sites, isSitesLoaded]);

  useEffect(() => {
    localStorage.setItem("gens_rft_opt_remember_local", JSON.stringify(rememberLocalPath));
  }, [rememberLocalPath]);

  useEffect(() => {
    localStorage.setItem("gens_rft_opt_remember_remote", JSON.stringify(rememberRemotePath));
  }, [rememberRemotePath]);

  // Mémorisation du chemin local
  useEffect(() => {
    if (rememberLocalPath && currentPath) {
      localStorage.setItem("gens_rft_last_local_path", currentPath);
      if (activeTab?.siteId) {
        setSites((prev) =>
          prev.map((s) =>
            s.id === activeTab.siteId ? { ...s, lastLocalPath: currentPath } : s
          )
        );
      }
    }
  }, [currentPath, rememberLocalPath, activeTab?.siteId]);

  useEffect(() => {
    const preventDrag = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = "copy";
      }
    };
    window.addEventListener("dragover", preventDrag);
    window.addEventListener("drop", preventDrag);
    return () => {
      window.removeEventListener("dragover", preventDrag);
      window.removeEventListener("drop", preventDrag);
    };
  }, []);

  // Écoute de la progression de transfert
  useEffect(() => {
    const unlisten = listen<TransferProgress>("transfer_progress", (event) => {
      const p = event.payload;
      updateProgress(p.transfer_id, p.transferred, p.total, p.percent);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [updateProgress]);

  // Glisser-déposer externe natif Tauri v2
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (event.payload.type === "drop") {
          const paths = event.payload.paths;
          if (!paths || paths.length === 0) return;
          const rawX = event.payload.position.x;
          const scale = window.devicePixelRatio || 1;
          const x = rawX / scale;
          const splitX = (window.innerWidth * localPaneWidthRef.current) / 100;
          const isRemotePane = x > splitX;

          if (isRemotePane) {
            const currentTab = activeTabRef.current;
            if (!currentTab.isConnected) {
              logMessage("Erreur : Impossible d'envoyer des fichiers, serveur déconnecté.");
              return;
            }
            for (const p of paths) {
              const name = p.split(/[\\/]/).pop() || "fichier";
              const isDir = await invoke<boolean>("is_local_dir", { path: p }).catch(() => false);
              checkAndEnqueueTransfer(name, p, currentTab.remotePath, "upload", isDir, currentTab.id);
            }
            logMessage(`Glisser-déposer externe : ${paths.length} élément(s) ajouté(s) à la file.`);
          } else {
            loadLocalDirectory(currentPathRef.current, false);
          }
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Boucle des transferts concurrents
  const inFlightIdsRef = useRef<Set<string>>(new Set());
  const concurrentLimit = parseInt(maxConcurrent) || 2;
  const runningCount = queue.filter((item) => item.status === "running").length;
  const runningCountRef = useRef(runningCount);
  useEffect(() => {
    runningCountRef.current = runningCount;
  }, [runningCount]);

  // Confirmation avant fermeture si transfert en cours
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (runningCountRef.current > 0) {
          event.preventDefault();
          setConfirmModal({
            title: "Transferts en cours",
            message: `Il y a actuellement ${runningCountRef.current} transfert(s) en cours d'exécution. Voulez-vous vraiment interrompre les transferts et quitter Gens-RFT ?`,
            onConfirm: async () => {
              await invoke("cancel_current_transfer", { transferId: null }).catch(() => {});
              await getCurrentWindow().destroy();
            },
          });
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    if (runningCount >= concurrentLimit) return;

    const nextItem = queue.find((item) => item.status === "queued" && !inFlightIdsRef.current.has(item.id));
    if (!nextItem) return;

    inFlightIdsRef.current.add(nextItem.id);
    markStatus(nextItem.id, "running");

    const executeTransfer = async () => {
      try {
        if (nextItem.direction === "upload") {
          const finalUploadName = nextItem.destFileName || nextItem.filename;
          logMessage(`STOR [${finalUploadName}] -> ${nextItem.destDir}`);
          await invoke("upload_item", {
            sessionId: nextItem.sessionId,
            transferId: nextItem.id,
            localPath: nextItem.sourcePath,
            remoteDestDir: nextItem.destDir,
            destFilename: finalUploadName,
          });
          if (
            activeTabRef.current.id === nextItem.sessionId &&
            activeTabRef.current.remotePath.replace(/\/+$/, "") === nextItem.destDir.replace(/\/+$/, "")
          ) {
            loadRemoteDirectory(activeTabRef.current.remotePath, nextItem.sessionId, false);
          }
        } else {
          const finalDownloadName = nextItem.destFileName || nextItem.filename;
          logMessage(`RETR [${finalDownloadName}] -> ${nextItem.destDir}`);
          await invoke("download_item", {
            sessionId: nextItem.sessionId,
            transferId: nextItem.id,
            remotePath: nextItem.sourcePath,
            localDestDir: nextItem.destDir,
            destFilename: finalDownloadName,
            isDir: nextItem.isDir,
          });

          if (nextItem.relayToSessionId && nextItem.relayDestDir) {
            const finalRelayName = nextItem.destFileName || nextItem.filename;
            const localRelayFile = `${nextItem.destDir.replace(/[\\/]+$/, "")}\\${finalRelayName}`;
            logMessage(`Relais inter-serveurs : Envoi vers le serveur cible (${finalRelayName})...`);
            updateProgress(nextItem.id, 0, 100, 0);
            await invoke("upload_item", {
              sessionId: nextItem.relayToSessionId,
              transferId: nextItem.id,
              localPath: localRelayFile,
              remoteDestDir: nextItem.relayDestDir,
              destFilename: finalRelayName,
            });
            try {
              await invoke("delete_local", { path: localRelayFile, isDir: nextItem.isDir });
              await invoke("delete_local", { path: nextItem.destDir, isDir: true });
            } catch {}
            if (
              activeTabRef.current.id === nextItem.relayToSessionId &&
              activeTabRef.current.remotePath.replace(/\/+$/, "") === nextItem.relayDestDir.replace(/\/+$/, "")
            ) {
              loadRemoteDirectory(activeTabRef.current.remotePath, nextItem.relayToSessionId, false);
            }
          } else {
            const normCurrent = currentPathRef.current.replace(/[\\/]+$/, "").toLowerCase();
            const normDest = nextItem.destDir.replace(/[\\/]+$/, "").toLowerCase();
            if (normCurrent === normDest) {
              loadLocalDirectory(currentPathRef.current, false);
            }
          }
        }

        inFlightIdsRef.current.delete(nextItem.id);
        markStatus(nextItem.id, "done");
        logMessage(`226 Transfert terminé : ${nextItem.filename}`);
      } catch (err) {
        inFlightIdsRef.current.delete(nextItem.id);
        const errorMsg = err instanceof Error ? err.message : String(err);
        markStatus(nextItem.id, "error", errorMsg);
        logMessage(`550 Échec de transfert (${nextItem.filename}) : ${errorMsg}`);
        if (nextItem.relayToSessionId && nextItem.destDir) {
          try {
            await invoke("delete_local", { path: nextItem.destDir, isDir: true });
          } catch {}
        }
      }
    };

    executeTransfer();
  }, [queue, runningCount, concurrentLimit, markStatus, updateProgress]);

  // Chargement dossier local
  const loadLocalDirectory = async (targetPath?: string, recordHistory = true) => {
    try {
      logMessage(`CWD Local: ${targetPath || "dossier utilisateur"}`);
      const result = await invoke<FileEntry[]>("read_local_dir", { path: targetPath || null });
      setFiles(result);
      let effectivePath = targetPath;
      if (targetPath) {
        setCurrentPath(targetPath);
      } else if (result.length > 0 && !currentPath) {
        const parent = result[0].path.split(/[\\/]/).slice(0, -1).join("\\");
        effectivePath = parent || "C:\\";
        setCurrentPath(effectivePath);
      }
      if (effectivePath && recordHistory) {
        setLocalHistory((prev) => {
          if (localHistoryIndex >= 0 && prev[localHistoryIndex] === effectivePath) {
            return prev;
          }
          const next = prev.slice(0, localHistoryIndex + 1);
          next.push(effectivePath!);
          return next;
        });
        setLocalHistoryIndex((prev) => prev + 1);
      }
    } catch (err) {
      logMessage(`Erreur lecture locale (${targetPath}) : ${err}`);
      if (drives.length > 0 && targetPath !== drives[0]) {
        loadLocalDirectory(drives[0], false);
      }
    }
  };

  const handleLocalHistoryBack = () => {
    if (localHistoryIndex > 0) {
      const target = localHistory[localHistoryIndex - 1];
      setLocalHistoryIndex(localHistoryIndex - 1);
      loadLocalDirectory(target, false);
    }
  };

  const handleLocalHistoryForward = () => {
    if (localHistoryIndex < localHistory.length - 1) {
      const target = localHistory[localHistoryIndex + 1];
      setLocalHistoryIndex(localHistoryIndex + 1);
      loadLocalDirectory(target, false);
    }
  };

  // Chargement dossier distant
  const loadRemoteDirectory = async (targetPath?: string, targetSessionId?: string, recordHistory = true) => {
    const sId = targetSessionId || activeTab.id;
    const fallbackPath = "/";
    try {
      logMessage(`[${sId}] CWD Distant: ${targetPath || "/"}`);
      const result = await invoke<FileEntry[]>("list_remote_dir", {
        sessionId: sId,
        path: targetPath || null,
      });

      const effectivePath = targetPath || "/";
      setTabs((prev) =>
        prev.map((t) => {
          if (t.id !== sId) return t;
          let newHistory = t.remoteHistory || ["/"];
          let newIndex = t.remoteHistoryIndex ?? (newHistory.length - 1);
          if (recordHistory) {
            const currentRecorded = newHistory[newIndex];
            if (currentRecorded !== effectivePath) {
              const next = newHistory.slice(0, newIndex + 1);
              next.push(effectivePath);
              newHistory = next;
              newIndex = next.length - 1;
            }
          }
          return {
            ...t,
            remoteFiles: result,
            remotePath: effectivePath,
            remoteHistory: newHistory,
            remoteHistoryIndex: newIndex,
          };
        })
      );

      if (rememberRemotePath) {
        setTabs((currentTabs) => {
          const tab = currentTabs.find((t) => t.id === sId);
          if (tab?.siteId) {
            setSites((sitesPrev) =>
              sitesPrev.map((s) =>
                s.id === tab.siteId ? { ...s, lastRemotePath: effectivePath } : s
              )
            );
          }
          return currentTabs;
        });
      }

      logMessage(`250 ${result.length} élément(s) listé(s) sur le serveur distant.`);
    } catch (err) {
      logMessage(`550 Erreur dossier distant (${targetPath}) : ${err}`);
      if (targetPath && targetPath !== fallbackPath) {
        logMessage(`Repli automatique sur la racine ${fallbackPath}`);
        try {
          const rootResult = await invoke<FileEntry[]>("list_remote_dir", {
            sessionId: sId,
            path: fallbackPath,
          });
          setTabs((prev) =>
            prev.map((t) =>
              t.id === sId
                ? { ...t, remoteFiles: rootResult, remotePath: fallbackPath }
                : t
            )
          );
        } catch {}
      }
    }
  };

  const currentRemoteIndex = activeTab.remoteHistoryIndex ?? 0;
  const currentRemoteHistory = activeTab.remoteHistory || ["/"];

  const handleRemoteHistoryBack = () => {
    if (currentRemoteIndex > 0) {
      const target = currentRemoteHistory[currentRemoteIndex - 1];
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTab.id ? { ...t, remoteHistoryIndex: currentRemoteIndex - 1 } : t
        )
      );
      loadRemoteDirectory(target, activeTab.id, false);
    }
  };

  const handleRemoteHistoryForward = () => {
    if (currentRemoteIndex < currentRemoteHistory.length - 1) {
      const target = currentRemoteHistory[currentRemoteIndex + 1];
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTab.id ? { ...t, remoteHistoryIndex: currentRemoteIndex + 1 } : t
        )
      );
      loadRemoteDirectory(target, activeTab.id, false);
    }
  };

  // Connexion
  const executeConnect = async (
    targetSessionId: string,
    protocol: "SFTP" | "FTP" | "FTPS",
    targetHost: string,
    targetPort: string,
    targetUser: string,
    authType: "password" | "key",
    targetPass?: string,
    targetKeyPath?: string,
    targetPassphrase?: string,
    siteId?: string,
    initialRemotePath?: string,
    initialLocalPath?: string
  ) => {
    logMessage(`[${targetSessionId}] Connexion ${protocol} à ${targetUser}@${targetHost}:${targetPort}...`);
    try {
      const msg = await invoke<string>("connect_server", {
        sessionId: targetSessionId,
        protocol,
        host: targetHost,
        port: parseInt(targetPort, 10) || (protocol === "FTP" || protocol === "FTPS" ? 21 : 22),
        username: targetUser,
        authType,
        password: targetPass || null,
        keyPath: targetKeyPath || null,
        passphrase: targetPassphrase || null,
      });

      logMessage(`230 ${msg}`);
      const tabTitle = targetHost ? `${targetUser}@${targetHost}` : "Serveur";

      setTabs((prev) =>
        prev.map((t) =>
          t.id === targetSessionId
            ? {
                ...t,
                title: tabTitle,
                isConnected: true,
                protocol,
                host: targetHost,
                port: targetPort,
                username: targetUser,
                siteId,
              }
            : t
        )
      );

      if (targetHost && targetUser) {
        setQuickHistory((prev) => {
          const entry: QuickHistoryItem = {
            host: targetHost,
            port: targetPort,
            username: targetUser,
            protocol,
          };
          const filtered = prev.filter(
            (it) => !(it.host === entry.host && it.port === entry.port && it.username === entry.username && it.protocol === entry.protocol)
          );
          const updated = [entry, ...filtered].slice(0, 10);
          localStorage.setItem("gens_rft_quick_history", JSON.stringify(updated));
          return updated;
        });
      }

      if (rememberLocalPath && initialLocalPath) {
        loadLocalDirectory(initialLocalPath);
      }

      const targetDir = rememberRemotePath && initialRemotePath ? initialRemotePath : "/";
      await loadRemoteDirectory(targetDir, targetSessionId);
    } catch (err) {
      logMessage(`530 Échec d'authentification : ${err}`);
    }
  };

  const handleConnectRequest = (
    protocol: "SFTP" | "FTP" | "FTPS",
    targetHost: string,
    targetPort: string,
    targetUser: string,
    authType: "password" | "key",
    targetPass?: string,
    targetKeyPath?: string,
    targetPassphrase?: string,
    siteId?: string,
    initialRemotePath?: string,
    initialLocalPath?: string
  ) => {
    setShowBookmarksMenu(false);
    setShowSettings(false);
    setShowSiteManager(false);

    if (activeTab.isConnected) {
      setTabPromptModal({
        pendingParams: {
          protocol,
          host: targetHost,
          port: targetPort,
          username: targetUser,
          authType,
          password: targetPass,
          keyPath: targetKeyPath,
          passphrase: targetPassphrase,
          siteId,
          initialRemotePath,
          initialLocalPath,
        },
      });
      return;
    }

    executeConnect(
      activeTab.id,
      protocol,
      targetHost,
      targetPort,
      targetUser,
      authType,
      targetPass,
      targetKeyPath,
      targetPassphrase,
      siteId,
      initialRemotePath,
      initialLocalPath
    );
  };

  const handleDisconnect = async (sessionId: string) => {
    await invoke("disconnect_server", { sessionId });
    setTabs((prev) =>
      prev.map((t) =>
        t.id === sessionId
          ? {
              ...t,
              isConnected: false,
              title: "Déconnecté",
              remoteFiles: [],
              remotePath: "/",
            }
          : t
      )
    );
    logMessage(`Session [${sessionId}] fermée.`);
  };

  const createNewTab = () => {
    const newId = `tab_${Date.now()}`;
    const newTab: TabSession = {
      id: newId,
      title: `Session ${tabs.length + 1}`,
      isConnected: false,
      protocol: "SFTP",
      host: "",
      port: "22",
      username: "",
      remotePath: "/",
      remoteFiles: [],
      remoteHistory: ["/"],
      remoteHistoryIndex: 0,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newId);
    return newId;
  };

  const closeTab = (tabId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (tabs.length === 1) return;
    handleDisconnect(tabId);
    const newTabs = tabs.filter((t) => t.id !== tabId);
    setTabs(newTabs);
    if (activeTabId === tabId) {
      setActiveTabId(newTabs[0].id);
    }
  };

  const handleStartRenameTab = (tab: TabSession, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingTabId(tab.id);
    setEditingTabTitle(tab.title);
  };

  const handleFinishRenameTab = () => {
    if (editingTabId) {
      const trimmed = editingTabTitle.trim();
      if (trimmed) {
        setTabs((prev) =>
          prev.map((t) => (t.id === editingTabId ? { ...t, title: trimmed } : t))
        );
      }
      setEditingTabId(null);
    }
  };

  // Chargement initial des volumes et dossiers locaux
  useEffect(() => {
    if (!hasLoadedInitialDir.current) {
      hasLoadedInitialDir.current = true;
      const savedLocal = rememberLocalPath ? localStorage.getItem("gens_rft_last_local_path") : null;
      loadLocalDirectory(savedLocal || undefined);

      invoke<string[]>("get_windows_drives")
        .then((d) => setDrives(d))
        .catch(() => setDrives(["C:\\"]));

      invoke<Record<string, string>>("get_system_folders")
        .then((f) => setSysFolders(f))
        .catch(() => {});
    }
  }, [rememberLocalPath]);

  // Enfilement avec détection de conflit
  const checkAndEnqueueTransfer = (
    filename: string,
    sourcePath: string,
    destDir: string,
    direction: "upload" | "download",
    isDir: boolean,
    destSessionId?: string
  ) => {
    const targetFileList = direction === "upload" ? activeTab.remoteFiles : files;
    const exists = direction === "download"
      ? targetFileList.some((f) => f.name.toLowerCase() === filename.toLowerCase())
      : targetFileList.some((f) => f.name.toLowerCase() === filename.toLowerCase());

    if (exists) {
      setConflictQueue((prev) => [
        ...prev,
        {
          filename,
          sourcePath,
          destDir,
          direction,
          isDir,
          destSessionId: destSessionId || activeTab.id,
        },
      ]);
    } else {
      addToQueue({
        sessionId: destSessionId || activeTab.id,
        filename,
        sourcePath,
        destDir,
        destFileName: filename,
        direction,
        isDir,
      });
      setActiveBottomTab("queue");
      setBottomOpen(true);
    }
  };

  // Traitement file de conflits
  useEffect(() => {
    if (conflictQueue.length > 0 && !conflictModal) {
      const current = conflictQueue[0];
      setConflictModal({
        filename: current.filename,
        remainingCount: conflictQueue.length,
        onResolve: (action: "overwrite" | "rename" | "skip", applyToAll: boolean) => {
          if (applyToAll) {
            for (const item of conflictQueue) {
              if (action === "skip") {
                logMessage(`Transfert de "${item.filename}" ignoré.`);
              } else {
                let finalName = item.filename;
                if (action === "rename") {
                  const extIdx = item.filename.lastIndexOf(".");
                  finalName =
                    extIdx > 0
                      ? `${item.filename.substring(0, extIdx)} (copie)${item.filename.substring(extIdx)}`
                      : `${item.filename} (copie)`;
                }
                addToQueue({
                  sessionId: item.destSessionId,
                  filename: item.filename,
                  destFileName: finalName,
                  sourcePath: item.sourcePath,
                  destDir: item.destDir,
                  direction: item.direction,
                  isDir: item.isDir,
                });
              }
            }
            setConflictQueue([]);
            setActiveBottomTab("queue");
            setBottomOpen(true);
            setConflictModal(null);
          } else {
            if (action === "skip") {
              logMessage(`Transfert de "${current.filename}" ignoré.`);
            } else {
              let finalName = current.filename;
              if (action === "rename") {
                const extIdx = current.filename.lastIndexOf(".");
                finalName =
                  extIdx > 0
                    ? `${current.filename.substring(0, extIdx)} (copie)${current.filename.substring(extIdx)}`
                    : `${current.filename} (copie)`;
              }
              addToQueue({
                sessionId: current.destSessionId,
                filename: current.filename,
                destFileName: finalName,
                sourcePath: current.sourcePath,
                destDir: current.destDir,
                direction: current.direction,
                isDir: current.isDir,
              });
              setActiveBottomTab("queue");
              setBottomOpen(true);
            }
            setConflictQueue((prev: PendingConflict[]) => prev.slice(1));
            setConflictModal(null);
          }
        },
      });
    }
  }, [conflictQueue, conflictModal, addToQueue]);

  // Relais inter-onglets
  const enqueueCrossTabTransfer = async (
    item: { entry: FileEntry; from: "local" | "remote"; fromSessionId?: string },
    targetTab: TabSession
  ) => {
    if (item.from === "remote" && item.fromSessionId && item.fromSessionId !== targetTab.id) {
      try {
        const tempBase = await invoke<string>("get_temp_dir");
        const transferSubdir = `${tempBase}\\relay_${Date.now()}`;
        await invoke("create_local_dir", { path: transferSubdir });

        addToQueue({
          sessionId: item.fromSessionId,
          filename: item.entry.name,
          destFileName: item.entry.name,
          sourcePath: item.entry.path,
          destDir: transferSubdir,
          direction: "download",
          isDir: item.entry.is_dir,
          relayToSessionId: targetTab.id,
          relayDestDir: targetTab.remotePath,
        });

        setActiveBottomTab("queue");
        setBottomOpen(true);
        logMessage(`Relais inter-serveurs programmé : ${item.entry.name} -> ${targetTab.title}`);
      } catch (err) {
        logMessage(`Erreur initialisation relais : ${err}`);
      }
    } else {
      checkAndEnqueueTransfer(
        item.entry.name,
        item.entry.path,
        targetTab.remotePath,
        "upload",
        item.entry.is_dir,
        targetTab.id
      );
    }
  };

  return (
    <div
      className={`flex h-screen w-screen flex-col overflow-hidden font-sans select-none ${
        isDark ? "bg-neutral-950 text-neutral-200" : "bg-neutral-50 text-neutral-800"
      }`}
    >
      {/* Barre de connexion rapide supérieure */}
      <QuickConnectBar
        isDark={isDark}
        activeTab={activeTab}
        quickHost={quickHost}
        setQuickHost={setQuickHost}
        quickPort={quickPort}
        setQuickPort={setQuickPort}
        quickUser={quickUser}
        setQuickUser={setQuickUser}
        quickPass={quickPass}
        setQuickPass={setQuickPass}
        quickHistory={quickHistory}
        setQuickHistory={setQuickHistory}
        showQuickHistoryDropdown={showQuickHistoryDropdown}
        setShowQuickHistoryDropdown={setShowQuickHistoryDropdown}
        showSiteManager={showSiteManager}
        setShowSiteManager={setShowSiteManager}
        showSettings={showSettings}
        setShowSettings={setShowSettings}
        onConnectRequest={handleConnectRequest}
        onDisconnect={handleDisconnect}
      />

      {/* Barre d'onglets multi-sessions */}
      <SessionTabs
        isDark={isDark}
        tabs={tabs}
        activeTabId={activeTabId}
        setActiveTabId={setActiveTabId}
        dragOverTabId={dragOverTabId}
        setDragOverTabId={setDragOverTabId}
        editingTabId={editingTabId}
        setEditingTabId={setEditingTabId}
        editingTabTitle={editingTabTitle}
        setEditingTabTitle={setEditingTabTitle}
        draggedItem={draggedItem}
        skipCrossTabConfirm={skipCrossTabConfirm}
        onStartRenameTab={handleStartRenameTab}
        onFinishRenameTab={handleFinishRenameTab}
        onCloseTab={closeTab}
        onCreateNewTab={createNewTab}
        onEnqueueCrossTabTransfer={enqueueCrossTabTransfer}
        onPromptCrossTabModal={setCrossTabModal}
      />

      {/* Main Split-Pane */}
      <div className="flex flex-1 overflow-hidden relative select-none">
        {/* Panneau Local */}
        <LocalPane
          isDark={isDark}
          localPaneWidth={localPaneWidth}
          currentPath={currentPath}
          files={files}
          processedLocalFiles={processedLocalFiles}
          drives={drives}
          sysFolders={sysFolders}
          isEditingLocalPath={isEditingLocalPath}
          setIsEditingLocalPath={setIsEditingLocalPath}
          localPathInput={localPathInput}
          setLocalPathInput={setLocalPathInput}
          localSearch={localSearch}
          setLocalSearch={setLocalSearch}
          localHistoryIndex={localHistoryIndex}
          localSort={localSort}
          setLocalSort={setLocalSort}
          showTreePanels={showTreePanels}
          treeHeight={treeHeight}
          setTreeHeight={setTreeHeight}
          showHidden={showHidden}
          selectedLocalPaths={selectedLocalPaths}
          setSelectedLocalPaths={setSelectedLocalPaths}
          selectedRemotePaths={selectedRemotePaths}
          activeTab={activeTab}
          draggedItem={draggedItem}
          setDraggedItem={setDraggedItem}
          isOverLocal={isOverLocal}
          setIsOverLocal={setIsOverLocal}
          setIsOverRemote={setIsOverRemote}
          setDragOverTabId={setDragOverTabId}
          setActivePane={setActivePane}
          onNavigateLocal={loadLocalDirectory}
          onLocalHistoryBack={handleLocalHistoryBack}
          onLocalHistoryForward={handleLocalHistoryForward}
          onCheckAndEnqueueTransfer={checkAndEnqueueTransfer}
          onOpenContextMenu={(e, entry, isRemote) => {
            setContextMenu({ x: e.clientX, y: e.clientY, entry, isRemote });
          }}
          onPromptInputModal={setInputModal}
          logMessage={logMessage}
        />

        {/* Panneau Distant */}
        <RemotePane
          isDark={isDark}
          localPaneWidth={localPaneWidth}
          setLocalPaneWidth={setLocalPaneWidth}
          activeTab={activeTab}
          processedRemoteFiles={processedRemoteFiles}
          bookmarks={bookmarks}
          setBookmarks={setBookmarks}
          showBookmarksMenu={showBookmarksMenu}
          setShowBookmarksMenu={setShowBookmarksMenu}
          isEditingRemotePath={isEditingRemotePath}
          setIsEditingRemotePath={setIsEditingRemotePath}
          remotePathInput={remotePathInput}
          setRemotePathInput={setRemotePathInput}
          remoteSearch={remoteSearch}
          setRemoteSearch={setRemoteSearch}
          remoteSort={remoteSort}
          setRemoteSort={setRemoteSort}
          showTreePanels={showTreePanels}
          treeHeight={treeHeight}
          setTreeHeight={setTreeHeight}
          showHidden={showHidden}
          selectedRemotePaths={selectedRemotePaths}
          setSelectedRemotePaths={setSelectedRemotePaths}
          selectedLocalPaths={selectedLocalPaths}
          files={files}
          currentPath={currentPath}
          draggedItem={draggedItem}
          setDraggedItem={setDraggedItem}
          isOverRemote={isOverRemote}
          setIsOverRemote={setIsOverRemote}
          setIsOverLocal={setIsOverLocal}
          setDragOverTabId={setDragOverTabId}
          setActivePane={setActivePane}
          onNavigateRemote={loadRemoteDirectory}
          onRemoteHistoryBack={handleRemoteHistoryBack}
          onRemoteHistoryForward={handleRemoteHistoryForward}
          onCheckAndEnqueueTransfer={checkAndEnqueueTransfer}
          onOpenContextMenu={(e, entry, isRemote) => {
            setContextMenu({ x: e.clientX, y: e.clientY, entry, isRemote });
          }}
          onPromptInputModal={setInputModal}
          logMessage={logMessage}
        />
      </div>

      {/* Panneau Inférieur (Console / File d'attente / Terminal SSH) */}
      <BottomPanel
        isDark={isDark}
        bottomHeight={bottomHeight}
        setBottomHeight={setBottomHeight}
        bottomOpen={bottomOpen}
        setBottomOpen={setBottomOpen}
        activeBottomTab={activeBottomTab}
        setActiveBottomTab={setActiveBottomTab}
        enableSshTerminal={enableSshTerminal}
        activeTab={activeTab}
        logs={logs}
      />

      {/* Menu contextuel Clic Droit */}
      <FileContextMenu
        isDark={isDark}
        contextMenu={contextMenu}
        onClose={() => setContextMenu(null)}
        activeTab={activeTab}
        currentPath={currentPath}
        files={files}
        selectedLocalPaths={selectedLocalPaths}
        setSelectedLocalPaths={setSelectedLocalPaths}
        selectedRemotePaths={selectedRemotePaths}
        setSelectedRemotePaths={setSelectedRemotePaths}
        onNavigateLocal={loadLocalDirectory}
        onNavigateRemote={loadRemoteDirectory}
        onCheckAndEnqueueTransfer={checkAndEnqueueTransfer}
        onPromptInputModal={setInputModal}
        onPromptConfirmModal={setConfirmModal}
        setEditorModal={setEditorModal}
        setChmodModal={setChmodModal}
        logMessage={logMessage}
      />

      {/* Modale transfert inter-onglets */}
      <CrossTabModal
        crossTabModal={crossTabModal}
        onClose={() => setCrossTabModal(null)}
        onConfirm={(item, targetTab, neverAskAgain) => {
          if (neverAskAgain) {
            setSkipCrossTabConfirm(true);
            localStorage.setItem("gens_rft_skip_cross_confirm", "true");
          }
          enqueueCrossTabTransfer(item, targetTab);
        }}
        isDark={isDark}
      />

      {/* Éditeur de texte distant */}
      <FileEditorModal
        editorModal={editorModal}
        onClose={() => setEditorModal(null)}
        activeTabId={activeTab.id}
        onSuccess={() => loadRemoteDirectory(activeTab.remotePath)}
        logMessage={logMessage}
        isDark={isDark}
      />

      {/* Modale Gestionnaire de sites */}
      <SiteManagerModal
        isOpen={showSiteManager}
        onClose={() => setShowSiteManager(false)}
        sites={sites}
        setSites={setSites}
        onConnect={(site: SiteProfile) => {
          handleConnectRequest(
            site.protocol,
            site.host,
            site.port,
            site.username,
            site.authType,
            site.password,
            site.keyPath,
            site.passphrase,
            site.id,
            site.lastRemotePath,
            site.lastLocalPath
          );
        }}
        isDark={isDark}
        logMessage={logMessage}
      />

      {/* Modale bifurcation de connexion */}
      <TabPromptModal
        tabPromptModal={tabPromptModal}
        activeTab={activeTab}
        onClose={() => setTabPromptModal(null)}
        onReplaceConnection={() => {
          if (!tabPromptModal) return;
          const p = tabPromptModal.pendingParams;
          handleDisconnect(activeTab.id);
          executeConnect(
            activeTab.id,
            p.protocol,
            p.host,
            p.port,
            p.username,
            p.authType,
            p.password,
            p.keyPath,
            p.passphrase,
            p.siteId,
            p.initialRemotePath,
            p.initialLocalPath
          );
        }}
        onOpenInNewTab={() => {
          if (!tabPromptModal) return;
          const p = tabPromptModal.pendingParams;
          const newId = createNewTab();
          executeConnect(
            newId,
            p.protocol,
            p.host,
            p.port,
            p.username,
            p.authType,
            p.password,
            p.keyPath,
            p.passphrase,
            p.siteId,
            p.initialRemotePath,
            p.initialLocalPath
          );
        }}
        isDark={isDark}
      />

      {/* Modale Paramètres */}
      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        theme={theme}
        setTheme={setTheme}
        showHidden={showHidden}
        setShowHidden={setShowHidden}
        rememberLocalPath={rememberLocalPath}
        setRememberLocalPath={setRememberLocalPath}
        rememberRemotePath={rememberRemotePath}
        setRememberRemotePath={setRememberRemotePath}
        showTreePanels={showTreePanels}
        setShowTreePanels={setShowTreePanels}
        enableSshTerminal={enableSshTerminal}
        setEnableSshTerminal={setEnableSshTerminal}
        maxConcurrent={maxConcurrent}
        setMaxConcurrent={setMaxConcurrent}
        isDark={isDark}
      />

      {/* Modale Conflit */}
      <ConflictModal
        conflictModal={conflictModal}
        onClose={() => {
          setConflictQueue([]);
          setConflictModal(null);
          logMessage("Conflits ignorés / opération annulée.");
        }}
        isDark={isDark}
      />

      {/* Modale Saisie */}
      <InputModal
        inputModal={inputModal}
        onClose={() => setInputModal(null)}
        isDark={isDark}
      />

      {/* Modale Confirmation */}
      <ConfirmModal
        confirmModal={confirmModal}
        onClose={() => setConfirmModal(null)}
        isDark={isDark}
      />

      {/* Modale CHMOD */}
      <ChmodModal
        chmodModal={chmodModal}
        onClose={() => setChmodModal(null)}
        activeTabId={activeTab.id}
        onSuccess={() => loadRemoteDirectory(activeTab.remotePath)}
        logMessage={logMessage}
        isDark={isDark}
      />
    </div>
  );
}

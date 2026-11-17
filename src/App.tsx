import { useEffect, useState, useMemo, useRef, useCallback, useDeferredValue } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

import SiteManagerModal, { SiteProfile } from "./components/modals/SiteManagerModal";
import ChmodModal, { ChmodModalState } from "./components/modals/ChmodModal";
import ConflictModal, { ConflictModalState } from "./components/modals/ConflictModal";
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
import BottomPanel, { TerminalTabInfo } from "./components/panels/BottomPanel";
import FileContextMenu from "./components/panels/FileContextMenu";

import { loadSitesFromBackendVault, saveSitesToBackendVault } from "./utils/cryptoVault";
import {
  buildCopyFilename,
  isValidFilenameInput,
  joinLocalPath,
  joinRemotePath,
} from "./utils/fileHelpers";
import { useTransferStore } from "./store/useTransferStore";
import { useLogStore } from "./store/useLogStore";
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

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const SITE_PATHS_KEY = "gens_rft_site_paths";

interface SitePathMemory {
  lastLocalPath?: string;
  lastRemotePath?: string;
}

function readSitePaths(): Record<string, SitePathMemory> {
  try {
    const raw = localStorage.getItem(SITE_PATHS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeSitePath(siteId: string, patch: Partial<SitePathMemory>) {
  try {
    const all = readSitePaths();
    all[siteId] = { ...all[siteId], ...patch };
    localStorage.setItem(SITE_PATHS_KEY, JSON.stringify(all));
  } catch {}
}

function readBoolPref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v !== null ? Boolean(JSON.parse(v)) : fallback;
  } catch {
    return fallback;
  }
}

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

  const [showHidden, setShowHidden] = useState<boolean>(() => {
    return localStorage.getItem("gens_rft_show_hidden") === "true";
  });
  const [showTreePanels, setShowTreePanels] = useState<boolean>(() =>
    readBoolPref("gens_rft_show_tree_panels", true)
  );
  const [enableSshTerminal, setEnableSshTerminal] = useState<boolean>(() =>
    readBoolPref("gens_rft_enable_ssh_terminal", true)
  );
  const [maxConcurrent, setMaxConcurrent] = useState<string>(() => {
    return localStorage.getItem("gens_rft_max_concurrent") || "2";
  });

  const [rememberLocalPath, setRememberLocalPath] = useState<boolean>(() =>
    readBoolPref("gens_rft_opt_remember_local", true)
  );
  const [rememberRemotePath, setRememberRemotePath] = useState<boolean>(() =>
    readBoolPref("gens_rft_opt_remember_remote", true)
  );

  const [skipCrossTabConfirm, setSkipCrossTabConfirm] = useState<boolean>(() => {
    return localStorage.getItem("gens_rft_skip_cross_confirm") === "true";
  });

  // Actions Zustand stables (sans souscrire à `queue` pour éviter les re-renders à 10 Hz)
  const addToQueue = useTransferStore((s) => s.addToQueue);
  const updateProgress = useTransferStore((s) => s.updateProgress);
  const markStatus = useTransferStore((s) => s.markStatus);
  const setStoreMaxConcurrent = useTransferStore((s) => s.setMaxConcurrent);

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
    try {
      const saved = localStorage.getItem("gens_rft_bookmarks");
      return saved ? JSON.parse(saved) : ["/var/log", "/home", "/etc"];
    } catch {
      return ["/var/log", "/home", "/etc"];
    }
  });
  const [showBookmarksMenu, setShowBookmarksMenu] = useState(false);

  // Drag & drop
  const [draggedItem, setDraggedItem] = useState<{
    entry: FileEntry;
    from: "local" | "remote";
    fromSessionId?: string;
  } | null>(null);
  const [isOverLocal, setIsOverLocal] = useState(false);
  const [isOverRemote, setIsOverRemote] = useState(false);

  // Filtres & tris
  const [localSearch, setLocalSearch] = useState("");
  const [remoteSearch, setRemoteSearch] = useState("");
  const [localSort, setLocalSort] = useState<{ field: SortField; order: SortOrder }>({
    field: "name",
    order: "asc",
  });
  const [remoteSort, setRemoteSort] = useState<{ field: SortField; order: SortOrder }>({
    field: "name",
    order: "asc",
  });

  // Sélections et panneau actif
  const [selectedLocalPaths, setSelectedLocalPaths] = useState<Set<string>>(new Set());
  const [selectedRemotePaths, setSelectedRemotePaths] = useState<Set<string>>(new Set());
  const [activePane, setActivePane] = useState<"local" | "remote">("local");

  const deferredLocalSearch = useDeferredValue(localSearch);
  const deferredRemoteSearch = useDeferredValue(remoteSearch);

  const processedLocalFiles = useMemo(() => {
    const query = deferredLocalSearch.toLowerCase();
    return files
      .filter((f) => (showHidden ? true : !f.name.startsWith(".")))
      .filter((f) => (query ? f.name.toLowerCase().includes(query) : true))
      .sort((a, b) => {
        if (a.is_dir && !b.is_dir) return -1;
        if (!a.is_dir && b.is_dir) return 1;
        if (localSort.field === "size") {
          return localSort.order === "asc" ? a.size - b.size : b.size - a.size;
        }
        return localSort.order === "asc"
          ? nameCollator.compare(a.name, b.name)
          : nameCollator.compare(b.name, a.name);
      });
  }, [files, showHidden, deferredLocalSearch, localSort]);

  const processedRemoteFiles = useMemo(() => {
    const query = deferredRemoteSearch.toLowerCase();
    return activeTab.remoteFiles
      .filter((f) => (showHidden ? true : !f.name.startsWith(".")))
      .filter((f) => (query ? f.name.toLowerCase().includes(query) : true))
      .sort((a, b) => {
        if (a.is_dir && !b.is_dir) return -1;
        if (!a.is_dir && b.is_dir) return 1;
        if (remoteSort.field === "size") {
          return remoteSort.order === "asc" ? a.size - b.size : b.size - a.size;
        }
        return remoteSort.order === "asc"
          ? nameCollator.compare(a.name, b.name)
          : nameCollator.compare(b.name, a.name);
      });
  }, [activeTab.remoteFiles, showHidden, deferredRemoteSearch, remoteSort]);

  // Logs (stockés hors d'App pour éviter les re-renders en cascade)
  const logMessage = useLogStore((s) => s.addLog);
  const [activeBottomTab, setActiveBottomTab] = useState<"logs" | "queue" | "terminal">("logs");
  const [bottomOpen, setBottomOpen] = useState(true);

  // Modales
  const [showSettings, setShowSettings] = useState(false);
  const [inputModal, setInputModal] = useState<InputModalState | null>(null);
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState | null>(null);
  const [conflictModal, setConflictModal] = useState<ConflictModalState | null>(null);
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
  const [vaultLoadFailed, setVaultLoadFailed] = useState(false);

  // Références toujours à jour
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const activeTabRef = useRef(activeTab);
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  const currentPathRef = useRef(currentPath);
  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);

  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  const localHistoryRef = useRef(localHistory);
  useEffect(() => {
    localHistoryRef.current = localHistory;
  }, [localHistory]);

  const localPaneWidthRef = useRef(localPaneWidth);
  useEffect(() => {
    localPaneWidthRef.current = localPaneWidth;
  }, [localPaneWidth]);

  const drivesRef = useRef(drives);
  useEffect(() => {
    drivesRef.current = drives;
  }, [drives]);

  const hasLoadedInitialDir = useRef(false);
  const localNavSeqRef = useRef(0);
  const remoteNavSeqMapRef = useRef<Map<string, number>>(new Map());
  const localHistoryIndexRef = useRef(-1);
  useEffect(() => {
    localHistoryIndexRef.current = localHistoryIndex;
  }, [localHistoryIndex]);

  const conflictQueueRef = useRef<PendingConflict[]>([]);
  useEffect(() => {
    conflictQueueRef.current = conflictQueue;
  }, [conflictQueue]);

  const sitesRef = useRef(sites);
  useEffect(() => {
    sitesRef.current = sites;
  }, [sites]);
  const vaultDirtyRef = useRef(false);
  const vaultReadyRef = useRef(false);
  useEffect(() => {
    vaultReadyRef.current = isSitesLoaded && !vaultLoadFailed;
  }, [isSitesLoaded, vaultLoadFailed]);
  const connectingTabsRef = useRef<Set<string>>(new Set());

  const handleOpenContextMenu = useCallback(
    (e: React.MouseEvent, entry: FileEntry | null, isRemote: boolean) => {
      setContextMenu({ x: e.clientX, y: e.clientY, entry, isRemote });
    },
    []
  );

  // Chargement initial des sites depuis le coffre DPAPI Rust (avec migration depuis localStorage)
  useEffect(() => {
    let isCancelled = false;
    const loadSecureSites = async () => {
      try {
        const loaded = await loadSitesFromBackendVault<SiteProfile>("gens_rft_sites");
        if (!isCancelled) {
          setSites(loaded);
          setIsSitesLoaded(true);
        }
      } catch (err) {
        if (!isCancelled) {
          // Ne pas activer isSitesLoaded pour empêcher tout écrasement du coffre existant
          setVaultLoadFailed(true);
          logMessage(`ALERTE SÉCURITÉ : Impossible de déchiffrer le coffre de sites (${err}). Sauvegarde automatique désactivée pour protéger vos données.`);
        }
      }
    };
    loadSecureSites();
    return () => {
      isCancelled = true;
    };
  }, [logMessage]);

  useEffect(() => {
    setSelectedRemotePaths(new Set());
  }, [activeTabId]);

  useEffect(() => {
    const handleGlobalClick = () => {
      setContextMenu(null);
    };
    window.addEventListener("click", handleGlobalClick);
    return () => window.removeEventListener("click", handleGlobalClick);
  }, []);

  useEffect(() => {
    setRemotePathInput(activeTab.remotePath);
  }, [activeTab.remotePath]);

  // Sauvegarde chiffrée via DPAPI côté Rust (jamais d'écrasement si le chargement initial a échoué)
  useEffect(() => {
    if (!isSitesLoaded || vaultLoadFailed) return;
    vaultDirtyRef.current = true;
    const timer = setTimeout(async () => {
      try {
        await saveSitesToBackendVault(sites);
        vaultDirtyRef.current = false;
      } catch (err) {
        logMessage(`Alerte sécurité : échec de la sauvegarde du coffre (${err}).`);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [sites, isSitesLoaded, vaultLoadFailed, logMessage]);

  useEffect(() => {
    localStorage.setItem("gens_rft_opt_remember_local", JSON.stringify(rememberLocalPath));
  }, [rememberLocalPath]);

  useEffect(() => {
    localStorage.setItem("gens_rft_opt_remember_remote", JSON.stringify(rememberRemotePath));
  }, [rememberRemotePath]);

  useEffect(() => {
    localStorage.setItem("gens_rft_show_hidden", JSON.stringify(showHidden));
  }, [showHidden]);

  useEffect(() => {
    localStorage.setItem("gens_rft_show_tree_panels", JSON.stringify(showTreePanels));
  }, [showTreePanels]);

  useEffect(() => {
    localStorage.setItem("gens_rft_enable_ssh_terminal", JSON.stringify(enableSshTerminal));
  }, [enableSshTerminal]);

  useEffect(() => {
    localStorage.setItem("gens_rft_max_concurrent", maxConcurrent);
    const parsed = Math.max(1, Math.min(10, parseInt(maxConcurrent, 10) || 2));
    setStoreMaxConcurrent(parsed);
  }, [maxConcurrent, setStoreMaxConcurrent]);

  useEffect(() => {
    try {
      localStorage.setItem("gens_rft_bookmarks", JSON.stringify(bookmarks));
    } catch {}
  }, [bookmarks]);

  // Mémorisation légère du chemin local (sans ré-encrypter le coffre DPAPI)
  useEffect(() => {
    if (rememberLocalPath && currentPath) {
      localStorage.setItem("gens_rft_last_local_path", currentPath);
      if (activeTab?.siteId) {
        writeSitePath(activeTab.siteId, { lastLocalPath: currentPath });
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

  // Écoute de la progression de transfert et perte de session SFTP
  useEffect(() => {
    let disposed = false;
    let unlistenProgress: (() => void) | undefined;
    let unlistenSessionLost: (() => void) | undefined;

    listen<TransferProgress>("transfer_progress", (event) => {
      if (disposed) return;
      const p = event.payload;
      updateProgress(p.transfer_id, p.transferred, p.total, p.percent);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlistenProgress = fn;
      })
      .catch(() => {});

    listen<string>("sftp_session_lost", (event) => {
      if (disposed) return;
      const lostId = event.payload;
      setTabs((prev) =>
        prev.map((t) =>
          t.id === lostId && t.isConnected
            ? { ...t, isConnected: false, title: "Déconnecté" }
            : t
        )
      );
      void invoke("disconnect_server", { sessionId: lostId }).catch(() => {});
      logMessage(`[${lostId}] Connexion SSH/SFTP perdue.`);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlistenSessionLost = fn;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlistenProgress?.();
      unlistenSessionLost?.();
    };
  }, [updateProgress, logMessage]);

  // Chargement dossier local (protégé contre les réponses obsolètes)
  const loadLocalDirectory = useCallback(
    async (targetPath?: string, recordHistory = true) => {
      const seq = ++localNavSeqRef.current;
      try {
        logMessage(`CWD Local: ${targetPath || "dossier utilisateur"}`);
        const result = await invoke<FileEntry[]>("read_local_dir", {
          path: targetPath || null,
        });
        if (seq !== localNavSeqRef.current) return;

        setFiles(result);
        setSelectedLocalPaths(new Set());
        let effectivePath = targetPath;
        if (targetPath) {
          setCurrentPath(targetPath);
        } else if (!currentPathRef.current) {
          if (result.length > 0) {
            const sep = result[0].path.includes("/") && !result[0].path.includes("\\") ? "/" : "\\";
            const parent = result[0].path.split(/[\\/]/).slice(0, -1).join(sep);
            effectivePath = parent || (sep === "/" ? "/" : "C:\\");
          } else {
            const folders = await invoke<Record<string, string>>("get_system_folders").catch(
              () => ({} as Record<string, string>)
            );
            effectivePath = folders.home || drivesRef.current[0] || "C:\\";
          }
          setCurrentPath(effectivePath);
        }
        if (effectivePath && recordHistory) {
          const targetHistPath = effectivePath;
          const prevHist = localHistoryRef.current;
          const curIdx = localHistoryIndexRef.current;
          const sliced = curIdx >= 0 ? prevHist.slice(0, curIdx + 1) : prevHist;
          if (sliced.length > 0 && sliced[sliced.length - 1] === targetHistPath) {
            const idx = sliced.length - 1;
            localHistoryRef.current = sliced;
            localHistoryIndexRef.current = idx;
            setLocalHistory(sliced);
            setLocalHistoryIndex(idx);
          } else {
            const next = [...sliced, targetHistPath];
            const idx = next.length - 1;
            localHistoryRef.current = next;
            localHistoryIndexRef.current = idx;
            setLocalHistory(next);
            setLocalHistoryIndex(idx);
          }
        }
      } catch (err) {
        if (seq !== localNavSeqRef.current) return;
        logMessage(`Erreur lecture locale (${targetPath}) : ${err}`);
        if (drivesRef.current.length > 0 && targetPath !== drivesRef.current[0]) {
          loadLocalDirectory(drivesRef.current[0], false);
        }
      }
    },
    [logMessage]
  );

  // Chargement dossier distant (protégé contre les réponses obsolètes, sans effet de bord dans setTabs)
  const loadRemoteDirectory = useCallback(
    async (targetPath?: string, targetSessionId?: string, recordHistory = true) => {
      const sId = targetSessionId || activeTabRef.current.id;
      const nextSeq = (remoteNavSeqMapRef.current.get(sId) || 0) + 1;
      remoteNavSeqMapRef.current.set(sId, nextSeq);

      const fallbackPath = "/";
      try {
        logMessage(`[${sId}] CWD Distant: ${targetPath || "/"}`);
        const result = await invoke<FileEntry[]>("list_remote_dir", {
          sessionId: sId,
          path: targetPath || null,
        });

        if (remoteNavSeqMapRef.current.get(sId) !== nextSeq) return;

        const effectivePath = targetPath || "/";
        if (sId === activeTabRef.current.id) {
          setSelectedRemotePaths(new Set());
        }
        setTabs((prev) =>
          prev.map((t) => {
            if (t.id !== sId) return t;
            let newHistory = t.remoteHistory || ["/"];
            let newIndex = t.remoteHistoryIndex ?? newHistory.length - 1;
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
          const tab = tabsRef.current.find((t) => t.id === sId);
          if (tab?.siteId) {
            writeSitePath(tab.siteId, { lastRemotePath: effectivePath });
          }
        }

        logMessage(`250 ${result.length} élément(s) listé(s) sur le serveur distant.`);
      } catch (err) {
        if (remoteNavSeqMapRef.current.get(sId) !== nextSeq) return;
        logMessage(`550 Erreur dossier distant (${targetPath}) : ${err}`);
        if (targetPath && targetPath !== fallbackPath) {
          logMessage(`Repli automatique sur la racine ${fallbackPath}`);
          try {
            const rootResult = await invoke<FileEntry[]>("list_remote_dir", {
              sessionId: sId,
              path: fallbackPath,
            });
            if (remoteNavSeqMapRef.current.get(sId) !== nextSeq) return;
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
    },
    [logMessage, rememberRemotePath]
  );

  // Enfilement avec détection de conflit (inclut la cible d'un onglet distant autre que l'onglet actif)
  const checkAndEnqueueTransfer = useCallback(
    (
      filename: string,
      sourcePath: string,
      destDir: string,
      direction: "upload" | "download",
      isDir: boolean,
      destSessionId?: string
    ) => {
      const targetSessionId = destSessionId || activeTabRef.current.id;
      const targetTab =
        tabsRef.current.find((t) => t.id === targetSessionId) || activeTabRef.current;
      const isTargetCurrentDir =
        direction === "upload"
          ? destDir.replace(/\/+$/, "") === targetTab.remotePath.replace(/\/+$/, "")
          : destDir.replace(/[\\/]+$/, "").toLowerCase() ===
            currentPathRef.current.replace(/[\\/]+$/, "").toLowerCase();

      let exists = false;
      if (isTargetCurrentDir) {
        if (direction === "upload") {
          exists = targetTab.remoteFiles.some((f) =>
            targetTab.protocol === "SFTP"
              ? f.name === filename
              : f.name.toLowerCase() === filename.toLowerCase()
          );
        } else {
          exists = filesRef.current.some((f) => f.name.toLowerCase() === filename.toLowerCase());
        }
      }

      if (exists) {
        setConflictQueue((prev) => [
          ...prev,
          {
            filename,
            sourcePath,
            destDir,
            direction,
            isDir,
            destSessionId: targetSessionId,
          },
        ]);
      } else {
        addToQueue({
          sessionId: targetSessionId,
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
    },
    [addToQueue]
  );

  // Glisser-déposer externe natif Tauri v2
  useEffect(() => {
    let disposed = false;
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
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => {});

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [checkAndEnqueueTransfer, loadLocalDirectory, logMessage]);

  // Confirmation avant fermeture si transfert en cours + flush coffre + nettoyage propre des sessions
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        const running = useTransferStore
          .getState()
          .queue.filter((item) => item.status === "running").length;
        const needsVaultFlush = vaultDirtyRef.current && vaultReadyRef.current;

        if (running > 0) {
          event.preventDefault();
          setConfirmModal({
            title: "Transferts en cours",
            message: `Il y a actuellement ${running} transfert(s) en cours d'exécution. Voulez-vous vraiment interrompre les transferts et quitter Gens-RFT ?`,
            onConfirm: async () => {
              if (vaultDirtyRef.current && vaultReadyRef.current) {
                await saveSitesToBackendVault(sitesRef.current).catch(() => {});
                vaultDirtyRef.current = false;
              }
              await invoke("cancel_current_transfer", { transferId: null }).catch(() => {});
              await Promise.all(
                tabsRef.current
                  .filter((t) => t.isConnected)
                  .map((t) => invoke("disconnect_server", { sessionId: t.id }).catch(() => {}))
              );
              await getCurrentWindow().destroy();
            },
          });
        } else if (needsVaultFlush) {
          event.preventDefault();
          await saveSitesToBackendVault(sitesRef.current).catch(() => {});
          vaultDirtyRef.current = false;
          await getCurrentWindow().destroy();
        }
      })
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => {});

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Ordonnanceur de transferts hors-rendu React (zéro re-render sur transfer_progress)
  const inFlightIdsRef = useRef<Set<string>>(new Set());

  const processTransferQueue = useCallback(() => {
    const state = useTransferStore.getState();
    const limit = state.maxConcurrent || 2;
    let runningCount = state.queue.filter((item) => item.status === "running").length;

    while (runningCount < limit) {
      const nextItem = useTransferStore
        .getState()
        .queue.find((item) => item.status === "queued" && !inFlightIdsRef.current.has(item.id));
      if (!nextItem) break;

      inFlightIdsRef.current.add(nextItem.id);
      markStatus(nextItem.id, "running");
      runningCount++;

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
              activeTabRef.current.remotePath.replace(/\/+$/, "") ===
                nextItem.destDir.replace(/\/+$/, "")
            ) {
              loadRemoteDirectory(activeTabRef.current.remotePath, nextItem.sessionId, false);
            }
          } else {
            const finalDownloadName = nextItem.destFileName || nextItem.filename;
            logMessage(`RETR [${finalDownloadName}] -> ${nextItem.destDir}`);
            const savedLocalName = await invoke<string>("download_item", {
              sessionId: nextItem.sessionId,
              transferId: nextItem.id,
              remotePath: nextItem.sourcePath,
              localDestDir: nextItem.destDir,
              destFilename: finalDownloadName,
              isDir: nextItem.isDir,
            });

            if (nextItem.relayToSessionId && nextItem.relayDestDir) {
              const currentItem = useTransferStore
                .getState()
                .queue.find((q) => q.id === nextItem.id);
              if (!currentItem || currentItem.status !== "running") {
                throw new Error("Relais annulé par l'utilisateur");
              }

              const finalRelayName = nextItem.destFileName || nextItem.filename;
              const effectiveLocalName = savedLocalName || finalRelayName;
              const localRelayFile = joinLocalPath(nextItem.destDir, effectiveLocalName);
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
                await invoke("delete_local", { path: nextItem.destDir, isDir: true });
              } catch {}
              if (
                activeTabRef.current.id === nextItem.relayToSessionId &&
                activeTabRef.current.remotePath.replace(/\/+$/, "") ===
                  nextItem.relayDestDir.replace(/\/+$/, "")
              ) {
                loadRemoteDirectory(
                  activeTabRef.current.remotePath,
                  nextItem.relayToSessionId,
                  false
                );
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
    }
  }, [loadLocalDirectory, loadRemoteDirectory, logMessage, markStatus, updateProgress]);

  useEffect(() => {
    processTransferQueue();
    let prevSig = "";
    const unsub = useTransferStore.subscribe((state) => {
      let queued = 0;
      let running = 0;
      for (const it of state.queue) {
        if (it.status === "queued") queued++;
        else if (it.status === "running") running++;
      }
      const sig = `${queued}:${running}:${state.maxConcurrent}`;
      if (sig !== prevSig) {
        prevSig = sig;
        processTransferQueue();
      }
    });
    return unsub;
  }, [processTransferQueue]);

  // Raccourcis claviers globaux (stabilisé via ref pour éviter de ré-attacher le listener à chaque interaction)
  const keyContextRef = useRef({
    tabs,
    activeTabId,
    currentPath,
    activeTab,
    activePane,
    selectedLocalPaths,
    selectedRemotePaths,
    files,
    processedLocalFiles,
    processedRemoteFiles,
    hasOpenModal: false,
    onCreateNewTab: () => {},
    onCloseTab: (_tabId: string) => {},
  });
  keyContextRef.current = {
    tabs,
    activeTabId,
    currentPath,
    activeTab,
    activePane,
    selectedLocalPaths,
    selectedRemotePaths,
    files,
    processedLocalFiles,
    processedRemoteFiles,
    hasOpenModal: Boolean(
      showSettings ||
        showSiteManager ||
        conflictModal ||
        chmodModal ||
        editorModal ||
        confirmModal ||
        inputModal ||
        crossTabModal ||
        tabPromptModal
    ),
    onCreateNewTab: () => {
      createNewTab();
    },
    onCloseTab: (tabId: string) => {
      closeTab(tabId);
    },
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const targetTag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (targetTag === "input" || targetTag === "textarea") return;

      const ctx = keyContextRef.current;
      if (ctx.hasOpenModal) return;

      if (e.key === "F5") {
        e.preventDefault();
        loadLocalDirectory(ctx.currentPath);
        if (ctx.activeTab.isConnected) {
          loadRemoteDirectory(ctx.activeTab.remotePath);
        }
        logMessage("Rafraîchissement des répertoires.");
      } else if (e.key === "Delete" || e.key === "Del") {
        if (ctx.activePane === "local" && ctx.selectedLocalPaths.size > 0) {
          e.preventDefault();
          const itemsToDelete = ctx.files.filter((f) => ctx.selectedLocalPaths.has(f.path));
          if (itemsToDelete.length === 0) return;
          const curPath = ctx.currentPath;
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
              loadLocalDirectory(curPath);
            },
          });
        } else if (
          ctx.activePane === "remote" &&
          ctx.selectedRemotePaths.size > 0 &&
          ctx.activeTab.isConnected
        ) {
          e.preventDefault();
          const tab = ctx.activeTab;
          const itemsToDelete = tab.remoteFiles.filter((f) => ctx.selectedRemotePaths.has(f.path));
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
                    sessionId: tab.id,
                    path: it.path,
                    isDir: it.is_dir,
                  });
                } catch (err) {
                  logMessage(`Erreur suppression ${it.name} : ${err}`);
                }
              }
              setSelectedRemotePaths(new Set());
              loadRemoteDirectory(tab.remotePath, tab.id);
            },
          });
        }
      } else if (e.key === "F2") {
        if (ctx.activePane === "local" && ctx.selectedLocalPaths.size === 1) {
          e.preventDefault();
          const entry = ctx.files.find((f) => ctx.selectedLocalPaths.has(f.path));
          if (!entry) return;
          const curPath = ctx.currentPath;
          setInputModal({
            title: "Renommer l'élément local",
            label: "Nouveau nom :",
            value: entry.name,
            onConfirm: async (val) => {
              const newName = val.trim();
              if (!newName || newName === entry.name) return;
              if (!isValidFilenameInput(newName, false)) {
                logMessage("Nom local invalide (caractères interdits ou '..').");
                return;
              }
              const sep = entry.path.includes("/") && !entry.path.includes("\\") ? "/" : "\\";
              const parent = entry.path.split(sep).slice(0, -1).join(sep);
              const newPath = `${parent}${sep}${newName}`;
              try {
                await invoke("rename_local", { oldPath: entry.path, newPath });
                logMessage(`Renommé en local : ${entry.name} -> ${newName}`);
                loadLocalDirectory(curPath);
              } catch (err) {
                logMessage(`Erreur renommage : ${err}`);
              }
            },
          });
        } else if (
          ctx.activePane === "remote" &&
          ctx.selectedRemotePaths.size === 1 &&
          ctx.activeTab.isConnected
        ) {
          e.preventDefault();
          const tab = ctx.activeTab;
          const entry = tab.remoteFiles.find((f) => ctx.selectedRemotePaths.has(f.path));
          if (!entry) return;
          setInputModal({
            title: "Renommer l'élément distant",
            label: "Nouveau nom :",
            value: entry.name,
            onConfirm: async (val) => {
              const newName = val.trim();
              if (!newName || newName === entry.name) return;
              if (!isValidFilenameInput(newName, true)) {
                logMessage("Nom distant invalide (caractères interdits ou '..').");
                return;
              }
              const parent = entry.path.split("/").slice(0, -1).join("/") || "/";
              const newPath = joinRemotePath(parent, newName);
              try {
                await invoke("rename_remote", {
                  sessionId: tab.id,
                  oldPath: entry.path,
                  newPath,
                });
                logMessage(`Renommé à distance : ${entry.name} -> ${newName}`);
                loadRemoteDirectory(tab.remotePath, tab.id);
              } catch (err) {
                logMessage(`Erreur renommage distant : ${err}`);
              }
            },
          });
        }
      } else if (e.ctrlKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        if (ctx.activePane === "local") {
          setSelectedLocalPaths(new Set(ctx.processedLocalFiles.map((f) => f.path)));
        } else if (ctx.activePane === "remote" && ctx.activeTab.isConnected) {
          setSelectedRemotePaths(new Set(ctx.processedRemoteFiles.map((f) => f.path)));
        }
      } else if (e.key === "Escape") {
        setSelectedLocalPaths(new Set());
        setSelectedRemotePaths(new Set());
        setContextMenu(null);
      } else if (e.ctrlKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        ctx.onCreateNewTab();
      } else if (e.ctrlKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (ctx.tabs.length > 1) {
          ctx.onCloseTab(ctx.activeTabId);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [loadLocalDirectory, loadRemoteDirectory, logMessage]);

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

  // Connexion avec validation port + vérification empreinte SSH & certificat FTPS
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
    initialLocalPath?: string,
    acceptInvalidCerts = false,
    trustHostKey = false
  ) => {
    const cleanHost = targetHost.trim();
    if (!cleanHost) {
      logMessage("Erreur : L'adresse de l'hôte est requise.");
      return;
    }

    const defaultPort = protocol === "FTP" || protocol === "FTPS" ? 21 : 22;
    const parsedPort = targetPort.trim() ? parseInt(targetPort.trim(), 10) : defaultPort;
    if (isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      logMessage(`Erreur : Numéro de port invalide (${targetPort}). Doit être entre 1 et 65535.`);
      return;
    }

    if (connectingTabsRef.current.has(targetSessionId)) {
      logMessage(`[${targetSessionId}] Une connexion est déjà en cours sur cet onglet.`);
      return;
    }
    connectingTabsRef.current.add(targetSessionId);

    logMessage(
      `[${targetSessionId}] Connexion ${protocol} à ${targetUser}@${cleanHost}:${parsedPort}...`
    );
    try {
      const msg = await invoke<string>("connect_server", {
        sessionId: targetSessionId,
        protocol,
        host: cleanHost,
        port: parsedPort,
        username: targetUser,
        authType,
        password: targetPass || null,
        keyPath: targetKeyPath || null,
        passphrase: targetPassphrase || null,
        trustHostKey,
        acceptInvalidCerts,
      });

      setQuickPass("");

      // Si l'onglet a été fermé pendant le handshake réseau, fermer proprement la session côté Rust
      if (!tabsRef.current.some((t) => t.id === targetSessionId)) {
        void invoke("disconnect_server", { sessionId: targetSessionId }).catch(() => {});
        return;
      }

      logMessage(`230 ${msg}`);
      const tabTitle = cleanHost ? `${targetUser}@${cleanHost}` : "Serveur";

      setTabs((prev) =>
        prev.map((t) =>
          t.id === targetSessionId
            ? {
                ...t,
                title: tabTitle,
                isConnected: true,
                protocol,
                host: cleanHost,
                port: String(parsedPort),
                username: targetUser,
                siteId,
              }
            : t
        )
      );

      if (cleanHost && targetUser) {
        setQuickHistory((prev) => {
          const entry: QuickHistoryItem = {
            host: cleanHost,
            port: String(parsedPort),
            username: targetUser,
            protocol,
          };
          const filtered = prev.filter(
            (it) =>
              !(
                it.host === entry.host &&
                it.port === entry.port &&
                it.username === entry.username &&
                it.protocol === entry.protocol
              )
          );
          const updated = [entry, ...filtered].slice(0, 10);
          localStorage.setItem("gens_rft_quick_history", JSON.stringify(updated));
          return updated;
        });
      }

      const memPaths = siteId ? readSitePaths()[siteId] : undefined;
      const effLocal = memPaths?.lastLocalPath || initialLocalPath;
      const effRemote = memPaths?.lastRemotePath || initialRemotePath;

      if (rememberLocalPath && effLocal) {
        loadLocalDirectory(effLocal);
      }

      const targetDir = rememberRemotePath && effRemote ? effRemote : "/";
      await loadRemoteDirectory(targetDir, targetSessionId);
    } catch (err) {
      const errStr = String(err);

      if (errStr.startsWith("HOST_KEY_UNKNOWN|")) {
        const [, algo = "ssh", fingerprint = ""] = errStr.split("|");
        logMessage(`Clé d'hôte SSH inconnue pour ${cleanHost}:${parsedPort} (${algo} ${fingerprint})`);
        setConfirmModal({
          title: "Clé d'hôte SSH inconnue",
          message: `La clé d'hôte de ${cleanHost}:${parsedPort} n'est pas encore connue (${algo}). Empreinte : ${fingerprint}. Voulez-vous lui faire confiance et l'enregistrer dans known_hosts ?`,
          onConfirm: () => {
            executeConnect(
              targetSessionId,
              protocol,
              cleanHost,
              String(parsedPort),
              targetUser,
              authType,
              targetPass,
              targetKeyPath,
              targetPassphrase,
              siteId,
              initialRemotePath,
              initialLocalPath,
              acceptInvalidCerts,
              true
            );
          },
        });
        return;
      }

      if (errStr.startsWith("HOST_KEY_CHANGED|")) {
        const [, algo = "ssh", fingerprint = ""] = errStr.split("|");
        logMessage(
          `ALERTE SÉCURITÉ : La clé d'hôte SSH de ${cleanHost}:${parsedPort} a changé (${algo} ${fingerprint}) ! Connexion bloquée (risque MITM).`
        );
        setConfirmModal({
          title: "Alerte sécurité : Clé SSH modifiée",
          message: `La clé d'hôte de ${cleanHost}:${parsedPort} ne correspond plus à celle enregistrée dans known_hosts (${algo} : ${fingerprint}). Cela peut indiquer une attaque Man-in-the-Middle. Si ce changement est légitime, supprimez l'ancienne entrée dans ~/.ssh/known_hosts avant de vous reconnecter.`,
          infoOnly: true,
          onConfirm: () => {},
        });
        return;
      }

      if (errStr.startsWith("FTPS_CERT_ERROR|")) {
        const detail = errStr.slice("FTPS_CERT_ERROR|".length);
        logMessage(`Certificat TLS FTPS rejeté pour ${cleanHost}:${parsedPort} : ${detail}`);
        setConfirmModal({
          title: "Certificat TLS FTPS invalide",
          message: `Le certificat TLS du serveur ${cleanHost}:${parsedPort} n'est pas approuvé (${detail}). Voulez-vous tout de même vous connecter en ignorant la vérification du certificat pour cette session ?`,
          onConfirm: () => {
            executeConnect(
              targetSessionId,
              protocol,
              cleanHost,
              String(parsedPort),
              targetUser,
              authType,
              targetPass,
              targetKeyPath,
              targetPassphrase,
              siteId,
              initialRemotePath,
              initialLocalPath,
              true,
              trustHostKey
            );
          },
        });
        return;
      }

      logMessage(`530 Échec d'authentification : ${errStr}`);
    } finally {
      connectingTabsRef.current.delete(targetSessionId);
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
    initialLocalPath?: string,
    acceptInvalidCerts = false
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
          acceptInvalidCerts,
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
      initialLocalPath,
      acceptInvalidCerts
    );
  };

  const handleDisconnect = async (sessionId: string) => {
    await invoke("disconnect_server", { sessionId }).catch(() => {});
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
    const uid =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID().slice(0, 8)
        : String(Date.now());
    const newId = `tab_${uid}`;
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
    void handleDisconnect(tabId);
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
      const savedLocal = rememberLocalPath
        ? localStorage.getItem("gens_rft_last_local_path")
        : null;
      loadLocalDirectory(savedLocal || undefined);

      invoke<string[]>("get_windows_drives")
        .then((d) => setDrives(d))
        .catch(() => setDrives(["C:\\"]));

      invoke<Record<string, string>>("get_system_folders")
        .then((f) => setSysFolders(f))
        .catch(() => {});
    }
  }, [rememberLocalPath, loadLocalDirectory]);

  // Traitement file de conflits
  useEffect(() => {
    if (conflictQueue.length > 0 && !conflictModal) {
      const current = conflictQueue[0];
      const getExistingDestNames = (item: PendingConflict): Set<string> => {
        if (item.relayToSessionId) {
          const targetTab = tabsRef.current.find((t) => t.id === item.relayToSessionId);
          return new Set((targetTab?.remoteFiles || []).map((f) => f.name.toLowerCase()));
        }
        if (item.direction === "upload") {
          const targetTab = tabsRef.current.find((t) => t.id === item.destSessionId);
          return new Set((targetTab?.remoteFiles || []).map((f) => f.name.toLowerCase()));
        }
        return new Set(filesRef.current.map((f) => f.name.toLowerCase()));
      };

      setConflictModal({
        filename: current.filename,
        remainingCount: conflictQueue.length,
        onResolve: (action: "overwrite" | "rename" | "skip", applyToAll: boolean) => {
          if (applyToAll) {
            const latestQueue = conflictQueueRef.current;
            const existingNames = getExistingDestNames(current);
            for (const item of latestQueue) {
              if (action === "skip") {
                logMessage(`Transfert de "${item.filename}" ignoré.`);
              } else {
                const finalName =
                  action === "rename"
                    ? buildCopyFilename(item.filename, item.isDir, existingNames)
                    : item.filename;
                addToQueue({
                  sessionId: item.destSessionId,
                  filename: item.filename,
                  destFileName: finalName,
                  sourcePath: item.sourcePath,
                  destDir: item.destDir,
                  direction: item.direction,
                  isDir: item.isDir,
                  relayToSessionId: item.relayToSessionId,
                  relayDestDir: item.relayDestDir,
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
              const existingNames = getExistingDestNames(current);
              const finalName =
                action === "rename"
                  ? buildCopyFilename(current.filename, current.isDir, existingNames)
                  : current.filename;
              addToQueue({
                sessionId: current.destSessionId,
                filename: current.filename,
                destFileName: finalName,
                sourcePath: current.sourcePath,
                destDir: current.destDir,
                direction: current.direction,
                isDir: current.isDir,
                relayToSessionId: current.relayToSessionId,
                relayDestDir: current.relayDestDir,
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
  }, [conflictQueue, conflictModal, addToQueue, logMessage]);

  // Relais inter-onglets avec dossier temporaire unique par item et détection de conflit cible
  const enqueueCrossTabTransfer = async (
    item: { entry: FileEntry; from: "local" | "remote"; fromSessionId?: string },
    targetTab: TabSession
  ) => {
    if (item.from === "remote" && item.fromSessionId && item.fromSessionId !== targetTab.id) {
      try {
        const tempBase = await invoke<string>("get_temp_dir");
        const uniqueId =
          typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const transferSubdir = joinLocalPath(tempBase, `relay_${uniqueId}`);
        await invoke("create_local_dir", { path: transferSubdir });

        const targetExists = targetTab.remoteFiles.some((f) =>
          targetTab.protocol === "SFTP"
            ? f.name === item.entry.name
            : f.name.toLowerCase() === item.entry.name.toLowerCase()
        );

        if (targetExists) {
          setConflictQueue((prev) => [
            ...prev,
            {
              filename: item.entry.name,
              sourcePath: item.entry.path,
              destDir: transferSubdir,
              direction: "download",
              isDir: item.entry.is_dir,
              destSessionId: item.fromSessionId!,
              relayToSessionId: targetTab.id,
              relayDestDir: targetTab.remotePath,
            },
          ]);
          return;
        }

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

  // Projection légère des onglets pour éviter de re-rendre BottomPanel lors de la navigation
  const terminalTabsSig = tabs
    .map((t) => `${t.id}:${t.title}:${t.isConnected ? 1 : 0}:${t.protocol}`)
    .join("|");
  const terminalTabs = useMemo<TerminalTabInfo[]>(
    () =>
      tabs.map((t) => ({
        id: t.id,
        title: t.title,
        isConnected: t.isConnected,
        protocol: t.protocol,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [terminalTabsSig]
  );
  const activeTerminalTab = useMemo<TerminalTabInfo>(
    () => terminalTabs.find((t) => t.id === activeTab.id) || terminalTabs[0],
    [terminalTabs, activeTab.id]
  );

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
          localHistory={localHistory}
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
          onOpenContextMenu={handleOpenContextMenu}
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
          onOpenContextMenu={handleOpenContextMenu}
          onPromptInputModal={setInputModal}
          onPromptConfirmModal={setConfirmModal}
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
        tabs={terminalTabs}
        activeTab={activeTerminalTab}
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
        onSuccess={(targetSessionId) => {
          const targetTab = tabsRef.current.find((t) => t.id === targetSessionId);
          if (targetTab?.isConnected) {
            loadRemoteDirectory(targetTab.remotePath, targetTab.id, false);
          }
        }}
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
            site.lastLocalPath,
            !!site.acceptInvalidCerts
          );
        }}
        isDark={isDark}
        logMessage={logMessage}
        vaultLoadFailed={vaultLoadFailed}
      />

      {/* Modale bifurcation de connexion */}
      <TabPromptModal
        tabPromptModal={tabPromptModal}
        activeTab={activeTab}
        onClose={() => setTabPromptModal(null)}
        onReplaceConnection={async () => {
          if (!tabPromptModal) return;
          const p = tabPromptModal.pendingParams;
          await handleDisconnect(activeTab.id);
          await executeConnect(
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
            p.initialLocalPath,
            !!p.acceptInvalidCerts
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
            p.initialLocalPath,
            !!p.acceptInvalidCerts
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
        onSuccess={(targetSessionId) => {
          const targetTab = tabsRef.current.find((t) => t.id === targetSessionId);
          if (targetTab?.isConnected) {
            loadRemoteDirectory(targetTab.remotePath, targetTab.id, false);
          }
        }}
        logMessage={logMessage}
        isDark={isDark}
      />
    </div>
  );
}

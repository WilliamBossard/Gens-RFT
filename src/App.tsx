import { useEffect, useState, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import SshTerminal from "./SshTerminal";
import DirectoryTree from "./DirectoryTree";
import {
  Server,
  Folder,
  FileText,
  Terminal as TerminalIcon,
  HardDrive,
  ArrowUp,
  Upload,
  Download,
  Trash2,
  FolderPlus,
  SlidersHorizontal,
  X,
  Plus,
  CheckCircle,
  Clock,
  ListOrdered,
  Search,
  ArrowUpDown,
  ShieldCheck,
  Calculator,
  ExternalLink,
  Ban,
  RotateCcw,
  AlertTriangle,
  RefreshCw,
  Settings,
  Sliders,
  Info,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Monitor,
  FolderDown,
  FileSpreadsheet,
  Star,
  Edit2,
  Unplug,
  FileCode,
  FileArchive,
  FileImage,
  FileCheck,
  FileEdit,
  Save,
  Send
} from "lucide-react";

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  permissions?: number;
}

interface TransferProgress {
  transfer_id: string;
  filename: string;
  transferred: number;
  total: number;
  percent: number;
  direction: "upload" | "download";
}

interface QueueItem {
  id: string;
  filename: string;
  sourcePath: string;
  destDir: string;
  destFileName: string;
  direction: "upload" | "download";
  isDir: boolean;
  status: "queued" | "running" | "done" | "error";
  percent: number;
  speed: string;
  eta: string;
  lastBytes: number;
  lastTimestamp: number;
  sessionId: string;
}

interface SiteProfile {
  id: string;
  name: string;
  protocol: "SFTP" | "FTP";
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

interface TabSession {
  id: string;
  title: string;
  isConnected: boolean;
  protocol: "SFTP" | "FTP";
  host: string;
  port: string;
  username: string;
  remotePath: string;
  remoteFiles: FileEntry[];
  siteId?: string;
}

type SortField = "name" | "size";
type SortOrder = "asc" | "desc";

function isEditableTextFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const nonEditable = [
    "zip", "tar", "gz", "7z", "rar", "iso", "exe", "bin", "dll", "so",
    "png", "jpg", "jpeg", "gif", "webp", "ico", "mp4", "mkv", "avi", "mov", "mp3", "wav",
    "pdf", "docx", "xlsx", "pptx"
  ];
  if (nonEditable.includes(ext)) return false;
  const editable = [
    "txt", "md", "sh", "bash", "zsh", "rs", "py", "js", "jsx", "ts", "tsx",
    "json", "yml", "yaml", "toml", "conf", "cfg", "ini", "env", "css", "html",
    "log", "xml", "service", "rules"
  ];
  return editable.includes(ext) || !name.includes(".");
}

function getFileBadge(name: string, isDark: boolean) {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["zip", "tar", "gz", "7z", "rar", "iso"].includes(ext)) {
    return {
      icon: <FileArchive className="h-4 w-4 text-amber-500 shrink-0" />,
      color: isDark ? "text-amber-400" : "text-amber-700",
    };
  }
  if (["rs", "ts", "tsx", "js", "jsx", "py", "sh", "json", "yml", "yaml", "toml", "css", "html"].includes(ext)) {
    return {
      icon: <FileCode className="h-4 w-4 text-emerald-500 shrink-0" />,
      color: isDark ? "text-emerald-300" : "text-emerald-700",
    };
  }
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "mp4", "mkv"].includes(ext)) {
    return {
      icon: <FileImage className="h-4 w-4 text-purple-500 shrink-0" />,
      color: isDark ? "text-purple-300" : "text-purple-700",
    };
  }
  if (["pdf", "docx", "doc", "txt", "md", "cfg", "conf", "ini", "env"].includes(ext)) {
    return {
      icon: <FileText className="h-4 w-4 text-sky-500 shrink-0" />,
      color: isDark ? "text-sky-300" : "text-sky-700",
    };
  }
  return {
    icon: <FileCheck className="h-4 w-4 text-neutral-400 shrink-0" />,
    color: isDark ? "text-neutral-300" : "text-neutral-800",
  };
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

  const [showHidden, setShowHidden] = useState(false);
  const [showTreePanels, setShowTreePanels] = useState(true);
  const [enableSshTerminal, setEnableSshTerminal] = useState(true);
  const [maxConcurrent, setMaxConcurrent] = useState("2");
  const [settingsTab, setSettingsTab] = useState<"general" | "panels" | "about">("general");

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

  // Largeur ajustable entre le panneau local et distant (en %)
  const [localPaneWidth, setLocalPaneWidth] = useState(50);
  const [treeHeight, setTreeHeight] = useState(130);
  const [bottomHeight, setBottomHeight] = useState(180);

  // Connexion rapide
  const [quickHost, setQuickHost] = useState("");
  const [quickPort, setQuickPort] = useState("22");
  const [quickUser, setQuickUser] = useState("");
  const [quickPass, setQuickPass] = useState("");

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
  const bookmarksRef = useRef<HTMLDivElement>(null);

  // Drag & drop
  const [draggedItem, setDraggedItem] = useState<{ entry: FileEntry; from: "local" | "remote"; fromSessionId?: string } | null>(null);
  const [isOverLocal, setIsOverLocal] = useState(false);
  const [isOverRemote, setIsOverRemote] = useState(false);

  // Filtres & tris
  const [localSearch, setLocalSearch] = useState("");
  const [remoteSearch, setRemoteSearch] = useState("");
  const [localSort, setLocalSort] = useState<{ field: SortField; order: SortOrder }>({ field: "name", order: "asc" });
  const [remoteSort, setRemoteSort] = useState<{ field: SortField; order: SortOrder }>({ field: "name", order: "asc" });

  // Logs & scroll automatique
  const [logs, setLogs] = useState<string[]>(["Gens-RFT initialisé."]);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const [activeBottomTab, setActiveBottomTab] = useState<"logs" | "queue" | "terminal">("logs");
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [bottomOpen, setBottomOpen] = useState(true);

  // Modales
  const [showSettings, setShowSettings] = useState(false);
  const [inputModal, setInputModal] = useState<{
    title: string;
    label: string;
    value: string;
    onConfirm: (val: string) => void;
  } | null>(null);

  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  const [conflictModal, setConflictModal] = useState<{
    filename: string;
    onResolve: (action: "overwrite" | "rename" | "skip") => void;
  } | null>(null);

  const [chmodModal, setChmodModal] = useState<{ path: string; name: string; octal: string } | null>(null);

  // Modale confirmation inter-onglets
  const [crossTabModal, setCrossTabModal] = useState<{
    item: { entry: FileEntry; from: "local" | "remote" };
    targetTab: TabSession;
    neverAskAgain: boolean;
  } | null>(null);

  const [tabPromptModal, setTabPromptModal] = useState<{
    pendingParams: {
      protocol: "SFTP" | "FTP";
      host: string;
      port: string;
      username: string;
      authType: "password" | "key";
      password?: string;
      keyPath?: string;
      passphrase?: string;
      siteId?: string;
      initialRemotePath?: string;
      initialLocalPath?: string;
    };
  } | null>(null);

  // Éditeur de texte intégré
  const [editorModal, setEditorModal] = useState<{
    path: string;
    filename: string;
    content: string;
    originalContent: string;
    saving: boolean;
  } | null>(null);
  const [editorSearchQuery, setEditorSearchQuery] = useState("");
  const [showEditorSearch, setShowEditorSearch] = useState(false);
  const [editorSearchMatches, setEditorSearchMatches] = useState<number[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const editorTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editorLineNumbersRef = useRef<HTMLDivElement>(null);

  // Sites
  const [showSiteManager, setShowSiteManager] = useState(false);
  const [sites, setSites] = useState<SiteProfile[]>(() => {
    const saved = localStorage.getItem("gens_rft_sites");
    return saved ? JSON.parse(saved) : [];
  });
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const [siteForm, setSiteForm] = useState<SiteProfile>({
    id: "",
    name: "Nouveau serveur",
    protocol: "SFTP",
    host: "",
    port: "22",
    authType: "password",
    username: "",
    password: "",
    keyPath: "",
    passphrase: "",
  });

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    entry: FileEntry;
    isRemote: boolean;
  } | null>(null);

  const hasLoadedInitialDir = useRef(false);

  const logMessage = (msg: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, `[${time}] ${msg}`]);
  };

  useEffect(() => {
    if (!editorModal || !editorSearchQuery) {
      setEditorSearchMatches([]);
      setCurrentMatchIndex(0);
      return;
    }
    const query = editorSearchQuery.toLowerCase();
    const content = editorModal.content.toLowerCase();
    const matches: number[] = [];
    let pos = content.indexOf(query);
    while (pos !== -1) {
      matches.push(pos);
      pos = content.indexOf(query, pos + 1);
    }
    setEditorSearchMatches(matches);
    setCurrentMatchIndex(matches.length > 0 ? 0 : -1);
  }, [editorSearchQuery, editorModal?.content]);

  useEffect(() => {
    if (activeBottomTab === "logs" && bottomOpen) {
      logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, activeBottomTab, bottomOpen]);

  useEffect(() => {
    const handleGlobalClick = (e: MouseEvent) => {
      if (bookmarksRef.current && !bookmarksRef.current.contains(e.target as Node)) {
        setShowBookmarksMenu(false);
      }
      if (e.button !== 2) {
        setContextMenu(null);
      }
    };
    window.addEventListener("mousedown", handleGlobalClick);
    return () => window.removeEventListener("mousedown", handleGlobalClick);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "t") {
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
  }, [tabs, activeTabId]);

  useEffect(() => {
    setRemotePathInput(activeTab.remotePath);
  }, [activeTab.remotePath]);

  useEffect(() => {
    setLocalPathInput(currentPath);
  }, [currentPath]);

  useEffect(() => {
    localStorage.setItem("gens_rft_bookmarks", JSON.stringify(bookmarks));
  }, [bookmarks]);

  useEffect(() => {
    localStorage.setItem("gens_rft_sites", JSON.stringify(sites));
  }, [sites]);

  useEffect(() => {
    localStorage.setItem("gens_rft_opt_remember_local", JSON.stringify(rememberLocalPath));
  }, [rememberLocalPath]);

  useEffect(() => {
    localStorage.setItem("gens_rft_opt_remember_remote", JSON.stringify(rememberRemotePath));
  }, [rememberRemotePath]);

  useEffect(() => {
    if (rememberLocalPath && currentPath) {
      localStorage.setItem("gens_rft_last_local_path", currentPath);
    }
  }, [currentPath, rememberLocalPath]);

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

  useEffect(() => {
    const unlisten = listen<TransferProgress>("transfer_progress", (event) => {
      const p = event.payload;
      const now = Date.now();

      setQueue((items) =>
        items.map((item) => {
          if (item.id !== p.transfer_id) return item;

          const deltaSec = (now - item.lastTimestamp) / 1000;
          let newSpeed = item.speed;
          let newEta = item.eta;

          if (deltaSec >= 0.25) {
            const deltaBytes = Math.max(0, p.transferred - item.lastBytes);
            const bytesPerSec = deltaBytes / deltaSec;

            if (bytesPerSec > 1024 * 1024) {
              newSpeed = `${(bytesPerSec / (1024 * 1024)).toFixed(1)} Mo/s`;
            } else if (bytesPerSec > 1024) {
              newSpeed = `${(bytesPerSec / 1024).toFixed(0)} Ko/s`;
            } else {
              newSpeed = `${bytesPerSec.toFixed(0)} o/s`;
            }

            const remainingBytes = p.total > p.transferred ? p.total - p.transferred : 0;
            if (bytesPerSec > 0 && remainingBytes > 0) {
              const secondsLeft = Math.ceil(remainingBytes / bytesPerSec);
              newEta = secondsLeft < 60 ? `${secondsLeft}s` : `${Math.floor(secondsLeft / 60)}m ${secondsLeft % 60}s`;
            } else if (p.percent >= 100) {
              newEta = "0s";
            }

            return {
              ...item,
              percent: p.percent,
              speed: newSpeed,
              eta: newEta,
              lastBytes: p.transferred,
              lastTimestamp: now,
            };
          }

          return { ...item, percent: p.percent };
        })
      );
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const concurrentLimit = parseInt(maxConcurrent) || 2;
  const runningCount = queue.filter((item) => item.status === "running").length;

  useEffect(() => {
    if (runningCount >= concurrentLimit) return;

    const nextItem = queue.find((item) => item.status === "queued");
    if (!nextItem) return;

    setQueue((items) =>
      items.map((it) => (it.id === nextItem.id ? { ...it, status: "running" } : it))
    );

    const executeTransfer = async () => {
      try {
        if (nextItem.direction === "upload") {
          logMessage(`STOR [${nextItem.filename}] -> ${nextItem.destDir}`);
          await invoke("upload_item", {
            sessionId: nextItem.sessionId,
            transferId: nextItem.id,
            localPath: nextItem.sourcePath,
            remoteDestDir: nextItem.destDir,
          });
          if (activeTab.id === nextItem.sessionId) {
            loadRemoteDirectory(activeTab.remotePath);
          }
        } else {
          logMessage(`RETR [${nextItem.filename}] -> ${nextItem.destDir}`);
          await invoke("download_item", {
            sessionId: nextItem.sessionId,
            transferId: nextItem.id,
            remotePath: nextItem.sourcePath,
            localDestDir: nextItem.destDir,
            isDir: nextItem.isDir,
          });
          loadLocalDirectory(currentPath);
        }

        setQueue((items) =>
          items.map((it) => (it.id === nextItem.id ? { ...it, status: "done", percent: 100 } : it))
        );
        logMessage(`226 Transfert terminé : ${nextItem.filename}`);
      } catch (err) {
        setQueue((items) =>
          items.map((it) => (it.id === nextItem.id ? { ...it, status: "error" } : it))
        );
        logMessage(`550 Échec de transfert (${nextItem.filename}) : ${err}`);
      }
    };

    executeTransfer();
  }, [queue, runningCount, activeTab.remotePath, currentPath, concurrentLimit, activeTab.id]);

  const loadLocalDirectory = async (targetPath?: string) => {
    try {
      logMessage(`CWD Local: ${targetPath || "dossier utilisateur"}`);
      const result = await invoke<FileEntry[]>("read_local_dir", { path: targetPath || null });
      setFiles(result);
      if (targetPath) {
        setCurrentPath(targetPath);
      } else if (result.length > 0 && !currentPath) {
        const parent = result[0].path.split(/[\\/]/).slice(0, -1).join("\\");
        setCurrentPath(parent || "C:\\");
      }
      logMessage(`250 ${result.length} élément(s) listé(s) en local.`);
    } catch (err) {
      logMessage(`550 Dossier local introuvable ou inaccessible (${targetPath}) : ${err}`);
      if (targetPath && targetPath !== "C:\\") {
        logMessage("Repli automatique sur la racine C:\\");
        loadLocalDirectory("C:\\");
      }
    }
  };

  const loadRemoteDirectory = async (targetPath?: string, targetSessionId?: string) => {
    const sId = targetSessionId || activeTab.id;
    const fallbackPath = "/";
    try {
      logMessage(`[${sId}] CWD Distant: ${targetPath || "/"}`);
      const result = await invoke<FileEntry[]>("list_remote_dir", {
        sessionId: sId,
        path: targetPath || null,
      });

      setTabs((prev) =>
        prev.map((t) =>
          t.id === sId
            ? { ...t, remoteFiles: result, remotePath: targetPath || "/" }
            : t
        )
      );
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

  const executeConnect = async (
    targetSessionId: string,
    protocol: "SFTP" | "FTP",
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
        port: parseInt(targetPort, 10) || (protocol === "FTP" ? 21 : 22),
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
    protocol: "SFTP" | "FTP",
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
    if (editingTabId && editingTabTitle.trim()) {
      setTabs((prev) =>
        prev.map((t) => (t.id === editingTabId ? { ...t, title: editingTabTitle.trim() } : t))
      );
    }
    setEditingTabId(null);
  };

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

  const checkAndEnqueueTransfer = (
    filename: string,
    sourcePath: string,
    destDir: string,
    direction: "upload" | "download",
    isDir: boolean,
    targetSessionId?: string
  ) => {
    const destSessionId = targetSessionId || activeTab.id;
    const destSession = tabs.find((t) => t.id === destSessionId);
    const targetFileList = direction === "upload" ? destSession?.remoteFiles || [] : files;
    const exists = targetFileList.some((f) => f.name.toLowerCase() === filename.toLowerCase());

    if (exists) {
      setConflictModal({
        filename,
        onResolve: (action) => {
          if (action === "skip") {
            logMessage(`Transfert de "${filename}" ignoré.`);
            setConflictModal(null);
            return;
          }

          let finalName = filename;
          if (action === "rename") {
            const extIdx = filename.lastIndexOf(".");
            finalName =
              extIdx > 0
                ? `${filename.substring(0, extIdx)} (copie)${filename.substring(extIdx)}`
                : `${filename} (copie)`;
          }

          addTransferToQueue(finalName, sourcePath, destDir, direction, isDir, destSessionId);
          setConflictModal(null);
        },
      });
    } else {
      addTransferToQueue(filename, sourcePath, destDir, direction, isDir, destSessionId);
    }
  };

  const addTransferToQueue = (
    filename: string,
    sourcePath: string,
    destDir: string,
    direction: "upload" | "download",
    isDir: boolean,
    targetSessionId?: string
  ) => {
    const newId = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    setQueue((prev) => [
      ...prev,
      {
        id: newId,
        sessionId: targetSessionId || activeTab.id,
        filename,
        sourcePath,
        destDir,
        destFileName: filename,
        direction,
        isDir,
        status: "queued",
        percent: 0,
        speed: "-- Mo/s",
        eta: "--",
        lastBytes: 0,
        lastTimestamp: Date.now(),
      },
    ]);

    setActiveBottomTab("queue");
    setBottomOpen(true);
  };

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

  return (
    <div
      className={`flex h-screen w-screen flex-col font-sans select-none antialiased ${
        isDark ? "bg-neutral-950 text-neutral-200" : "bg-neutral-100 text-neutral-900"
      }`}
    >
      {/* Barre d'outils supérieure */}
      <header
        className={`flex flex-wrap items-center justify-between border-b px-2 py-1.5 gap-2 transition-colors ${
          isDark ? "border-neutral-800 bg-neutral-900 text-neutral-100" : "border-neutral-300 bg-white text-neutral-800"
        }`}
      >
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => {
              setShowBookmarksMenu(false);
              setShowSettings(false);
              setShowSiteManager(true);
            }}
            className={`flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs cursor-pointer transition active:scale-95 ${
              isDark
                ? "border-neutral-700 bg-neutral-800 text-neutral-200 hover:bg-neutral-700 hover:text-white"
                : "border-neutral-300 bg-neutral-100 text-neutral-800 hover:bg-neutral-200"
            }`}
            title="Gestionnaire de sites (Vos serveurs)"
          >
            <SlidersHorizontal className="h-3.5 w-3.5 text-sky-500" />
            <span className="font-medium">Sites</span>
          </button>

          <button
            onClick={() => {
              logMessage("Actualisation des deux répertoires...");
              loadLocalDirectory(currentPath);
              if (activeTab.isConnected) loadRemoteDirectory(activeTab.remotePath);
            }}
            className={`flex items-center gap-1 px-2.5 py-1 rounded border cursor-pointer text-xs transition active:scale-95 ${
              isDark
                ? "border-neutral-700 bg-neutral-800 text-neutral-200 hover:text-white"
                : "border-neutral-300 bg-neutral-100 text-neutral-800 hover:bg-neutral-200"
            }`}
            title="Actualiser les deux panneaux"
          >
            <RefreshCw className="h-3.5 w-3.5 text-emerald-500" />
            <span>Actualiser</span>
          </button>

          <button
            onClick={() => {
              setShowBookmarksMenu(false);
              setShowSiteManager(false);
              setShowSettings(true);
            }}
            className={`flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs cursor-pointer transition active:scale-95 ${
              showSettings
                ? "border-sky-500 bg-sky-600 text-white"
                : isDark
                ? "border-neutral-700 bg-neutral-800 text-neutral-200 hover:bg-neutral-700 hover:text-white"
                : "border-neutral-300 bg-neutral-100 text-neutral-800 hover:bg-neutral-200"
            }`}
            title="Paramètres de l'application"
          >
            <Settings className="h-3.5 w-3.5 text-sky-400" />
            <span className="font-medium">Paramètres</span>
          </button>
        </div>

        {/* Connexion rapide */}
        <div
          className={`flex flex-1 max-w-xl items-center rounded-lg border p-0.5 shadow-inner transition-colors ${
            isDark ? "border-neutral-800 bg-neutral-950 text-neutral-200" : "border-neutral-300 bg-neutral-50 text-neutral-800"
          }`}
        >
          <input
            type="text"
            placeholder="Hôte"
            value={quickHost}
            onChange={(e) => setQuickHost(e.target.value)}
            className="bg-transparent px-2.5 py-1 text-xs placeholder-neutral-500 focus:outline-none flex-1 min-w-[90px] border-r border-neutral-700/50"
          />
          <input
            type="text"
            placeholder="Port"
            value={quickPort}
            onChange={(e) => setQuickPort(e.target.value)}
            className="bg-transparent px-1.5 py-1 text-xs placeholder-neutral-500 focus:outline-none w-12 text-center border-r border-neutral-700/50 shrink-0"
          />
          <input
            type="text"
            placeholder="Utilisateur"
            value={quickUser}
            onChange={(e) => setQuickUser(e.target.value)}
            className="bg-transparent px-2.5 py-1 text-xs placeholder-neutral-500 focus:outline-none flex-1 min-w-[80px] border-r border-neutral-700/50"
          />
          <input
            type="password"
            placeholder="Mot de passe"
            value={quickPass}
            onChange={(e) => setQuickPass(e.target.value)}
            className="bg-transparent px-2.5 py-1 text-xs placeholder-neutral-500 focus:outline-none flex-1 min-w-[80px]"
          />
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div className="hidden xl:flex items-center gap-2 text-[11px] font-medium text-neutral-400 mr-1">
            <span
              className={`h-2 w-2 rounded-full transition-all ${
                activeTab.isConnected ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]" : "bg-neutral-500"
              }`}
            />
            <span>{activeTab.isConnected ? "En ligne" : "Déconnecté"}</span>
          </div>

          {activeTab.isConnected ? (
            <button
              onClick={() => handleDisconnect(activeTab.id)}
              className="flex items-center gap-1.5 rounded bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white shadow hover:bg-rose-500 active:scale-95 cursor-pointer transition duration-150"
              title="Déconnecter la session courante"
            >
              <Unplug className="h-3.5 w-3.5" />
              <span>Déconnecter</span>
            </button>
          ) : (
            <button
              onClick={() =>
                handleConnectRequest(
                  "SFTP",
                  quickHost,
                  quickPort,
                  quickUser,
                  "password",
                  quickPass
                )
              }
              className="flex items-center gap-1.5 rounded bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white shadow hover:bg-sky-500 active:scale-95 cursor-pointer transition duration-150"
            >
              <Server className="h-3.5 w-3.5" />
              <span>Connecter</span>
            </button>
          )}
        </div>
      </header>

      {/* Barre d'onglets (Multi-sessions avec glisser-déposer inter-onglets) */}
      <div
        className={`flex items-center border-b px-2 gap-1 overflow-x-auto select-none ${
          isDark ? "border-neutral-800 bg-neutral-950 text-neutral-300" : "border-neutral-300 bg-neutral-200 text-neutral-800"
        }`}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const isEditing = editingTabId === tab.id;
          const isDropTarget = dragOverTabId === tab.id;

          return (
            <div
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              onDoubleClick={(e) => handleStartRenameTab(tab, e)}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (draggedItem && draggedItem.fromSessionId !== tab.id) {
                  setDragOverTabId(tab.id);
                }
              }}
              onDragLeave={() => setDragOverTabId(null)}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragOverTabId(null);
                if (draggedItem && tab.isConnected) {
                  if (skipCrossTabConfirm) {
                    checkAndEnqueueTransfer(
                      draggedItem.entry.name,
                      draggedItem.entry.path,
                      tab.remotePath,
                      "upload",
                      draggedItem.entry.is_dir,
                      tab.id
                    );
                  } else {
                    setCrossTabModal({
                      item: draggedItem,
                      targetTab: tab,
                      neverAskAgain: false,
                    });
                  }
                }
              }}
              className={`group flex items-center gap-2 px-3 py-1.5 text-xs font-medium cursor-pointer border-b-2 transition-all duration-150 ${
                isDropTarget
                  ? "border-sky-400 bg-sky-500/20 text-sky-300 ring-2 ring-sky-400 animate-pulse"
                  : isActive
                  ? isDark
                    ? "border-sky-500 bg-neutral-800/80 text-sky-400 font-semibold"
                    : "border-sky-600 bg-white text-sky-700 font-bold shadow-xs"
                  : isDark
                  ? "border-transparent text-neutral-400 hover:bg-neutral-800/40 hover:text-neutral-200"
                  : "border-transparent text-neutral-600 hover:bg-neutral-300/60 hover:text-neutral-900"
              }`}
              title="Double-cliquez pour renommer, ou déposez un fichier ici pour transférer vers ce serveur"
            >
              <span
                className={`h-1.5 w-1.5 rounded-full transition-colors ${
                  tab.isConnected ? "bg-emerald-400" : "bg-neutral-500"
                }`}
              />

              {isEditing ? (
                <input
                  type="text"
                  autoFocus
                  value={editingTabTitle}
                  onChange={(e) => setEditingTabTitle(e.target.value)}
                  onBlur={handleFinishRenameTab}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleFinishRenameTab();
                    if (e.key === "Escape") setEditingTabId(null);
                  }}
                  className="bg-neutral-900 border border-sky-500 rounded px-1.5 py-0.5 text-xs text-white focus:outline-none w-28"
                />
              ) : (
                <span className="truncate max-w-[140px]">{tab.title}</span>
              )}

              {tabs.length > 1 && (
                <button
                  onClick={(e) => closeTab(tab.id, e)}
                  className="rounded p-0.5 hover:bg-neutral-500/30 text-neutral-500 hover:text-rose-400 opacity-60 group-hover:opacity-100 transition"
                  title="Fermer l'onglet (Ctrl+W)"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        })}

        <button
          onClick={createNewTab}
          className="p-1.5 rounded hover:bg-neutral-800 text-neutral-400 hover:text-white cursor-pointer ml-1 transition"
          title="Nouvel onglet (Ctrl+T)"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Main Split-Pane avec redimensionnement horizontal */}
      <div className="flex flex-1 overflow-hidden relative select-none">
        {/* Panneau Local */}
        <section
          style={{ width: `${localPaneWidth}%` }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "copy";
            if (draggedItem?.from === "remote") setIsOverLocal(true);
          }}
          onDragEnter={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (draggedItem?.from === "remote") setIsOverLocal(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsOverLocal(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsOverLocal(false);
            if (draggedItem && draggedItem.from === "remote") {
              checkAndEnqueueTransfer(
                draggedItem.entry.name,
                draggedItem.entry.path,
                currentPath,
                "download",
                draggedItem.entry.is_dir
              );
              setDraggedItem(null);
            }
          }}
          className={`flex flex-col border-r relative transition ${
            isDark ? "border-neutral-800 bg-neutral-950 text-neutral-200" : "border-neutral-300 bg-white text-neutral-900"
          } ${isOverLocal ? "outline outline-2 outline-emerald-500 bg-emerald-500/10" : ""}`}
        >
          {/* En-tête Local */}
          <div
            className={`flex items-center justify-between border-b px-3 py-1.5 gap-2 ${
              isDark ? "border-neutral-800 bg-neutral-900 text-neutral-200" : "border-neutral-300 bg-neutral-100 text-neutral-800"
            }`}
          >
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <HardDrive className="h-4 w-4 text-emerald-500 shrink-0" />

              {/* Sélecteur de volume */}
              {drives.length > 0 && (
                <select
                  value={
                    drives.find((d) => currentPath.toUpperCase().startsWith(d.toUpperCase())) || drives[0]
                  }
                  onChange={(e) => loadLocalDirectory(e.target.value)}
                  className={`rounded border px-1.5 py-0.5 text-[11px] font-mono focus:outline-none cursor-pointer shrink-0 transition ${
                    isDark
                      ? "bg-neutral-950 border-neutral-700 text-sky-400 font-semibold"
                      : "bg-white border-neutral-300 text-sky-700 font-semibold"
                  }`}
                  title="Changer de volume / partition"
                >
                  {drives.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              )}

              {/* Raccourcis compacts */}
              <div className="hidden sm:flex items-center gap-1 border-l border-neutral-700/50 pl-1.5 shrink-0">
                {sysFolders.desktop && (
                  <button
                    onClick={() => loadLocalDirectory(sysFolders.desktop)}
                    className="p-1 rounded border border-neutral-700/60 hover:bg-neutral-800 text-neutral-400 hover:text-sky-400 cursor-pointer transition active:scale-95"
                    title={`Bureau (${sysFolders.desktop})`}
                  >
                    <Monitor className="h-3.5 w-3.5" />
                  </button>
                )}
                {sysFolders.downloads && (
                  <button
                    onClick={() => loadLocalDirectory(sysFolders.downloads)}
                    className="p-1 rounded border border-neutral-700/60 hover:bg-neutral-800 text-neutral-400 hover:text-emerald-400 cursor-pointer transition active:scale-95"
                    title={`Téléchargements (${sysFolders.downloads})`}
                  >
                    <FolderDown className="h-3.5 w-3.5" />
                  </button>
                )}
                {sysFolders.documents && (
                  <button
                    onClick={() => loadLocalDirectory(sysFolders.documents)}
                    className="p-1 rounded border border-neutral-700/60 hover:bg-neutral-800 text-neutral-400 hover:text-amber-400 cursor-pointer transition active:scale-95"
                    title={`Documents (${sysFolders.documents})`}
                  >
                    <FileSpreadsheet className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {/* Barre de chemin Windows éditable */}
              {isEditingLocalPath ? (
                <input
                  type="text"
                  autoFocus
                  value={localPathInput}
                  onChange={(e) => setLocalPathInput(e.target.value)}
                  onBlur={() => {
                    setIsEditingLocalPath(false);
                    setLocalPathInput(currentPath);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      setIsEditingLocalPath(false);
                      if (localPathInput.trim()) {
                        loadLocalDirectory(localPathInput.trim());
                      }
                    } else if (e.key === "Escape") {
                      setIsEditingLocalPath(false);
                      setLocalPathInput(currentPath);
                    }
                  }}
                  className={`flex-1 rounded border px-2 py-0.5 text-xs font-mono focus:outline-none transition ${
                    isDark ? "bg-neutral-950 border-emerald-500 text-emerald-300" : "bg-white border-emerald-500 text-emerald-700 font-semibold"
                  }`}
                  placeholder="C:\Dossier"
                />
              ) : (
                <div
                  onClick={() => {
                    setLocalPathInput(currentPath);
                    setIsEditingLocalPath(true);
                  }}
                  className={`flex items-center gap-1.5 px-2 py-0.5 rounded cursor-pointer border border-transparent hover:border-neutral-700/60 transition truncate flex-1 min-w-0 ${
                    isDark ? "hover:bg-neutral-800/60" : "hover:bg-neutral-200"
                  }`}
                  title="Cliquer pour taper un chemin local au clavier"
                >
                  <span className={`text-xs font-semibold font-mono truncate ${isDark ? "text-neutral-200" : "text-neutral-900"}`}>
                    {currentPath}
                  </span>
                  <Edit2 className="h-3 w-3 text-neutral-500 opacity-60 shrink-0" />
                </div>
              )}
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <div className="relative">
                <Search className="h-3 w-3 absolute left-2 top-2 text-neutral-500" />
                <input
                  type="text"
                  placeholder="Filtrer..."
                  value={localSearch}
                  onChange={(e) => setLocalSearch(e.target.value)}
                  className={`h-6 w-20 sm:w-28 rounded border pl-7 pr-2 text-[11px] focus:outline-none transition ${
                    isDark ? "bg-neutral-950 border-neutral-800 text-neutral-100" : "bg-white border-neutral-300 text-neutral-900"
                  }`}
                />
              </div>
              <button
                onClick={() => {
                  const sep = currentPath.includes("/") ? "/" : "\\";
                  const parts = currentPath.split(sep).filter(Boolean);
                  parts.pop();
                  loadLocalDirectory(parts.join(sep) || (drives[0] || "C:\\"));
                }}
                className="rounded p-1 hover:bg-neutral-500/20 cursor-pointer transition active:scale-95"
                title="Dossier parent"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Arborescence en arbre Local */}
          {showTreePanels && (
            <>
              <div
                style={{ height: `${treeHeight}px` }}
                className={`border-b overflow-y-auto ${
                  isDark ? "border-neutral-800/80 bg-neutral-950/70" : "border-neutral-200 bg-neutral-50"
                }`}
              >
                <DirectoryTree
                  isDark={isDark}
                  isRemote={false}
                  currentPath={currentPath || (drives[0] || "C:\\")}
                  subFolders={files.filter((f) => f.is_dir && (showHidden ? true : !f.name.startsWith("."))).map((f) => f.name)}
                  onNavigate={loadLocalDirectory}
                />
              </div>

              <div
                onMouseDown={(e) => {
                  const startY = e.clientY;
                  const startH = treeHeight;
                  const onMouseMove = (ev: MouseEvent) => {
                    setTreeHeight(Math.max(60, Math.min(300, startH + (ev.clientY - startY))));
                  };
                  const onMouseUp = () => {
                    window.removeEventListener("mousemove", onMouseMove);
                    window.removeEventListener("mouseup", onMouseUp);
                  };
                  window.addEventListener("mousemove", onMouseMove);
                  window.addEventListener("mouseup", onMouseUp);
                }}
                className="h-1 bg-neutral-800 hover:bg-sky-500 cursor-row-resize transition"
                title="Glisser pour redimensionner l'arbre"
              />
            </>
          )}

          {/* Colonnes Local */}
          <div
            className={`grid grid-cols-12 border-b px-3 py-1 text-[11px] font-semibold uppercase tracking-wider ${
              isDark ? "border-neutral-800 bg-neutral-900/90 text-neutral-400" : "border-neutral-300 bg-neutral-200 text-neutral-700 font-bold"
            }`}
          >
            <button
              onClick={() =>
                setLocalSort({
                  field: "name",
                  order: localSort.field === "name" && localSort.order === "asc" ? "desc" : "asc",
                })
              }
              className="col-span-8 flex items-center gap-1 text-left hover:text-neutral-300 cursor-pointer"
            >
              <span>Nom de fichier</span>
              {localSort.field === "name" && <ArrowUpDown className="h-2.5 w-2.5 text-sky-500" />}
            </button>
            <button
              onClick={() =>
                setLocalSort({
                  field: "size",
                  order: localSort.field === "size" && localSort.order === "asc" ? "desc" : "asc",
                })
              }
              className="col-span-3 flex items-center justify-end gap-1 text-right hover:text-neutral-300 cursor-pointer"
            >
              <span>Taille</span>
              {localSort.field === "size" && <ArrowUpDown className="h-2.5 w-2.5 text-sky-500" />}
            </button>
            <span className="col-span-1 text-center">Action</span>
          </div>

          {/* Liste des fichiers locaux */}
          <div className="flex-1 overflow-y-auto font-mono text-xs divide-y divide-neutral-500/10">
            {processedLocalFiles.map((item, index) => {
              const badge = getFileBadge(item.name, isDark);
              return (
                <div
                  key={index}
                  draggable
                  onDragStart={(e) => {
                    setDraggedItem({ entry: item, from: "local" });
                    e.dataTransfer.setData("text/plain", item.path);
                    e.dataTransfer.effectAllowed = "copyMove";
                  }}
                  onDragEnd={() => {
                    setDraggedItem(null);
                    setIsOverRemote(false);
                    setIsOverLocal(false);
                    setDragOverTabId(null);
                  }}
                  onDoubleClick={() => {
                    if (item.is_dir) {
                      loadLocalDirectory(item.path);
                    } else {
                      if (!activeTab.isConnected) {
                        logMessage("Info : Connectez-vous d'abord à un serveur distant pour transférer.");
                        return;
                      }
                      checkAndEnqueueTransfer(item.name, item.path, activeTab.remotePath, "upload", false);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setContextMenu({ x: e.clientX, y: e.clientY, entry: item, isRemote: false });
                  }}
                  className="grid grid-cols-12 items-center px-3 py-1.5 hover:bg-sky-500/10 cursor-pointer group transition duration-100"
                >
                  <div className="col-span-8 flex items-center gap-2 truncate pr-2">
                    {item.is_dir ? (
                      <Folder className="h-4 w-4 text-amber-500 shrink-0" />
                    ) : (
                      badge.icon
                    )}
                    <span className={`truncate ${item.is_dir ? (isDark ? "text-neutral-200" : "text-neutral-900 font-semibold") : badge.color}`}>
                      {item.name}
                    </span>
                  </div>

                  <div className="col-span-3 text-right text-[11px] text-neutral-500 font-sans">
                    {!item.is_dir ? `${(item.size / 1024).toFixed(1)} Ko` : "--"}
                  </div>

                  <div className="col-span-1 flex justify-center">
                    {activeTab.isConnected && !item.is_dir && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          checkAndEnqueueTransfer(item.name, item.path, activeTab.remotePath, "upload", false);
                        }}
                        className="opacity-0 group-hover:opacity-100 rounded p-1 text-neutral-400 hover:text-sky-500 cursor-pointer transition active:scale-95"
                        title="Envoyer vers le serveur"
                      >
                        <Upload className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Splitter vertical entre le panneau local et le panneau distant */}
        <div
          onMouseDown={(e) => {
            const container = e.currentTarget.parentElement;
            if (!container) return;
            const containerRect = container.getBoundingClientRect();
            const onMouseMove = (ev: MouseEvent) => {
              const relX = ev.clientX - containerRect.left;
              const newPercent = Math.max(20, Math.min(80, (relX / containerRect.width) * 100));
              setLocalPaneWidth(newPercent);
            };
            const onMouseUp = () => {
              window.removeEventListener("mousemove", onMouseMove);
              window.removeEventListener("mouseup", onMouseUp);
            };
            window.addEventListener("mousemove", onMouseMove);
            window.addEventListener("mouseup", onMouseUp);
          }}
          className="w-1.5 bg-neutral-800 hover:bg-sky-500 cursor-col-resize transition-colors duration-150 z-10 shrink-0"
          title="Glisser pour ajuster la largeur local / distant"
        />

        {/* Panneau Distant */}
        <section
          style={{ width: `${100 - localPaneWidth}%` }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "copy";
            if (draggedItem?.from === "local" || !draggedItem) setIsOverRemote(true);
          }}
          onDragEnter={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (draggedItem?.from === "local" || !draggedItem) setIsOverRemote(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsOverRemote(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsOverRemote(false);
            if (draggedItem && draggedItem.from === "local") {
              if (!activeTab.isConnected) {
                logMessage("Erreur : Impossible d'envoyer, serveur déconnecté.");
                setDraggedItem(null);
                return;
              }
              checkAndEnqueueTransfer(
                draggedItem.entry.name,
                draggedItem.entry.path,
                activeTab.remotePath,
                "upload",
                draggedItem.entry.is_dir
              );
              setDraggedItem(null);
            }
          }}
          className={`flex flex-col relative transition ${
            isDark ? "bg-neutral-950 text-neutral-200" : "bg-white text-neutral-900"
          } ${isOverRemote ? "outline outline-2 outline-sky-500 bg-sky-500/10" : ""}`}
        >
          {/* En-tête Distant */}
          <div
            className={`flex items-center justify-between border-b px-3 py-1.5 gap-2 ${
              isDark ? "border-neutral-800 bg-neutral-900 text-neutral-200" : "border-neutral-300 bg-neutral-100 text-neutral-800"
            }`}
          >
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              <Server className="h-4 w-4 text-sky-500 shrink-0" />

              {/* Menu Favoris */}
              <div className="relative shrink-0" ref={bookmarksRef}>
                <button
                  onClick={() => setShowBookmarksMenu(!showBookmarksMenu)}
                  className={`p-1 rounded hover:bg-neutral-500/20 cursor-pointer transition active:scale-95 ${
                    bookmarks.includes(activeTab.remotePath) ? "text-amber-400" : "text-neutral-400 hover:text-amber-400"
                  }`}
                  title="Favoris / Dossiers rapides"
                >
                  <Star className="h-3.5 w-3.5 fill-current" />
                </button>

                {showBookmarksMenu && (
                  <div
                    className={`absolute left-0 mt-1 w-64 rounded-lg border py-1 shadow-2xl z-50 text-xs animate-in fade-in zoom-in-95 duration-150 backdrop-blur-md ${
                      isDark ? "bg-neutral-900/95 border-neutral-700 text-neutral-200" : "bg-white/95 border-neutral-300 text-neutral-800"
                    }`}
                  >
                    <div className="flex items-center justify-between px-3 py-1 border-b border-neutral-700/50 font-semibold text-[11px] text-neutral-400">
                      <span>Dossiers favoris</span>
                      {activeTab.isConnected && (
                        <button
                          onClick={() => {
                            if (!bookmarks.includes(activeTab.remotePath)) {
                              setBookmarks([...bookmarks, activeTab.remotePath]);
                            }
                            setShowBookmarksMenu(false);
                          }}
                          className="text-sky-400 hover:text-sky-300 cursor-pointer transition"
                        >
                          + Ajouter actif
                        </button>
                      )}
                    </div>
                    <div className="max-h-48 overflow-y-auto">
                      {bookmarks.length === 0 ? (
                        <div className="px-3 py-2 text-neutral-500 text-[11px]">Aucun favori enregistré</div>
                      ) : (
                        bookmarks.map((bPath) => (
                          <div
                            key={bPath}
                            className="flex items-center justify-between px-3 py-1.5 hover:bg-neutral-500/15 cursor-pointer transition"
                            onClick={() => {
                              if (activeTab.isConnected) loadRemoteDirectory(bPath);
                              setShowBookmarksMenu(false);
                            }}
                          >
                            <span className="truncate font-mono text-[11px] text-sky-400">{bPath}</span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setBookmarks(bookmarks.filter((b) => b !== bPath));
                              }}
                              className="text-neutral-500 hover:text-rose-400 p-0.5 ml-2 cursor-pointer transition"
                              title="Retirer des favoris"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Barre de chemin distant éditable */}
              {isEditingRemotePath ? (
                <input
                  type="text"
                  autoFocus
                  value={remotePathInput}
                  onChange={(e) => setRemotePathInput(e.target.value)}
                  onBlur={() => {
                    setIsEditingRemotePath(false);
                    setRemotePathInput(activeTab.remotePath);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      setIsEditingRemotePath(false);
                      if (activeTab.isConnected && remotePathInput.trim()) {
                        loadRemoteDirectory(remotePathInput.trim());
                      }
                    } else if (e.key === "Escape") {
                      setIsEditingRemotePath(false);
                      setRemotePathInput(activeTab.remotePath);
                    }
                  }}
                  className={`flex-1 rounded border px-2 py-0.5 text-xs font-mono focus:outline-none transition ${
                    isDark ? "bg-neutral-950 border-sky-500 text-sky-300" : "bg-white border-sky-500 text-sky-700 font-semibold"
                  }`}
                  placeholder="/chemin/distant"
                />
              ) : (
                <div
                  onClick={() => {
                    if (activeTab.isConnected) {
                      setRemotePathInput(activeTab.remotePath);
                      setIsEditingRemotePath(true);
                    }
                  }}
                  className={`flex items-center gap-1.5 px-2 py-0.5 rounded cursor-pointer border border-transparent hover:border-neutral-700/60 transition truncate flex-1 min-w-0 ${
                    isDark ? "hover:bg-neutral-800/60" : "hover:bg-neutral-200"
                  }`}
                  title="Cliquer pour taper un chemin distant au clavier"
                >
                  <span className={`text-xs font-semibold font-mono truncate ${isDark ? "text-neutral-200" : "text-neutral-900"}`}>
                    {activeTab.remotePath}
                  </span>
                  <Edit2 className="h-3 w-3 text-neutral-500 opacity-60 shrink-0" />
                </div>
              )}
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <div className="relative">
                <Search className="h-3 w-3 absolute left-2 top-2 text-neutral-500" />
                <input
                  type="text"
                  placeholder="Filtrer..."
                  value={remoteSearch}
                  onChange={(e) => setRemoteSearch(e.target.value)}
                  className={`h-6 w-24 sm:w-28 rounded border pl-7 pr-2 text-[11px] focus:outline-none transition ${
                    isDark ? "bg-neutral-950 border-neutral-800 text-neutral-100" : "bg-white border-neutral-300 text-neutral-900"
                  }`}
                />
              </div>
              {activeTab.isConnected && (
                <>
                  <button
                    onClick={() => {
                      const parts = activeTab.remotePath.split("/").filter(Boolean);
                      parts.pop();
                      loadRemoteDirectory("/" + parts.join("/"));
                    }}
                    className="rounded p-1 hover:bg-neutral-500/20 cursor-pointer transition active:scale-95"
                    title="Dossier parent"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => {
                      setInputModal({
                        title: "Nouveau dossier distant",
                        label: "Nom du dossier :",
                        value: "nouveau_dossier",
                        onConfirm: async (val) => {
                          const sep = activeTab.remotePath.endsWith("/") ? "" : "/";
                          await invoke("create_remote_dir", {
                            sessionId: activeTab.id,
                            path: `${activeTab.remotePath}${sep}${val}`,
                          });
                          logMessage(`MKD ${activeTab.remotePath}${sep}${val}`);
                          loadRemoteDirectory(activeTab.remotePath);
                        },
                      });
                    }}
                    className="rounded p-1 hover:bg-neutral-500/20 cursor-pointer transition active:scale-95"
                    title="Nouveau dossier distant"
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Arborescence en arbre Distante */}
          {showTreePanels && (
            <>
              <div
                style={{ height: `${treeHeight}px` }}
                className={`border-b overflow-y-auto ${
                  isDark ? "border-neutral-800/80 bg-neutral-950/70" : "border-neutral-200 bg-neutral-50"
                }`}
              >
                {activeTab.isConnected ? (
                  <DirectoryTree
                    sessionId={activeTab.id}
                    isDark={isDark}
                    isRemote={true}
                    currentPath={activeTab.remotePath}
                    subFolders={activeTab.remoteFiles.filter((f) => f.is_dir && (showHidden ? true : !f.name.startsWith("."))).map((f) => f.name)}
                    onNavigate={loadRemoteDirectory}
                  />
                ) : (
                  <div className="p-3 text-neutral-500 text-xs">Serveur déconnecté</div>
                )}
              </div>

              <div
                onMouseDown={(e) => {
                  const startY = e.clientY;
                  const startH = treeHeight;
                  const onMouseMove = (ev: MouseEvent) => {
                    setTreeHeight(Math.max(60, Math.min(300, startH + (ev.clientY - startY))));
                  };
                  const onMouseUp = () => {
                    window.removeEventListener("mousemove", onMouseMove);
                    window.removeEventListener("mouseup", onMouseUp);
                  };
                  window.addEventListener("mousemove", onMouseMove);
                  window.addEventListener("mouseup", onMouseUp);
                }}
                className="h-1 bg-neutral-800 hover:bg-sky-500 cursor-row-resize transition"
                title="Glisser pour redimensionner l'arbre"
              />
            </>
          )}

          {/* Colonnes Distant */}
          <div
            className={`grid grid-cols-12 border-b px-3 py-1 text-[11px] font-semibold uppercase tracking-wider ${
              isDark ? "border-neutral-800 bg-neutral-900/90 text-neutral-400" : "border-neutral-300 bg-neutral-200 text-neutral-700 font-bold"
            }`}
          >
            <button
              onClick={() =>
                setRemoteSort({
                  field: "name",
                  order: remoteSort.field === "name" && remoteSort.order === "asc" ? "desc" : "asc",
                })
              }
              className="col-span-6 flex items-center gap-1 text-left hover:text-neutral-300 cursor-pointer"
            >
              <span>Nom de fichier</span>
              {remoteSort.field === "name" && <ArrowUpDown className="h-2.5 w-2.5 text-sky-500" />}
            </button>
            <span className="col-span-2 text-center hidden sm:inline">Droits</span>
            <button
              onClick={() =>
                setRemoteSort({
                  field: "size",
                  order: remoteSort.field === "size" && remoteSort.order === "asc" ? "desc" : "asc",
                })
              }
              className="col-span-5 sm:col-span-3 flex items-center justify-end gap-1 text-right hover:text-neutral-300 cursor-pointer"
            >
              <span>Taille</span>
              {remoteSort.field === "size" && <ArrowUpDown className="h-2.5 w-2.5 text-sky-500" />}
            </button>
            <span className="col-span-1 text-center">Action</span>
          </div>

          {/* Liste des fichiers distants */}
          <div className="flex-1 overflow-y-auto font-mono text-xs divide-y divide-neutral-500/10">
            {!activeTab.isConnected ? (
              <div className="flex h-full flex-col items-center justify-center text-xs text-neutral-500 gap-2 font-sans">
                <Server className="h-8 w-8 text-neutral-500" />
                <span>Absence de connexion à un serveur</span>
              </div>
            ) : (
              processedRemoteFiles.map((item, index) => {
                const badge = getFileBadge(item.name, isDark);
                return (
                  <div
                    key={index}
                    draggable
                    onDragStart={(e) => {
                      setDraggedItem({ entry: item, from: "remote", fromSessionId: activeTab.id });
                      e.dataTransfer.setData("text/plain", item.path);
                      e.dataTransfer.effectAllowed = "copyMove";
                    }}
                    onDragEnd={() => {
                      setDraggedItem(null);
                      setIsOverRemote(false);
                      setIsOverLocal(false);
                      setDragOverTabId(null);
                    }}
                    onDoubleClick={() => {
                      if (item.is_dir) {
                        loadRemoteDirectory(item.path);
                      } else {
                        checkAndEnqueueTransfer(item.name, item.path, currentPath, "download", false);
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setContextMenu({ x: e.clientX, y: e.clientY, entry: item, isRemote: true });
                    }}
                    className="grid grid-cols-12 items-center px-3 py-1.5 hover:bg-sky-500/10 cursor-pointer group transition duration-100"
                  >
                    <div className="col-span-6 flex items-center gap-2 truncate pr-2">
                      {item.is_dir ? (
                        <Folder className="h-4 w-4 text-sky-500 shrink-0" />
                      ) : (
                        badge.icon
                      )}
                      <span className={`truncate ${item.is_dir ? (isDark ? "text-neutral-200" : "text-neutral-900 font-semibold") : badge.color}`}>
                        {item.name}
                      </span>
                    </div>

                    <div className="col-span-2 text-center text-[10px] text-neutral-500 font-mono hidden sm:inline">
                      {item.permissions ? `0${(item.permissions & 0o777).toString(8)}` : "--"}
                    </div>

                    <div className="col-span-5 sm:col-span-3 text-right text-[11px] text-neutral-500 font-sans">
                      {!item.is_dir ? `${(item.size / 1024).toFixed(1)} Ko` : "--"}
                    </div>

                    <div className="col-span-1 flex justify-center gap-1">
                      {!item.is_dir && (
                        <>
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              logMessage(`Téléchargement temporaire et ouverture de "${item.name}"...`);
                              try {
                                const tempPath = await invoke<string>("open_remote_with_system", {
                                  sessionId: activeTab.id,
                                  remotePath: item.path,
                                });
                                logMessage(`Fichier ouvert : ${tempPath}`);
                              } catch (err) {
                                logMessage(`Erreur d'ouverture : ${err}`);
                              }
                            }}
                            className="opacity-0 group-hover:opacity-100 rounded p-1 text-neutral-400 hover:text-amber-500 cursor-pointer transition active:scale-95"
                            title="Ouvrir avec Windows"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </button>

                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              checkAndEnqueueTransfer(item.name, item.path, currentPath, "download", false);
                            }}
                            className="opacity-0 group-hover:opacity-100 rounded p-1 text-neutral-400 hover:text-emerald-500 cursor-pointer transition active:scale-95"
                            title="Télécharger"
                          >
                            <Download className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>
      </div>

      {/* Splitter console du bas */}
      <div
        onMouseDown={(e) => {
          const startY = e.clientY;
          const startH = bottomHeight;
          const onMouseMove = (ev: MouseEvent) => {
            setBottomHeight(Math.max(100, Math.min(500, startH - (ev.clientY - startY))));
          };
          const onMouseUp = () => {
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", onMouseUp);
          };
          window.addEventListener("mousemove", onMouseMove);
          window.addEventListener("mouseup", onMouseUp);
        }}
        className="h-1 bg-neutral-800 hover:bg-sky-500 cursor-row-resize transition"
        title="Glisser pour redimensionner la console inférieure"
      />

      {/* Console inférieure */}
      <footer
        style={{ height: bottomOpen ? `${bottomHeight}px` : "32px" }}
        className={`border-t flex flex-col transition-all duration-150 ${
          isDark ? "border-neutral-800 bg-neutral-900 text-neutral-200" : "border-neutral-300 bg-neutral-100 text-neutral-800"
        }`}
      >
        <div
          className={`flex items-center justify-between border-b px-4 h-8 text-xs font-semibold select-none ${
            isDark ? "border-neutral-800 bg-neutral-950 text-neutral-200" : "border-neutral-300 bg-neutral-200 text-neutral-800"
          }`}
        >
          <div className="flex gap-4">
            <button
              onClick={() => {
                setActiveBottomTab("queue");
                setBottomOpen(true);
              }}
              className={`flex items-center gap-1.5 py-1 cursor-pointer transition ${
                activeBottomTab === "queue" && bottomOpen ? "text-sky-500 font-bold" : "text-neutral-500 hover:text-neutral-300"
              }`}
            >
              <ListOrdered className="h-3.5 w-3.5" />
              <span>Fichiers en file d'attente ({queue.filter((q) => q.status === "queued" || q.status === "running").length})</span>
            </button>
            <button
              onClick={() => {
                setActiveBottomTab("logs");
                setBottomOpen(true);
              }}
              className={`flex items-center gap-1.5 py-1 cursor-pointer transition ${
                activeBottomTab === "logs" && bottomOpen ? "text-sky-500 font-bold" : "text-neutral-500 hover:text-neutral-300"
              }`}
            >
              <TerminalIcon className="h-3.5 w-3.5" />
              <span>Journal de commandes</span>
            </button>
            {enableSshTerminal && (
              <button
                onClick={() => {
                  setActiveBottomTab("terminal");
                  setBottomOpen(true);
                }}
                className={`flex items-center gap-1.5 py-1 cursor-pointer transition ${
                  activeBottomTab === "terminal" && bottomOpen ? "text-sky-500 font-bold" : "text-neutral-500 hover:text-neutral-300"
                }`}
              >
                <TerminalIcon className="h-3.5 w-3.5 text-emerald-500" />
                <span>Terminal SSH ({activeTab.title})</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {activeBottomTab === "queue" && (
              <>
                <button
                  onClick={() => {
                    setQueue((items) => items.filter((it) => it.status === "running" || it.status === "queued"));
                    logMessage("Opération : Historique des transferts nettoyé.");
                  }}
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-normal text-neutral-400 hover:text-neutral-200 cursor-pointer transition active:scale-95"
                  title="Vider les transferts terminés"
                >
                  <RotateCcw className="h-3 w-3" />
                  <span>Vider terminé</span>
                </button>
                <button
                  onClick={async () => {
                    await invoke("cancel_current_transfer");
                    setQueue((items) =>
                      items.map((it) =>
                        it.status === "queued" || it.status === "running"
                          ? { ...it, status: "error", speed: "Annulé" }
                          : it
                      )
                    );
                    logMessage("Opération : Tous les transferts ont été annulés.");
                  }}
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-normal text-rose-500 hover:text-rose-400 cursor-pointer transition active:scale-95"
                  title="Annuler tous les transferts"
                >
                  <Ban className="h-3 w-3" />
                  <span>Tout annuler</span>
                </button>
              </>
            )}

            <button
              onClick={() => setBottomOpen(!bottomOpen)}
              className="p-1 text-neutral-400 hover:text-neutral-200 cursor-pointer ml-2 transition"
              title={bottomOpen ? "Réduire" : "Agrandir"}
            >
              {bottomOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

        {bottomOpen && (
          <div className="flex-1 flex flex-col overflow-hidden relative">
            {enableSshTerminal && (
              <div className={`h-full w-full ${activeBottomTab === "terminal" ? "block" : "hidden"}`}>
                <SshTerminal sessionId={activeTab.id} isConnected={activeTab.isConnected} />
              </div>
            )}

            {activeBottomTab === "logs" && (
              <div className="flex-1 overflow-y-auto p-2.5 font-mono text-[11px] space-y-1">
                {logs.map((log, idx) => (
                  <div key={idx} className="flex gap-2">
                    <span className="text-neutral-500">&gt;</span>
                    <span>{log}</span>
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>
            )}

            {activeBottomTab === "queue" && (
              <div className="flex-1 overflow-y-auto p-2.5 font-mono text-[11px] space-y-1">
                {queue.length === 0 ? (
                  <div className="text-neutral-500 flex h-full items-center justify-center font-sans text-xs">
                    File d'attente : vide
                  </div>
                ) : (
                  queue.map((item) => (
                    <div key={item.id} className="flex items-center justify-between border-b border-neutral-500/10 py-1.5 px-2">
                      <div className="flex items-center gap-2 truncate max-w-md">
                        {item.status === "running" && <Clock className="h-3.5 w-3.5 text-sky-500 animate-spin shrink-0" />}
                        {item.status === "queued" && <Clock className="h-3.5 w-3.5 text-neutral-500 shrink-0" />}
                        {item.status === "done" && <CheckCircle className="h-3.5 w-3.5 text-emerald-500 shrink-0" />}
                        {item.status === "error" && <Ban className="h-3.5 w-3.5 text-rose-500 shrink-0" />}
                        <span className="truncate">{item.filename}</span>
                        <span className="text-neutral-500 shrink-0">({item.direction})</span>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        {item.status === "running" && (
                          <>
                            <span className="text-emerald-500 font-semibold">{item.speed}</span>
                            <span className="text-neutral-400">ETA: {item.eta}</span>
                            <span className="text-sky-500">{item.percent.toFixed(0)}%</span>
                            <button
                              onClick={async () => {
                                await invoke("cancel_current_transfer");
                                setQueue((items) =>
                                  items.map((it) => (it.id === item.id ? { ...it, status: "error", speed: "Annulé" } : it))
                                );
                              }}
                              className="px-2 py-0.5 rounded bg-rose-600/80 hover:bg-rose-500 text-[10px] text-white cursor-pointer transition active:scale-95"
                            >
                              Annuler
                            </button>
                          </>
                        )}
                        {item.status === "queued" && <span className="text-neutral-500">En attente...</span>}
                        {item.status === "done" && <span className="text-emerald-400">Terminé</span>}
                        {item.status === "error" && <span className="text-rose-400">Erreur / Annulé</span>}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </footer>

      {/* Menu contextuel Clic Droit */}
      {contextMenu && (
        <div
          style={{ top: `${Math.min(window.innerHeight - 220, contextMenu.y)}px`, left: `${Math.min(window.innerWidth - 220, contextMenu.x)}px` }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className={`fixed z-[100] min-w-52 rounded-lg border py-1 shadow-2xl text-xs backdrop-blur-md animate-in fade-in zoom-in-95 duration-100 ${
            isDark ? "border-neutral-800 bg-neutral-900/95 text-neutral-200" : "border-neutral-300 bg-white/95 text-neutral-800"
          }`}
        >
          {contextMenu.isRemote ? (
            <>
              {!contextMenu.entry.is_dir && (
                <>
                  {isEditableTextFile(contextMenu.entry.name) && (
                    <button
                      onClick={async () => {
                        const entry = contextMenu.entry;
                        setContextMenu(null);
                        logMessage(`Lecture de "${entry.name}" pour édition...`);
                        try {
                          const text = await invoke<string>("read_remote_file_text", {
                            sessionId: activeTab.id,
                            remotePath: entry.path,
                          });
                          setEditorModal({
                            path: entry.path,
                            filename: entry.name,
                            content: text,
                            originalContent: text,
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
                      const entry = contextMenu.entry;
                      setContextMenu(null);
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
              <button
                onClick={() => {
                  checkAndEnqueueTransfer(contextMenu.entry.name, contextMenu.entry.path, currentPath, "download", contextMenu.entry.is_dir);
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-sky-500/20 cursor-pointer"
              >
                <Download className="h-3.5 w-3.5 text-emerald-500" />
                <span>Télécharger</span>
              </button>
              <button
                onClick={async () => {
                  const entry = contextMenu.entry;
                  setContextMenu(null);
                  logMessage(`Calcul de la taille pour "${entry.name}"...`);
                  try {
                    const out = await invoke<string>("exec_remote_command", { sessionId: activeTab.id, command: `du -sh "${entry.path}"` });
                    logMessage(`Taille (${entry.name}) : ${out.trim()}`);
                  } catch (err) {
                    logMessage(`Erreur calcul taille : ${err}`);
                  }
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-sky-500/20 cursor-pointer"
              >
                <Calculator className="h-3.5 w-3.5 text-indigo-500" />
                <span>Calculer la taille (du -sh)</span>
              </button>
              <button
                onClick={() => {
                  const currentOctal = contextMenu.entry.permissions
                    ? (contextMenu.entry.permissions & 0o777).toString(8)
                    : "755";
                  setChmodModal({
                    path: contextMenu.entry.path,
                    name: contextMenu.entry.name,
                    octal: currentOctal,
                  });
                  setContextMenu(null);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-sky-500/20 cursor-pointer"
              >
                <ShieldCheck className="h-3.5 w-3.5 text-sky-500" />
                <span>Permissions (CHMOD)</span>
              </button>
            </>
          ) : (
            <button
              onClick={() => {
                checkAndEnqueueTransfer(contextMenu.entry.name, contextMenu.entry.path, activeTab.remotePath, "upload", contextMenu.entry.is_dir);
                setContextMenu(null);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-sky-500/20 cursor-pointer"
            >
              <Upload className="h-3.5 w-3.5 text-sky-500" />
              <span>Envoyer sur le serveur actif</span>
            </button>
          )}

          <div className="my-1 border-t border-neutral-500/20" />

          <button
            onClick={() => {
              const entry = contextMenu.entry;
              const isRem = contextMenu.isRemote;
              setContextMenu(null);
              setConfirmModal({
                title: "Suppression définitive",
                message: `Supprimer "${entry.name}" ? Cette action est irréversible.`,
                onConfirm: async () => {
                  if (isRem) {
                    await invoke("delete_remote", { sessionId: activeTab.id, path: entry.path, isDir: entry.is_dir });
                    logMessage(`DELE ${entry.path}`);
                    loadRemoteDirectory(activeTab.remotePath);
                  } else {
                    await invoke("delete_local", { path: entry.path, isDir: entry.is_dir });
                    logMessage(`Suppression locale : ${entry.path}`);
                    loadLocalDirectory(currentPath);
                  }
                },
              });
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-rose-500 hover:bg-rose-500/20 cursor-pointer"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>Supprimer</span>
          </button>
        </div>
      )}

      {/* Modale confirmation transfert inter-onglets */}
      {crossTabModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in duration-150">
          <div
            className={`w-[440px] rounded-xl border p-5 shadow-2xl space-y-4 animate-in zoom-in-95 duration-150 ${
              isDark ? "border-neutral-800 bg-neutral-900 text-neutral-200" : "border-neutral-300 bg-white text-neutral-800"
            }`}
          >
            <div className="flex items-center gap-2 border-b border-neutral-500/20 pb-2 text-sky-500">
              <Send className="h-5 w-5 shrink-0" />
              <span className="font-semibold text-sm">Transfert vers une autre session</span>
            </div>
            <p className="text-xs text-neutral-400 leading-relaxed">
              Vous allez envoyer <span className="font-mono text-emerald-400 font-semibold">{crossTabModal.item.entry.name}</span> vers le serveur distant de l'onglet :<br />
              <strong className="text-sky-400 font-semibold">{crossTabModal.targetTab.title}</strong> ({crossTabModal.targetTab.remotePath}).
            </p>

            <label className="flex items-center gap-2 cursor-pointer text-xs text-neutral-400 pt-1">
              <input
                type="checkbox"
                checked={crossTabModal.neverAskAgain}
                onChange={(e) =>
                  setCrossTabModal({ ...crossTabModal, neverAskAgain: e.target.checked })
                }
                className="rounded cursor-pointer"
              />
              <span>Ne plus me demander pour cette session</span>
            </label>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setCrossTabModal(null)}
                className="px-3 py-1.5 rounded border border-neutral-700 text-xs text-neutral-400 hover:bg-neutral-500/10 cursor-pointer"
              >
                Annuler
              </button>
              <button
                onClick={() => {
                  if (crossTabModal.neverAskAgain) {
                    setSkipCrossTabConfirm(true);
                    localStorage.setItem("gens_rft_skip_cross_confirm", "true");
                  }
                  checkAndEnqueueTransfer(
                    crossTabModal.item.entry.name,
                    crossTabModal.item.entry.path,
                    crossTabModal.targetTab.remotePath,
                    "upload",
                    crossTabModal.item.entry.is_dir,
                    crossTabModal.targetTab.id
                  );
                  setCrossTabModal(null);
                }}
                className="px-4 py-1.5 rounded bg-sky-600 font-semibold text-xs text-white hover:bg-sky-500 cursor-pointer transition active:scale-95"
              >
                Confirmer l'envoi
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Fenêtre de l'Éditeur de texte avec numéros de lignes synchronisés et Ctrl+F */}
      {editorModal && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/75 backdrop-blur-xs p-4 animate-in fade-in duration-150">
          <div
            className={`flex flex-col w-[920px] h-[600px] rounded-xl border shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150 ${
              isDark ? "border-neutral-800 bg-neutral-900 text-neutral-200" : "border-neutral-300 bg-white text-neutral-800"
            }`}
          >
            {/* Header éditeur */}
            <div className="flex items-center justify-between border-b px-4 py-2 border-neutral-700/50">
              <div className="flex items-center gap-2">
                <FileEdit className="h-4 w-4 text-sky-400" />
                <span className="font-semibold text-xs font-mono">{editorModal.filename}</span>
                <span className="text-[11px] text-neutral-500">({editorModal.path})</span>
                {editorModal.content !== editorModal.originalContent && (
                  <span className="h-2 w-2 rounded-full bg-amber-400" title="Modifications non enregistrées" />
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowEditorSearch(!showEditorSearch)}
                  className={`p-1.5 rounded text-xs flex items-center gap-1 border transition ${
                    showEditorSearch
                      ? "border-sky-500 bg-sky-500/20 text-sky-400"
                      : "border-neutral-700 hover:bg-neutral-800 text-neutral-400"
                  }`}
                  title="Rechercher (Ctrl+F)"
                >
                  <Search className="h-3.5 w-3.5" />
                  <span className="text-[10px]">Rechercher</span>
                </button>
                <button
                  disabled={editorModal.saving}
                  onClick={async () => {
                    setEditorModal({ ...editorModal, saving: true });
                    try {
                      await invoke("save_remote_file_text", {
                        sessionId: activeTab.id,
                        remotePath: editorModal.path,
                        content: editorModal.content,
                      });
                      logMessage(`Fichier sauvegardé avec succès : ${editorModal.filename}`);
                      setEditorModal({ ...editorModal, originalContent: editorModal.content, saving: false });
                    } catch (err) {
                      logMessage(`Erreur de sauvegarde : ${err}`);
                      setEditorModal({ ...editorModal, saving: false });
                    }
                  }}
                  className="flex items-center gap-1.5 px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white font-semibold text-xs cursor-pointer transition active:scale-95 disabled:opacity-50"
                  title="Sauvegarder sur le serveur (Ctrl+S)"
                >
                  <Save className="h-3.5 w-3.5" />
                  <span>{editorModal.saving ? "Sauvegarde..." : "Enregistrer"}</span>
                </button>
                <button
                  onClick={() => {
                    setEditorModal(null);
                    setShowEditorSearch(false);
                  }}
                  className="p-1 rounded hover:bg-neutral-500/20 text-neutral-400 hover:text-white cursor-pointer transition"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Barre flottante de recherche (Ctrl+F) */}
            {showEditorSearch && (
              <div className="flex items-center justify-between border-b px-3 py-1.5 bg-neutral-950/90 border-neutral-800 gap-2">
                <div className="flex items-center gap-2 flex-1">
                  <Search className="h-3.5 w-3.5 text-sky-400 shrink-0" />
                  <input
                    type="text"
                    autoFocus
                    placeholder="Rechercher dans le fichier..."
                    value={editorSearchQuery}
                    onChange={(e) => setEditorSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        if (editorSearchMatches.length > 0) {
                          const nextIdx = (currentMatchIndex + 1) % editorSearchMatches.length;
                          setCurrentMatchIndex(nextIdx);
                          const startPos = editorSearchMatches[nextIdx];
                          if (editorTextareaRef.current) {
                            editorTextareaRef.current.focus();
                            editorTextareaRef.current.setSelectionRange(startPos, startPos + editorSearchQuery.length);
                          }
                        }
                      } else if (e.key === "Escape") {
                        setShowEditorSearch(false);
                      }
                    }}
                    className="bg-neutral-900 border border-neutral-700 rounded px-2 py-0.5 text-xs text-neutral-200 outline-none focus:border-sky-500 w-64 font-mono"
                  />
                  <span className="text-[11px] text-neutral-400">
                    {editorSearchMatches.length > 0
                      ? `${currentMatchIndex + 1} / ${editorSearchMatches.length}`
                      : editorSearchQuery ? "0 résultat" : ""}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    disabled={editorSearchMatches.length === 0}
                    onClick={() => {
                      if (editorSearchMatches.length > 0) {
                        const prevIdx = (currentMatchIndex - 1 + editorSearchMatches.length) % editorSearchMatches.length;
                        setCurrentMatchIndex(prevIdx);
                        const startPos = editorSearchMatches[prevIdx];
                        if (editorTextareaRef.current) {
                          editorTextareaRef.current.focus();
                          editorTextareaRef.current.setSelectionRange(startPos, startPos + editorSearchQuery.length);
                        }
                      }
                    }}
                    className="p-1 rounded hover:bg-neutral-800 text-neutral-400 hover:text-white disabled:opacity-30 cursor-pointer"
                    title="Occurrence précédente"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </button>
                  <button
                    disabled={editorSearchMatches.length === 0}
                    onClick={() => {
                      if (editorSearchMatches.length > 0) {
                        const nextIdx = (currentMatchIndex + 1) % editorSearchMatches.length;
                        setCurrentMatchIndex(nextIdx);
                        const startPos = editorSearchMatches[nextIdx];
                        if (editorTextareaRef.current) {
                          editorTextareaRef.current.focus();
                          editorTextareaRef.current.setSelectionRange(startPos, startPos + editorSearchQuery.length);
                        }
                      }
                    }}
                    className="p-1 rounded hover:bg-neutral-800 text-neutral-400 hover:text-white disabled:opacity-30 cursor-pointer"
                    title="Occurrence suivante"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => setShowEditorSearch(false)}
                    className="p-1 rounded hover:bg-neutral-800 text-neutral-500 hover:text-white cursor-pointer ml-1"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}

            {/* Zone code avec numéros de lignes synchronisés */}
            <div className="flex-1 bg-neutral-950 flex overflow-hidden font-mono text-xs relative">
              <div
                ref={editorLineNumbersRef}
                className="w-12 py-2 pr-2 text-right bg-neutral-900/60 text-neutral-600 border-r border-neutral-800/80 select-none overflow-hidden leading-relaxed font-mono text-[11px]"
              >
                {editorModal.content.split("\n").map((_, i) => (
                  <div key={i} className="h-5">{i + 1}</div>
                ))}
              </div>

              <textarea
                ref={editorTextareaRef}
                autoFocus
                value={editorModal.content}
                onChange={(e) => setEditorModal({ ...editorModal, content: e.target.value })}
                onScroll={(e) => {
                  if (editorLineNumbersRef.current) {
                    editorLineNumbersRef.current.scrollTop = e.currentTarget.scrollTop;
                  }
                }}
                onKeyDown={async (e) => {
                  if (e.ctrlKey && e.key.toLowerCase() === "s") {
                    e.preventDefault();
                    setEditorModal((prev) => (prev ? { ...prev, saving: true } : null));
                    try {
                      await invoke("save_remote_file_text", {
                        sessionId: activeTab.id,
                        remotePath: editorModal.path,
                        content: editorModal.content,
                      });
                      logMessage(`Fichier sauvegardé : ${editorModal.filename}`);
                      setEditorModal((prev) => (prev ? { ...prev, originalContent: prev.content, saving: false } : null));
                    } catch (err) {
                      logMessage(`Erreur sauvegarde : ${err}`);
                      setEditorModal((prev) => (prev ? { ...prev, saving: false } : null));
                    }
                  }
                  if (e.ctrlKey && e.key.toLowerCase() === "f") {
                    e.preventDefault();
                    setShowEditorSearch(true);
                  }
                }}
                className="flex-1 h-full resize-none bg-transparent text-neutral-200 outline-none p-2 leading-relaxed overflow-auto whitespace-pre font-mono selection:bg-sky-500/30"
                placeholder="Contenu du fichier..."
                spellCheck={false}
              />
            </div>

            {/* Footer éditeur */}
            <div className="flex items-center justify-between border-t border-neutral-800 px-4 py-1.5 text-[11px] text-neutral-500">
              <div className="flex items-center gap-3">
                <span>Lignes : {editorModal.content.split("\n").length}</span>
                <span>Caractères : {editorModal.content.length}</span>
              </div>
              <div className="flex items-center gap-3 text-[10px]">
                <span>Ctrl+F : Rechercher</span>
                <span>Ctrl+S : Sauvegarder</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modale de bifurcation de connexion */}
      {tabPromptModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in duration-150">
          <div
            className={`w-[450px] rounded-xl border p-5 shadow-2xl space-y-4 animate-in zoom-in-95 duration-150 ${
              isDark ? "border-neutral-800 bg-neutral-900 text-neutral-200" : "border-neutral-300 bg-white text-neutral-800"
            }`}
          >
            <div className="flex items-center gap-2 border-b border-neutral-500/20 pb-2 text-sky-500">
              <Server className="h-5 w-5 shrink-0" />
              <span className="font-semibold text-sm">Connexion déjà établie</span>
            </div>
            <p className="text-xs text-neutral-400 leading-relaxed">
              Une connexion est déjà active sur cet onglet (
              <span className="text-sky-400 font-semibold">{activeTab.title}</span>).
              Que souhaitez-vous faire ?
            </p>
            <div className="flex flex-col gap-2 pt-2">
              <button
                onClick={() => {
                  const p = tabPromptModal.pendingParams;
                  setTabPromptModal(null);
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
                className="w-full py-2 rounded bg-amber-600 font-semibold text-xs text-white hover:bg-amber-500 cursor-pointer transition active:scale-95"
              >
                Couper la connexion actuelle et se connecter ici
              </button>
              <button
                onClick={() => {
                  const p = tabPromptModal.pendingParams;
                  setTabPromptModal(null);
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
                className="w-full py-2 rounded bg-sky-600 font-semibold text-xs text-white hover:bg-sky-500 cursor-pointer transition active:scale-95"
              >
                Ouvrir la connexion dans un nouvel onglet
              </button>
              <button
                onClick={() => setTabPromptModal(null)}
                className="w-full py-1.5 rounded border border-neutral-700 text-xs text-neutral-400 hover:bg-neutral-500/10 cursor-pointer transition"
              >
                Annuler
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modale Gestionnaire de sites */}
      {showSiteManager && (
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
              <button onClick={() => setShowSiteManager(false)} className="text-neutral-400 hover:text-neutral-200 cursor-pointer transition">
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
                      onClick={() => {
                        setSelectedSiteId(site.id);
                        setSiteForm(site);
                      }}
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

                <div className="flex gap-2 pt-2 border-t border-neutral-500/20">
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
                            isDark ? "bg-neutral-950 border-neutral-700" : "bg-neutral-50 border-neutral-300"
                          }`}
                        />
                      </div>
                      <div>
                        <label className="block text-neutral-400 mb-1">Protocole</label>
                        <select
                          value={siteForm.protocol}
                          onChange={(e) =>
                            setSiteForm({
                              ...siteForm,
                              protocol: e.target.value as "SFTP" | "FTP",
                              port: e.target.value === "SFTP" ? "22" : "21",
                            })
                          }
                          className={`w-full rounded border px-3 py-1.5 focus:outline-none cursor-pointer transition ${
                            isDark ? "bg-neutral-950 border-neutral-700" : "bg-neutral-50 border-neutral-300"
                          }`}
                        >
                          <option value="SFTP">SFTP - SSH File Transfer</option>
                          <option value="FTP">FTP - File Transfer Protocol</option>
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
                            isDark ? "bg-neutral-950 border-neutral-700" : "bg-neutral-50 border-neutral-300"
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
                            isDark ? "bg-neutral-950 border-neutral-700" : "bg-neutral-50 border-neutral-300"
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
                              isDark ? "bg-neutral-950 border-neutral-700" : "bg-neutral-50 border-neutral-300"
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
                                isDark ? "bg-neutral-950 border-neutral-700" : "bg-neutral-50 border-neutral-300"
                              }`}
                            />
                          </div>
                        ) : (
                          <>
                            <div>
                              <label className="block text-neutral-400 mb-1">Chemin de la clé privée</label>
                              <input
                                type="text"
                                placeholder="C:\Users\William\.ssh\id_ed25519"
                                value={siteForm.keyPath || ""}
                                onChange={(e) => setSiteForm({ ...siteForm, keyPath: e.target.value })}
                                className={`w-full rounded border px-3 py-1.5 font-mono text-[11px] focus:outline-none transition ${
                                  isDark ? "bg-neutral-950 border-neutral-700" : "bg-neutral-50 border-neutral-300"
                                }`}
                              />
                            </div>
                            <div>
                              <label className="block text-neutral-400 mb-1">Passphrase</label>
                              <input
                                type="password"
                                value={siteForm.passphrase || ""}
                                onChange={(e) => setSiteForm({ ...siteForm, passphrase: e.target.value })}
                                className={`w-full rounded border px-3 py-1.5 focus:outline-none transition ${
                                  isDark ? "bg-neutral-950 border-neutral-700" : "bg-neutral-50 border-neutral-300"
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
                  }
                }}
                className="px-3 py-1.5 rounded border border-neutral-700 text-xs hover:bg-neutral-500/10 cursor-pointer transition active:scale-95"
              >
                Enregistrer
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowSiteManager(false)}
                  className="px-3 py-1.5 rounded border border-neutral-700 text-xs hover:bg-neutral-500/10 cursor-pointer transition"
                >
                  Fermer
                </button>
                <button
                  onClick={() => {
                    if (selectedSiteId) {
                      setSites(sites.map((s) => (s.id === selectedSiteId ? siteForm : s)));
                      setShowSiteManager(false);
                      handleConnectRequest(
                        siteForm.protocol,
                        siteForm.host,
                        siteForm.port,
                        siteForm.username,
                        siteForm.authType,
                        siteForm.password,
                        siteForm.keyPath,
                        siteForm.passphrase,
                        siteForm.id,
                        siteForm.lastRemotePath,
                        siteForm.lastLocalPath
                      );
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
      )}

      {/* Modale Paramètres */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in duration-150">
          <div
            className={`w-[600px] h-[400px] flex flex-col rounded-xl border shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150 ${
              isDark ? "border-neutral-800 bg-neutral-900 text-neutral-200" : "border-neutral-300 bg-white text-neutral-800"
            }`}
          >
            <div className="flex items-center justify-between border-b px-4 py-2.5 border-neutral-500/20">
              <span className="font-semibold text-sm flex items-center gap-2 text-sky-500">
                <Settings className="h-4 w-4" />
                Paramètres de Gens-RFT
              </span>
              <button onClick={() => setShowSettings(false)} className="text-neutral-400 hover:text-white cursor-pointer transition">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex flex-1 overflow-hidden">
              <div className={`w-44 border-r p-2 space-y-1 ${isDark ? "border-neutral-800 bg-neutral-950/40" : "border-neutral-200 bg-neutral-50"}`}>
                <button
                  onClick={() => setSettingsTab("general")}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded text-xs cursor-pointer transition ${
                    settingsTab === "general" ? "bg-sky-600 text-white font-medium" : "hover:bg-neutral-500/10 text-neutral-400"
                  }`}
                >
                  <Sliders className="h-3.5 w-3.5" />
                  <span>Affichage & Thème</span>
                </button>
                <button
                  onClick={() => setSettingsTab("panels")}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded text-xs cursor-pointer transition ${
                    settingsTab === "panels" ? "bg-sky-600 text-white font-medium" : "hover:bg-neutral-500/10 text-neutral-400"
                  }`}
                >
                  <Folder className="h-3.5 w-3.5" />
                  <span>Panneaux & Outils</span>
                </button>
                <button
                  onClick={() => setSettingsTab("about")}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded text-xs cursor-pointer transition ${
                    settingsTab === "about" ? "bg-sky-600 text-white font-medium" : "hover:bg-neutral-500/10 text-neutral-400"
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
                          <span>Mémoriser le dernier dossier distant par serveur (SiteProfile)</span>
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
                      <p className="text-neutral-500 text-[11px] mt-1">Client SFTP / SSH haute performance basé sur Tauri v2 et Rust.</p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end p-3 border-t border-neutral-500/20">
              <button
                onClick={() => setShowSettings(false)}
                className="px-4 py-1.5 rounded bg-sky-600 font-semibold text-xs text-white hover:bg-sky-500 cursor-pointer transition active:scale-95"
              >
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modale Conflit */}
      {conflictModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in duration-150">
          <div
            className={`w-96 rounded-xl border p-5 shadow-2xl space-y-4 animate-in zoom-in-95 duration-150 ${
              isDark ? "border-neutral-800 bg-neutral-900 text-neutral-200" : "border-neutral-300 bg-white text-neutral-800"
            }`}
          >
            <div className="flex items-center gap-2 border-b border-neutral-500/20 pb-2 text-amber-500">
              <AlertTriangle className="h-5 w-5 shrink-0" />
              <span className="font-semibold text-sm">Fichier déjà existant</span>
            </div>
            <p className="text-xs text-neutral-400 leading-relaxed">
              Un élément nommé <span className="font-mono text-sky-500 font-semibold">{conflictModal.filename}</span> existe déjà dans la destination.
            </p>
            <div className="flex flex-col gap-2 pt-1">
              <button
                onClick={() => conflictModal.onResolve("overwrite")}
                className="w-full py-1.5 rounded bg-rose-600 font-semibold text-xs text-white hover:bg-rose-500 cursor-pointer transition active:scale-95"
              >
                Écraser le fichier cible
              </button>
              <button
                onClick={() => conflictModal.onResolve("rename")}
                className="w-full py-1.5 rounded border border-neutral-700 font-semibold text-xs text-sky-500 hover:bg-neutral-500/10 cursor-pointer transition active:scale-95"
              >
                Renommer automatiquement
              </button>
              <button
                onClick={() => conflictModal.onResolve("skip")}
                className="w-full py-1.5 rounded border border-neutral-700 text-xs text-neutral-400 hover:bg-neutral-500/10 cursor-pointer transition"
              >
                Ignorer ce fichier
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modale Saisie */}
      {inputModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in duration-150">
          <div
            className={`w-80 rounded-xl border p-5 shadow-2xl space-y-4 animate-in zoom-in-95 duration-150 ${
              isDark ? "border-neutral-800 bg-neutral-900 text-neutral-200" : "border-neutral-300 bg-white text-neutral-800"
            }`}
          >
            <div className="flex items-center justify-between border-b pb-2 border-neutral-500/20">
              <span className="font-semibold text-sm">{inputModal.title}</span>
              <button onClick={() => setInputModal(null)} className="text-neutral-400 hover:text-white cursor-pointer transition">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div>
              <label className="block text-xs text-neutral-400 mb-1">{inputModal.label}</label>
              <input
                type="text"
                autoFocus
                value={inputModal.value}
                onChange={(e) => setInputModal({ ...inputModal, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    inputModal.onConfirm(inputModal.value);
                    setInputModal(null);
                  }
                }}
                className={`w-full rounded border px-3 py-1.5 text-xs focus:outline-none transition ${
                  isDark ? "bg-neutral-950 border-neutral-700 text-neutral-100" : "bg-neutral-50 border-neutral-300 text-neutral-900"
                }`}
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setInputModal(null)}
                className="px-3 py-1.5 rounded border border-neutral-700 text-xs text-neutral-400 hover:bg-neutral-500/10 cursor-pointer transition"
              >
                Annuler
              </button>
              <button
                onClick={() => {
                  inputModal.onConfirm(inputModal.value);
                  setInputModal(null);
                }}
                className="px-3 py-1.5 rounded bg-sky-600 font-semibold text-xs text-white hover:bg-sky-500 cursor-pointer transition active:scale-95"
              >
                Valider
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modale Confirmation */}
      {confirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in duration-150">
          <div
            className={`w-80 rounded-xl border p-5 shadow-2xl space-y-4 animate-in zoom-in-95 duration-150 ${
              isDark ? "border-neutral-800 bg-neutral-900 text-neutral-200" : "border-neutral-300 bg-white text-neutral-800"
            }`}
          >
            <div className="flex items-center justify-between border-b pb-2 border-neutral-500/20">
              <span className="font-semibold text-sm">{confirmModal.title}</span>
              <button onClick={() => setConfirmModal(null)} className="text-neutral-400 hover:text-white cursor-pointer transition">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-xs text-neutral-400 leading-relaxed">{confirmModal.message}</p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setConfirmModal(null)}
                className="px-3 py-1.5 rounded border border-neutral-700 text-xs text-neutral-400 hover:bg-neutral-500/10 cursor-pointer transition"
              >
                Annuler
              </button>
              <button
                onClick={() => {
                  confirmModal.onConfirm();
                  setConfirmModal(null);
                }}
                className="px-3 py-1.5 rounded bg-rose-600 font-semibold text-xs text-white hover:bg-rose-500 cursor-pointer transition active:scale-95"
              >
                Confirmer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modale CHMOD */}
      {chmodModal && (
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
              <button onClick={() => setChmodModal(null)} className="text-neutral-400 hover:text-white cursor-pointer transition">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div>
              <div className="text-xs text-neutral-400 mb-1 truncate">{chmodModal.name}</div>
              <label className="block text-xs font-semibold text-neutral-300 mb-1">Valeur Octale</label>
              <input
                type="text"
                maxLength={4}
                value={chmodModal.octal}
                onChange={(e) => setChmodModal({ ...chmodModal, octal: e.target.value })}
                className={`w-full text-center font-mono text-lg rounded border py-1.5 text-sky-500 focus:outline-none transition ${
                  isDark ? "bg-neutral-950 border-neutral-700" : "bg-neutral-50 border-neutral-300"
                }`}
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setChmodModal(null)}
                className="px-3 py-1.5 rounded border border-neutral-700 text-xs text-neutral-400 hover:bg-neutral-500/10 cursor-pointer transition"
              >
                Annuler
              </button>
              <button
                onClick={async () => {
                  const permVal = parseInt(chmodModal.octal, 8);
                  try {
                    await invoke("chmod_remote", { sessionId: activeTab.id, path: chmodModal.path, permissions: permVal });
                    logMessage(`SITE CHMOD ${chmodModal.octal} ${chmodModal.name}`);
                    setChmodModal(null);
                    loadRemoteDirectory(activeTab.remotePath);
                  } catch (err) {
                    logMessage(`550 Échec CHMOD : ${err}`);
                  }
                }}
                className="px-3 py-1.5 rounded bg-sky-600 font-semibold text-xs text-white hover:bg-sky-500 cursor-pointer transition active:scale-95"
              >
                Appliquer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
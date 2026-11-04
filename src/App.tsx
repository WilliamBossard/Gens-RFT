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
  AlertTriangle,
  RotateCcw,
  RefreshCw,
  Settings,
  Sliders,
  Info,
  ChevronDown,
  ChevronUp
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
}

type SortField = "name" | "size";
type SortOrder = "asc" | "desc";

export default function App() {
  // Paramètres & Thème
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [showHidden, setShowHidden] = useState(false);
  const [showTreePanels, setShowTreePanels] = useState(true);
  const [enableSshTerminal, setEnableSshTerminal] = useState(true);
  const [maxConcurrent, setMaxConcurrent] = useState("2");
  const [settingsTab, setSettingsTab] = useState<"general" | "panels" | "about">("general");

  // Hauteurs redimensionnables
  const [treeHeight, setTreeHeight] = useState(130);
  const [bottomHeight, setBottomHeight] = useState(180);

  // Connexion
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isConnected, setIsConnected] = useState(false);

  // Explorateurs
  const [currentPath, setCurrentPath] = useState<string>("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [remotePath, setRemotePath] = useState<string>("/");
  const [remoteFiles, setRemoteFiles] = useState<FileEntry[]>([]);

  // Drag & drop interne
  const [draggedItem, setDraggedItem] = useState<{ entry: FileEntry; from: "local" | "remote" } | null>(null);
  const [isOverLocal, setIsOverLocal] = useState(false);
  const [isOverRemote, setIsOverRemote] = useState(false);

  // Filtres et tris
  const [localSearch, setLocalSearch] = useState("");
  const [remoteSearch, setRemoteSearch] = useState("");
  const [localSort, setLocalSort] = useState<{ field: SortField; order: SortOrder }>({ field: "name", order: "asc" });
  const [remoteSort, setRemoteSort] = useState<{ field: SortField; order: SortOrder }>({ field: "name", order: "asc" });

  // Console et logs
  const [logs, setLogs] = useState<string[]>(["Gens-RFT initialisé. En attente de connexion."]);
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

  // Neutralisation globale du blocage WebView2
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

  // Fermeture du menu contextuel sur clic gauche uniquement
  useEffect(() => {
    const handleGlobalMouseDown = (e: MouseEvent) => {
      if (e.button === 2) return;
      setContextMenu(null);
    };

    window.addEventListener("mousedown", handleGlobalMouseDown);
    return () => window.removeEventListener("mousedown", handleGlobalMouseDown);
  }, []);

  // Écoute de progression des transferts
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

  // Traitement séquentiel de la queue
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
          logMessage(`STOR ${nextItem.filename} -> ${nextItem.destDir}`);
          await invoke("upload_item", {
            transferId: nextItem.id,
            localPath: nextItem.sourcePath,
            remoteDestDir: nextItem.destDir,
          });
          loadRemoteDirectory(remotePath);
        } else {
          logMessage(`RETR ${nextItem.filename} -> ${nextItem.destDir}`);
          await invoke("download_item", {
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
  }, [queue, runningCount, remotePath, currentPath, concurrentLimit]);

  // Drag & drop externe Windows
  useEffect(() => {
    const unlistenDrop = listen<{ paths: string[] }>("tauri://drag-drop", async (event) => {
      setIsOverRemote(false);
      setIsOverLocal(false);
      if (!isConnected) {
        logMessage("Erreur : Aucun serveur distant connecté pour recevoir les fichiers.");
        return;
      }
      for (const p of event.payload.paths) {
        const fname = p.split(/[\\/]/).pop() || "fichier";
        checkAndEnqueueTransfer(fname, p, remotePath, "upload", false);
      }
    });

    return () => {
      unlistenDrop.then((fn) => fn());
    };
  }, [isConnected, remotePath]);

  useEffect(() => {
    localStorage.setItem("gens_rft_sites", JSON.stringify(sites));
  }, [sites]);

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
      logMessage(`550 Accès refusé au dossier local : ${err}`);
    }
  };

  const loadRemoteDirectory = async (targetPath?: string) => {
    try {
      logMessage(`CWD Distant: ${targetPath || "/"}`);
      const result = await invoke<FileEntry[]>("list_remote_dir", { path: targetPath || null });
      setRemoteFiles(result);
      if (targetPath) setRemotePath(targetPath);
      logMessage(`250 ${result.length} élément(s) listé(s) sur le serveur.`);
    } catch (err) {
      logMessage(`550 Permission denied sur le serveur distant : ${err}`);
    }
  };

  const connectToServer = async (
    protocol: "SFTP" | "FTP",
    targetHost: string,
    targetPort: string,
    targetUser: string,
    authType: "password" | "key",
    targetPass?: string,
    targetKeyPath?: string,
    targetPassphrase?: string
  ) => {
    logMessage(`Connexion ${protocol} à ${targetUser}@${targetHost}:${targetPort}...`);
    try {
      const msg = await invoke<string>("connect_server", {
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
      setIsConnected(true);
      await loadRemoteDirectory("/");
    } catch (err) {
      logMessage(`530 Échec d'authentification : ${err}`);
    }
  };

  useEffect(() => {
    if (!hasLoadedInitialDir.current) {
      hasLoadedInitialDir.current = true;
      loadLocalDirectory();
    }
  }, []);

  const checkAndEnqueueTransfer = (
    filename: string,
    sourcePath: string,
    destDir: string,
    direction: "upload" | "download",
    isDir: boolean
  ) => {
    const targetFileList = direction === "upload" ? remoteFiles : files;
    const exists = targetFileList.some((f) => f.name.toLowerCase() === filename.toLowerCase());

    if (exists) {
      setConflictModal({
        filename,
        onResolve: (action) => {
          if (action === "skip") {
            logMessage(`Transfert de "${filename}" ignoré (conflit).`);
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

          addTransferToQueue(finalName, sourcePath, destDir, direction, isDir);
          setConflictModal(null);
        },
      });
    } else {
      addTransferToQueue(filename, sourcePath, destDir, direction, isDir);
    }
  };

  const addTransferToQueue = (
    filename: string,
    sourcePath: string,
    destDir: string,
    direction: "upload" | "download",
    isDir: boolean
  ) => {
    const newId = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    setQueue((prev) => [
      ...prev,
      {
        id: newId,
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

  const cancelTransferItem = async (id: string) => {
    await invoke("cancel_current_transfer");
    setQueue((items) =>
      items.map((it) => (it.id === id ? { ...it, status: "error", speed: "Annulé" } : it))
    );
  };

  const handleCancelAllTransfers = async () => {
    await invoke("cancel_current_transfer");
    setQueue((items) =>
      items.map((it) =>
        it.status === "queued" || it.status === "running"
          ? { ...it, status: "error", speed: "Annulé" }
          : it
      )
    );
    logMessage("Opération : Tous les transferts ont été annulés.");
  };

  const handleClearQueueHistory = () => {
    setQueue((items) => items.filter((it) => it.status === "running" || it.status === "queued"));
    logMessage("Opération : Historique des transferts nettoyé.");
  };

  const handleOpenWithSystem = async (file: FileEntry) => {
    if (!isConnected) return;
    logMessage(`Téléchargement temporaire et ouverture de "${file.name}"...`);
    try {
      const tempPath = await invoke<string>("open_remote_with_system", { remotePath: file.path });
      logMessage(`Fichier ouvert avec le programme Windows par défaut : ${tempPath}`);
    } catch (err) {
      logMessage(`Erreur d'ouverture : ${err}`);
    }
  };

  const handleApplyChmod = async () => {
    if (!chmodModal) return;
    const permVal = parseInt(chmodModal.octal, 8);
    try {
      await invoke("chmod_remote", { path: chmodModal.path, permissions: permVal });
      logMessage(`SITE CHMOD ${chmodModal.octal} ${chmodModal.name}`);
      setChmodModal(null);
      loadRemoteDirectory(remotePath);
    } catch (err) {
      logMessage(`550 Échec CHMOD : ${err}`);
    }
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
    return remoteFiles
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
  }, [remoteFiles, showHidden, remoteSearch, remoteSort]);

  const isDark = theme === "dark";

  return (
    <div
      className={`flex h-screen w-screen flex-col font-sans select-none antialiased ${isDark ? "bg-neutral-950 text-neutral-200" : "bg-neutral-100 text-neutral-800"
        }`}
    >
      {/* Barre d'outils supérieure */}
      <header
        className={`flex flex-wrap items-center justify-between border-b px-2 py-1.5 gap-2 backdrop-blur-md ${isDark ? "border-neutral-800 bg-neutral-900/80" : "border-neutral-300 bg-white"
          }`}
      >
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => setShowSiteManager(true)}
            className={`flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs cursor-pointer transition ${isDark
                ? "border-neutral-700 bg-neutral-800 text-neutral-300 hover:bg-neutral-700 hover:text-white"
                : "border-neutral-300 bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
              }`}
            title="Gestionnaire de sites"
          >
            <SlidersHorizontal className="h-3.5 w-3.5 text-sky-500" />
            <span>Sites</span>
          </button>

          <button
            onClick={() => {
              logMessage("Actualisation des dossiers et fichiers...");
              loadLocalDirectory(currentPath);
              if (isConnected) loadRemoteDirectory(remotePath);
            }}
            className={`flex items-center gap-1 px-2.5 py-1 rounded border cursor-pointer text-xs transition ${isDark
                ? "border-neutral-700 bg-neutral-800 text-neutral-300 hover:text-white"
                : "border-neutral-300 bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
              }`}
            title="Actualiser les deux panneaux"
          >
            <RefreshCw className="h-3.5 w-3.5 text-emerald-500" />
            <span>Actualiser</span>
          </button>

          <button
            onClick={() => setShowSettings(true)}
            className={`flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs cursor-pointer transition ${isDark
                ? "border-neutral-700 bg-neutral-800 text-neutral-300 hover:text-white"
                : "border-neutral-300 bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
              }`}
            title="Paramètres de l'application"
          >
            <Settings className="h-3.5 w-3.5 text-neutral-400" />
            <span>Paramètres</span>
          </button>
        </div>

        {/* Connexion rapide */}
        <div
          className={`flex flex-1 max-w-xl items-center rounded-lg border p-0.5 shadow-inner ${isDark ? "border-neutral-800 bg-neutral-950/80" : "border-neutral-300 bg-white"
            }`}
        >
          <input
            type="text"
            placeholder="Hôte"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            className="bg-transparent px-2.5 py-1 text-xs placeholder-neutral-500 focus:outline-none flex-1 min-w-[90px] border-r border-neutral-700/50"
          />
          <input
            type="text"
            placeholder="Port"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            className="bg-transparent px-1.5 py-1 text-xs placeholder-neutral-500 focus:outline-none w-12 text-center border-r border-neutral-700/50 shrink-0"
          />
          <input
            type="text"
            placeholder="Utilisateur"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="bg-transparent px-2.5 py-1 text-xs placeholder-neutral-500 focus:outline-none flex-1 min-w-[80px] border-r border-neutral-700/50"
          />
          <input
            type="password"
            placeholder="Mot de passe"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="bg-transparent px-2.5 py-1 text-xs placeholder-neutral-500 focus:outline-none flex-1 min-w-[80px]"
          />
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div className="hidden xl:flex items-center gap-2 text-[11px] font-medium text-neutral-400 mr-1">
            <span
              className={`h-2 w-2 rounded-full ${isConnected ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]" : "bg-neutral-500"
                }`}
            />
            <span>{isConnected ? "En ligne" : "Déconnecté"}</span>
          </div>

          <button
            onClick={() => connectToServer("SFTP", host, port, username, "password", password)}
            className="flex items-center gap-1.5 rounded bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white shadow hover:bg-sky-500 active:scale-95 cursor-pointer transition"
          >
            <Server className="h-3.5 w-3.5" />
            <span>Connecter</span>
          </button>
        </div>
      </header>

      {/* Main Split-Pane */}
      <div className="flex flex-1 overflow-hidden">
        {/* Panneau Local */}
        <section
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
          className={`flex flex-1 flex-col border-r relative transition ${isDark ? "border-neutral-800 bg-neutral-950/40" : "border-neutral-300 bg-white"
            } ${isOverLocal ? "outline outline-2 outline-emerald-500 bg-emerald-500/10" : ""}`}
        >
          {/* En-tête Local */}
          <div
            className={`flex items-center justify-between border-b px-3 py-1.5 ${isDark ? "border-neutral-800 bg-neutral-900/40" : "border-neutral-200 bg-neutral-100"
              }`}
          >
            <div className="flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-emerald-500" />
              <span className="text-xs font-semibold truncate max-w-sm">Site Local : {currentPath}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="relative">
                <Search className="h-3 w-3 absolute left-2 top-2 text-neutral-500" />
                <input
                  type="text"
                  placeholder="Filtrer..."
                  value={localSearch}
                  onChange={(e) => setLocalSearch(e.target.value)}
                  className={`h-6 w-24 sm:w-28 rounded border pl-7 pr-2 text-[11px] focus:outline-none ${isDark ? "bg-neutral-950 border-neutral-800 text-neutral-100" : "bg-white border-neutral-300 text-neutral-900"
                    }`}
                />
              </div>
              <button
                onClick={() => {
                  const sep = currentPath.includes("/") ? "/" : "\\";
                  const parts = currentPath.split(sep).filter(Boolean);
                  parts.pop();
                  loadLocalDirectory(parts.join(sep) || "C:\\");
                }}
                className="rounded p-1 hover:bg-neutral-500/20 cursor-pointer"
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
                className={`border-b overflow-y-auto ${isDark ? "border-neutral-800/80 bg-neutral-950/70" : "border-neutral-200 bg-neutral-50"
                  }`}
              >
                <DirectoryTree
                  isRemote={false}
                  currentPath={currentPath || "C:\\"}
                  subFolders={files.filter((f) => f.is_dir && (showHidden ? true : !f.name.startsWith("."))).map((f) => f.name)}
                  onNavigate={loadLocalDirectory}
                />
              </div>

              {/* Splitter redimensionnable */}
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

          {/* En-tête des colonnes */}
          <div
            className={`grid grid-cols-12 border-b px-3 py-1 text-[11px] font-semibold text-neutral-500 uppercase tracking-wider ${isDark ? "border-neutral-800 bg-neutral-900/50" : "border-neutral-200 bg-neutral-100"
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
            {processedLocalFiles.map((item, index) => (
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
                }}
                onDoubleClick={() => {
                  if (item.is_dir) {
                    loadLocalDirectory(item.path);
                  } else {
                    if (!isConnected) {
                      logMessage("Info : Connectez-vous d'abord à un serveur distant pour transférer.");
                      return;
                    }
                    checkAndEnqueueTransfer(item.name, item.path, remotePath, "upload", false);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu({ x: e.clientX, y: e.clientY, entry: item, isRemote: false });
                }}
                className="grid grid-cols-12 items-center px-3 py-1.5 hover:bg-sky-500/10 cursor-pointer group transition"
              >
                <div className="col-span-8 flex items-center gap-2 truncate pr-2">
                  {item.is_dir ? (
                    <Folder className="h-4 w-4 text-amber-500 shrink-0" />
                  ) : (
                    <FileText className="h-4 w-4 text-neutral-400 shrink-0 group-hover:text-sky-500" />
                  )}
                  <span className="truncate">{item.name}</span>
                </div>

                <div className="col-span-3 text-right text-[11px] text-neutral-500 font-sans">
                  {!item.is_dir ? `${(item.size / 1024).toFixed(1)} Ko` : "--"}
                </div>

                <div className="col-span-1 flex justify-center">
                  {isConnected && !item.is_dir && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        checkAndEnqueueTransfer(item.name, item.path, remotePath, "upload", false);
                      }}
                      className="opacity-0 group-hover:opacity-100 rounded p-1 text-neutral-400 hover:text-sky-500 cursor-pointer transition"
                      title="Envoyer vers le serveur"
                    >
                      <Upload className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Panneau Distant */}
        <section
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
              if (!isConnected) {
                logMessage("Erreur : Impossible d'envoyer, serveur déconnecté.");
                setDraggedItem(null);
                return;
              }
              checkAndEnqueueTransfer(
                draggedItem.entry.name,
                draggedItem.entry.path,
                remotePath,
                "upload",
                draggedItem.entry.is_dir
              );
              setDraggedItem(null);
            }
          }}
          className={`flex flex-1 flex-col relative transition ${isDark ? "bg-neutral-950/20" : "bg-white"
            } ${isOverRemote ? "outline outline-2 outline-sky-500 bg-sky-500/10" : ""}`}
        >
          {/* En-tête Distant */}
          <div
            className={`flex items-center justify-between border-b px-3 py-1.5 ${isDark ? "border-neutral-800 bg-neutral-900/40" : "border-neutral-200 bg-neutral-100"
              }`}
          >
            <div className="flex items-center gap-2">
              <Server className="h-4 w-4 text-sky-500" />
              <span className="text-xs font-semibold truncate max-w-sm">Site Distant : {remotePath}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="relative">
                <Search className="h-3 w-3 absolute left-2 top-2 text-neutral-500" />
                <input
                  type="text"
                  placeholder="Filtrer..."
                  value={remoteSearch}
                  onChange={(e) => setRemoteSearch(e.target.value)}
                  className={`h-6 w-24 sm:w-28 rounded border pl-7 pr-2 text-[11px] focus:outline-none ${isDark ? "bg-neutral-950 border-neutral-800 text-neutral-100" : "bg-white border-neutral-300 text-neutral-900"
                    }`}
                />
              </div>
              {isConnected && (
                <>
                  <button
                    onClick={() => {
                      const parts = remotePath.split("/").filter(Boolean);
                      parts.pop();
                      loadRemoteDirectory("/" + parts.join("/"));
                    }}
                    className="rounded p-1 hover:bg-neutral-500/20 cursor-pointer"
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
                          const sep = remotePath.endsWith("/") ? "" : "/";
                          await invoke("create_remote_dir", { path: `${remotePath}${sep}${val}` });
                          logMessage(`MKD ${remotePath}${sep}${val}`);
                          loadRemoteDirectory(remotePath);
                        },
                      });
                    }}
                    className="rounded p-1 hover:bg-neutral-500/20 cursor-pointer"
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
                className={`border-b overflow-y-auto ${isDark ? "border-neutral-800/80 bg-neutral-950/70" : "border-neutral-200 bg-neutral-50"
                  }`}
              >
                {isConnected ? (
                  <DirectoryTree
                    isRemote={true}
                    currentPath={remotePath}
                    subFolders={remoteFiles.filter((f) => f.is_dir && (showHidden ? true : !f.name.startsWith("."))).map((f) => f.name)}
                    onNavigate={loadRemoteDirectory}
                  />
                ) : (
                  <div className="p-3 text-neutral-500 text-xs">Serveur déconnecté</div>
                )}
              </div>

              {/* Splitter redimensionnable */}
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

          {/* En-tête des colonnes */}
          <div
            className={`grid grid-cols-12 border-b px-3 py-1 text-[11px] font-semibold text-neutral-500 uppercase tracking-wider ${isDark ? "border-neutral-800 bg-neutral-900/50" : "border-neutral-200 bg-neutral-100"
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
            {!isConnected ? (
              <div className="flex h-full flex-col items-center justify-center text-xs text-neutral-500 gap-2 font-sans">
                <Server className="h-8 w-8 text-neutral-500" />
                <span>Absence de connexion à un serveur</span>
              </div>
            ) : (
              processedRemoteFiles.map((item, index) => (
                <div
                  key={index}
                  draggable
                  onDragStart={(e) => {
                    setDraggedItem({ entry: item, from: "remote" });
                    e.dataTransfer.setData("text/plain", item.path);
                    e.dataTransfer.effectAllowed = "copyMove";
                  }}
                  onDragEnd={() => {
                    setDraggedItem(null);
                    setIsOverRemote(false);
                    setIsOverLocal(false);
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
                  className="grid grid-cols-12 items-center px-3 py-1.5 hover:bg-sky-500/10 cursor-pointer group transition"
                >
                  <div className="col-span-6 flex items-center gap-2 truncate pr-2">
                    {item.is_dir ? (
                      <Folder className="h-4 w-4 text-sky-500 shrink-0" />
                    ) : (
                      <FileText className="h-4 w-4 text-neutral-400 shrink-0 group-hover:text-emerald-500" />
                    )}
                    <span className="truncate">{item.name}</span>
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
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenWithSystem(item);
                          }}
                          className="opacity-0 group-hover:opacity-100 rounded p-1 text-neutral-400 hover:text-amber-500 cursor-pointer transition"
                          title="Éditer / Ouvrir avec Windows"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            checkAndEnqueueTransfer(item.name, item.path, currentPath, "download", false);
                          }}
                          className="opacity-0 group-hover:opacity-100 rounded p-1 text-neutral-400 hover:text-emerald-500 cursor-pointer transition"
                          title="Télécharger"
                        >
                          <Download className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      {/* Splitter pour la console du bas */}
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
        className={`border-t flex flex-col transition-all duration-100 ${isDark ? "border-neutral-800 bg-neutral-900/90" : "border-neutral-300 bg-white"
          }`}
      >
        <div
          className={`flex items-center justify-between border-b px-4 h-8 text-xs font-semibold select-none ${isDark ? "border-neutral-800/80" : "border-neutral-200"
            }`}
        >
          <div className="flex gap-4">
            <button
              onClick={() => {
                setActiveBottomTab("queue");
                setBottomOpen(true);
              }}
              className={`flex items-center gap-1.5 py-1 cursor-pointer transition ${activeBottomTab === "queue" && bottomOpen ? "text-sky-500 font-bold" : "text-neutral-500 hover:text-neutral-300"
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
              className={`flex items-center gap-1.5 py-1 cursor-pointer transition ${activeBottomTab === "logs" && bottomOpen ? "text-sky-500 font-bold" : "text-neutral-500 hover:text-neutral-300"
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
                className={`flex items-center gap-1.5 py-1 cursor-pointer transition ${activeBottomTab === "terminal" && bottomOpen ? "text-sky-500 font-bold" : "text-neutral-500 hover:text-neutral-300"
                  }`}
              >
                <TerminalIcon className="h-3.5 w-3.5 text-emerald-500" />
                <span>Terminal SSH</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {activeBottomTab === "queue" && (
              <>
                <button
                  onClick={handleClearQueueHistory}
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-normal text-neutral-400 hover:text-neutral-200 cursor-pointer transition"
                  title="Vider l'historique"
                >
                  <RotateCcw className="h-3 w-3" />
                  <span>Vider terminé</span>
                </button>
                <button
                  onClick={handleCancelAllTransfers}
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-normal text-rose-500 hover:text-rose-400 cursor-pointer transition"
                  title="Tout annuler"
                >
                  <Ban className="h-3 w-3" />
                  <span>Tout annuler</span>
                </button>
              </>
            )}

            <button
              onClick={() => setBottomOpen(!bottomOpen)}
              className="p-1 text-neutral-400 hover:text-neutral-200 cursor-pointer ml-2"
              title={bottomOpen ? "Réduire" : "Agrandir"}
            >
              {bottomOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

        {bottomOpen && (
          <div className="flex-1 flex flex-col overflow-hidden relative">
            {/* Terminal SSH persistant */}
            {enableSshTerminal && (
              <div className={`h-full w-full ${activeBottomTab === "terminal" ? "block" : "hidden"}`}>
                <SshTerminal isConnected={isConnected} />
              </div>
            )}

            {/* Logs */}
            {activeBottomTab === "logs" && (
              <div className="flex-1 overflow-y-auto p-2.5 font-mono text-[11px] space-y-1">
                {logs.map((log, idx) => (
                  <div key={idx} className="flex gap-2">
                    <span className="text-neutral-500">&gt;</span>
                    <span>{log}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Queue de transferts */}
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
                              onClick={() => cancelTransferItem(item.id)}
                              className="px-2 py-0.5 rounded bg-rose-600/80 hover:bg-rose-500 text-[10px] text-white cursor-pointer transition"
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
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className={`fixed z-50 min-w-52 rounded-lg border py-1 shadow-2xl text-xs backdrop-blur-md ${isDark ? "border-neutral-800 bg-neutral-900/95 text-neutral-200" : "border-neutral-300 bg-white/95 text-neutral-800"
            }`}
        >
          {contextMenu.isRemote ? (
            <>
              {!contextMenu.entry.is_dir && (
                <button
                  onClick={() => {
                    handleOpenWithSystem(contextMenu.entry);
                    setContextMenu(null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-sky-500/20 cursor-pointer"
                >
                  <ExternalLink className="h-3.5 w-3.5 text-amber-500" />
                  <span>Ouvrir avec Windows...</span>
                </button>
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
                    const out = await invoke<string>("exec_remote_command", { command: `du -sh "${entry.path}"` });
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
                checkAndEnqueueTransfer(contextMenu.entry.name, contextMenu.entry.path, remotePath, "upload", contextMenu.entry.is_dir);
                setContextMenu(null);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-sky-500/20 cursor-pointer"
            >
              <Upload className="h-3.5 w-3.5 text-sky-500" />
              <span>Envoyer sur le serveur</span>
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
                    await invoke("delete_remote", { path: entry.path, isDir: entry.is_dir });
                    logMessage(`DELE ${entry.path}`);
                    loadRemoteDirectory(remotePath);
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

      {/* Modale Paramètres */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div
            className={`w-[600px] h-[400px] flex flex-col rounded-xl border shadow-2xl overflow-hidden ${isDark ? "border-neutral-800 bg-neutral-900 text-neutral-200" : "border-neutral-300 bg-white text-neutral-800"
              }`}
          >
            <div className="flex items-center justify-between border-b px-4 py-2.5 border-neutral-500/20">
              <span className="font-semibold text-sm flex items-center gap-2 text-sky-500">
                <Settings className="h-4 w-4" />
                Paramètres
              </span>
              <button onClick={() => setShowSettings(false)} className="text-neutral-400 hover:text-white cursor-pointer">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex flex-1 overflow-hidden">
              <div className={`w-44 border-r p-2 space-y-1 ${isDark ? "border-neutral-800 bg-neutral-950/40" : "border-neutral-200 bg-neutral-50"}`}>
                <button
                  onClick={() => setSettingsTab("general")}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded text-xs cursor-pointer transition ${settingsTab === "general" ? "bg-sky-600 text-white font-medium" : "hover:bg-neutral-500/10 text-neutral-400"
                    }`}
                >
                  <Sliders className="h-3.5 w-3.5" />
                  <span>Affichage & Thème</span>
                </button>
                <button
                  onClick={() => setSettingsTab("panels")}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded text-xs cursor-pointer transition ${settingsTab === "panels" ? "bg-sky-600 text-white font-medium" : "hover:bg-neutral-500/10 text-neutral-400"
                    }`}
                >
                  <Folder className="h-3.5 w-3.5" />
                  <span>Panneaux & Outils</span>
                </button>
                <button
                  onClick={() => setSettingsTab("about")}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded text-xs cursor-pointer transition ${settingsTab === "about" ? "bg-sky-600 text-white font-medium" : "hover:bg-neutral-500/10 text-neutral-400"
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
                        className={`w-full rounded border px-3 py-1.5 focus:outline-none cursor-pointer ${isDark ? "bg-neutral-950 border-neutral-700 text-neutral-100" : "bg-neutral-50 border-neutral-300"
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
                        className={`w-full rounded border px-3 py-1.5 focus:outline-none ${isDark ? "bg-neutral-950 border-neutral-700 text-neutral-100" : "bg-neutral-50 border-neutral-300"
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
                className="px-4 py-1.5 rounded bg-sky-600 font-semibold text-xs text-white hover:bg-sky-500 cursor-pointer"
              >
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modale Conflit */}
      {conflictModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
          <div
            className={`w-96 rounded-xl border p-5 shadow-2xl space-y-4 ${isDark ? "border-neutral-800 bg-neutral-900 text-neutral-200" : "border-neutral-300 bg-white text-neutral-800"
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
                className="w-full py-1.5 rounded bg-rose-600 font-semibold text-xs text-white hover:bg-rose-500 cursor-pointer transition"
              >
                Écraser le fichier cible
              </button>
              <button
                onClick={() => conflictModal.onResolve("rename")}
                className="w-full py-1.5 rounded border border-neutral-700 font-semibold text-xs text-sky-500 hover:bg-neutral-500/10 cursor-pointer transition"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
          <div
            className={`w-80 rounded-xl border p-5 shadow-2xl space-y-4 ${isDark ? "border-neutral-800 bg-neutral-900 text-neutral-200" : "border-neutral-300 bg-white text-neutral-800"
              }`}
          >
            <div className="flex items-center justify-between border-b pb-2 border-neutral-500/20">
              <span className="font-semibold text-sm">{inputModal.title}</span>
              <button onClick={() => setInputModal(null)} className="text-neutral-400 hover:text-white cursor-pointer">
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
                className={`w-full rounded border px-3 py-1.5 text-xs focus:outline-none ${isDark ? "bg-neutral-950 border-neutral-700 text-neutral-100" : "bg-neutral-50 border-neutral-300"
                  }`}
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setInputModal(null)}
                className="px-3 py-1.5 rounded border border-neutral-700 text-xs text-neutral-400 hover:bg-neutral-500/10 cursor-pointer"
              >
                Annuler
              </button>
              <button
                onClick={() => {
                  inputModal.onConfirm(inputModal.value);
                  setInputModal(null);
                }}
                className="px-3 py-1.5 rounded bg-sky-600 font-semibold text-xs text-white hover:bg-sky-500 cursor-pointer"
              >
                Valider
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modale Confirmation */}
      {confirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
          <div
            className={`w-80 rounded-xl border p-5 shadow-2xl space-y-4 ${isDark ? "border-neutral-800 bg-neutral-900 text-neutral-200" : "border-neutral-300 bg-white text-neutral-800"
              }`}
          >
            <div className="flex items-center justify-between border-b pb-2 border-neutral-500/20">
              <span className="font-semibold text-sm">{confirmModal.title}</span>
              <button onClick={() => setConfirmModal(null)} className="text-neutral-400 hover:text-white cursor-pointer">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-xs text-neutral-400 leading-relaxed">{confirmModal.message}</p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setConfirmModal(null)}
                className="px-3 py-1.5 rounded border border-neutral-700 text-xs text-neutral-400 hover:bg-neutral-500/10 cursor-pointer"
              >
                Annuler
              </button>
              <button
                onClick={() => {
                  confirmModal.onConfirm();
                  setConfirmModal(null);
                }}
                className="px-3 py-1.5 rounded bg-rose-600 font-semibold text-xs text-white hover:bg-rose-500 cursor-pointer"
              >
                Confirmer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modale CHMOD */}
      {chmodModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-6">
          <div
            className={`w-80 rounded-xl border p-5 shadow-2xl space-y-4 ${isDark ? "border-neutral-800 bg-neutral-900 text-neutral-200" : "border-neutral-300 bg-white text-neutral-800"
              }`}
          >
            <div className="flex items-center justify-between border-b border-neutral-500/20 pb-3">
              <span className="font-semibold text-sm flex items-center gap-2 text-sky-500">
                <ShieldCheck className="h-4 w-4" /> Permissions (CHMOD)
              </span>
              <button onClick={() => setChmodModal(null)} className="text-neutral-400 hover:text-white cursor-pointer">
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
                className={`w-full text-center font-mono text-lg rounded border py-1.5 text-sky-500 focus:outline-none ${isDark ? "bg-neutral-950 border-neutral-700" : "bg-neutral-50 border-neutral-300"
                  }`}
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setChmodModal(null)}
                className="px-3 py-1.5 rounded border border-neutral-700 text-xs text-neutral-400 hover:bg-neutral-500/10 cursor-pointer"
              >
                Annuler
              </button>
              <button
                onClick={handleApplyChmod}
                className="px-3 py-1.5 rounded bg-sky-600 font-semibold text-xs text-white hover:bg-sky-500 cursor-pointer"
              >
                Appliquer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modale Gestionnaire de sites */}
      {showSiteManager && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div
            className={`flex h-[520px] w-[750px] flex-col rounded-xl border shadow-2xl overflow-hidden ${isDark ? "border-neutral-800 bg-neutral-900 text-neutral-200" : "border-neutral-300 bg-white text-neutral-800"
              }`}
          >
            <div className="flex items-center justify-between border-b border-neutral-500/20 px-4 py-3">
              <span className="font-semibold text-sm flex items-center gap-2 text-sky-500">
                <SlidersHorizontal className="h-4 w-4" />
                Gestionnaire de sites
              </span>
              <button onClick={() => setShowSiteManager(false)} className="text-neutral-400 hover:text-neutral-200 cursor-pointer">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex flex-1 overflow-hidden">
              <div
                className={`w-56 border-r border-neutral-500/20 p-3 flex flex-col justify-between ${isDark ? "bg-neutral-950/40" : "bg-neutral-50"
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
                      className={`flex items-center gap-2 px-2.5 py-1.5 rounded cursor-pointer text-xs transition ${selectedSiteId === site.id
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
                    className="flex flex-1 items-center justify-center gap-1 py-1.5 rounded border border-neutral-700 hover:bg-neutral-500/10 text-xs cursor-pointer"
                  >
                    <Plus className="h-3 w-3" /> Nouveau
                  </button>
                  {selectedSiteId && (
                    <button
                      onClick={() => {
                        setSites(sites.filter((s) => s.id !== selectedSiteId));
                        setSelectedSiteId(null);
                      }}
                      className="px-2 py-1.5 rounded border border-rose-500/30 text-rose-500 hover:bg-rose-500/10 text-xs cursor-pointer"
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
                          className={`w-full rounded border px-3 py-1.5 focus:outline-none ${isDark ? "bg-neutral-950 border-neutral-700" : "bg-neutral-50 border-neutral-300"
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
                          className={`w-full rounded border px-3 py-1.5 focus:outline-none cursor-pointer ${isDark ? "bg-neutral-950 border-neutral-700" : "bg-neutral-50 border-neutral-300"
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
                          className={`w-full rounded border px-3 py-1.5 focus:outline-none ${isDark ? "bg-neutral-950 border-neutral-700" : "bg-neutral-50 border-neutral-300"
                            }`}
                        />
                      </div>
                      <div>
                        <label className="block text-neutral-400 mb-1">Port</label>
                        <input
                          type="text"
                          value={siteForm.port}
                          onChange={(e) => setSiteForm({ ...siteForm, port: e.target.value })}
                          className={`w-full rounded border px-3 py-1.5 text-center focus:outline-none ${isDark ? "bg-neutral-950 border-neutral-700" : "bg-neutral-50 border-neutral-300"
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
                            className={`w-full rounded border px-3 py-1.5 focus:outline-none ${isDark ? "bg-neutral-950 border-neutral-700" : "bg-neutral-50 border-neutral-300"
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
                              className={`w-full rounded border px-3 py-1.5 focus:outline-none ${isDark ? "bg-neutral-950 border-neutral-700" : "bg-neutral-50 border-neutral-300"
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
                                className={`w-full rounded border px-3 py-1.5 font-mono text-[11px] focus:outline-none ${isDark ? "bg-neutral-950 border-neutral-700" : "bg-neutral-50 border-neutral-300"
                                  }`}
                              />
                            </div>
                            <div>
                              <label className="block text-neutral-400 mb-1">Passphrase</label>
                              <input
                                type="password"
                                value={siteForm.passphrase || ""}
                                onChange={(e) => setSiteForm({ ...siteForm, passphrase: e.target.value })}
                                className={`w-full rounded border px-3 py-1.5 focus:outline-none ${isDark ? "bg-neutral-950 border-neutral-700" : "bg-neutral-50 border-neutral-300"
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
                className="px-3 py-1.5 rounded border border-neutral-700 text-xs hover:bg-neutral-500/10 cursor-pointer"
              >
                Enregistrer
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowSiteManager(false)}
                  className="px-3 py-1.5 rounded border border-neutral-700 text-xs hover:bg-neutral-500/10 cursor-pointer"
                >
                  Fermer
                </button>
                <button
                  onClick={() => {
                    if (selectedSiteId) {
                      setSites(sites.map((s) => (s.id === selectedSiteId ? siteForm : s)));
                      setShowSiteManager(false);
                      connectToServer(
                        siteForm.protocol,
                        siteForm.host,
                        siteForm.port,
                        siteForm.username,
                        siteForm.authType,
                        siteForm.password,
                        siteForm.keyPath,
                        siteForm.passphrase
                      );
                    }
                  }}
                  className="px-4 py-1.5 rounded bg-sky-600 font-semibold text-xs text-white hover:bg-sky-500 cursor-pointer"
                >
                  Connexion
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
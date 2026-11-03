import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Server,
  Folder,
  FileText,
  Terminal,
  ArrowRightLeft,
  HardDrive,
  RefreshCw,
  ArrowUp
} from "lucide-react";

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

export default function App() {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isConnected, setIsConnected] = useState(false);

  // État navigateur local
  const [currentPath, setCurrentPath] = useState<string>("");
  const [files, setFiles] = useState<FileEntry[]>([]);

  // État navigateur distant
  const [remotePath, setRemotePath] = useState<string>("/");
  const [remoteFiles, setRemoteFiles] = useState<FileEntry[]>([]);

  // Logs
  const [logs, setLogs] = useState<string[]>([
    "Gens-RFT initialisé. Prêt pour la connexion.",
  ]);

  const loadLocalDirectory = async (targetPath?: string) => {
    try {
      const result = await invoke<FileEntry[]>("read_local_dir", { path: targetPath || null });
      setFiles(result);
      if (targetPath) {
        setCurrentPath(targetPath);
      }
    } catch (err) {
      setLogs((prev) => [...prev, `[Erreur FS Local] : ${err}`]);
    }
  };

  const loadRemoteDirectory = async (targetPath?: string) => {
    try {
      const result = await invoke<FileEntry[]>("list_remote_dir", {
        path: targetPath || null,
      });
      setRemoteFiles(result);
      if (targetPath) {
        setRemotePath(targetPath);
      }
    } catch (err) {
      setLogs((prev) => [...prev, `[Erreur Distant] : ${err}`]);
    }
  };

  const handleConnect = async () => {
    if (!host || !username) {
      setLogs((prev) => [...prev, "[Erreur] : Hôte et nom d'utilisateur requis."]);
      return;
    }

    setLogs((prev) => [...prev, `Connexion à ${username}@${host}:${port}...`]);

    try {
      const msg = await invoke<string>("connect_sftp", {
        host,
        port: parseInt(port, 10) || 22,
        username,
        password: password || null,
      });

      setLogs((prev) => [...prev, `[Succès] : ${msg}`]);
      setIsConnected(true);

      await loadRemoteDirectory("/");
    } catch (err) {
      setLogs((prev) => [...prev, `[Erreur SFTP] : ${err}`]);
    }
  };

  useEffect(() => {
    loadLocalDirectory();
  }, []);

  const handleLocalClick = (entry: FileEntry) => {
    if (entry.is_dir) {
      loadLocalDirectory(entry.path);
    }
  };

  const handleRemoteClick = (entry: FileEntry) => {
    if (entry.is_dir) {
      loadRemoteDirectory(entry.path);
    }
  };

  const handleGoUpLocal = () => {
    if (!currentPath) return;
    const separator = currentPath.includes("/") ? "/" : "\\";
    const parts = currentPath.split(separator).filter(Boolean);
    if (parts.length > 1) {
      parts.pop();
      const parentPath = currentPath.startsWith("/")
        ? "/" + parts.join("/")
        : parts.join("\\");
      loadLocalDirectory(parentPath);
    }
  };

  const handleGoUpRemote = () => {
    if (remotePath === "/" || !remotePath) return;
    const parts = remotePath.split("/").filter(Boolean);
    parts.pop();
    const parentPath = "/" + parts.join("/");
    loadRemoteDirectory(parentPath);
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-neutral-950 font-sans text-neutral-200 select-none">
      {/* Top Bar : Quick Connect */}
      <header className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-900/80 px-4 py-2.5 backdrop-blur">
        <div className="flex items-center gap-2 font-bold tracking-wide text-sky-400 mr-2 shrink-0">
          <ArrowRightLeft className="h-5 w-5" />
          <span>Gens-RFT</span>
        </div>

        <input
          type="text"
          placeholder="Hôte / IP"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-xs text-neutral-100 placeholder-neutral-500 focus:border-sky-500 focus:outline-none w-44"
        />

        <input
          type="text"
          placeholder="Port"
          value={port}
          onChange={(e) => setPort(e.target.value)}
          className="rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100 placeholder-neutral-500 focus:border-sky-500 focus:outline-none w-14 text-center"
        />

        <input
          type="text"
          placeholder="Utilisateur"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-xs text-neutral-100 placeholder-neutral-500 focus:border-sky-500 focus:outline-none w-32"
        />

        <input
          type="password"
          placeholder="Mot de passe"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-xs text-neutral-100 placeholder-neutral-500 focus:border-sky-500 focus:outline-none w-32"
        />

        <button
          onClick={handleConnect}
          className="flex items-center gap-1.5 rounded-md bg-sky-600 px-4 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-sky-500 transition ml-auto"
        >
          <Server className="h-3.5 w-3.5" /> Connexion
        </button>
      </header>

      {/* Main Split-Pane */}
      <div className="flex flex-1 overflow-hidden">
        {/* Explorateur Local */}
        <section className="flex flex-1 flex-col border-r border-neutral-800 bg-neutral-950/60">
          <div className="flex items-center justify-between border-b border-neutral-800/80 px-4 py-2 text-xs font-medium text-neutral-400 bg-neutral-900/40">
            <div className="flex items-center gap-2 text-neutral-200">
              <HardDrive className="h-4 w-4 text-emerald-400" />
              <span>Site Local</span>
              <button
                onClick={handleGoUpLocal}
                className="ml-2 p-1 rounded hover:bg-neutral-800 text-neutral-400 hover:text-neutral-100 transition"
                title="Dossier parent"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
            </div>
            <span className="font-mono text-neutral-500 text-[11px] truncate max-w-[220px]">
              {currentPath || "Racine"}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto p-2 font-mono text-xs">
            {files.map((item, index) => (
              <div
                key={index}
                onDoubleClick={() => handleLocalClick(item)}
                className="flex items-center justify-between rounded px-2 py-1.5 hover:bg-neutral-800/60 cursor-pointer group"
              >
                <div className="flex items-center gap-2.5 truncate">
                  {item.is_dir ? (
                    <Folder className="h-4 w-4 text-amber-400 shrink-0" />
                  ) : (
                    <FileText className="h-4 w-4 text-neutral-400 shrink-0" />
                  )}
                  <span className="truncate group-hover:text-neutral-100">{item.name}</span>
                </div>
                {!item.is_dir && (
                  <span className="text-[11px] text-neutral-500 font-sans">
                    {(item.size / 1024).toFixed(1)} Ko
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Explorateur Distant */}
        <section className="flex flex-1 flex-col bg-neutral-950/40">
          <div className="flex items-center justify-between border-b border-neutral-800/80 px-4 py-2 text-xs font-medium text-neutral-400 bg-neutral-900/40">
            <div className="flex items-center gap-2 text-neutral-200">
              <Server className="h-4 w-4 text-sky-400" />
              <span>Site Distant</span>
              {isConnected && (
                <button
                  onClick={handleGoUpRemote}
                  className="ml-2 p-1 rounded hover:bg-neutral-800 text-neutral-400 hover:text-neutral-100 transition"
                  title="Dossier parent distant"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <span className="font-mono text-neutral-500 text-[11px] truncate max-w-[220px]">
              {isConnected ? remotePath : "Non connecté"}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto p-2 font-mono text-xs">
            {!isConnected ? (
              <div className="flex h-full items-center justify-center text-xs text-neutral-500 font-sans">
                Pas de session active
              </div>
            ) : (
              remoteFiles.map((item, index) => (
                <div
                  key={index}
                  onDoubleClick={() => handleRemoteClick(item)}
                  className="flex items-center justify-between rounded px-2 py-1.5 hover:bg-neutral-800/60 cursor-pointer group"
                >
                  <div className="flex items-center gap-2.5 truncate">
                    {item.is_dir ? (
                      <Folder className="h-4 w-4 text-sky-400 shrink-0" />
                    ) : (
                      <FileText className="h-4 w-4 text-neutral-400 shrink-0" />
                    )}
                    <span className="truncate group-hover:text-neutral-100">{item.name}</span>
                  </div>
                  {!item.is_dir && (
                    <span className="text-[11px] text-neutral-500 font-sans">
                      {(item.size / 1024).toFixed(1)} Ko
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      {/* Bottom Console : Logs */}
      <footer className="h-36 border-t border-neutral-800 bg-neutral-900/90 flex flex-col">
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-1.5 text-[11px] font-semibold text-neutral-400">
          <div className="flex items-center gap-1.5">
            <Terminal className="h-3.5 w-3.5 text-neutral-400" />
            <span>Journal de transfert & commandes</span>
          </div>
          <button
            onClick={() => setLogs([])}
            className="hover:text-neutral-200 transition"
            title="Effacer"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 font-mono text-[11px] space-y-1 text-neutral-300">
          {logs.map((log, idx) => (
            <div key={idx} className="flex gap-2">
              <span className="text-neutral-500">&gt;</span>
              <span>{log}</span>
            </div>
          ))}
        </div>
      </footer>
    </div>
  );
}
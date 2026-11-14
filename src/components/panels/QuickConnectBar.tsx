import React, { useRef, useEffect } from "react";
import { SlidersHorizontal, Settings, Server, Unplug, ChevronDown } from "lucide-react";
import { QuickHistoryItem, TabSession } from "../../types";

interface Props {
  isDark: boolean;
  activeTab: TabSession;
  quickHost: string;
  setQuickHost: (val: string) => void;
  quickPort: string;
  setQuickPort: (val: string) => void;
  quickUser: string;
  setQuickUser: (val: string) => void;
  quickPass: string;
  setQuickPass: (val: string) => void;
  quickHistory: QuickHistoryItem[];
  setQuickHistory: React.Dispatch<React.SetStateAction<QuickHistoryItem[]>>;
  showQuickHistoryDropdown: boolean;
  setShowQuickHistoryDropdown: (val: boolean) => void;
  showSiteManager: boolean;
  setShowSiteManager: (val: boolean) => void;
  showSettings: boolean;
  setShowSettings: (val: boolean) => void;
  onConnectRequest: (
    protocol: "SFTP" | "FTP" | "FTPS",
    host: string,
    port: string,
    username: string,
    authType: "password" | "key",
    password?: string
  ) => void;
  onDisconnect: (sessionId: string) => void;
}

export default function QuickConnectBar({
  isDark,
  activeTab,
  quickHost,
  setQuickHost,
  quickPort,
  setQuickPort,
  quickUser,
  setQuickUser,
  quickPass,
  setQuickPass,
  quickHistory,
  setQuickHistory,
  showQuickHistoryDropdown,
  setShowQuickHistoryDropdown,
  showSiteManager,
  setShowSiteManager,
  showSettings,
  setShowSettings,
  onConnectRequest,
  onDisconnect,
}: Props) {
  const quickHistoryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showQuickHistoryDropdown) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (quickHistoryRef.current && !quickHistoryRef.current.contains(e.target as Node)) {
        setShowQuickHistoryDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showQuickHistoryDropdown, setShowQuickHistoryDropdown]);

  const handleQuickConnect = () => {
    let host = quickHost.trim();
    let port = quickPort.trim();
    let protocol: "SFTP" | "FTP" | "FTPS" = "SFTP";

    if (host.toLowerCase().startsWith("ftps://")) {
      protocol = "FTPS";
      host = host.substring(7);
      if (!port || port === "22") port = "21";
    } else if (host.toLowerCase().startsWith("ftp://")) {
      protocol = "FTP";
      host = host.substring(6);
      if (!port || port === "22") port = "21";
    } else if (host.toLowerCase().startsWith("sftp://")) {
      protocol = "SFTP";
      host = host.substring(7);
      if (!port || port === "21") port = "22";
    } else if (port === "21") {
      protocol = "FTP";
    } else if (port === "990") {
      protocol = "FTPS";
    }

    // Support [ipv6]:port ou host:port (en préservant les adresses IPv6 brutes)
    const hostPortMatch = host.match(/^(?:\[([a-fA-F0-9:]+)\]|([^:]+)):(\d+)$/);
    if (hostPortMatch) {
      host = hostPortMatch[1] || hostPortMatch[2];
      port = hostPortMatch[3];
    } else if (host.startsWith("[") && host.endsWith("]")) {
      host = host.slice(1, -1);
    }

    onConnectRequest(
      protocol,
      host,
      port || (protocol === "FTP" || protocol === "FTPS" ? "21" : "22"),
      quickUser.trim(),
      "password",
      quickPass
    );
  };

  return (
    <header
      className={`flex items-center justify-between border-b px-4 py-2 gap-4 ${
        isDark ? "border-neutral-800 bg-neutral-900/90 text-neutral-200" : "border-neutral-200 bg-white text-neutral-800"
      }`}
    >
      <div className="flex items-center gap-2">
        <button
          onClick={() => setShowSiteManager(!showSiteManager)}
          className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold shadow-xs transition duration-150 active:scale-95 cursor-pointer ${
            showSiteManager
              ? "border-sky-500 bg-sky-600 text-white"
              : isDark
              ? "border-neutral-700 bg-neutral-800 text-neutral-200 hover:bg-neutral-700 hover:text-white"
              : "border-neutral-300 bg-neutral-100 text-neutral-800 hover:bg-neutral-200"
          }`}
          title="Gestionnaire de profils serveurs"
        >
          <SlidersHorizontal className="h-3.5 w-3.5 text-sky-400" />
          <span className="font-medium">Gestionnaire de sites</span>
        </button>

        <button
          onClick={() => setShowSettings(!showSettings)}
          className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold shadow-xs transition duration-150 active:scale-95 cursor-pointer ${
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
          onKeyDown={(e) => e.key === "Enter" && handleQuickConnect()}
          className="bg-transparent px-2.5 py-1 text-xs placeholder-neutral-500 focus:outline-none flex-1 min-w-[90px] border-r border-neutral-700/50"
        />
        <input
          type="text"
          placeholder="Port"
          value={quickPort}
          onChange={(e) => setQuickPort(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleQuickConnect()}
          className="bg-transparent px-1.5 py-1 text-xs placeholder-neutral-500 focus:outline-none w-12 text-center border-r border-neutral-700/50 shrink-0"
        />
        <input
          type="text"
          placeholder="Utilisateur"
          value={quickUser}
          onChange={(e) => setQuickUser(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleQuickConnect()}
          className="bg-transparent px-2.5 py-1 text-xs placeholder-neutral-500 focus:outline-none flex-1 min-w-[80px] border-r border-neutral-700/50"
        />
        <input
          type="password"
          placeholder="Mot de passe"
          value={quickPass}
          onChange={(e) => setQuickPass(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleQuickConnect()}
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
            onClick={() => onDisconnect(activeTab.id)}
            className="flex items-center gap-1.5 rounded bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white shadow hover:bg-rose-500 active:scale-95 cursor-pointer transition duration-150"
            title="Déconnecter la session courante"
          >
            <Unplug className="h-3.5 w-3.5" />
            <span>Déconnecter</span>
          </button>
        ) : (
          <div className="relative flex items-center" ref={quickHistoryRef}>
            <div className="flex rounded shadow overflow-hidden">
              <button
                onClick={handleQuickConnect}
                className="flex items-center gap-1.5 bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 active:scale-95 cursor-pointer transition duration-150"
                title="Connexion rapide"
              >
                <Server className="h-3.5 w-3.5" />
                <span>Connecter</span>
              </button>
              <button
                onClick={() => setShowQuickHistoryDropdown(!showQuickHistoryDropdown)}
                className="bg-sky-700 hover:bg-sky-600 px-1.5 py-1.5 text-white border-l border-sky-500/40 cursor-pointer transition"
                title="Historique des connexions rapides"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Menu déroulant de l'historique rapide */}
            {showQuickHistoryDropdown && (
              <div
                className={`absolute right-0 top-full mt-1.5 w-72 rounded-xl border shadow-2xl py-1.5 z-50 animate-in fade-in zoom-in-95 duration-100 ${
                  isDark ? "bg-neutral-900 border-neutral-700 text-neutral-200" : "bg-white border-neutral-300 text-neutral-800"
                }`}
              >
                <div className="px-3 py-1 text-[10px] font-semibold text-neutral-500 uppercase tracking-wider border-b border-neutral-700/40 flex justify-between items-center">
                  <span>Connexions récentes</span>
                  {quickHistory.length > 0 && (
                    <button
                      onClick={() => {
                        setQuickHistory([]);
                        localStorage.removeItem("gens_rft_quick_history");
                      }}
                      className="text-[10px] text-neutral-400 hover:text-rose-400 cursor-pointer"
                    >
                      Effacer
                    </button>
                  )}
                </div>
                {quickHistory.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-neutral-500 text-center">Aucune connexion récente</div>
                ) : (
                  quickHistory.map((item, idx) => (
                    <div
                      key={idx}
                      onClick={() => {
                        setQuickHost(item.host);
                        setQuickPort(item.port);
                        setQuickUser(item.username);
                        setShowQuickHistoryDropdown(false);
                      }}
                      className="px-3 py-1.5 hover:bg-neutral-500/10 cursor-pointer flex items-center justify-between text-xs transition"
                    >
                      <div className="truncate">
                        <span className="font-semibold text-sky-400">{item.username}</span>
                        <span className="text-neutral-400">@{item.host}</span>
                        <span className="text-[10px] text-neutral-500">:{item.port}</span>
                      </div>
                      <span className="text-[10px] font-mono px-1 rounded bg-neutral-800 text-neutral-400">
                        {item.protocol}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}

import React, { useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Server,
  Star,
  Edit2,
  Search,
  ChevronLeft,
  ChevronRight,
  ArrowUp,
  FolderPlus,
  ArrowUpDown,
  Folder,
  Download,
  ExternalLink,
  X,
} from "lucide-react";
import DirectoryTree from "../../DirectoryTree";
import { FileEntry, SortField, SortOrder, TabSession } from "../../types";
import { getFileBadge, formatFileSize, formatOctalPermissions } from "../../utils/fileHelpers";

interface Props {
  isDark: boolean;
  localPaneWidth: number;
  setLocalPaneWidth: (val: number) => void;
  activeTab: TabSession;
  processedRemoteFiles: FileEntry[];
  bookmarks: string[];
  setBookmarks: (val: string[]) => void;
  showBookmarksMenu: boolean;
  setShowBookmarksMenu: (val: boolean) => void;
  isEditingRemotePath: boolean;
  setIsEditingRemotePath: (val: boolean) => void;
  remotePathInput: string;
  setRemotePathInput: (val: string) => void;
  remoteSearch: string;
  setRemoteSearch: (val: string) => void;
  remoteSort: { field: SortField; order: SortOrder };
  setRemoteSort: React.Dispatch<React.SetStateAction<{ field: SortField; order: SortOrder }>>;
  showTreePanels: boolean;
  treeHeight: number;
  setTreeHeight: React.Dispatch<React.SetStateAction<number>>;
  showHidden: boolean;
  selectedRemotePaths: Set<string>;
  setSelectedRemotePaths: React.Dispatch<React.SetStateAction<Set<string>>>;
  selectedLocalPaths: Set<string>;
  files: FileEntry[];
  currentPath: string;
  draggedItem: { entry: FileEntry; from: "local" | "remote"; fromSessionId?: string } | null;
  setDraggedItem: (val: { entry: FileEntry; from: "local" | "remote"; fromSessionId?: string } | null) => void;
  isOverRemote: boolean;
  setIsOverRemote: (val: boolean) => void;
  setIsOverLocal: (val: boolean) => void;
  setDragOverTabId: (val: string | null) => void;
  setActivePane: (pane: "local" | "remote") => void;
  onNavigateRemote: (targetPath?: string, targetSessionId?: string, recordHistory?: boolean) => void;
  onRemoteHistoryBack: () => void;
  onRemoteHistoryForward: () => void;
  onCheckAndEnqueueTransfer: (
    filename: string,
    sourcePath: string,
    destDir: string,
    direction: "upload" | "download",
    isDir: boolean,
    destSessionId?: string
  ) => void;
  onOpenContextMenu: (e: React.MouseEvent, entry: FileEntry | null, isRemote: boolean) => void;
  onPromptInputModal: (modal: {
    title: string;
    label: string;
    value: string;
    onConfirm: (val: string) => void;
  }) => void;
  logMessage: (msg: string) => void;
}

export default function RemotePane({
  isDark,
  localPaneWidth,
  setLocalPaneWidth,
  activeTab,
  processedRemoteFiles,
  bookmarks,
  setBookmarks,
  showBookmarksMenu,
  setShowBookmarksMenu,
  isEditingRemotePath,
  setIsEditingRemotePath,
  remotePathInput,
  setRemotePathInput,
  remoteSearch,
  setRemoteSearch,
  remoteSort,
  setRemoteSort,
  showTreePanels,
  treeHeight,
  setTreeHeight,
  showHidden,
  selectedRemotePaths,
  setSelectedRemotePaths,
  selectedLocalPaths,
  files,
  currentPath,
  draggedItem,
  setDraggedItem,
  isOverRemote,
  setIsOverRemote,
  setIsOverLocal,
  setDragOverTabId,
  setActivePane,
  onNavigateRemote,
  onRemoteHistoryBack,
  onRemoteHistoryForward,
  onCheckAndEnqueueTransfer,
  onOpenContextMenu,
  onPromptInputModal,
  logMessage,
}: Props) {
  const bookmarksRef = useRef<HTMLDivElement>(null);
  const lastSelectedRemoteIndexRef = useRef<number | null>(null);

  const currentRemoteIndex = activeTab.remoteHistoryIndex ?? 0;
  const currentRemoteHistory = activeTab.remoteHistory || ["/"];

  return (
    <>
      {/* Séparateur Redimensionnable horizontal */}
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
            const items =
              selectedLocalPaths.has(draggedItem.entry.path) && selectedLocalPaths.size > 1
                ? files.filter((f) => selectedLocalPaths.has(f.path))
                : [draggedItem.entry];
            for (const it of items) {
              onCheckAndEnqueueTransfer(
                it.name,
                it.path,
                activeTab.remotePath,
                "upload",
                it.is_dir
              );
            }
            setDraggedItem(null);
          } else if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
            if (!activeTab.isConnected) {
              logMessage("Erreur : Impossible d'envoyer des fichiers, serveur déconnecté.");
              return;
            }
            const dropFiles = Array.from(e.dataTransfer.files);
            let count = 0;
            for (const file of dropFiles) {
              const filePath = (file as any).path || (file as any).webkitRelativePath || "";
              if (filePath) {
                onCheckAndEnqueueTransfer(
                  file.name,
                  filePath,
                  activeTab.remotePath,
                  "upload",
                  false
                );
                count++;
              }
            }
            if (count > 0) {
              logMessage(`Glisser-déposer externe : ${count} fichier(s) ajouté(s) à la file d'attente.`);
            }
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
                            if (activeTab.isConnected) onNavigateRemote(bPath);
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

            {/* Chemin distant éditable */}
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
                      onNavigateRemote(remotePathInput.trim());
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
                <div className="flex items-center gap-0.5">
                  <button
                    onClick={onRemoteHistoryBack}
                    disabled={currentRemoteIndex <= 0}
                    className="rounded p-1 hover:bg-neutral-500/20 cursor-pointer transition active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed"
                    title="Dossier distant précédent"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={onRemoteHistoryForward}
                    disabled={currentRemoteIndex >= currentRemoteHistory.length - 1}
                    className="rounded p-1 hover:bg-neutral-500/20 cursor-pointer transition active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed"
                    title="Dossier distant suivant"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
                <button
                  onClick={() => {
                    const parts = activeTab.remotePath.split("/").filter(Boolean);
                    parts.pop();
                    onNavigateRemote("/" + parts.join("/"));
                  }}
                  className="rounded p-1 hover:bg-neutral-500/20 cursor-pointer transition active:scale-95"
                  title="Dossier parent"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => {
                    onPromptInputModal({
                      title: "Nouveau dossier distant",
                      label: "Nom du dossier :",
                      value: "nouveau_dossier",
                      onConfirm: async (val) => {
                        const dirName = val.trim();
                        if (!dirName) return;
                        const sep = activeTab.remotePath.endsWith("/") ? "" : "/";
                        try {
                          await invoke("create_remote_dir", {
                            sessionId: activeTab.id,
                            path: `${activeTab.remotePath}${sep}${dirName}`,
                          });
                          logMessage(`MKD ${activeTab.remotePath}${sep}${dirName}`);
                          onNavigateRemote(activeTab.remotePath);
                        } catch (err) {
                          logMessage(`550 Échec création dossier distant : ${err}`);
                        }
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
                  onNavigate={onNavigateRemote}
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
        <div
          onClick={() => {
            setActivePane("remote");
            setSelectedRemotePaths(new Set());
          }}
          onContextMenu={(e) => {
            if (!activeTab.isConnected) return;
            e.preventDefault();
            setActivePane("remote");
            onOpenContextMenu(e, null, true);
          }}
          className="flex-1 overflow-y-auto font-mono text-xs divide-y divide-neutral-500/10 min-h-[100px]"
        >
          {!activeTab.isConnected ? (
            <div className="flex h-full flex-col items-center justify-center text-xs text-neutral-500 gap-2 font-sans">
              <Server className="h-8 w-8 text-neutral-500" />
              <span>Absence de connexion à un serveur</span>
            </div>
          ) : (
            processedRemoteFiles.map((item, index) => {
              const badge = getFileBadge(item.name, isDark);
              const isSelected = selectedRemotePaths.has(item.path);
              return (
                <div
                  key={item.path}
                  draggable
                  onClick={(e) => {
                    e.stopPropagation();
                    setActivePane("remote");
                    if (e.shiftKey && lastSelectedRemoteIndexRef.current !== null) {
                      const start = Math.min(lastSelectedRemoteIndexRef.current, index);
                      const end = Math.max(lastSelectedRemoteIndexRef.current, index);
                      const rangePaths = processedRemoteFiles.slice(start, end + 1).map((f) => f.path);
                      setSelectedRemotePaths(new Set(rangePaths));
                    } else if (e.ctrlKey || e.metaKey) {
                      lastSelectedRemoteIndexRef.current = index;
                      setSelectedRemotePaths((prev) => {
                        const next = new Set(prev);
                        if (next.has(item.path)) next.delete(item.path);
                        else next.add(item.path);
                        return next;
                      });
                    } else {
                      lastSelectedRemoteIndexRef.current = index;
                      setSelectedRemotePaths(new Set([item.path]));
                    }
                  }}
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
                      onNavigateRemote(item.path);
                    } else {
                      onCheckAndEnqueueTransfer(item.name, item.path, currentPath, "download", false);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setActivePane("remote");
                    if (!selectedRemotePaths.has(item.path)) {
                      setSelectedRemotePaths(new Set([item.path]));
                    }
                    onOpenContextMenu(e, item, true);
                  }}
                  className={`grid grid-cols-12 items-center px-3 py-1.5 cursor-pointer group transition duration-75 border-l-2 select-none ${
                    isSelected
                      ? isDark
                        ? "bg-sky-500/20 border-sky-400 font-medium"
                        : "bg-sky-100 border-sky-600 font-medium"
                      : "border-transparent hover:bg-sky-500/10"
                  }`}
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
                    {formatOctalPermissions(item.permissions)}
                  </div>

                  <div className="col-span-5 sm:col-span-3 text-right text-[11px] text-neutral-500 font-sans">
                    {!item.is_dir ? formatFileSize(item.size) : "--"}
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
                          className="opacity-0 group-hover:opacity-100 rounded p-1 text-neutral-400 hover:text-amber-400 cursor-pointer transition active:scale-95"
                          title="Ouvrir avec le programme par défaut de Windows"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onCheckAndEnqueueTransfer(item.name, item.path, currentPath, "download", false);
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
    </>
  );
}

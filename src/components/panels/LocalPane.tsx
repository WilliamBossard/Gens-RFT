import React, { useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  HardDrive,
  Monitor,
  FolderDown,
  FileSpreadsheet,
  Edit2,
  Search,
  ChevronLeft,
  ChevronRight,
  ArrowUp,
  FolderPlus,
  ArrowUpDown,
  Folder,
  Upload,
} from "lucide-react";
import DirectoryTree from "../../DirectoryTree";
import { FileEntry, SortField, SortOrder, TabSession } from "../../types";
import { getFileBadge, formatFileSize } from "../../utils/fileHelpers";

interface Props {
  isDark: boolean;
  localPaneWidth: number;
  currentPath: string;
  files: FileEntry[];
  processedLocalFiles: FileEntry[];
  drives: string[];
  sysFolders: Record<string, string>;
  isEditingLocalPath: boolean;
  setIsEditingLocalPath: (val: boolean) => void;
  localPathInput: string;
  setLocalPathInput: (val: string) => void;
  localSearch: string;
  setLocalSearch: (val: string) => void;
  localHistoryIndex: number;
  localSort: { field: SortField; order: SortOrder };
  setLocalSort: React.Dispatch<React.SetStateAction<{ field: SortField; order: SortOrder }>>;
  showTreePanels: boolean;
  treeHeight: number;
  setTreeHeight: React.Dispatch<React.SetStateAction<number>>;
  showHidden: boolean;
  selectedLocalPaths: Set<string>;
  setSelectedLocalPaths: React.Dispatch<React.SetStateAction<Set<string>>>;
  selectedRemotePaths: Set<string>;
  activeTab: TabSession;
  draggedItem: { entry: FileEntry; from: "local" | "remote"; fromSessionId?: string } | null;
  setDraggedItem: (val: { entry: FileEntry; from: "local" | "remote"; fromSessionId?: string } | null) => void;
  isOverLocal: boolean;
  setIsOverLocal: (val: boolean) => void;
  setIsOverRemote: (val: boolean) => void;
  setDragOverTabId: (val: string | null) => void;
  setActivePane: (pane: "local" | "remote") => void;
  onNavigateLocal: (targetPath?: string, recordHistory?: boolean) => void;
  onLocalHistoryBack: () => void;
  onLocalHistoryForward: () => void;
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

export default function LocalPane({
  isDark,
  localPaneWidth,
  currentPath,
  files,
  processedLocalFiles,
  drives,
  sysFolders,
  isEditingLocalPath,
  setIsEditingLocalPath,
  localPathInput,
  setLocalPathInput,
  localSearch,
  setLocalSearch,
  localHistoryIndex,
  localSort,
  setLocalSort,
  showTreePanels,
  treeHeight,
  setTreeHeight,
  showHidden,
  selectedLocalPaths,
  setSelectedLocalPaths,
  selectedRemotePaths,
  activeTab,
  draggedItem,
  setDraggedItem,
  isOverLocal,
  setIsOverLocal,
  setIsOverRemote,
  setDragOverTabId,
  setActivePane,
  onNavigateLocal,
  onLocalHistoryBack,
  onLocalHistoryForward,
  onCheckAndEnqueueTransfer,
  onOpenContextMenu,
  onPromptInputModal,
  logMessage,
}: Props) {
  const lastSelectedLocalIndexRef = useRef<number | null>(null);

  return (
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
          const items =
            selectedRemotePaths.has(draggedItem.entry.path) && selectedRemotePaths.size > 1
              ? activeTab.remoteFiles.filter((f) => selectedRemotePaths.has(f.path))
              : [draggedItem.entry];
          for (const it of items) {
            onCheckAndEnqueueTransfer(
              it.name,
              it.path,
              currentPath,
              "download",
              it.is_dir
            );
          }
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
              onChange={(e) => onNavigateLocal(e.target.value)}
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
                onClick={() => onNavigateLocal(sysFolders.desktop)}
                className="p-1 rounded border border-neutral-700/60 hover:bg-neutral-800 text-neutral-400 hover:text-sky-400 cursor-pointer transition active:scale-95"
                title={`Bureau (${sysFolders.desktop})`}
              >
                <Monitor className="h-3.5 w-3.5" />
              </button>
            )}
            {sysFolders.downloads && (
              <button
                onClick={() => onNavigateLocal(sysFolders.downloads)}
                className="p-1 rounded border border-neutral-700/60 hover:bg-neutral-800 text-neutral-400 hover:text-emerald-400 cursor-pointer transition active:scale-95"
                title={`Téléchargements (${sysFolders.downloads})`}
              >
                <FolderDown className="h-3.5 w-3.5" />
              </button>
            )}
            {sysFolders.documents && (
              <button
                onClick={() => onNavigateLocal(sysFolders.documents)}
                className="p-1 rounded border border-neutral-700/60 hover:bg-neutral-800 text-neutral-400 hover:text-amber-400 cursor-pointer transition active:scale-95"
                title={`Documents (${sysFolders.documents})`}
              >
                <FileSpreadsheet className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Chemin éditable */}
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
                    let target = localPathInput.trim();
                    if (target.endsWith(":")) {
                      target += "\\";
                    }
                    onNavigateLocal(target);
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
          <div className="flex items-center gap-0.5">
            <button
              onClick={onLocalHistoryBack}
              disabled={localHistoryIndex <= 0}
              className="rounded p-1 hover:bg-neutral-500/20 cursor-pointer transition active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed"
              title="Dossier local précédent"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={onLocalHistoryForward}
              disabled={localHistoryIndex < 0}
              className="rounded p-1 hover:bg-neutral-500/20 cursor-pointer transition active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed"
              title="Dossier local suivant"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
          <button
            onClick={() => {
              const parts = currentPath.split(/[\\/]+/).filter(Boolean);
              parts.pop();
              const isWinDrive = parts.length === 1 && parts[0].endsWith(":");
              let parentPath = parts.join("\\");
              if (isWinDrive) {
                parentPath += "\\";
              }
              onNavigateLocal(parentPath || (drives[0] || "C:\\"));
            }}
            className="rounded p-1 hover:bg-neutral-500/20 cursor-pointer transition active:scale-95"
            title="Dossier parent"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => {
              onPromptInputModal({
                title: "Nouveau dossier local",
                label: "Nom du dossier :",
                value: "nouveau_dossier",
                onConfirm: async (val) => {
                  const cleanPath = currentPath.replace(/[\\/]+$/, "");
                  const target = `${cleanPath}\\${val}`;
                  try {
                    await invoke("create_local_dir", { path: target });
                    logMessage(`Dossier local créé : ${target}`);
                    onNavigateLocal(currentPath);
                  } catch (err) {
                    logMessage(`Erreur création dossier local : ${err}`);
                  }
                },
              });
            }}
            className="rounded p-1 hover:bg-neutral-500/20 cursor-pointer transition active:scale-95"
            title="Nouveau dossier local"
          >
            <FolderPlus className="h-3.5 w-3.5" />
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
              onNavigate={onNavigateLocal}
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
      <div
        onClick={() => {
          setActivePane("local");
          setSelectedLocalPaths(new Set());
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setActivePane("local");
          onOpenContextMenu(e, null, false);
        }}
        className="flex-1 overflow-y-auto font-mono text-xs divide-y divide-neutral-500/10 min-h-[100px]"
      >
        {processedLocalFiles.map((item, index) => {
          const badge = getFileBadge(item.name, isDark);
          const isSelected = selectedLocalPaths.has(item.path);
          return (
            <div
              key={item.path}
              draggable
              onClick={(e) => {
                e.stopPropagation();
                setActivePane("local");
                if (e.shiftKey && lastSelectedLocalIndexRef.current !== null) {
                  const start = Math.min(lastSelectedLocalIndexRef.current, index);
                  const end = Math.max(lastSelectedLocalIndexRef.current, index);
                  const rangePaths = processedLocalFiles.slice(start, end + 1).map((f) => f.path);
                  setSelectedLocalPaths(new Set(rangePaths));
                } else if (e.ctrlKey || e.metaKey) {
                  lastSelectedLocalIndexRef.current = index;
                  setSelectedLocalPaths((prev) => {
                    const next = new Set(prev);
                    if (next.has(item.path)) next.delete(item.path);
                    else next.add(item.path);
                    return next;
                  });
                } else {
                  lastSelectedLocalIndexRef.current = index;
                  setSelectedLocalPaths(new Set([item.path]));
                }
              }}
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
                  onNavigateLocal(item.path);
                } else {
                  if (!activeTab.isConnected) {
                    logMessage("Info : Connectez-vous d'abord à un serveur distant pour transférer.");
                    return;
                  }
                  onCheckAndEnqueueTransfer(item.name, item.path, activeTab.remotePath, "upload", false);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setActivePane("local");
                if (!selectedLocalPaths.has(item.path)) {
                  setSelectedLocalPaths(new Set([item.path]));
                }
                onOpenContextMenu(e, item, false);
              }}
              className={`grid grid-cols-12 items-center px-3 py-1.5 cursor-pointer group transition duration-75 border-l-2 select-none ${
                isSelected
                  ? isDark
                    ? "bg-sky-500/20 border-sky-400 font-medium"
                    : "bg-sky-100 border-sky-600 font-medium"
                  : "border-transparent hover:bg-sky-500/10"
              }`}
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
                {!item.is_dir ? formatFileSize(item.size) : "--"}
              </div>

              <div className="col-span-1 flex justify-center">
                {activeTab.isConnected && !item.is_dir && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onCheckAndEnqueueTransfer(item.name, item.path, activeTab.remotePath, "upload", false);
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
  );
}

import { useState, useEffect } from "react";
import { Folder, ChevronRight, ChevronDown, HelpCircle } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  sessionId?: string;
  isRemote: boolean;
  currentPath: string;
  subFolders: string[];
  onNavigate: (path: string) => void;
  isDark?: boolean;
}

export default function DirectoryTree({ sessionId, isRemote, currentPath, subFolders, onNavigate, isDark = true }: Props) {
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const [childrenCache, setChildrenCache] = useState<Record<string, string[]>>({});
  const [loadingNodes, setLoadingNodes] = useState<Record<string, boolean>>({});

  const rootPath = isRemote ? "/" : "C:\\";

  const parts = currentPath
    .split(isRemote ? "/" : /[\\/]/)
    .filter(Boolean);

  useEffect(() => {
    const cleanPath = isRemote ? (currentPath || "/") : (currentPath || "C:\\");
    setChildrenCache((prev) => ({
      ...prev,
      [cleanPath.toLowerCase()]: subFolders,
    }));
  }, [currentPath, subFolders, isRemote]);

  const toggleExpand = async (targetPath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const key = targetPath.toLowerCase();
    const isNowExpanded = !expandedNodes[key];

    setExpandedNodes((prev) => ({ ...prev, [key]: isNowExpanded }));

    if (isNowExpanded && !childrenCache[key]) {
      setLoadingNodes((prev) => ({ ...prev, [key]: true }));
      try {
        if (isRemote) {
          const dirs = await invoke<string[]>("list_remote_subdirs", { sessionId: sessionId || "default", path: targetPath });
          setChildrenCache((prev) => ({ ...prev, [key]: dirs }));
        } else {
          const dirs = await invoke<string[]>("read_local_subdirs", { path: targetPath });
          setChildrenCache((prev) => ({ ...prev, [key]: dirs }));
        }
      } catch {
        setChildrenCache((prev) => ({ ...prev, [key]: [] }));
      } finally {
        setLoadingNodes((prev) => ({ ...prev, [key]: false }));
      }
    }
  };

  const renderFolderNode = (nodeName: string, fullPath: string, depth: number) => {
    const key = fullPath.toLowerCase();
    const isCurrent = key === (currentPath.toLowerCase().trim() || rootPath.toLowerCase());
    const isExpanded = expandedNodes[key] || parts.some((_, i) => {
      const pPath = isRemote
        ? "/" + parts.slice(0, i + 1).join("/")
        : parts[0] + "\\" + parts.slice(1, i + 1).join("\\");
      return pPath.toLowerCase() === key;
    });

    const knownChildren = childrenCache[key];
    const isUnknown = knownChildren === undefined;
    const isLoading = loadingNodes[key];

    return (
      <div key={fullPath} className="flex flex-col">
        <div
          style={{ paddingLeft: `${depth * 14}px` }}
          onClick={() => onNavigate(fullPath)}
          className={`flex items-center gap-1.5 py-0.5 px-1.5 rounded cursor-pointer group transition text-[11px] ${
            isCurrent
              ? (isDark ? "bg-sky-500/20 text-sky-400 font-bold" : "bg-sky-100 text-sky-700 font-bold")
              : (isDark ? "hover:bg-neutral-800 text-neutral-300" : "hover:bg-neutral-200 text-neutral-700")
          }`}
        >
          <button
            onClick={(e) => toggleExpand(fullPath, e)}
            className={`p-0.5 rounded cursor-pointer ${ isDark ? "hover:bg-neutral-700 text-neutral-400" : "hover:bg-neutral-300 text-neutral-600" }`} title={isUnknown ? "Contenu inconnu (?) - Cliquez pour explorer" : "Déplier/Replier"} > {isLoading ? ( <span className="inline-block h-3 w-3 animate-spin text-sky-400 text-[9px] text-center">○</span> ) : isExpanded ? ( <ChevronDown className="h-3 w-3" /> ) : ( <div className="flex items-center"> <ChevronRight className="h-3 w-3" /> {isUnknown && depth > 0 && ( <span title="Inconnu (?)"> <HelpCircle className="h-2.5 w-2.5 text-amber-500 -ml-1" /> </span> )} </div> )} </button>  <Folder className={`h-3.5 w-3.5 shrink-0 ${
              isRemote ? (isDark ? "text-sky-400" : "text-sky-600") : "text-amber-500"
            }`}
          />
          <span className="truncate">{nodeName}</span>
        </div>

        {isExpanded && knownChildren && knownChildren.length > 0 && (
          <div className="flex flex-col">
            {knownChildren.map((childName) => {
              const childPath = isRemote
                ? `${fullPath.replace(/\/$/, "")}/${childName}` : `${fullPath.replace(/\\$/, "")}\\${childName}`;
              return renderFolderNode(childName, childPath, depth + 1);
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={`p-1 font-mono text-xs select-none ${isDark ? "text-neutral-200" : "text-neutral-800"}`}>
      {renderFolderNode(isRemote ? "/ (Racine)" : "Disque local (C:)", rootPath, 0)}

      {parts.length > 0 && (
        <div className="flex flex-col">
          {parts.map((part, idx) => {
            const subPath = isRemote
              ? "/" + parts.slice(0, idx + 1).join("/")
              : parts[0] + "\\" + parts.slice(1, idx + 1).join("\\");
            if (subPath.toLowerCase() === rootPath.toLowerCase()) return null;
            return renderFolderNode(part, subPath, idx + 1);
          })}
        </div>
      )}
    </div>
  );
}
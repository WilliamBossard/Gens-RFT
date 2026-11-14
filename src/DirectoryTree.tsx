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

function getPathHierarchy(path: string, isRemote: boolean, rootPath: string): string[] {
  if (isRemote) {
    const clean = path.replace(/\/+$/, "");
    if (!clean || clean === "/") return ["/"];
    const segments = clean.split("/").filter(Boolean);
    const result: string[] = ["/"];
    let curr = "";
    for (const seg of segments) {
      curr += "/" + seg;
      result.push(curr);
    }
    return result;
  } else {
    // Normalise les slashes pour Windows afin de supporter C:/ comme C:\
    const normalized = path.replace(/\//g, "\\");
    const clean = normalized.replace(/\\+$/, "");
    const root = rootPath.replace(/\\+$/, "");
    const result: string[] = [rootPath];
    if (clean.toLowerCase() === root.toLowerCase()) return [rootPath];

    const withoutDrive = clean.substring(root.length).replace(/^\\+/, "");
    if (!withoutDrive) return result;

    const parts = withoutDrive.split("\\").filter(Boolean);
    let curr = root;
    for (const part of parts) {
      curr = curr + "\\" + part;
      result.push(curr);
    }
    return result;
  }
}

export default function DirectoryTree({
  sessionId,
  isRemote,
  currentPath,
  subFolders,
  onNavigate,
  isDark = true,
}: Props) {
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const [childrenCache, setChildrenCache] = useState<Record<string, string[]>>({});
  const [loadingNodes, setLoadingNodes] = useState<Record<string, boolean>>({});

  // Détermination dynamique de la racine
  const rootPath = isRemote
    ? "/"
    : currentPath.includes(":")
    ? currentPath.substring(0, currentPath.indexOf(":") + 1) + "\\"
    : "C:\\";

  const rootLabel = isRemote
    ? "/ (Racine)"
    : `Disque local (${rootPath.replace("\\", "")})`;

  const getKey = (p: string) => (isRemote ? p : p.toLowerCase());

  // Auto-déploiement et chargement de la racine et de toute la hiérarchie du chemin actuel
  useEffect(() => {
    let isCancelled = false;

    const autoExpandAndFetch = async () => {
      const target = currentPath.trim() || rootPath;
      const hierarchy = getPathHierarchy(target, isRemote, rootPath);

      // Déplie tous les dossiers de la hiérarchie menant au dossier actuel
      setExpandedNodes((prev) => {
        const next = { ...prev };
        hierarchy.forEach((p) => {
          next[getKey(p)] = true;
        });
        return next;
      });

      // Met en cache les sous-dossiers déjà connus pour le dossier courant
      const currKey = getKey(target);
      setChildrenCache((prev) => ({
        ...prev,
        [currKey]: subFolders,
      }));

      // Récupère les sous-dossiers de chaque niveau parent non encore en cache (notamment la racine !)
      for (const p of hierarchy) {
        const key = getKey(p);
        if (key === currKey && subFolders.length > 0) continue;
        if (childrenCache[key] !== undefined) continue;

        try {
          if (isRemote) {
            if (!sessionId) continue;
            const dirs = await invoke<string[]>("list_remote_subdirs", {
              sessionId,
              path: p,
            });
            if (!isCancelled) {
              setChildrenCache((prev) => ({ ...prev, [key]: dirs }));
            }
          } else {
            const dirs = await invoke<string[]>("read_local_subdirs", { path: p });
            if (!isCancelled) {
              setChildrenCache((prev) => ({ ...prev, [key]: dirs }));
            }
          }
        } catch {}
      }
    };

    autoExpandAndFetch();

    return () => {
      isCancelled = true;
    };
  }, [currentPath, subFolders, isRemote, rootPath, sessionId]);

  const toggleExpand = async (targetPath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const key = getKey(targetPath);
    const currentlyExpanded = !!expandedNodes[key];
    const isNowExpanded = !currentlyExpanded;

    setExpandedNodes((prev) => ({ ...prev, [key]: isNowExpanded }));

    if (isNowExpanded && childrenCache[key] === undefined) {
      setLoadingNodes((prev) => ({ ...prev, [key]: true }));
      try {
        if (isRemote) {
          const dirs = await invoke<string[]>("list_remote_subdirs", {
            sessionId: sessionId || "default",
            path: targetPath,
          });
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
    const key = getKey(fullPath);
    const isCurrent = key === getKey(currentPath.trim() || rootPath);
    const isExpanded = !!expandedNodes[key];

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
              ? isDark
                ? "bg-sky-500/20 text-sky-400 font-bold"
                : "bg-sky-100 text-sky-700 font-bold"
              : isDark
              ? "hover:bg-neutral-800 text-neutral-300"
              : "hover:bg-neutral-200 text-neutral-700"
          }`}
        >
          <button
            onClick={(e) => toggleExpand(fullPath, e)}
            className={`p-0.5 rounded cursor-pointer ${
              isDark ? "hover:bg-neutral-700 text-neutral-400" : "hover:bg-neutral-300 text-neutral-600"
            }`}
            title={isUnknown ? "Explorer le dossier" : "Déplier/Replier"}
          >
            {isLoading ? (
              <span className="inline-block h-3 w-3 animate-spin text-sky-400 text-[9px] text-center">○</span>
            ) : isExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <div className="flex items-center">
                <ChevronRight className="h-3 w-3" />
                {isUnknown && depth > 0 && (
                  <span title="Contenu non exploré">
                    <HelpCircle className="h-2.5 w-2.5 text-amber-500 -ml-1" />
                  </span>
                )}
              </div>
            )}
          </button>
          <Folder
            className={`h-3.5 w-3.5 shrink-0 ${
              isRemote ? (isDark ? "text-sky-400" : "text-sky-600") : "text-amber-500"
            }`}
          />
          <span className="truncate">{nodeName}</span>
        </div>

        {isExpanded && knownChildren && knownChildren.length > 0 && (
          <div className="flex flex-col">
            {knownChildren.map((childName) => {
              const childPath = isRemote
                ? `${fullPath.replace(/\/+$/, "")}/${childName}`
                : `${fullPath.replace(/\\+$/, "")}\\${childName}`;
              return renderFolderNode(childName, childPath, depth + 1);
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={`p-1 font-mono text-xs select-none ${isDark ? "text-neutral-200" : "text-neutral-800"}`}>
      {renderFolderNode(rootLabel, rootPath, 0)}
    </div>
  );
}

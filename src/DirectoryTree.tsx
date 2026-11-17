import { useState, useEffect, useRef, memo } from "react";
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

const MAX_CACHE_ENTRIES = 200;

function arraysEqual(a: string[] | undefined, b: string[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function detectLocalRoot(path: string): string {
  const normalized = path.replace(/\//g, "\\");
  if (normalized.startsWith("\\\\")) {
    const parts = normalized.slice(2).split("\\").filter(Boolean);
    if (parts.length >= 2) {
      return `\\\\${parts[0]}\\${parts[1]}\\`;
    }
  }
  if (/^[a-zA-Z]:/.test(normalized)) {
    return `${normalized.slice(0, 2)}\\`;
  }
  if (path.startsWith("/")) {
    return "/";
  }
  return "C:\\";
}

function getPathHierarchy(path: string, isRemote: boolean, rootPath: string): string[] {
  if (isRemote || rootPath === "/") {
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

function trimCache(
  cache: Record<string, string[]>,
  accessOrder: string[],
  preserveKey?: string
): Record<string, string[]> {
  const keys = Object.keys(cache);
  if (keys.length <= MAX_CACHE_ENTRIES) return cache;
  const keep = new Set<string>();
  if (preserveKey && cache[preserveKey] !== undefined) {
    keep.add(preserveKey);
  }
  for (let i = accessOrder.length - 1; i >= 0 && keep.size < MAX_CACHE_ENTRIES; i--) {
    const k = accessOrder[i];
    if (cache[k] !== undefined) keep.add(k);
  }
  for (let i = keys.length - 1; i >= 0 && keep.size < MAX_CACHE_ENTRIES; i--) {
    keep.add(keys[i]);
  }
  const trimmed: Record<string, string[]> = {};
  for (const k of keep) {
    trimmed[k] = cache[k];
  }
  return trimmed;
}

function DirectoryTreeComponent({
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
  const childrenCacheRef = useRef(childrenCache);
  useEffect(() => {
    childrenCacheRef.current = childrenCache;
  }, [childrenCache]);
  const accessOrderRef = useRef<string[]>([]);
  const fetchedAncestorsRef = useRef<Set<string>>(new Set());
  const activeNodeRef = useRef<HTMLDivElement | null>(null);
  const lastScrolledKeyRef = useRef<string>("");

  const touchKeys = (keys: string[]) => {
    const next = accessOrderRef.current.filter((k) => !keys.includes(k));
    next.push(...keys);
    if (next.length > MAX_CACHE_ENTRIES * 2) {
      next.splice(0, next.length - MAX_CACHE_ENTRIES);
    }
    accessOrderRef.current = next;
  };

  useEffect(() => {
    if (isRemote) {
      setExpandedNodes({});
      setChildrenCache({});
      setLoadingNodes({});
      fetchedAncestorsRef.current.clear();
      lastScrolledKeyRef.current = "";
    }
  }, [isRemote, sessionId]);

  const rootPath = isRemote ? "/" : detectLocalRoot(currentPath);

  const rootLabel = isRemote
    ? "/ (Racine)"
    : rootPath === "/"
    ? "/ (Racine)"
    : `Disque local (${rootPath.replace(/\\+$/, "")})`;

  const getKey = (p: string) => {
    if (isRemote || rootPath === "/") {
      const c = p.replace(/\/+$/, "");
      return c || "/";
    }
    const n = p.replace(/\//g, "\\");
    if (/^[a-zA-Z]:\\?$/.test(n)) {
      return `${n.slice(0, 2).toLowerCase()}\\`;
    }
    return n.replace(/\\+$/, "").toLowerCase();
  };

  useEffect(() => {
    if (!currentPath.trim()) return;
    let isCancelled = false;

    const autoExpandAndFetch = async () => {
      const target = currentPath.trim();
      const hierarchy = getPathHierarchy(target, isRemote, rootPath);

      setExpandedNodes((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const p of hierarchy) {
          const k = getKey(p);
          if (!next[k]) {
            next[k] = true;
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      const currKey = getKey(target);
      const rootKey = getKey(rootPath);
      if (!arraysEqual(childrenCacheRef.current[currKey], subFolders)) {
        touchKeys([rootKey, currKey]);
        setChildrenCache((prev) =>
          trimCache(
            {
              ...prev,
              [currKey]: subFolders,
            },
            accessOrderRef.current,
            rootKey
          )
        );
      }

      const missingPaths = hierarchy.filter((p) => {
        const key = getKey(p);
        if (key === currKey) return false;
        const cached = childrenCacheRef.current[key];
        if (cached !== undefined && (cached.length > 0 || fetchedAncestorsRef.current.has(key))) {
          return false;
        }
        if (isRemote && !sessionId) return false;
        return true;
      });

      if (missingPaths.length === 0) return;

      const results = await Promise.all(
        missingPaths.map(async (p) => {
          const key = getKey(p);
          fetchedAncestorsRef.current.add(key);
          try {
            const dirs = isRemote
              ? await invoke<string[]>("list_remote_subdirs", { sessionId, path: p })
              : await invoke<string[]>("read_local_subdirs", { path: p });
            return [key, dirs] as const;
          } catch {
            return null;
          }
        })
      );

      if (isCancelled) return;
      const updates: Record<string, string[]> = {};
      for (const res of results) {
        if (res) updates[res[0]] = res[1];
      }
      const updateKeys = Object.keys(updates);
      if (updateKeys.length > 0) {
        touchKeys(updateKeys);
        setChildrenCache((prev) =>
          trimCache({ ...prev, ...updates }, accessOrderRef.current, rootKey)
        );
      }
    };

    autoExpandAndFetch();

    return () => {
      isCancelled = true;
    };
  }, [currentPath, subFolders, isRemote, rootPath, sessionId]);

  // Défilement automatique vers le dossier actif dès qu'il est rendu dans l'arborescence
  useEffect(() => {
    const trimmed = currentPath.trim();
    if (!trimmed) return;
    const currKey = getKey(trimmed);
    if (lastScrolledKeyRef.current === currKey) return;
    const el = activeNodeRef.current;
    if (el && el.dataset.nodeKey === currKey) {
      lastScrolledKeyRef.current = currKey;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [currentPath, childrenCache, expandedNodes, isRemote, rootPath, sessionId]);

  const toggleExpand = async (targetPath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const key = getKey(targetPath);
    const currentlyExpanded = !!expandedNodes[key];
    const isNowExpanded = !currentlyExpanded;

    setExpandedNodes((prev) => ({ ...prev, [key]: isNowExpanded }));

    if (isNowExpanded && childrenCacheRef.current[key] === undefined) {
      const rootKey = getKey(rootPath);
      setLoadingNodes((prev) => ({ ...prev, [key]: true }));
      try {
        if (isRemote) {
          if (!sessionId) {
            setChildrenCache((prev) => ({ ...prev, [key]: [] }));
            return;
          }
          const dirs = await invoke<string[]>("list_remote_subdirs", {
            sessionId,
            path: targetPath,
          });
          touchKeys([key]);
          setChildrenCache((prev) =>
            trimCache({ ...prev, [key]: dirs }, accessOrderRef.current, rootKey)
          );
        } else {
          const dirs = await invoke<string[]>("read_local_subdirs", { path: targetPath });
          touchKeys([key]);
          setChildrenCache((prev) =>
            trimCache({ ...prev, [key]: dirs }, accessOrderRef.current, rootKey)
          );
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
          ref={isCurrent ? activeNodeRef : undefined}
          data-node-key={key}
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
              const isPosix = isRemote || rootPath === "/";
              const childPath = isPosix
                ? `${fullPath === "/" ? "" : fullPath.replace(/\/+$/, "")}/${childName}`
                : `${fullPath.replace(/\\+$/, "")}\\${childName}`;
              return renderFolderNode(childName, childPath, depth + 1);
            })}
          </div>
        )}
      </div>
    );
  };

  if (!currentPath.trim()) {
    return (
      <div className="p-3 text-neutral-500 text-xs font-mono">
        Chargement de l'arborescence...
      </div>
    );
  }

  return (
    <div className={`p-1 font-mono text-xs select-none ${isDark ? "text-neutral-200" : "text-neutral-800"}`}>
      {renderFolderNode(rootLabel, rootPath, 0)}
    </div>
  );
}

export default memo(DirectoryTreeComponent);

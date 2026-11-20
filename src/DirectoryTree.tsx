import { useState, useEffect, useRef, useMemo, useCallback, memo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Folder, ChevronRight, ChevronDown, HelpCircle } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  sessionId?: string;
  isRemote: boolean;
  currentPath: string;
  subFolders: string[];
  onNavigate: (path: string) => void;
  refreshKey?: number;
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

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIdx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(runners);
  return results;
}

interface FlatTreeNode {
  key: string;
  name: string;
  fullPath: string;
  depth: number;
  isCurrent: boolean;
  isExpanded: boolean;
  isUnknown: boolean;
  isLoading: boolean;
}

function DirectoryTreeComponent({
  sessionId,
  isRemote,
  currentPath,
  subFolders,
  onNavigate,
  refreshKey = 0,
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
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
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
      childrenCacheRef.current = {};
      setChildrenCache({});
      setLoadingNodes({});
      fetchedAncestorsRef.current.clear();
      accessOrderRef.current = [];
      lastScrolledKeyRef.current = "";
    }
  }, [isRemote, sessionId]);

  useEffect(() => {
    if (refreshKey === 0) return;
    childrenCacheRef.current = {};
    setChildrenCache({});
    fetchedAncestorsRef.current.clear();
    accessOrderRef.current = [];
  }, [refreshKey]);

  const rootPath = isRemote ? "/" : detectLocalRoot(currentPath);

  const rootLabel = isRemote
    ? "/ (Racine)"
    : rootPath === "/"
    ? "/ (Racine)"
    : `Disque local (${rootPath.replace(/\\+$/, "")})`;

  const getKey = useCallback(
    (p: string) => {
      if (isRemote || rootPath === "/") {
        const c = p.replace(/\/+$/, "");
        return c || "/";
      }
      const n = p.replace(/\//g, "\\");
      if (/^[a-zA-Z]:\\?$/.test(n)) {
        return `${n.slice(0, 2).toLowerCase()}\\`;
      }
      return n.replace(/\\+$/, "").toLowerCase();
    },
    [isRemote, rootPath]
  );

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
        const nextCache = trimCache(
          {
            ...childrenCacheRef.current,
            [currKey]: subFolders,
          },
          accessOrderRef.current,
          rootKey
        );
        childrenCacheRef.current = nextCache;
        setChildrenCache(nextCache);
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

      const results = await runWithConcurrency(
        missingPaths,
        isRemote ? 2 : 4,
        async (p) => {
          if (isCancelled) return null;
          const key = getKey(p);
          fetchedAncestorsRef.current.add(key);
          try {
            const dirs = isRemote
              ? await invoke<string[]>("list_remote_subdirs", { sessionId, path: p })
              : await invoke<string[]>("read_local_subdirs", { path: p });
            return [key, dirs] as const;
          } catch {
            fetchedAncestorsRef.current.delete(key);
            return null;
          }
        }
      );

      if (isCancelled) return;
      const updates: Record<string, string[]> = {};
      for (const res of results) {
        if (res) updates[res[0]] = res[1];
      }
      const updateKeys = Object.keys(updates);
      if (updateKeys.length > 0) {
        touchKeys(updateKeys);
        const nextCache = trimCache(
          { ...childrenCacheRef.current, ...updates },
          accessOrderRef.current,
          rootKey
        );
        childrenCacheRef.current = nextCache;
        setChildrenCache(nextCache);
      }
    };

    autoExpandAndFetch();

    return () => {
      isCancelled = true;
    };
  }, [currentPath, subFolders, isRemote, rootPath, sessionId, getKey, refreshKey]);

  const flatNodes = useMemo(() => {
    if (!currentPath.trim()) return [];
    const currentKey = getKey(currentPath.trim() || rootPath);
    const isPosix = isRemote || rootPath === "/";
    const list: FlatTreeNode[] = [];
    const visited = new Set<string>();

    const walk = (nodeName: string, fullPath: string, depth: number) => {
      const key = getKey(fullPath);
      if (visited.has(key)) return;
      visited.add(key);

      const isCurrent = key === currentKey;
      const isExpanded = !!expandedNodes[key];
      const knownChildren = childrenCache[key];
      const isUnknown = knownChildren === undefined;
      const isLoading = !!loadingNodes[key];

      list.push({
        key,
        name: nodeName,
        fullPath,
        depth,
        isCurrent,
        isExpanded,
        isUnknown,
        isLoading,
      });

      if (isExpanded && knownChildren && knownChildren.length > 0) {
        for (const childName of knownChildren) {
          const childPath = isPosix
            ? `${fullPath === "/" ? "" : fullPath.replace(/\/+$/, "")}/${childName}`
            : `${fullPath.replace(/\\+$/, "")}\\${childName}`;
          walk(childName, childPath, depth + 1);
        }
      }
    };

    walk(rootLabel, rootPath, 0);
    return list;
  }, [currentPath, rootPath, rootLabel, isRemote, expandedNodes, childrenCache, loadingNodes, getKey]);

  const rowVirtualizer = useVirtualizer({
    count: flatNodes.length,
    getScrollElement: () => treeScrollRef.current,
    estimateSize: () => 22,
    overscan: 10,
  });

  // Défilement automatique vers le dossier actif dès qu'il est présent dans l'arborescence
  useEffect(() => {
    const trimmed = currentPath.trim();
    if (!trimmed) return;
    const currKey = getKey(trimmed);
    if (lastScrolledKeyRef.current === currKey) return;
    const idx = flatNodes.findIndex((n) => n.key === currKey);
    if (idx >= 0) {
      lastScrolledKeyRef.current = currKey;
      rowVirtualizer.scrollToIndex(idx, { align: "auto" });
    }
  }, [currentPath, flatNodes, getKey, rowVirtualizer]);

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
        // Ne pas figer le cache à [] en cas d'erreur temporaire afin de permettre une nouvelle tentative
      } finally {
        setLoadingNodes((prev) => ({ ...prev, [key]: false }));
      }
    }
  };

  if (!currentPath.trim()) {
    return (
      <div className="p-3 text-neutral-500 text-xs font-mono">
        Chargement de l'arborescence...
      </div>
    );
  }

  return (
    <div
      ref={treeScrollRef}
      className={`h-full overflow-y-auto p-1 font-mono text-xs select-none ${
        isDark ? "text-neutral-200" : "text-neutral-800"
      }`}
    >
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const node = flatNodes[virtualRow.index];
          return (
            <div
              key={node.fullPath}
              data-node-key={node.key}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
                paddingLeft: `${node.depth * 14 + 6}px`,
              }}
              onClick={() => onNavigate(node.fullPath)}
              className={`flex items-center gap-1.5 pr-1.5 rounded cursor-pointer group transition text-[11px] ${
                node.isCurrent
                  ? isDark
                    ? "bg-sky-500/20 text-sky-400 font-bold"
                    : "bg-sky-100 text-sky-700 font-bold"
                  : isDark
                  ? "hover:bg-neutral-800 text-neutral-300"
                  : "hover:bg-neutral-200 text-neutral-700"
              }`}
            >
              <button
                onClick={(e) => toggleExpand(node.fullPath, e)}
                className={`p-0.5 rounded cursor-pointer ${
                  isDark ? "hover:bg-neutral-700 text-neutral-400" : "hover:bg-neutral-300 text-neutral-600"
                }`}
                title={node.isUnknown ? "Explorer le dossier" : "Déplier/Replier"}
              >
                {node.isLoading ? (
                  <span className="inline-block h-3 w-3 animate-spin text-sky-400 text-[9px] text-center">○</span>
                ) : node.isExpanded ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <div className="flex items-center">
                    <ChevronRight className="h-3 w-3" />
                    {node.isUnknown && node.depth > 0 && (
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
              <span className="truncate">{node.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default memo(DirectoryTreeComponent);

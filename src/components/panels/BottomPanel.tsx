import { useRef, useEffect, useState, memo, lazy, Suspense } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ListOrdered, Terminal as TerminalIcon, RotateCcw, Ban, ChevronDown, ChevronUp } from "lucide-react";
import QueuePanel from "../QueuePanel";
import { TabSession } from "../../types";
import { useTransferStore } from "../../store/useTransferStore";
import { useLogStore } from "../../store/useLogStore";

const SshTerminal = lazy(() => import("../../SshTerminal"));

export type TerminalTabInfo = Pick<TabSession, "id" | "title" | "isConnected" | "protocol">;

interface Props {
  isDark: boolean;
  bottomHeight: number;
  setBottomHeight: (val: number) => void;
  bottomOpen: boolean;
  setBottomOpen: (val: boolean) => void;
  activeBottomTab: "logs" | "queue" | "terminal";
  setActiveBottomTab: (tab: "logs" | "queue" | "terminal") => void;
  enableSshTerminal: boolean;
  tabs: TerminalTabInfo[];
  activeTab: TerminalTabInfo;
}

const LogsViewer = memo(function LogsViewer({ bottomOpen }: { bottomOpen: boolean }) {
  const logs = useLogStore((state) => state.logs);
  const logsContainerRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: logs.length,
    getScrollElement: () => logsContainerRef.current,
    estimateSize: () => 20,
    overscan: 12,
  });

  useEffect(() => {
    if (bottomOpen && logs.length > 0) {
      rowVirtualizer.scrollToIndex(logs.length - 1, { align: "end" });
    }
  }, [logs.length, bottomOpen, rowVirtualizer]);

  return (
    <div ref={logsContainerRef} className="flex-1 overflow-y-auto p-2.5 font-mono text-[11px]">
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.index}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: `${virtualRow.size}px`,
              transform: `translateY(${virtualRow.start}px)`,
            }}
            className="flex gap-2 items-center truncate"
          >
            <span className="text-neutral-500 shrink-0">&gt;</span>
            <span className="truncate">{logs[virtualRow.index]}</span>
          </div>
        ))}
      </div>
    </div>
  );
});

function BottomPanelComponent({
  isDark,
  bottomHeight,
  setBottomHeight,
  bottomOpen,
  setBottomOpen,
  activeBottomTab,
  setActiveBottomTab,
  enableSshTerminal,
  tabs,
  activeTab,
}: Props) {
  const [activatedTerminalTabs, setActivatedTerminalTabs] = useState<Record<string, boolean>>({});
  const footerRef = useRef<HTMLElement>(null);

  const runningOrQueuedCount = useTransferStore(
    (state) => state.queue.filter((q) => q.status === "queued" || q.status === "running").length
  );
  const clearDone = useTransferStore((state) => state.clearDone);
  const cancelAll = useTransferStore((state) => state.cancelAll);
  const retryAllFailed = useTransferStore((state) => state.retryAllFailed);

  // Activer paresseusement le terminal SSH uniquement quand l'utilisateur sélectionne l'onglet Terminal
  useEffect(() => {
    if (
      enableSshTerminal &&
      bottomOpen &&
      activeBottomTab === "terminal" &&
      activeTab.isConnected &&
      activeTab.protocol === "SFTP"
    ) {
      setActivatedTerminalTabs((prev) =>
        prev[activeTab.id] ? prev : { ...prev, [activeTab.id]: true }
      );
    }
  }, [enableSshTerminal, bottomOpen, activeBottomTab, activeTab.id, activeTab.isConnected, activeTab.protocol]);

  // Nettoyer l'état d'activation quand une session est déconnectée ou fermée
  useEffect(() => {
    setActivatedTerminalTabs((prev) => {
      const connectedIds = new Set(
        tabs.filter((t) => t.isConnected && t.protocol === "SFTP").map((t) => t.id)
      );
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [id, active] of Object.entries(prev)) {
        if (active && connectedIds.has(id)) {
          next[id] = true;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [tabs]);

  return (
    <>
      {/* Splitter console du bas */}
      <div
        onMouseDown={(e) => {
          const startY = e.clientY;
          const startH = bottomHeight;
          let latestH = startH;
          const onMouseMove = (ev: MouseEvent) => {
            latestH = Math.max(100, Math.min(500, startH - (ev.clientY - startY)));
            if (footerRef.current && bottomOpen) {
              footerRef.current.style.height = `${latestH}px`;
            }
          };
          const onMouseUp = () => {
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", onMouseUp);
            setBottomHeight(latestH);
          };
          window.addEventListener("mousemove", onMouseMove);
          window.addEventListener("mouseup", onMouseUp);
        }}
        className="h-1 bg-neutral-800 hover:bg-sky-500 cursor-row-resize transition"
        title="Glisser pour redimensionner la console inférieure"
      />

      {/* Console inférieure */}
      <footer
        ref={footerRef}
        style={{ height: bottomOpen ? `${bottomHeight}px` : "32px" }}
        className={`border-t flex flex-col ${
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
              <span>Fichiers en file d'attente ({runningOrQueuedCount})</span>
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
                  onClick={retryAllFailed}
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-normal text-amber-400 hover:text-amber-300 cursor-pointer transition active:scale-95"
                  title="Relancer tous les transferts échoués ou annulés"
                >
                  <RotateCcw className="h-3 w-3" />
                  <span>Relancer échecs</span>
                </button>
                <button
                  onClick={clearDone}
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-normal text-neutral-400 hover:text-neutral-200 cursor-pointer transition active:scale-95"
                  title="Vider les transferts terminés"
                >
                  <RotateCcw className="h-3 w-3" />
                  <span>Vider terminé</span>
                </button>
                <button
                  onClick={cancelAll}
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
            {enableSshTerminal &&
              tabs.map((tab) => {
                const isTabVisible = activeBottomTab === "terminal" && tab.id === activeTab.id;
                const shouldMount =
                  isTabVisible || (tab.isConnected && tab.protocol === "SFTP" && !!activatedTerminalTabs[tab.id]);
                if (!shouldMount) return null;
                return (
                  <div key={tab.id} className={`h-full w-full ${isTabVisible ? "block" : "hidden"}`}>
                    <Suspense
                      fallback={
                        <div className="flex h-full items-center justify-center text-xs text-neutral-500">
                          Chargement du terminal SSH...
                        </div>
                      }
                    >
                      <SshTerminal
                        sessionId={tab.id}
                        isConnected={tab.isConnected}
                        isVisible={isTabVisible}
                        protocol={tab.protocol}
                      />
                    </Suspense>
                  </div>
                );
              })}

            {activeBottomTab === "logs" && <LogsViewer bottomOpen={bottomOpen} />}

            {activeBottomTab === "queue" && <QueuePanel />}
          </div>
        )}
      </footer>
    </>
  );
}

export default memo(BottomPanelComponent);

import { useRef, useEffect } from "react";
import { ListOrdered, Terminal as TerminalIcon, RotateCcw, Ban, ChevronDown, ChevronUp } from "lucide-react";
import SshTerminal from "../../SshTerminal";
import QueuePanel from "../QueuePanel";
import { TabSession } from "../../types";
import { useTransferStore } from "../../store/useTransferStore";

interface Props {
  isDark: boolean;
  bottomHeight: number;
  setBottomHeight: (val: number) => void;
  bottomOpen: boolean;
  setBottomOpen: (val: boolean) => void;
  activeBottomTab: "logs" | "queue" | "terminal";
  setActiveBottomTab: (tab: "logs" | "queue" | "terminal") => void;
  enableSshTerminal: boolean;
  activeTab: TabSession;
  logs: string[];
}

export default function BottomPanel({
  isDark,
  bottomHeight,
  setBottomHeight,
  bottomOpen,
  setBottomOpen,
  activeBottomTab,
  setActiveBottomTab,
  enableSshTerminal,
  activeTab,
  logs,
}: Props) {
  const logsEndRef = useRef<HTMLDivElement>(null);

  const queue = useTransferStore((state) => state.queue);
  const clearDone = useTransferStore((state) => state.clearDone);
  const cancelAll = useTransferStore((state) => state.cancelAll);
  const retryAllFailed = useTransferStore((state) => state.retryAllFailed);

  const runningOrQueuedCount = queue.filter(
    (q) => q.status === "queued" || q.status === "running"
  ).length;

  useEffect(() => {
    if (activeBottomTab === "logs" && bottomOpen) {
      logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, activeBottomTab, bottomOpen]);

  return (
    <>
      {/* Splitter console du bas */}
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
        className={`border-t flex flex-col transition-all duration-150 ${
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
            {enableSshTerminal && (
              <div className={`h-full w-full ${activeBottomTab === "terminal" ? "block" : "hidden"}`}>
                <SshTerminal
                  sessionId={activeTab.id}
                  isConnected={activeTab.isConnected}
                  protocol={activeTab.protocol}
                />
              </div>
            )}

            {activeBottomTab === "logs" && (
              <div className="flex-1 overflow-y-auto p-2.5 font-mono text-[11px] space-y-1">
                {logs.map((log, idx) => (
                  <div key={idx} className="flex gap-2">
                    <span className="text-neutral-500">&gt;</span>
                    <span>{log}</span>
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>
            )}

            {activeBottomTab === "queue" && <QueuePanel />}
          </div>
        )}
      </footer>
    </>
  );
}

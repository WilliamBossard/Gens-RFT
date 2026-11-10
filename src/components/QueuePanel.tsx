import { memo } from "react";
import { useTransferStore } from "../store/useTransferStore";
import { Clock, CheckCircle, Ban, RotateCcw } from "lucide-react";

function QueuePanelComponent() {
  const queue = useTransferStore((state) => state.queue);
  const cancelItem = useTransferStore((state) => state.cancelItem);
  const retryItem = useTransferStore((state) => state.retryItem);

  if (queue.length === 0) {
    return (
      <div className="text-neutral-500 flex h-full items-center justify-center font-sans text-xs">
        File d'attente : vide
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-2.5 font-mono text-[11px] space-y-1">
      {queue.map((item) => (
        <div
          key={item.id}
          className="flex items-center justify-between border-b border-neutral-500/10 py-1.5 px-2 hover:bg-neutral-500/5 transition"
        >
          <div className="flex items-center gap-2 truncate max-w-md">
            {item.status === "running" && (
              <Clock className="h-3.5 w-3.5 text-sky-500 animate-spin shrink-0" />
            )}
            {item.status === "queued" && (
              <Clock className="h-3.5 w-3.5 text-neutral-500 shrink-0" />
            )}
            {item.status === "done" && (
              <CheckCircle className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
            )}
            {item.status === "error" && (
              <Ban className="h-3.5 w-3.5 text-rose-500 shrink-0" />
            )}
            <span className="truncate font-semibold">{item.filename}</span>
            <span className="text-neutral-500 shrink-0">({item.direction})</span>
            {item.errorReason && (
              <span className="text-rose-400 text-[10px] truncate max-w-xs" title={item.errorReason}>
                — {item.errorReason}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {item.status === "running" && (
              <>
                <span className="text-emerald-500 font-semibold">{item.speed}</span>
                <span className="text-neutral-400">ETA: {item.eta}</span>
                <div className="w-16 h-1.5 bg-neutral-800 rounded-full overflow-hidden shrink-0">
                  <div
                    className="h-full bg-sky-500 transition-all duration-100"
                    style={{ width: `${item.percent}%` }}
                  />
                </div>
                <span className="text-sky-500 w-9 text-right">{item.percent.toFixed(0)}%</span>
                <button
                  onClick={() => cancelItem(item.id)}
                  className="px-2 py-0.5 rounded bg-rose-600/80 hover:bg-rose-500 text-[10px] text-white cursor-pointer transition active:scale-95"
                >
                  Annuler
                </button>
              </>
            )}
            {item.status === "queued" && (
              <span className="text-neutral-500">En attente...</span>
            )}
            {item.status === "done" && (
              <span className="text-emerald-400">Terminé</span>
            )}
            {item.status === "error" && (
              <div className="flex items-center gap-2">
                <span className="text-rose-400">Échec</span>
                <button
                  onClick={() => retryItem(item.id)}
                  className="flex items-center gap-1 px-2 py-0.5 rounded bg-amber-600/80 hover:bg-amber-500 text-[10px] text-white cursor-pointer transition active:scale-95"
                  title="Relancer ce transfert"
                >
                  <RotateCcw className="h-2.5 w-2.5" />
                  <span>Réessayer</span>
                </button>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export const QueuePanel = memo(QueuePanelComponent);
export default QueuePanel;


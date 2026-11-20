import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface QueueItem {
  id: string;
  filename: string;
  sourcePath: string;
  destDir: string;
  destFileName: string;
  direction: "upload" | "download";
  isDir: boolean;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  percent: number;
  speed: string;
  eta: string;
  lastBytes: number;
  lastTimestamp: number;
  sessionId: string;
  relayToSessionId?: string;
  relayDestDir?: string;
  errorReason?: string;
}

interface TransferStore {
  queue: QueueItem[];
  maxConcurrent: number;
  scheduleTick: number;
  setMaxConcurrent: (limit: number) => void;
  addToQueue: (item: Omit<QueueItem, "id" | "status" | "percent" | "speed" | "eta" | "lastBytes" | "lastTimestamp">) => void;
  markManyRunning: (ids: string[]) => void;
  updateProgress: (transferId: string, transferred: number, total: number, percent: number) => void;
  resetProgress: (transferId: string) => void;
  markStatus: (id: string, status: QueueItem["status"], errorReason?: string) => void;
  clearDone: () => void;
  cancelAll: () => Promise<void>;
  cancelItem: (id: string) => Promise<void>;
  cancelSessionTransfers: (sessionId: string) => void;
  retryItem: (id: string) => void;
  retryAllFailed: () => void;
}

const MAX_FINISHED_QUEUE_ITEMS = 500;

function pruneFinishedItems(queue: QueueItem[]): QueueItem[] {
  let finishedCount = 0;
  for (const it of queue) {
    if (it.status !== "queued" && it.status !== "running") {
      finishedCount++;
    }
  }
  if (finishedCount <= MAX_FINISHED_QUEUE_ITEMS) {
    return queue;
  }
  let toDrop = finishedCount - MAX_FINISHED_QUEUE_ITEMS;
  return queue.filter((it) => {
    if (toDrop > 0 && it.status !== "queued" && it.status !== "running") {
      toDrop--;
      return false;
    }
    return true;
  });
}

function generateTransferId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export const useTransferStore = create<TransferStore>((set) => ({
  queue: [],
  maxConcurrent: 2,
  scheduleTick: 0,

  setMaxConcurrent: (limit) => set((state) => ({ maxConcurrent: limit, scheduleTick: state.scheduleTick + 1 })),

  addToQueue: (params) => {
    const newItem: QueueItem = {
      ...params,
      id: generateTransferId(),
      status: "queued",
      percent: 0,
      speed: "-- Mo/s",
      eta: "--",
      lastBytes: 0,
      lastTimestamp: Date.now(),
    };
    set((state) => ({ queue: [...state.queue, newItem], scheduleTick: state.scheduleTick + 1 }));
  },

  markManyRunning: (ids) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    set((state) => ({
      queue: state.queue.map((it) =>
        idSet.has(it.id) && it.status === "queued" ? { ...it, status: "running" } : it
      ),
      scheduleTick: state.scheduleTick + 1,
    }));
  },

  updateProgress: (transferId, transferred, total, percent) => {
    const now = Date.now();
    const safePercent = Math.min(100, Math.max(0, percent));
    set((state) => ({
      queue: state.queue.map((item) => {
        if (item.id !== transferId) return item;

        // Réinitialiser la baseline si un relais passe du download à l'upload
        if (transferred < item.lastBytes) {
          return {
            ...item,
            percent: safePercent,
            speed: "-- Mo/s",
            eta: "--",
            lastBytes: transferred,
            lastTimestamp: now,
          };
        }

        const deltaSec = (now - item.lastTimestamp) / 1000;
        let newSpeed = item.speed;
        let newEta = item.eta;

        if (deltaSec >= 0.4) {
          const deltaBytes = Math.max(0, transferred - item.lastBytes);
          const bytesPerSec = deltaBytes / deltaSec;

          if (bytesPerSec > 1024 * 1024) {
            newSpeed = `${(bytesPerSec / (1024 * 1024)).toFixed(1)} Mo/s`;
          } else if (bytesPerSec > 1024) {
            newSpeed = `${(bytesPerSec / 1024).toFixed(0)} Ko/s`;
          } else if (bytesPerSec > 0) {
            newSpeed = `${bytesPerSec.toFixed(0)} o/s`;
          }

          const remainingBytes = total > transferred ? total - transferred : 0;
          if (bytesPerSec > 0 && remainingBytes > 0) {
            const secondsLeft = Math.ceil(remainingBytes / bytesPerSec);
            newEta = secondsLeft < 60 ? `${secondsLeft}s` : `${Math.floor(secondsLeft / 60)}m ${secondsLeft % 60}s`;
          } else if (safePercent >= 100) {
            newEta = "0s";
          }

          return {
            ...item,
            percent: safePercent,
            speed: newSpeed,
            eta: newEta,
            lastBytes: transferred,
            lastTimestamp: now,
          };
        }
        return { ...item, percent: safePercent };
      }),
    }));
  },

  resetProgress: (transferId) => {
    const now = Date.now();
    set((state) => ({
      queue: state.queue.map((item) =>
        item.id === transferId
          ? {
              ...item,
              percent: 0,
              speed: "-- Mo/s",
              eta: "--",
              lastBytes: 0,
              lastTimestamp: now,
            }
          : item
      ),
    }));
  },

  markStatus: (id, status, errorReason) => {
    set((state) => {
      const updated = state.queue.map((it) => {
        if (it.id !== id) return it;
        if (it.status === "cancelled" && status !== "cancelled") {
          return it;
        }
        const isCancelled =
          status === "cancelled" ||
          (status === "error" &&
            (it.speed === "Annulé" ||
              errorReason === "Transfert annulé par l'utilisateur" ||
              errorReason === "Relais annulé par l'utilisateur ou session cible déconnectée"));
        const effectiveStatus: QueueItem["status"] = isCancelled ? "cancelled" : status;
        return {
          ...it,
          status: effectiveStatus,
          errorReason:
            effectiveStatus === "error" || effectiveStatus === "cancelled"
              ? errorReason || it.errorReason
              : undefined,
          percent: effectiveStatus === "done" ? 100 : it.percent,
          speed:
            effectiveStatus === "done"
              ? "Terminé"
              : effectiveStatus === "cancelled"
              ? "Annulé"
              : effectiveStatus === "error"
              ? "Échec"
              : it.speed,
          eta:
            effectiveStatus === "done"
              ? "0s"
              : effectiveStatus === "error" || effectiveStatus === "cancelled"
              ? "--"
              : it.eta,
        };
      });
      return {
        queue: pruneFinishedItems(updated),
        scheduleTick: state.scheduleTick + 1,
      };
    });
  },

  clearDone: () => {
    set((state) => ({
      queue: state.queue.filter((it) => it.status === "running" || it.status === "queued"),
    }));
  },

  cancelAll: async () => {
    set((state) => ({
      queue: state.queue.map((it) =>
        it.status === "queued" || it.status === "running"
          ? {
              ...it,
              status: "cancelled",
              speed: "Annulé",
              eta: "--",
              errorReason: "Annulé par l'utilisateur",
            }
          : it
      ),
      scheduleTick: state.scheduleTick + 1,
    }));
    await invoke("cancel_current_transfer", { transferId: null }).catch(() => {});
  },

  cancelItem: async (id: string) => {
    let wasRunning = false;
    let isRelay = false;
    set((state) => ({
      queue: state.queue.map((it) => {
        if (it.id === id && (it.status === "queued" || it.status === "running")) {
          if (it.status === "running") {
            wasRunning = true;
          }
          if (it.relayToSessionId) {
            isRelay = true;
          }
          return {
            ...it,
            status: "cancelled",
            speed: "Annulé",
            eta: "--",
            errorReason: "Annulé par l'utilisateur",
          };
        }
        return it;
      }),
      scheduleTick: state.scheduleTick + 1,
    }));
    if (wasRunning) {
      await invoke("cancel_current_transfer", { transferId: id }).catch(() => {});
      if (isRelay) {
        await invoke("cancel_current_transfer", { transferId: `${id}_relay` }).catch(() => {});
      }
    }
  },

  cancelSessionTransfers: (sessionId: string) => {
    set((state) => ({
      queue: state.queue.map((it) =>
        (it.status === "queued" || it.status === "running") &&
        (it.sessionId === sessionId || it.relayToSessionId === sessionId)
          ? {
              ...it,
              status: "cancelled",
              speed: "Annulé",
              eta: "--",
              errorReason: "Session déconnectée",
            }
          : it
      ),
      scheduleTick: state.scheduleTick + 1,
    }));
  },

  retryItem: (id) => {
    set((state) => ({
      queue: state.queue.map((it) =>
        it.id === id && (it.status === "error" || it.status === "cancelled")
          ? {
              ...it,
              id: generateTransferId(),
              status: "queued",
              errorReason: undefined,
              percent: 0,
              speed: "-- Mo/s",
              eta: "--",
              lastBytes: 0,
              lastTimestamp: Date.now(),
            }
          : it
      ),
      scheduleTick: state.scheduleTick + 1,
    }));
  },

  retryAllFailed: () => {
    set((state) => ({
      queue: state.queue.map((it) =>
        it.status === "error"
          ? {
              ...it,
              id: generateTransferId(),
              status: "queued",
              errorReason: undefined,
              percent: 0,
              speed: "-- Mo/s",
              eta: "--",
              lastBytes: 0,
              lastTimestamp: Date.now(),
            }
          : it
      ),
      scheduleTick: state.scheduleTick + 1,
    }));
  },
}));

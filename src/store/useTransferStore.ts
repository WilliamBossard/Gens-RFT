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
  status: "queued" | "running" | "done" | "error";
  percent: number;
  speed: string;
  eta: string;
  lastBytes: number;
  lastTimestamp: number;
  sessionId: string;
}

interface TransferStore {
  queue: QueueItem[];
  maxConcurrent: number;
  setMaxConcurrent: (limit: number) => void;
  addToQueue: (item: Omit<QueueItem, "id" | "status" | "percent" | "speed" | "eta" | "lastBytes" | "lastTimestamp">) => void;
  updateProgress: (transferId: string, transferred: number, total: number, percent: number) => void;
  markStatus: (id: string, status: QueueItem["status"]) => void;
  clearDone: () => void;
  cancelAll: () => Promise<void>;
  retryItem: (id: string) => void;
  retryAllFailed: () => void;
}

export const useTransferStore = create<TransferStore>((set) => ({
  queue: [],
  maxConcurrent: 2,

  setMaxConcurrent: (limit) => set({ maxConcurrent: limit }),

  addToQueue: (params) => {
    const newItem: QueueItem = {
      ...params,
      id: `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      status: "queued",
      percent: 0,
      speed: "-- Mo/s",
      eta: "--",
      lastBytes: 0,
      lastTimestamp: Date.now(),
    };
    set((state) => ({ queue: [...state.queue, newItem] }));
  },

  updateProgress: (transferId, transferred, total, percent) => {
    const now = Date.now();
    set((state) => ({
      queue: state.queue.map((item) => {
        if (item.id !== transferId) return item;
        const deltaSec = (now - item.lastTimestamp) / 1000;
        let newSpeed = item.speed;
        let newEta = item.eta;

        if (deltaSec >= 0.25) {
          const deltaBytes = Math.max(0, transferred - item.lastBytes);
          const bytesPerSec = deltaBytes / deltaSec;

          if (bytesPerSec > 1024 * 1024) {
            newSpeed = `${(bytesPerSec / (1024 * 1024)).toFixed(1)} Mo/s`;
          } else if (bytesPerSec > 1024) {
            newSpeed = `${(bytesPerSec / 1024).toFixed(0)} Ko/s`;
          } else {
            newSpeed = `${bytesPerSec.toFixed(0)} o/s`;
          }

          const remainingBytes = total > transferred ? total - transferred : 0;
          if (bytesPerSec > 0 && remainingBytes > 0) {
            const secondsLeft = Math.ceil(remainingBytes / bytesPerSec);
            newEta = secondsLeft < 60 ? `${secondsLeft}s` : `${Math.floor(secondsLeft / 60)}m ${secondsLeft % 60}s`;
          } else if (percent >= 100) {
            newEta = "0s";
          }

          return {
            ...item,
            percent,
            speed: newSpeed,
            eta: newEta,
            lastBytes: transferred,
            lastTimestamp: now,
          };
        }
        return { ...item, percent };
      }),
    }));
  },

  markStatus: (id, status) => {
    set((state) => ({
      queue: state.queue.map((it) => (it.id === id ? { ...it, status, percent: status === "done" ? 100 : it.percent } : it)),
    }));
  },

  clearDone: () => {
    set((state) => ({
      queue: state.queue.filter((it) => it.status === "running" || it.status === "queued"),
    }));
  },

  cancelAll: async () => {
    await invoke("cancel_current_transfer");
    set((state) => ({
      queue: state.queue.map((it) =>
        it.status === "queued" || it.status === "running" ? { ...it, status: "error", speed: "Annulé" } : it
      ),
    }));
  },

  retryItem: (id) => {
    set((state) => ({
      queue: state.queue.map((it) =>
        it.id === id ? { ...it, status: "queued", percent: 0, speed: "-- Mo/s", eta: "--", lastBytes: 0, lastTimestamp: Date.now() } : it
      ),
    }));
  },

  retryAllFailed: () => {
    set((state) => ({
      queue: state.queue.map((it) =>
        it.status === "error" ? { ...it, status: "queued", percent: 0, speed: "-- Mo/s", eta: "--", lastBytes: 0, lastTimestamp: Date.now() } : it
      ),
    }));
  },
}));

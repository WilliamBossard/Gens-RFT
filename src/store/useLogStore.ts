import { create } from "zustand";

interface LogStore {
  logs: string[];
  addLog: (msg: string) => void;
  clearLogs: () => void;
}

export const useLogStore = create<LogStore>((set) => ({
  logs: ["Gens-RFT initialisé."],
  addLog: (msg: string) => {
    const time = new Date().toLocaleTimeString();
    set((state) => ({
      logs: [...state.logs.slice(-999), `[${time}] ${msg}`],
    }));
  },
  clearLogs: () => set({ logs: [] }),
}));

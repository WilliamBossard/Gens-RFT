import type React from "react";
import { Plus, X } from "lucide-react";
import { TabSession, FileEntry } from "../../types";

interface Props {
  isDark: boolean;
  tabs: TabSession[];
  activeTabId: string;
  setActiveTabId: (id: string) => void;
  dragOverTabId: string | null;
  setDragOverTabId: (id: string | null) => void;
  editingTabId: string | null;
  setEditingTabId: (id: string | null) => void;
  editingTabTitle: string;
  setEditingTabTitle: (val: string) => void;
  draggedItem: { entry: FileEntry; from: "local" | "remote"; fromSessionId?: string } | null;
  skipCrossTabConfirm: boolean;
  onStartRenameTab: (tab: TabSession, e: React.MouseEvent) => void;
  onFinishRenameTab: () => void;
  onCloseTab: (tabId: string, e?: React.MouseEvent) => void;
  onCreateNewTab: () => void;
  onEnqueueCrossTabTransfer: (
    item: { entry: FileEntry; from: "local" | "remote"; fromSessionId?: string },
    targetTab: TabSession
  ) => void;
  onPromptCrossTabModal: (modal: {
    item: { entry: FileEntry; from: "local" | "remote"; fromSessionId?: string };
    targetTab: TabSession;
    neverAskAgain: boolean;
  }) => void;
}

export default function SessionTabs({
  isDark,
  tabs,
  activeTabId,
  setActiveTabId,
  dragOverTabId,
  setDragOverTabId,
  editingTabId,
  setEditingTabId,
  editingTabTitle,
  setEditingTabTitle,
  draggedItem,
  skipCrossTabConfirm,
  onStartRenameTab,
  onFinishRenameTab,
  onCloseTab,
  onCreateNewTab,
  onEnqueueCrossTabTransfer,
  onPromptCrossTabModal,
}: Props) {
  return (
    <div
      className={`flex items-center border-b px-2 gap-1 overflow-x-auto select-none ${
        isDark ? "border-neutral-800 bg-neutral-950 text-neutral-300" : "border-neutral-300 bg-neutral-200 text-neutral-800"
      }`}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const isEditing = editingTabId === tab.id;
        const isDropTarget = dragOverTabId === tab.id;

        return (
          <div
            key={tab.id}
            onClick={() => setActiveTabId(tab.id)}
            onDoubleClick={(e) => onStartRenameTab(tab, e)}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (draggedItem && draggedItem.fromSessionId !== tab.id) {
                setDragOverTabId(tab.id);
              }
            }}
            onDragLeave={() => setDragOverTabId(null)}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragOverTabId(null);
              if (draggedItem && tab.isConnected) {
                if (skipCrossTabConfirm) {
                  onEnqueueCrossTabTransfer(draggedItem, tab);
                } else {
                  onPromptCrossTabModal({
                    item: draggedItem,
                    targetTab: tab,
                    neverAskAgain: false,
                  });
                }
              }
            }}
            className={`group flex items-center gap-2 px-3 py-1.5 text-xs font-medium cursor-pointer border-b-2 transition-all duration-150 ${
              isDropTarget
                ? "border-sky-400 bg-sky-500/20 text-sky-300 ring-2 ring-sky-400 animate-pulse"
                : isActive
                ? isDark
                ? "border-sky-500 bg-neutral-800/80 text-sky-400 font-semibold"
                : "border-sky-600 bg-white text-sky-700 font-bold shadow-xs"
                : isDark
                ? "border-transparent text-neutral-400 hover:bg-neutral-800/40 hover:text-neutral-200"
                : "border-transparent text-neutral-600 hover:bg-neutral-300/60 hover:text-neutral-900"
            }`}
            title="Double-cliquez pour renommer, ou déposez un fichier ici pour transférer vers ce serveur"
          >
            <span
              className={`h-1.5 w-1.5 rounded-full transition-colors ${
                tab.isConnected ? "bg-emerald-400" : "bg-neutral-500"
              }`}
            />

            {isEditing ? (
              <input
                type="text"
                autoFocus
                value={editingTabTitle}
                onChange={(e) => setEditingTabTitle(e.target.value)}
                onBlur={onFinishRenameTab}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onFinishRenameTab();
                  if (e.key === "Escape") setEditingTabId(null);
                }}
                className="bg-neutral-900 border border-sky-500 rounded px-1.5 py-0.5 text-xs text-white focus:outline-none w-28"
              />
            ) : (
              <span className="truncate max-w-[140px]">{tab.title}</span>
            )}

            {tabs.length > 1 && (
              <button
                onClick={(e) => onCloseTab(tab.id, e)}
                className="rounded p-0.5 hover:bg-neutral-500/30 text-neutral-500 hover:text-rose-400 opacity-60 group-hover:opacity-100 transition"
                title="Fermer l'onglet (Ctrl+W)"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        );
      })}

      <button
        onClick={onCreateNewTab}
        className="p-1.5 rounded hover:bg-neutral-800 text-neutral-400 hover:text-white cursor-pointer ml-1 transition"
        title="Nouvel onglet (Ctrl+T)"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

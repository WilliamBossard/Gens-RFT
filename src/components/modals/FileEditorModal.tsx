import { useState, useEffect, useRef } from "react";
import { FileEdit, Search, Save, X, ChevronLeft, ChevronRight, AlertTriangle } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

export interface EditorModalState {
  path: string;
  filename: string;
  content: string;
  originalContent: string;
  isLossy?: boolean;
  saving?: boolean;
}

interface Props {
  editorModal: EditorModalState | null;
  onClose: () => void;
  activeTabId: string;
  onSuccess?: () => void;
  logMessage: (msg: string) => void;
  isDark?: boolean;
}

export default function FileEditorModal({
  editorModal,
  onClose,
  activeTabId,
  onSuccess,
  logMessage,
  isDark = true,
}: Props) {
  const [content, setContent] = useState(editorModal?.content || "");
  const [originalContent, setOriginalContent] = useState(editorModal?.originalContent || "");
  const [saving, setSaving] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatches, setSearchMatches] = useState<number[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [showConfirmClose, setShowConfirmClose] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editorModal) {
      setContent(editorModal.content);
      setOriginalContent(editorModal.originalContent);
      setSaving(false);
      setShowSearch(false);
      setSearchQuery("");
    }
  }, [editorModal]);

  useEffect(() => {
    if (!searchQuery) {
      setSearchMatches([]);
      setCurrentMatchIndex(0);
      return;
    }
    const q = searchQuery.toLowerCase();
    const c = content.toLowerCase();
    const matches: number[] = [];
    let pos = c.indexOf(q);
    while (pos !== -1 && matches.length < 1000) {
      matches.push(pos);
      pos = c.indexOf(q, pos + 1);
    }
    setSearchMatches(matches);
    setCurrentMatchIndex(matches.length > 0 ? 0 : -1);
  }, [searchQuery, content]);

  if (!editorModal) return null;

  const hasUnsavedChanges = content !== originalContent;

  const handleSave = async () => {
    setSaving(true);
    try {
      await invoke("save_remote_file_text", {
        sessionId: activeTabId,
        remotePath: editorModal.path,
        content,
      });
      logMessage(`Fichier sauvegardé avec succès : ${editorModal.filename}`);
      setOriginalContent(content);
      onSuccess?.();
    } catch (err) {
      logMessage(`Erreur de sauvegarde : ${err}`);
    } finally {
      setSaving(false);
    }
  };

  const jumpToMatch = (idx: number) => {
    if (searchMatches.length === 0) return;
    setCurrentMatchIndex(idx);
    const startPos = searchMatches[idx];
    if (textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(startPos, startPos + searchQuery.length);
    }
  };

  const handleRequestClose = () => {
    if (hasUnsavedChanges) {
      setShowConfirmClose(true);
    } else {
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/75 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div
        className={`flex flex-col w-[920px] h-[600px] rounded-xl border shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150 relative ${
          isDark ? "border-neutral-800 bg-neutral-900 text-neutral-200" : "border-neutral-300 bg-white text-neutral-800"
        }`}
      >
        {/* Boîte de dialogue de confirmation si modifications non enregistrées */}
        {showConfirmClose && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in duration-100">
            <div className={`w-80 rounded-xl border p-4 shadow-2xl space-y-3 ${isDark ? "bg-neutral-900 border-neutral-700 text-neutral-200" : "bg-white border-neutral-300 text-neutral-800"}`}>
              <h4 className="font-semibold text-xs text-amber-400">Modifications non enregistrées</h4>
              <p className="text-[11px] text-neutral-400">
                Vous avez modifié le fichier sans enregistrer. Voulez-vous vraiment quitter ? Toutes les modifications seront perdues.
              </p>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => setShowConfirmClose(false)}
                  className="px-3 py-1 rounded border border-neutral-700 text-xs text-neutral-300 hover:bg-neutral-800 cursor-pointer"
                >
                  Continuer l'édition
                </button>
                <button
                  onClick={() => {
                    setShowConfirmClose(false);
                    onClose();
                  }}
                  className="px-3 py-1 rounded bg-rose-600 hover:bg-rose-500 font-semibold text-xs text-white cursor-pointer"
                >
                  Quitter sans enregistrer
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-2 border-neutral-700/50">
          <div className="flex items-center gap-2">
            <FileEdit className="h-4 w-4 text-sky-400" />
            <span className="font-semibold text-xs font-mono">{editorModal.filename}</span>
            <span className="text-[11px] text-neutral-500">({editorModal.path})</span>
            {hasUnsavedChanges && (
              <span className="h-2 w-2 rounded-full bg-amber-400" title="Modifications non enregistrées" />
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowSearch(!showSearch)}
              className={`p-1.5 rounded text-xs flex items-center gap-1 border transition cursor-pointer ${
                showSearch
                  ? "border-sky-500 bg-sky-500/20 text-sky-400"
                  : "border-neutral-700 hover:bg-neutral-800 text-neutral-400"
              }`}
              title="Rechercher (Ctrl+F)"
            >
              <Search className="h-3.5 w-3.5" />
              <span className="text-[10px]">Rechercher</span>
            </button>
            <button
              disabled={saving}
              onClick={handleSave}
              className="flex items-center gap-1.5 px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white font-semibold text-xs cursor-pointer transition active:scale-95 disabled:opacity-50"
              title="Sauvegarder sur le serveur (Ctrl+S)"
            >
              <Save className="h-3.5 w-3.5" />
              <span>{saving ? "Sauvegarde..." : "Enregistrer"}</span>
            </button>
            <button
              onClick={handleRequestClose}
              className="p-1 rounded hover:bg-neutral-500/20 text-neutral-400 hover:text-white cursor-pointer transition"
              title="Fermer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Alerte encodage non-UTF-8 */}
        {editorModal.isLossy && (
          <div className="flex items-center gap-2 px-4 py-1.5 bg-amber-500/15 border-b border-amber-500/30 text-amber-400 text-[11px]">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>
              <strong>Attention :</strong> Ce fichier distant n'est pas en UTF-8 pur (ISO-8859-1 / ANSI détecté).
              L'enregistrement pourrait altérer certains caractères accentués.
            </span>
          </div>
        )}

        {/* Barre de recherche */}
        {showSearch && (
          <div className="flex items-center justify-between border-b px-3 py-1.5 bg-neutral-950/90 border-neutral-800 gap-2">
            <div className="flex items-center gap-2 flex-1">
              <Search className="h-3.5 w-3.5 text-sky-400 shrink-0" />
              <input
                type="text"
                autoFocus
                placeholder="Rechercher dans le fichier..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && searchMatches.length > 0) {
                    const nextIdx = (currentMatchIndex + 1) % searchMatches.length;
                    jumpToMatch(nextIdx);
                  } else if (e.key === "Escape") {
                    setShowSearch(false);
                  }
                }}
                className="bg-neutral-900 border border-neutral-700 rounded px-2 py-0.5 text-xs text-neutral-200 outline-none focus:border-sky-500 w-64 font-mono"
              />
              <span className="text-[11px] text-neutral-400">
                {searchMatches.length > 0
                  ? `${currentMatchIndex + 1} / ${searchMatches.length}`
                  : searchQuery
                  ? "0 résultat"
                  : ""}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                disabled={searchMatches.length === 0}
                onClick={() => {
                  const prevIdx =
                    (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length;
                  jumpToMatch(prevIdx);
                }}
                className="p-1 rounded hover:bg-neutral-800 text-neutral-400 hover:text-white disabled:opacity-30 cursor-pointer"
                title="Occurrence précédente"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <button
                disabled={searchMatches.length === 0}
                onClick={() => {
                  const nextIdx = (currentMatchIndex + 1) % searchMatches.length;
                  jumpToMatch(nextIdx);
                }}
                className="p-1 rounded hover:bg-neutral-800 text-neutral-400 hover:text-white disabled:opacity-30 cursor-pointer"
                title="Occurrence suivante"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setShowSearch(false)}
                className="p-1 rounded hover:bg-neutral-800 text-neutral-500 hover:text-white cursor-pointer ml-1"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Zone de code */}
        <div className="flex-1 bg-neutral-950 flex overflow-hidden font-mono text-xs relative">
          <div
            ref={lineNumbersRef}
            className="w-12 py-2 pr-2 text-right bg-neutral-900/60 text-neutral-600 border-r border-neutral-800/80 select-none overflow-hidden font-mono text-xs"
          >
            {content.split("\n").map((_, i) => (
              <div key={i} className="h-[20px] leading-[20px]">
                {i + 1}
              </div>
            ))}
          </div>

          <textarea
            ref={textareaRef}
            autoFocus
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onScroll={(e) => {
              if (lineNumbersRef.current) {
                lineNumbersRef.current.scrollTop = e.currentTarget.scrollTop;
              }
            }}
            onKeyDown={async (e) => {
              if (e.ctrlKey && e.key.toLowerCase() === "s") {
                e.preventDefault();
                await handleSave();
              }
              if (e.ctrlKey && e.key.toLowerCase() === "f") {
                e.preventDefault();
                setShowSearch(true);
              }
              if (e.key === "Escape") {
                if (showSearch) {
                  setShowSearch(false);
                } else {
                  handleRequestClose();
                }
              }
            }}
            className="flex-1 h-full resize-none bg-transparent text-neutral-200 outline-none p-2 leading-[20px] overflow-auto whitespace-pre font-mono selection:bg-sky-500/30 text-xs"
            placeholder="Contenu du fichier..."
            spellCheck={false}
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-neutral-800 px-4 py-1.5 text-[11px] text-neutral-500">
          <div className="flex items-center gap-3">
            <span>Lignes : {content.split("\n").length}</span>
            <span>Caractères : {content.length}</span>
          </div>
          <div className="flex items-center gap-3 text-[10px]">
            <span>Ctrl+F : Rechercher</span>
            <span>Ctrl+S : Sauvegarder</span>
          </div>
        </div>
      </div>
    </div>
  );
}


import { useState, useEffect } from "react";
import { X } from "lucide-react";
import { InputModalState } from "../../types";

interface Props {
  inputModal: InputModalState | null;
  onClose: () => void;
  isDark?: boolean;
}

export default function InputModal({ inputModal, onClose, isDark = true }: Props) {
  const [value, setValue] = useState(inputModal?.value ?? "");

  useEffect(() => {
    if (inputModal) {
      setValue(inputModal.value);
    }
  }, [inputModal]);

  if (!inputModal) return null;

  const submit = () => {
    inputModal.onConfirm(value);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div
        className={`w-80 rounded-xl border p-5 shadow-2xl space-y-4 animate-in zoom-in-95 duration-150 ${
          isDark ? "border-neutral-800 bg-neutral-900 text-neutral-200" : "border-neutral-300 bg-white text-neutral-800"
        }`}
      >
        <div className="flex items-center justify-between border-b pb-2 border-neutral-500/20">
          <span className="font-semibold text-sm">{inputModal.title}</span>
          <button onClick={onClose} className="text-neutral-400 hover:text-white cursor-pointer transition">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div>
          <label className="block text-xs text-neutral-400 mb-1">{inputModal.label}</label>
          <input
            type="text"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                submit();
              } else if (e.key === "Escape") {
                onClose();
              }
            }}
            className={`w-full rounded border px-3 py-1.5 text-xs focus:outline-none transition ${
              isDark ? "bg-neutral-950 border-neutral-700 text-neutral-100" : "bg-neutral-50 border-neutral-300 text-neutral-900"
            }`}
          />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded border border-neutral-700 text-xs text-neutral-400 hover:bg-neutral-500/10 cursor-pointer transition"
          >
            Annuler
          </button>
          <button
            onClick={submit}
            className="px-3 py-1.5 rounded bg-sky-600 font-semibold text-xs text-white hover:bg-sky-500 cursor-pointer transition active:scale-95"
          >
            Valider
          </button>
        </div>
      </div>
    </div>
  );
}

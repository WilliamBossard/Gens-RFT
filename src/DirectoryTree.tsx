import { Folder, ChevronRight, ChevronDown } from "lucide-react";

interface Props {
    isRemote: boolean;
    currentPath: string;
    subFolders: string[];
    onNavigate: (path: string) => void;
}

export default function DirectoryTree({ isRemote, currentPath, subFolders, onNavigate }: Props) {
    const parts = currentPath.split(isRemote ? "/" : /[\\/]/).filter(Boolean);

    return (
        <div className="p-2 font-mono text-xs select-none">
            {/* Racine */}
            <div
                onClick={() => onNavigate(isRemote ? "/" : "C:\\")}
                className={`flex items-center gap-1.5 py-1 px-1.5 rounded cursor-pointer transition ${currentPath === (isRemote ? "/" : "C:\\")
                    ? "bg-sky-500/20 text-sky-400 font-bold"
                    : "hover:bg-neutral-500/10 text-neutral-300"
                    }`}
            >
                <Folder className={`h-3.5 w-3.5 shrink-0 ${isRemote ? "text-sky-400" : "text-amber-400"}`} />
                <span>{isRemote ? "/ (Racine)" : "Disque local (C:)"}</span>
            </div>

            {/* Hiérarchie des dossiers parents ouverts */}
            {parts.map((part, idx) => {
                const subPath = isRemote
                    ? "/" + parts.slice(0, idx + 1).join("/")
                    : parts[0] + "\\" + parts.slice(1, idx + 1).join("\\");
                const isCurrent = subPath.toLowerCase() === currentPath.toLowerCase();

                return (
                    <div
                        key={idx}
                        style={{ paddingLeft: `${(idx + 1) * 14}px` }}
                        onClick={() => onNavigate(subPath)}
                        className={`flex items-center gap-1.5 py-1 px-1.5 rounded cursor-pointer truncate transition ${isCurrent
                            ? "bg-sky-500/20 text-sky-400 font-bold"
                            : "hover:bg-neutral-500/10 text-neutral-400"
                            }`}
                    >
                        <ChevronDown className="h-3 w-3 text-neutral-500 shrink-0" />
                        <Folder className={`h-3.5 w-3.5 shrink-0 ${isRemote ? "text-sky-400" : "text-amber-400"}`} />
                        <span className="truncate">{part}</span>
                    </div>
                );
            })}

            {/* Dossiers enfants immédiats (au niveau du dossier courant) */}
            {subFolders.map((dirName, idx) => {
                const childPath = isRemote
                    ? `${currentPath.replace(/\/$/, "")}/${dirName}`
                    : `${currentPath.replace(/\\$/, "")}\\${dirName}`;

                return (
                    <div
                        key={`child-${idx}`}
                        style={{ paddingLeft: `${(parts.length + 1) * 14}px` }}
                        onClick={() => onNavigate(childPath)}
                        className="flex items-center gap-1.5 py-1 px-1.5 rounded cursor-pointer hover:bg-neutral-500/15 text-neutral-300 truncate transition"
                    >
                        <ChevronRight className="h-3 w-3 text-neutral-600 shrink-0" />
                        <Folder className={`h-3.5 w-3.5 shrink-0 ${isRemote ? "text-sky-400" : "text-amber-500"}`} />
                        <span className="truncate">{dirName}</span>
                    </div>
                );
            })}
        </div>
    );
}
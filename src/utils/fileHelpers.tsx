import React from "react";
import { FileArchive, FileCode, FileImage, FileText, FileCheck } from "lucide-react";

export function isArchiveFile(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith(".zip") || n.endsWith(".tar.gz") || n.endsWith(".tgz") || n.endsWith(".tar");
}

const DANGEROUS_EXECUTABLE_RE =
  /\.(exe|bat|cmd|ps1|psm1|psd1|ps1xml|vbs|vbe|vba|js|jse|ws|wsc|wsf|wsh|hta|msi|msp|mst|msix|appx|appxbundle|msixbundle|appinstaller|msu|scr|com|pif|reg|sh|bash|zsh|lnk|msc|cpl|url|jar|jnlp|doc|docm|xls|xlsm|ppt|pptm|xll|wll|iqy|slk|inf|sct|chm|iso|img|vhd|vhdx|appref-ms|library-ms|search-ms|settingcontent-ms|diagcab|application|svg|html|htm|py|pyw|pyz|pyc|rb|pl|scf|gadget|dll|ocx|sys|desktop|command|pkg|dmg|rdp|ica|msh|msh1|msh2|mshxml|website)$/i;

export function isDangerousExecutable(name: string): boolean {
  const trimmed = name.replace(/[. ]+$/, "");
  return DANGEROUS_EXECUTABLE_RE.test(trimmed);
}

export function buildCopyFilename(
  filename: string,
  isDir: boolean,
  existingNames?: Set<string>
): string {
  const splitName = (raw: string): [string, string] => {
    if (isDir) return [raw, ""];
    const lower = raw.toLowerCase();
    for (const multiExt of [".tar.gz", ".tar.bz2", ".tar.xz"]) {
      if (lower.endsWith(multiExt) && raw.length > multiExt.length) {
        const idx = raw.length - multiExt.length;
        return [raw.slice(0, idx), raw.slice(idx)];
      }
    }
    const extIdx = raw.lastIndexOf(".");
    if (extIdx > 0) {
      return [raw.slice(0, extIdx), raw.slice(extIdx)];
    }
    return [raw, ""];
  };

  const [stem, ext] = splitName(filename);
  const firstCandidate = `${stem} (copie)${ext}`;
  if (!existingNames || !existingNames.has(firstCandidate.toLowerCase())) {
    existingNames?.add(firstCandidate.toLowerCase());
    return firstCandidate;
  }

  let counter = 2;
  while (true) {
    const candidate = `${stem} (copie ${counter})${ext}`;
    if (!existingNames.has(candidate.toLowerCase())) {
      existingNames.add(candidate.toLowerCase());
      return candidate;
    }
    counter++;
  }
}

export function isValidFilenameInput(name: string, isRemote: boolean): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return false;
  if (/[\x00-\x1f\x7f/\\]/.test(trimmed)) return false;
  if (!isRemote && /[<>:"|?*]/.test(trimmed)) return false;
  return true;
}

export function joinLocalPath(baseDir: string, name: string): string {
  const sep = baseDir.includes("/") && !baseDir.includes("\\") ? "/" : "\\";
  const clean = baseDir.replace(/[\\/]+$/, "");
  return `${clean}${sep}${name}`;
}

export function joinRemotePath(baseDir: string, name: string): string {
  if (!baseDir || baseDir === "/") return `/${name}`;
  return `${baseDir.replace(/\/+$/, "")}/${name}`;
}

export function isEditableTextFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const nonEditable = [
    "zip", "tar", "gz", "7z", "rar", "iso", "exe", "bin", "dll", "so",
    "png", "jpg", "jpeg", "gif", "webp", "ico", "mp4", "mkv", "avi", "mov", "mp3", "wav",
    "pdf", "docx", "xlsx", "pptx"
  ];
  if (nonEditable.includes(ext)) return false;
  const editable = [
    "txt", "md", "sh", "bash", "zsh", "rs", "py", "js", "jsx", "ts", "tsx",
    "json", "yml", "yaml", "toml", "conf", "cfg", "ini", "env", "css", "html",
    "log", "xml", "service", "rules"
  ];
  return editable.includes(ext) || !name.includes(".");
}

export function getFileBadge(name: string, isDark: boolean): { icon: React.ReactElement; color: string } {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["zip", "tar", "gz", "7z", "rar", "iso"].includes(ext)) {
    return {
      icon: <FileArchive className="h-4 w-4 text-amber-500 shrink-0" />,
      color: isDark ? "text-amber-400" : "text-amber-700",
    };
  }
  if (["rs", "ts", "tsx", "js", "jsx", "py", "sh", "json", "yml", "yaml", "toml", "css", "html"].includes(ext)) {
    return {
      icon: <FileCode className="h-4 w-4 text-emerald-500 shrink-0" />,
      color: isDark ? "text-emerald-300" : "text-emerald-700",
    };
  }
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "mp4", "mkv"].includes(ext)) {
    return {
      icon: <FileImage className="h-4 w-4 text-purple-500 shrink-0" />,
      color: isDark ? "text-purple-300" : "text-purple-700",
    };
  }
  if (["pdf", "docx", "doc", "txt", "md", "cfg", "conf", "ini", "env"].includes(ext)) {
    return {
      icon: <FileText className="h-4 w-4 text-sky-500 shrink-0" />,
      color: isDark ? "text-sky-300" : "text-sky-700",
    };
  }
  return {
    icon: <FileCheck className="h-4 w-4 text-neutral-400 shrink-0" />,
    color: isDark ? "text-neutral-300" : "text-neutral-800",
  };
}

export function formatOctalPermissions(permissions?: number): string {
  if (permissions === undefined || permissions === null) return "--";
  const p = permissions & 0o777;
  return `0${p.toString(8)}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} Go`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(0)} Ko`;
  }
  return `${bytes} o`;
}

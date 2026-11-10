import React from "react";
import { FileArchive, FileCode, FileImage, FileText, FileCheck } from "lucide-react";

export function isArchiveFile(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith(".zip") || n.endsWith(".tar.gz") || n.endsWith(".tgz") || n.endsWith(".tar");
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


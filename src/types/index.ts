export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  permissions?: number;
}

export interface TransferProgress {
  transfer_id: string;
  filename: string;
  transferred: number;
  total: number;
  percent: number;
  direction: "upload" | "download";
}

export interface TabSession {
  id: string;
  title: string;
  isConnected: boolean;
  protocol: "SFTP" | "FTP" | "FTPS";
  host: string;
  port: string;
  username: string;
  remotePath: string;
  remoteFiles: FileEntry[];
  siteId?: string;
  remoteHistory: string[];
  remoteHistoryIndex: number;
}

export interface QuickHistoryItem {
  host: string;
  port: string;
  username: string;
  protocol: "SFTP" | "FTP" | "FTPS";
}

export type SortField = "name" | "size";
export type SortOrder = "asc" | "desc";

export interface PendingConflict {
  filename: string;
  sourcePath: string;
  destDir: string;
  direction: "upload" | "download";
  isDir: boolean;
  destSessionId: string;
}

export interface ConfirmModalState {
  title: string;
  message: string;
  onConfirm: () => void;
}

export interface InputModalState {
  title: string;
  label: string;
  value: string;
  onConfirm: (val: string) => void;
}

export interface CrossTabModalState {
  item: { entry: FileEntry; from: "local" | "remote"; fromSessionId?: string };
  targetTab: TabSession;
  neverAskAgain: boolean;
}

export interface TabPromptModalState {
  pendingParams: {
    protocol: "SFTP" | "FTP" | "FTPS";
    host: string;
    port: string;
    username: string;
    authType: "password" | "key";
    password?: string;
    keyPath?: string;
    passphrase?: string;
    siteId?: string;
    initialRemotePath?: string;
    initialLocalPath?: string;
  };
}

export interface ContextMenuState {
  x: number;
  y: number;
  entry: FileEntry | null;
  isRemote: boolean;
}


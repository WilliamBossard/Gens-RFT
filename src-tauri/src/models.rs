use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub permissions: Option<u32>,
}

#[derive(Serialize, Clone, Debug)]
pub struct TransferProgress {
    pub transfer_id: String,
    pub filename: String,
    pub transferred: u64,
    pub total: u64,
    pub percent: f32,
    pub direction: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct RemoteTextFile {
    pub content: String,
    pub is_lossy: bool,
}

pub enum PtyCommand {
    Input(Vec<u8>),
    Resize { cols: u32, rows: u32 },
}

#[derive(Clone, Debug)]
pub enum HostKeyRejectReason {
    Unknown { algo: String, fingerprint: String },
    Changed { algo: String, fingerprint: String },
    Error(String),
}

use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

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

#[derive(Serialize, Deserialize, Clone, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct SiteProfile {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub host: String,
    pub port: String,
    pub auth_type: String,
    pub username: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
    #[serde(default)]
    pub last_remote_path: Option<String>,
    #[serde(default)]
    pub last_local_path: Option<String>,
    #[serde(default)]
    pub accept_invalid_certs: Option<bool>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SiteProfileSummary {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub host: String,
    pub port: String,
    pub auth_type: String,
    pub username: String,
    pub has_password: bool,
    pub key_path: Option<String>,
    pub has_passphrase: bool,
    pub last_remote_path: Option<String>,
    pub last_local_path: Option<String>,
    pub accept_invalid_certs: bool,
}

impl From<&SiteProfile> for SiteProfileSummary {
    fn from(p: &SiteProfile) -> Self {
        Self {
            id: p.id.clone(),
            name: p.name.clone(),
            protocol: p.protocol.clone(),
            host: p.host.clone(),
            port: p.port.clone(),
            auth_type: p.auth_type.clone(),
            username: p.username.clone(),
            has_password: p.password.as_deref().is_some_and(|s| !s.is_empty()),
            key_path: p.key_path.clone(),
            has_passphrase: p.passphrase.as_deref().is_some_and(|s| !s.is_empty()),
            last_remote_path: p.last_remote_path.clone(),
            last_local_path: p.last_local_path.clone(),
            accept_invalid_certs: p.accept_invalid_certs.unwrap_or(false),
        }
    }
}

#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct SiteProfileSaveInput {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub host: String,
    pub port: String,
    pub auth_type: String,
    pub username: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub clear_password: bool,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
    #[serde(default)]
    pub clear_passphrase: bool,
    #[serde(default)]
    pub last_remote_path: Option<String>,
    #[serde(default)]
    pub last_local_path: Option<String>,
    #[serde(default)]
    pub accept_invalid_certs: bool,
}

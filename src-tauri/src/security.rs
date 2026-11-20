use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use russh::client;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;
use zeroize::{Zeroize, Zeroizing};

use crate::models::{HostKeyRejectReason, SiteProfile, SiteProfileSaveInput, SiteProfileSummary};
use crate::state::AppState;

static SSH_KNOWN_HOSTS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static FTPS_CERTS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(any(windows, test))]
pub fn zeroize_bytes(buf: &mut [u8]) {
    buf.zeroize();
}

pub fn encrypt_vault_aes256_gcm(
    key: &[u8; 32],
    nonce_bytes: &[u8; 12],
    plaintext: &[u8],
) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| format!("Erreur initialisation clé AES-256-GCM: {}", e))?;
    let nonce = Nonce::from(*nonce_bytes);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|e| format!("Erreur chiffrement AES-256-GCM: {}", e))?;
    let mut out = Vec::with_capacity(12 + ciphertext.len());
    out.extend_from_slice(nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

#[cfg(any(not(windows), test))]
pub fn decrypt_vault_aes256_gcm(key: &[u8; 32], blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    if blob.len() < 12 + 16 {
        return Err("Coffre chiffré tronqué ou invalide".to_string());
    }
    let (nonce_bytes, ciphertext) = blob.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| format!("Erreur initialisation clé AES-256-GCM: {}", e))?;
    let nonce =
        Nonce::try_from(nonce_bytes).map_err(|_| "Nonce AES-256-GCM invalide".to_string())?;
    let plain = cipher.decrypt(&nonce, ciphertext).map_err(|_| {
        "Échec déchiffrement AES-256-GCM (clé invalide ou coffre altéré)".to_string()
    })?;
    Ok(Zeroizing::new(plain))
}

pub fn is_safe_local_path_components(path: &Path, allow_root_only: bool) -> bool {
    let raw = path.to_string_lossy();
    if raw.starts_with("\\\\") || raw.starts_with("//") {
        return false;
    }

    let mut has_normal = false;
    let mut has_root_or_disk = false;
    for comp in path.components() {
        match comp {
            Component::ParentDir => return false,
            Component::Normal(part) => {
                #[cfg(windows)]
                if part.to_string_lossy().contains(':') {
                    return false;
                }
                #[cfg(not(windows))]
                let _ = part;
                has_normal = true;
            }
            Component::Prefix(prefix) => {
                use std::path::Prefix;
                match prefix.kind() {
                    Prefix::Disk(_) => has_root_or_disk = true,
                    Prefix::UNC(_, _)
                    | Prefix::VerbatimUNC(_, _)
                    | Prefix::Verbatim(_)
                    | Prefix::VerbatimDisk(_)
                    | Prefix::DeviceNS(_) => return false,
                }
            }
            Component::RootDir => has_root_or_disk = true,
            Component::CurDir => {}
        }
    }
    has_normal || (allow_root_only && has_root_or_disk)
}

pub fn is_safe_local_path_no_traversal(path: &Path) -> bool {
    is_safe_local_path_components(path, false)
}

pub fn is_symlink_or_reparse_path(path: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return true;
        }
    }
    false
}

pub fn ensure_safe_local_path(path: &str) -> Result<(), String> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err("Chemin local invalide".to_string());
    }
    if !is_safe_local_path_no_traversal(Path::new(path)) {
        return Err("Chemin local non autorisé (traversée, UNC ou flux ADS détecté)".to_string());
    }
    Ok(())
}

pub fn ensure_safe_local_browse_path(path: &str) -> Result<(), String> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err("Chemin local invalide".to_string());
    }
    if !is_safe_local_path_components(Path::new(path), true) {
        return Err("Chemin local non autorisé (traversée, UNC ou flux ADS détecté)".to_string());
    }
    Ok(())
}

pub fn ensure_safe_local_dest_dir(path: &str) -> Result<(), String> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err("Dossier de destination local invalide".to_string());
    }
    if !is_safe_local_path_components(Path::new(path), true) {
        return Err(
            "Dossier de destination non autorisé (traversée, UNC ou flux ADS détecté)".to_string(),
        );
    }
    Ok(())
}

pub fn is_safe_local_delete_target(path: &Path) -> bool {
    let mut has_normal = false;
    let mut has_prefix_or_root = false;
    for comp in path.components() {
        match comp {
            Component::Prefix(_) | Component::RootDir => has_prefix_or_root = true,
            Component::Normal(_) => has_normal = true,
            Component::ParentDir => return false,
            Component::CurDir => {}
        }
    }
    if !has_normal {
        return false;
    }
    if has_prefix_or_root && path.parent().is_none() {
        return false;
    }
    // Sur Windows, "C:" seul a Prefix(Disk('C')) sans RootDir et parent() == Some("")
    let s = path.to_string_lossy();
    let trimmed = s.trim();
    if trimmed.len() == 2
        && trimmed.as_bytes()[0].is_ascii_alphabetic()
        && trimmed.as_bytes()[1] == b':'
    {
        return false;
    }

    #[cfg(windows)]
    {
        let normalized = trimmed
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase();
        if normalized.len() >= 2 && normalized.as_bytes()[1] == b':' {
            let rest = &normalized[2..];
            const PROTECTED_WIN_SUBPATHS: &[&str] = &[
                "\\windows",
                "\\program files",
                "\\program files (x86)",
                "\\programdata",
                "\\users",
                "\\system volume information",
            ];
            if PROTECTED_WIN_SUBPATHS.contains(&rest) {
                return false;
            }
        }
    }
    #[cfg(not(windows))]
    {
        let normalized = trimmed.trim_end_matches('/');
        const PROTECTED_UNIX_ROOTS: &[&str] = &[
            "/bin",
            "/boot",
            "/dev",
            "/etc",
            "/home",
            "/lib",
            "/lib64",
            "/proc",
            "/root",
            "/run",
            "/sbin",
            "/sys",
            "/usr",
            "/var",
            "/applications",
            "/system",
            "/library",
        ];
        if PROTECTED_UNIX_ROOTS.contains(&normalized.to_ascii_lowercase().as_str()) {
            return false;
        }
    }
    true
}

pub fn is_dangerous_executable_filename(name: &str) -> bool {
    let clean = sanitize_windows_filename(name);
    let lower = clean.to_ascii_lowercase();
    let Some(ext) = lower.rsplit('.').next() else {
        return false;
    };
    if !lower.contains('.') {
        return false;
    }
    const DANGEROUS_EXTS: &[&str] = &[
        "exe",
        "bat",
        "cmd",
        "ps1",
        "psm1",
        "psd1",
        "ps1xml",
        "vbs",
        "vbe",
        "vba",
        "js",
        "jse",
        "ws",
        "wsc",
        "wsf",
        "wsh",
        "hta",
        "msi",
        "msp",
        "mst",
        "msix",
        "appx",
        "appxbundle",
        "msixbundle",
        "appinstaller",
        "msu",
        "scr",
        "com",
        "pif",
        "reg",
        "sh",
        "bash",
        "zsh",
        "lnk",
        "msc",
        "cpl",
        "url",
        "jar",
        "jnlp",
        "doc",
        "docm",
        "xls",
        "xlsm",
        "ppt",
        "pptm",
        "xll",
        "wll",
        "iqy",
        "slk",
        "inf",
        "sct",
        "chm",
        "iso",
        "img",
        "vhd",
        "vhdx",
        "appref-ms",
        "library-ms",
        "search-ms",
        "settingcontent-ms",
        "diagcab",
        "application",
        "svg",
        "html",
        "htm",
        "py",
        "pyw",
        "pyz",
        "pyc",
        "rb",
        "pl",
        "scf",
        "gadget",
        "dll",
        "ocx",
        "sys",
        "desktop",
        "command",
        "pkg",
        "dmg",
        "rdp",
        "ica",
        "msh",
        "msh1",
        "msh2",
        "mshxml",
        "website",
    ];
    DANGEROUS_EXTS.contains(&ext)
}

#[derive(Clone)]
pub struct ClientHandler {
    pub host: String,
    pub port: u16,
    pub trust_host_key: bool,
    pub expected_fingerprint: Option<String>,
    pub reject_reason: Arc<Mutex<Option<HostKeyRejectReason>>>,
}

fn openssh_known_hosts_path() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|h| PathBuf::from(h).join(".ssh").join("known_hosts"))
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let pub_key = server_public_key.public_key();
        let algo = pub_key.algorithm().to_string();
        let fingerprint = pub_key
            .fingerprint(russh::keys::HashAlg::Sha256)
            .to_string();
        let host = self.host.clone();
        let port = self.port;
        let fp_for_task = fingerprint.clone();
        let trust_host_key = self.trust_host_key;
        let expected_fingerprint = self.expected_fingerprint.clone();

        enum KnownHostsOutcome {
            Trusted,
            Unknown,
            Changed,
            Err(String),
        }

        let outcome = tokio::task::spawn_blocking(move || {
            let _kh_guard = SSH_KNOWN_HOSTS_LOCK
                .lock()
                .map_err(|_| "Verrou known_hosts corrompu".to_string());
            if let Err(msg) = _kh_guard {
                return KnownHostsOutcome::Err(msg);
            }

            // 1. Vérifier ~/.ssh/known_hosts (standard OpenSSH)
            if let Some(kh_path) = openssh_known_hosts_path()
                && kh_path.exists()
            {
                match russh::keys::check_known_hosts_path(&host, port, &pub_key, &kh_path) {
                    Ok(true) => return KnownHostsOutcome::Trusted,
                    Ok(false) => {}
                    Err(russh::keys::Error::KeyChanged { .. }) => {
                        return KnownHostsOutcome::Changed;
                    }
                    Err(e) => {
                        return KnownHostsOutcome::Err(format!(
                            "Erreur lecture known_hosts: {}",
                            e
                        ));
                    }
                }
            }

            // 2. Fallback rétrocompatibilité avec l'emplacement par défaut de russh::keys
            match russh::keys::check_known_hosts(&host, port, &pub_key) {
                Ok(true) => return KnownHostsOutcome::Trusted,
                Ok(false) => {}
                Err(russh::keys::Error::KeyChanged { .. }) => return KnownHostsOutcome::Changed,
                Err(e) => {
                    return KnownHostsOutcome::Err(format!("Erreur lecture known_hosts: {}", e));
                }
            }

            // 3. Hôte inconnu : exiger une approbation explicite (avec vérification anti-TOCTOU de l'empreinte)
            if trust_host_key {
                if let Some(ref expected) = expected_fingerprint
                    && expected != &fp_for_task
                {
                    return KnownHostsOutcome::Changed;
                }
                let saved = if let Some(kh_path) = openssh_known_hosts_path() {
                    if let Some(parent) = kh_path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    russh::keys::known_hosts::learn_known_hosts_path(&host, port, &pub_key, kh_path)
                } else {
                    russh::keys::known_hosts::learn_known_hosts(&host, port, &pub_key)
                };
                if let Err(e) = saved {
                    return KnownHostsOutcome::Err(format!(
                        "Impossible d'enregistrer la clé d'hôte dans known_hosts: {}",
                        e
                    ));
                }
                return KnownHostsOutcome::Trusted;
            }

            KnownHostsOutcome::Unknown
        })
        .await
        .unwrap_or_else(|e| KnownHostsOutcome::Err(format!("Erreur tâche known_hosts: {}", e)));

        match outcome {
            KnownHostsOutcome::Trusted => Ok(true),
            KnownHostsOutcome::Unknown => {
                let mut guard = self.reject_reason.lock().await;
                *guard = Some(HostKeyRejectReason::Unknown { algo, fingerprint });
                Ok(false)
            }
            KnownHostsOutcome::Changed => {
                let mut guard = self.reject_reason.lock().await;
                *guard = Some(HostKeyRejectReason::Changed { algo, fingerprint });
                Ok(false)
            }
            KnownHostsOutcome::Err(msg) => {
                let mut guard = self.reject_reason.lock().await;
                *guard = Some(HostKeyRejectReason::Error(msg));
                Ok(false)
            }
        }
    }
}

pub fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn validate_ftp_arg(s: &str) -> Result<(), String> {
    if s.chars().any(|c| c == '\0' || c == '\r' || c == '\n') {
        return Err("Caractères de contrôle interdits dans le chemin FTP".to_string());
    }
    Ok(())
}

pub fn is_valid_remote_path(s: &str) -> bool {
    !s.is_empty() && !s.chars().any(|c| c < '\x20' || c == '\x7f')
}

pub fn is_safe_remote_delete_target(path: &str) -> bool {
    let trimmed = path.trim();
    if !is_valid_remote_path(trimmed) {
        return false;
    }
    let normalized = trimmed.trim_end_matches('/');
    if normalized.is_empty() || normalized == "." || normalized == ".." {
        return false;
    }
    if normalized.split('/').any(|seg| seg == "..") {
        return false;
    }
    const PROTECTED_SYSTEM_ROOTS: &[&str] = &[
        "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64", "/proc", "/root", "/run",
        "/sbin", "/sys", "/usr", "/var",
    ];
    !PROTECTED_SYSTEM_ROOTS.contains(&normalized)
}

pub fn is_valid_remote_filename(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && !s.contains(['/', '\\'])
        && !s.chars().any(|c| c < '\x20' || c == '\x7f')
}

/// Extrait le nom de fichier final d'un chemin POSIX distant sans appliquer les séparateurs Windows (`\`).
pub fn remote_file_name(path: &str) -> Option<&str> {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let name = trimmed.rsplit('/').next().unwrap_or(trimmed);
    if name.is_empty() || name == "." || name == ".." {
        None
    } else {
        Some(name)
    }
}

pub fn is_valid_local_filename(s: &str) -> bool {
    let trimmed = s.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || s.ends_with(['.', ' '])
        || s.contains(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])
        || s.chars().any(|c| c < '\x20' || c == '\x7f')
    {
        return false;
    }
    let uppercase = s.to_ascii_uppercase();
    let base_name = uppercase.split('.').next().unwrap_or(&uppercase);
    const DOS_RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "COM1", "COM2", "COM3", "COM4", "COM5",
        "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7",
        "LPT8", "LPT9",
    ];
    !DOS_RESERVED.contains(&base_name)
}

pub fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

pub fn sanitize_windows_filename(name: &str) -> String {
    let clean: String = name
        .chars()
        .map(|c| {
            if c < '\x20'
                || c == '\x7f'
                || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    let mut trimmed = clean.trim_end_matches(['.', ' ']).to_string();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return "unnamed_file".to_string();
    }
    let uppercase = trimmed.to_ascii_uppercase();
    let base_name = uppercase.split('.').next().unwrap_or(&uppercase);
    const DOS_RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "COM1", "COM2", "COM3", "COM4", "COM5",
        "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7",
        "LPT8", "LPT9",
    ];
    if DOS_RESERVED.contains(&base_name) {
        trimmed = format!("_{}", trimmed);
    }
    if trimmed.chars().count() > 240 {
        trimmed = trimmed.chars().take(240).collect();
    }
    trimmed
}

/// Évite les collisions de noms après assainissement Windows (ou différences de casse) lors du téléchargement d'un dossier.
pub fn unique_local_child_path(
    parent: &Path,
    raw_name: &str,
    used_lower_paths: &mut std::collections::HashSet<String>,
) -> PathBuf {
    let base_safe = sanitize_windows_filename(raw_name);
    let mut candidate = parent.join(&base_safe);
    let mut key = candidate.to_string_lossy().to_lowercase();
    if used_lower_paths.insert(key) {
        return candidate;
    }

    let (stem, ext) = match base_safe.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() && !e.is_empty() => (s.to_string(), format!(".{}", e)),
        _ => (base_safe.clone(), String::new()),
    };
    let mut counter = 2usize;
    loop {
        let renamed = format!("{} ({}){}", stem, counter, ext);
        candidate = parent.join(&renamed);
        key = candidate.to_string_lossy().to_lowercase();
        if used_lower_paths.insert(key) {
            return candidate;
        }
        counter += 1;
    }
}

#[cfg(windows)]
mod dpapi {
    use std::ffi::c_void;
    use std::ptr;

    #[repr(C)]
    #[allow(non_snake_case)]
    struct CRYPT_INTEGER_BLOB {
        cbData: u32,
        pbData: *mut u8,
    }

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    #[link(name = "crypt32")]
    unsafe extern "system" {
        fn CryptProtectData(
            pDataIn: *const CRYPT_INTEGER_BLOB,
            szDataDescr: *const u16,
            pOptionalEntropy: *const CRYPT_INTEGER_BLOB,
            pvReserved: *mut c_void,
            pPromptStruct: *mut c_void,
            dwFlags: u32,
            pDataOut: *mut CRYPT_INTEGER_BLOB,
        ) -> i32;

        fn CryptUnprotectData(
            pDataIn: *const CRYPT_INTEGER_BLOB,
            ppszDataDescr: *mut *mut u16,
            pOptionalEntropy: *const CRYPT_INTEGER_BLOB,
            pvReserved: *mut c_void,
            pPromptStruct: *mut c_void,
            dwFlags: u32,
            pDataOut: *mut CRYPT_INTEGER_BLOB,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LocalFree(hMem: *mut c_void) -> *mut c_void;
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
        let len_u32 = u32::try_from(plain.len())
            .map_err(|_| "Données trop volumineuses pour DPAPI".to_string())?;
        let mut plain_copy = plain.to_vec();
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: len_u32,
            pbData: plain_copy.as_mut_ptr(),
        };
        let mut out_blob = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };
        let ok = unsafe {
            CryptProtectData(
                &in_blob,
                ptr::null(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out_blob,
            )
        };
        super::zeroize_bytes(&mut plain_copy);
        if ok == 0 {
            return Err("CryptProtectData (DPAPI) a échoué".to_string());
        }
        let protected = unsafe {
            std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec()
        };
        unsafe {
            LocalFree(out_blob.pbData as *mut c_void);
        }
        Ok(protected)
    }

    pub fn unprotect(cipher: &[u8]) -> Result<Vec<u8>, String> {
        let len_u32 = u32::try_from(cipher.len())
            .map_err(|_| "Données chiffrées DPAPI trop volumineuses".to_string())?;
        let mut cipher_copy = cipher.to_vec();
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: len_u32,
            pbData: cipher_copy.as_mut_ptr(),
        };
        let mut out_blob = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };
        let ok = unsafe {
            CryptUnprotectData(
                &in_blob,
                ptr::null_mut(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out_blob,
            )
        };
        super::zeroize_bytes(&mut cipher_copy);
        if ok == 0 {
            return Err("CryptUnprotectData (DPAPI) a échoué".to_string());
        }
        let plain_slice =
            unsafe { std::slice::from_raw_parts_mut(out_blob.pbData, out_blob.cbData as usize) };
        let plain = plain_slice.to_vec();
        super::zeroize_bytes(plain_slice);
        unsafe {
            LocalFree(out_blob.pbData as *mut c_void);
        }
        Ok(plain)
    }
}

pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn sha256_fingerprint_der(der_bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(der_bytes);
    let digest = hasher.finalize();
    format!("SHA256:{}", to_hex(&digest))
}

#[cfg(any(not(windows), test))]
pub fn decode_hex_32(hex: &str) -> Option<[u8; 32]> {
    let trimmed = hex.trim();
    if trimmed.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    let (chunks, rem) = trimmed.as_bytes().as_chunks::<2>();
    if !rem.is_empty() {
        return None;
    }
    for (i, chunk) in chunks.iter().enumerate() {
        let s = std::str::from_utf8(chunk).ok()?;
        out[i] = u8::from_str_radix(s, 16).ok()?;
    }
    Some(out)
}

#[cfg(target_os = "macos")]
fn try_read_os_keyring() -> Option<Zeroizing<[u8; 32]>> {
    let out = std::process::Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            "com.william.gens-rft",
            "-a",
            "vault_master_key",
            "-w",
        ])
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let hex_str = Zeroizing::new(String::from_utf8_lossy(&out.stdout).to_string());
    decode_hex_32(&hex_str).map(Zeroizing::new)
}

#[cfg(target_os = "macos")]
fn try_write_os_keyring(key: &[u8; 32]) -> bool {
    use std::io::Write;
    let hex_key = Zeroizing::new(to_hex(key));
    let cmd_line = Zeroizing::new(format!(
        "add-generic-password -U -s \"com.william.gens-rft\" -a \"vault_master_key\" -w \"{}\"\n",
        hex_key.as_str()
    ));
    let Ok(mut child) = std::process::Command::new("/usr/bin/security")
        .arg("-i")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return false;
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(cmd_line.as_bytes());
    }
    let Ok(status) = child.wait() else {
        return false;
    };
    status.success() && try_read_os_keyring().is_some_and(|k| *k == *key)
}

#[cfg(target_os = "linux")]
fn try_read_os_keyring() -> Option<Zeroizing<[u8; 32]>> {
    let out = std::process::Command::new("secret-tool")
        .args([
            "lookup",
            "service",
            "com.william.gens-rft",
            "account",
            "vault_master_key",
        ])
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let hex_str = Zeroizing::new(String::from_utf8_lossy(&out.stdout).to_string());
    decode_hex_32(&hex_str).map(Zeroizing::new)
}

#[cfg(target_os = "linux")]
fn try_write_os_keyring(key: &[u8; 32]) -> bool {
    use std::io::Write;
    let hex_key = Zeroizing::new(to_hex(key));
    let Ok(mut child) = std::process::Command::new("secret-tool")
        .args([
            "store",
            "--label=Gens-RFT Vault Master Key",
            "service",
            "com.william.gens-rft",
            "account",
            "vault_master_key",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return false;
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(hex_key.as_bytes());
    }
    let Ok(status) = child.wait() else {
        return false;
    };
    status.success() && try_read_os_keyring().is_some_and(|k| *k == *key)
}

#[cfg(all(not(windows), not(target_os = "macos"), not(target_os = "linux")))]
fn try_read_os_keyring() -> Option<Zeroizing<[u8; 32]>> {
    None
}

#[cfg(all(not(windows), not(target_os = "macos"), not(target_os = "linux")))]
fn try_write_os_keyring(_key: &[u8; 32]) -> bool {
    false
}

#[cfg(not(windows))]
fn wipe_and_remove_file(path: &Path) {
    if let Ok(meta) = std::fs::symlink_metadata(path)
        && !meta.file_type().is_symlink()
        && let Ok(mut f) = std::fs::OpenOptions::new().write(true).open(path)
    {
        use std::io::Write;
        let zeros = vec![0u8; (meta.len() as usize).clamp(32, 4096)];
        let _ = f.write_all(&zeros);
        let _ = f.sync_all();
    }
    let _ = std::fs::remove_file(path);
}

fn vault_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Impossible de localiser app_local_data_dir: {}", e))?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Impossible de créer le dossier de données: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&data_dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(data_dir)
}

fn ensure_not_symlink(path: &Path, label: &str) -> Result<(), String> {
    if is_symlink_or_reparse_path(path) {
        return Err(format!(
            "Fichier {} rejeté pour des raisons de sécurité (lien symbolique détecté)",
            label
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn write_file_secure(path: &Path, data: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts
        .open(path)
        .map_err(|e| format!("Erreur ouverture sécurisée {}: {}", path.display(), e))?;
    file.write_all(data)
        .map_err(|e| format!("Erreur écriture sécurisée {}: {}", path.display(), e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[cfg(not(windows))]
fn get_or_create_unix_key(data_dir: &Path) -> Result<Zeroizing<[u8; 32]>, String> {
    use std::io::Read;
    let key_path = data_dir.join("vault.key");
    ensure_not_symlink(&key_path, "vault.key")?;

    if let Some(keyring_key) = try_read_os_keyring() {
        if key_path.exists() {
            wipe_and_remove_file(&key_path);
        }
        return Ok(keyring_key);
    }

    if key_path.exists() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600));
        }
        let mut data =
            std::fs::read(&key_path).map_err(|e| format!("Erreur lecture clé coffre: {}", e))?;
        if data.len() != 32 {
            data.zeroize();
            return Err("Clé coffre invalide (taille incorrecte)".to_string());
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&data);
        data.zeroize();
        let key = Zeroizing::new(arr);
        if try_write_os_keyring(&key) {
            wipe_and_remove_file(&key_path);
        }
        return Ok(key);
    }

    let mut raw = [0u8; 32];
    let mut f = std::fs::File::open("/dev/urandom")
        .map_err(|e| format!("Impossible d'ouvrir /dev/urandom: {}", e))?;
    f.read_exact(&mut raw).map_err(|e| e.to_string())?;
    let key = Zeroizing::new(raw);
    if try_write_os_keyring(&key) {
        return Ok(key);
    }
    write_file_secure(&key_path, &*key)
        .map_err(|e| format!("Erreur écriture clé coffre: {}", e))?;
    Ok(key)
}

#[cfg(not(windows))]
fn read_unix_random_nonce() -> Result<[u8; 12], String> {
    use std::io::Read;
    let mut nonce = [0u8; 12];
    let mut f = std::fs::File::open("/dev/urandom")
        .map_err(|e| format!("Impossible d'ouvrir /dev/urandom: {}", e))?;
    f.read_exact(&mut nonce).map_err(|e| e.to_string())?;
    Ok(nonce)
}

#[tauri::command]
pub fn load_vault_sites(app: AppHandle) -> Result<Option<String>, String> {
    let data_dir = vault_data_dir(&app)?;

    #[cfg(windows)]
    {
        let vault_path = data_dir.join("sites.dpapi");
        let bak_path = data_dir.join("sites.dpapi.bak");
        ensure_not_symlink(&vault_path, "sites.dpapi")?;
        ensure_not_symlink(&bak_path, "sites.dpapi.bak")?;
        let read_path = if vault_path.exists() {
            vault_path
        } else if bak_path.exists() {
            let _ = std::fs::rename(&bak_path, &vault_path);
            if vault_path.exists() {
                vault_path
            } else {
                bak_path
            }
        } else {
            return Ok(None);
        };
        let cipher = std::fs::read(&read_path)
            .map_err(|e| format!("Erreur lecture coffre sites DPAPI: {}", e))?;
        let plain = Zeroizing::new(dpapi::unprotect(&cipher)?);
        let json = String::from_utf8(plain.to_vec())
            .map_err(|e| format!("Coffre sites corrompu (UTF-8 invalide): {}", e))?;
        Ok(Some(json))
    }

    #[cfg(not(windows))]
    {
        let enc_path = data_dir.join("sites.vault.enc");
        ensure_not_symlink(&enc_path, "sites.vault.enc")?;
        if enc_path.exists() {
            let key = get_or_create_unix_key(&data_dir)?;
            let blob = std::fs::read(&enc_path)
                .map_err(|e| format!("Erreur lecture coffre chiffré: {}", e))?;
            let plain = decrypt_vault_aes256_gcm(&key, &blob)?;
            let json = String::from_utf8(plain.to_vec())
                .map_err(|e| format!("Coffre sites corrompu (UTF-8 invalide): {}", e))?;
            return Ok(Some(json));
        }

        // Migration unique depuis un éventuel ancien fichier JSON en clair
        let legacy_path = data_dir.join("sites.vault.json");
        if !legacy_path.exists() {
            return Ok(None);
        }
        let content = Zeroizing::new(
            std::fs::read_to_string(&legacy_path)
                .map_err(|e| format!("Erreur lecture coffre sites: {}", e))?,
        );
        save_vault_sites_non_windows(&data_dir, content.as_bytes())?;
        let _ = std::fs::remove_file(&legacy_path);
        Ok(Some(content.to_string()))
    }
}

#[cfg(not(windows))]
fn save_vault_sites_non_windows(data_dir: &Path, raw_bytes: &[u8]) -> Result<(), String> {
    let key = get_or_create_unix_key(data_dir)?;
    let nonce = read_unix_random_nonce()?;
    let encrypted = encrypt_vault_aes256_gcm(&key, &nonce, raw_bytes)?;

    let vault_path = data_dir.join("sites.vault.enc");
    let tmp_path = data_dir.join("sites.vault.enc.tmp");
    write_file_secure(&tmp_path, &encrypted)
        .map_err(|e| format!("Erreur écriture coffre chiffré: {}", e))?;
    std::fs::rename(&tmp_path, &vault_path)
        .map_err(|e| format!("Erreur finalisation coffre chiffré: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn save_vault_sites(app: AppHandle, json_payload: String) -> Result<(), String> {
    let data_dir = vault_data_dir(&app)?;
    let raw_bytes = Zeroizing::new(json_payload.into_bytes());

    #[cfg(windows)]
    {
        let vault_path = data_dir.join("sites.dpapi");
        let tmp_path = data_dir.join("sites.dpapi.tmp");
        let bak_path = data_dir.join("sites.dpapi.bak");
        ensure_not_symlink(&vault_path, "sites.dpapi")?;
        ensure_not_symlink(&tmp_path, "sites.dpapi.tmp")?;
        ensure_not_symlink(&bak_path, "sites.dpapi.bak")?;
        let protected = dpapi::protect(&raw_bytes)?;
        std::fs::write(&tmp_path, &protected)
            .map_err(|e| format!("Erreur écriture temporaire coffre DPAPI: {}", e))?;

        if std::fs::rename(&tmp_path, &vault_path).is_ok() {
            let _ = std::fs::remove_file(&bak_path);
            return Ok(());
        }

        // Fallback sécurisé avec sauvegarde .bak si le remplacement direct échoue
        let backed_up = vault_path.exists() && std::fs::rename(&vault_path, &bak_path).is_ok();
        match std::fs::rename(&tmp_path, &vault_path) {
            Ok(()) => {
                if backed_up {
                    let _ = std::fs::remove_file(&bak_path);
                }
                Ok(())
            }
            Err(e) => {
                if backed_up {
                    let _ = std::fs::rename(&bak_path, &vault_path);
                }
                let _ = std::fs::remove_file(&tmp_path);
                Err(format!("Erreur finalisation coffre DPAPI: {}", e))
            }
        }
    }

    #[cfg(not(windows))]
    {
        save_vault_sites_non_windows(&data_dir, &raw_bytes)
    }
}

#[tauri::command]
pub fn read_legacy_vault_key_if_exists(app: AppHandle) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let data_dir = vault_data_dir(&app)?;
        let key_path = data_dir.join("vault.dpapi");
        if key_path.exists() {
            let cipher =
                std::fs::read(&key_path).map_err(|e| format!("Erreur lecture clé DPAPI: {}", e))?;
            let plain = Zeroizing::new(dpapi::unprotect(&cipher)?);
            return Ok(Some(to_hex(&plain)));
        }
        Ok(None)
    }

    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(None)
    }
}

#[tauri::command]
pub fn delete_legacy_vault_key(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        let data_dir = vault_data_dir(&app)?;
        let key_path = data_dir.join("vault.dpapi");
        if key_path.exists() {
            let _ = std::fs::remove_file(key_path);
        }
    }
    #[cfg(not(windows))]
    let _ = app;
    Ok(())
}

// ============================================================================
// Isolation des profils de sites côté Rust & FTPS TOFU
// ============================================================================

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteSecretsPayload {
    pub password: String,
    pub passphrase: String,
}

fn persist_vault_profiles(app: &AppHandle, profiles: &[SiteProfile]) -> Result<(), String> {
    let json = serde_json::to_string(profiles)
        .map_err(|e| format!("Erreur sérialisation coffre: {}", e))?;
    save_vault_sites(app.clone(), json)
}

pub(crate) fn normalize_imported_profile(mut p: SiteProfile) -> Option<SiteProfile> {
    if p.name.trim().is_empty() || p.host.trim().is_empty() {
        return None;
    }
    p.protocol = match p.protocol.trim().to_uppercase().as_str() {
        "FTP" => "FTP".to_string(),
        "FTPS" => "FTPS".to_string(),
        _ => "SFTP".to_string(),
    };
    if p.protocol != "SFTP" || p.auth_type != "key" {
        p.auth_type = "password".to_string();
    }
    let default_port = if p.protocol == "SFTP" { "22" } else { "21" };
    let port_num = p.port.trim().parse::<u16>().ok().filter(|&n| n > 0);
    p.port = port_num
        .map(|n| n.to_string())
        .unwrap_or_else(|| default_port.to_string());
    if p.id.trim().is_empty() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        p.id = format!("site_{}", nanos);
    }
    Some(p)
}

#[tauri::command]
pub async fn load_vault_sites_summary(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<Vec<SiteProfileSummary>>, String> {
    let app_c = app.clone();
    let raw_opt = tokio::task::spawn_blocking(move || load_vault_sites(app_c))
        .await
        .map_err(|e| e.to_string())??;

    let Some(raw) = raw_opt else {
        let mut guard = state.vault_sites.lock().await;
        guard.clear();
        state.vault_loaded.store(true, Ordering::Relaxed);
        return Ok(None);
    };

    let raw_z = Zeroizing::new(raw);
    let parsed: Vec<SiteProfile> = serde_json::from_str(&raw_z)
        .map_err(|e| format!("Format du coffre backend invalide: {}", e))?;
    let summaries: Vec<SiteProfileSummary> = parsed.iter().map(SiteProfileSummary::from).collect();

    let mut guard = state.vault_sites.lock().await;
    *guard = parsed;
    state.vault_loaded.store(true, Ordering::Relaxed);
    Ok(Some(summaries))
}

#[tauri::command]
pub async fn save_site_profile(
    app: AppHandle,
    input: SiteProfileSaveInput,
    state: State<'_, AppState>,
) -> Result<Vec<SiteProfileSummary>, String> {
    if !state.vault_loaded.load(Ordering::Relaxed) {
        return Err(
            "Coffre non initialisé ou verrouillé (sauvegarde bloquée par sécurité).".to_string(),
        );
    }
    let mut guard = state.vault_sites.lock().await;
    let existing = guard.iter().find(|s| s.id == input.id).cloned();

    let next_password = if input.clear_password {
        None
    } else if let Some(ref pwd) = input.password
        && !pwd.is_empty()
    {
        Some(pwd.clone())
    } else {
        existing.as_ref().and_then(|s| s.password.clone())
    };

    let next_passphrase = if input.clear_passphrase {
        None
    } else if let Some(ref pp) = input.passphrase
        && !pp.is_empty()
    {
        Some(pp.clone())
    } else {
        existing.as_ref().and_then(|s| s.passphrase.clone())
    };

    let normalized_protocol = match input.protocol.trim().to_uppercase().as_str() {
        "FTP" => "FTP".to_string(),
        "FTPS" => "FTPS".to_string(),
        _ => "SFTP".to_string(),
    };
    let normalized_auth = if normalized_protocol == "SFTP" && input.auth_type == "key" {
        "key".to_string()
    } else {
        "password".to_string()
    };

    let updated = SiteProfile {
        id: input.id.clone(),
        name: input.name.clone(),
        protocol: normalized_protocol,
        host: input.host.clone(),
        port: input.port.clone(),
        auth_type: normalized_auth,
        username: input.username.clone(),
        password: next_password,
        key_path: input.key_path.clone(),
        passphrase: next_passphrase,
        last_remote_path: input.last_remote_path.clone(),
        last_local_path: input.last_local_path.clone(),
        accept_invalid_certs: Some(input.accept_invalid_certs),
    };

    if let Some(slot) = guard.iter_mut().find(|s| s.id == input.id) {
        *slot = updated;
    } else {
        guard.push(updated);
    }

    let snapshot = guard.clone();
    let summaries: Vec<SiteProfileSummary> = guard.iter().map(SiteProfileSummary::from).collect();
    drop(guard);

    let app_c = app.clone();
    tokio::task::spawn_blocking(move || persist_vault_profiles(&app_c, &snapshot))
        .await
        .map_err(|e| e.to_string())??;

    Ok(summaries)
}

#[tauri::command]
pub async fn delete_site_profile(
    app: AppHandle,
    site_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<SiteProfileSummary>, String> {
    if !state.vault_loaded.load(Ordering::Relaxed) {
        return Err("Coffre non initialisé ou verrouillé.".to_string());
    }
    let mut guard = state.vault_sites.lock().await;
    guard.retain(|s| s.id != site_id);
    let snapshot = guard.clone();
    let summaries: Vec<SiteProfileSummary> = guard.iter().map(SiteProfileSummary::from).collect();
    drop(guard);

    let app_c = app.clone();
    tokio::task::spawn_blocking(move || persist_vault_profiles(&app_c, &snapshot))
        .await
        .map_err(|e| e.to_string())??;

    Ok(summaries)
}

#[tauri::command]
pub async fn import_vault_profiles(
    app: AppHandle,
    profiles_json: String,
    state: State<'_, AppState>,
) -> Result<Vec<SiteProfileSummary>, String> {
    if !state.vault_loaded.load(Ordering::Relaxed) {
        return Err("Coffre non initialisé ou verrouillé.".to_string());
    }
    let raw_z = Zeroizing::new(profiles_json);
    let incoming: Vec<SiteProfile> = serde_json::from_str(&raw_z)
        .map_err(|e| format!("Format JSON des profils invalide: {}", e))?;

    let mut guard = state.vault_sites.lock().await;
    for raw_prof in incoming {
        if let Some(norm) = normalize_imported_profile(raw_prof) {
            if let Some(slot) = guard.iter_mut().find(|s| s.id == norm.id) {
                *slot = norm;
            } else {
                guard.push(norm);
            }
        }
    }
    let snapshot = guard.clone();
    let summaries: Vec<SiteProfileSummary> = guard.iter().map(SiteProfileSummary::from).collect();
    drop(guard);

    let app_c = app.clone();
    tokio::task::spawn_blocking(move || persist_vault_profiles(&app_c, &snapshot))
        .await
        .map_err(|e| e.to_string())??;

    Ok(summaries)
}

#[tauri::command]
pub async fn get_site_secrets_for_edit(
    site_id: String,
    state: State<'_, AppState>,
) -> Result<SiteSecretsPayload, String> {
    if !state.vault_loaded.load(Ordering::Relaxed) {
        return Err("Coffre non initialisé ou verrouillé.".to_string());
    }
    let guard = state.vault_sites.lock().await;
    let site = guard
        .iter()
        .find(|s| s.id == site_id)
        .ok_or_else(|| "Profil introuvable dans le coffre".to_string())?;
    Ok(SiteSecretsPayload {
        password: site.password.clone().unwrap_or_default(),
        passphrase: site.passphrase.clone().unwrap_or_default(),
    })
}

#[cfg(windows)]
fn fill_csprng_bytes(buf: &mut [u8]) -> Result<(), String> {
    const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;
    #[link(name = "bcrypt")]
    unsafe extern "system" {
        fn BCryptGenRandom(
            hAlgorithm: *mut std::ffi::c_void,
            pbBuffer: *mut u8,
            cbBuffer: u32,
            dwFlags: u32,
        ) -> i32;
    }
    let len_u32 =
        u32::try_from(buf.len()).map_err(|_| "Buffer aléatoire trop grand".to_string())?;
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            buf.as_mut_ptr(),
            len_u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        return Err(format!("Échec BCryptGenRandom (status: {})", status));
    }
    Ok(())
}

#[cfg(not(windows))]
fn fill_csprng_bytes(buf: &mut [u8]) -> Result<(), String> {
    use std::io::Read;
    let mut f = std::fs::File::open("/dev/urandom")
        .map_err(|e| format!("Impossible d'ouvrir /dev/urandom: {}", e))?;
    f.read_exact(buf)
        .map_err(|e| format!("Erreur lecture /dev/urandom: {}", e))
}

pub fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = if chunk.len() > 1 {
            chunk[1] as usize
        } else {
            0
        };
        let b2 = if chunk.len() > 2 {
            chunk[2] as usize
        } else {
            0
        };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(triple >> 18) & 0x3f] as char);
        out.push(TABLE[(triple >> 12) & 0x3f] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(triple >> 6) & 0x3f] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[triple & 0x3f] as char
        } else {
            '='
        });
    }
    out
}

pub fn pbkdf2_hmac_sha256(password: &[u8], salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut key_block = Zeroizing::new([0u8; 64]);
    if password.len() > 64 {
        let digest = Sha256::digest(password);
        key_block[..32].copy_from_slice(&digest);
    } else {
        key_block[..password.len()].copy_from_slice(password);
    }

    let mut ipad = Zeroizing::new([0x36u8; 64]);
    let mut opad = Zeroizing::new([0x5cu8; 64]);
    for i in 0..64 {
        ipad[i] ^= key_block[i];
        opad[i] ^= key_block[i];
    }

    let mut inner_base = Sha256::new();
    inner_base.update(*ipad);
    let mut outer_base = Sha256::new();
    outer_base.update(*opad);

    let mut u_prev = {
        let mut inner = inner_base.clone();
        inner.update(salt);
        inner.update(1u32.to_be_bytes());
        let first = inner.finalize();
        let mut outer = outer_base.clone();
        outer.update(first);
        let res: [u8; 32] = outer.finalize().into();
        res
    };

    let mut dk = u_prev;
    for _ in 1..iterations {
        let mut inner = inner_base.clone();
        inner.update(u_prev);
        let mid = inner.finalize();
        let mut outer = outer_base.clone();
        outer.update(mid);
        u_prev = outer.finalize().into();
        for (d, &u) in dk.iter_mut().zip(u_prev.iter()) {
            *d ^= u;
        }
    }
    dk
}

pub fn export_vault_v5_encrypted(
    profiles: &[SiteProfile],
    export_password: &str,
) -> Result<String, String> {
    let trimmed = export_password.trim();
    if trimmed.chars().count() < 8 {
        return Err(
            "Un mot de passe d'au moins 8 caractères est requis pour exporter les profils."
                .to_string(),
        );
    }
    let mut salt = [0u8; 16];
    let mut iv = [0u8; 12];
    fill_csprng_bytes(&mut salt)?;
    fill_csprng_bytes(&mut iv)?;

    let json = Zeroizing::new(
        serde_json::to_string(profiles)
            .map_err(|e| format!("Erreur sérialisation export: {}", e))?,
    );
    let key = Zeroizing::new(pbkdf2_hmac_sha256(trimmed.as_bytes(), &salt, 600_000));
    let combined = encrypt_vault_aes256_gcm(&key, &iv, json.as_bytes())?;
    let ciphertext = &combined[12..];

    Ok(format!(
        "enc:v5:pwd:{}:{}:{}",
        to_hex(&salt),
        base64_encode(&iv),
        base64_encode(ciphertext)
    ))
}

#[tauri::command]
pub async fn export_vault_encrypted_to_path(
    file_path: String,
    export_password: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !state.vault_loaded.load(Ordering::Relaxed) {
        return Err("Coffre non initialisé ou verrouillé.".to_string());
    }
    ensure_safe_local_path(&file_path)?;
    ensure_not_symlink(Path::new(&file_path), "export")?;

    let password_z = Zeroizing::new(export_password);
    if password_z.trim().chars().count() < 8 {
        return Err(
            "Un mot de passe d'au moins 8 caractères est requis pour exporter les profils."
                .to_string(),
        );
    }

    let snapshot = {
        let guard = state.vault_sites.lock().await;
        guard.clone()
    };

    tokio::task::spawn_blocking(move || {
        let encrypted = export_vault_v5_encrypted(&snapshot, &password_z)?;
        std::fs::write(&file_path, encrypted)
            .map_err(|e| format!("Impossible d'écrire le fichier : {}", e))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FtpsCertTrustStatus {
    Unknown,
    Trusted,
    Changed { expected: String },
}

fn known_ftps_certs_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = vault_data_dir(app)?;
    Ok(dir.join("known_ftps_certs.json"))
}

pub fn check_known_ftps_cert(
    app: &AppHandle,
    host: &str,
    port: u16,
    fingerprint: &str,
) -> Result<FtpsCertTrustStatus, String> {
    let _guard = FTPS_CERTS_LOCK
        .lock()
        .map_err(|_| "Verrou known_ftps_certs corrompu".to_string())?;
    let path = known_ftps_certs_path(app)?;
    ensure_not_symlink(&path, "known_ftps_certs.json")?;
    if !path.exists() {
        return Ok(FtpsCertTrustStatus::Unknown);
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Erreur lecture known_ftps_certs.json: {}", e))?;
    let map: HashMap<String, String> = serde_json::from_str(&raw).unwrap_or_default();
    let key = format!("{}:{}", host.to_ascii_lowercase(), port);
    match map.get(&key) {
        None => Ok(FtpsCertTrustStatus::Unknown),
        Some(saved) if saved == fingerprint => Ok(FtpsCertTrustStatus::Trusted),
        Some(saved) => Ok(FtpsCertTrustStatus::Changed {
            expected: saved.clone(),
        }),
    }
}

pub fn save_known_ftps_cert(
    app: &AppHandle,
    host: &str,
    port: u16,
    fingerprint: &str,
) -> Result<(), String> {
    let _guard = FTPS_CERTS_LOCK
        .lock()
        .map_err(|_| "Verrou known_ftps_certs corrompu".to_string())?;
    let path = known_ftps_certs_path(app)?;
    ensure_not_symlink(&path, "known_ftps_certs.json")?;
    let mut map: HashMap<String, String> = if path.exists() {
        let raw = std::fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&raw).unwrap_or_default()
    } else {
        HashMap::new()
    };
    let key = format!("{}:{}", host.to_ascii_lowercase(), port);
    map.insert(key, fingerprint.to_string());
    let json = serde_json::to_string_pretty(&map)
        .map_err(|e| format!("Erreur sérialisation known_ftps_certs: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    ensure_not_symlink(&tmp, "known_ftps_certs.json.tmp")?;
    std::fs::write(&tmp, json.as_bytes())
        .map_err(|e| format!("Erreur écriture known_ftps_certs.tmp: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &path)
        .map_err(|e| format!("Erreur finalisation known_ftps_certs.json: {}", e))?;
    Ok(())
}

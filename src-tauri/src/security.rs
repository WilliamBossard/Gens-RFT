#[cfg(any(not(windows), test))]
use aes_gcm::aead::{Aead, KeyInit};
#[cfg(any(not(windows), test))]
use aes_gcm::{Aes256Gcm, Nonce};
use async_trait::async_trait;
use russh::client;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;
use zeroize::{Zeroize, Zeroizing};

use crate::models::HostKeyRejectReason;

#[cfg(any(windows, test))]
pub fn zeroize_bytes(buf: &mut [u8]) {
    buf.zeroize();
}

#[cfg(any(not(windows), test))]
pub fn encrypt_vault_aes256_gcm(key: &[u8; 32], nonce_bytes: &[u8; 12], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| format!("Erreur initialisation clé AES-256-GCM: {}", e))?;
    let nonce = Nonce::from_slice(nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
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
    let nonce = Nonce::from_slice(nonce_bytes);
    let plain = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "Échec déchiffrement AES-256-GCM (clé invalide ou coffre altéré)".to_string())?;
    Ok(Zeroizing::new(plain))
}

pub fn is_safe_local_path_no_traversal(path: &Path) -> bool {
    let mut has_normal = false;
    for comp in path.components() {
        match comp {
            Component::ParentDir => return false,
            Component::Normal(_) => has_normal = true,
            Component::Prefix(_) | Component::RootDir | Component::CurDir => {}
        }
    }
    has_normal
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
    !(trimmed.len() == 2 && trimmed.as_bytes()[0].is_ascii_alphabetic() && trimmed.as_bytes()[1] == b':')
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
        "exe", "bat", "cmd", "ps1", "psm1", "psd1", "ps1xml", "vbs", "vbe", "vba", "js", "jse",
        "ws", "wsc", "wsf", "wsh", "hta", "msi", "msp", "mst", "msix", "appx", "appxbundle",
        "msixbundle", "appinstaller", "msu", "scr", "com", "pif", "reg", "sh", "bash", "zsh",
        "lnk", "msc", "cpl", "url", "jar", "jnlp", "doc", "docm", "xls", "xlsm", "ppt", "pptm",
        "xll", "wll", "iqy", "slk", "inf", "sct", "chm", "iso", "img", "vhd", "vhdx",
        "appref-ms", "library-ms", "search-ms", "settingcontent-ms", "diagcab", "application",
        "svg", "html", "htm", "py", "pyw", "pyz", "pyc", "rb", "pl", "scf", "gadget", "dll",
        "ocx", "sys", "desktop", "command", "pkg", "dmg", "rdp", "ica", "msh", "msh1", "msh2",
        "mshxml", "website",
    ];
    DANGEROUS_EXTS.contains(&ext)
}

#[derive(Clone)]
pub struct ClientHandler {
    pub host: String,
    pub port: u16,
    pub trust_host_key: bool,
    pub reject_reason: Arc<Mutex<Option<HostKeyRejectReason>>>,
}

fn openssh_known_hosts_path() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|h| PathBuf::from(h).join(".ssh").join("known_hosts"))
}

#[async_trait]
impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let algo = server_public_key.name().to_string();
        let fingerprint = server_public_key.fingerprint();

        // 1. Vérifier ~/.ssh/known_hosts (standard OpenSSH)
        if let Some(kh_path) = openssh_known_hosts_path()
            && kh_path.exists()
        {
            match russh_keys::check_known_hosts_path(
                &self.host,
                self.port,
                server_public_key,
                &kh_path,
            ) {
                Ok(true) => return Ok(true),
                Ok(false) => {}
                Err(russh_keys::Error::KeyChanged { .. }) => {
                    let mut guard = self.reject_reason.lock().await;
                    *guard = Some(HostKeyRejectReason::Changed { algo, fingerprint });
                    return Ok(false);
                }
                Err(e) => {
                    let mut guard = self.reject_reason.lock().await;
                    *guard = Some(HostKeyRejectReason::Error(format!(
                        "Erreur lecture known_hosts: {}",
                        e
                    )));
                    return Ok(false);
                }
            }
        }

        // 2. Fallback rétrocompatibilité avec l'emplacement par défaut de russh_keys
        match russh_keys::check_known_hosts(&self.host, self.port, server_public_key) {
            Ok(true) => return Ok(true),
            Ok(false) => {}
            Err(russh_keys::Error::KeyChanged { .. }) => {
                let mut guard = self.reject_reason.lock().await;
                *guard = Some(HostKeyRejectReason::Changed { algo, fingerprint });
                return Ok(false);
            }
            Err(e) => {
                let mut guard = self.reject_reason.lock().await;
                *guard = Some(HostKeyRejectReason::Error(format!(
                    "Erreur lecture known_hosts: {}",
                    e
                )));
                return Ok(false);
            }
        }

        // 3. Hôte inconnu : exiger une approbation explicite de l'utilisateur
        if self.trust_host_key {
            let saved = if let Some(kh_path) = openssh_known_hosts_path() {
                if let Some(parent) = kh_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                russh_keys::learn_known_hosts_path(&self.host, self.port, server_public_key, kh_path)
            } else {
                russh_keys::learn_known_hosts(&self.host, self.port, server_public_key)
            };
            if let Err(e) = saved {
                let mut guard = self.reject_reason.lock().await;
                *guard = Some(HostKeyRejectReason::Error(format!(
                    "Impossible d'enregistrer la clé d'hôte dans known_hosts: {}",
                    e
                )));
                return Ok(false);
            }
            return Ok(true);
        }

        let mut guard = self.reject_reason.lock().await;
        *guard = Some(HostKeyRejectReason::Unknown { algo, fingerprint });
        Ok(false)
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
        let mut plain_copy = plain.to_vec();
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: plain_copy.len() as u32,
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
        let mut cipher_copy = cipher.to_vec();
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: cipher_copy.len() as u32,
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
        let plain_slice = unsafe {
            std::slice::from_raw_parts_mut(out_blob.pbData, out_blob.cbData as usize)
        };
        let plain = plain_slice.to_vec();
        super::zeroize_bytes(plain_slice);
        unsafe {
            LocalFree(out_blob.pbData as *mut c_void);
        }
        Ok(plain)
    }
}

#[cfg(windows)]
fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn vault_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Impossible de localiser app_local_data_dir: {}", e))?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Impossible de créer le dossier de données: {}", e))?;
    Ok(data_dir)
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
    if key_path.exists() {
        let mut data = std::fs::read(&key_path)
            .map_err(|e| format!("Erreur lecture clé coffre: {}", e))?;
        if data.len() != 32 {
            data.zeroize();
            return Err("Clé coffre invalide (taille incorrecte)".to_string());
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&data);
        data.zeroize();
        return Ok(Zeroizing::new(arr));
    }
    let mut raw = [0u8; 32];
    let mut f = std::fs::File::open("/dev/urandom")
        .map_err(|e| format!("Impossible d'ouvrir /dev/urandom: {}", e))?;
    f.read_exact(&mut raw).map_err(|e| e.to_string())?;
    write_file_secure(&key_path, &raw)
        .map_err(|e| format!("Erreur écriture clé coffre: {}", e))?;
    Ok(Zeroizing::new(raw))
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
        let read_path = if vault_path.exists() {
            vault_path
        } else if bak_path.exists() {
            let _ = std::fs::rename(&bak_path, &vault_path);
            if vault_path.exists() { vault_path } else { bak_path }
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
            let cipher = std::fs::read(&key_path)
                .map_err(|e| format!("Erreur lecture clé DPAPI: {}", e))?;
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

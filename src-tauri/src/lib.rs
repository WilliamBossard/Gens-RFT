use async_trait::async_trait;
use russh::{ChannelMsg, client};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use suppaftp::native_tls::TlsConnector;
use suppaftp::{NativeTlsConnector, NativeTlsFtpStream};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex, mpsc};
use walkdir::WalkDir;

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

#[derive(Clone)]
pub struct ClientHandler {
    pub host: String,
    pub port: u16,
}

#[async_trait]
impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        match russh_keys::check_known_hosts(&self.host, self.port, server_public_key) {
            Ok(true) => Ok(true),
            Ok(false) => {
                // Nouvelle clé pour cet hôte : on l'apprend automatiquement dans ~/.ssh/known_hosts
                let _ = russh_keys::learn_known_hosts(&self.host, self.port, server_public_key);
                Ok(true)
            }
            Err(russh_keys::Error::KeyChanged { .. }) => {
                // Clé modifiée suspecte (possible attaque Man-in-the-Middle) !
                eprintln!("ATTENTION: La clé d'hôte du serveur a changé pour {}:{}", self.host, self.port);
                Ok(false)
            }
            Err(_) => {
                let _ = russh_keys::learn_known_hosts(&self.host, self.port, server_public_key);
                Ok(true)
            }
        }
    }
}

pub struct ServerSession {
    pub ssh_session: Option<Arc<tokio::sync::Mutex<client::Handle<ClientHandler>>>>,
    pub pty_sender: Option<mpsc::Sender<PtyCommand>>,
    pub sftp: Option<Arc<SftpSession>>,
    pub ftp: Option<Arc<tokio::sync::Mutex<NativeTlsFtpStream>>>,
    pub protocol: String,
    pub current_remote_path: String,
}

pub struct AppState {
    pub sessions: Arc<Mutex<HashMap<String, ServerSession>>>,
    pub cancel_tokens: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl AppState {
    pub async fn get_or_create_cancel_token(&self, id: &str) -> Arc<AtomicBool> {
        let mut tokens = self.cancel_tokens.lock().await;
        tokens
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    pub async fn cancel_transfer(&self, id: &str) {
        let tokens = self.cancel_tokens.lock().await;
        if let Some(token) = tokens.get(id) {
            token.store(true, Ordering::Relaxed);
        }
    }

    pub async fn cancel_all(&self) {
        let tokens = self.cancel_tokens.lock().await;
        for token in tokens.values() {
            token.store(true, Ordering::Relaxed);
        }
    }

    pub async fn cleanup_cancel_token(&self, id: &str) {
        let mut tokens = self.cancel_tokens.lock().await;
        tokens.remove(id);
    }
}

#[cfg(windows)]
unsafe extern "system" {
    fn GetLogicalDrives() -> u32;
}

#[tauri::command]
fn get_windows_drives() -> Vec<String> {
    let mut drives = Vec::new();
    #[cfg(windows)]
    {
        let mask = unsafe { GetLogicalDrives() };
        for i in 0..26 {
            if (mask & (1 << i)) != 0 {
                let letter = (b'A' + i) as char;
                drives.push(format!("{}:\\", letter));
            }
        }
    }
    if drives.is_empty() {
        drives.push("C:\\".to_string());
    }
    drives
}

#[tauri::command]
fn get_system_folders() -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Some(userprofile) = std::env::var_os("USERPROFILE") {
        let base = PathBuf::from(userprofile);
        let desktop = base.join("Desktop");
        let downloads = base.join("Downloads");
        let documents = base.join("Documents");

        if desktop.exists() {
            map.insert("desktop".into(), desktop.to_string_lossy().to_string());
        }
        if downloads.exists() {
            map.insert("downloads".into(), downloads.to_string_lossy().to_string());
        }
        if documents.exists() {
            map.insert("documents".into(), documents.to_string_lossy().to_string());
        }
        map.insert("home".into(), base.to_string_lossy().to_string());
    }
    map
}

#[tauri::command]
fn read_local_dir(path: Option<String>) -> Result<Vec<FileEntry>, String> {
    let target_path = match path {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => dirs_next()
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))),
    };

    let read_dir = fs::read_dir(&target_path).map_err(|e| e.to_string())?;
    let mut entries = Vec::new();

    for entry in read_dir.flatten() {
        let metadata = entry.metadata().ok();
        let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
        let name = entry.file_name().to_string_lossy().to_string();
        let full_path = entry.path().to_string_lossy().to_string();

        entries.push(FileEntry {
            name,
            path: full_path,
            is_dir,
            size,
            permissions: None,
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

#[tauri::command]
fn read_local_subdirs(path: String) -> Result<Vec<String>, String> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Ok(Vec::new());
    }
    let mut dirs = Vec::new();
    if let Ok(entries) = fs::read_dir(p) {
        for entry in entries.flatten() {
            if let Ok(m) = entry.metadata() {
                if m.is_dir() {
                    dirs.push(entry.file_name().to_string_lossy().to_string());
                }
            }
        }
    }
    dirs.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(dirs)
}

#[tauri::command]
async fn connect_server(
    session_id: String,
    protocol: String,
    host: String,
    port: u16,
    username: String,
    auth_type: String,
    password: Option<String>,
    key_path: Option<String>,
    passphrase: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if protocol == "FTP" || protocol == "FTPS" {
        let addr = format!("{}:{}", host, port);
        let pass = password.unwrap_or_default();

        let mut ftp = if protocol == "FTPS" {
            let connector = TlsConnector::builder()
                .danger_accept_invalid_certs(true)
                .build()
                .map_err(|e| format!("Erreur configuration TLS: {}", e))?;
            let tls_connector = NativeTlsConnector::from(connector);

            let stream = NativeTlsFtpStream::connect(&addr)
                .map_err(|e| format!("Erreur TCP FTPS: {}", e))?;
            stream
                .into_secure(tls_connector, &host)
                .map_err(|e| format!("Échec négociation TLS (FTPS): {}", e))?
        } else {
            NativeTlsFtpStream::connect(&addr).map_err(|e| format!("Erreur TCP FTP: {}", e))?
        };

        ftp.login(&username, &pass)
            .map_err(|e| format!("Auth {} rejetée: {}", protocol, e))?;

        let mut sessions = state.sessions.lock().await;
        sessions.insert(
            session_id,
            ServerSession {
                ssh_session: None,
                pty_sender: None,
                sftp: None,
                ftp: Some(Arc::new(tokio::sync::Mutex::new(ftp))),
                protocol: protocol.clone(),
                current_remote_path: "/".into(),
            },
        );

        return Ok(format!("Connecté en {} à {}@{}:{}", protocol, username, host, port));
    }

    let mut config = client::Config::default();
    config.window_size = 4 * 1024 * 1024;
    config.maximum_packet_size = 64 * 1024;
    let config = Arc::new(config);
    let handler = ClientHandler {
        host: host.clone(),
        port,
    };
    let mut session = client::connect(config, (host.as_str(), port), handler)
        .await
        .map_err(|e| format!("Erreur réseau SSH: {}", e))?;

    let authenticated = if auth_type == "key" {
        let path = key_path.ok_or_else(|| "Chemin de clé SSH manquant".to_string())?;
        let key_data = russh_keys::load_secret_key(path, passphrase.as_deref())
            .map_err(|e| format!("Clé SSH invalide ou passphrase erronée: {}", e))?;
        session
            .authenticate_publickey(username.clone(), Arc::new(key_data))
            .await
            .map_err(|e| format!("Auth clé rejetée: {}", e))?
    } else {
        let pass = password.unwrap_or_default();
        session
            .authenticate_password(username.clone(), pass)
            .await
            .map_err(|e| format!("Auth mot de passe rejetée: {}", e))?
    };

    if !authenticated {
        return Err("Authentification refusée par le serveur".into());
    }

    let sftp_channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("Canal SSH échoué: {}", e))?;

    sftp_channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("Sous-système SFTP échoué: {}", e))?;

    let sftp = SftpSession::new(sftp_channel.into_stream())
        .await
        .map_err(|e| format!("Handshake SFTP échoué: {}", e))?;

    let mut sessions = state.sessions.lock().await;
    sessions.insert(
        session_id,
        ServerSession {
            ssh_session: Some(Arc::new(tokio::sync::Mutex::new(session))),
            pty_sender: None,
            sftp: Some(Arc::new(sftp)),
            ftp: None,
            protocol,
            current_remote_path: "/".into(),
        },
    );

    Ok(format!("Connecté en SFTP à {}@{}:{}", username, host, port))
}

#[tauri::command]
async fn disconnect_server(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    if let Some(mut sess) = sessions.remove(&session_id) {
        if let Some(ftp_arc) = sess.ftp.take() {
            let mut ftp = ftp_arc.lock().await;
            let _ = ftp.quit();
        }
        if let Some(ssh_arc) = sess.ssh_session.take() {
            let ssh = ssh_arc.lock().await;
            let _ = ssh
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
        }
    }

    let temp_preview = std::env::temp_dir().join("Gens-RFT").join("preview").join(&session_id);
    let _ = tokio::fs::remove_dir_all(temp_preview).await;

    Ok(())
}

#[tauri::command]
async fn cancel_current_transfer(
    transfer_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if let Some(id) = transfer_id {
        state.cancel_transfer(&id).await;
    } else {
        state.cancel_all().await;
    }
    Ok(())
}

#[tauri::command]
async fn start_ssh_pty(
    session_id: String,
    app: AppHandle,
    cols: u32,
    rows: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let ssh_arc = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(&session_id)
            .ok_or_else(|| "Session SSH inactive".to_string())?;

        sess.ssh_session
            .clone()
            .ok_or_else(|| "Session SSH inactive".to_string())?
    };

    let session = ssh_arc.lock().await;
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("Impossible d'ouvrir un canal PTY: {}", e))?;

    channel
        .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
        .await
        .map_err(|e| format!("Échec allocation PTY: {}", e))?;

    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("Échec lancement shell: {}", e))?;
    drop(session);

    let (tx, mut rx) = mpsc::channel::<PtyCommand>(128);
    {
        let mut sessions = state.sessions.lock().await;
        if let Some(sess) = sessions.get_mut(&session_id) {
            sess.pty_sender = Some(tx);
        }
    }

    let event_name = format!("ssh_pty_output_{}", session_id);
    tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { ref data }) => {
                            let text = String::from_utf8_lossy(data).to_string();
                            let _ = app.emit(&event_name, text);
                        }
                        Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                            let text = String::from_utf8_lossy(data).to_string();
                            let _ = app.emit(&event_name, text);
                        }
                        Some(ChannelMsg::Eof) | None => break,
                        _ => {}
                    }
                }
                cmd = rx.recv() => {
                    match cmd {
                        Some(PtyCommand::Input(bytes)) => {
                            if channel.data(&bytes[..]).await.is_err() {
                                break;
                            }
                        }
                        Some(PtyCommand::Resize { cols, rows }) => {
                            let _ = channel.window_change(cols, rows, 0, 0).await;
                        }
                        None => break,
                    }
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
async fn write_ssh_pty(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    if let Some(sess) = sessions.get(&session_id) {
        if let Some(tx) = sess.pty_sender.as_ref() {
            tx.send(PtyCommand::Input(data.into_bytes()))
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn resize_ssh_pty(
    session_id: String,
    cols: u32,
    rows: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    if let Some(sess) = sessions.get(&session_id) {
        if let Some(tx) = sess.pty_sender.as_ref() {
            tx.send(PtyCommand::Resize { cols, rows })
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn parse_ftp_entry(line: &str, target_path: &str) -> Option<FileEntry> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.to_lowercase().starts_with("total ") {
        return None;
    }

    let parts: Vec<&str> = trimmed.split_whitespace().collect();

    // 1. Format Unix prioritaire (ProFTPD, vsftpd, Pure-FTPd): "drwxr-xr-x 2 user group 4096 Nov 09 10:00 dirname"
    if parts.len() >= 9
        && (trimmed.starts_with('d') || trimmed.starts_with('-') || trimmed.starts_with('l'))
    {
        let mut is_dir = trimmed.starts_with('d');
        let size = parts[4].parse::<u64>().unwrap_or(0);

        // Préserver exactement les espaces multiples du nom de fichier après le 8ème champ
        let mut space_count = 0;
        let mut in_whitespace = false;
        let mut name_start_idx = 0;
        for (i, ch) in trimmed.char_indices() {
            if ch.is_whitespace() {
                if !in_whitespace {
                    space_count += 1;
                    in_whitespace = true;
                }
            } else if in_whitespace {
                in_whitespace = false;
                if space_count == 8 {
                    name_start_idx = i;
                    break;
                }
            }
        }

        let raw_name = if name_start_idx > 0 && name_start_idx < trimmed.len() {
            trimmed[name_start_idx..].to_string()
        } else {
            parts[8..].join(" ")
        };

        let name = if let Some((link_name, target)) = raw_name.split_once(" -> ") {
            let t = target.trim();
            if t.ends_with('/') || is_dir {
                is_dir = true;
            }
            link_name.trim().to_string()
        } else {
            raw_name
        };
        if name == "." || name == ".." || name.is_empty() {
            return None;
        }

        let permissions = if parts[0].len() >= 10 {
            let mut mode = 0u32;
            let bytes = parts[0].as_bytes();
            if bytes[1] == b'r' { mode |= 0o400; }
            if bytes[2] == b'w' { mode |= 0o200; }
            if bytes[3] == b'x' || bytes[3] == b's' { mode |= 0o100; }
            if bytes[4] == b'r' { mode |= 0o040; }
            if bytes[5] == b'w' { mode |= 0o020; }
            if bytes[6] == b'x' || bytes[6] == b's' { mode |= 0o010; }
            if bytes[7] == b'r' { mode |= 0o004; }
            if bytes[8] == b'w' { mode |= 0o002; }
            if bytes[9] == b'x' || bytes[9] == b't' { mode |= 0o001; }
            Some(mode)
        } else {
            None
        };

        let full_path = format!("{}/{}", target_path.trim_end_matches('/'), name);
        return Some(FileEntry {
            name,
            path: full_path,
            is_dir,
            size,
            permissions,
        });
    }

    // 2. Format DOS (Windows IIS FTP): "01-02-23 04:50PM <DIR> dirname" ou "01-02-23 04:50PM 1024 filename.txt"
    if parts.len() >= 4 && (parts[2] == "<DIR>" || parts[2].parse::<u64>().is_ok()) {
        let is_dos_date = parts[0].contains('-') || parts[0].contains('/');
        let is_dos_time = parts[1].contains(':');
        if is_dos_date && is_dos_time {
            let is_dir = parts[2] == "<DIR>";
            let size = if is_dir {
                0
            } else {
                parts[2].parse::<u64>().unwrap_or(0)
            };
            let name = parts[3..].join(" ");
            if name == "." || name == ".." || name.is_empty() {
                return None;
            }
            let full_path = format!("{}/{}", target_path.trim_end_matches('/'), name);
            return Some(FileEntry {
                name,
                path: full_path,
                is_dir,
                size,
                permissions: None,
            });
        }
    }

    // 3. Fallback simple si c'est juste un chemin ou un nom (provenant de nlst)
    let raw_name = trimmed.split('/').last().unwrap_or(trimmed).to_string();
    let name = raw_name.trim_end_matches('/').to_string();
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    let is_dir = trimmed.ends_with('/');
    let full_path = format!("{}/{}", target_path.trim_end_matches('/'), name);
    Some(FileEntry {
        name,
        path: full_path,
        is_dir,
        size: 0,
        permissions: None,
    })
}

#[tauri::command]
async fn list_remote_dir(
    session_id: String,
    path: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<FileEntry>, String> {
    let target_path = path.unwrap_or_else(|| "/".into());

    let (protocol, sftp, ftp) = {
        let mut sessions = state.sessions.lock().await;
        let sess = sessions
            .get_mut(&session_id)
            .ok_or_else(|| "Session introuvable ou déconnectée".to_string())?;
        sess.current_remote_path = target_path.clone();
        (sess.protocol.clone(), sess.sftp.clone(), sess.ftp.clone())
    };

    if protocol == "FTP" || protocol == "FTPS" {
        let ftp_arc = ftp.ok_or_else(|| "Session FTP/FTPS inactive".to_string())?;
        let mut ftp_guard = ftp_arc.lock().await;

        let lines = match ftp_guard.list(Some(&target_path)) {
            Ok(l) if !l.is_empty() => l,
            _ => ftp_guard
                .nlst(Some(&target_path))
                .map_err(|e| e.to_string())?,
        };

        let mut entries = Vec::new();
        for line in lines {
            if let Some(entry) = parse_ftp_entry(&line, &target_path) {
                entries.push(entry);
            }
        }

        entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });

        return Ok(entries);
    }

    let sftp = sftp.ok_or_else(|| "Session SFTP inactive".to_string())?;
    let mut dir = sftp
        .read_dir(&target_path)
        .await
        .map_err(|e| format!("Erreur dossier: {}", e))?;
    let mut entries = Vec::new();

    while let Some(file) = dir.next() {
        let name = file.file_name();
        if name == "." || name == ".." {
            continue;
        }

        let full_path = if target_path.ends_with('/') {
            format!("{}{}", target_path, name)
        } else {
            format!("{}/{}", target_path, name)
        };

        let mut is_dir = file.file_type().is_dir();
        if file.file_type().is_symlink() {
            if let Ok(target_meta) = sftp.metadata(&full_path).await {
                if target_meta.is_dir() {
                    is_dir = true;
                }
            }
        }

        let size = file.metadata().size.unwrap_or(0);
        let permissions = file.metadata().permissions;

        entries.push(FileEntry {
            name,
            path: full_path,
            is_dir,
            size,
            permissions,
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

#[tauri::command]
async fn list_remote_subdirs(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let (protocol, sftp, ftp) = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(&session_id)
            .ok_or_else(|| "Session inactive".to_string())?;
        (sess.protocol.clone(), sess.sftp.clone(), sess.ftp.clone())
    };

    if protocol == "FTP" || protocol == "FTPS" {
        let ftp_arc = ftp.ok_or_else(|| "Session FTP/FTPS inactive".to_string())?;
        let mut ftp_guard = ftp_arc.lock().await;
        let lines = match ftp_guard.list(Some(&path)) {
            Ok(l) if !l.is_empty() => l,
            _ => ftp_guard.nlst(Some(&path)).unwrap_or_default(),
        };

        let mut dirs = Vec::new();
        for line in lines {
            if let Some(entry) = parse_ftp_entry(&line, &path) {
                if entry.is_dir {
                    dirs.push(entry.name);
                }
            }
        }
        dirs.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
        return Ok(dirs);
    }

    let sftp = sftp.ok_or_else(|| "Session SFTP inactive".to_string())?;
    let mut dir = sftp
        .read_dir(&path)
        .await
        .map_err(|e| format!("Erreur permission: {}", e))?;
    let mut dirs = Vec::new();

    while let Some(file) = dir.next() {
        let name = file.file_name();
        if name == "." || name == ".." {
            continue;
        }

        let full_path = if path.ends_with('/') {
            format!("{}{}", path, name)
        } else {
            format!("{}/{}", path, name)
        };

        let mut is_dir = file.file_type().is_dir();
        if file.file_type().is_symlink() {
            if let Ok(target_meta) = sftp.metadata(&full_path).await {
                if target_meta.is_dir() {
                    is_dir = true;
                }
            }
        }

        if is_dir {
            dirs.push(name);
        }
    }

    dirs.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(dirs)
}

struct ProgressRead<'a, R: Read> {
    inner: R,
    app: &'a AppHandle,
    transfer_id: &'a str,
    filename: &'a str,
    total: u64,
    transferred: u64,
    last_emit: Instant,
    cancel_flag: Arc<AtomicBool>,
}

impl<'a, R: Read> Read for ProgressRead<'a, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.cancel_flag.load(Ordering::Relaxed) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "Transfert annulé par l'utilisateur",
            ));
        }
        let n = self.inner.read(buf)?;
        self.transferred += n as u64;

        if self.last_emit.elapsed().as_millis() >= 100
            || (self.total > 0 && self.transferred >= self.total)
        {
            let percent = if self.total > 0 {
                ((self.transferred as f64 / self.total as f64) * 100.0) as f32
            } else {
                100.0
            };

            let _ = self.app.emit(
                "transfer_progress",
                TransferProgress {
                    transfer_id: self.transfer_id.to_string(),
                    filename: self.filename.to_string(),
                    transferred: self.transferred,
                    total: self.total,
                    percent,
                    direction: "upload".into(),
                },
            );
            self.last_emit = Instant::now();
        }

        Ok(n)
    }
}

struct ProgressWrite<'a, W: Write> {
    inner: W,
    app: &'a AppHandle,
    transfer_id: &'a str,
    filename: &'a str,
    total: u64,
    transferred: u64,
    last_emit: Instant,
    cancel_flag: Arc<AtomicBool>,
}

impl<'a, W: Write> Write for ProgressWrite<'a, W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.cancel_flag.load(Ordering::Relaxed) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "Transfert annulé par l'utilisateur",
            ));
        }
        let n = self.inner.write(buf)?;
        self.transferred += n as u64;

        if self.last_emit.elapsed().as_millis() >= 100
            || (self.total > 0 && self.transferred >= self.total)
        {
            let percent = if self.total > 0 {
                ((self.transferred as f64 / self.total as f64) * 100.0) as f32
            } else {
                0.0
            };

            let _ = self.app.emit(
                "transfer_progress",
                TransferProgress {
                    transfer_id: self.transfer_id.to_string(),
                    filename: self.filename.to_string(),
                    transferred: self.transferred,
                    total: self.total,
                    percent,
                    direction: "download".into(),
                },
            );
            self.last_emit = Instant::now();
        }

        Ok(n)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

async fn upload_single_file_sftp(
    app: &AppHandle,
    sftp: &SftpSession,
    cancel_flag: &AtomicBool,
    transfer_id: &str,
    local_path: &str,
    remote_path: &str,
    folder_progress: Option<(Arc<Mutex<u64>>, u64)>,
) -> Result<(), String> {
    let local_raw = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| format!("Erreur ouverture {}: {}", local_path, e))?;

    let total_size = local_raw.metadata().await.map(|m| m.len()).unwrap_or(0);
    let mut local_file = tokio::io::BufReader::with_capacity(256 * 1024, local_raw);

    // Upload atomique : on passe par un fichier temporaire pour ne jamais écraser
    // ou détruire un fichier distant existant si le transfert est annulé au milieu.
    let temp_remote_path = format!("{}.gens_part_{}", remote_path, transfer_id);
    let mut remote_file = sftp
        .create(&temp_remote_path)
        .await
        .map_err(|e| format!("Erreur création distante: {}", e))?;

    let filename = Path::new(local_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let mut buffer = vec![0u8; 256 * 1024];
    let mut transferred: u64 = 0;
    let mut last_emit = Instant::now();

    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            drop(remote_file);
            let _ = sftp.remove_file(&temp_remote_path).await;
            return Err("Transfert annulé par l'utilisateur".to_string());
        }

        let n = local_file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Erreur lecture locale: {}", e))?;

        if n == 0 {
            break;
        }

        if let Err(e) = remote_file.write_all(&buffer[..n]).await {
            drop(remote_file);
            let _ = sftp.remove_file(&temp_remote_path).await;
            return Err(format!("Erreur écriture distante: {}", e));
        }

        transferred += n as u64;

        let (emit_transferred, emit_total, percent) = if let Some((ref cum_lock, folder_total)) = folder_progress {
            let mut cum = cum_lock.lock().await;
            *cum += n as u64;
            let current_cum = *cum;
            let p = if folder_total > 0 {
                ((current_cum as f64 / folder_total as f64) * 100.0).min(99.9) as f32
            } else {
                0.0
            };
            (current_cum, folder_total, p)
        } else {
            let p = if total_size > 0 {
                ((transferred as f64 / total_size as f64) * 100.0).min(99.9) as f32
            } else {
                0.0
            };
            (transferred, total_size, p)
        };

        if last_emit.elapsed().as_millis() >= 100 || (total_size > 0 && transferred >= total_size) {
            let _ = app.emit(
                "transfer_progress",
                TransferProgress {
                    transfer_id: transfer_id.to_string(),
                    filename: filename.clone(),
                    transferred: emit_transferred,
                    total: emit_total,
                    percent,
                    direction: "upload".into(),
                },
            );
            last_emit = Instant::now();
        }
    }

    drop(remote_file);

    // Finalisation atomique : on remplace la cible finale par le fichier temporaire
    if let Err(_) = sftp.rename(&temp_remote_path, remote_path).await {
        let _ = sftp.remove_file(remote_path).await;
        sftp.rename(&temp_remote_path, remote_path)
            .await
            .map_err(|e| format!("Erreur finalisation fichier distant: {}", e))?;
    }

    if folder_progress.is_none() {
        let _ = app.emit(
            "transfer_progress",
            TransferProgress {
                transfer_id: transfer_id.to_string(),
                filename: filename.clone(),
                transferred: total_size,
                total: total_size,
                percent: 100.0,
                direction: "upload".into(),
            },
        );
    }

    Ok(())
}

async fn upload_item_inner(
    session_id: &str,
    app: &AppHandle,
    transfer_id: &str,
    local_path: &str,
    remote_dest_dir: &str,
    dest_filename: Option<String>,
    state: &AppState,
) -> Result<String, String> {
    let cancel_flag = state.get_or_create_cancel_token(transfer_id).await;
    if cancel_flag.load(Ordering::Relaxed) {
        return Err("Transfert annulé par l'utilisateur".to_string());
    }

    let (protocol, sftp, ftp) = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(session_id)
            .ok_or_else(|| "Session inactive".to_string())?;
        (sess.protocol.clone(), sess.sftp.clone(), sess.ftp.clone())
    };

    let source = Path::new(local_path);
    let original_name = source
        .file_name()
        .ok_or_else(|| "Nom invalide".to_string())?
        .to_string_lossy();

    let target_name = dest_filename
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| original_name.to_string());

    if protocol == "FTP" || protocol == "FTPS" {
        let ftp_arc = ftp.ok_or_else(|| "Session FTP/FTPS inactive".to_string())?;

        if source.is_dir() {
            let root_remote = format!("{}/{}", remote_dest_dir.trim_end_matches('/'), target_name);
            {
                let mut ftp_guard = ftp_arc.lock().await;
                let _ = ftp_guard.mkdir(&root_remote);
            }

            for entry in WalkDir::new(local_path).into_iter().filter_map(|e| e.ok()) {
                if cancel_flag.load(Ordering::Relaxed) {
                    return Err("Transfert annulé".to_string());
                }

                let rel = entry
                    .path()
                    .strip_prefix(local_path)
                    .map_err(|e| e.to_string())?;
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                if rel_str.is_empty() {
                    continue;
                }

                let remote_target = format!("{}/{}", root_remote, rel_str);
                if entry.file_type().is_dir() {
                    let mut ftp_guard = ftp_arc.lock().await;
                    let _ = ftp_guard.mkdir(&remote_target);
                } else {
                    let file = fs::File::open(entry.path()).map_err(|e| e.to_string())?;
                    let total_size = file.metadata().map(|m| m.len()).unwrap_or(0);
                    let filename = entry.file_name().to_string_lossy().to_string();

                    let mut progress_reader = ProgressRead {
                        inner: file,
                        app,
                        transfer_id,
                        filename: &filename,
                        total: total_size,
                        transferred: 0,
                        last_emit: Instant::now(),
                        cancel_flag: cancel_flag.clone(),
                    };

                    let mut ftp_guard = ftp_arc.lock().await;
                    ftp_guard
                        .put_file(&remote_target, &mut progress_reader)
                        .map_err(|e| format!("Erreur upload FTP {}: {}", filename, e))?;
                }
            }
        } else {
            let remote_target =
                format!("{}/{}", remote_dest_dir.trim_end_matches('/'), target_name);
            let file = fs::File::open(local_path).map_err(|e| e.to_string())?;
            let total_size = file.metadata().map(|m| m.len()).unwrap_or(0);

            let mut progress_reader = ProgressRead {
                inner: file,
                app,
                transfer_id,
                filename: &target_name,
                total: total_size,
                transferred: 0,
                last_emit: Instant::now(),
                cancel_flag: cancel_flag.clone(),
            };

            let mut ftp_guard = ftp_arc.lock().await;
            if let Err(e) = ftp_guard.put_file(&remote_target, &mut progress_reader) {
                let _ = ftp_guard.rm(&remote_target);
                return Err(format!("Erreur upload FTP: {}", e));
            }
        }

        return Ok("Upload FTP terminé".into());
    }

    let sftp = sftp.ok_or_else(|| "Session SFTP inactive".to_string())?;

    if source.is_dir() {
        let root_remote = format!("{}/{}", remote_dest_dir.trim_end_matches('/'), target_name);
        let _ = sftp.create_dir(&root_remote).await;

        let mut files_to_upload: Vec<(PathBuf, String, u64)> = Vec::new();
        let mut total_folder_bytes: u64 = 0;

        for entry in WalkDir::new(local_path).into_iter().filter_map(|e| e.ok()) {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err("Transfert annulé par l'utilisateur".to_string());
            }
            let rel = match entry.path().strip_prefix(local_path) {
                Ok(r) => r,
                Err(_) => continue,
            };
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            if rel_str.is_empty() {
                continue;
            }

            let remote_target = format!("{}/{}", root_remote, rel_str);
            if entry.file_type().is_dir() {
                let _ = sftp.create_dir(&remote_target).await;
            } else {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                total_folder_bytes += size;
                files_to_upload.push((entry.path().to_path_buf(), remote_target, size));
            }
        }

        let cumulative = Arc::new(Mutex::new(0u64));
        let mut upload_errors = Vec::new();
        for (local_file_path, remote_target, _) in files_to_upload {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err("Transfert annulé par l'utilisateur".to_string());
            }

            if let Err(e) = upload_single_file_sftp(
                app,
                &sftp,
                &cancel_flag,
                transfer_id,
                &local_file_path.to_string_lossy(),
                &remote_target,
                Some((cumulative.clone(), total_folder_bytes)),
            )
            .await
            {
                if cancel_flag.load(Ordering::Relaxed) {
                    return Err("Transfert annulé par l'utilisateur".to_string());
                }
                upload_errors.push(format!("{}: {}", remote_target, e));
            }
        }

        if !upload_errors.is_empty() {
            return Err(format!(
                "{} fichier(s) n'ont pas pu être uploadés : {}",
                upload_errors.len(),
                upload_errors.join("; ")
            ));
        }
    } else {
        let remote_target = format!("{}/{}", remote_dest_dir.trim_end_matches('/'), target_name);
        upload_single_file_sftp(
            app,
            &sftp,
            &cancel_flag,
            transfer_id,
            local_path,
            &remote_target,
            None,
        )
        .await?;
    }

    Ok("Upload terminé".into())
}

#[tauri::command]
async fn upload_item(
    session_id: String,
    app: AppHandle,
    transfer_id: String,
    local_path: String,
    remote_dest_dir: String,
    dest_filename: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let res = upload_item_inner(
        &session_id,
        &app,
        &transfer_id,
        &local_path,
        &remote_dest_dir,
        dest_filename,
        &state,
    )
    .await;
    state.cleanup_cancel_token(&transfer_id).await;
    res
}

fn sanitize_windows_filename(name: &str) -> String {
    let clean = name.replace(['<', '>', ':', '"', '/', '\\', '|', '?', '*'], "_");
    let mut trimmed = clean.trim_end_matches(['.', ' ']).to_string();
    if trimmed.is_empty() {
        return "unnamed_file".to_string();
    }
    // Gérer les noms de périphériques réservés MS-DOS (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
    let uppercase = trimmed.to_ascii_uppercase();
    let base_name = uppercase.split('.').next().unwrap_or(&uppercase);
    const DOS_RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if DOS_RESERVED.contains(&base_name) {
        trimmed = format!("_{}", trimmed);
    }
    trimmed
}

async fn download_single_file_sftp(
    app: &AppHandle,
    sftp: &SftpSession,
    cancel_flag: &AtomicBool,
    transfer_id: &str,
    remote_path: &str,
    local_path: &Path,
    folder_progress: Option<(Arc<Mutex<u64>>, u64)>,
) -> Result<(), String> {
    if let Some(parent) = local_path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| {
            format!(
                "Impossible de créer le dossier local ({}): {}",
                parent.display(),
                e
            )
        })?;
    }

    let mut remote_file = sftp
        .open(remote_path)
        .await
        .map_err(|e| format!("Erreur lecture distante ({}): {}", remote_path, e))?;

    let total_size = match sftp.metadata(remote_path).await {
        Ok(m) => m.size.unwrap_or(0),
        Err(_) => remote_file
            .metadata()
            .await
            .map(|m| m.size.unwrap_or(0))
            .unwrap_or(0),
    };

    let temp_local_file = match local_path.file_name() {
        Some(name) => local_path.with_file_name(format!("{}.gens_part_{}", name.to_string_lossy(), transfer_id)),
        None => local_path.to_path_buf(),
    };

    let local_raw = tokio::fs::File::create(&temp_local_file)
        .await
        .map_err(|e| format!("Erreur création locale ({}): {}", local_path.display(), e))?;
    let mut local_file = tokio::io::BufWriter::with_capacity(256 * 1024, local_raw);

    let filename = local_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let mut buffer = vec![0u8; 256 * 1024];
    let mut transferred: u64 = 0;
    let mut last_emit = Instant::now();

    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            drop(local_file);
            let _ = tokio::fs::remove_file(&temp_local_file).await;
            return Err("Transfert annulé par l'utilisateur".to_string());
        }

        let n = match remote_file.read(&mut buffer).await {
            Ok(bytes) => bytes,
            Err(e) => {
                drop(local_file);
                let _ = tokio::fs::remove_file(&temp_local_file).await;
                return Err(format!("Erreur lecture: {}", e));
            }
        };

        if n == 0 {
            break;
        }

        if let Err(e) = local_file.write_all(&buffer[..n]).await {
            drop(local_file);
            let _ = tokio::fs::remove_file(&temp_local_file).await;
            return Err(format!("Erreur écriture ({}): {}", local_path.display(), e));
        }

        transferred += n as u64;

        let (emit_transferred, emit_total, percent) = if let Some((ref cum_lock, folder_total)) = folder_progress {
            let mut cum = cum_lock.lock().await;
            *cum += n as u64;
            let current_cum = *cum;
            let p = if folder_total > 0 {
                ((current_cum as f64 / folder_total as f64) * 100.0).min(99.9) as f32
            } else {
                0.0
            };
            (current_cum, folder_total, p)
        } else {
            let p = if total_size > 0 {
                ((transferred as f64 / total_size as f64) * 100.0).min(99.9) as f32
            } else {
                0.0
            };
            (transferred, total_size, p)
        };

        if last_emit.elapsed().as_millis() >= 100 || (total_size > 0 && transferred >= total_size) {
            let _ = app.emit(
                "transfer_progress",
                TransferProgress {
                    transfer_id: transfer_id.to_string(),
                    filename: filename.clone(),
                    transferred: emit_transferred,
                    total: emit_total,
                    percent,
                    direction: "download".into(),
                },
            );
            last_emit = Instant::now();
        }
    }

    let _ = local_file.flush().await;
    drop(local_file);

    if local_path.exists() {
        let _ = tokio::fs::remove_file(local_path).await;
    }
    tokio::fs::rename(&temp_local_file, local_path)
        .await
        .map_err(|e| format!("Erreur finalisation locale: {}", e))?;

    if folder_progress.is_none() {
        let _ = app.emit(
            "transfer_progress",
            TransferProgress {
                transfer_id: transfer_id.to_string(),
                filename: filename.clone(),
                transferred: total_size,
                total: total_size,
                percent: 100.0,
                direction: "download".into(),
            },
        );
    }

    Ok(())
}

async fn download_item_inner(
    session_id: &str,
    app: &AppHandle,
    transfer_id: &str,
    remote_path: &str,
    local_dest_dir: &str,
    dest_filename: Option<String>,
    is_dir: bool,
    state: &AppState,
) -> Result<String, String> {
    let cancel_flag = state.get_or_create_cancel_token(transfer_id).await;
    if cancel_flag.load(Ordering::Relaxed) {
        return Err("Transfert annulé par l'utilisateur".to_string());
    }

    let (protocol, sftp, ftp) = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(session_id)
            .ok_or_else(|| "Session inactive".to_string())?;
        (sess.protocol.clone(), sess.sftp.clone(), sess.ftp.clone())
    };

    let normalized_dest = local_dest_dir.trim().replace('/', "\\");
    let base_dest = PathBuf::from(&normalized_dest);

    tokio::fs::create_dir_all(&base_dest).await.map_err(|e| {
        format!(
            "Dossier local inaccessible ({}): {}",
            base_dest.display(),
            e
        )
    })?;

    let raw_filename = Path::new(remote_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    let safe_filename = dest_filename
        .filter(|s| !s.trim().is_empty())
        .map(|s| sanitize_windows_filename(&s))
        .unwrap_or_else(|| sanitize_windows_filename(&raw_filename));

    if protocol == "FTP" || protocol == "FTPS" {
        let ftp_arc = ftp.ok_or_else(|| "Session FTP/FTPS inactive".to_string())?;

        if is_dir {
            let root_local_dir = base_dest.join(&safe_filename);
            fs::create_dir_all(&root_local_dir).map_err(|e| e.to_string())?;

            let mut visited = std::collections::HashSet::new();
            visited.insert(remote_path.to_string());
            let mut queue = vec![(remote_path.to_string(), root_local_dir, 0usize)];
            while let Some((rem_dir, loc_dir, depth)) = queue.pop() {
                if cancel_flag.load(Ordering::Relaxed) {
                    return Err("Transfert annulé".to_string());
                }

                if depth > 40 {
                    continue;
                }

                let lines = {
                    let mut ftp_guard = ftp_arc.lock().await;
                    ftp_guard.list(Some(&rem_dir)).unwrap_or_default()
                };

                for line in lines {
                    if let Some(item) = parse_ftp_entry(&line, &rem_dir) {
                        let sub_loc = loc_dir.join(sanitize_windows_filename(&item.name));
                        if item.is_dir {
                            if visited.insert(item.path.clone()) {
                                let _ = fs::create_dir_all(&sub_loc);
                                queue.push((item.path, sub_loc, depth + 1));
                            }
                        } else {
                            let file = fs::File::create(&sub_loc).map_err(|e| e.to_string())?;
                            let mut progress_writer = ProgressWrite {
                                inner: file,
                                app,
                                transfer_id,
                                filename: &item.name,
                                total: item.size,
                                transferred: 0,
                                last_emit: Instant::now(),
                                cancel_flag: cancel_flag.clone(),
                            };

                            let mut ftp_guard = ftp_arc.lock().await;
                            let retr_res = ftp_guard.retr(&item.path, |stream| {
                                let mut buffer = [0u8; 128 * 1024];
                                loop {
                                    let n = stream
                                        .read(&mut buffer)
                                        .map_err(suppaftp::FtpError::ConnectionError)?;
                                    if n == 0 {
                                        break;
                                    }
                                    progress_writer
                                        .write_all(&buffer[..n])
                                        .map_err(suppaftp::FtpError::ConnectionError)?;
                                }
                                Ok(())
                            });
                            if let Err(e) = retr_res {
                                let _ = fs::remove_file(&sub_loc);
                                return Err(format!("Erreur téléchargement FTP {}: {}", item.name, e));
                            }
                        }
                    }
                }
            }
        } else {
            let local_target = base_dest.join(&safe_filename);
            let file = fs::File::create(&local_target).map_err(|e| e.to_string())?;

            let total_size = {
                let mut ftp_guard = ftp_arc.lock().await;
                ftp_guard.size(remote_path).unwrap_or(0) as u64
            };

            let filename = local_target
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            let mut progress_writer = ProgressWrite {
                inner: file,
                app,
                transfer_id,
                filename: &filename,
                total: total_size,
                transferred: 0,
                last_emit: Instant::now(),
                cancel_flag: cancel_flag.clone(),
            };

            let mut ftp_guard = ftp_arc.lock().await;
            let retr_res = ftp_guard
                .retr(remote_path, |stream| {
                    let mut buffer = [0u8; 128 * 1024];
                    loop {
                        let n = stream
                            .read(&mut buffer)
                            .map_err(suppaftp::FtpError::ConnectionError)?;
                        if n == 0 {
                            break;
                        }
                        progress_writer
                            .write_all(&buffer[..n])
                            .map_err(suppaftp::FtpError::ConnectionError)?;
                    }
                    Ok(())
                });
            drop(progress_writer);
            if let Err(e) = retr_res {
                let _ = fs::remove_file(&local_target);
                return Err(format!("Erreur download FTP: {}", e));
            }
        }

        return Ok(safe_filename);
    }

    let sftp = sftp.ok_or_else(|| "Session SFTP inactive".to_string())?;

    if is_dir {
        let root_local_dir = base_dest.join(&safe_filename);
        tokio::fs::create_dir_all(&root_local_dir)
            .await
            .map_err(|e| e.to_string())?;

        let mut files_to_download: Vec<(String, PathBuf, u64)> = Vec::new();
        let mut total_folder_bytes: u64 = 0;

        let mut visited = std::collections::HashSet::new();
        visited.insert(remote_path.to_string());
        let mut queue = vec![(remote_path.to_string(), root_local_dir, 0usize)];
        while let Some((rem_dir, loc_dir, depth)) = queue.pop() {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err("Transfert annulé".to_string());
            }

            if depth > 40 {
                continue;
            }

            if let Ok(mut dir) = sftp.read_dir(&rem_dir).await {
                while let Some(item) = dir.next() {
                    let sub_name = item.file_name();
                    if sub_name == "." || sub_name == ".." {
                        continue;
                    }
                    let safe_sub = sanitize_windows_filename(&sub_name);
                    let sub_rem = format!("{}/{}", rem_dir.trim_end_matches('/'), sub_name);
                    let sub_loc = loc_dir.join(safe_sub);

                    let mut is_sub_dir = item.file_type().is_dir();
                    if item.file_type().is_symlink() {
                        if let Ok(target_meta) = sftp.metadata(&sub_rem).await {
                            if target_meta.is_dir() && !visited.contains(&sub_rem) {
                                is_sub_dir = true;
                            }
                        }
                    }

                    if is_sub_dir {
                        if visited.insert(sub_rem.clone()) {
                            let _ = tokio::fs::create_dir_all(&sub_loc).await;
                            queue.push((sub_rem, sub_loc, depth + 1));
                        }
                    } else {
                        let size = item.metadata().size.unwrap_or(0);
                        total_folder_bytes += size;
                        files_to_download.push((sub_rem, sub_loc, size));
                    }
                }
            }
        }

        let cumulative = Arc::new(Mutex::new(0u64));
        let mut download_errors = Vec::new();
        for (sub_rem, sub_loc, _) in files_to_download {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err("Transfert annulé par l'utilisateur".to_string());
            }

            if let Err(e) = download_single_file_sftp(
                app,
                &sftp,
                &cancel_flag,
                transfer_id,
                &sub_rem,
                &sub_loc,
                Some((cumulative.clone(), total_folder_bytes)),
            )
            .await
            {
                if cancel_flag.load(Ordering::Relaxed) {
                    return Err("Transfert annulé par l'utilisateur".to_string());
                }
                download_errors.push(format!("{}: {}", sub_rem, e));
            }
        }

        if !download_errors.is_empty() {
            return Err(format!(
                "{} fichier(s) n'ont pas pu être téléchargés : {}",
                download_errors.len(),
                download_errors.join("; ")
            ));
        }
    } else {
        let local_target = base_dest.join(&safe_filename);
        download_single_file_sftp(
            app,
            &sftp,
            &cancel_flag,
            transfer_id,
            remote_path,
            &local_target,
            None,
        )
        .await?;
    }

    Ok(safe_filename)
}

#[tauri::command]
async fn download_item(
    session_id: String,
    app: AppHandle,
    transfer_id: String,
    remote_path: String,
    local_dest_dir: String,
    dest_filename: Option<String>,
    is_dir: bool,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let res = download_item_inner(
        &session_id,
        &app,
        &transfer_id,
        &remote_path,
        &local_dest_dir,
        dest_filename,
        is_dir,
        &state,
    )
    .await;
    state.cleanup_cancel_token(&transfer_id).await;
    res
}

#[tauri::command]
async fn read_remote_file_text(
    session_id: String,
    remote_path: String,
    state: State<'_, AppState>,
) -> Result<RemoteTextFile, String> {
    let (protocol, sftp, ftp) = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(&session_id)
            .ok_or_else(|| "Session inactive".to_string())?;
        (sess.protocol.clone(), sess.sftp.clone(), sess.ftp.clone())
    };

    if protocol == "FTP" || protocol == "FTPS" {
        let ftp_arc = ftp.ok_or_else(|| "Session FTP/FTPS inactive".to_string())?;
        let mut ftp_guard = ftp_arc.lock().await;

        if let Ok(size) = ftp_guard.size(&remote_path) {
            if size > 5 * 1024 * 1024 {
                return Err("Fichier trop volumineux (> 5 Mo) pour l'éditeur intégré.".to_string());
            }
        }

        let cursor = ftp_guard
            .retr_as_buffer(&remote_path)
            .map_err(|e| e.to_string())?;
        let buffer = cursor.into_inner();
        if buffer.len() > 5 * 1024 * 1024 {
            return Err("Fichier trop volumineux (> 5 Mo) pour l'éditeur intégré.".to_string());
        }

        if buffer.contains(&0) {
            return Err("Le fichier est un binaire (caractères nuls détectés). Impossible de l'ouvrir dans l'éditeur de texte.".to_string());
        }

        let is_lossy = std::str::from_utf8(&buffer).is_err();
        let content = String::from_utf8_lossy(&buffer).to_string();
        return Ok(RemoteTextFile { content, is_lossy });
    }

    let sftp = sftp.ok_or_else(|| "Session SFTP inactive".to_string())?;

    if let Ok(meta) = sftp.metadata(&remote_path).await {
        if meta.size.unwrap_or(0) > 5 * 1024 * 1024 {
            return Err("Fichier trop volumineux (> 5 Mo) pour l'éditeur intégré.".to_string());
        }
    }

    let mut remote_file = sftp.open(&remote_path).await.map_err(|e| e.to_string())?;
    let mut buffer = Vec::new();
    remote_file
        .read_to_end(&mut buffer)
        .await
        .map_err(|e| e.to_string())?;

    if buffer.contains(&0) {
        return Err("Le fichier est un binaire (caractères nuls détectés). Impossible de l'ouvrir dans l'éditeur de texte.".to_string());
    }

    let is_lossy = std::str::from_utf8(&buffer).is_err();
    let content = String::from_utf8_lossy(&buffer).to_string();
    Ok(RemoteTextFile { content, is_lossy })
}

#[tauri::command]
async fn save_remote_file_text(
    session_id: String,
    remote_path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (protocol, sftp, ftp) = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(&session_id)
            .ok_or_else(|| "Session inactive".to_string())?;
        (sess.protocol.clone(), sess.sftp.clone(), sess.ftp.clone())
    };

    if protocol == "FTP" || protocol == "FTPS" {
        let ftp_arc = ftp.ok_or_else(|| "Session FTP/FTPS inactive".to_string())?;
        let mut ftp_guard = ftp_arc.lock().await;
        let mut cursor = Cursor::new(content.into_bytes());
        ftp_guard
            .put_file(&remote_path, &mut cursor)
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    let sftp = sftp.ok_or_else(|| "Session SFTP inactive".to_string())?;
    let mut remote_file = sftp.create(&remote_path).await.map_err(|e| e.to_string())?;
    remote_file
        .write_all(content.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn open_remote_with_system(
    session_id: String,
    remote_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (protocol, sftp, ftp) = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(&session_id)
            .ok_or_else(|| "Session inactive".to_string())?;
        (sess.protocol.clone(), sess.sftp.clone(), sess.ftp.clone())
    };

    let raw_filename = Path::new(&remote_path)
        .file_name()
        .ok_or_else(|| "Nom de fichier invalide".to_string())?
        .to_string_lossy();
    let safe_filename = sanitize_windows_filename(&raw_filename);

    let temp_dir = std::env::temp_dir().join("Gens-RFT").join("preview").join(&session_id);
    let _ = fs::create_dir_all(&temp_dir);
    let mut local_temp_file = temp_dir.join(&safe_filename);
    // Si le fichier existe et est verrouillé par un processus tiers (ex: lecteur PDF/Word), on utilise un nom horodaté
    if local_temp_file.exists() && fs::OpenOptions::new().write(true).open(&local_temp_file).is_err() {
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
        local_temp_file = temp_dir.join(format!("{}_{}", ts, safe_filename));
    }

    if protocol == "FTP" || protocol == "FTPS" {
        let ftp_arc = ftp.ok_or_else(|| "Session FTP/FTPS inactive".to_string())?;
        let mut ftp_guard = ftp_arc.lock().await;
        let mut file = fs::File::create(&local_temp_file).map_err(|e| e.to_string())?;
        ftp_guard
            .retr(&remote_path, |stream| {
                std::io::copy(stream, &mut file)
                    .map(|_| ())
                    .map_err(suppaftp::FtpError::ConnectionError)
            })
            .map_err(|e| e.to_string())?;
    } else {
        let sftp = sftp.ok_or_else(|| "Session SFTP inactive".to_string())?;
        let mut remote_file = sftp.open(&remote_path).await.map_err(|e| e.to_string())?;
        let mut local_file = tokio::fs::File::create(&local_temp_file)
            .await
            .map_err(|e| e.to_string())?;

        let mut buffer = vec![0u8; 128 * 1024];
        loop {
            let n = remote_file
                .read(&mut buffer)
                .await
                .map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            local_file
                .write_all(&buffer[..n])
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    let path_str = local_temp_file.to_string_lossy().to_string();
    tauri_plugin_opener::open_path(path_str.clone(), None::<&str>)
        .map_err(|e| format!("Erreur ouverture Windows: {}", e))?;

    Ok(path_str)
}

#[tauri::command]
async fn exec_remote_command(
    session_id: String,
    command: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let ssh_arc = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(&session_id)
            .ok_or_else(|| "Session inactive".to_string())?;

        sess.ssh_session.clone().ok_or_else(|| {
            "Session SSH inactive (FTP ne supporte pas l'exécution shell)".to_string()
        })?
    };

    let mut channel = {
        let session = ssh_arc.lock().await;
        session
            .channel_open_session()
            .await
            .map_err(|e| format!("Impossible d'ouvrir un canal SSH : {}", e))?
    };

    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|e| format!("Erreur exécution commande : {}", e))?;

    let mut output = Vec::new();
    let mut exit_status: Option<u32> = None;
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { ref data } => {
                output.extend_from_slice(data);
            }
            ChannelMsg::ExtendedData { ref data, .. } => {
                output.extend_from_slice(data);
            }
            ChannelMsg::ExitStatus { exit_status: status } => {
                exit_status = Some(status);
            }
            ChannelMsg::Eof => break,
            _ => {}
        }
    }

    let out_str = String::from_utf8_lossy(&output).trim().to_string();
    if let Some(status) = exit_status {
        if status != 0 {
            let msg = if out_str.is_empty() {
                format!("Commande échouée avec le code de sortie {}", status)
            } else {
                format!("Échec (code {}): {}", status, out_str)
            };
            return Err(msg);
        }
    }

    Ok(out_str)
}

#[tauri::command]
async fn chmod_remote(
    session_id: String,
    path: String,
    permissions: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (protocol, sftp, ftp) = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(&session_id)
            .ok_or_else(|| "Session inactive".to_string())?;
        (sess.protocol.clone(), sess.sftp.clone(), sess.ftp.clone())
    };

    if protocol == "FTP" || protocol == "FTPS" {
        let ftp_arc = ftp.ok_or_else(|| "Session FTP/FTPS inactive".to_string())?;
        let mut ftp_guard = ftp_arc.lock().await;
        ftp_guard
            .site(&format!("CHMOD {:o} {}", permissions, path))
            .map_err(|e| format!("Erreur CHMOD FTP: {}", e))?;
        return Ok(());
    }

    let sftp = sftp.ok_or_else(|| "Session SFTP inactive".to_string())?;
    let mut metadata = sftp.metadata(&path).await.map_err(|e| e.to_string())?;
    let old_mode = metadata.permissions.unwrap_or(0);
    // Préserve les bits de type de fichier Unix (S_IFREG, S_IFDIR, etc.)
    let new_mode = (old_mode & !0o7777) | (permissions & 0o7777);
    metadata.permissions = Some(new_mode);
    sftp.set_metadata(&path, metadata)
        .await
        .map_err(|e| format!("Erreur CHMOD SFTP: {}", e))
}

#[tauri::command]
fn rename_local(old_path: String, new_path: String) -> Result<(), String> {
    fs::rename(old_path, new_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn rename_remote(
    session_id: String,
    old_path: String,
    new_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (protocol, sftp, ftp) = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(&session_id)
            .ok_or_else(|| "Session inactive".to_string())?;
        (sess.protocol.clone(), sess.sftp.clone(), sess.ftp.clone())
    };

    if protocol == "FTP" || protocol == "FTPS" {
        let ftp_arc = ftp.ok_or_else(|| "Session FTP/FTPS inactive".to_string())?;
        let mut ftp_guard = ftp_arc.lock().await;
        ftp_guard
            .rename(&old_path, &new_path)
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    let sftp = sftp.ok_or_else(|| "Session SFTP inactive".to_string())?;
    sftp.rename(old_path, new_path)
        .await
        .map_err(|e| e.to_string())
}

fn make_writable(path: &Path) {
    if let Ok(metadata) = fs::metadata(path) {
        let mut perms = metadata.permissions();
        if perms.readonly() {
            perms.set_readonly(false);
            let _ = fs::set_permissions(path, perms);
        }
    }
}

#[tauri::command]
fn delete_local(path: String, is_dir: bool) -> Result<(), String> {
    let p = Path::new(&path);
    if is_dir {
        for entry in WalkDir::new(p).into_iter().filter_map(|e| e.ok()) {
            make_writable(entry.path());
        }
        make_writable(p);
        fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        make_writable(p);
        fs::remove_file(p).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn create_local_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_local_file(path: String) -> Result<(), String> {
    if Path::new(&path).exists() {
        return Err("Un élément portant ce nom existe déjà.".to_string());
    }
    fs::File::create(&path).map_err(|e| format!("Impossible de créer le fichier: {}", e))?;
    Ok(())
}

async fn remove_dir_recursive_sftp(sftp: &SftpSession, root_path: &str) -> Result<(), String> {
    fn delete_sftp_dir<'a>(
        sftp: &'a SftpSession,
        path: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            if let Ok(mut dir) = sftp.read_dir(path).await {
                while let Some(item) = dir.next() {
                    let name = item.file_name();
                    if name == "." || name == ".." {
                        continue;
                    }
                    let child_path = if path.ends_with('/') {
                        format!("{}{}", path, name)
                    } else {
                        format!("{}/{}", path, name)
                    };
                    // Si c'est un lien symbolique, on ne descend SURTOUT PAS dedans pour ne pas
                    // détruire récursivement la cible du lien ! On détache juste le lien.
                    if item.file_type().is_symlink() {
                        let _ = sftp.remove_file(&child_path).await;
                    } else if item.file_type().is_dir() {
                        delete_sftp_dir(sftp, &child_path).await?;
                    } else {
                        let _ = sftp.remove_file(&child_path).await;
                    }
                }
            }
            sftp.remove_dir(path).await.map_err(|e| e.to_string())
        })
    }
    delete_sftp_dir(sftp, root_path).await
}

fn remove_dir_recursive_ftp(ftp: &mut NativeTlsFtpStream, path: &str) -> Result<(), String> {
    let lines = match ftp.list(Some(path)) {
        Ok(l) if !l.is_empty() => l,
        _ => ftp.nlst(Some(path)).unwrap_or_default(),
    };
    for line in lines {
        if let Some(entry) = parse_ftp_entry(&line, path) {
            if entry.name == "." || entry.name == ".." {
                continue;
            }
            if entry.is_dir {
                let _ = remove_dir_recursive_ftp(ftp, &entry.path);
            } else {
                if ftp.rm(&entry.path).is_err() {
                    let _ = remove_dir_recursive_ftp(ftp, &entry.path);
                }
            }
        }
    }
    ftp.rmdir(path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_remote(
    session_id: String,
    path: String,
    is_dir: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (protocol, sftp, ftp) = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(&session_id)
            .ok_or_else(|| "Session inactive".to_string())?;
        (sess.protocol.clone(), sess.sftp.clone(), sess.ftp.clone())
    };

    if protocol == "FTP" || protocol == "FTPS" {
        let ftp_arc = ftp.ok_or_else(|| "Session FTP/FTPS inactive".to_string())?;
        let mut ftp_guard = ftp_arc.lock().await;
        if is_dir {
            remove_dir_recursive_ftp(&mut ftp_guard, &path)?;
        } else {
            ftp_guard.rm(&path).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    let sftp = sftp.ok_or_else(|| "Session SFTP inactive".to_string())?;
    if is_dir {
        remove_dir_recursive_sftp(&sftp, &path).await
    } else {
        sftp.remove_file(&path).await.map_err(|e| e.to_string())
    }
}

#[tauri::command]
async fn create_remote_dir(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (protocol, sftp, ftp) = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(&session_id)
            .ok_or_else(|| "Session inactive".to_string())?;
        (sess.protocol.clone(), sess.sftp.clone(), sess.ftp.clone())
    };

    if protocol == "FTP" || protocol == "FTPS" {
        let ftp_arc = ftp.ok_or_else(|| "Session FTP/FTPS inactive".to_string())?;
        let mut ftp_guard = ftp_arc.lock().await;
        ftp_guard.mkdir(&path).map_err(|e| e.to_string())?;
        return Ok(());
    }

    let sftp = sftp.ok_or_else(|| "Session SFTP inactive".to_string())?;
    sftp.create_dir(&path).await.map_err(|e| e.to_string())
}

fn is_valid_remote_filename(s: &str) -> bool {
    !s.is_empty() && !s.contains(['\0', '\n', '\r'])
}

fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[tauri::command]
async fn compress_remote(
    session_id: String,
    parent_dir: String,
    item_name: String,
    format: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if !is_valid_remote_filename(&parent_dir) || !is_valid_remote_filename(&item_name) {
        return Err("Caractères invalides ou chemin vide détecté".into());
    }

    let parent_esc = shell_escape(&parent_dir);
    let item_esc = shell_escape(&item_name);

    let (archive_name, cmd) = if format == "zip" {
        let zip_name = format!("{}.zip", item_name);
        let zip_esc = shell_escape(&zip_name);
        (
            zip_name,
            format!(
                "cd {} && zip -r -- {} {}",
                parent_esc, zip_esc, item_esc
            ),
        )
    } else {
        let tar_name = format!("{}.tar.gz", item_name);
        let tar_esc = shell_escape(&tar_name);
        (
            tar_name,
            format!(
                "cd {} && tar -czf {} -- {}",
                parent_esc, tar_esc, item_esc
            ),
        )
    };
    exec_remote_command(session_id, cmd, state).await?;
    Ok(archive_name)
}

#[tauri::command]
async fn extract_remote(
    session_id: String,
    parent_dir: String,
    archive_name: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if !is_valid_remote_filename(&parent_dir) || !is_valid_remote_filename(&archive_name) {
        return Err("Caractères invalides ou nom d'archive vide détecté".into());
    }

    let parent_esc = shell_escape(&parent_dir);
    let archive_esc = shell_escape(&archive_name);

    let cmd = if archive_name.ends_with(".zip") {
        format!("cd {} && unzip -o -- {}", parent_esc, archive_esc)
    } else if archive_name.ends_with(".tar.gz") || archive_name.ends_with(".tgz") {
        format!("cd {} && tar -xzf {} -C {}", parent_esc, archive_esc, parent_esc)
    } else if archive_name.ends_with(".tar") {
        format!("cd {} && tar -xf {} -C {}", parent_esc, archive_esc, parent_esc)
    } else {
        return Err("Format d'archive non supporté".into());
    };
    exec_remote_command(session_id, cmd, state).await?;
    Ok("Archive extraite avec succès".into())
}

#[tauri::command]
fn is_local_dir(path: String) -> bool {
    Path::new(&path).is_dir()
}

#[tauri::command]
async fn get_remote_size(
    session_id: String,
    remote_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (protocol, sftp, ftp) = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(&session_id)
            .ok_or_else(|| "Session inactive".to_string())?;
        (sess.protocol.clone(), sess.sftp.clone(), sess.ftp.clone())
    };

    if protocol == "SFTP" {
        let sftp = sftp.ok_or_else(|| "Session SFTP inactive".to_string())?;
        let meta = sftp.metadata(&remote_path).await.map_err(|e| e.to_string())?;
        if meta.is_dir() {
            let esc_path = shell_escape(&remote_path);
            let cmd = format!("du -sh -- {}", esc_path);
            let raw_res = exec_remote_command(session_id, cmd, state).await?;
            let size_only = raw_res.split_whitespace().next().unwrap_or(&raw_res).to_string();
            Ok(size_only)
        } else {
            let bytes = meta.size.unwrap_or(0);
            if bytes > 1024 * 1024 * 1024 {
                Ok(format!("{:.2} Go", bytes as f64 / (1024.0 * 1024.0 * 1024.0)))
            } else if bytes > 1024 * 1024 {
                Ok(format!("{:.1} Mo", bytes as f64 / (1024.0 * 1024.0)))
            } else if bytes > 1024 {
                Ok(format!("{:.0} Ko", bytes as f64 / 1024.0))
            } else {
                Ok(format!("{} octets", bytes))
            }
        }
    } else {
        let ftp_arc = ftp.ok_or_else(|| "Session FTP inactive".to_string())?;
        let mut ftp_guard = ftp_arc.lock().await;
        let size = ftp_guard.size(&remote_path).map_err(|e| e.to_string())? as u64;
        if size > 1024 * 1024 {
            Ok(format!("{:.1} Mo", size as f64 / (1024.0 * 1024.0)))
        } else if size > 1024 {
            Ok(format!("{:.0} Ko", size as f64 / 1024.0))
        } else {
            Ok(format!("{} octets", size))
        }
    }
}

#[tauri::command]
async fn compress_local(path: String, format: String) -> Result<String, String> {
    let p = Path::new(&path);
    let name = p.file_name().ok_or("Chemin invalide")?.to_string_lossy().to_string();
    let parent = p.parent().unwrap_or(Path::new("."));
    let is_zip = format.to_lowercase() == "zip";
    let ext = if is_zip { "zip" } else { "tar.gz" };
    let archive_path = parent.join(format!("{}.{}", name, ext));
    let archive_str = archive_path.to_string_lossy().to_string();

    let output = tokio::process::Command::new("tar")
        .current_dir(parent)
        .args(["-acf", &archive_str, &name])
        .output()
        .await
        .map_err(|e| format!("Erreur exécution tar: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(archive_str)
}

#[tauri::command]
async fn extract_local(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    let parent = p.parent().unwrap_or(Path::new("."));

    let output = tokio::process::Command::new("tar")
        .current_dir(parent)
        .args(["-axf", &path])
        .output()
        .await
        .map_err(|e| format!("Erreur exécution tar: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok("Archive locale extraite".into())
}

#[tauri::command]
fn get_temp_dir() -> String {
    let temp = std::env::temp_dir().join("Gens-RFT").join("relay");
    let _ = fs::create_dir_all(&temp);
    temp.to_string_lossy().to_string()
}

#[tauri::command]
fn export_sites_to_path(file_path: String, json_content: String) -> Result<(), String> {
    fs::write(file_path, json_content)
        .map_err(|e| format!("Impossible d'écrire le fichier : {}", e))
}

fn dirs_next() -> Option<PathBuf> {
    if let Some(userprofile) = std::env::var_os("USERPROFILE") {
        let path = PathBuf::from(userprofile);
        if path.is_dir() {
            return Some(path);
        }
    }

    if let (Ok(drive), Ok(homepath)) = (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH")) {
        let path = PathBuf::from(format!("{}{}", drive, homepath));
        if path.is_dir() {
            return Some(path);
        }
    }

    if let Some(home) = std::env::var_os("HOME") {
        let path = PathBuf::from(home);
        if path.is_dir() {
            return Some(path);
        }
    }

    std::env::current_dir().ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            cancel_tokens: Arc::new(Mutex::new(HashMap::new())),
        })
        .invoke_handler(tauri::generate_handler![
            get_windows_drives,
            get_system_folders,
            read_local_dir,
            list_remote_subdirs,
            read_local_subdirs,
            connect_server,
            disconnect_server,
            start_ssh_pty,
            write_ssh_pty,
            resize_ssh_pty,
            list_remote_dir,
            upload_item,
            download_item,
            cancel_current_transfer,
            read_remote_file_text,
            save_remote_file_text,
            open_remote_with_system,
            exec_remote_command,
            delete_local,
            create_local_dir,
            create_local_file,
            delete_remote,
            create_remote_dir,
            rename_local,
            rename_remote,
            chmod_remote,
            compress_remote,
            extract_remote,
            compress_local,
            extract_local,
            is_local_dir,
            get_remote_size,
            export_sites_to_path,
            get_temp_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

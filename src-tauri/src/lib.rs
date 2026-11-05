use async_trait::async_trait;
use russh::{ChannelMsg, client};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use suppaftp::FtpStream;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex, mpsc};
use walkdir::WalkDir;

#[derive(Serialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub permissions: Option<u32>,
}

#[derive(Serialize, Clone)]
pub struct TransferProgress {
    pub transfer_id: String,
    pub filename: String,
    pub transferred: u64,
    pub total: u64,
    pub percent: f32,
    pub direction: String,
}

pub enum PtyCommand {
    Input(Vec<u8>),
    Resize { cols: u32, rows: u32 },
}

pub struct ClientHandler;

#[async_trait]
impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

pub struct ServerSession {
    pub ssh_session: Option<client::Handle<ClientHandler>>,
    pub pty_sender: Option<mpsc::Sender<PtyCommand>>,
    pub sftp: Option<SftpSession>,
    pub ftp: Option<FtpStream>,
    pub protocol: String,
    pub current_remote_path: String,
}

pub struct AppState {
    pub sessions: Arc<Mutex<HashMap<String, ServerSession>>>,
    pub cancel_transfer: Arc<AtomicBool>,
}

#[tauri::command]
fn get_windows_drives() -> Vec<String> {
    let mut drives = Vec::new();
    #[cfg(windows)]
    {
        for drive_letter in b'A'..=b'Z' {
            let path_str = format!("{}:\\", drive_letter as char);
            if Path::new(&path_str).exists() {
                drives.push(path_str);
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
    if protocol == "FTP" {
        let addr = format!("{}:{}", host, port);
        let mut ftp = FtpStream::connect(&addr).map_err(|e| format!("Erreur TCP FTP: {}", e))?;
        let pass = password.unwrap_or_default();
        ftp.login(&username, &pass)
            .map_err(|e| format!("Auth FTP rejetée: {}", e))?;

        let mut sessions = state.sessions.lock().await;
        sessions.insert(session_id, ServerSession {
            ssh_session: None,
            pty_sender: None,
            sftp: None,
            ftp: Some(ftp),
            protocol,
            current_remote_path: "/".into(),
        });

        return Ok(format!("Connecté en FTP à {}@{}:{}", username, host, port));
    }

    let config = Arc::new(client::Config::default());
    let mut session = client::connect(config, (host.as_str(), port), ClientHandler)
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
    sessions.insert(session_id, ServerSession {
        ssh_session: Some(session),
        pty_sender: None,
        sftp: Some(sftp),
        ftp: None,
        protocol,
        current_remote_path: "/".into(),
    });

    Ok(format!("Connecté en SFTP à {}@{}:{}", username, host, port))
}

#[tauri::command]
async fn disconnect_server(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    if let Some(mut sess) = sessions.remove(&session_id) {
        if let Some(mut ftp) = sess.ftp.take() {
            let _ = ftp.quit();
        }
    }
    Ok(())
}

#[tauri::command]
fn cancel_current_transfer(state: State<'_, AppState>) {
    state.cancel_transfer.store(true, Ordering::Relaxed);
}

#[tauri::command]
async fn start_ssh_pty(
    session_id: String,
    app: AppHandle,
    cols: u32,
    rows: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    let sess = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "Session SSH inactive".to_string())?;

    let session = sess
        .ssh_session
        .as_mut()
        .ok_or_else(|| "Session SSH inactive".to_string())?;

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

    let (tx, mut rx) = mpsc::channel::<PtyCommand>(128);
    sess.pty_sender = Some(tx);

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
                Some(cmd) = rx.recv() => {
                    match cmd {
                        PtyCommand::Input(bytes) => {
                            if channel.data(&bytes[..]).await.is_err() {
                                break;
                            }
                        }
                        PtyCommand::Resize { cols, rows } => {
                            let _ = channel.window_change(cols, rows, 0, 0).await;
                        }
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

#[tauri::command]
async fn list_remote_dir(
    session_id: String,
    path: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<FileEntry>, String> {
    let mut sessions = state.sessions.lock().await;
    let sess = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "Session introuvable ou déconnectée".to_string())?;

    let target_path = path.unwrap_or_else(|| "/".into());

    if sess.protocol == "FTP" {
        let ftp = sess
            .ftp
            .as_mut()
            .ok_or_else(|| "Session FTP inactive".to_string())?;
        let lines = ftp.nlst(Some(&target_path)).map_err(|e| e.to_string())?;
        let mut entries = Vec::new();
        for item in lines {
            let name = Path::new(&item)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            if name.is_empty() || name == "." || name == ".." {
                continue;
            }
            let is_dir = !name.contains('.');
            entries.push(FileEntry {
                name: name.clone(),
                path: format!("{}/{}", target_path.trim_end_matches('/'), name),
                is_dir,
                size: 0,
                permissions: None,
            });
        }
        sess.current_remote_path = target_path;
        return Ok(entries);
    }

    let sftp = sess
        .sftp
        .as_ref()
        .ok_or_else(|| "Session SFTP inactive".to_string())?;

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

    sess.current_remote_path = target_path;
    Ok(entries)
}

#[tauri::command]
async fn list_remote_subdirs(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let sessions = state.sessions.lock().await;
    let sess = sessions
        .get(&session_id)
        .ok_or_else(|| "Session inactive".to_string())?;

    let sftp = sess
        .sftp
        .as_ref()
        .ok_or_else(|| "Session SFTP inactive".to_string())?;

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

async fn upload_single_file(
    app: &AppHandle,
    sftp: &SftpSession,
    cancel_flag: &AtomicBool,
    transfer_id: &str,
    local_path: &str,
    remote_path: &str,
) -> Result<(), String> {
    let mut local_file = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| format!("Erreur ouverture {}: {}", local_path, e))?;

    let total_size = local_file.metadata().await.map(|m| m.len()).unwrap_or(0);
    let mut remote_file = sftp
        .create(remote_path)
        .await
        .map_err(|e| format!("Erreur création distante: {}", e))?;

    let filename = Path::new(local_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let mut buffer = vec![0u8; 128 * 1024];
    let mut transferred: u64 = 0;
    let mut last_emit = Instant::now();

    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err("Transfert annulé par l'utilisateur".to_string());
        }

        let n = local_file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Erreur lecture locale: {}", e))?;

        if n == 0 {
            break;
        }

        remote_file
            .write_all(&buffer[..n])
            .await
            .map_err(|e| format!("Erreur écriture distante: {}", e))?;

        transferred += n as u64;

        if last_emit.elapsed().as_millis() >= 100 || transferred == total_size {
            let percent = if total_size > 0 {
                ((transferred as f64 / total_size as f64) * 100.0) as f32
            } else {
                100.0
            };

            let _ = app.emit(
                "transfer_progress",
                TransferProgress {
                    transfer_id: transfer_id.to_string(),
                    filename: filename.clone(),
                    transferred,
                    total: total_size,
                    percent,
                    direction: "upload".into(),
                },
            );
            last_emit = Instant::now();
        }
    }

    Ok(())
}

#[tauri::command]
async fn upload_item(
    session_id: String,
    app: AppHandle,
    transfer_id: String,
    local_path: String,
    remote_dest_dir: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state.cancel_transfer.store(false, Ordering::Relaxed);
    let sessions = state.sessions.lock().await;
    let sess = sessions
        .get(&session_id)
        .ok_or_else(|| "Session inactive".to_string())?;

    let sftp = sess
        .sftp
        .as_ref()
        .ok_or_else(|| "Session SFTP inactive".to_string())?;

    let source = Path::new(&local_path);
    let base_name = source
        .file_name()
        .ok_or_else(|| "Nom invalide".to_string())?
        .to_string_lossy();

    if source.is_dir() {
        let root_remote = format!("{}/{}", remote_dest_dir.trim_end_matches('/'), base_name);
        let _ = sftp.create_dir(&root_remote).await;

        for entry in WalkDir::new(&local_path).into_iter().filter_map(|e| e.ok()) {
            if state.cancel_transfer.load(Ordering::Relaxed) {
                return Err("Transfert annulé".to_string());
            }

            let rel = entry
                .path()
                .strip_prefix(&local_path)
                .map_err(|e| e.to_string())?;
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            if rel_str.is_empty() {
                continue;
            }

            let remote_target = format!("{}/{}", root_remote, rel_str);
            if entry.file_type().is_dir() {
                let _ = sftp.create_dir(&remote_target).await;
            } else {
                upload_single_file(
                    &app,
                    sftp,
                    &state.cancel_transfer,
                    &transfer_id,
                    &entry.path().to_string_lossy(),
                    &remote_target,
                )
                .await?;
            }
        }
    } else {
        let remote_target = format!("{}/{}", remote_dest_dir.trim_end_matches('/'), base_name);
        upload_single_file(
            &app,
            sftp,
            &state.cancel_transfer,
            &transfer_id,
            &local_path,
            &remote_target,
        )
        .await?;
    }

    Ok("Upload terminé".into())
}

fn sanitize_windows_filename(name: &str) -> String {
    let clean = name.replace(['<', '>', ':', '"', '/', '\\', '|', '?', '*'], "_");
    clean.trim_end_matches(['.', ' ']).to_string()
}

async fn download_single_file(
    app: &AppHandle,
    sftp: &SftpSession,
    cancel_flag: &AtomicBool,
    transfer_id: &str,
    remote_path: &str,
    local_path: &Path,
) -> Result<(), String> {
    // 1. Création systématique de toute l'arborescence parente locale
    if let Some(parent) = local_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Impossible de créer le dossier local ({}): {}", parent.display(), e))?;
    }

    // 2. Ouverture distante
    let mut remote_file = sftp
        .open(remote_path)
        .await
        .map_err(|e| format!("Erreur lecture distante ({}): {}", remote_path, e))?;

    let total_size = remote_file
        .metadata()
        .await
        .map(|m| m.size.unwrap_or(0))
        .unwrap_or(0);

    // 3. Création locale Windows
    let mut local_file = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| format!("Erreur création locale ({}): {}", local_path.display(), e))?;

    let filename = local_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let mut buffer = vec![0u8; 128 * 1024];
    let mut transferred: u64 = 0;
    let mut last_emit = Instant::now();

    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err("Transfert annulé par l'utilisateur".to_string());
        }

        let n = remote_file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Erreur lecture: {}", e))?;

        if n == 0 {
            break;
        }

        local_file
            .write_all(&buffer[..n])
            .await
            .map_err(|e| format!("Erreur écriture ({}): {}", local_path.display(), e))?;

        transferred += n as u64;

        if last_emit.elapsed().as_millis() >= 100 || transferred == total_size {
            let percent = if total_size > 0 {
                ((transferred as f64 / total_size as f64) * 100.0) as f32
            } else {
                100.0
            };

            let _ = app.emit(
                "transfer_progress",
                TransferProgress {
                    transfer_id: transfer_id.to_string(),
                    filename: filename.clone(),
                    transferred,
                    total: total_size,
                    percent,
                    direction: "download".into(),
                },
            );
            last_emit = Instant::now();
        }
    }

    Ok(())
}

#[tauri::command]
async fn download_item(
    session_id: String,
    app: AppHandle,
    transfer_id: String,
    remote_path: String,
    local_dest_dir: String,
    is_dir: bool,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state.cancel_transfer.store(false, Ordering::Relaxed);
    let sessions = state.sessions.lock().await;
    let sess = sessions
        .get(&session_id)
        .ok_or_else(|| "Session inactive".to_string())?;

    let sftp = sess
        .sftp
        .as_ref()
        .ok_or_else(|| "Session SFTP inactive".to_string())?;

    // Nettoyage et normalisation du dossier de destination local
    let normalized_dest = local_dest_dir.trim().replace('/', "\\");
    let base_dest = PathBuf::from(&normalized_dest);

    // Vérifie et crée la base locale si elle n'existe pas
    tokio::fs::create_dir_all(&base_dest)
        .await
        .map_err(|e| format!("Dossier local de destination inaccessible ({}): {}", base_dest.display(), e))?;

    let raw_filename = Path::new(&remote_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    let safe_filename = sanitize_windows_filename(&raw_filename);

    if is_dir {
        let root_local_dir = base_dest.join(&safe_filename);
        tokio::fs::create_dir_all(&root_local_dir).await.map_err(|e| e.to_string())?;

        let mut queue = vec![(remote_path.clone(), root_local_dir)];
        while let Some((rem_dir, loc_dir)) = queue.pop() {
            if state.cancel_transfer.load(Ordering::Relaxed) {
                return Err("Transfert annulé".to_string());
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

                    if item.file_type().is_dir() {
                        let _ = tokio::fs::create_dir_all(&sub_loc).await;
                        queue.push((sub_rem, sub_loc));
                    } else {
                        download_single_file(
                            &app,
                            sftp,
                            &state.cancel_transfer,
                            &transfer_id,
                            &sub_rem,
                            &sub_loc,
                        )
                        .await?;
                    }
                }
            }
        }
    } else {
        let local_target = base_dest.join(safe_filename);
        download_single_file(
            &app,
            sftp,
            &state.cancel_transfer,
            &transfer_id,
            &remote_path,
            &local_target,
        )
        .await?;
    }

    Ok("Téléchargement terminé".into())
}

#[tauri::command]
async fn read_remote_file_text(
    session_id: String,
    remote_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let sessions = state.sessions.lock().await;
    let sess = sessions
        .get(&session_id)
        .ok_or_else(|| "Session inactive".to_string())?;

    let sftp = sess
        .sftp
        .as_ref()
        .ok_or_else(|| "Session SFTP inactive".to_string())?;

    let mut remote_file = sftp.open(&remote_path).await.map_err(|e| e.to_string())?;
    let mut buffer = Vec::new();
    remote_file.read_to_end(&mut buffer).await.map_err(|e| e.to_string())?;

    String::from_utf8(buffer).map_err(|_| "Ce fichier n'est pas un fichier texte UTF-8 valide (binaire ou encodage non supporté).".to_string())
}

#[tauri::command]
async fn save_remote_file_text(
    session_id: String,
    remote_path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let sess = sessions
        .get(&session_id)
        .ok_or_else(|| "Session inactive".to_string())?;

    let sftp = sess
        .sftp
        .as_ref()
        .ok_or_else(|| "Session SFTP inactive".to_string())?;

    let mut remote_file = sftp.create(&remote_path).await.map_err(|e| e.to_string())?;
    remote_file.write_all(content.as_bytes()).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn open_remote_with_system(
    session_id: String,
    remote_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let sessions = state.sessions.lock().await;
    let sess = sessions
        .get(&session_id)
        .ok_or_else(|| "Session inactive".to_string())?;

    let sftp = sess
        .sftp
        .as_ref()
        .ok_or_else(|| "Session SFTP inactive".to_string())?;

    let filename = Path::new(&remote_path)
        .file_name()
        .ok_or_else(|| "Nom de fichier invalide".to_string())?
        .to_string_lossy();

    let temp_dir = std::env::temp_dir().join("Gens-RFT");
    let _ = fs::create_dir_all(&temp_dir);
    let local_temp_file = temp_dir.join(filename.as_ref());

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
    let mut sessions = state.sessions.lock().await;
    let sess = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "Session inactive".to_string())?;

    let session = sess
        .ssh_session
        .as_mut()
        .ok_or_else(|| "Session SSH inactive".to_string())?;

    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("Impossible d'ouvrir un canal SSH : {}", e))?;

    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|e| format!("Erreur exécution commande : {}", e))?;

    let mut output = Vec::new();
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { ref data } => {
                output.extend_from_slice(data);
            }
            ChannelMsg::ExtendedData { ref data, .. } => {
                output.extend_from_slice(data);
            }
            ChannelMsg::Eof => break,
            _ => {}
        }
    }

    Ok(String::from_utf8_lossy(&output).to_string())
}

#[tauri::command]
async fn chmod_remote(
    session_id: String,
    path: String,
    permissions: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let sess = sessions
        .get(&session_id)
        .ok_or_else(|| "Session inactive".to_string())?;

    let sftp = sess
        .sftp
        .as_ref()
        .ok_or_else(|| "Session SFTP inactive".to_string())?;

    let mut metadata = sftp.metadata(&path).await.map_err(|e| e.to_string())?;
    metadata.permissions = Some(permissions);
    sftp.set_metadata(&path, metadata)
        .await
        .map_err(|e| format!("Erreur CHMOD: {}", e))
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
    let sessions = state.sessions.lock().await;
    let sess = sessions
        .get(&session_id)
        .ok_or_else(|| "Session inactive".to_string())?;

    let sftp = sess
        .sftp
        .as_ref()
        .ok_or_else(|| "Session SFTP inactive".to_string())?;

    sftp.rename(old_path, new_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_local(path: String, is_dir: bool) -> Result<(), String> {
    if is_dir {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&path).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn create_local_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_remote(
    session_id: String,
    path: String,
    is_dir: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let sess = sessions
        .get(&session_id)
        .ok_or_else(|| "Session inactive".to_string())?;

    let sftp = sess
        .sftp
        .as_ref()
        .ok_or_else(|| "Session SFTP inactive".to_string())?;

    if is_dir {
        sftp.remove_dir(&path).await.map_err(|e| e.to_string())
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
    let sessions = state.sessions.lock().await;
    let sess = sessions
        .get(&session_id)
        .ok_or_else(|| "Session inactive".to_string())?;

    let sftp = sess
        .sftp
        .as_ref()
        .ok_or_else(|| "Session SFTP inactive".to_string())?;

    sftp.create_dir(&path).await.map_err(|e| e.to_string())
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
        .manage(AppState {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            cancel_transfer: Arc::new(AtomicBool::new(false)),
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
            delete_remote,
            create_remote_dir,
            rename_local,
            rename_remote,
            chmod_remote
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
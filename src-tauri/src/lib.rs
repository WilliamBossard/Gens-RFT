use async_trait::async_trait;
use russh::{ChannelMsg, client};
use russh_sftp::client::SftpSession;
use serde::Serialize;
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

pub struct AppState {
    pub ssh_session: Arc<Mutex<Option<client::Handle<ClientHandler>>>>,
    pub pty_sender: Arc<Mutex<Option<mpsc::Sender<PtyCommand>>>>,
    pub sftp: Arc<Mutex<Option<SftpSession>>>,
    pub ftp: Arc<Mutex<Option<FtpStream>>>,
    pub current_protocol: Arc<Mutex<String>>,
    pub current_remote_path: Arc<Mutex<String>>,
    pub cancel_transfer: Arc<AtomicBool>,
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
    *state.current_protocol.lock().await = protocol.clone();

    if protocol == "FTP" {
        let addr = format!("{}:{}", host, port);
        let mut ftp = FtpStream::connect(&addr).map_err(|e| format!("Erreur TCP FTP: {}", e))?;
        let pass = password.unwrap_or_default();
        ftp.login(&username, &pass)
            .map_err(|e| format!("Auth FTP rejetée: {}", e))?;

        let mut ftp_guard = state.ftp.lock().await;
        *ftp_guard = Some(ftp);
        *state.current_remote_path.lock().await = "/".into();

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

    {
        let mut ssh_guard = state.ssh_session.lock().await;
        *ssh_guard = Some(session);

        let mut sftp_guard = state.sftp.lock().await;
        *sftp_guard = Some(sftp);

        let mut path_guard = state.current_remote_path.lock().await;
        *path_guard = "/".into();
    }

    Ok(format!("Connecté en SFTP à {}@{}:{}", username, host, port))
}

#[tauri::command]
fn cancel_current_transfer(state: State<'_, AppState>) {
    state.cancel_transfer.store(true, Ordering::Relaxed);
}

#[tauri::command]
async fn start_ssh_pty(
    app: AppHandle,
    cols: u32,
    rows: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut session_guard = state.ssh_session.lock().await;
    let session = session_guard
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
    *state.pty_sender.lock().await = Some(tx);

    tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { ref data }) => {
                            let text = String::from_utf8_lossy(data).to_string();
                            let _ = app.emit("ssh_pty_output", text);
                        }
                        Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                            let text = String::from_utf8_lossy(data).to_string();
                            let _ = app.emit("ssh_pty_output", text);
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
async fn write_ssh_pty(data: String, state: State<'_, AppState>) -> Result<(), String> {
    let pty_guard = state.pty_sender.lock().await;
    if let Some(tx) = pty_guard.as_ref() {
        tx.send(PtyCommand::Input(data.into_bytes()))
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn resize_ssh_pty(cols: u32, rows: u32, state: State<'_, AppState>) -> Result<(), String> {
    let pty_guard = state.pty_sender.lock().await;
    if let Some(tx) = pty_guard.as_ref() {
        tx.send(PtyCommand::Resize { cols, rows })
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn list_remote_dir(
    path: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<FileEntry>, String> {
    let proto = state.current_protocol.lock().await.clone();
    let target_path = path.unwrap_or_else(|| "/".into());

    if proto == "FTP" {
        let mut ftp_guard = state.ftp.lock().await;
        let ftp = ftp_guard
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
        *state.current_remote_path.lock().await = target_path;
        return Ok(entries);
    }

    let sftp_guard = state.sftp.lock().await;
    let sftp = sftp_guard
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

        // Prise en charge des liens symboliques Linux :
        // Si c'est un symlink, on inspecte la cible via sftp.metadata()
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

    *state.current_remote_path.lock().await = target_path;
    Ok(entries)
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
    let mut buffer = [0u8; 64 * 1024];
    let mut transferred: u64 = 0;
    let mut last_emit = Instant::now();

    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err("Transfert annulé par l'utilisateur".to_string());
        }

        let n = local_file
            .read(&mut buffer)
            .await
            .map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        remote_file
            .write_all(&buffer[..n])
            .await
            .map_err(|e| e.to_string())?;
        transferred += n as u64;

        if last_emit.elapsed().as_millis() >= 150 || transferred == total_size {
            let percent = if total_size > 0 {
                (transferred as f32 / total_size as f32) * 100.0
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
    app: AppHandle,
    transfer_id: String,
    local_path: String,
    remote_dest_dir: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state.cancel_transfer.store(false, Ordering::Relaxed);
    let sftp_guard = state.sftp.lock().await;
    let sftp = sftp_guard
        .as_ref()
        .ok_or_else(|| "Session inactive".to_string())?;

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

async fn download_single_file(
    app: &AppHandle,
    sftp: &SftpSession,
    cancel_flag: &AtomicBool,
    transfer_id: &str,
    remote_path: &str,
    local_path: &str,
) -> Result<(), String> {
    let mut remote_file = sftp
        .open(remote_path)
        .await
        .map_err(|e| format!("Erreur lecture: {}", e))?;

    let total_size = remote_file
        .metadata()
        .await
        .map(|m| m.size.unwrap_or(0))
        .unwrap_or(0);
    let mut local_file = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| format!("Erreur création: {}", e))?;

    let filename = Path::new(remote_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let mut buffer = [0u8; 64 * 1024];
    let mut transferred: u64 = 0;
    let mut last_emit = Instant::now();

    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err("Transfert annulé par l'utilisateur".to_string());
        }

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
        transferred += n as u64;

        if last_emit.elapsed().as_millis() >= 150 || transferred == total_size {
            let percent = if total_size > 0 {
                (transferred as f32 / total_size as f32) * 100.0
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
    app: AppHandle,
    transfer_id: String,
    remote_path: String,
    local_dest_dir: String,
    is_dir: bool,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state.cancel_transfer.store(false, Ordering::Relaxed);
    let sftp_guard = state.sftp.lock().await;
    let sftp = sftp_guard
        .as_ref()
        .ok_or_else(|| "Session inactive".to_string())?;

    let filename = Path::new(&remote_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();

    if is_dir {
        let target_dir = Path::new(&local_dest_dir).join(filename.as_ref());
        let _ = fs::create_dir_all(&target_dir);

        let mut queue = vec![(remote_path.clone(), target_dir)];
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
                    let sub_rem = format!("{}/{}", rem_dir.trim_end_matches('/'), sub_name);
                    let sub_loc = loc_dir.join(&sub_name);

                    if item.file_type().is_dir() {
                        let _ = fs::create_dir_all(&sub_loc);
                        queue.push((sub_rem, sub_loc));
                    } else {
                        download_single_file(
                            &app,
                            sftp,
                            &state.cancel_transfer,
                            &transfer_id,
                            &sub_rem,
                            &sub_loc.to_string_lossy(),
                        )
                        .await?;
                    }
                }
            }
        }
    } else {
        let local_target = Path::new(&local_dest_dir).join(filename.as_ref());
        download_single_file(
            &app,
            sftp,
            &state.cancel_transfer,
            &transfer_id,
            &remote_path,
            &local_target.to_string_lossy(),
        )
        .await?;
    }

    Ok("Téléchargement terminé".into())
}

#[tauri::command]
async fn open_remote_with_system(
    remote_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let sftp_guard = state.sftp.lock().await;
    let sftp = sftp_guard
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

    let mut buffer = [0u8; 64 * 1024];
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
    command: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let mut session_guard = state.ssh_session.lock().await;
    let session = session_guard
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
    path: String,
    permissions: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sftp_guard = state.sftp.lock().await;
    let sftp = sftp_guard
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
    old_path: String,
    new_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sftp_guard = state.sftp.lock().await;
    let sftp = sftp_guard
        .as_ref()
        .ok_or_else(|| "Session inactive".to_string())?;
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
    path: String,
    is_dir: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sftp_guard = state.sftp.lock().await;
    let sftp = sftp_guard
        .as_ref()
        .ok_or_else(|| "Session inactive".to_string())?;

    if is_dir {
        sftp.remove_dir(&path).await.map_err(|e| e.to_string())
    } else {
        sftp.remove_file(&path).await.map_err(|e| e.to_string())
    }
}

#[tauri::command]
async fn create_remote_dir(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let sftp_guard = state.sftp.lock().await;
    let sftp = sftp_guard
        .as_ref()
        .ok_or_else(|| "Session inactive".to_string())?;
    sftp.create_dir(&path).await.map_err(|e| e.to_string())
}

fn dirs_next() -> Option<PathBuf> {
    // 1. Profil utilisateur principal Windows
    if let Some(userprofile) = std::env::var_os("USERPROFILE") {
        let path = PathBuf::from(userprofile);
        if path.is_dir() {
            return Some(path);
        }
    }

    // 2. Variables de session Windows (HOMEDRIVE + HOMEPATH)
    if let (Ok(drive), Ok(homepath)) = (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH")) {
        let path = PathBuf::from(format!("{}{}", drive, homepath));
        if path.is_dir() {
            return Some(path);
        }
    }

    // 3. Variable HOME (Linux/macOS)
    if let Some(home) = std::env::var_os("HOME") {
        let path = PathBuf::from(home);
        if path.is_dir() {
            return Some(path);
        }
    }

    // 4. Dossier de travail courant en dernier recours
    std::env::current_dir().ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            ssh_session: Arc::new(Mutex::new(None)),
            pty_sender: Arc::new(Mutex::new(None)),
            sftp: Arc::new(Mutex::new(None)),
            ftp: Arc::new(Mutex::new(None)),
            current_protocol: Arc::new(Mutex::new("SFTP".into())),
            current_remote_path: Arc::new(Mutex::new("/".into())),
            cancel_transfer: Arc::new(AtomicBool::new(false)),
        })
        .invoke_handler(tauri::generate_handler![
            read_local_dir,
            list_remote_subdirs,
            read_local_subdirs,
            connect_server,
            start_ssh_pty,
            write_ssh_pty,
            resize_ssh_pty,
            list_remote_dir,
            upload_item,
            download_item,
            cancel_current_transfer,
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
#[tauri::command]
async fn list_remote_subdirs(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let sftp_guard = state.sftp.lock().await;
    let sftp = sftp_guard
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

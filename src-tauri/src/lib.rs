use async_trait::async_trait;
use russh::client::{self, Msg};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;

#[derive(Serialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

// Handler client SSH vide (accepte la clé hôte du serveur)
struct ClientHandler;

#[async_trait]
impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

pub struct AppState {
    pub sftp: Arc<Mutex<Option<SftpSession>>>,
    pub current_remote_path: Arc<Mutex<String>>,
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
async fn connect_sftp(
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let config = Arc::new(client::Config::default());
    let mut session = client::connect(config, (host.as_str(), port), ClientHandler)
        .await
        .map_err(|e| format!("Erreur connexion TCP/SSH: {}", e))?;

    let pass = password.unwrap_or_default();
    let auth_res = session
        .authenticate_password(username.clone(), pass)
        .await
        .map_err(|e| format!("Erreur authentification: {}", e))?;

    if !auth_res {
        return Err("Identifiants incorrects (authentification refusée)".into());
    }

    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("Erreur ouverture canal SSH: {}", e))?;

    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("Erreur sous-système SFTP: {}", e))?;

    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("Erreur handshake SFTP: {}", e))?;

    {
        let mut sftp_guard = state.sftp.lock().await;
        *sftp_guard = Some(sftp);

        let mut path_guard = state.current_remote_path.lock().await;
        *path_guard = "/".into();
    }

    Ok(format!(
        "Connecté avec succès à {}@{}:{}",
        username, host, port
    ))
}

#[tauri::command]
async fn list_remote_dir(
    path: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<FileEntry>, String> {
    let sftp_guard = state.sftp.lock().await;
    let sftp = sftp_guard
        .as_ref()
        .ok_or_else(|| "Aucune session SFTP active".to_string())?;

    let target_path = path.unwrap_or_else(|| "/".into());

    let mut dir = sftp
        .read_dir(&target_path)
        .await
        .map_err(|e| format!("Erreur lecture dossier distant: {}", e))?;

    let mut entries = Vec::new();
    while let Some(file) = dir.next() {
        let name = file.file_name();
        if name == "." || name == ".." {
            continue;
        }

        let is_dir = file.file_type().is_dir();
        let size = file.metadata().size.unwrap_or(0);
        let full_path = if target_path.ends_with('/') {
            format!("{}{}", target_path, name)
        } else {
            format!("{}/{}", target_path, name)
        };

        entries.push(FileEntry {
            name,
            path: full_path,
            is_dir,
            size,
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    {
        let mut path_guard = state.current_remote_path.lock().await;
        *path_guard = target_path;
    }

    Ok(entries)
}

fn dirs_next() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            sftp: Arc::new(Mutex::new(None)),
            current_remote_path: Arc::new(Mutex::new("/".into())),
        })
        .invoke_handler(tauri::generate_handler![
            read_local_dir,
            connect_sftp,
            list_remote_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

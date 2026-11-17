mod ftp;
mod local;
mod models;
mod sftp;
mod security;
mod state;

use russh::{ChannelMsg, client};
use russh_sftp::client::SftpSession;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex, Semaphore, mpsc};
use zeroize::Zeroizing;

use models::{FileEntry, HostKeyRejectReason, PtyCommand, RemoteTextFile};
use security::{
    ClientHandler, is_dangerous_executable_filename, is_valid_id, is_valid_remote_filename,
    is_valid_remote_path, remote_file_name, sanitize_windows_filename, shell_escape,
    validate_ftp_arg,
};
use state::{AppState, FtpSessionConfig, ServerSession};
use suppaftp::NativeTlsFtpStream;

const SSH_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const PTY_BATCH_THRESHOLD: usize = 16 * 1024;
const PTY_BATCH_INTERVAL: Duration = Duration::from_millis(16);
const MAX_PREVIEW_BYTES: u64 = 100 * 1024 * 1024;
const MAX_FTP_POOL_SIZE: usize = 2;

fn ensure_valid_id(id: &str, label: &str) -> Result<(), String> {
    if !is_valid_id(id) {
        return Err(format!("Identifiant {} invalide", label));
    }
    Ok(())
}

fn flush_pty_utf8(app: &AppHandle, event_name: &str, pending: &mut Vec<u8>, force_all: bool) {
    if pending.is_empty() {
        return;
    }

    let mut out = String::new();
    let mut consumed = 0usize;

    while consumed < pending.len() {
        match std::str::from_utf8(&pending[consumed..]) {
            Ok(valid) => {
                out.push_str(valid);
                consumed = pending.len();
                break;
            }
            Err(err) => {
                let valid_len = err.valid_up_to();
                if valid_len > 0 {
                    // Safety: valid_up_to() guarantees valid UTF-8 slice
                    let valid_str = std::str::from_utf8(&pending[consumed..consumed + valid_len])
                        .unwrap_or_default();
                    out.push_str(valid_str);
                    consumed += valid_len;
                }
                match err.error_len() {
                    Some(bad_len) => {
                        out.push('\u{FFFD}');
                        consumed += bad_len;
                    }
                    None => {
                        if force_all {
                            out.push('\u{FFFD}');
                            consumed = pending.len();
                        }
                        break;
                    }
                }
            }
        }
    }

    if consumed > 0 {
        pending.drain(..consumed);
    }

    if !out.is_empty() {
        let _ = app.emit(event_name, out);
    }
}

async fn stop_pty_gracefully(
    pty_sender: Option<mpsc::Sender<PtyCommand>>,
    pty_task: Option<tokio::task::JoinHandle<()>>,
) {
    drop(pty_sender);
    if let Some(mut task) = pty_task
        && tokio::time::timeout(Duration::from_millis(300), &mut task)
            .await
            .is_err()
    {
        task.abort();
    }
}

async fn cleanup_session_resources(mut sess: ServerSession) {
    stop_pty_gracefully(sess.pty_sender.take(), sess.pty_task.take()).await;
    sess.ftp_config.take();
    if let Some(pool_arc) = sess.ftp_pool.take() {
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            tokio::task::spawn_blocking(move || {
                if let Ok(mut pool) = pool_arc.lock() {
                    for mut conn in pool.drain(..) {
                        let _ = conn.quit();
                    }
                }
            }),
        )
        .await;
    }
    if let Some(ftp_arc) = sess.ftp.take() {
        // Ne pas bloquer disconnect_server si un transfert ou verrou FTP est encore actif
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            tokio::task::spawn_blocking(move || {
                if let Ok(mut ftp) = ftp_arc.try_lock() {
                    let _ = ftp.quit();
                }
            }),
        )
        .await;
    }
    if let Some(ssh_arc) = sess.ssh_session.take()
        && let Ok(ssh) = tokio::time::timeout(Duration::from_secs(2), ssh_arc.lock()).await
    {
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            ssh.disconnect(russh::Disconnect::ByApplication, "", "en"),
        )
        .await;
    }
}

fn is_ftp_connection_error(msg: &str) -> bool {
    let lower = msg.to_ascii_lowercase();
    lower.contains("connection")
        || lower.contains("broken pipe")
        || lower.contains("reset")
        || lower.contains("eof")
        || lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("421")
        || lower.contains("closed")
}

fn run_ftp_browsing<T, F>(
    ftp_arc: &Arc<std::sync::Mutex<NativeTlsFtpStream>>,
    ftp_cfg: &Option<FtpSessionConfig>,
    mut op: F,
) -> Result<T, String>
where
    F: FnMut(&mut NativeTlsFtpStream) -> Result<T, String>,
{
    let mut ftp_guard = ftp_arc
        .lock()
        .map_err(|_| "Verrou FTP corrompu".to_string())?;
    match op(&mut ftp_guard) {
        Ok(val) => Ok(val),
        Err(first_err) => {
            let dead = is_ftp_connection_error(&first_err) || ftp_guard.noop().is_err();
            if dead
                && let Some(cfg) = ftp_cfg
                && let Ok(new_stream) = ftp::connect_from_config(cfg)
            {
                *ftp_guard = new_stream;
                return op(&mut ftp_guard);
            }
            Err(first_err)
        }
    }
}

fn acquire_ftp_transfer_conn(
    pool_arc: &Option<Arc<std::sync::Mutex<Vec<NativeTlsFtpStream>>>>,
    cfg: &FtpSessionConfig,
) -> Result<NativeTlsFtpStream, String> {
    if let Some(pool) = pool_arc
        && let Ok(mut guard) = pool.lock()
    {
        while let Some(mut conn) = guard.pop() {
            if conn.noop().is_ok() {
                return Ok(conn);
            }
        }
    }
    ftp::connect_from_config(cfg)
}

fn release_ftp_transfer_conn(
    pool_arc: &Option<Arc<std::sync::Mutex<Vec<NativeTlsFtpStream>>>>,
    mut conn: NativeTlsFtpStream,
    reusable: bool,
) {
    if reusable
        && let Some(pool) = pool_arc
        && let Ok(mut guard) = pool.lock()
        && guard.len() < MAX_FTP_POOL_SIZE
    {
        guard.push(conn);
        return;
    }
    let _ = conn.quit();
}

#[allow(clippy::too_many_arguments)]
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
    trust_host_key: Option<bool>,
    accept_invalid_certs: Option<bool>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    ensure_valid_id(&session_id, "de session")?;
    if host.trim().is_empty() {
        return Err("L'adresse de l'hôte est requise".to_string());
    }
    if port == 0 {
        return Err("Numéro de port invalide".to_string());
    }

    // Fermer une éventuelle session existante sur ce même ID avant de la remplacer
    let previous = {
        let mut sessions = state.sessions.lock().await;
        sessions.remove(&session_id)
    };
    if let Some(old_sess) = previous {
        state.cancel_session_transfers(&session_id).await;
        cleanup_session_resources(old_sess).await;
    }

    if protocol == "FTP" || protocol == "FTPS" {
        let prot_c = protocol.clone();
        let host_c = host.clone();
        let user_c = username.clone();
        let pass_z = Zeroizing::new(password.unwrap_or_default());
        let allow_invalid = accept_invalid_certs.unwrap_or(false);

        let ftp_cfg = FtpSessionConfig {
            protocol: prot_c.clone(),
            host: host_c.clone(),
            port,
            username: user_c.clone(),
            password: pass_z.clone(),
            accept_invalid_certs: allow_invalid,
        };

        let ftp = tokio::task::spawn_blocking(move || {
            ftp::connect_ftp_blocking(
                &prot_c,
                &host_c,
                port,
                &user_c,
                &pass_z,
                allow_invalid,
            )
        })
        .await
        .map_err(|e| format!("Erreur tâche FTP: {}", e))??;

        let mut sessions = state.sessions.lock().await;
        sessions.insert(
            session_id,
            ServerSession {
                ssh_session: None,
                pty_sender: None,
                pty_task: None,
                sftp: None,
                sftp_semaphore: None,
                ftp: Some(Arc::new(std::sync::Mutex::new(ftp))),
                ftp_pool: Some(Arc::new(std::sync::Mutex::new(Vec::new()))),
                ftp_config: Some(ftp_cfg),
                protocol: protocol.clone(),
                current_remote_path: "/".into(),
            },
        );

        return Ok(format!(
            "Connecté en {} à {}@{}:{}",
            protocol, username, host, port
        ));
    }

    let config = Arc::new(client::Config {
        window_size: 4 * 1024 * 1024,
        maximum_packet_size: 64 * 1024,
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        ..Default::default()
    });

    let reject_reason = Arc::new(Mutex::new(None));
    let handler = ClientHandler {
        host: host.clone(),
        port,
        trust_host_key: trust_host_key.unwrap_or(false),
        reject_reason: Arc::clone(&reject_reason),
    };

    let connect_res = tokio::time::timeout(
        SSH_CONNECT_TIMEOUT,
        client::connect(config, (host.as_str(), port), handler),
    )
    .await
    .map_err(|_| {
        format!(
            "Timeout connexion SSH vers {}:{} ({}s)",
            host,
            port,
            SSH_CONNECT_TIMEOUT.as_secs()
        )
    })?;

    let mut session = match connect_res {
        Ok(s) => s,
        Err(e) => {
            let reason = reject_reason.lock().await.take();
            match reason {
                Some(HostKeyRejectReason::Unknown { algo, fingerprint }) => {
                    return Err(format!("HOST_KEY_UNKNOWN|{}|{}", algo, fingerprint));
                }
                Some(HostKeyRejectReason::Changed { algo, fingerprint }) => {
                    return Err(format!("HOST_KEY_CHANGED|{}|{}", algo, fingerprint));
                }
                Some(HostKeyRejectReason::Error(msg)) => return Err(msg),
                None => return Err(format!("Erreur réseau SSH: {}", e)),
            }
        }
    };

    let authenticated = if auth_type == "key" {
        let path = key_path.ok_or_else(|| "Chemin de clé SSH manquant".to_string())?;
        let passphrase_buf = passphrase.map(Zeroizing::new);
        let key_res = russh_keys::load_secret_key(path, passphrase_buf.as_deref().map(|s| s.as_str()));
        let key_data =
            key_res.map_err(|e| format!("Clé SSH invalide ou passphrase erronée: {}", e))?;
        session
            .authenticate_publickey(username.clone(), Arc::new(key_data))
            .await
            .map_err(|e| format!("Auth clé rejetée: {}", e))?
    } else {
        let pass = Zeroizing::new(password.unwrap_or_default());
        session
            .authenticate_password(username.clone(), pass.as_str())
            .await
            .map_err(|e| format!("Auth mot de passe rejetée: {}", e))?
    };

    if !authenticated {
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            session.disconnect(russh::Disconnect::ByApplication, "", "en"),
        )
        .await;
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
            ssh_session: Some(Arc::new(Mutex::new(session))),
            pty_sender: None,
            pty_task: None,
            sftp: Some(Arc::new(sftp)),
            sftp_semaphore: Some(Arc::new(Semaphore::new(8))),
            ftp: None,
            ftp_pool: None,
            ftp_config: None,
            protocol,
            current_remote_path: "/".into(),
        },
    );

    Ok(format!("Connecté en SFTP à {}@{}:{}", username, host, port))
}

#[tauri::command]
async fn disconnect_server(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    ensure_valid_id(&session_id, "de session")?;
    state.cancel_session_transfers(&session_id).await;

    // Retirer la session et relâcher immédiatement le verrou global avant de fermer les sockets réseau
    let removed = {
        let mut sessions = state.sessions.lock().await;
        sessions.remove(&session_id)
    };

    if let Some(sess) = removed {
        cleanup_session_resources(sess).await;
    }

    let temp_preview = local::pid_temp_root().join("preview").join(&session_id);
    let _ = tokio::fs::remove_dir_all(temp_preview).await;

    Ok(())
}

#[tauri::command]
async fn cancel_current_transfer(
    transfer_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if let Some(id) = transfer_id {
        ensure_valid_id(&id, "de transfert")?;
        state.cancel_transfer(&id, None).await;
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
    ensure_valid_id(&session_id, "de session")?;
    let (ssh_arc, old_sender, old_task) = {
        let mut sessions = state.sessions.lock().await;
        let sess = sessions
            .get_mut(&session_id)
            .ok_or_else(|| "Session SSH inactive".to_string())?;

        let old_sender = sess.pty_sender.take();
        let old_task = sess.pty_task.take();
        let ssh_arc = sess
            .ssh_session
            .clone()
            .ok_or_else(|| "Session SSH inactive".to_string())?;
        (ssh_arc, old_sender, old_task)
    };

    // Ferme proprement un éventuel ancien canal PTY sans retenir le verrou global
    if old_sender.is_some() || old_task.is_some() {
        stop_pty_gracefully(old_sender, old_task).await;
    }

    let session = tokio::time::timeout(Duration::from_secs(15), ssh_arc.lock())
        .await
        .map_err(|_| "Timeout verrou session SSH".to_string())?;
    let mut channel = tokio::time::timeout(Duration::from_secs(15), session.channel_open_session())
        .await
        .map_err(|_| "Timeout ouverture canal PTY".to_string())?
        .map_err(|e| format!("Impossible d'ouvrir un canal PTY: {}", e))?;

    tokio::time::timeout(
        Duration::from_secs(15),
        channel.request_pty(false, "xterm-256color", cols, rows, 0, 0, &[]),
    )
    .await
    .map_err(|_| "Timeout allocation PTY".to_string())?
    .map_err(|e| format!("Échec allocation PTY: {}", e))?;

    tokio::time::timeout(Duration::from_secs(15), channel.request_shell(true))
        .await
        .map_err(|_| "Timeout lancement shell".to_string())?
        .map_err(|e| format!("Échec lancement shell: {}", e))?;
    drop(session);

    let (tx, mut rx) = mpsc::channel::<PtyCommand>(128);
    let event_name = format!("ssh_pty_output_{}", session_id);
    let closed_event_name = format!("ssh_pty_closed_{}", session_id);
    let handle = tokio::spawn(async move {
        let mut pending: Vec<u8> = Vec::with_capacity(PTY_BATCH_THRESHOLD);
        let flush_timer = tokio::time::sleep(PTY_BATCH_INTERVAL);
        tokio::pin!(flush_timer);
        let mut timer_armed = false;

        loop {
            tokio::select! {
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { ref data }) | Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                            pending.extend_from_slice(data);
                            if pending.len() >= PTY_BATCH_THRESHOLD {
                                flush_pty_utf8(&app, &event_name, &mut pending, false);
                                timer_armed = false;
                                tokio::task::yield_now().await;
                            } else if !timer_armed {
                                flush_timer.as_mut().reset(tokio::time::Instant::now() + PTY_BATCH_INTERVAL);
                                timer_armed = true;
                            }
                        }
                        Some(ChannelMsg::Eof) | None => {
                            flush_pty_utf8(&app, &event_name, &mut pending, true);
                            let _ = app.emit(&closed_event_name, ());
                            break;
                        }
                        _ => {}
                    }
                }
                _ = &mut flush_timer, if timer_armed => {
                    flush_pty_utf8(&app, &event_name, &mut pending, false);
                    timer_armed = false;
                }
                cmd = rx.recv() => {
                    match cmd {
                        Some(PtyCommand::Input(bytes)) => {
                            if channel.data(&bytes[..]).await.is_err() {
                                flush_pty_utf8(&app, &event_name, &mut pending, true);
                                let _ = app.emit(&closed_event_name, ());
                                break;
                            }
                        }
                        Some(PtyCommand::Resize { cols, rows }) => {
                            let _ = channel.window_change(cols, rows, 0, 0).await;
                        }
                        None => {
                            flush_pty_utf8(&app, &event_name, &mut pending, true);
                            let _ = channel.close().await;
                            break;
                        }
                    }
                }
            }
        }
    });

    let mut sessions = state.sessions.lock().await;
    if let Some(sess) = sessions.get_mut(&session_id) {
        sess.pty_sender = Some(tx);
        sess.pty_task = Some(handle);
    } else {
        handle.abort();
    }

    Ok(())
}

#[tauri::command]
async fn write_ssh_pty(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    ensure_valid_id(&session_id, "de session")?;
    let tx_opt = {
        let sessions = state.sessions.lock().await;
        sessions.get(&session_id).and_then(|s| s.pty_sender.clone())
    };
    if let Some(tx) = tx_opt {
        tx.send(PtyCommand::Input(data.into_bytes()))
            .await
            .map_err(|e| e.to_string())?;
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
    ensure_valid_id(&session_id, "de session")?;
    let tx_opt = {
        let sessions = state.sessions.lock().await;
        sessions.get(&session_id).and_then(|s| s.pty_sender.clone())
    };
    if let Some(tx) = tx_opt {
        tx.send(PtyCommand::Resize { cols, rows })
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn list_remote_dir(
    session_id: String,
    app: AppHandle,
    path: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<FileEntry>, String> {
    ensure_valid_id(&session_id, "de session")?;
    let target_path = path.unwrap_or_else(|| "/".into());
    if !is_valid_remote_path(&target_path) {
        return Err("Chemin distant invalide".to_string());
    }

    let (protocol, sftp, ftp, ftp_cfg) = {
        let mut sessions = state.sessions.lock().await;
        let sess = sessions
            .get_mut(&session_id)
            .ok_or_else(|| "Session introuvable ou déconnectée".to_string())?;
        sess.current_remote_path = target_path.clone();
        (
            sess.protocol.clone(),
            sess.sftp.clone(),
            sess.ftp.clone(),
            sess.ftp_config.clone(),
        )
    };

    if protocol == "FTP" || protocol == "FTPS" {
        let ftp_arc = ftp.ok_or_else(|| "Session FTP/FTPS inactive".to_string())?;
        return tokio::task::spawn_blocking(move || {
            run_ftp_browsing(&ftp_arc, &ftp_cfg, |stream| {
                ftp::list_entries_blocking(stream, &target_path)
            })
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    let sftp = sftp.ok_or_else(|| "Session SFTP inactive".to_string())?;
    match sftp::list_entries_sftp(&sftp, &target_path).await {
        Ok(entries) => Ok(entries),
        Err(err) => {
            if sftp.canonicalize(".").await.is_err() {
                let _ = app.emit("sftp_session_lost", session_id.clone());
            }
            Err(err)
        }
    }
}

#[tauri::command]
async fn list_remote_subdirs(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    ensure_valid_id(&session_id, "de session")?;
    if !is_valid_remote_path(&path) {
        return Err("Chemin distant invalide".to_string());
    }
    let (protocol, sftp, ftp, ftp_cfg) = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(&session_id)
            .ok_or_else(|| "Session inactive".to_string())?;
        (
            sess.protocol.clone(),
            sess.sftp.clone(),
            sess.ftp.clone(),
            sess.ftp_config.clone(),
        )
    };

    if protocol == "FTP" || protocol == "FTPS" {
        let ftp_arc = ftp.ok_or_else(|| "Session FTP/FTPS inactive".to_string())?;
        return tokio::task::spawn_blocking(move || {
            run_ftp_browsing(&ftp_arc, &ftp_cfg, |stream| {
                let entries = ftp::list_entries_blocking(stream, &path)?;
                let mut dirs: Vec<String> = entries
                    .into_iter()
                    .filter(|e| e.is_dir)
                    .map(|e| e.name)
                    .collect();
                dirs.sort_by_cached_key(|a| a.to_lowercase());
                Ok(dirs)
            })
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    let sftp = sftp.ok_or_else(|| "Session SFTP inactive".to_string())?;
    sftp::list_subdirs_sftp(&sftp, &path).await
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
    ensure_valid_id(session_id, "de session")?;
    ensure_valid_id(transfer_id, "de transfert")?;
    if !is_valid_remote_path(remote_dest_dir) {
        return Err("Dossier distant de destination invalide".to_string());
    }

    let cancel_flag = state.get_or_create_cancel_token(transfer_id, session_id).await;
    if cancel_flag.load(Ordering::Relaxed) {
        return Err("Transfert annulé par l'utilisateur".to_string());
    }

    let (protocol, sftp, sftp_sem, ftp, ftp_pool, ftp_cfg) = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(session_id)
            .ok_or_else(|| "Session inactive".to_string())?;
        (
            sess.protocol.clone(),
            sess.sftp.clone(),
            sess.sftp_semaphore.clone(),
            sess.ftp.clone(),
            sess.ftp_pool.clone(),
            sess.ftp_config.clone(),
        )
    };

    let source = Path::new(local_path);
    let original_name = source
        .file_name()
        .ok_or_else(|| "Nom invalide".to_string())?
        .to_string_lossy();

    let target_name = dest_filename
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| original_name.to_string());

    if !is_valid_remote_filename(&target_name) {
        return Err("Nom de fichier de destination invalide".to_string());
    }

    if protocol == "FTP" || protocol == "FTPS" {
        let ftp_arc = ftp.ok_or_else(|| "Session FTP/FTPS inactive".to_string())?;
        let app_c = app.clone();
        let tid = transfer_id.to_string();
        let lpath = local_path.to_string();
        let rdir = remote_dest_dir.to_string();
        let tname = target_name.clone();
        let cancel_c = cancel_flag.clone();

        return tokio::task::spawn_blocking(move || {
            // Préférer une connexion FTP du pool (évite la contention et les handshakes répétés)
            if let Some(cfg) = ftp_cfg
                && let Ok(mut dedicated_ftp) = acquire_ftp_transfer_conn(&ftp_pool, &cfg)
            {
                let res = ftp::upload_item_blocking(
                    &mut dedicated_ftp,
                    &app_c,
                    &tid,
                    &lpath,
                    &rdir,
                    &tname,
                    cancel_c,
                );
                let ok = res.is_ok();
                release_ftp_transfer_conn(&ftp_pool, dedicated_ftp, ok);
                return res;
            }
            let mut ftp_guard = ftp_arc
                .lock()
                .map_err(|_| "Verrou FTP corrompu".to_string())?;
            ftp::upload_item_blocking(&mut ftp_guard, &app_c, &tid, &lpath, &rdir, &tname, cancel_c)
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    let sftp = sftp.ok_or_else(|| "Session SFTP inactive".to_string())?;
    let sftp_sem = sftp_sem.unwrap_or_else(|| Arc::new(Semaphore::new(8)));

    if source.is_dir() {
        let root_remote = format!("{}/{}", remote_dest_dir.trim_end_matches('/'), target_name);
        sftp::upload_dir_sftp(
            app,
            &sftp,
            &sftp_sem,
            cancel_flag,
            transfer_id,
            local_path,
            &root_remote,
        )
        .await?;
    } else {
        let _permit = sftp_sem
            .acquire()
            .await
            .map_err(|e| format!("Sémaphore SFTP fermé: {}", e))?;
        let remote_target = format!("{}/{}", remote_dest_dir.trim_end_matches('/'), target_name);
        sftp::upload_single_file_sftp(
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

struct DownloadRequest<'a> {
    session_id: &'a str,
    transfer_id: &'a str,
    remote_path: &'a str,
    local_dest_dir: &'a str,
    dest_filename: Option<String>,
    is_dir: bool,
}

async fn download_item_inner(
    app: &AppHandle,
    req: DownloadRequest<'_>,
    state: &AppState,
) -> Result<String, String> {
    ensure_valid_id(req.session_id, "de session")?;
    ensure_valid_id(req.transfer_id, "de transfert")?;
    if !is_valid_remote_path(req.remote_path) {
        return Err("Chemin distant invalide".to_string());
    }

    let cancel_flag = state
        .get_or_create_cancel_token(req.transfer_id, req.session_id)
        .await;
    if cancel_flag.load(Ordering::Relaxed) {
        return Err("Transfert annulé par l'utilisateur".to_string());
    }

    let (protocol, sftp, sftp_sem, ftp, ftp_pool, ftp_cfg) = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(req.session_id)
            .ok_or_else(|| "Session inactive".to_string())?;
        (
            sess.protocol.clone(),
            sess.sftp.clone(),
            sess.sftp_semaphore.clone(),
            sess.ftp.clone(),
            sess.ftp_pool.clone(),
            sess.ftp_config.clone(),
        )
    };

    #[cfg(windows)]
    let normalized_dest = req.local_dest_dir.trim().replace('/', "\\");
    #[cfg(not(windows))]
    let normalized_dest = req.local_dest_dir.trim().to_string();
    let base_dest = PathBuf::from(&normalized_dest);

    tokio::fs::create_dir_all(&base_dest).await.map_err(|e| {
        format!(
            "Dossier local inaccessible ({}): {}",
            base_dest.display(),
            e
        )
    })?;

    let raw_filename = remote_file_name(req.remote_path).unwrap_or("");
    let safe_filename = req
        .dest_filename
        .filter(|s| !s.trim().is_empty())
        .map(|s| sanitize_windows_filename(&s))
        .unwrap_or_else(|| sanitize_windows_filename(raw_filename));

    if protocol == "FTP" || protocol == "FTPS" {
        let ftp_arc = ftp.ok_or_else(|| "Session FTP/FTPS inactive".to_string())?;
        let app_c = app.clone();
        let tid = req.transfer_id.to_string();
        let rpath = req.remote_path.to_string();
        let safe_c = safe_filename.clone();
        let cancel_c = cancel_flag.clone();
        let is_dir = req.is_dir;

        return tokio::task::spawn_blocking(move || {
            if let Some(cfg) = ftp_cfg
                && let Ok(mut dedicated_ftp) = acquire_ftp_transfer_conn(&ftp_pool, &cfg)
            {
                let res = ftp::download_item_blocking(
                    &mut dedicated_ftp,
                    &app_c,
                    ftp::FtpDownloadArgs {
                        transfer_id: &tid,
                        remote_path: &rpath,
                        base_dest: &base_dest,
                        safe_filename: &safe_c,
                        is_dir,
                        cancel_flag: cancel_c,
                    },
                );
                let ok = res.is_ok();
                release_ftp_transfer_conn(&ftp_pool, dedicated_ftp, ok);
                return res;
            }
            let mut ftp_guard = ftp_arc
                .lock()
                .map_err(|_| "Verrou FTP corrompu".to_string())?;
            ftp::download_item_blocking(
                &mut ftp_guard,
                &app_c,
                ftp::FtpDownloadArgs {
                    transfer_id: &tid,
                    remote_path: &rpath,
                    base_dest: &base_dest,
                    safe_filename: &safe_c,
                    is_dir,
                    cancel_flag: cancel_c,
                },
            )
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    let sftp = sftp.ok_or_else(|| "Session SFTP inactive".to_string())?;
    let sftp_sem = sftp_sem.unwrap_or_else(|| Arc::new(Semaphore::new(8)));

    if req.is_dir {
        let root_local_dir = base_dest.join(&safe_filename);
        sftp::download_dir_sftp(
            app,
            &sftp,
            &sftp_sem,
            cancel_flag,
            req.transfer_id,
            req.remote_path,
            root_local_dir,
        )
        .await?;
    } else {
        let _permit = sftp_sem
            .acquire()
            .await
            .map_err(|e| format!("Sémaphore SFTP fermé: {}", e))?;
        let local_target = base_dest.join(&safe_filename);
        sftp::download_single_file_sftp(
            app,
            &sftp,
            &cancel_flag,
            req.transfer_id,
            req.remote_path,
            &local_target,
            None,
            None,
        )
        .await?;
    }

    Ok(safe_filename)
}

#[allow(clippy::too_many_arguments)]
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
        &app,
        DownloadRequest {
            session_id: &session_id,
            transfer_id: &transfer_id,
            remote_path: &remote_path,
            local_dest_dir: &local_dest_dir,
            dest_filename,
            is_dir,
        },
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
    ensure_valid_id(&session_id, "de session")?;
    if !is_valid_remote_path(&remote_path) {
        return Err("Chemin distant invalide".to_string());
    }
    let (protocol, sftp, ftp, ftp_cfg) = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(&session_id)
            .ok_or_else(|| "Session inactive".to_string())?;
        (
            sess.protocol.clone(),
            sess.sftp.clone(),
            sess.ftp.clone(),
            sess.ftp_config.clone(),
        )
    };

    if protocol == "FTP" || protocol == "FTPS" {
        let ftp_arc = ftp.ok_or_else(|| "Session FTP/FTPS inactive".to_string())?;
        return tokio::task::spawn_blocking(move || {
            run_ftp_browsing(&ftp_arc, &ftp_cfg, |stream| {
                ftp::read_text_bounded_blocking(stream, &remote_path)
            })
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    let sftp = sftp.ok_or_else(|| "Session SFTP inactive".to_string())?;
    sftp::read_text_sftp(&sftp, &remote_path).await
}

#[tauri::command]
async fn save_remote_file_text(
    session_id: String,
    remote_path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    ensure_valid_id(&session_id, "de session")?;
    if !is_valid_remote_path(&remote_path) {
        return Err("Chemin distant invalide".to_string());
    }
    let (protocol, sftp, ftp, ftp_cfg) = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(&session_id)
            .ok_or_else(|| "Session inactive".to_string())?;
        (
            sess.protocol.clone(),
            sess.sftp.clone(),
            sess.ftp.clone(),
            sess.ftp_config.clone(),
        )
    };

    if protocol == "FTP" || protocol == "FTPS" {
        let ftp_arc = ftp.ok_or_else(|| "Session FTP/FTPS inactive".to_string())?;
        return tokio::task::spawn_blocking(move || {
            run_ftp_browsing(&ftp_arc, &ftp_cfg, |stream| {
                ftp::save_text_blocking(stream, &remote_path, content.clone())
            })
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    let sftp = sftp.ok_or_else(|| "Session SFTP inactive".to_string())?;
    sftp::save_text_sftp(&sftp, &remote_path, &content).await
}

#[tauri::command]
async fn open_remote_with_system(
    session_id: String,
    remote_path: String,
    confirm_executable: Option<bool>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    ensure_valid_id(&session_id, "de session")?;
    if !is_valid_remote_path(&remote_path) {
        return Err("Chemin distant invalide".to_string());
    }
    let (protocol, sftp, ftp, ftp_pool, ftp_cfg) = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(&session_id)
            .ok_or_else(|| "Session inactive".to_string())?;
        (
            sess.protocol.clone(),
            sess.sftp.clone(),
            sess.ftp.clone(),
            sess.ftp_pool.clone(),
            sess.ftp_config.clone(),
        )
    };

    let raw_filename = remote_file_name(&remote_path)
        .ok_or_else(|| "Nom de fichier invalide".to_string())?;
    let safe_filename = sanitize_windows_filename(raw_filename);

    if is_dangerous_executable_filename(&safe_filename) && !confirm_executable.unwrap_or(false) {
        return Err(format!("EXECUTABLE_CONFIRM_REQUIRED|{}", safe_filename));
    }

    let temp_dir = local::pid_temp_root().join("preview").join(&session_id);
    let _ = fs::create_dir_all(&temp_dir);
    let mut local_temp_file = temp_dir.join(&safe_filename);
    if local_temp_file.exists()
        && fs::OpenOptions::new()
            .write(true)
            .open(&local_temp_file)
            .is_err()
    {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        local_temp_file = temp_dir.join(format!("{}_{}", ts, safe_filename));
    }

    if protocol == "FTP" || protocol == "FTPS" {
        let ftp_arc = ftp.ok_or_else(|| "Session FTP/FTPS inactive".to_string())?;
        let rpath = remote_path.clone();
        let lfile = local_temp_file.clone();
        tokio::task::spawn_blocking(move || {
            validate_ftp_arg(&rpath)?;
            let run_preview = |stream: &mut NativeTlsFtpStream| -> Result<(), String> {
                if let Ok(sz) = stream.size(&rpath)
                    && (sz as u64) > MAX_PREVIEW_BYTES
                {
                    return Err("Fichier trop volumineux (> 100 Mo) pour l'aperçu système. Utilisez le téléchargement standard.".to_string());
                }
                let mut file = fs::File::create(&lfile).map_err(|e| e.to_string())?;
                let mut written: u64 = 0;
                let mut chunk = [0u8; 64 * 1024];
                use std::io::Write;
                let res = stream.retr(&rpath, |data_stream| {
                    loop {
                        let n = data_stream
                            .read(&mut chunk)
                            .map_err(suppaftp::FtpError::ConnectionError)?;
                        if n == 0 {
                            break;
                        }
                        written += n as u64;
                        if written > MAX_PREVIEW_BYTES {
                            return Err(suppaftp::FtpError::ConnectionError(std::io::Error::new(
                                std::io::ErrorKind::InvalidData,
                                "PREVIEW_TOO_LARGE",
                            )));
                        }
                        file.write_all(&chunk[..n])
                            .map_err(suppaftp::FtpError::ConnectionError)?;
                    }
                    Ok(())
                });
                if let Err(e) = res {
                    drop(file);
                    let _ = fs::remove_file(&lfile);
                    let msg = e.to_string();
                    if msg.contains("PREVIEW_TOO_LARGE") {
                        return Err("Fichier trop volumineux (> 100 Mo) pour l'aperçu système. Utilisez le téléchargement standard.".to_string());
                    }
                    return Err(msg);
                }
                Ok(())
            };

            if let Some(cfg) = ftp_cfg
                && let Ok(mut dedicated) = acquire_ftp_transfer_conn(&ftp_pool, &cfg)
            {
                let res = run_preview(&mut dedicated);
                release_ftp_transfer_conn(&ftp_pool, dedicated, res.is_ok());
                return res;
            }
            let mut ftp_guard = ftp_arc
                .lock()
                .map_err(|_| "Verrou FTP corrompu".to_string())?;
            run_preview(&mut ftp_guard)
        })
        .await
        .map_err(|e| e.to_string())??;
    } else {
        let sftp = sftp.ok_or_else(|| "Session SFTP inactive".to_string())?;
        if let Ok(meta) = sftp.metadata(&remote_path).await
            && meta.size.unwrap_or(0) > MAX_PREVIEW_BYTES
        {
            return Err("Fichier trop volumineux (> 100 Mo) pour l'aperçu système. Utilisez le téléchargement standard.".to_string());
        }
        let mut remote_file = sftp.open(&remote_path).await.map_err(|e| e.to_string())?;
        let mut local_file = tokio::fs::File::create(&local_temp_file)
            .await
            .map_err(|e| e.to_string())?;

        let mut buffer = vec![0u8; 128 * 1024];
        let mut written: u64 = 0;
        loop {
            let n = remote_file
                .read(&mut buffer)
                .await
                .map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            written += n as u64;
            if written > MAX_PREVIEW_BYTES {
                drop(local_file);
                let _ = tokio::fs::remove_file(&local_temp_file).await;
                return Err("Fichier trop volumineux (> 100 Mo) pour l'aperçu système. Utilisez le téléchargement standard.".to_string());
            }
            local_file
                .write_all(&buffer[..n])
                .await
                .map_err(|e| e.to_string())?;
        }
        local_file.flush().await.map_err(|e| e.to_string())?;
    }

    let path_str = local_temp_file.to_string_lossy().to_string();
    tauri_plugin_opener::open_path(path_str.clone(), None::<&str>)
        .map_err(|e| format!("Erreur ouverture Windows: {}", e))?;

    Ok(path_str)
}

async fn exec_remote_command_inner(
    session_id: &str,
    command: &str,
    state: &AppState,
) -> Result<String, String> {
    ensure_valid_id(session_id, "de session")?;
    let ssh_arc = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(session_id)
            .ok_or_else(|| "Session inactive".to_string())?;

        sess.ssh_session.clone().ok_or_else(|| {
            "Session SSH inactive (FTP ne supporte pas l'exécution shell)".to_string()
        })?
    };

    sftp::exec_ssh_command(ssh_arc, command).await
}

#[tauri::command]
async fn chmod_remote(
    session_id: String,
    path: String,
    permissions: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    ensure_valid_id(&session_id, "de session")?;
    if !is_valid_remote_path(&path) {
        return Err("Chemin distant invalide".to_string());
    }
    let (protocol, sftp, ftp, ftp_cfg) = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(&session_id)
            .ok_or_else(|| "Session inactive".to_string())?;
        (
            sess.protocol.clone(),
            sess.sftp.clone(),
            sess.ftp.clone(),
            sess.ftp_config.clone(),
        )
    };

    if protocol == "FTP" || protocol == "FTPS" {
        let ftp_arc = ftp.ok_or_else(|| "Session FTP/FTPS inactive".to_string())?;
        return tokio::task::spawn_blocking(move || {
            validate_ftp_arg(&path)?;
            run_ftp_browsing(&ftp_arc, &ftp_cfg, |stream| {
                stream
                    .site(format!("CHMOD {:o} {}", permissions & 0o7777, path))
                    .map(|_| ())
                    .map_err(|e| format!("Erreur CHMOD FTP: {}", e))
            })
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    let sftp = sftp.ok_or_else(|| "Session SFTP inactive".to_string())?;
    let mut metadata = sftp.metadata(&path).await.map_err(|e| e.to_string())?;
    let old_mode = metadata.permissions.unwrap_or(0);
    let new_mode = (old_mode & !0o7777) | (permissions & 0o7777);
    metadata.permissions = Some(new_mode);
    sftp.set_metadata(&path, metadata)
        .await
        .map_err(|e| format!("Erreur CHMOD SFTP: {}", e))
}

#[tauri::command]
async fn rename_remote(
    session_id: String,
    old_path: String,
    new_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    ensure_valid_id(&session_id, "de session")?;
    if !is_valid_remote_path(&old_path) || !is_valid_remote_path(&new_path) {
        return Err("Chemin distant invalide".to_string());
    }
    let new_name = remote_file_name(&new_path)
        .ok_or_else(|| "Nom de destination invalide".to_string())?;
    if !is_valid_remote_filename(new_name) {
        return Err("Nom de destination distant invalide".to_string());
    }
    let (protocol, sftp, ftp, ftp_cfg) = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(&session_id)
            .ok_or_else(|| "Session inactive".to_string())?;
        (
            sess.protocol.clone(),
            sess.sftp.clone(),
            sess.ftp.clone(),
            sess.ftp_config.clone(),
        )
    };

    if protocol == "FTP" || protocol == "FTPS" {
        let ftp_arc = ftp.ok_or_else(|| "Session FTP/FTPS inactive".to_string())?;
        return tokio::task::spawn_blocking(move || {
            validate_ftp_arg(&old_path)?;
            validate_ftp_arg(&new_path)?;
            run_ftp_browsing(&ftp_arc, &ftp_cfg, |stream| {
                stream.rename(&old_path, &new_path).map_err(|e| e.to_string())
            })
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    let sftp = sftp.ok_or_else(|| "Session SFTP inactive".to_string())?;
    sftp.rename(old_path, new_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_remote(
    session_id: String,
    path: String,
    is_dir: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    ensure_valid_id(&session_id, "de session")?;
    if !is_valid_remote_path(&path) || path == "/" {
        return Err("Chemin distant invalide ou interdit".to_string());
    }
    let (protocol, sftp, ftp, ftp_cfg) = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(&session_id)
            .ok_or_else(|| "Session inactive".to_string())?;
        (
            sess.protocol.clone(),
            sess.sftp.clone(),
            sess.ftp.clone(),
            sess.ftp_config.clone(),
        )
    };

    if protocol == "FTP" || protocol == "FTPS" {
        let ftp_arc = ftp.ok_or_else(|| "Session FTP/FTPS inactive".to_string())?;
        return tokio::task::spawn_blocking(move || {
            validate_ftp_arg(&path)?;
            run_ftp_browsing(&ftp_arc, &ftp_cfg, |stream| {
                if is_dir {
                    ftp::remove_dir_recursive_ftp(stream, &path)
                } else {
                    stream.rm(&path).map_err(|e| e.to_string())
                }
            })
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    let sftp = sftp.ok_or_else(|| "Session SFTP inactive".to_string())?;
    if is_dir {
        sftp::remove_dir_recursive_sftp(&sftp, &path).await
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
    ensure_valid_id(&session_id, "de session")?;
    if !is_valid_remote_path(&path) {
        return Err("Chemin distant invalide".to_string());
    }
    let dir_name = remote_file_name(&path)
        .ok_or_else(|| "Nom de dossier distant invalide".to_string())?;
    if !is_valid_remote_filename(dir_name) {
        return Err("Nom de dossier distant invalide".to_string());
    }
    let (protocol, sftp, ftp, ftp_cfg) = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(&session_id)
            .ok_or_else(|| "Session inactive".to_string())?;
        (
            sess.protocol.clone(),
            sess.sftp.clone(),
            sess.ftp.clone(),
            sess.ftp_config.clone(),
        )
    };

    if protocol == "FTP" || protocol == "FTPS" {
        let ftp_arc = ftp.ok_or_else(|| "Session FTP/FTPS inactive".to_string())?;
        return tokio::task::spawn_blocking(move || {
            validate_ftp_arg(&path)?;
            run_ftp_browsing(&ftp_arc, &ftp_cfg, |stream| {
                stream.mkdir(&path).map_err(|e| e.to_string())
            })
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    let sftp = sftp.ok_or_else(|| "Session SFTP inactive".to_string())?;
    sftp.create_dir(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_remote_file(
    session_id: String,
    remote_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    ensure_valid_id(&session_id, "de session")?;
    if !is_valid_remote_path(&remote_path) {
        return Err("Chemin distant invalide".to_string());
    }
    let file_name = remote_file_name(&remote_path)
        .ok_or_else(|| "Nom de fichier distant invalide".to_string())?;
    if !is_valid_remote_filename(file_name) {
        return Err("Nom de fichier distant invalide".to_string());
    }
    let (protocol, sftp, ftp, ftp_cfg) = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(&session_id)
            .ok_or_else(|| "Session inactive".to_string())?;
        (
            sess.protocol.clone(),
            sess.sftp.clone(),
            sess.ftp.clone(),
            sess.ftp_config.clone(),
        )
    };

    if protocol == "FTP" || protocol == "FTPS" {
        let ftp_arc = ftp.ok_or_else(|| "Session FTP/FTPS inactive".to_string())?;
        let rpath = remote_path.clone();
        let fname = file_name.to_string();
        return tokio::task::spawn_blocking(move || {
            validate_ftp_arg(&rpath)?;
            run_ftp_browsing(&ftp_arc, &ftp_cfg, |stream| {
                if stream.size(&rpath).is_ok() {
                    return Err("Un élément portant ce nom existe déjà.".to_string());
                }
                let parent = rpath.rsplit_once('/').map(|(p, _)| if p.is_empty() { "/" } else { p }).unwrap_or("/");
                if let Ok(entries) = ftp::list_entries_blocking(stream, parent)
                    && entries.iter().any(|e| e.name.eq_ignore_ascii_case(&fname))
                {
                    return Err("Un élément portant ce nom existe déjà.".to_string());
                }
                let mut empty = std::io::Cursor::new(&[][..]);
                stream.put_file(&rpath, &mut empty).map_err(|e| e.to_string())?;
                Ok(())
            })
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    let sftp = sftp.ok_or_else(|| "Session SFTP inactive".to_string())?;
    if sftp.metadata(&remote_path).await.is_ok() {
        return Err("Un élément portant ce nom existe déjà.".to_string());
    }
    sftp::save_text_sftp(&sftp, &remote_path, "").await
}

#[tauri::command]
async fn compress_remote(
    session_id: String,
    parent_dir: String,
    item_name: String,
    format: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if !is_valid_remote_path(&parent_dir) || !is_valid_remote_filename(&item_name) {
        return Err("Caractères invalides ou chemin vide détecté".into());
    }
    if format != "zip" && format != "tar.gz" {
        return Err("Format d'archive non supporté".into());
    }

    let parent_esc = shell_escape(&parent_dir);
    let item_rel_esc = shell_escape(&format!("./{}", item_name));

    let (archive_name, cmd) = if format == "zip" {
        let zip_name = format!("{}.zip", item_name);
        let zip_esc = shell_escape(&format!("./{}", zip_name));
        (
            zip_name,
            format!("cd -- {} && zip -r -- {} {}", parent_esc, zip_esc, item_rel_esc),
        )
    } else {
        let tar_name = format!("{}.tar.gz", item_name);
        let tar_esc = shell_escape(&format!("./{}", tar_name));
        (
            tar_name,
            format!("cd -- {} && tar -czf {} -- {}", parent_esc, tar_esc, item_rel_esc),
        )
    };
    exec_remote_command_inner(&session_id, &cmd, &state).await?;
    Ok(archive_name)
}

fn extract_unzip_l_entry_name(trimmed: &str) -> Option<&str> {
    let mut space_groups = 0usize;
    let mut in_ws = false;
    for (idx, ch) in trimmed.char_indices() {
        if ch.is_whitespace() {
            if !in_ws {
                space_groups += 1;
                in_ws = true;
            }
        } else if in_ws {
            in_ws = false;
            if space_groups == 3 {
                return Some(&trimmed[idx..]);
            }
        }
    }
    None
}

#[tauri::command]
async fn extract_remote(
    session_id: String,
    parent_dir: String,
    archive_name: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    ensure_valid_id(&session_id, "de session")?;
    if !is_valid_remote_path(&parent_dir) || !is_valid_remote_filename(&archive_name) {
        return Err("Caractères invalides ou nom d'archive vide détecté".into());
    }

    let parent_esc = shell_escape(&parent_dir);
    let archive_rel_esc = shell_escape(&format!("./{}", archive_name));

    let cmd = if archive_name.ends_with(".zip") {
        // Pré-vérification anti Zip-Slip & symlinks avant extraction
        let list_cmd = format!(
            "cd -- {} && (unzip -Z1 -- {} 2>/dev/null || unzip -l -- {})",
            parent_esc, archive_rel_esc, archive_rel_esc
        );
        let listing = exec_remote_command_inner(&session_id, &list_cmd, &state).await?;
        let mut parsed_any = false;
        let mut saw_header_sep = false;
        let mut finished_table = false;
        for line in listing.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if trimmed.starts_with("Archive:") || trimmed.starts_with("Length") {
                continue;
            }
            if trimmed.starts_with("----") {
                if !saw_header_sep {
                    saw_header_sep = true;
                } else {
                    finished_table = true;
                }
                continue;
            }
            if finished_table {
                continue;
            }
            // Format `unzip -l` : "  1234  2026-01-01 12:00   dir/file.txt"
            let entry_name = if saw_header_sep {
                match extract_unzip_l_entry_name(trimmed) {
                    Some(name) => name,
                    None => continue,
                }
            } else {
                trimmed
            };
            parsed_any = true;
            if !local::is_safe_archive_entry(entry_name) {
                return Err(format!(
                    "Archive ZIP distante bloquée (chemin non sûr détecté : {})",
                    entry_name
                ));
            }
        }
        if !parsed_any {
            return Err("Impossible d'inspecter le contenu de l'archive ZIP distante.".to_string());
        }
        let zlist = exec_remote_command_inner(
            &session_id,
            &format!("cd -- {} && unzip -Z -- {}", parent_esc, archive_rel_esc),
            &state,
        )
        .await
        .map_err(|e| {
            format!(
                "Archive ZIP distante bloquée (impossible de vérifier les liens symboliques via unzip -Z : {})",
                e
            )
        })?;
        for line in zlist.lines() {
            let t = line.trim_start();
            if t.starts_with('l') || t.starts_with('h') {
                return Err(format!(
                    "Archive ZIP distante bloquée (lien détecté : {})",
                    t
                ));
            }
        }
        format!("cd -- {} && unzip -o -- {}", parent_esc, archive_rel_esc)
    } else if archive_name.ends_with(".tar.gz")
        || archive_name.ends_with(".tgz")
        || archive_name.ends_with(".tar")
    {
        let flag = if archive_name.ends_with(".tar") { "t" } else { "tz" };
        let list_cmd = format!("cd -- {} && tar -{}f {}", parent_esc, flag, archive_rel_esc);
        let listing = exec_remote_command_inner(&session_id, &list_cmd, &state).await?;
        for line in listing.lines() {
            if !line.trim().is_empty() && !local::is_safe_archive_entry(line) {
                return Err(format!(
                    "Archive distante bloquée (chemin non sûr détecté : {})",
                    line.trim()
                ));
            }
        }
        let vflag = if archive_name.ends_with(".tar") { "tv" } else { "tzv" };
        let vlist_cmd = format!("cd -- {} && tar -{}f {}", parent_esc, vflag, archive_rel_esc);
        let vlisting = exec_remote_command_inner(&session_id, &vlist_cmd, &state).await?;
        for line in vlisting.lines() {
            if !local::is_safe_tar_verbose_line(line) {
                return Err(format!(
                    "Archive distante bloquée (lien ou fichier spécial détecté : {})",
                    line.trim()
                ));
            }
        }
        let xflag = if archive_name.ends_with(".tar") { "-xf" } else { "-xzf" };
        format!(
            "cd -- {} && tar {} {} -C {}",
            parent_esc, xflag, archive_rel_esc, parent_esc
        )
    } else {
        return Err("Format d'archive non supporté".into());
    };
    exec_remote_command_inner(&session_id, &cmd, &state).await?;
    Ok("Archive extraite avec succès".into())
}

#[tauri::command]
async fn get_remote_size(
    session_id: String,
    remote_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    ensure_valid_id(&session_id, "de session")?;
    if !is_valid_remote_path(&remote_path) {
        return Err("Chemin distant invalide".to_string());
    }
    let (protocol, sftp, ftp, ftp_cfg) = {
        let sessions = state.sessions.lock().await;
        let sess = sessions
            .get(&session_id)
            .ok_or_else(|| "Session inactive".to_string())?;
        (
            sess.protocol.clone(),
            sess.sftp.clone(),
            sess.ftp.clone(),
            sess.ftp_config.clone(),
        )
    };

    if protocol == "SFTP" {
        let sftp = sftp.ok_or_else(|| "Session SFTP inactive".to_string())?;
        let meta = sftp.metadata(&remote_path).await.map_err(|e| e.to_string())?;
        if meta.is_dir() {
            let esc_path = shell_escape(&remote_path);
            let cmd = format!("du -sh -- {}", esc_path);
            let raw_res = exec_remote_command_inner(&session_id, &cmd, &state).await?;
            let size_only = raw_res
                .split_whitespace()
                .next()
                .unwrap_or(&raw_res)
                .to_string();
            Ok(size_only)
        } else {
            Ok(format_size_human(meta.size.unwrap_or(0)))
        }
    } else {
        let ftp_arc = ftp.ok_or_else(|| "Session FTP inactive".to_string())?;
        let size = tokio::task::spawn_blocking(move || {
            validate_ftp_arg(&remote_path)?;
            run_ftp_browsing(&ftp_arc, &ftp_cfg, |stream| {
                stream
                    .size(&remote_path)
                    .map(|s| s as u64)
                    .map_err(|e| e.to_string())
            })
        })
        .await
        .map_err(|e| e.to_string())??;
        Ok(format_size_human(size))
    }
}

fn format_size_human(bytes: u64) -> String {
    if bytes > 1024 * 1024 * 1024 {
        format!("{:.2} Go", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    } else if bytes > 1024 * 1024 {
        format!("{:.1} Mo", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes > 1024 {
        format!("{:.0} Ko", bytes as f64 / 1024.0)
    } else {
        format!("{} octets", bytes)
    }
}

fn cleanup_temp_workspace() {
    let base = local::pid_temp_root();
    let _ = fs::remove_dir_all(base);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    cleanup_temp_workspace();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            cancel_tokens: Arc::new(Mutex::new(HashMap::new())),
        })
        .invoke_handler(tauri::generate_handler![
            local::get_windows_drives,
            local::get_system_folders,
            local::read_local_dir,
            list_remote_subdirs,
            local::read_local_subdirs,
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
            local::delete_local,
            local::create_local_dir,
            local::create_local_file,
            delete_remote,
            create_remote_dir,
            create_remote_file,
            local::rename_local,
            rename_remote,
            chmod_remote,
            compress_remote,
            extract_remote,
            local::compress_local,
            local::extract_local,
            local::is_local_dir,
            get_remote_size,
            local::export_sites_to_path,
            local::get_temp_dir,
            security::read_legacy_vault_key_if_exists,
            security::delete_legacy_vault_key,
            security::load_vault_sites,
            security::save_vault_sites
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            let state = app_handle.state::<AppState>();
            tauri::async_runtime::block_on(async {
                state.cancel_all().await;
                let drained: Vec<ServerSession> = {
                    let mut sessions = state.sessions.lock().await;
                    sessions.drain().map(|(_, s)| s).collect()
                };
                for sess in drained {
                    cleanup_session_resources(sess).await;
                }
            });
            cleanup_temp_workspace();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_windows_filename() {
        assert_eq!(sanitize_windows_filename("CON"), "_CON");
        assert_eq!(sanitize_windows_filename("CONIN$"), "_CONIN$");
        assert_eq!(sanitize_windows_filename("nul.txt"), "_nul.txt");
        assert_eq!(sanitize_windows_filename(".."), "unnamed_file");
        assert_eq!(sanitize_windows_filename("...  "), "unnamed_file");
        assert_eq!(sanitize_windows_filename("a<b>c:d/e\\f|g?h*i"), "a_b_c_d_e_f_g_h_i");
        assert_eq!(sanitize_windows_filename("hello\x07\nworld"), "hello__world");
    }

    #[test]
    fn test_ftp_entry_parsing_and_traversal_defense() {
        let unix_line = "drwxr-xr-x 2 user group 4096 Nov 09 10:00 my  folder";
        let parsed = ftp::parse_ftp_entry(unix_line, "/var").unwrap();
        assert_eq!(parsed.name, "my  folder");
        assert!(parsed.is_dir);
        assert_eq!(parsed.path, "/var/my  folder");

        // Rejet d'un nom contenant .. ou /
        let malicious = "-rw-r--r-- 1 user group 123 Nov 09 10:00 ../../etc/passwd";
        assert!(ftp::parse_ftp_entry(malicious, "/var").is_none());

        let dos_line = "01-02-23 04:50PM <DIR> logs";
        let dos_parsed = ftp::parse_ftp_entry(dos_line, "/").unwrap();
        assert_eq!(dos_parsed.name, "logs");
        assert!(dos_parsed.is_dir);
    }

    #[test]
    fn test_validation_and_shell_escape() {
        assert!(validate_ftp_arg("/var/www/index.html").is_ok());
        assert!(validate_ftp_arg("/var/www\r\nDELE /etc/passwd").is_err());
        assert!(is_valid_remote_filename("archive.tar.gz"));
        assert!(!is_valid_remote_filename("../secret"));
        assert!(!is_valid_remote_filename("a/b"));
        assert!(!is_valid_remote_filename("bad\x01name"));
        assert!(is_valid_remote_path("/var/www/site"));
        assert!(!is_valid_remote_path("/var/www\nrm -rf /"));
        assert_eq!(shell_escape("it's a file"), "'it'\\''s a file'");
    }

    #[test]
    fn test_id_and_local_filename_and_archive_entry_validation() {
        assert!(is_valid_id("tab_1"));
        assert!(is_valid_id("550e8400-e29b-41d4-a716-446655440000"));
        assert!(!is_valid_id(""));
        assert!(!is_valid_id("../evil"));
        assert!(!is_valid_id("tab/1"));

        assert!(security::is_valid_local_filename("rapport-2026.pdf"));
        assert!(!security::is_valid_local_filename(".."));
        assert!(!security::is_valid_local_filename("sub/file.txt"));
        assert!(!security::is_valid_local_filename("sub\\file.txt"));
        assert!(!security::is_valid_local_filename("CON"));
        assert!(!security::is_valid_local_filename("file."));

        assert!(local::is_safe_archive_entry("dir/file.txt"));
        assert!(local::is_safe_archive_entry("./dir/file.txt"));
        assert!(!local::is_safe_archive_entry("../evil.txt"));
        assert!(!local::is_safe_archive_entry("dir/../../evil.txt"));
        assert!(!local::is_safe_archive_entry("/etc/passwd"));
        assert!(!local::is_safe_archive_entry("C:\\Windows\\System32\\cmd.exe"));
    }

    #[test]
    fn test_zeroize_bytes() {
        let mut secret = vec![0xAAu8; 32];
        security::zeroize_bytes(&mut secret);
        assert!(secret.iter().all(|&b| b == 0));
    }

    #[test]
    fn test_aes256_gcm_vault_roundtrip() {
        let key = [0x42u8; 32];
        let nonce = [0x11u8; 12];
        let payload = br#"[{"id":"1","password":"secret"}]"#;
        let encrypted = security::encrypt_vault_aes256_gcm(&key, &nonce, payload).unwrap();
        assert_ne!(&encrypted[12..], payload);
        let decrypted = security::decrypt_vault_aes256_gcm(&key, &encrypted).unwrap();
        assert_eq!(&decrypted[..], payload);

        let wrong_key = [0x99u8; 32];
        assert!(security::decrypt_vault_aes256_gcm(&wrong_key, &encrypted).is_err());
    }

    #[test]
    fn test_safe_local_delete_and_tar_verbose_and_ipv6() {
        assert!(!security::is_safe_local_delete_target(Path::new("C:")));
        assert!(!security::is_safe_local_delete_target(Path::new("/")));
        assert!(!security::is_safe_local_delete_target(Path::new("/Users/..")));
        assert!(security::is_safe_local_delete_target(Path::new("/Users/test/file.txt")));
        #[cfg(windows)]
        {
            assert!(!security::is_safe_local_delete_target(Path::new("C:\\")));
            assert!(!security::is_safe_local_delete_target(Path::new("C:\\Users\\..")));
            assert!(security::is_safe_local_delete_target(Path::new("C:\\Users\\test\\file.txt")));
        }

        assert!(local::is_safe_tar_verbose_line("-rw-r--r-- 0 user group 100 Jan 1 00:00 normal.txt"));
        assert!(local::is_safe_tar_verbose_line("drwxr-xr-x 0 user group 0 Jan 1 00:00 subdir"));
        assert!(!local::is_safe_tar_verbose_line("lrwxrwxrwx 0 user group 0 Jan 1 00:00 evil -> /etc/passwd"));
        assert!(!local::is_safe_tar_verbose_line("hrw-r--r-- 0 user group 0 Jan 1 00:00 evil link to C:\\Windows\\win.ini"));
        assert!(!local::is_safe_tar_verbose_line("crw-rw-rw- 0 root root 1, 3 Jan 1 00:00 null"));

        assert_eq!(security::remote_file_name("/var/www/index.html"), Some("index.html"));
        assert_eq!(security::remote_file_name("/var/www/..\\evil"), Some("..\\evil"));
        assert!(!security::is_valid_remote_filename("..\\evil"));
        assert_eq!(security::remote_file_name("/"), None);

        let mut used = std::collections::HashSet::new();
        let p1 = security::unique_local_child_path(Path::new("dest"), "Report.txt", &mut used);
        let p2 = security::unique_local_child_path(Path::new("dest"), "report.txt", &mut used);
        assert_ne!(p1.to_string_lossy().to_lowercase(), p2.to_string_lossy().to_lowercase());

        assert_eq!(ftp::format_host_port("::1", 21), "[::1]:21");
        assert_eq!(ftp::format_host_port("[::1]", 21), "[::1]:21");
        assert_eq!(ftp::format_host_port("192.168.1.10", 21), "192.168.1.10:21");
    }

    #[test]
    fn test_executable_after_sanitize_and_ads_and_unzip_parser() {
        assert!(security::is_dangerous_executable_filename("payload.exe "));
        assert!(security::is_dangerous_executable_filename("payload.exe."));
        assert!(security::is_dangerous_executable_filename("connect.rdp"));
        assert!(!security::is_dangerous_executable_filename("readme.txt"));

        assert!(!local::is_safe_archive_entry("readme.txt:evil.exe"));
        assert!(!security::is_safe_local_path_no_traversal(Path::new("/Users/../etc")));
        assert!(security::is_safe_local_path_no_traversal(Path::new("/Users/test/docs")));
        #[cfg(windows)]
        {
            assert!(!security::is_safe_local_path_no_traversal(Path::new("C:\\Users\\..\\Windows")));
            assert!(security::is_safe_local_path_no_traversal(Path::new("C:\\Users\\test\\docs")));
        }

        assert_eq!(
            extract_unzip_l_entry_name("1234  2026-01-01 12:00   dir/my file.txt"),
            Some("dir/my file.txt")
        );
    }
}

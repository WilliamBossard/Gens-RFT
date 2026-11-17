use russh::{ChannelMsg, client};
use russh_sftp::client::SftpSession;
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex, Semaphore};
use tokio::task::JoinSet;
use walkdir::WalkDir;

use crate::models::{FileEntry, RemoteTextFile, TransferProgress};
use crate::security::{ClientHandler, unique_local_child_path};

const MAX_EDITOR_BYTES: usize = 5 * 1024 * 1024;
const MAX_EXEC_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const EXEC_TIMEOUT: Duration = Duration::from_secs(120);
const SYMLINK_CONCURRENCY: usize = 16;
const FOLDER_TRANSFER_CONCURRENCY: usize = 4;

async fn resolve_symlink_dirs(
    sftp: &Arc<SftpSession>,
    symlink_paths: Vec<(usize, String)>,
) -> Vec<(usize, bool)> {
    if symlink_paths.is_empty() {
        return Vec::new();
    }
    let sem = Arc::new(Semaphore::new(SYMLINK_CONCURRENCY));
    let mut set = JoinSet::new();
    for (idx, path) in symlink_paths {
        let sftp_c = Arc::clone(sftp);
        let sem_c = Arc::clone(&sem);
        set.spawn(async move {
            let _permit = sem_c.acquire_owned().await.ok()?;
            let is_dir = match sftp_c.metadata(&path).await {
                Ok(meta) => meta.is_dir(),
                Err(_) => false,
            };
            Some((idx, is_dir))
        });
    }

    let mut results = Vec::new();
    while let Some(res) = set.join_next().await {
        if let Ok(Some(item)) = res {
            results.push(item);
        }
    }
    results
}

pub async fn list_entries_sftp(
    sftp: &Arc<SftpSession>,
    target_path: &str,
) -> Result<Vec<FileEntry>, String> {
    let dir = sftp
        .read_dir(target_path)
        .await
        .map_err(|e| format!("Erreur dossier: {}", e))?;

    let mut entries = Vec::new();
    let mut symlink_indices = Vec::new();

    for file in dir {
        let name = file.file_name();
        if name == "." || name == ".." {
            continue;
        }

        let full_path = if target_path.ends_with('/') {
            format!("{}{}", target_path, name)
        } else {
            format!("{}/{}", target_path, name)
        };

        let is_dir = file.file_type().is_dir();
        let is_symlink = file.file_type().is_symlink();
        let size = file.metadata().size.unwrap_or(0);
        let permissions = file.metadata().permissions;

        let idx = entries.len();
        entries.push(FileEntry {
            name,
            path: full_path.clone(),
            is_dir,
            size,
            permissions,
        });

        if is_symlink && !is_dir {
            symlink_indices.push((idx, full_path));
        }
    }

    for (idx, resolved_is_dir) in resolve_symlink_dirs(sftp, symlink_indices).await {
        if resolved_is_dir
            && let Some(entry) = entries.get_mut(idx)
        {
            entry.is_dir = true;
        }
    }

    entries.sort_by_cached_key(|e| (!e.is_dir, e.name.to_lowercase()));

    Ok(entries)
}

pub async fn list_subdirs_sftp(
    sftp: &Arc<SftpSession>,
    path: &str,
) -> Result<Vec<String>, String> {
    let dir = sftp
        .read_dir(path)
        .await
        .map_err(|e| format!("Erreur permission: {}", e))?;

    let mut dirs = Vec::new();
    let mut symlinks = Vec::new();

    for file in dir {
        let name = file.file_name();
        if name == "." || name == ".." {
            continue;
        }

        let full_path = if path.ends_with('/') {
            format!("{}{}", path, name)
        } else {
            format!("{}/{}", path, name)
        };

        if file.file_type().is_dir() {
            dirs.push(name);
        } else if file.file_type().is_symlink() {
            symlinks.push((name, full_path));
        }
    }

    if !symlinks.is_empty() {
        let indexed: Vec<(usize, String)> = symlinks
            .iter()
            .enumerate()
            .map(|(i, (_, p))| (i, p.clone()))
            .collect();
        for (idx, is_dir) in resolve_symlink_dirs(sftp, indexed).await {
            if is_dir
                && let Some((name, _)) = symlinks.get(idx)
            {
                dirs.push(name.clone());
            }
        }
    }

    dirs.sort_by_cached_key(|a| a.to_lowercase());
    Ok(dirs)
}

async fn atomic_replace_remote(
    sftp: &SftpSession,
    temp_path: &str,
    target_path: &str,
    unique_suffix: &str,
) -> Result<(), String> {
    if sftp.rename(temp_path, target_path).await.is_ok() {
        return Ok(());
    }

    let backup_path = format!("{}.gens_bak_{}", target_path, unique_suffix);
    let backed_up = sftp.rename(target_path, &backup_path).await.is_ok();

    match sftp.rename(temp_path, target_path).await {
        Ok(()) => {
            if backed_up {
                let _ = sftp.remove_file(&backup_path).await;
            }
            Ok(())
        }
        Err(e) => {
            if backed_up {
                let _ = sftp.rename(&backup_path, target_path).await;
            }
            let _ = sftp.remove_file(temp_path).await;
            Err(format!("Erreur finalisation fichier distant: {}", e))
        }
    }
}

pub async fn upload_single_file_sftp(
    app: &AppHandle,
    sftp: &SftpSession,
    cancel_flag: &AtomicBool,
    transfer_id: &str,
    local_path: &str,
    remote_path: &str,
    folder_progress: Option<(Arc<AtomicU64>, u64)>,
) -> Result<(), String> {
    let mut local_file = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| format!("Erreur ouverture {}: {}", local_path, e))?;

    let total_size = local_file.metadata().await.map(|m| m.len()).unwrap_or(0);
    let buf_cap = if total_size > 0 {
        (total_size as usize).clamp(4 * 1024, 256 * 1024)
    } else {
        256 * 1024
    };

    let unique_suffix = format!(
        "{}_{}",
        transfer_id,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let temp_remote_path = format!("{}.gens_part_{}", remote_path, unique_suffix);
    let mut remote_file = sftp
        .create(&temp_remote_path)
        .await
        .map_err(|e| format!("Erreur création distante: {}", e))?;

    let filename = Path::new(local_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let mut buffer = vec![0u8; buf_cap];
    let mut transferred: u64 = 0;
    let mut last_emit = Instant::now();

    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            let _ = remote_file.shutdown().await;
            drop(remote_file);
            let _ = sftp.remove_file(&temp_remote_path).await;
            return Err("Transfert annulé par l'utilisateur".to_string());
        }

        let n = match local_file.read(&mut buffer).await {
            Ok(bytes) => bytes,
            Err(e) => {
                let _ = remote_file.shutdown().await;
                drop(remote_file);
                let _ = sftp.remove_file(&temp_remote_path).await;
                return Err(format!("Erreur lecture locale: {}", e));
            }
        };

        if n == 0 {
            break;
        }

        if let Err(e) = remote_file.write_all(&buffer[..n]).await {
            let _ = remote_file.shutdown().await;
            drop(remote_file);
            let _ = sftp.remove_file(&temp_remote_path).await;
            return Err(format!("Erreur écriture distante: {}", e));
        }

        transferred += n as u64;

        let (emit_transferred, emit_total, percent) =
            if let Some((ref cum_atomic, folder_total)) = folder_progress {
                let current_cum = cum_atomic.fetch_add(n as u64, Ordering::Relaxed) + n as u64;
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

    if let Err(e) = remote_file.flush().await {
        let _ = remote_file.shutdown().await;
        drop(remote_file);
        let _ = sftp.remove_file(&temp_remote_path).await;
        return Err(format!("Erreur flush distante: {}", e));
    }
    let _ = remote_file.shutdown().await;
    drop(remote_file);

    atomic_replace_remote(sftp, &temp_remote_path, remote_path, &unique_suffix).await?;

    if folder_progress.is_none() {
        let _ = app.emit(
            "transfer_progress",
            TransferProgress {
                transfer_id: transfer_id.to_string(),
                filename,
                transferred: total_size,
                total: total_size,
                percent: 100.0,
                direction: "upload".into(),
            },
        );
    }

    Ok(())
}

async fn ensure_remote_dir(sftp: &SftpSession, path: &str) -> Result<(), String> {
    if let Err(e) = sftp.create_dir(path).await {
        if let Ok(meta) = sftp.metadata(path).await
            && meta.is_dir()
        {
            return Ok(());
        }
        return Err(format!("Impossible de créer le dossier distant ({}): {}", path, e));
    }
    Ok(())
}

pub async fn upload_dir_sftp(
    app: &AppHandle,
    sftp: &Arc<SftpSession>,
    session_sem: &Arc<Semaphore>,
    cancel_flag: Arc<AtomicBool>,
    transfer_id: &str,
    local_path: &str,
    root_remote: &str,
) -> Result<(), String> {
    ensure_remote_dir(sftp, root_remote).await?;

    let local_path_owned = local_path.to_string();
    let root_remote_owned = root_remote.to_string();
    let cancel_walk = Arc::clone(&cancel_flag);

    let (dirs_to_create, files_to_upload, total_folder_bytes) =
        tokio::task::spawn_blocking(move || {
            let mut dirs_to_create: Vec<String> = Vec::new();
            let mut files_to_upload: Vec<(PathBuf, String)> = Vec::new();
            let mut total_folder_bytes: u64 = 0;

            for entry_res in WalkDir::new(&local_path_owned) {
                if cancel_walk.load(Ordering::Relaxed) {
                    return Err("Transfert annulé par l'utilisateur".to_string());
                }
                let entry = entry_res.map_err(|e| format!("Erreur lecture locale: {}", e))?;
                // Ignorer les liens symboliques pour éviter toute fuite involontaire hors du dossier
                if entry.file_type().is_symlink() {
                    continue;
                }
                let rel = match entry.path().strip_prefix(&local_path_owned) {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                if rel_str.is_empty() {
                    continue;
                }

                let remote_target = format!("{}/{}", root_remote_owned, rel_str);
                if entry.file_type().is_dir() {
                    dirs_to_create.push(remote_target);
                } else {
                    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    total_folder_bytes = total_folder_bytes.saturating_add(size);
                    files_to_upload.push((entry.path().to_path_buf(), remote_target));
                }
            }
            Ok((dirs_to_create, files_to_upload, total_folder_bytes))
        })
        .await
        .map_err(|e| format!("Erreur parcours local: {}", e))??;

    // Création concurrente des dossiers par niveau de profondeur (parents avant enfants)
    let mut dirs_by_depth: BTreeMap<usize, Vec<String>> = BTreeMap::new();
    for dir_path in dirs_to_create {
        let depth = dir_path.matches('/').count();
        dirs_by_depth.entry(depth).or_default().push(dir_path);
    }
    for (_depth, level_dirs) in dirs_by_depth {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err("Transfert annulé par l'utilisateur".to_string());
        }
        let dir_queue = Arc::new(Mutex::new(VecDeque::from(level_dirs)));
        let worker_count = FOLDER_TRANSFER_CONCURRENCY.min(dir_queue.lock().await.len().max(1));
        let mut dir_set = JoinSet::new();
        for _ in 0..worker_count {
            let sftp_c = Arc::clone(sftp);
            let cancel_c = Arc::clone(&cancel_flag);
            let q_c = Arc::clone(&dir_queue);
            dir_set.spawn(async move {
                loop {
                    if cancel_c.load(Ordering::Relaxed) {
                        return Err("Transfert annulé par l'utilisateur".to_string());
                    }
                    let next_dir = { q_c.lock().await.pop_front() };
                    match next_dir {
                        Some(d) => ensure_remote_dir(&sftp_c, &d).await?,
                        None => return Ok(()),
                    }
                }
            });
        }
        while let Some(res) = dir_set.join_next().await {
            match res {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    dir_set.abort_all();
                    return Err(e);
                }
                Err(e) => {
                    dir_set.abort_all();
                    return Err(e.to_string());
                }
            }
        }
    }

    let cumulative = Arc::new(AtomicU64::new(0));
    let total_files = files_to_upload.len();
    let file_queue = Arc::new(Mutex::new(VecDeque::from(files_to_upload)));
    let worker_count = FOLDER_TRANSFER_CONCURRENCY.min(total_files.max(1));
    let mut join_set = JoinSet::new();

    for _ in 0..worker_count {
        let app_c = app.clone();
        let sftp_c = Arc::clone(sftp);
        let cancel_c = Arc::clone(&cancel_flag);
        let tid = transfer_id.to_string();
        let cum_c = Arc::clone(&cumulative);
        let session_sem_c = Arc::clone(session_sem);
        let q_c = Arc::clone(&file_queue);

        join_set.spawn(async move {
            let mut worker_errors = Vec::new();
            loop {
                if cancel_c.load(Ordering::Relaxed) {
                    return Err("Transfert annulé par l'utilisateur".to_string());
                }
                let next_file = { q_c.lock().await.pop_front() };
                let Some((local_file_path, remote_target)) = next_file else {
                    break;
                };

                let _session_permit = session_sem_c
                    .acquire()
                    .await
                    .map_err(|e| e.to_string())?;
                if cancel_c.load(Ordering::Relaxed) {
                    return Err("Transfert annulé par l'utilisateur".to_string());
                }
                if let Err(e) = upload_single_file_sftp(
                    &app_c,
                    &sftp_c,
                    &cancel_c,
                    &tid,
                    &local_file_path.to_string_lossy(),
                    &remote_target,
                    Some((Arc::clone(&cum_c), total_folder_bytes)),
                )
                .await
                {
                    if cancel_c.load(Ordering::Relaxed) {
                        return Err("Transfert annulé par l'utilisateur".to_string());
                    }
                    worker_errors.push(format!("{}: {}", remote_target, e));
                }
            }
            Ok(worker_errors)
        });
    }

    let mut upload_errors = Vec::new();
    while let Some(res) = join_set.join_next().await {
        match res {
            Ok(Ok(errs)) => upload_errors.extend(errs),
            Ok(Err(e)) => {
                if cancel_flag.load(Ordering::Relaxed) {
                    join_set.abort_all();
                    return Err("Transfert annulé par l'utilisateur".to_string());
                }
                upload_errors.push(e);
            }
            Err(e) if e.is_cancelled() => {}
            Err(e) => upload_errors.push(e.to_string()),
        }
    }

    if !upload_errors.is_empty() {
        let total_errs = upload_errors.len();
        let preview: Vec<_> = upload_errors.into_iter().take(5).collect();
        return Err(format!(
            "{} fichier(s) n'ont pas pu être uploadés : {}{}",
            total_errs,
            preview.join("; "),
            if total_errs > 5 { " (...)" } else { "" }
        ));
    }

    let folder_name = Path::new(local_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let _ = app.emit(
        "transfer_progress",
        TransferProgress {
            transfer_id: transfer_id.to_string(),
            filename: folder_name,
            transferred: total_folder_bytes,
            total: total_folder_bytes,
            percent: 100.0,
            direction: "upload".into(),
        },
    );

    Ok(())
}

async fn atomic_replace_local_async(
    temp_path: &Path,
    target_path: &Path,
    unique_suffix: &str,
) -> Result<(), String> {
    if !target_path.exists() {
        if let Err(e) = tokio::fs::rename(temp_path, target_path).await {
            let _ = tokio::fs::remove_file(temp_path).await;
            return Err(format!("Erreur finalisation locale: {}", e));
        }
        return Ok(());
    }

    let backup_path = match target_path.file_name() {
        Some(name) => target_path.with_file_name(format!(
            "{}.gens_bak_{}",
            name.to_string_lossy(),
            unique_suffix
        )),
        None => {
            let _ = tokio::fs::remove_file(temp_path).await;
            return Err("Chemin local cible invalide".to_string());
        }
    };

    if let Err(e) = tokio::fs::rename(target_path, &backup_path).await {
        let _ = tokio::fs::remove_file(temp_path).await;
        return Err(format!(
            "Impossible de préparer le remplacement du fichier local existant: {}",
            e
        ));
    }

    match tokio::fs::rename(temp_path, target_path).await {
        Ok(()) => {
            let _ = tokio::fs::remove_file(&backup_path).await;
            Ok(())
        }
        Err(e) => {
            let _ = tokio::fs::rename(&backup_path, target_path).await;
            let _ = tokio::fs::remove_file(temp_path).await;
            Err(format!("Erreur finalisation locale: {}", e))
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn download_single_file_sftp(
    app: &AppHandle,
    sftp: &SftpSession,
    cancel_flag: &AtomicBool,
    transfer_id: &str,
    remote_path: &str,
    local_path: &Path,
    known_size: Option<u64>,
    folder_progress: Option<(Arc<AtomicU64>, u64)>,
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

    let total_size = match known_size {
        Some(s) => s,
        None => match sftp.metadata(remote_path).await {
            Ok(m) => m.size.unwrap_or(0),
            Err(_) => remote_file
                .metadata()
                .await
                .map(|m| m.size.unwrap_or(0))
                .unwrap_or(0),
        },
    };

    let buf_cap = if total_size > 0 {
        (total_size as usize).clamp(4 * 1024, 256 * 1024)
    } else {
        256 * 1024
    };

    let unique_suffix = format!(
        "{}_{}",
        transfer_id,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let temp_local_file = match local_path.file_name() {
        Some(name) => {
            local_path.with_file_name(format!("{}.gens_part_{}", name.to_string_lossy(), unique_suffix))
        }
        None => local_path.to_path_buf(),
    };

    let local_raw = tokio::fs::File::create(&temp_local_file)
        .await
        .map_err(|e| format!("Erreur création locale ({}): {}", local_path.display(), e))?;
    let mut local_file = tokio::io::BufWriter::with_capacity(buf_cap, local_raw);

    let filename = local_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let mut buffer = vec![0u8; buf_cap];
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

        let (emit_transferred, emit_total, percent) =
            if let Some((ref cum_atomic, folder_total)) = folder_progress {
                let current_cum = cum_atomic.fetch_add(n as u64, Ordering::Relaxed) + n as u64;
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

    local_file
        .flush()
        .await
        .map_err(|e| format!("Erreur flush local: {}", e))?;
    drop(local_file);

    atomic_replace_local_async(&temp_local_file, local_path, &unique_suffix).await?;

    if folder_progress.is_none() {
        let _ = app.emit(
            "transfer_progress",
            TransferProgress {
                transfer_id: transfer_id.to_string(),
                filename,
                transferred: total_size,
                total: total_size,
                percent: 100.0,
                direction: "download".into(),
            },
        );
    }

    Ok(())
}

pub async fn download_dir_sftp(
    app: &AppHandle,
    sftp: &Arc<SftpSession>,
    session_sem: &Arc<Semaphore>,
    cancel_flag: Arc<AtomicBool>,
    transfer_id: &str,
    remote_path: &str,
    root_local_dir: PathBuf,
) -> Result<(), String> {
    tokio::fs::create_dir_all(&root_local_dir)
        .await
        .map_err(|e| e.to_string())?;

    let mut files_to_download: Vec<(String, PathBuf, u64)> = Vec::new();
    let mut total_folder_bytes: u64 = 0;

    let mut visited = HashSet::new();
    let mut used_local_paths = HashSet::new();
    let root_canon = sftp
        .canonicalize(remote_path)
        .await
        .unwrap_or_else(|_| remote_path.to_string());
    visited.insert(root_canon);
    let mut queue = vec![(remote_path.to_string(), root_local_dir.clone(), 0usize)];

    while let Some((rem_dir, loc_dir, depth)) = queue.pop() {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err("Transfert annulé par l'utilisateur".to_string());
        }
        if depth > 40 {
            continue;
        }

        let dir = sftp
            .read_dir(&rem_dir)
            .await
            .map_err(|e| format!("Erreur lecture dossier distant {}: {}", rem_dir, e))?;

        for item in dir {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err("Transfert annulé par l'utilisateur".to_string());
            }
            let sub_name = item.file_name();
            if sub_name == "." || sub_name == ".." {
                continue;
            }
            let sub_rem = format!("{}/{}", rem_dir.trim_end_matches('/'), sub_name);
            let sub_loc = unique_local_child_path(&loc_dir, &sub_name, &mut used_local_paths);

            let mut is_sub_dir = item.file_type().is_dir();
            let mut visit_key = sub_rem.clone();
            if item.file_type().is_symlink()
                && let Ok(target_meta) = sftp.metadata(&sub_rem).await
                && target_meta.is_dir()
            {
                let canon = sftp
                    .canonicalize(&sub_rem)
                    .await
                    .unwrap_or_else(|_| sub_rem.clone());
                if !visited.contains(&canon) {
                    is_sub_dir = true;
                    visit_key = canon;
                }
            }

            if is_sub_dir {
                if visited.insert(visit_key) {
                    tokio::fs::create_dir_all(&sub_loc)
                        .await
                        .map_err(|e| format!("Impossible de créer {}: {}", sub_loc.display(), e))?;
                    queue.push((sub_rem, sub_loc, depth + 1));
                }
            } else {
                let size = item.metadata().size.unwrap_or(0);
                total_folder_bytes = total_folder_bytes.saturating_add(size);
                files_to_download.push((sub_rem, sub_loc, size));
            }
        }
    }

    let cumulative = Arc::new(AtomicU64::new(0));
    let total_files = files_to_download.len();
    let file_queue = Arc::new(Mutex::new(VecDeque::from(files_to_download)));
    let worker_count = FOLDER_TRANSFER_CONCURRENCY.min(total_files.max(1));
    let mut join_set = JoinSet::new();

    for _ in 0..worker_count {
        let app_c = app.clone();
        let sftp_c = Arc::clone(sftp);
        let cancel_c = Arc::clone(&cancel_flag);
        let tid = transfer_id.to_string();
        let cum_c = Arc::clone(&cumulative);
        let session_sem_c = Arc::clone(session_sem);
        let q_c = Arc::clone(&file_queue);

        join_set.spawn(async move {
            let mut worker_errors = Vec::new();
            loop {
                if cancel_c.load(Ordering::Relaxed) {
                    return Err("Transfert annulé par l'utilisateur".to_string());
                }
                let next_file = { q_c.lock().await.pop_front() };
                let Some((sub_rem, sub_loc, file_size)) = next_file else {
                    break;
                };

                let _session_permit = session_sem_c
                    .acquire()
                    .await
                    .map_err(|e| e.to_string())?;
                if cancel_c.load(Ordering::Relaxed) {
                    return Err("Transfert annulé par l'utilisateur".to_string());
                }
                if let Err(e) = download_single_file_sftp(
                    &app_c,
                    &sftp_c,
                    &cancel_c,
                    &tid,
                    &sub_rem,
                    &sub_loc,
                    Some(file_size),
                    Some((Arc::clone(&cum_c), total_folder_bytes)),
                )
                .await
                {
                    if cancel_c.load(Ordering::Relaxed) {
                        return Err("Transfert annulé par l'utilisateur".to_string());
                    }
                    worker_errors.push(format!("{}: {}", sub_rem, e));
                }
            }
            Ok(worker_errors)
        });
    }

    let mut download_errors = Vec::new();
    while let Some(res) = join_set.join_next().await {
        match res {
            Ok(Ok(errs)) => download_errors.extend(errs),
            Ok(Err(e)) => {
                if cancel_flag.load(Ordering::Relaxed) {
                    join_set.abort_all();
                    return Err("Transfert annulé par l'utilisateur".to_string());
                }
                download_errors.push(e);
            }
            Err(e) if e.is_cancelled() => {}
            Err(e) => download_errors.push(e.to_string()),
        }
    }

    if !download_errors.is_empty() {
        let total_errs = download_errors.len();
        let preview: Vec<_> = download_errors.into_iter().take(5).collect();
        return Err(format!(
            "{} fichier(s) n'ont pas pu être téléchargés : {}{}",
            total_errs,
            preview.join("; "),
            if total_errs > 5 { " (...)" } else { "" }
        ));
    }

    let folder_name = root_local_dir
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let _ = app.emit(
        "transfer_progress",
        TransferProgress {
            transfer_id: transfer_id.to_string(),
            filename: folder_name,
            transferred: total_folder_bytes,
            total: total_folder_bytes,
            percent: 100.0,
            direction: "download".into(),
        },
    );

    Ok(())
}

pub async fn read_text_sftp(sftp: &SftpSession, remote_path: &str) -> Result<RemoteTextFile, String> {
    if let Ok(meta) = sftp.metadata(remote_path).await
        && meta.size.unwrap_or(0) > MAX_EDITOR_BYTES as u64
    {
        return Err("Fichier trop volumineux (> 5 Mo) pour l'éditeur intégré.".to_string());
    }

    let remote_file = sftp.open(remote_path).await.map_err(|e| e.to_string())?;
    let mut limited = remote_file.take((MAX_EDITOR_BYTES + 1) as u64);
    let mut buffer = Vec::new();
    limited
        .read_to_end(&mut buffer)
        .await
        .map_err(|e| e.to_string())?;

    if buffer.len() > MAX_EDITOR_BYTES {
        return Err("Fichier trop volumineux (> 5 Mo) pour l'éditeur intégré.".to_string());
    }

    if buffer.contains(&0) {
        return Err("Le fichier est un binaire (caractères nuls détectés). Impossible de l'ouvrir dans l'éditeur de texte.".to_string());
    }

    let is_lossy = std::str::from_utf8(&buffer).is_err();
    let content = String::from_utf8_lossy(&buffer).to_string();
    Ok(RemoteTextFile { content, is_lossy })
}

pub async fn save_text_sftp(
    sftp: &SftpSession,
    remote_path: &str,
    content: &str,
) -> Result<(), String> {
    let unique_suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .to_string();
    let temp_path = format!("{}.gens_save_{}", remote_path, unique_suffix);

    let mut remote_file = sftp.create(&temp_path).await.map_err(|e| e.to_string())?;
    if let Err(e) = remote_file.write_all(content.as_bytes()).await {
        let _ = remote_file.shutdown().await;
        drop(remote_file);
        let _ = sftp.remove_file(&temp_path).await;
        return Err(e.to_string());
    }
    if let Err(e) = remote_file.flush().await {
        let _ = remote_file.shutdown().await;
        drop(remote_file);
        let _ = sftp.remove_file(&temp_path).await;
        return Err(e.to_string());
    }
    let _ = remote_file.shutdown().await;
    drop(remote_file);

    atomic_replace_remote(sftp, &temp_path, remote_path, &unique_suffix).await
}

pub async fn remove_dir_recursive_sftp(
    sftp: &SftpSession,
    root_path: &str,
) -> Result<(), String> {
    if root_path.trim().is_empty() || root_path == "/" {
        return Err("Refus de supprimer la racine du serveur".to_string());
    }
    fn delete_sftp_dir<'a>(
        sftp: &'a SftpSession,
        path: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            let dir = sftp
                .read_dir(path)
                .await
                .map_err(|e| format!("Erreur lecture {}: {}", path, e))?;
            for item in dir {
                let name = item.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                let child_path = if path.ends_with('/') {
                    format!("{}{}", path, name)
                } else {
                    format!("{}/{}", path, name)
                };
                if item.file_type().is_symlink() {
                    sftp.remove_file(&child_path)
                        .await
                        .map_err(|e| format!("Erreur suppression lien {}: {}", child_path, e))?;
                } else if item.file_type().is_dir() {
                    delete_sftp_dir(sftp, &child_path).await?;
                } else {
                    sftp.remove_file(&child_path)
                        .await
                        .map_err(|e| format!("Erreur suppression {}: {}", child_path, e))?;
                }
            }
            sftp.remove_dir(path).await.map_err(|e| e.to_string())
        })
    }
    delete_sftp_dir(sftp, root_path).await
}

pub async fn exec_ssh_command(
    ssh_arc: Arc<Mutex<client::Handle<ClientHandler>>>,
    command: &str,
) -> Result<String, String> {
    let mut channel = {
        let session = tokio::time::timeout(Duration::from_secs(15), ssh_arc.lock())
            .await
            .map_err(|_| "Timeout verrou session SSH".to_string())?;
        tokio::time::timeout(Duration::from_secs(15), session.channel_open_session())
            .await
            .map_err(|_| "Timeout ouverture canal SSH".to_string())?
            .map_err(|e| format!("Impossible d'ouvrir un canal SSH : {}", e))?
    };

    tokio::time::timeout(Duration::from_secs(15), channel.exec(true, command.as_bytes()))
        .await
        .map_err(|_| "Timeout lancement commande SSH".to_string())?
        .map_err(|e| format!("Erreur exécution commande : {}", e))?;

    let mut output = Vec::new();
    let mut exit_status: Option<u32> = None;

    let read_res = tokio::time::timeout(EXEC_TIMEOUT, async {
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { ref data } | ChannelMsg::ExtendedData { ref data, .. } => {
                    let remaining = MAX_EXEC_OUTPUT_BYTES.saturating_sub(output.len());
                    if remaining > 0 {
                        let take = remaining.min(data.len());
                        output.extend_from_slice(&data[..take]);
                    }
                }
                ChannelMsg::ExitStatus { exit_status: status } => {
                    exit_status = Some(status);
                }
                ChannelMsg::Eof => break,
                _ => {}
            }
        }
    })
    .await;

    if read_res.is_err() {
        let _ = channel.close().await;
        return Err("Timeout d'exécution de la commande distante (120s)".to_string());
    }

    let out_str = String::from_utf8_lossy(&output).trim().to_string();
    if let Some(status) = exit_status
        && status != 0
    {
        let msg = if out_str.is_empty() {
            format!("Commande échouée avec le code de sortie {}", status)
        } else {
            format!("Échec (code {}): {}", status, out_str)
        };
        return Err(msg);
    }

    Ok(out_str)
}

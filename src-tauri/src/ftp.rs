use std::collections::HashSet;
use std::fs;
use std::io::{BufReader, BufWriter, Cursor, Read, Write};
use std::net::ToSocketAddrs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use suppaftp::native_tls::TlsConnector;
use suppaftp::{NativeTlsConnector, NativeTlsFtpStream};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use crate::models::{FileEntry, RemoteTextFile, TransferProgress};
use crate::security::{
    is_valid_remote_filename, unique_local_child_path, validate_ftp_arg,
};
use crate::state::FtpSessionConfig;

const FTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const FTP_IO_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_EDITOR_BYTES: usize = 5 * 1024 * 1024;

pub fn parse_ftp_entry(line: &str, target_path: &str) -> Option<FileEntry> {
    let trimmed = line.trim();
    if trimmed.is_empty()
        || trimmed
            .get(..6)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("total "))
    {
        return None;
    }

    let parts: Vec<&str> = trimmed.split_whitespace().collect();

    // 1. Format Unix prioritaire (ProFTPD, vsftpd, Pure-FTPd)
    if parts.len() >= 9
        && (trimmed.starts_with('d') || trimmed.starts_with('-') || trimmed.starts_with('l'))
    {
        let mut is_dir = trimmed.starts_with('d');
        let size = parts[4].parse::<u64>().unwrap_or(0);

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

        if !is_safe_ftp_entry_name(&name) {
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

    // 2. Format DOS (Windows IIS FTP)
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
            if !is_safe_ftp_entry_name(&name) {
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

    // 3. Fallback simple (nlst)
    let is_dir = trimmed.ends_with('/');
    let trimmed_no_slash = trimmed.trim_end_matches('/');
    let name = trimmed_no_slash
        .rsplit('/')
        .next()
        .unwrap_or(trimmed_no_slash)
        .to_string();
    if !is_safe_ftp_entry_name(&name) {
        return None;
    }
    let full_path = format!("{}/{}", target_path.trim_end_matches('/'), name);
    Some(FileEntry {
        name,
        path: full_path,
        is_dir,
        size: 0,
        permissions: None,
    })
}

fn is_safe_ftp_entry_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', '\0', '\r', '\n'])
}

pub fn format_host_port(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{}]:{}", host, port)
    } else {
        format!("{}:{}", host, port)
    }
}

pub fn connect_ftp_blocking(
    protocol: &str,
    host: &str,
    port: u16,
    username: &str,
    password: &str,
    accept_invalid_certs: bool,
) -> Result<NativeTlsFtpStream, String> {
    validate_ftp_arg(host)?;
    validate_ftp_arg(username)?;

    let addr_str = format_host_port(host, port);
    let sock_addrs: Vec<_> = addr_str
        .to_socket_addrs()
        .map_err(|e| format!("Résolution DNS {} échouée: {}", addr_str, e))?
        .collect();
    if sock_addrs.is_empty() {
        return Err(format!("Aucune adresse résolue pour {}", addr_str));
    }

    let mut last_err = None;
    let mut stream_opt = None;
    for sock in sock_addrs {
        match NativeTlsFtpStream::connect_timeout(sock, FTP_CONNECT_TIMEOUT) {
            Ok(s) => {
                stream_opt = Some(s);
                break;
            }
            Err(e) => {
                last_err = Some(e);
            }
        }
    }

    let mut ftp = match stream_opt {
        Some(s) => s,
        None => {
            return Err(format!(
                "Erreur TCP {}: {}",
                protocol,
                last_err
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "connexion impossible".into())
            ));
        }
    };

    let _ = ftp.get_ref().set_read_timeout(Some(FTP_IO_TIMEOUT));
    let _ = ftp.get_ref().set_write_timeout(Some(FTP_IO_TIMEOUT));

    if protocol == "FTPS" {
        let connector = TlsConnector::builder()
            .danger_accept_invalid_certs(accept_invalid_certs)
            .build()
            .map_err(|e| format!("Erreur configuration TLS: {}", e))?;
        let tls_connector = NativeTlsConnector::from(connector);
        ftp = ftp.into_secure(tls_connector, host).map_err(|e| {
            let msg = e.to_string();
            if !accept_invalid_certs {
                format!("FTPS_CERT_ERROR|{}", msg)
            } else {
                format!("Échec négociation TLS (FTPS): {}", msg)
            }
        })?;
        let _ = ftp.get_ref().set_read_timeout(Some(FTP_IO_TIMEOUT));
        let _ = ftp.get_ref().set_write_timeout(Some(FTP_IO_TIMEOUT));
    }

    ftp.login(username, password)
        .map_err(|e| format!("Auth {} rejetée: {}", protocol, e))?;
    ftp.transfer_type(suppaftp::types::FileType::Binary)
        .map_err(|e| format!("Erreur activation mode binaire {}: {}", protocol, e))?;

    Ok(ftp)
}

pub fn connect_from_config(cfg: &FtpSessionConfig) -> Result<NativeTlsFtpStream, String> {
    connect_ftp_blocking(
        &cfg.protocol,
        &cfg.host,
        cfg.port,
        &cfg.username,
        &cfg.password,
        cfg.accept_invalid_certs,
    )
}

pub fn list_entries_blocking(
    ftp: &mut NativeTlsFtpStream,
    target_path: &str,
) -> Result<Vec<FileEntry>, String> {
    validate_ftp_arg(target_path)?;
    let lines = match ftp.list(Some(target_path)) {
        Ok(l) => l,
        Err(_) => ftp.nlst(Some(target_path)).map_err(|e| e.to_string())?,
    };

    let mut entries = Vec::new();
    for line in lines {
        if let Some(entry) = parse_ftp_entry(&line, target_path) {
            entries.push(entry);
        }
    }

    entries.sort_by_cached_key(|e| (!e.is_dir, e.name.to_lowercase()));

    Ok(entries)
}

struct ProgressRead<'a, R: Read> {
    inner: R,
    app: &'a AppHandle,
    transfer_id: &'a str,
    filename: &'a str,
    base_transferred: u64,
    total: u64,
    file_transferred: u64,
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
        self.file_transferred += n as u64;
        let cumulative = self.base_transferred + self.file_transferred;

        if self.last_emit.elapsed().as_millis() >= 100
            || (self.total > 0 && cumulative >= self.total)
        {
            let percent = if self.total > 0 {
                ((cumulative as f64 / self.total as f64) * 100.0).min(99.9) as f32
            } else {
                0.0
            };

            let _ = self.app.emit(
                "transfer_progress",
                TransferProgress {
                    transfer_id: self.transfer_id.to_string(),
                    filename: self.filename.to_string(),
                    transferred: cumulative,
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
    base_transferred: u64,
    total: u64,
    file_transferred: u64,
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
        self.file_transferred += n as u64;
        let cumulative = self.base_transferred + self.file_transferred;

        if self.last_emit.elapsed().as_millis() >= 100
            || (self.total > 0 && cumulative >= self.total)
        {
            let percent = if self.total > 0 {
                ((cumulative as f64 / self.total as f64) * 100.0).min(99.9) as f32
            } else {
                0.0
            };

            let _ = self.app.emit(
                "transfer_progress",
                TransferProgress {
                    transfer_id: self.transfer_id.to_string(),
                    filename: self.filename.to_string(),
                    transferred: cumulative,
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

fn unique_nanos_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

fn atomic_replace_remote_ftp(
    ftp: &mut NativeTlsFtpStream,
    temp_path: &str,
    remote_path: &str,
    unique_suffix: &str,
) -> Result<(), String> {
    if ftp.rename(temp_path, remote_path).is_ok() {
        return Ok(());
    }

    // Fallback si le serveur FTP interdit rename sur un fichier existant
    let backup_path = format!("{}.gens_bak_{}", remote_path, unique_suffix);
    let backed_up = ftp.rename(remote_path, backup_path.as_str()).is_ok();
    match ftp.rename(temp_path, remote_path) {
        Ok(()) => {
            if backed_up {
                let _ = ftp.rm(&backup_path);
            }
            Ok(())
        }
        Err(e) => {
            if backed_up {
                let _ = ftp.rename(backup_path.as_str(), remote_path);
            }
            let _ = ftp.rm(temp_path);
            Err(format!("Erreur finalisation fichier FTP: {}", e))
        }
    }
}

fn atomic_replace_local_blocking(
    temp_path: &Path,
    target_path: &Path,
    unique_suffix: &str,
) -> Result<(), String> {
    if !target_path.exists() {
        if let Err(e) = fs::rename(temp_path, target_path) {
            let _ = fs::remove_file(temp_path);
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
            let _ = fs::remove_file(temp_path);
            return Err("Chemin local cible invalide".to_string());
        }
    };

    if let Err(e) = fs::rename(target_path, &backup_path) {
        let _ = fs::remove_file(temp_path);
        return Err(format!(
            "Impossible de préparer le remplacement du fichier local existant: {}",
            e
        ));
    }

    match fs::rename(temp_path, target_path) {
        Ok(()) => {
            let _ = fs::remove_file(&backup_path);
            Ok(())
        }
        Err(e) => {
            let _ = fs::rename(&backup_path, target_path);
            let _ = fs::remove_file(temp_path);
            Err(format!("Erreur finalisation locale: {}", e))
        }
    }
}

pub fn upload_item_blocking(
    ftp: &mut NativeTlsFtpStream,
    app: &AppHandle,
    transfer_id: &str,
    local_path: &str,
    remote_dest_dir: &str,
    target_name: &str,
    cancel_flag: Arc<AtomicBool>,
) -> Result<String, String> {
    validate_ftp_arg(remote_dest_dir)?;
    validate_ftp_arg(target_name)?;
    if !is_valid_remote_filename(target_name) {
        return Err("Nom de fichier distant invalide".to_string());
    }

    let source = Path::new(local_path);
    if source.is_dir() {
        let root_remote = format!("{}/{}", remote_dest_dir.trim_end_matches('/'), target_name);
        validate_ftp_arg(&root_remote)?;
        let _ = ftp.mkdir(&root_remote);

        let mut dirs_to_create: Vec<String> = Vec::new();
        let mut files_to_upload: Vec<(PathBuf, String, u64)> = Vec::new();
        let mut total_folder_bytes: u64 = 0;

        for entry_res in WalkDir::new(local_path) {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err("Transfert annulé par l'utilisateur".to_string());
            }
            let entry = entry_res.map_err(|e| format!("Erreur lecture locale: {}", e))?;
            if entry.file_type().is_symlink() {
                continue;
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
            validate_ftp_arg(&remote_target)?;

            if entry.file_type().is_dir() {
                dirs_to_create.push(remote_target);
            } else {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                total_folder_bytes = total_folder_bytes.saturating_add(size);
                files_to_upload.push((entry.path().to_path_buf(), remote_target, size));
            }
        }

        for dir in dirs_to_create {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err("Transfert annulé par l'utilisateur".to_string());
            }
            let _ = ftp.mkdir(&dir);
        }

        let mut cumulative_bytes: u64 = 0;
        for (file_path, remote_target, file_size) in files_to_upload {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err("Transfert annulé par l'utilisateur".to_string());
            }
            let file = fs::File::open(&file_path).map_err(|e| e.to_string())?;
            let filename = file_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let buf_cap = (file_size as usize).clamp(4 * 1024, 128 * 1024);

            let mut progress_reader = ProgressRead {
                inner: BufReader::with_capacity(buf_cap, file),
                app,
                transfer_id,
                filename: &filename,
                base_transferred: cumulative_bytes,
                total: total_folder_bytes,
                file_transferred: 0,
                last_emit: Instant::now(),
                cancel_flag: cancel_flag.clone(),
            };

            let unique_suffix = format!("{}_{}", transfer_id, unique_nanos_suffix());
            let temp_remote = format!("{}.gens_part_{}", remote_target, unique_suffix);
            if let Err(e) = ftp.put_file(&temp_remote, &mut progress_reader) {
                let _ = ftp.rm(&temp_remote);
                return Err(format!("Erreur upload FTP {}: {}", filename, e));
            }
            atomic_replace_remote_ftp(ftp, &temp_remote, &remote_target, &unique_suffix)?;
            cumulative_bytes += progress_reader.file_transferred;
        }

        let _ = app.emit(
            "transfer_progress",
            TransferProgress {
                transfer_id: transfer_id.to_string(),
                filename: target_name.to_string(),
                transferred: total_folder_bytes,
                total: total_folder_bytes,
                percent: 100.0,
                direction: "upload".into(),
            },
        );
    } else {
        let remote_target = format!("{}/{}", remote_dest_dir.trim_end_matches('/'), target_name);
        validate_ftp_arg(&remote_target)?;

        let file = fs::File::open(local_path).map_err(|e| e.to_string())?;
        let total_size = file.metadata().map(|m| m.len()).unwrap_or(0);
        let buf_cap = if total_size > 0 {
            (total_size as usize).clamp(4 * 1024, 128 * 1024)
        } else {
            128 * 1024
        };

        let mut progress_reader = ProgressRead {
            inner: BufReader::with_capacity(buf_cap, file),
            app,
            transfer_id,
            filename: target_name,
            base_transferred: 0,
            total: total_size,
            file_transferred: 0,
            last_emit: Instant::now(),
            cancel_flag: cancel_flag.clone(),
        };

        let unique_suffix = format!("{}_{}", transfer_id, unique_nanos_suffix());
        let temp_remote = format!("{}.gens_part_{}", remote_target, unique_suffix);
        if let Err(e) = ftp.put_file(&temp_remote, &mut progress_reader) {
            let _ = ftp.rm(&temp_remote);
            return Err(format!("Erreur upload FTP: {}", e));
        }
        atomic_replace_remote_ftp(ftp, &temp_remote, &remote_target, &unique_suffix)?;

        let _ = app.emit(
            "transfer_progress",
            TransferProgress {
                transfer_id: transfer_id.to_string(),
                filename: target_name.to_string(),
                transferred: total_size,
                total: total_size,
                percent: 100.0,
                direction: "upload".into(),
            },
        );
    }

    Ok("Upload FTP terminé".into())
}

struct FtpFileDownload<'a> {
    remote_path: &'a str,
    local_target: &'a Path,
    display_name: &'a str,
    base_transferred: u64,
    total_progress: u64,
    buffer: &'a mut [u8],
}

fn download_single_file_ftp_atomic(
    ftp: &mut NativeTlsFtpStream,
    app: &AppHandle,
    transfer_id: &str,
    req: FtpFileDownload<'_>,
    cancel_flag: Arc<AtomicBool>,
) -> Result<u64, String> {
    validate_ftp_arg(req.remote_path)?;
    if let Some(parent) = req.local_target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let unique_suffix = format!("{}_{}", transfer_id, unique_nanos_suffix());
    let temp_local_file = match req.local_target.file_name() {
        Some(name) => req.local_target.with_file_name(format!(
            "{}.gens_part_{}",
            name.to_string_lossy(),
            unique_suffix
        )),
        None => req.local_target.to_path_buf(),
    };

    let file = fs::File::create(&temp_local_file).map_err(|e| e.to_string())?;
    let mut progress_writer = ProgressWrite {
        inner: BufWriter::with_capacity(128 * 1024, file),
        app,
        transfer_id,
        filename: req.display_name,
        base_transferred: req.base_transferred,
        total: req.total_progress,
        file_transferred: 0,
        last_emit: Instant::now(),
        cancel_flag,
    };

    let retr_res = ftp.retr(req.remote_path, |stream| {
        loop {
            let n = stream
                .read(req.buffer)
                .map_err(suppaftp::FtpError::ConnectionError)?;
            if n == 0 {
                break;
            }
            progress_writer
                .write_all(&req.buffer[..n])
                .map_err(suppaftp::FtpError::ConnectionError)?;
        }
        Ok(())
    });

    if let Err(e) = retr_res {
        drop(progress_writer);
        let _ = fs::remove_file(&temp_local_file);
        return Err(format!("Erreur download FTP: {}", e));
    }

    if let Err(e) = progress_writer.flush() {
        drop(progress_writer);
        let _ = fs::remove_file(&temp_local_file);
        return Err(format!("Erreur flush fichier local: {}", e));
    }
    let bytes_written = progress_writer.file_transferred;
    drop(progress_writer);

    atomic_replace_local_blocking(&temp_local_file, req.local_target, &unique_suffix)?;

    Ok(bytes_written)
}

pub struct FtpDownloadArgs<'a> {
    pub transfer_id: &'a str,
    pub remote_path: &'a str,
    pub base_dest: &'a Path,
    pub safe_filename: &'a str,
    pub is_dir: bool,
    pub cancel_flag: Arc<AtomicBool>,
}

pub fn download_item_blocking(
    ftp: &mut NativeTlsFtpStream,
    app: &AppHandle,
    args: FtpDownloadArgs<'_>,
) -> Result<String, String> {
    validate_ftp_arg(args.remote_path)?;
    let mut shared_buf = vec![0u8; 128 * 1024];

    if args.is_dir {
        let root_local_dir = args.base_dest.join(args.safe_filename);
        fs::create_dir_all(&root_local_dir).map_err(|e| e.to_string())?;

        let mut visited = HashSet::new();
        visited.insert(args.remote_path.to_string());
        let mut used_local_paths = HashSet::new();
        let mut queue = vec![(args.remote_path.to_string(), root_local_dir, 0usize)];
        let mut files_to_download: Vec<(String, PathBuf, String)> = Vec::new();
        let mut total_folder_bytes: u64 = 0;

        while let Some((rem_dir, loc_dir, depth)) = queue.pop() {
            if args.cancel_flag.load(Ordering::Relaxed) {
                return Err("Transfert annulé par l'utilisateur".to_string());
            }
            if depth > 40 {
                continue;
            }

            let lines = match ftp.list(Some(&rem_dir)) {
                Ok(l) => l,
                Err(e) => ftp.nlst(Some(&rem_dir)).map_err(|_| {
                    format!("Erreur lecture dossier FTP {}: {}", rem_dir, e)
                })?,
            };

            for line in lines {
                if let Some(item) = parse_ftp_entry(&line, &rem_dir) {
                    let sub_loc = unique_local_child_path(&loc_dir, &item.name, &mut used_local_paths);
                    if item.is_dir {
                        if visited.insert(item.path.clone()) {
                            fs::create_dir_all(&sub_loc).map_err(|e| {
                                format!("Impossible de créer {}: {}", sub_loc.display(), e)
                            })?;
                            queue.push((item.path, sub_loc, depth + 1));
                        }
                    } else {
                        total_folder_bytes = total_folder_bytes.saturating_add(item.size);
                        files_to_download.push((item.path, sub_loc, item.name));
                    }
                }
            }
        }

        let mut cumulative_bytes: u64 = 0;
        for (rem_file, loc_file, display_name) in files_to_download {
            if args.cancel_flag.load(Ordering::Relaxed) {
                return Err("Transfert annulé par l'utilisateur".to_string());
            }
            let written = download_single_file_ftp_atomic(
                ftp,
                app,
                args.transfer_id,
                FtpFileDownload {
                    remote_path: &rem_file,
                    local_target: &loc_file,
                    display_name: &display_name,
                    base_transferred: cumulative_bytes,
                    total_progress: total_folder_bytes,
                    buffer: &mut shared_buf,
                },
                args.cancel_flag.clone(),
            )?;
            cumulative_bytes += written;
        }

        let _ = app.emit(
            "transfer_progress",
            TransferProgress {
                transfer_id: args.transfer_id.to_string(),
                filename: args.safe_filename.to_string(),
                transferred: total_folder_bytes,
                total: total_folder_bytes,
                percent: 100.0,
                direction: "download".into(),
            },
        );
    } else {
        let local_target = args.base_dest.join(args.safe_filename);
        let total_size = ftp.size(args.remote_path).unwrap_or(0) as u64;
        let filename = local_target
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        let written = download_single_file_ftp_atomic(
            ftp,
            app,
            args.transfer_id,
            FtpFileDownload {
                remote_path: args.remote_path,
                local_target: &local_target,
                display_name: &filename,
                base_transferred: 0,
                total_progress: total_size,
                buffer: &mut shared_buf,
            },
            args.cancel_flag,
        )?;

        let final_total = if total_size > 0 { total_size } else { written };
        let _ = app.emit(
            "transfer_progress",
            TransferProgress {
                transfer_id: args.transfer_id.to_string(),
                filename,
                transferred: final_total,
                total: final_total,
                percent: 100.0,
                direction: "download".into(),
            },
        );
    }

    Ok(args.safe_filename.to_string())
}

pub fn read_text_bounded_blocking(
    ftp: &mut NativeTlsFtpStream,
    remote_path: &str,
) -> Result<RemoteTextFile, String> {
    validate_ftp_arg(remote_path)?;

    if let Ok(size) = ftp.size(remote_path)
        && size > MAX_EDITOR_BYTES
    {
        return Err("Fichier trop volumineux (> 5 Mo) pour l'éditeur intégré.".to_string());
    }

    let mut buffer = Vec::new();
    let res = ftp.retr(remote_path, |stream| {
        let mut chunk = vec![0u8; 32 * 1024];
        loop {
            let n = stream
                .read(&mut chunk)
                .map_err(suppaftp::FtpError::ConnectionError)?;
            if n == 0 {
                break;
            }
            if buffer.len() + n > MAX_EDITOR_BYTES {
                return Err(suppaftp::FtpError::ConnectionError(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "TOO_LARGE",
                )));
            }
            buffer.extend_from_slice(&chunk[..n]);
        }
        Ok(())
    });

    if let Err(e) = res {
        let msg = e.to_string();
        if msg.contains("TOO_LARGE") {
            return Err("Fichier trop volumineux (> 5 Mo) pour l'éditeur intégré.".to_string());
        }
        return Err(msg);
    }

    if buffer.contains(&0) {
        return Err("Le fichier est un binaire (caractères nuls détectés). Impossible de l'ouvrir dans l'éditeur de texte.".to_string());
    }

    let is_lossy = std::str::from_utf8(&buffer).is_err();
    let content = String::from_utf8_lossy(&buffer).to_string();
    Ok(RemoteTextFile { content, is_lossy })
}

pub fn save_text_blocking(
    ftp: &mut NativeTlsFtpStream,
    remote_path: &str,
    content: String,
) -> Result<(), String> {
    validate_ftp_arg(remote_path)?;
    let unique_suffix = unique_nanos_suffix().to_string();
    let temp_path = format!("{}.gens_save_{}", remote_path, unique_suffix);

    let mut cursor = Cursor::new(content.into_bytes());
    if let Err(e) = ftp.put_file(&temp_path, &mut cursor) {
        let _ = ftp.rm(&temp_path);
        return Err(format!("Erreur écriture temporaire FTP: {}", e));
    }

    atomic_replace_remote_ftp(ftp, &temp_path, remote_path, &unique_suffix)
}

pub fn remove_dir_recursive_ftp(
    ftp: &mut NativeTlsFtpStream,
    path: &str,
) -> Result<(), String> {
    fn inner(
        ftp: &mut NativeTlsFtpStream,
        path: &str,
        visited: &mut HashSet<String>,
        depth: usize,
    ) -> Result<(), String> {
        if depth > 40 {
            return Err("Profondeur maximale atteinte lors de la suppression FTP".to_string());
        }
        validate_ftp_arg(path)?;
        if path.trim().is_empty() || path == "/" {
            return Err("Refus de supprimer la racine du serveur".to_string());
        }
        if !visited.insert(path.to_string()) {
            return Ok(());
        }
        let lines = match ftp.list(Some(path)) {
            Ok(l) => l,
            Err(e) => ftp.nlst(Some(path)).map_err(|_| e.to_string())?,
        };
        for line in lines {
            if let Some(entry) = parse_ftp_entry(&line, path) {
                if entry.is_dir {
                    inner(ftp, &entry.path, visited, depth + 1)?;
                } else {
                    ftp.rm(&entry.path).map_err(|e| {
                        format!("Impossible de supprimer {}: {}", entry.path, e)
                    })?;
                }
            }
        }
        ftp.rmdir(path).map_err(|e| e.to_string())
    }

    let mut visited = HashSet::new();
    inner(ftp, path, &mut visited, 0)
}

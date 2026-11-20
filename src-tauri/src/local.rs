use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;

use crate::models::FileEntry;
use crate::security::{
    ensure_safe_local_browse_path, ensure_safe_local_path, is_safe_local_delete_target,
    is_symlink_or_reparse_path, is_valid_local_filename,
};

#[cfg(windows)]
unsafe extern "system" {
    fn GetLogicalDrives() -> u32;
}

#[tauri::command]
pub fn get_windows_drives() -> Vec<String> {
    #[cfg(windows)]
    {
        let mut drives = Vec::new();
        let mask = unsafe { GetLogicalDrives() };
        for i in 0..26 {
            if (mask & (1 << i)) != 0 {
                let letter = (b'A' + i) as char;
                drives.push(format!("{}:\\", letter));
            }
        }
        if drives.is_empty() {
            drives.push("C:\\".to_string());
        }
        drives
    }
    #[cfg(not(windows))]
    {
        vec!["/".to_string()]
    }
}

#[tauri::command]
pub fn get_system_folders() -> HashMap<String, String> {
    let mut map = HashMap::new();
    let home_dir = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    if let Some(base) = home_dir {
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
pub async fn read_local_dir(path: Option<String>) -> Result<Vec<FileEntry>, String> {
    if let Some(ref p) = path
        && !p.trim().is_empty()
    {
        ensure_safe_local_browse_path(p)?;
    }
    tokio::task::spawn_blocking(move || {
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

        entries.sort_by_cached_key(|e| (!e.is_dir, e.name.to_lowercase()));

        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn read_local_subdirs(path: String) -> Result<Vec<String>, String> {
    ensure_safe_local_browse_path(&path)?;
    tokio::task::spawn_blocking(move || {
        let p = Path::new(&path);
        if !p.is_dir() {
            return Ok(Vec::new());
        }
        let mut dirs = Vec::new();
        if let Ok(entries) = fs::read_dir(p) {
            for entry in entries.flatten() {
                if let Ok(m) = entry.metadata()
                    && m.is_dir()
                {
                    dirs.push(entry.file_name().to_string_lossy().to_string());
                }
            }
        }
        dirs.sort_by_cached_key(|a| a.to_lowercase());
        Ok(dirs)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn rename_local(old_path: String, new_path: String) -> Result<(), String> {
    ensure_safe_local_path(&old_path)?;
    ensure_safe_local_path(&new_path)?;
    let new_name = Path::new(&new_path)
        .file_name()
        .ok_or_else(|| "Nom de destination invalide".to_string())?
        .to_string_lossy();
    if !is_valid_local_filename(&new_name) {
        return Err("Nom de fichier ou dossier invalide".to_string());
    }
    fs::rename(old_path, new_path).map_err(|e| e.to_string())
}

fn make_writable(path: &Path) {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return;
    };
    if metadata.file_type().is_symlink() || is_symlink_or_reparse_path(path) {
        return;
    }
    let perms = metadata.permissions();
    if perms.readonly() {
        #[cfg(windows)]
        {
            let mut perms = perms;
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            let _ = fs::set_permissions(path, perms);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = perms.mode() | 0o200;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
        }
    }
}

#[tauri::command]
pub async fn delete_local(path: String, is_dir: bool) -> Result<(), String> {
    ensure_safe_local_path(&path)?;
    tokio::task::spawn_blocking(move || {
        let p = Path::new(&path);
        if !is_safe_local_delete_target(p) {
            return Err("Refus de supprimer la racine du système ou du volume".to_string());
        }
        if is_symlink_or_reparse_path(p) {
            #[cfg(windows)]
            if is_dir {
                return fs::remove_dir(p).map_err(|e| e.to_string());
            }
            return fs::remove_file(p)
                .or_else(|_| fs::remove_dir(p))
                .map_err(|e| e.to_string());
        }
        if is_dir {
            for entry in WalkDir::new(p)
                .follow_links(false)
                .into_iter()
                .filter_map(|e| e.ok())
            {
                make_writable(entry.path());
            }
            make_writable(p);
            fs::remove_dir_all(p).map_err(|e| e.to_string())
        } else {
            make_writable(p);
            fs::remove_file(p).map_err(|e| e.to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn create_local_dir(path: String) -> Result<(), String> {
    ensure_safe_local_path(&path)?;
    let dir_name = Path::new(&path)
        .file_name()
        .ok_or_else(|| "Nom de dossier invalide".to_string())?
        .to_string_lossy();
    if !is_valid_local_filename(&dir_name) {
        return Err("Nom de dossier invalide".to_string());
    }
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_local_file(path: String) -> Result<(), String> {
    ensure_safe_local_path(&path)?;
    let file_name = Path::new(&path)
        .file_name()
        .ok_or_else(|| "Nom de fichier invalide".to_string())?
        .to_string_lossy();
    if !is_valid_local_filename(&file_name) {
        return Err("Nom de fichier invalide".to_string());
    }
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Err("Un élément portant ce nom existe déjà.".to_string())
        }
        Err(e) => Err(format!("Impossible de créer le fichier: {}", e)),
    }
}

#[tauri::command]
pub fn is_local_dir(path: String) -> bool {
    if ensure_safe_local_browse_path(&path).is_err() {
        return false;
    }
    Path::new(&path).is_dir()
}

pub fn is_safe_archive_entry(entry: &str) -> bool {
    let trimmed = entry.trim_end_matches(['\r', '\n']);
    if trimmed.is_empty() || trimmed.contains('\0') || trimmed.contains(':') {
        return false;
    }
    if trimmed.starts_with('/') || trimmed.starts_with('\\') {
        return false;
    }
    let normalized = trimmed.replace('\\', "/");
    for comp in Path::new(&normalized).components() {
        match comp {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return false,
            Component::Normal(_) | Component::CurDir => {}
        }
    }
    true
}

pub(crate) fn is_symlink_or_reparse(file_type: &fs::FileType, path: &Path) -> bool {
    if file_type.is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if let Ok(meta) = fs::symlink_metadata(path)
            && (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0
        {
            return true;
        }
    }
    #[cfg(not(windows))]
    let _ = path;
    false
}

fn unique_archive_path(parent: &Path, base_name: &str, ext: &str) -> PathBuf {
    let first = parent.join(format!("{}.{}", base_name, ext));
    if !first.exists() {
        return first;
    }
    let mut counter = 2usize;
    loop {
        let candidate = parent.join(format!("{} ({}).{}", base_name, counter, ext));
        if !candidate.exists() {
            return candidate;
        }
        counter += 1;
    }
}

#[tauri::command]
pub async fn compress_local(path: String, format: String) -> Result<String, String> {
    ensure_safe_local_path(&path)?;
    let fmt_lower = format.to_lowercase();
    let ext = match fmt_lower.as_str() {
        "zip" => "zip",
        "tar.gz" | "tgz" => "tar.gz",
        _ => return Err("Format d'archive local non supporté".to_string()),
    };

    tokio::task::spawn_blocking(move || {
        let p = Path::new(&path);
        if is_symlink_or_reparse_path(p) {
            return Err("Refus de compresser un lien symbolique ou junction.".to_string());
        }
        if !p.exists() {
            return Err("Élément local introuvable.".to_string());
        }
        let name = p
            .file_name()
            .ok_or("Chemin invalide")?
            .to_string_lossy()
            .to_string();
        let parent = p.parent().unwrap_or(Path::new("."));
        let archive_path = unique_archive_path(parent, &name, ext);

        if ext == "zip" {
            crate::archive::create_zip_archive(p, &archive_path)?;
        } else {
            crate::archive::create_tar_gz_archive(p, &archive_path)?;
        }

        Ok(archive_path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn is_safe_tar_verbose_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    if trimmed.is_empty() {
        return true;
    }
    // Dans `tar -tvf`, seul '-' (fichier régulier) ou 'd' (dossier) est autorisé.
    // Rejeter 'l' (symlink), 'h' (hardlink), 'c'/'b'/'p'/'s' (périphériques/FIFO/sockets).
    let first = trimmed.chars().next().unwrap_or('-');
    first == '-' || first == 'd'
}

pub(crate) fn move_dir_contents_safe(src_dir: &Path, dst_dir: &Path) -> Result<(), String> {
    let entries = fs::read_dir(src_dir).map_err(|e| format!("Erreur lecture staging: {}", e))?;
    for entry_res in entries {
        let entry = entry_res.map_err(|e| format!("Erreur entrée staging: {}", e))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Erreur type entrée staging: {}", e))?;
        let src_path = entry.path();
        if is_symlink_or_reparse(&file_type, &src_path) {
            return Err(
                "Lien symbolique ou junction détecté après extraction, opération annulée."
                    .to_string(),
            );
        }
        let name = entry.file_name();
        let dst_path = dst_dir.join(&name);

        if file_type.is_dir() {
            if dst_path.exists() {
                if !dst_path.is_dir() {
                    return Err(format!(
                        "Conflit à l'extraction : {} existe déjà en tant que fichier.",
                        dst_path.display()
                    ));
                }
                move_dir_contents_safe(&src_path, &dst_path)?;
                let _ = fs::remove_dir(&src_path);
            } else {
                fs::rename(&src_path, &dst_path).map_err(|e| {
                    format!("Erreur déplacement dossier {}: {}", dst_path.display(), e)
                })?;
            }
        } else {
            if dst_path.exists() {
                if dst_path.is_dir() {
                    return Err(format!(
                        "Conflit à l'extraction : {} existe déjà en tant que dossier.",
                        dst_path.display()
                    ));
                }
                fs::remove_file(&dst_path).map_err(|e| {
                    format!("Impossible de remplacer {}: {}", dst_path.display(), e)
                })?;
            }
            fs::rename(&src_path, &dst_path)
                .map_err(|e| format!("Erreur déplacement fichier {}: {}", dst_path.display(), e))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn extract_local(path: String) -> Result<String, String> {
    ensure_safe_local_path(&path)?;
    if path.trim() == "-" {
        return Err("Chemin d'archive invalide".to_string());
    }
    tokio::task::spawn_blocking(move || {
        crate::archive::extract_archive_blocking(Path::new(&path))?;
        Ok("Archive locale extraite".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn pid_temp_root() -> PathBuf {
    std::env::temp_dir()
        .join("Gens-RFT")
        .join(format!("pid_{}", std::process::id()))
}

pub fn cleanup_stale_temp_workspaces() {
    let root = std::env::temp_dir().join("Gens-RFT");
    let current_pid_name = format!("pid_{}", std::process::id());
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    let stale_age = std::time::Duration::from_secs(12 * 3600);
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("pid_") || name == current_pid_name {
            continue;
        }
        let pid_dead = if cfg!(target_os = "linux") {
            name.strip_prefix("pid_")
                .is_some_and(|p| !Path::new("/proc").join(p).exists())
        } else {
            false
        };
        let is_old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > stale_age);
        if pid_dead || is_old {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

#[tauri::command]
pub fn get_temp_dir() -> String {
    let temp = pid_temp_root().join("relay");
    let _ = fs::create_dir_all(&temp);
    temp.to_string_lossy().to_string()
}

#[tauri::command]
pub fn export_sites_to_path(file_path: String, json_content: String) -> Result<(), String> {
    ensure_safe_local_path(&file_path)?;
    fs::write(file_path, json_content)
        .map_err(|e| format!("Impossible d'écrire le fichier : {}", e))
}

pub fn dirs_next() -> Option<PathBuf> {
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

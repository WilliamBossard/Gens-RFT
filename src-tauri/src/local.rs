use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;

use crate::models::FileEntry;
use crate::security::{
    is_safe_local_delete_target, is_safe_local_path_no_traversal, is_valid_local_filename,
};

fn ensure_safe_local_path(path: &str) -> Result<(), String> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err("Chemin local invalide".to_string());
    }
    if !is_safe_local_path_no_traversal(Path::new(path)) {
        return Err("Chemin local non autorisé (traversée détectée)".to_string());
    }
    Ok(())
}

fn configure_background_command(cmd: &mut tokio::process::Command) {
    cmd.stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

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
    tokio::task::spawn_blocking(move || {
        let target_path = match path {
            Some(p) if !p.trim().is_empty() => PathBuf::from(p),
            _ => dirs_next().unwrap_or_else(|| {
                std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
            }),
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
    if let Ok(metadata) = fs::metadata(path) {
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
}

#[tauri::command]
pub async fn delete_local(path: String, is_dir: bool) -> Result<(), String> {
    ensure_safe_local_path(&path)?;
    tokio::task::spawn_blocking(move || {
        let p = Path::new(&path);
        if !is_safe_local_delete_target(p) {
            return Err("Refus de supprimer la racine du système ou du volume".to_string());
        }
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
    if ensure_safe_local_path(&path).is_err() {
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

#[tauri::command]
pub async fn compress_local(path: String, format: String) -> Result<String, String> {
    ensure_safe_local_path(&path)?;
    let p = Path::new(&path);
    let name = p
        .file_name()
        .ok_or("Chemin invalide")?
        .to_string_lossy()
        .to_string();
    let parent = p.parent().unwrap_or(Path::new("."));
    let is_zip = format.to_lowercase() == "zip";
    let ext = if is_zip { "zip" } else { "tar.gz" };
    let archive_path = parent.join(format!("{}.{}", name, ext));
    let archive_str = archive_path.to_string_lossy().to_string();

    let mut cmd = tokio::process::Command::new("tar");
    configure_background_command(&mut cmd);
    let output = cmd
        .current_dir(parent)
        .args(["-acf", &archive_str, "--", &name])
        .output()
        .await
        .map_err(|e| format!("Erreur exécution tar: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(archive_str)
}

pub fn is_safe_tar_verbose_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    if trimmed.is_empty() {
        return true;
    }
    // Dans `tar -tvf`, seul '-' (fichier régulier) ou 'd' (dossier) est autorisé.
    // Rejeter 'l' (symlink), 'h' (hardlink), 'c'/'b'/'p'/'s' (périphériques/FIFO/sockets).
    let first = trimmed.chars().next().unwrap_or('-');
    if first != '-' && first != 'd' {
        return false;
    }
    if trimmed.contains(" -> ") || trimmed.contains(" link to ") {
        return false;
    }
    true
}

fn move_dir_contents_safe(src_dir: &Path, dst_dir: &Path) -> Result<(), String> {
    let entries = fs::read_dir(src_dir).map_err(|e| format!("Erreur lecture staging: {}", e))?;
    for entry_res in entries {
        let entry = entry_res.map_err(|e| format!("Erreur entrée staging: {}", e))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Erreur type entrée staging: {}", e))?;
        if file_type.is_symlink() {
            return Err("Lien symbolique détecté après extraction, opération annulée.".to_string());
        }
        let name = entry.file_name();
        let src_path = entry.path();
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
                fs::rename(&src_path, &dst_path)
                    .map_err(|e| format!("Erreur déplacement dossier {}: {}", dst_path.display(), e))?;
            }
        } else {
            if dst_path.exists() {
                fs::remove_file(&dst_path)
                    .map_err(|e| format!("Impossible de remplacer {}: {}", dst_path.display(), e))?;
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
    let p = Path::new(&path);
    if !p.is_file() {
        return Err("Archive locale introuvable.".to_string());
    }
    let parent = p.parent().unwrap_or(Path::new("."));
    let abs_archive = fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());

    // Pré-vérification anti Zip Slip / Tar Slip avant extraction
    let mut list_cmd = tokio::process::Command::new("tar");
    configure_background_command(&mut list_cmd);
    let list_out = list_cmd
        .arg("-tf")
        .arg(&abs_archive)
        .output()
        .await
        .map_err(|e| format!("Erreur inspection archive: {}", e))?;

    if !list_out.status.success() {
        return Err(format!(
            "Archive invalide ou illisible: {}",
            String::from_utf8_lossy(&list_out.stderr)
        ));
    }

    let listing = String::from_utf8_lossy(&list_out.stdout);
    for line in listing.lines() {
        if !line.trim().is_empty() && !is_safe_archive_entry(line) {
            return Err(format!(
                "Archive bloquée pour raisons de sécurité (chemin non sûr détecté : {})",
                line.trim()
            ));
        }
    }

    // Pré-vérification anti Symlink/Hardlink Slip via `tar -tvf`
    let mut verbose_cmd = tokio::process::Command::new("tar");
    configure_background_command(&mut verbose_cmd);
    let verbose_out = verbose_cmd
        .arg("-tvf")
        .arg(&abs_archive)
        .output()
        .await
        .map_err(|e| format!("Erreur inspection détaillée archive: {}", e))?;

    if !verbose_out.status.success() {
        return Err(format!(
            "Archive invalide ou illisible: {}",
            String::from_utf8_lossy(&verbose_out.stderr)
        ));
    }

    let verbose_listing = String::from_utf8_lossy(&verbose_out.stdout);
    for line in verbose_listing.lines() {
        if !is_safe_tar_verbose_line(line) {
            return Err(format!(
                "Archive bloquée pour raisons de sécurité (lien ou fichier spécial détecté : {})",
                line.trim()
            ));
        }
    }

    // Extraction isolée dans un répertoire staging (mitigation TOCTOU)
    let unique_ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let staging_dir = parent.join(format!(".gens_extract_{}", unique_ts));
    tokio::fs::create_dir_all(&staging_dir)
        .await
        .map_err(|e| format!("Impossible de créer le dossier temporaire d'extraction: {}", e))?;

    let mut extract_cmd = tokio::process::Command::new("tar");
    configure_background_command(&mut extract_cmd);
    let output = extract_cmd
        .current_dir(&staging_dir)
        .args(["-ax", "-f"])
        .arg(&abs_archive)
        .output()
        .await;

    let staging_clone = staging_dir.clone();
    let parent_owned = parent.to_path_buf();

    let extract_res: Result<(), String> = match output {
        Ok(out) if out.status.success() => {
            tokio::task::spawn_blocking(move || {
                for entry_res in WalkDir::new(&staging_clone).follow_links(false) {
                    let entry = entry_res.map_err(|e| format!("Erreur scan staging: {}", e))?;
                    if entry.file_type().is_symlink() {
                        return Err("Lien symbolique détecté après extraction, opération bloquée.".to_string());
                    }
                }
                move_dir_contents_safe(&staging_clone, &parent_owned)
            })
            .await
            .map_err(|e| e.to_string())?
        }
        Ok(out) => Err(String::from_utf8_lossy(&out.stderr).to_string()),
        Err(e) => Err(format!("Erreur exécution tar: {}", e)),
    };

    let _ = tokio::fs::remove_dir_all(&staging_dir).await;
    extract_res?;
    Ok("Archive locale extraite".into())
}

pub fn pid_temp_root() -> PathBuf {
    std::env::temp_dir()
        .join("Gens-RFT")
        .join(format!("pid_{}", std::process::id()))
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

use crc32fast::Hasher as Crc32Hasher;
use flate2::Compression;
use flate2::read::{DeflateDecoder, GzDecoder};
use flate2::write::{DeflateEncoder, GzEncoder};
use std::fs::{self, File};
use std::hash::{BuildHasher, Hasher};
use std::io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;

use crate::local::{is_safe_archive_entry, is_symlink_or_reparse, move_dir_contents_safe};
use crate::security::is_symlink_or_reparse_path;

pub const MAX_EXTRACT_ENTRIES: usize = 50_000;
pub const MAX_EXTRACT_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const COPY_BUF_SIZE: usize = 64 * 1024;

struct StagingGuard {
    dir: PathBuf,
}

impl StagingGuard {
    fn create(parent: &Path) -> Result<Self, String> {
        let rand_token = std::collections::hash_map::RandomState::new()
            .build_hasher()
            .finish();
        let unique_ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = parent.join(format!(".gens_extract_{}_{:016x}", unique_ts, rand_token));
        fs::create_dir(&dir).map_err(|e| {
            format!(
                "Impossible de créer le dossier temporaire d'extraction: {}",
                e
            )
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
        }
        Ok(Self { dir })
    }
}

impl Drop for StagingGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn resolve_safe_staging_path(staging_root: &Path, entry_name: &str) -> Result<PathBuf, String> {
    if !is_safe_archive_entry(entry_name) {
        return Err(format!(
            "Archive bloquée pour raisons de sécurité (chemin non sûr détecté : {})",
            entry_name.trim()
        ));
    }
    let normalized = entry_name.trim_end_matches(['\r', '\n']).replace('\\', "/");
    let mut out = staging_root.to_path_buf();
    for comp in Path::new(&normalized).components() {
        match comp {
            Component::Normal(part) => {
                out.push(part);
                if is_symlink_or_reparse_path(&out) {
                    return Err(
                        "Lien symbolique ou junction détecté dans le dossier d'extraction"
                            .to_string(),
                    );
                }
            }
            Component::CurDir => {}
            _ => {
                return Err(format!(
                    "Archive bloquée pour raisons de sécurité (composant interdit : {})",
                    entry_name
                ));
            }
        }
    }
    Ok(out)
}

fn copy_bounded_with_crc<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    expected_len: Option<u64>,
    total_extracted: &mut u64,
    compute_crc: bool,
) -> Result<(u64, u32), String> {
    let mut buf = [0u8; COPY_BUF_SIZE];
    let mut entry_bytes: u64 = 0;
    let mut crc = Crc32Hasher::new();

    loop {
        let to_read = match expected_len {
            Some(exp) => {
                let rem = exp.saturating_sub(entry_bytes);
                if rem == 0 {
                    break;
                }
                (rem as usize).min(buf.len())
            }
            None => buf.len(),
        };

        let n = reader
            .read(&mut buf[..to_read])
            .map_err(|e| format!("Erreur lecture flux archive: {}", e))?;
        if n == 0 {
            if let Some(exp) = expected_len
                && entry_bytes < exp
            {
                return Err("Archive tronquée ou corrompue (fin de fichier inattendue)".to_string());
            }
            break;
        }

        entry_bytes = entry_bytes.saturating_add(n as u64);
        *total_extracted = total_extracted.saturating_add(n as u64);
        if *total_extracted > MAX_EXTRACT_TOTAL_BYTES {
            return Err(
                "Archive bloquée : taille décompressée maximale dépassée (> 2 Go).".to_string(),
            );
        }

        if compute_crc {
            crc.update(&buf[..n]);
        }
        writer
            .write_all(&buf[..n])
            .map_err(|e| format!("Erreur écriture fichier extrait: {}", e))?;
    }

    Ok((entry_bytes, if compute_crc { crc.finalize() } else { 0 }))
}

fn verify_staging_no_symlinks(staging_root: &Path) -> Result<(), String> {
    for entry_res in WalkDir::new(staging_root).follow_links(false) {
        let entry = entry_res.map_err(|e| format!("Erreur scan staging: {}", e))?;
        if is_symlink_or_reparse(&entry.file_type(), entry.path()) {
            return Err(
                "Lien symbolique ou junction détecté après extraction, opération bloquée."
                    .to_string(),
            );
        }
    }
    Ok(())
}

// ============================================================================
// TAR / TAR.GZ (ustar + GNU LongName + PAX) en Rust pur
// ============================================================================

fn parse_tar_octal_or_base256(field: &[u8]) -> Result<u64, String> {
    if field.is_empty() {
        return Ok(0);
    }
    if (field[0] & 0x80) != 0 {
        let mut val: u64 = (field[0] & 0x7f) as u64;
        for &b in &field[1..] {
            val = val
                .checked_shl(8)
                .ok_or_else(|| "Taille TAR base-256 invalide (dépassement u64)".to_string())?
                | (b as u64);
        }
        return Ok(val);
    }
    let nul_pos = field.iter().position(|&b| b == 0).unwrap_or(field.len());
    let s = std::str::from_utf8(&field[..nul_pos])
        .map_err(|_| "En-tête TAR invalide (UTF-8)".to_string())?
        .trim_matches(|c: char| c == ' ');
    if s.is_empty() {
        return Ok(0);
    }
    u64::from_str_radix(s, 8).map_err(|_| format!("Nombre octal TAR invalide: {}", s))
}

fn parse_tar_cstr(field: &[u8]) -> String {
    let end = field.iter().position(|&b| b == 0).unwrap_or(field.len());
    String::from_utf8_lossy(&field[..end]).to_string()
}

fn verify_tar_checksum(block: &[u8; 512]) -> bool {
    let Ok(expected) = parse_tar_octal_or_base256(&block[148..156]) else {
        return false;
    };
    let mut unsigned_sum: u64 = 0;
    let mut signed_sum: i64 = 0;
    for (idx, &b) in block.iter().enumerate() {
        let effective = if (148..156).contains(&idx) { b' ' } else { b };
        unsigned_sum += effective as u64;
        signed_sum += (effective as i8) as i64;
    }
    expected == unsigned_sum || (expected as i64) == signed_sum
}

fn parse_pax_records(data: &[u8]) -> (Option<String>, Option<u64>) {
    let mut pax_path = None;
    let mut pax_size = None;
    let mut pos = 0usize;
    while pos < data.len() {
        let Some(sp_rel) = data[pos..].iter().position(|&b| b == b' ') else {
            break;
        };
        let Ok(len_str) = std::str::from_utf8(&data[pos..pos + sp_rel]) else {
            break;
        };
        let Ok(rec_len) = len_str.parse::<usize>() else {
            break;
        };
        if rec_len == 0 || pos + rec_len > data.len() {
            break;
        }
        let rec = &data[pos + sp_rel + 1..pos + rec_len];
        let trimmed = rec.strip_suffix(b"\n").unwrap_or(rec);
        if let Some(eq_pos) = trimmed.iter().position(|&b| b == b'=') {
            let key = &trimmed[..eq_pos];
            let val = &trimmed[eq_pos + 1..];
            if key == b"path" {
                pax_path = Some(String::from_utf8_lossy(val).to_string());
            } else if key == b"size"
                && let Ok(s) = std::str::from_utf8(val)
                && let Ok(parsed) = s.parse::<u64>()
            {
                pax_size = Some(parsed);
            }
        }
        pos += rec_len;
    }
    (pax_path, pax_size)
}

fn skip_exact_bytes<R: Read>(reader: &mut R, mut remaining: u64) -> Result<(), String> {
    let mut discard = [0u8; 8192];
    while remaining > 0 {
        let chunk = (remaining as usize).min(discard.len());
        let n = reader
            .read(&mut discard[..chunk])
            .map_err(|e| format!("Erreur lecture flux TAR: {}", e))?;
        if n == 0 {
            return Err("Archive TAR tronquée".to_string());
        }
        remaining -= n as u64;
    }
    Ok(())
}

fn read_exact_bounded<R: Read>(
    reader: &mut R,
    size: u64,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    if size > max_bytes as u64 {
        return Err("Métadonnée TAR surdimensionnée, archive rejetée".to_string());
    }
    let mut buf = vec![0u8; size as usize];
    reader
        .read_exact(&mut buf)
        .map_err(|e| format!("Erreur lecture métadonnée TAR: {}", e))?;
    Ok(buf)
}

fn extract_tar_stream<R: Read>(mut reader: R, staging_root: &Path) -> Result<(), String> {
    let mut block = [0u8; 512];
    let mut entry_count: usize = 0;
    let mut total_extracted: u64 = 0;
    let mut next_long_name: Option<String> = None;
    let mut next_pax_path: Option<String> = None;
    let mut next_pax_size: Option<u64> = None;

    loop {
        match reader.read_exact(&mut block) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(format!("Erreur lecture en-tête TAR: {}", e)),
        }

        if block.iter().all(|&b| b == 0) {
            break;
        }
        if !verify_tar_checksum(&block) {
            return Err(
                "Archive TAR invalide (somme de contrôle d'en-tête incorrecte)".to_string(),
            );
        }

        let typeflag = block[156];
        let header_size = parse_tar_octal_or_base256(&block[124..136])?;
        let header_pad_len = (512 - (header_size % 512)) % 512;

        match typeflag {
            b'L' => {
                let raw = read_exact_bounded(&mut reader, header_size, 1024 * 1024)?;
                skip_exact_bytes(&mut reader, header_pad_len)?;
                next_long_name = Some(parse_tar_cstr(&raw));
                continue;
            }
            b'K' => {
                return Err("Archive TAR bloquée : entrée GNU LongLink non autorisée".to_string());
            }
            b'x' => {
                let raw = read_exact_bounded(&mut reader, header_size, 1024 * 1024)?;
                skip_exact_bytes(&mut reader, header_pad_len)?;
                let (p, s) = parse_pax_records(&raw);
                if p.is_some() {
                    next_pax_path = p;
                }
                if s.is_some() {
                    next_pax_size = s;
                }
                continue;
            }
            b'g' => {
                let _ = read_exact_bounded(&mut reader, header_size, 1024 * 1024)?;
                skip_exact_bytes(&mut reader, header_pad_len)?;
                continue;
            }
            b'1' | b'2' | b'3' | b'4' | b'6' => {
                return Err(format!(
                    "Archive TAR bloquée pour raisons de sécurité (lien ou fichier spécial type '{}')",
                    typeflag as char
                ));
            }
            b'0' | 0 | b'5' => {}
            other => {
                return Err(format!(
                    "Archive TAR bloquée : type d'entrée non supporté ('{}')",
                    other as char
                ));
            }
        }

        let effective_size = next_pax_size.take().unwrap_or(header_size);
        let pad_len = (512 - (effective_size % 512)) % 512;

        let name = parse_tar_cstr(&block[0..100]);
        let prefix = parse_tar_cstr(&block[345..500]);
        let ustar_name = if prefix.is_empty() {
            name
        } else {
            format!("{}/{}", prefix, name)
        };
        let entry_name = next_pax_path
            .take()
            .or_else(|| next_long_name.take())
            .unwrap_or(ustar_name);

        entry_count += 1;
        if entry_count > MAX_EXTRACT_ENTRIES {
            return Err(format!(
                "Archive bloquée : trop d'entrées (> {} fichiers).",
                MAX_EXTRACT_ENTRIES
            ));
        }

        let target_path = resolve_safe_staging_path(staging_root, &entry_name)?;
        if typeflag == b'5' || entry_name.ends_with('/') {
            fs::create_dir_all(&target_path).map_err(|e| {
                format!(
                    "Impossible de créer le dossier {}: {}",
                    target_path.display(),
                    e
                )
            })?;
            if effective_size > 0 {
                skip_exact_bytes(&mut reader, effective_size)?;
                skip_exact_bytes(&mut reader, pad_len)?;
            }
        } else {
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent).map_err(|e| {
                    format!(
                        "Impossible de créer le dossier parent {}: {}",
                        parent.display(),
                        e
                    )
                })?;
            }
            if is_symlink_or_reparse_path(&target_path) {
                return Err("Lien symbolique ou junction détecté à la destination".to_string());
            }
            let out_file = File::create(&target_path)
                .map_err(|e| format!("Impossible de créer {}: {}", target_path.display(), e))?;
            let mut writer = BufWriter::with_capacity(COPY_BUF_SIZE, out_file);
            let mut limited = reader.by_ref().take(effective_size);
            let (written, _) = copy_bounded_with_crc(
                &mut limited,
                &mut writer,
                Some(effective_size),
                &mut total_extracted,
                false,
            )?;
            writer
                .flush()
                .map_err(|e| format!("Erreur flush fichier extrait: {}", e))?;
            if written != effective_size {
                return Err("Taille de fichier TAR incohérente".to_string());
            }
            skip_exact_bytes(&mut reader, pad_len)?;
        }
    }

    Ok(())
}

fn write_tar_header_block(
    out: &mut impl Write,
    name: &str,
    mode: u32,
    size: u64,
    mtime: u64,
    typeflag: u8,
) -> Result<(), String> {
    if name.len() > 100 || !name.is_ascii() {
        let payload = format_pax_path_record(name);
        write_tar_header_block_raw(
            out,
            "PaxHeader/entry",
            0o644,
            payload.len() as u64,
            mtime,
            b'x',
        )?;
        out.write_all(&payload)
            .map_err(|e| format!("Erreur écriture PAX TAR: {}", e))?;
        let pad = (512 - (payload.len() % 512)) % 512;
        if pad > 0 {
            out.write_all(&vec![0u8; pad])
                .map_err(|e| format!("Erreur padding PAX TAR: {}", e))?;
        }
        let truncated: String = name
            .bytes()
            .take(100)
            .map(|b| if b.is_ascii() { b as char } else { '_' })
            .collect();
        return write_tar_header_block_raw(out, &truncated, mode, size, mtime, typeflag);
    }
    write_tar_header_block_raw(out, name, mode, size, mtime, typeflag)
}

fn format_pax_path_record(path: &str) -> Vec<u8> {
    let body = format!(" path={}\n", path);
    let mut len_guess = body.len() + 2;
    loop {
        let line = format!("{}{}", len_guess, body);
        if line.len() == len_guess {
            return line.into_bytes();
        }
        len_guess = line.len();
    }
}

fn write_tar_header_block_raw(
    out: &mut impl Write,
    name: &str,
    mode: u32,
    size: u64,
    mtime: u64,
    typeflag: u8,
) -> Result<(), String> {
    let mut block = [0u8; 512];
    let name_bytes = name.as_bytes();
    let copy_len = name_bytes.len().min(100);
    block[..copy_len].copy_from_slice(&name_bytes[..copy_len]);

    let mode_str = format!("{:07o}\0", mode & 0o7777);
    block[100..108].copy_from_slice(mode_str.as_bytes());
    block[108..116].copy_from_slice(b"0000000\0");
    block[116..124].copy_from_slice(b"0000000\0");

    if size <= 0o777_7777_7777 {
        let size_str = format!("{:011o}\0", size);
        block[124..136].copy_from_slice(size_str.as_bytes());
    } else {
        block[124] = 0x80;
        block[128..136].copy_from_slice(&size.to_be_bytes());
    }

    let mtime_str = format!("{:011o}\0", mtime & 0o777_7777_7777);
    block[136..148].copy_from_slice(mtime_str.as_bytes());
    block[148..156].fill(b' ');
    block[156] = typeflag;
    block[257..263].copy_from_slice(b"ustar\0");
    block[263..265].copy_from_slice(b"00");

    let cksum: u64 = block.iter().map(|&b| b as u64).sum();
    let cksum_str = format!("{:06o}\0 ", cksum);
    block[148..156].copy_from_slice(cksum_str.as_bytes());

    out.write_all(&block)
        .map_err(|e| format!("Erreur écriture en-tête TAR: {}", e))
}

pub fn create_tar_gz_archive(source_path: &Path, archive_path: &Path) -> Result<(), String> {
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(archive_path)
        .map_err(|e| {
            format!(
                "Impossible de créer l'archive {}: {}",
                archive_path.display(),
                e
            )
        })?;
    let mut encoder = GzEncoder::new(
        BufWriter::with_capacity(COPY_BUF_SIZE, file),
        Compression::default(),
    );

    let parent = source_path.parent().unwrap_or_else(|| Path::new("."));
    let mut copy_buf = [0u8; COPY_BUF_SIZE];

    for entry_res in WalkDir::new(source_path).follow_links(false) {
        let entry = entry_res.map_err(|e| format!("Erreur lecture locale: {}", e))?;
        if is_symlink_or_reparse(&entry.file_type(), entry.path()) {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(parent)
            .map_err(|e| e.to_string())?;
        let mut rel_str = rel.to_string_lossy().replace('\\', "/");
        if rel_str.is_empty() {
            continue;
        }
        let meta = entry
            .metadata()
            .map_err(|e| format!("Erreur métadonnées {}: {}", entry.path().display(), e))?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        if entry.file_type().is_dir() {
            if !rel_str.ends_with('/') {
                rel_str.push('/');
            }
            write_tar_header_block(&mut encoder, &rel_str, 0o755, 0, mtime, b'5')?;
        } else if entry.file_type().is_file() {
            let size = meta.len();
            write_tar_header_block(&mut encoder, &rel_str, 0o644, size, mtime, b'0')?;
            let mut src_file = File::open(entry.path())
                .map_err(|e| format!("Erreur ouverture {}: {}", entry.path().display(), e))?;
            let mut remaining = size;
            while remaining > 0 {
                let to_read = (remaining as usize).min(copy_buf.len());
                let n = src_file
                    .read(&mut copy_buf[..to_read])
                    .map_err(|e| format!("Erreur lecture {}: {}", entry.path().display(), e))?;
                if n == 0 {
                    return Err(format!(
                        "Fichier modifié pendant la compression: {}",
                        entry.path().display()
                    ));
                }
                encoder
                    .write_all(&copy_buf[..n])
                    .map_err(|e| format!("Erreur écriture TAR.GZ: {}", e))?;
                remaining -= n as u64;
            }
            let pad = (512 - (size % 512)) % 512;
            if pad > 0 {
                encoder
                    .write_all(&vec![0u8; pad as usize])
                    .map_err(|e| format!("Erreur padding TAR.GZ: {}", e))?;
            }
        }
    }

    encoder
        .write_all(&[0u8; 1024])
        .map_err(|e| format!("Erreur finalisation TAR.GZ: {}", e))?;
    let mut writer = encoder
        .finish()
        .map_err(|e| format!("Erreur finalisation flux gzip: {}", e))?;
    writer
        .flush()
        .map_err(|e| format!("Erreur flush archive TAR.GZ: {}", e))?;
    Ok(())
}

// ============================================================================
// ZIP (Store 0 & Deflate 8, Central Directory) en Rust pur
// ============================================================================

fn le_u16(b: &[u8]) -> u16 {
    u16::from_le_bytes([b[0], b[1]])
}

fn le_u32(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

struct ZipCdEntry {
    name: String,
    method: u16,
    flags: u16,
    crc32: u32,
    compressed_size: u64,
    uncompressed_size: u64,
    local_header_offset: u64,
    is_dir: bool,
}

fn find_zip_eocd(file: &mut File, file_len: u64) -> Result<(u32, u32, u16), String> {
    if file_len < 22 {
        return Err("Archive ZIP invalide ou tronquée".to_string());
    }
    let tail_len = file_len.min(65_557) as usize;
    let tail_start = file_len - tail_len as u64;
    file.seek(SeekFrom::Start(tail_start))
        .map_err(|e| format!("Erreur lecture EOCD ZIP: {}", e))?;
    let mut tail = vec![0u8; tail_len];
    file.read_exact(&mut tail)
        .map_err(|e| format!("Erreur lecture EOCD ZIP: {}", e))?;

    for i in (0..=tail_len - 22).rev() {
        if tail[i..i + 4] == [0x50, 0x4b, 0x05, 0x06] {
            let comment_len = le_u16(&tail[i + 20..i + 22]) as usize;
            if i + 22 + comment_len == tail_len {
                let entries = le_u16(&tail[i + 10..i + 12]);
                let cd_size = le_u32(&tail[i + 12..i + 16]);
                let cd_offset = le_u32(&tail[i + 16..i + 20]);
                if entries == u16::MAX || cd_size == u32::MAX || cd_offset == u32::MAX {
                    return Err(
                        "Archives ZIP64 non supportées pour l'extraction intégrée".to_string()
                    );
                }
                return Ok((cd_offset, cd_size, entries));
            }
        }
    }
    Err("Signature ZIP EOCD introuvable (archive invalide ou ZIP64)".to_string())
}

fn parse_zip_central_directory(
    file: &mut File,
    cd_offset: u32,
    cd_size: u32,
    expected_entries: u16,
) -> Result<Vec<ZipCdEntry>, String> {
    if cd_size > 64 * 1024 * 1024 {
        return Err("Répertoire central ZIP trop volumineux".to_string());
    }
    if (expected_entries as usize) > MAX_EXTRACT_ENTRIES {
        return Err(format!(
            "Archive bloquée : trop d'entrées (> {} fichiers).",
            MAX_EXTRACT_ENTRIES
        ));
    }
    file.seek(SeekFrom::Start(cd_offset as u64))
        .map_err(|e| format!("Erreur positionnement Central Directory ZIP: {}", e))?;
    let mut cd_buf = vec![0u8; cd_size as usize];
    file.read_exact(&mut cd_buf)
        .map_err(|e| format!("Erreur lecture Central Directory ZIP: {}", e))?;

    let mut entries = Vec::with_capacity(expected_entries as usize);
    let mut pos = 0usize;
    let mut declared_total: u64 = 0;

    while pos < cd_buf.len() {
        if pos + 46 > cd_buf.len() || cd_buf[pos..pos + 4] != [0x50, 0x4b, 0x01, 0x02] {
            return Err("Entrée Central Directory ZIP corrompue".to_string());
        }
        let ver_made_by = le_u16(&cd_buf[pos + 4..pos + 6]);
        let flags = le_u16(&cd_buf[pos + 8..pos + 10]);
        let method = le_u16(&cd_buf[pos + 10..pos + 12]);
        let crc32 = le_u32(&cd_buf[pos + 16..pos + 20]);
        let comp_size = le_u32(&cd_buf[pos + 20..pos + 24]);
        let uncomp_size = le_u32(&cd_buf[pos + 24..pos + 28]);
        let name_len = le_u16(&cd_buf[pos + 28..pos + 30]) as usize;
        let extra_len = le_u16(&cd_buf[pos + 30..pos + 32]) as usize;
        let comment_len = le_u16(&cd_buf[pos + 32..pos + 34]) as usize;
        let external_attrs = le_u32(&cd_buf[pos + 38..pos + 42]);
        let local_offset = le_u32(&cd_buf[pos + 42..pos + 46]);

        let next_pos = pos + 46 + name_len + extra_len + comment_len;
        if next_pos > cd_buf.len() {
            return Err("En-tête ZIP Central Directory tronqué".to_string());
        }

        if comp_size == u32::MAX || uncomp_size == u32::MAX || local_offset == u32::MAX {
            return Err("Entrée ZIP64 non supportée pour l'extraction intégrée".to_string());
        }
        if (flags & 0x0001) != 0 {
            return Err("Archives ZIP chiffrées par mot de passe non supportées".to_string());
        }

        let creator_os = ver_made_by >> 8;
        if creator_os == 3 || creator_os == 19 {
            let unix_mode = (external_attrs >> 16) & 0o170000;
            if unix_mode == 0o120000 {
                return Err("Archive ZIP bloquée : lien symbolique Unix détecté".to_string());
            }
            if unix_mode != 0 && unix_mode != 0o100000 && unix_mode != 0o040000 {
                return Err("Archive ZIP bloquée : fichier spécial détecté".to_string());
            }
        }

        let name = String::from_utf8_lossy(&cd_buf[pos + 46..pos + 46 + name_len]).to_string();
        if !is_safe_archive_entry(&name) {
            return Err(format!(
                "Archive ZIP bloquée pour raisons de sécurité (chemin non sûr détecté : {})",
                name.trim()
            ));
        }

        declared_total = declared_total.saturating_add(uncomp_size as u64);
        if declared_total > MAX_EXTRACT_TOTAL_BYTES {
            return Err(
                "Archive bloquée : taille décompressée maximale dépassée (> 2 Go).".to_string(),
            );
        }

        let is_dir = name.ends_with('/')
            || name.ends_with('\\')
            || (external_attrs & 0x10) != 0 && uncomp_size == 0;
        entries.push(ZipCdEntry {
            name,
            method,
            flags,
            crc32,
            compressed_size: comp_size as u64,
            uncompressed_size: uncomp_size as u64,
            local_header_offset: local_offset as u64,
            is_dir,
        });

        if entries.len() > MAX_EXTRACT_ENTRIES {
            return Err(format!(
                "Archive bloquée : trop d'entrées (> {} fichiers).",
                MAX_EXTRACT_ENTRIES
            ));
        }
        pos = next_pos;
    }

    Ok(entries)
}

fn extract_zip_file(file: &mut File, file_len: u64, staging_root: &Path) -> Result<(), String> {
    let (cd_offset, cd_size, expected_entries) = find_zip_eocd(file, file_len)?;
    let entries = parse_zip_central_directory(file, cd_offset, cd_size, expected_entries)?;
    let mut total_extracted: u64 = 0;

    for entry in entries {
        let target_path = resolve_safe_staging_path(staging_root, &entry.name)?;
        if entry.is_dir {
            fs::create_dir_all(&target_path)
                .map_err(|e| format!("Impossible de créer {}: {}", target_path.display(), e))?;
            continue;
        }

        file.seek(SeekFrom::Start(entry.local_header_offset))
            .map_err(|e| format!("Erreur lecture Local Header ZIP: {}", e))?;
        let mut lh = [0u8; 30];
        file.read_exact(&mut lh)
            .map_err(|e| format!("Local Header ZIP tronqué: {}", e))?;
        if lh[0..4] != [0x50, 0x4b, 0x03, 0x04] {
            return Err("Signature Local File Header ZIP invalide".to_string());
        }
        let lh_name_len = le_u16(&lh[26..28]) as u64;
        let lh_extra_len = le_u16(&lh[28..30]) as u64;
        let data_start = entry.local_header_offset + 30 + lh_name_len + lh_extra_len;
        if data_start + entry.compressed_size > file_len {
            return Err("Données ZIP hors limites du fichier".to_string());
        }

        file.seek(SeekFrom::Start(data_start))
            .map_err(|e| format!("Erreur seek données ZIP: {}", e))?;

        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Impossible de créer {}: {}", parent.display(), e))?;
        }
        if is_symlink_or_reparse_path(&target_path) {
            return Err("Lien symbolique ou junction détecté à la destination".to_string());
        }

        let out_file = File::create(&target_path)
            .map_err(|e| format!("Impossible de créer {}: {}", target_path.display(), e))?;
        let mut writer = BufWriter::with_capacity(COPY_BUF_SIZE, out_file);
        let mut comp_reader = std::io::Read::by_ref(file).take(entry.compressed_size);

        let (written, actual_crc) = match entry.method {
            0 => copy_bounded_with_crc(
                &mut comp_reader,
                &mut writer,
                Some(entry.uncompressed_size),
                &mut total_extracted,
                true,
            )?,
            8 => {
                let mut decoder = DeflateDecoder::new(comp_reader);
                copy_bounded_with_crc(
                    &mut decoder,
                    &mut writer,
                    if (entry.flags & 0x08) != 0 && entry.uncompressed_size == 0 {
                        None
                    } else {
                        Some(entry.uncompressed_size)
                    },
                    &mut total_extracted,
                    true,
                )?
            }
            m => {
                return Err(format!("Méthode de compression ZIP non supportée ({})", m));
            }
        };

        writer
            .flush()
            .map_err(|e| format!("Erreur flush fichier ZIP extrait: {}", e))?;

        if written != entry.uncompressed_size && (entry.flags & 0x08) == 0 {
            return Err(format!(
                "Taille décompressée incohérente pour {}",
                entry.name
            ));
        }
        if actual_crc != entry.crc32 {
            return Err(format!("Somme CRC-32 invalide pour {}", entry.name));
        }
    }

    Ok(())
}

struct WrittenZipRecord {
    name_bytes: Vec<u8>,
    method: u16,
    flags: u16,
    crc32: u32,
    comp_size: u32,
    uncomp_size: u32,
    local_offset: u32,
    is_dir: bool,
}

struct CountingWriter<W: Write> {
    inner: W,
    written: u64,
}

impl<W: Write> Write for CountingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.written += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

pub fn create_zip_archive(source_path: &Path, archive_path: &Path) -> Result<(), String> {
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(archive_path)
        .map_err(|e| {
            format!(
                "Impossible de créer le ZIP {}: {}",
                archive_path.display(),
                e
            )
        })?;
    let mut out = BufWriter::with_capacity(COPY_BUF_SIZE, file);
    let mut offset: u64 = 0;
    let mut records: Vec<WrittenZipRecord> = Vec::new();
    let parent = source_path.parent().unwrap_or_else(|| Path::new("."));
    let mut buf = [0u8; COPY_BUF_SIZE];

    for entry_res in WalkDir::new(source_path).follow_links(false) {
        let entry = entry_res.map_err(|e| format!("Erreur lecture locale: {}", e))?;
        if is_symlink_or_reparse(&entry.file_type(), entry.path()) {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(parent)
            .map_err(|e| e.to_string())?;
        let mut rel_str = rel.to_string_lossy().replace('\\', "/");
        if rel_str.is_empty() {
            continue;
        }

        if entry.file_type().is_dir() {
            if !rel_str.ends_with('/') {
                rel_str.push('/');
            }
            let name_bytes = rel_str.into_bytes();
            let local_offset = u32::try_from(offset)
                .map_err(|_| "Archive ZIP > 4 Go non supportée".to_string())?;
            let flags = 0x0800u16;
            write_zip_local_header(&mut out, &name_bytes, 0, flags, 0, 0, 0)?;
            offset += 30 + name_bytes.len() as u64;
            records.push(WrittenZipRecord {
                name_bytes,
                method: 0,
                flags,
                crc32: 0,
                comp_size: 0,
                uncomp_size: 0,
                local_offset,
                is_dir: true,
            });
        } else if entry.file_type().is_file() {
            let meta = entry
                .metadata()
                .map_err(|e| format!("Erreur métadonnées {}: {}", entry.path().display(), e))?;
            let raw_len = meta.len();
            let uncomp_size = u32::try_from(raw_len)
                .map_err(|_| "Fichier > 4 Go non supporté en ZIP standard".to_string())?;
            let local_offset = u32::try_from(offset)
                .map_err(|_| "Archive ZIP > 4 Go non supportée".to_string())?;

            let mut src = File::open(entry.path())
                .map_err(|e| format!("Erreur ouverture {}: {}", entry.path().display(), e))?;
            let mut crc = Crc32Hasher::new();
            let method = if raw_len == 0 { 0u16 } else { 8u16 };
            let flags = if method == 8 { 0x0808u16 } else { 0x0800u16 };
            let name_bytes = rel_str.into_bytes();

            write_zip_local_header(&mut out, &name_bytes, method, flags, 0, 0, 0)?;
            let data_start = offset + 30 + name_bytes.len() as u64;
            let mut comp_len: u64 = 0;

            if method == 8 {
                let counting = CountingWriter {
                    inner: &mut out,
                    written: 0,
                };
                let mut enc = DeflateEncoder::new(counting, Compression::default());
                loop {
                    let n = src
                        .read(&mut buf)
                        .map_err(|e| format!("Erreur lecture {}: {}", entry.path().display(), e))?;
                    if n == 0 {
                        break;
                    }
                    crc.update(&buf[..n]);
                    enc.write_all(&buf[..n])
                        .map_err(|e| format!("Erreur compression ZIP: {}", e))?;
                }
                let counting = enc
                    .finish()
                    .map_err(|e| format!("Erreur finalisation DEFLATE: {}", e))?;
                comp_len = counting.written;
            }

            let crc32 = crc.finalize();
            let comp_size = u32::try_from(comp_len)
                .map_err(|_| "Entrée compressée > 4 Go non supportée".to_string())?;

            if method == 8 {
                let mut dd = [0u8; 16];
                dd[0..4].copy_from_slice(&[0x50, 0x4b, 0x07, 0x08]);
                dd[4..8].copy_from_slice(&crc32.to_le_bytes());
                dd[8..12].copy_from_slice(&comp_size.to_le_bytes());
                dd[12..16].copy_from_slice(&uncomp_size.to_le_bytes());
                out.write_all(&dd)
                    .map_err(|e| format!("Erreur écriture Data Descriptor ZIP: {}", e))?;
                offset = data_start + comp_len + 16;
            } else {
                offset = data_start;
            }

            records.push(WrittenZipRecord {
                name_bytes,
                method,
                flags,
                crc32,
                comp_size,
                uncomp_size,
                local_offset,
                is_dir: false,
            });
        }
    }

    let cd_offset =
        u32::try_from(offset).map_err(|_| "Archive ZIP > 4 Go non supportée".to_string())?;
    let mut cd_size: u64 = 0;
    let entry_count = u16::try_from(records.len())
        .map_err(|_| "Trop d'entrées pour ZIP standard (> 65535)".to_string())?;

    for rec in &records {
        let mut hdr = Vec::with_capacity(46 + rec.name_bytes.len());
        hdr.extend_from_slice(&[0x50, 0x4b, 0x01, 0x02]);
        hdr.extend_from_slice(&0x031Eu16.to_le_bytes()); // version made by: Unix
        hdr.extend_from_slice(&20u16.to_le_bytes()); // version needed: 2.0
        hdr.extend_from_slice(&rec.flags.to_le_bytes()); // UTF-8 (+ Data Descriptor si deflate)
        hdr.extend_from_slice(&rec.method.to_le_bytes());
        hdr.extend_from_slice(&0u16.to_le_bytes());
        hdr.extend_from_slice(&0x5421u16.to_le_bytes());
        hdr.extend_from_slice(&rec.crc32.to_le_bytes());
        hdr.extend_from_slice(&rec.comp_size.to_le_bytes());
        hdr.extend_from_slice(&rec.uncomp_size.to_le_bytes());
        hdr.extend_from_slice(&(rec.name_bytes.len() as u16).to_le_bytes());
        hdr.extend_from_slice(&0u16.to_le_bytes());
        hdr.extend_from_slice(&0u16.to_le_bytes());
        hdr.extend_from_slice(&0u16.to_le_bytes());
        hdr.extend_from_slice(&0u16.to_le_bytes());
        let ext_attr: u32 = if rec.is_dir {
            (0o040755u32 << 16) | 0x10
        } else {
            0o100644u32 << 16
        };
        hdr.extend_from_slice(&ext_attr.to_le_bytes());
        hdr.extend_from_slice(&rec.local_offset.to_le_bytes());
        hdr.extend_from_slice(&rec.name_bytes);

        out.write_all(&hdr)
            .map_err(|e| format!("Erreur écriture Central Directory ZIP: {}", e))?;
        cd_size += hdr.len() as u64;
    }

    let cd_size_u32 =
        u32::try_from(cd_size).map_err(|_| "Central Directory ZIP > 4 Go".to_string())?;
    let mut eocd = [0u8; 22];
    eocd[0..4].copy_from_slice(&[0x50, 0x4b, 0x05, 0x06]);
    eocd[8..10].copy_from_slice(&entry_count.to_le_bytes());
    eocd[10..12].copy_from_slice(&entry_count.to_le_bytes());
    eocd[12..16].copy_from_slice(&cd_size_u32.to_le_bytes());
    eocd[16..20].copy_from_slice(&cd_offset.to_le_bytes());
    out.write_all(&eocd)
        .map_err(|e| format!("Erreur écriture EOCD ZIP: {}", e))?;
    out.flush()
        .map_err(|e| format!("Erreur flush archive ZIP: {}", e))?;
    Ok(())
}

fn write_zip_local_header(
    out: &mut impl Write,
    name_bytes: &[u8],
    method: u16,
    flags: u16,
    crc32: u32,
    comp_size: u32,
    uncomp_size: u32,
) -> Result<(), String> {
    let name_len = u16::try_from(name_bytes.len())
        .map_err(|_| "Nom de fichier trop long pour ZIP".to_string())?;
    let mut hdr = Vec::with_capacity(30 + name_bytes.len());
    hdr.extend_from_slice(&[0x50, 0x4b, 0x03, 0x04]);
    hdr.extend_from_slice(&20u16.to_le_bytes());
    hdr.extend_from_slice(&flags.to_le_bytes());
    hdr.extend_from_slice(&method.to_le_bytes());
    hdr.extend_from_slice(&0u16.to_le_bytes());
    hdr.extend_from_slice(&0x5421u16.to_le_bytes());
    hdr.extend_from_slice(&crc32.to_le_bytes());
    hdr.extend_from_slice(&comp_size.to_le_bytes());
    hdr.extend_from_slice(&uncomp_size.to_le_bytes());
    hdr.extend_from_slice(&name_len.to_le_bytes());
    hdr.extend_from_slice(&0u16.to_le_bytes());
    hdr.extend_from_slice(name_bytes);
    out.write_all(&hdr)
        .map_err(|e| format!("Erreur écriture Local Header ZIP: {}", e))
}

// ============================================================================
// Point d'entrée extraction locale unifié (handle unique anti-TOCTOU)
// ============================================================================

pub fn extract_archive_blocking(archive_path: &Path) -> Result<(), String> {
    if is_symlink_or_reparse_path(archive_path) {
        return Err("Refus d'extraire via un lien symbolique ou junction.".to_string());
    }
    let mut file = File::open(archive_path)
        .map_err(|e| format!("Archive locale introuvable ou illisible: {}", e))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("Impossible de lire les métadonnées de l'archive: {}", e))?;
    if !meta.is_file() {
        return Err("Archive locale introuvable.".to_string());
    }
    let file_len = meta.len();
    let parent = archive_path.parent().unwrap_or_else(|| Path::new("."));
    let staging = StagingGuard::create(parent)?;

    let lower_name = archive_path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    if lower_name.ends_with(".zip") {
        extract_zip_file(&mut file, file_len, &staging.dir)?;
    } else if lower_name.ends_with(".tar.gz") || lower_name.ends_with(".tgz") {
        let gz = GzDecoder::new(BufReader::with_capacity(COPY_BUF_SIZE, file));
        extract_tar_stream(BufReader::with_capacity(COPY_BUF_SIZE, gz), &staging.dir)?;
    } else if lower_name.ends_with(".tar") {
        extract_tar_stream(BufReader::with_capacity(COPY_BUF_SIZE, file), &staging.dir)?;
    } else {
        return Err(
            "Format d'archive locale non supporté (.zip, .tar.gz, .tgz, .tar).".to_string(),
        );
    }

    verify_staging_no_symlinks(&staging.dir)?;
    move_dir_contents_safe(&staging.dir, parent)?;
    Ok(())
}

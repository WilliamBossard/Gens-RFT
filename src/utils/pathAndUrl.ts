export type ProtocolType = "SFTP" | "FTP" | "FTPS";

export interface ParsedQuickConnectTarget {
  protocol: ProtocolType;
  host: string;
  port: string;
  username: string;
}

/**
 * Parse un champ cible QuickConnect (avec protocole éventuel, user@, /chemin et [IPv6%zone]:port).
 */
export function parseQuickConnectTarget(
  rawHost: string,
  rawPort: string,
  defaultProtocol: ProtocolType,
  rawUser: string
): ParsedQuickConnectTarget {
  let host = rawHost.trim();
  let port = rawPort.trim();
  let protocol: ProtocolType = defaultProtocol;
  let username = rawUser.trim();

  const lower = host.toLowerCase();
  if (lower.startsWith("ftps://")) {
    protocol = "FTPS";
    host = host.slice(7);
    if (!port || port === "22") port = "21";
  } else if (lower.startsWith("ftp://")) {
    protocol = "FTP";
    host = host.slice(6);
    if (!port || port === "22") port = "21";
  } else if (lower.startsWith("sftp://")) {
    protocol = "SFTP";
    host = host.slice(7);
    if (!port || port === "21") port = "22";
  }

  // Supprimer le chemin éventuel (/dir/sub) avant de parser user@ et :port
  const slashIdx = host.indexOf("/");
  if (slashIdx !== -1) {
    host = host.slice(0, slashIdx);
  }

  // Extraire user@host si présent (n'écrase pas un utilisateur déjà saisi explicitement)
  const atIdx = host.lastIndexOf("@");
  if (atIdx !== -1) {
    const urlUser = host.slice(0, atIdx).trim();
    host = host.slice(atIdx + 1);
    if (!username && urlUser) {
      username = urlUser;
    }
  }

  // Support [ipv6%zone]:port ou host:port (en préservant les adresses IPv6 brutes)
  const hostPortMatch = host.match(/^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/);
  if (hostPortMatch) {
    host = hostPortMatch[1] || hostPortMatch[2];
    port = hostPortMatch[3];
  } else if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }

  const finalPort = port || (protocol === "FTP" || protocol === "FTPS" ? "21" : "22");

  return {
    protocol,
    host,
    port: finalPort,
    username,
  };
}

const DOS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CONIN$",
  "CONOUT$",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

/**
 * Miroir exact de `security::sanitize_windows_filename` côté Rust pour la détection des conflits de téléchargement.
 */
export function sanitizeWindowsFilename(name: string): string {
  let clean = "";
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      code < 0x20 ||
      code === 0x7f ||
      ch === "<" ||
      ch === ">" ||
      ch === ":" ||
      ch === '"' ||
      ch === "/" ||
      ch === "\\" ||
      ch === "|" ||
      ch === "?" ||
      ch === "*"
    ) {
      clean += "_";
    } else {
      clean += ch;
    }
  }

  let trimmed = clean.replace(/[. ]+$/, "");
  if (!trimmed || trimmed === "." || trimmed === "..") {
    return "unnamed_file";
  }

  const upper = trimmed.toUpperCase();
  const dotIdx = upper.indexOf(".");
  const baseName = dotIdx === -1 ? upper : upper.slice(0, dotIdx);
  if (DOS_RESERVED_NAMES.has(baseName)) {
    trimmed = `_${trimmed}`;
  }

  const chars = Array.from(trimmed);
  if (chars.length > 240) {
    trimmed = chars.slice(0, 240).join("");
  }
  return trimmed;
}

export type ParsedFtpsCertError =
  | { kind: "unknown"; fingerprint: string; detail: string }
  | { kind: "changed"; fingerprint: string; expected: string; detail: string };

/**
 * Parse les erreurs structurées TOFU FTPS émises par le backend Rust.
 */
export function parseFtpsCertError(errMsg: string): ParsedFtpsCertError | null {
  if (errMsg.startsWith("FTPS_CERT_UNKNOWN|")) {
    const parts = errMsg.split("|");
    return {
      kind: "unknown",
      fingerprint: parts[1] || "INCONNU",
      detail: parts.slice(2).join("|") || "Certificat non vérifié par les autorités système",
    };
  }
  if (errMsg.startsWith("FTPS_CERT_CHANGED|")) {
    const parts = errMsg.split("|");
    return {
      kind: "changed",
      fingerprint: parts[1] || "INCONNU",
      expected: parts[2] || "INCONNU",
      detail: parts.slice(3).join("|") || "Empreinte SHA-256 différente",
    };
  }
  return null;
}

import { invoke } from "@tauri-apps/api/core";

/**
 * Module de chiffrement AES-256-GCM pour sécuriser le stockage des profils
 * de serveurs (mots de passe, identifiants, IP/hôtes).
 * La clé locale est protégée par Windows DPAPI (via le backend Rust) et dérivée via PBKDF2.
 */

const VAULT_KEY_STORAGE = "gens_rft_vault_salt_v1";
const APP_PORTABLE_SECRET = "gens-rft-portable-vault-key-2025-v2";

let cachedDpapiKey: string | null = null;

async function getLegacyVaultSecret(): Promise<string> {
  if (cachedDpapiKey) return cachedDpapiKey;
  const key = await invoke<string | null>("read_legacy_vault_key_if_exists");
  if (!key || key.length < 32) {
    throw new Error("Clé de migration DPAPI introuvable ou invalide.");
  }
  cachedDpapiKey = key;
  return key;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function hexToUint8Array(hex: string): Uint8Array {
  const cleanHex = hex.length % 2 !== 0 ? "0" + hex : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function getOrCreateLocalSalt(): string {
  let rawSalt = localStorage.getItem(VAULT_KEY_STORAGE);
  if (!rawSalt) {
    const saltBytes = new Uint8Array(32);
    window.crypto.getRandomValues(saltBytes);
    rawSalt = Array.from(saltBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    localStorage.setItem(VAULT_KEY_STORAGE, rawSalt);
  }
  return rawSalt;
}

async function deriveAesKeyPbkdf2(
  password: string,
  saltBytes: Uint8Array,
  iterations = 100000
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const baseKey = await window.crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  return await window.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes as unknown as BufferSource,
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function deriveAesKeyLegacyV2(secret: string, salt: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${secret}:${salt}`)
  );
  return await window.crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

// Export chiffré portable v5 protégé par mot de passe utilisateur obligatoire (PBKDF2 600k itérations)
export async function exportVaultData(data: unknown, customPassword: string): Promise<string> {
  const trimmedPwd = (customPassword || "").trim();
  if (trimmedPwd.length < 8) {
    throw new Error("Un mot de passe d'au moins 8 caractères est requis pour exporter les profils.");
  }

  const saltBytes = new Uint8Array(16);
  window.crypto.getRandomValues(saltBytes);
  const saltHex = Array.from(saltBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const key = await deriveAesKeyPbkdf2(trimmedPwd, saltBytes, 600000);
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encodedData = new TextEncoder().encode(JSON.stringify(data));

  const ciphertext = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encodedData
  );

  return `enc:v5:pwd:${saltHex}:${uint8ArrayToBase64(iv)}:${uint8ArrayToBase64(
    new Uint8Array(ciphertext)
  )}`;
}

export function isPasswordProtectedExport(raw: string): boolean {
  return (
    raw.startsWith("enc:v5:pwd:") ||
    raw.startsWith("enc:v3:pwd:") ||
    raw.startsWith("enc:v2:pwd:")
  );
}

export async function decryptVaultDataStrict<T = unknown>(
  encryptedStr: string,
  customPassword?: string
): Promise<T> {
  if (!encryptedStr || typeof encryptedStr !== "string") {
    throw new Error("Données de coffre vides ou invalides.");
  }

  if (!encryptedStr.startsWith("enc:")) {
    return JSON.parse(encryptedStr) as T;
  }

  const parts = encryptedStr.split(":");

  // Format v5 : enc:v5:pwd:<saltHex>:<iv>:<ciphertext> (PBKDF2 600k)
  if (parts[0] === "enc" && parts[1] === "v5" && parts[2] === "pwd") {
    const saltHex = parts[3];
    const ivBase64 = parts[4];
    const cipherBase64 = parts[5];
    if (!saltHex || !ivBase64 || !cipherBase64) {
      throw new Error("Format de coffre v5 corrompu.");
    }

    const key = await deriveAesKeyPbkdf2(
      (customPassword || "").trim(),
      hexToUint8Array(saltHex),
      600000
    );
    const iv = base64ToUint8Array(ivBase64);
    const ciphertext = base64ToUint8Array(cipherBase64);

    const decryptedBuffer = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource },
      key,
      ciphertext as unknown as BufferSource
    );
    return JSON.parse(new TextDecoder().decode(decryptedBuffer)) as T;
  }

  // Format v4 DPAPI : enc:v4:dpapi:<saltHex>:<iv>:<ciphertext>
  if (parts[0] === "enc" && parts[1] === "v4" && parts[2] === "dpapi") {
    const saltHex = parts[3];
    const ivBase64 = parts[4];
    const cipherBase64 = parts[5];
    if (!saltHex || !ivBase64 || !cipherBase64) {
      throw new Error("Format de coffre v4 corrompu.");
    }

    const dpapiSecret = await getLegacyVaultSecret();
    const key = await deriveAesKeyPbkdf2(dpapiSecret, hexToUint8Array(saltHex));
    const iv = base64ToUint8Array(ivBase64);
    const ciphertext = base64ToUint8Array(cipherBase64);

    const decryptedBuffer = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource },
      key,
      ciphertext as unknown as BufferSource
    );
    return JSON.parse(new TextDecoder().decode(decryptedBuffer)) as T;
  }

  // Format v3 : enc:v3:<mode>:<salt>:<iv>:<ciphertext>
  if (parts[0] === "enc" && parts[1] === "v3") {
    const mode = parts[2];
    const saltHex = parts[3];
    const ivBase64 = parts[4];
    const cipherBase64 = parts[5];
    if (!saltHex || !ivBase64 || !cipherBase64) {
      throw new Error("Format de coffre v3 corrompu.");
    }

    const saltBytes =
      mode === "local" ? new TextEncoder().encode(saltHex) : hexToUint8Array(saltHex);
    const password =
      mode === "pwd"
        ? (customPassword || "").trim()
        : mode === "local"
        ? "gens-rft-vault-secret-local"
        : APP_PORTABLE_SECRET;

    const key = await deriveAesKeyPbkdf2(password, saltBytes);
    const iv = base64ToUint8Array(ivBase64);
    const ciphertext = base64ToUint8Array(cipherBase64);

    const decryptedBuffer = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource },
      key,
      ciphertext as unknown as BufferSource
    );
    return JSON.parse(new TextDecoder().decode(decryptedBuffer)) as T;
  }

  // Format v2 legacy
  if (parts[0] === "enc" && parts[1] === "v2") {
    const mode = parts[2];
    const salt = parts[3];
    const ivBase64 = parts[4];
    const cipherBase64 = parts[5];
    if (!salt || !ivBase64 || !cipherBase64) {
      throw new Error("Format de coffre v2 corrompu.");
    }

    const secret =
      mode === "pwd"
        ? `gens-custom:${(customPassword || "").trim()}`
        : mode === "local"
        ? "gens-rft-vault-secret"
        : APP_PORTABLE_SECRET;

    const key = await deriveAesKeyLegacyV2(secret, salt);
    const iv = base64ToUint8Array(ivBase64);
    const ciphertext = base64ToUint8Array(cipherBase64);

    const decryptedBuffer = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource },
      key,
      ciphertext as unknown as BufferSource
    );
    return JSON.parse(new TextDecoder().decode(decryptedBuffer)) as T;
  }

  // Format v1 legacy
  if (parts[0] === "enc" && parts[1] === "v1") {
    const ivBase64 = parts[2];
    const cipherBase64 = parts[3];
    if (!ivBase64 || !cipherBase64) {
      throw new Error("Format de coffre v1 corrompu.");
    }

    const salt = getOrCreateLocalSalt();
    const key = await deriveAesKeyLegacyV2("gens-rft-vault-secret", salt);
    const iv = base64ToUint8Array(ivBase64);
    const ciphertext = base64ToUint8Array(cipherBase64);

    const decryptedBuffer = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource },
      key,
      ciphertext as unknown as BufferSource
    );
    return JSON.parse(new TextDecoder().decode(decryptedBuffer)) as T;
  }

  throw new Error("Version de chiffrement du coffre non reconnue.");
}

export async function decryptVaultData<T = unknown>(
  encryptedStr: string,
  fallback: T,
  customPassword?: string
): Promise<T> {
  if (!encryptedStr || typeof encryptedStr !== "string") return fallback;
  try {
    return await decryptVaultDataStrict<T>(encryptedStr, customPassword);
  } catch (err) {
    console.error("Erreur déchiffrement coffre:", err);
    return fallback;
  }
}

export async function loadSitesFromBackendVault<T>(legacyStorageKey: string): Promise<T[]> {
  const backendRaw = await invoke<string | null>("load_vault_sites");
  if (backendRaw !== null) {
    const parsed = JSON.parse(backendRaw);
    if (!Array.isArray(parsed)) {
      throw new Error("Format du coffre backend invalide.");
    }
    return parsed as T[];
  }

  // Migration unique depuis l'ancien stockage localStorage (enc:v4:dpapi / legacy) vers le coffre Rust
  const legacyRaw = localStorage.getItem(legacyStorageKey);
  if (legacyRaw) {
    const migrated = await decryptVaultDataStrict<T[]>(legacyRaw);
    if (!Array.isArray(migrated)) {
      throw new Error("Format de profils migrés invalide.");
    }
    await invoke("save_vault_sites", { jsonPayload: JSON.stringify(migrated) });
    await invoke("delete_legacy_vault_key").catch(() => {});
    localStorage.removeItem(legacyStorageKey);
    localStorage.removeItem(VAULT_KEY_STORAGE);
    cachedDpapiKey = null;
    return migrated;
  }

  return [];
}

export async function saveSitesToBackendVault(sites: unknown[]): Promise<void> {
  await invoke("save_vault_sites", { jsonPayload: JSON.stringify(sites) });
}

/**
 * Module de chiffrement AES-256-GCM pour sécuriser le stockage des profils
 * de serveurs (mots de passe, identifiants, IP/hôtes).
 * Utilise l'API native Web Crypto (SubtleCrypto) intégrée à WebView2.
 */

const VAULT_KEY_STORAGE = "gens_rft_vault_salt_v1";
const APP_PORTABLE_SECRET = "gens-rft-portable-vault-key-2025-v2";

// Conversion sûre Uint8Array -> Base64 par morceaux pour éviter "Maximum call stack size exceeded"
function uint8ArrayToBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 0x8000; // 32768
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

// Conversion sûre Base64 -> Uint8Array
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Conversion hexadécimale -> Uint8Array
function hexToUint8Array(hex: string): Uint8Array {
  const cleanHex = hex.length % 2 !== 0 ? "0" + hex : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// Récupère ou génère un sel local
function getOrCreateLocalSalt(): string {
  let rawSalt = localStorage.getItem(VAULT_KEY_STORAGE);
  if (!rawSalt) {
    const saltBytes = new Uint8Array(32);
    window.crypto.getRandomValues(saltBytes);
    rawSalt = Array.from(saltBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(VAULT_KEY_STORAGE, rawSalt);
  }
  return rawSalt;
}

// Dérive une clé AES-GCM robuste via PBKDF2 (100 000 itérations)
async function deriveAesKeyPbkdf2(password: string, saltBytes: Uint8Array): Promise<CryptoKey> {
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
      iterations: 100000,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// Dérive une clé AES-GCM legacy v2 (SHA-256) pour rétrocompatibilité
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

// Chiffre des données JavaScript pour le stockage local avec PBKDF2 + AES-256-GCM
export async function encryptVaultData(data: any): Promise<string> {
  try {
    const saltHex = getOrCreateLocalSalt();
    const saltBytes = new TextEncoder().encode(saltHex);
    const key = await deriveAesKeyPbkdf2("gens-rft-vault-secret-local", saltBytes);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const encodedData = encoder.encode(JSON.stringify(data));

    const ciphertext = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encodedData
    );

    const ivBase64 = uint8ArrayToBase64(iv);
    const cipherBase64 = uint8ArrayToBase64(new Uint8Array(ciphertext));

    return `enc:v3:local:${saltHex}:${ivBase64}:${cipherBase64}`;
  } catch (err) {
    console.error("Erreur chiffrement coffre:", err);
    return JSON.stringify(data);
  }
}

// Exporte les profils pour sauvegarde/partage sécurisé avec PBKDF2
export async function exportVaultData(data: any, customPassword?: string): Promise<string> {
  try {
    const saltBytes = new Uint8Array(16);
    window.crypto.getRandomValues(saltBytes);
    const saltHex = Array.from(saltBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    const hasPwd = customPassword && customPassword.trim().length > 0;
    const secret = hasPwd ? customPassword!.trim() : APP_PORTABLE_SECRET;

    const key = await deriveAesKeyPbkdf2(secret, saltBytes);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const encodedData = encoder.encode(JSON.stringify(data));

    const ciphertext = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encodedData
    );

    const ivBase64 = uint8ArrayToBase64(iv);
    const cipherBase64 = uint8ArrayToBase64(new Uint8Array(ciphertext));
    const mode = hasPwd ? "pwd" : "app";

    return `enc:v3:${mode}:${saltHex}:${ivBase64}:${cipherBase64}`;
  } catch (err) {
    console.error("Erreur export coffre:", err);
    return JSON.stringify(data);
  }
}

// Déchiffre une chaîne chiffrée
export async function decryptVaultData<T = any>(
  encryptedStr: string,
  fallback: T,
  customPassword?: string
): Promise<T> {
  if (!encryptedStr || typeof encryptedStr !== "string") return fallback;

  // Format JSON clair non chiffré
  if (!encryptedStr.startsWith("enc:")) {
    try {
      return JSON.parse(encryptedStr) as T;
    } catch {
      return fallback;
    }
  }

  try {
    const parts = encryptedStr.split(":");

    // Format v3 renforcé PBKDF2 : enc:v3:<mode>:<salt>:<iv>:<ciphertext>
    if (parts[0] === "enc" && parts[1] === "v3") {
      const mode = parts[2];
      const saltHex = parts[3];
      const ivBase64 = parts[4];
      const cipherBase64 = parts[5];

      if (!saltHex || !ivBase64 || !cipherBase64) return fallback;

      const saltBytes = mode === "local" 
        ? new TextEncoder().encode(saltHex) 
        : hexToUint8Array(saltHex);
      const password = mode === "pwd"
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

      const decoder = new TextDecoder();
      return JSON.parse(decoder.decode(decryptedBuffer)) as T;
    }

    // Format v2 portable : enc:v2:<mode>:<salt>:<iv>:<ciphertext>
    if (parts[0] === "enc" && parts[1] === "v2") {
      const mode = parts[2];
      const salt = parts[3];
      const ivBase64 = parts[4];
      const cipherBase64 = parts[5];

      if (!salt || !ivBase64 || !cipherBase64) return fallback;

      const secret = mode === "pwd"
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

      const decoder = new TextDecoder();
      return JSON.parse(decoder.decode(decryptedBuffer)) as T;
    }

    // Format v1 legacy : enc:v1:<iv>:<ciphertext> (utilise le sel de la machine)
    if (parts[0] === "enc" && parts[1] === "v1") {
      const ivBase64 = parts[2];
      const cipherBase64 = parts[3];
      if (!ivBase64 || !cipherBase64) return fallback;

      const salt = getOrCreateLocalSalt();
      const key = await deriveAesKeyLegacyV2("gens-rft-vault-secret", salt);
      const iv = base64ToUint8Array(ivBase64);
      const ciphertext = base64ToUint8Array(cipherBase64);

      const decryptedBuffer = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv as unknown as BufferSource },
        key,
        ciphertext as unknown as BufferSource
      );

      const decoder = new TextDecoder();
      return JSON.parse(decoder.decode(decryptedBuffer)) as T;
    }

    return fallback;
  } catch (err) {
    console.error("Erreur déchiffrement coffre:", err);
    return fallback;
  }
}

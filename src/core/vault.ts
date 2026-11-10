import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { GateError } from "./errors.js";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const FORMAT_VERSION = "v1";

/** Nouvelle clé de coffre : 32 octets aléatoires, en base64. */
export function generateVaultKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

/** Décode VAULT_KEY ; lève une erreur qui dit comment en obtenir une valide. */
export function parseVaultKey(raw: string | undefined): Buffer {
  const value = raw?.trim();
  if (!value) {
    throw new GateError(
      "VAULT_KEY is not set. It encrypts the SSH private keys: generate one with `npx -y @imenam/mcp-ssh-gate --generate-vault-key` and set it as a secret variable of the MCP."
    );
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== KEY_BYTES || key.toString("base64") !== value) {
    throw new GateError(
      `VAULT_KEY is not a valid key: expected ${KEY_BYTES} bytes encoded in base64. Generate one with \`npx -y @imenam/mcp-ssh-gate --generate-vault-key\`.`
    );
  }
  return key;
}

/** Chiffre en AES-256-GCM : `v1:<iv>:<tag>:<chiffré>`, chaque partie en base64. */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT_VERSION, iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
}

/** Déchiffre un secret produit par `encryptSecret` ; échoue si la clé n'est pas la bonne. */
export function decryptSecret(payload: string, key: Buffer): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new GateError("Encrypted value has an unknown format.");
  }
  const [, iv, tag, encrypted] = parts;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new GateError("VAULT_KEY does not decrypt this value: it is not the key that was used to encrypt it.");
  }
}

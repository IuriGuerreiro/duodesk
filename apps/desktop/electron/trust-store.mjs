import { open, readFile, rename, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import {
  randomBytes,
  createHash,
  createPrivateKey,
  ECDH,
  X509Certificate,
} from "node:crypto";

export function secureStorageReason(storage, platform = process.platform) {
  try {
    if (!storage.isEncryptionAvailable())
      return "OS secure storage is unavailable";
    if (
      platform === "linux" &&
      !["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(
        storage.getSelectedStorageBackend(),
      )
    )
      return "OS secure storage backend is insecure or unavailable";
    return null;
  } catch {
    return "OS secure storage is unavailable";
  }
}
function exact(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join() === [...keys].sort().join()
  );
}
export function validatePhone(phone) {
  if (
    !exact(phone, ["phoneId", "name", "publicKey", "createdAt"]) ||
    !/^[a-f0-9]{64}$/.test(phone.phoneId) ||
    !/^04[a-f0-9]{128}$/.test(phone.publicKey) ||
    typeof phone.name !== "string" ||
    !phone.name.length ||
    Buffer.byteLength(phone.name) > 80 ||
    /\p{Cc}/u.test(phone.name) ||
    !Number.isSafeInteger(phone.createdAt) ||
    phone.createdAt < 0
  )
    throw new Error("Invalid trusted phone");
  const key = Buffer.from(phone.publicKey, "hex");
  ECDH.convertKey(key, "prime256v1");
  if (createHash("sha256").update(key).digest("hex") !== phone.phoneId)
    throw new Error("Phone identity mismatch");
  return phone;
}
function validateData(data) {
  if (
    !exact(data, ["v", "identity", "devices", "port", "address"]) ||
    data.v !== 1 ||
    !exact(data.identity, ["certificateDer", "privateKeyDer"]) ||
    ![data.identity.certificateDer, data.identity.privateKeyDer].every(
      (v) =>
        typeof v === "string" &&
        v.length <= 32768 &&
        /^(?:[a-f0-9]{2})+$/.test(v),
    ) ||
    !Number.isInteger(data.port) ||
    data.port < 1 ||
    data.port > 65535 ||
    !(
      data.address === null ||
      (typeof data.address === "string" &&
        /^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(data.address))
    ) ||
    !Array.isArray(data.devices) ||
    data.devices.length > 100
  )
    throw new Error("Invalid trusted device store");
  const cert = new X509Certificate(
    Buffer.from(data.identity.certificateDer, "hex"),
  );
  const key = createPrivateKey({
    key: Buffer.from(data.identity.privateKeyDer, "hex"),
    format: "der",
    type: "pkcs8",
  });
  if (!cert.checkPrivateKey(key)) throw new Error("TLS identity mismatch");
  data.devices.forEach(validatePhone);
  if (new Set(data.devices.map((p) => p.phoneId)).size !== data.devices.length)
    throw new Error("Duplicate phone");
  return data;
}
export class TrustStore {
  constructor(file, storage, platform = process.platform) {
    this.file = file;
    this.storage = storage;
    this.platform = platform;
    this.data = null;
    this.reason = null;
  }
  check() {
    const reason = secureStorageReason(this.storage, this.platform);
    if (reason) throw new Error(reason);
  }
  async load() {
    try {
      this.check();
      let encrypted;
      try {
        encrypted = await readFile(this.file);
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      if (encrypted.length > 262144)
        throw new Error("Trusted device store too large");
      this.data = validateData(
        JSON.parse(this.storage.decryptString(encrypted)),
      );
    } catch {
      this.data = null;
      this.reason =
        secureStorageReason(this.storage, this.platform) ??
        "Trusted device store cannot be decrypted or validated";
    }
  }
  async save(next) {
    try {
      this.check();
      if (this.reason) throw new Error(this.reason);
      validateData(next);
      const encrypted = this.storage.encryptString(JSON.stringify(next));
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomBytes(12).toString("hex")}.tmp`;
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(encrypted);
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, this.file);
        if (this.platform !== "win32") {
          const directory = await open(path.dirname(this.file), "r");
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        }
        this.data = structuredClone(next);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    } catch (error) {
      this.reason =
        "Trusted device persistence failed. Ordinary pairing is still available.";
      throw error;
    }
  }

  async initialize(generate) {
    this.check();
    if (this.reason) throw new Error(this.reason);
    if (!this.data)
      await this.save({
        v: 1,
        identity: await generate(),
        devices: [],
        port: 42889,
        address: null,
      });
  }
  fingerprint() {
    return this.data
      ? createHash("sha256")
          .update(Buffer.from(this.data.identity.certificateDer, "hex"))
          .digest("hex")
      : null;
  }
}

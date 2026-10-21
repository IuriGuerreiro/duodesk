import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TrustStore, secureStorageReason } from "../electron/trust-store.mjs";
import { TrustBackend } from "../electron/trust-backend.mjs";
import { validateCommand } from "../electron/host.mjs";

test("secure storage rejects unavailable, basic_text and unknown Linux backends", () => {
  for (const backend of [
    "basic_text",
    "unknown",
    "future_unreviewed_backend",
  ]) {
    const storage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => backend,
    };
    assert.ok(secureStorageReason(storage, "linux"));
  }
  assert.ok(
    secureStorageReason({ isEncryptionAvailable: () => false }, "darwin"),
  );
  for (const backend of ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"])
    assert.equal(
      secureStorageReason(
        {
          isEncryptionAvailable: () => true,
          getSelectedStorageBackend: () => backend,
        },
        "linux",
      ),
      null,
    );
});
test("insecure storage never decrypts, generates, encrypts or overwrites existing data", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "duodesk-store-"));
  try {
    const file = path.join(dir, "trust.enc");
    await writeFile(file, "existing ciphertext");
    const forbidden = () => {
      assert.fail("Insecure store must never touch identity material");
    };
    const store = new TrustStore(
      file,
      {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => "basic_text",
        encryptString: forbidden,
        decryptString: forbidden,
      },
      "linux",
    );
    await store.load();
    assert.ok(store.reason);
    await assert.rejects(store.initialize(forbidden));
    assert.equal(await readFile(file, "utf8"), "existing ciphertext");
    assert.deepEqual(await readdir(dir), ["trust.enc"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("undecryptable identity is retained and never replaced automatically", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "duodesk-corrupt-"));
  try {
    const file = path.join(dir, "trust.enc");
    await writeFile(file, "ciphertext");
    const store = new TrustStore(
      file,
      {
        isEncryptionAvailable: () => true,
        decryptString: () => {
          throw new Error("Locked");
        },
      },
      "darwin",
    );
    await store.load();
    assert.match(store.reason, /cannot be decrypted/);
    await assert.rejects(
      store.initialize(() => assert.fail("Must not rotate a pinned identity")),
    );
    assert.equal(await readFile(file, "utf8"), "ciphertext");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("persistence failure exposes trust error while preserving ordinary host pairing", async () => {
  const events = [];
  const store = {
    reason: null,
    platform: "darwin",
    storage: { isEncryptionAvailable: () => true },
    fingerprint: () => null,
    initialize: async () => {
      throw new Error("Encryption or disk failed");
    },
  };
  const backend = new TrustBackend(store, (event) => events.push(event));
  const host = {
    request: () =>
      assert.fail(
        "No trust identity should reach host after failed persistence",
      ),
  };
  await backend.beforeStart(host, "192.168.1.2");
  assert.equal(backend.status().available, false);
  assert.equal(backend.status().enabled, false);
  assert.match(backend.status().reason, /Ordinary pairing is still available/);
  assert.equal(events[0].kind, "trust_status");
});
test("IPC permits only explicit, exact trust decisions and never renderer identity configuration", () => {
  validateCommand("trust_status");
  validateCommand("trust_allow", { ip: "192.168.1.2", allow: false });
  validateCommand("trust_approve", {
    requestId: "a".repeat(32),
    approve: true,
  });
  validateCommand("trust_revoke", { phoneId: "b".repeat(64) });
  for (const [method, args] of [
    ["trust_status", {}],
    ["identity_generate"],
    ["trust_configure", {}],
    ["trust_allow", { ip: "localhost", allow: true }],
    ["trust_approve", { requestId: "a".repeat(32), approve: "true" }],
    ["trust_revoke", { phoneId: "a".repeat(64), all: true }],
  ])
    assert.throws(() => validateCommand(method, args));
});

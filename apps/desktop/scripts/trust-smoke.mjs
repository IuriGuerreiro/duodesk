import electron from "electron";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const directory = await mkdtemp(path.join(tmpdir(), "duodesk-trust-smoke-"));
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const env = {
  ...process.env,
  DUODESK_TRUST_SMOKE_DIR: directory,
  DUODESK_TRUST_SMOKE_KEY: privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString(),
};
delete env.ELECTRON_RUN_AS_NODE;
try {
  const phases =
    process.platform === "linux"
      ? ["insecure", "enroll", "restart"]
      : ["enroll", "restart"];
  for (const phase of phases) {
    await new Promise((resolve, reject) => {
      const flags = phase === "insecure" ? ["--password-store=basic"] : [];
      const child = spawn(
        electron,
        [...flags, "scripts/trust-smoke-app.mjs", phase],
        {
          env,
          stdio: "inherit",
        },
      );
      const timer = setTimeout(() => child.kill(), 45000);
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Trusted UI ${phase} failed: ${code}`));
      });
    });
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

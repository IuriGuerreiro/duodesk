import { execFileSync } from "node:child_process";
import path from "node:path";
execFileSync(
  "cargo",
  [
    "build",
    "--locked",
    "--manifest-path",
    "src-tauri/signaling/Cargo.toml",
    "--features",
    "test-storage",
    "--bin",
    "duodesk-host",
  ],
  { stdio: "inherit" },
);
const target = process.env.CARGO_TARGET_DIR ?? "src-tauri/signaling/target";
execFileSync(process.execPath, ["--test", "test/trust.integration.mjs"], {
  stdio: "inherit",
  env: {
    ...process.env,
    DUODESK_TEST_HOST: path.resolve(
      target,
      "debug",
      `duodesk-host${process.platform === "win32" ? ".exe" : ""}`,
    ),
  },
});

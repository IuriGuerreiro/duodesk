import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
const manifest = "src-tauri/signaling/Cargo.toml";
execFileSync(
  "cargo",
  [
    "build",
    "--locked",
    "--release",
    "--manifest-path",
    manifest,
    "--bin",
    "duodesk-host",
  ],
  { stdio: "inherit" },
);
mkdirSync("bin", { recursive: true });
const name = `duodesk-host${process.platform === "win32" ? ".exe" : ""}`;
copyFileSync(`src-tauri/signaling/target/release/${name}`, `bin/${name}`);

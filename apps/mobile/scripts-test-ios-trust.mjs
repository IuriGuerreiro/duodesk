import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
if (process.platform !== "darwin")
  throw new Error(
    "Swift trust tests require macOS and Xcode command-line tools.",
  );
const dir = mkdtempSync(path.join(tmpdir(), "duodesk-swift-trust-"));
const root = "modules/test-video/ios";
try {
  const output = path.join(dir, "trust-tests");
  execFileSync(
    "swiftc",
    [
      "TrustIdentity.swift",
      "TrustEnrollment.swift",
      "TrustWaitingLink.swift",
      "TrustManager.swift",
      "PinnedSignaling.swift",
      "tests/TrustTests.swift",
    ]
      .map((f) => path.join(root, f))
      .concat(["-o", output]),
    { stdio: "inherit" },
  );
  execFileSync(
    output,
    [path.resolve("../../packages/protocol/test/vectors/trust-v1.json")],
    { stdio: "inherit" },
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

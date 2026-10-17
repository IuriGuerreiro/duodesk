import { test } from "node:test";
import assert from "node:assert/strict";
import { Host } from "../electron/host.mjs";
import path from "node:path";
import { once } from "node:events";
import net from "node:net";
test("native transport lists interfaces, rejects remote bind and exits on close", async () => {
  const host = new Host(
    path.resolve(
      `bin/duodesk-host${process.platform === "win32" ? ".exe" : ""}`,
    ),
    () => {},
    () => {},
  );
  try {
    assert.ok(Array.isArray(await host.request("stream_interfaces")));
    await assert.rejects(
      host.request("stream_start", { ip: "203.0.113.1" }),
      /local IPv4/,
    );
    await host.request("stream_stop");
    const ips = await host.request("stream_interfaces");
    if (ips.length) {
      const invitation = await host.request("stream_start", { ip: ips[0] });
      const url = new URL(invitation.url);
      const exited = once(host.child, "exit");
      host.close();
      await exited;
      await new Promise((resolve, reject) => {
        const socket = net.connect({
          host: url.hostname,
          port: Number(url.port),
        });
        socket.once("connect", () => {
          socket.destroy();
          reject(new Error("Signaling port leaked"));
        });
        socket.once("error", resolve);
      });
    }
  } finally {
    host.close();
  }
});
test("unexpected native exit reports failure once and rejects later commands", async () => {
  let failures = 0;
  const host = new Host(
    path.resolve(
      `bin/duodesk-host${process.platform === "win32" ? ".exe" : ""}`,
    ),
    () => {},
    () => {
      failures++;
    },
  );
  try {
    await host.request("stream_interfaces");
    const exited = once(host.child, "exit");
    host.child.kill();
    await exited;
    assert.equal(failures, 1);
    assert.equal(host.closed, true);
    await assert.rejects(host.request("stream_interfaces"), /unavailable/);
  } finally {
    host.close();
  }
});

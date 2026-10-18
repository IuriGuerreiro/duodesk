import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import net from "node:net";
import tls from "node:tls";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { Host } from "../electron/host.mjs";
import {
  createPairingClient,
  createPairingServer,
} from "../../../packages/protocol/src/pairing.ts";

// Real Rust sidecar + production SRP roles + actual local TCP and TLS sockets.
test(
  "Electron host relays PAKE, recovers certificate pin, consumes code and cancels sockets",
  { timeout: 20000 },
  async () => {
    let info;
    const serve = await createPairingServer("012345");
    const events = [];
    const replies = [];
    const host = new Host(
      path.resolve(
        `bin/duodesk-host${process.platform === "win32" ? ".exe" : ""}`,
      ),
      (event) => {
        events.push(event);
        if (event.kind === "pairing") {
          replies.push(
            serve(event.requestId, event.message, info)
              .then((reply) =>
                host.request("stream_pair_reply", {
                  reply: { requestId: event.requestId, ...reply },
                }),
              )
              .catch(() =>
                host.request("stream_pair_reply", {
                  reply: {
                    requestId: event.requestId,
                    message: "",
                    complete: false,
                  },
                }),
              ),
          );
        }
      },
      () => {},
    );
    let socket;
    let secure;
    try {
      const addresses = await host.request("stream_interfaces");
      const ip = addresses.find((a) => a.selectable)?.address;
      assert.ok(ip, "Integration requires a private LAN interface");
      const connection = await host.request("stream_start", { ip });
      info = connection.invitation;
      const [hostname, port] = connection.address.split(":");
      async function open() {
        socket = net.connect({ host: hostname, port: Number(port) });
        await once(socket, "connect");
        return createInterface({ input: socket })[Symbol.asyncIterator]();
      }
      // Wrong proof closes this attempt while allowing a fresh connection.
      let lines = await open();
      let client = createPairingClient("999999", connection.address);
      socket.write(client.hello + "\n");
      socket.write((await client.challenge((await lines.next()).value)) + "\n");
      assert.equal((await lines.next()).done, true);
      lines = await open();
      client = createPairingClient("012345", connection.address);
      socket.write(client.hello + "\n");
      socket.write((await client.challenge((await lines.next()).value)) + "\n");
      const recovered = JSON.parse(
        await client.finish((await lines.next()).value),
      );
      assert.deepEqual(recovered, info);
      socket.destroy();
      await Promise.all(replies);
      // Confirm the actual TLS server certificate matches the authenticated encrypted pin.
      const url = new URL(recovered.url);
      secure = tls.connect({
        host: url.hostname,
        port: Number(url.port),
        rejectUnauthorized: false,
      });
      // This test accepts the fresh self-signed chain only to assert its exact pin below.
      await once(secure, "secureConnect");
      assert.equal(
        createHash("sha256")
          .update(secure.getPeerCertificate().raw)
          .digest("hex"),
        recovered.fingerprint,
      );
      assert.ok(
        events.some((e) => e.kind === "pairingstatus" && e.status === "used"),
      );
      await assert.rejects(
        new Promise((resolve, reject) => {
          const retry = net.connect({ host: hostname, port: Number(port) });
          retry.once("connect", () => {
            retry.destroy();
            resolve();
          });
          retry.once("error", reject);
        }),
      );
      const closed = once(secure, "close");
      await host.request("stream_stop");
      await closed;
    } finally {
      socket?.destroy();
      secure?.destroy();
      host.close();
    }
  },
);

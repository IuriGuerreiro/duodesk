import tls from "node:tls";
import { randomBytes, createHash } from "node:crypto";
import { once } from "node:events";
import assert from "node:assert/strict";

/** Small test-only WebSocket client. The caller asserts the TLS identity before any HTTP or secrets. */
export async function pinnedSocket(url, verify) {
  const target = new URL(url);
  const socket = tls.connect({
    host: target.hostname,
    port: Number(target.port),
    rejectUnauthorized: false,
  });
  socket.on("error", () => {});
  try {
    await once(socket, "secureConnect");
    verify(socket.getPeerCertificate());
  } catch (error) {
    socket.destroy();
    throw error;
  }
  const key = randomBytes(16).toString("base64");
  let buffer = Buffer.alloc(0),
    upgraded = false,
    ended = false;
  const messages = [],
    waiters = [];
  const next = () =>
    messages.length
      ? Promise.resolve(messages.shift())
      : ended
        ? Promise.reject(new Error("Socket closed"))
        : new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              const i = waiters.findIndex((w) => w.resolve === resolve);
              if (i >= 0) waiters.splice(i, 1);
              reject(new Error("Message timeout"));
            }, 5000);
            waiters.push({ resolve, reject, timer });
          });
  const deliver = (value) => {
    const waiter = waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    } else messages.push(value);
  };
  const frame = (payload, opcode = 1) => {
    const mask = randomBytes(4),
      head = Buffer.alloc(payload.length < 126 ? 2 : 4);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | (payload.length < 126 ? payload.length : 126);
    if (payload.length >= 126) head.writeUInt16BE(payload.length, 2);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    socket.write(Buffer.concat([head, mask, masked]));
  };
  const closed = new Promise((resolve) =>
    socket.once("close", () => {
      ended = true;
      for (const w of waiters.splice(0)) {
        clearTimeout(w.timer);
        w.reject(new Error("Socket closed"));
      }
      resolve();
    }),
  );
  socket.on("data", (data) => {
    buffer = Buffer.concat([buffer, data]);
    if (!upgraded) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buffer.subarray(0, end).toString();
      buffer = buffer.subarray(end + 4);
      assert.match(head, /^HTTP\/1.1 101 /);
      assert.ok(
        head.toLowerCase().includes(
          `sec-websocket-accept: ${createHash("sha1")
            .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
            .digest("base64")}`.toLowerCase(),
        ),
      );
      upgraded = true;
    }
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 15;
      let size = buffer[1] & 127,
        offset = 2;
      assert.ok(buffer[0] & 0x80);
      assert.equal(buffer[1] & 0x80, 0);
      assert.notEqual(size, 127);
      if (size === 126) {
        if (buffer.length < 4) return;
        size = buffer.readUInt16BE(2);
        offset = 4;
      }
      if (buffer.length < offset + size) return;
      const payload = buffer.subarray(offset, offset + size);
      buffer = buffer.subarray(offset + size);
      if (opcode === 1) deliver(JSON.parse(payload.toString()));
      else if (opcode === 9) frame(payload, 10);
      else if (opcode === 8) {
        socket.end();
        return;
      }
    }
  });
  socket.write(
    `GET / HTTP/1.1\r\nHost: ${target.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  return {
    send: (value) => frame(Buffer.from(JSON.stringify(value))),
    next,
    closed,
    close: () => socket.destroy(),
  };
}

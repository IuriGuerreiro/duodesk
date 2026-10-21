import tls from "node:tls";
import { createHash, randomBytes } from "node:crypto";

export async function openPinnedWebSocket(url, fingerprint) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "wss:") throw new Error("TLS required");
  const socket = tls.connect({
    host: endpoint.hostname,
    port: Number(endpoint.port),
    rejectUnauthorized: false,
  });
  let buffer = Buffer.alloc(0);
  let ready = false;
  let ended = false;
  const messages = [];
  const readers = [];
  const flush = () => {
    while (readers.length && (messages.length || ended)) {
      const reader = readers.shift();
      clearTimeout(reader.timer);
      reader.resolve(messages.length ? messages.shift() : null);
    }
  };
  const key = randomBytes(16).toString("base64");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("WebSocket handshake timeout"));
    }, 5000);
    socket.once("secureConnect", () => {
      if (
        createHash("sha256")
          .update(socket.getPeerCertificate().raw)
          .digest("hex") !== fingerprint
      ) {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error("Certificate pin mismatch"));
        return;
      }
      socket.write(
        `GET ${endpoint.pathname} HTTP/1.1\r\nHost: ${endpoint.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
      ended = true;
      flush();
    });
    socket.on("close", () => {
      ended = true;
      flush();
      if (!ready) {
        clearTimeout(timer);
        reject(new Error("Closed before upgrade"));
      }
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!ready) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const headers = buffer.subarray(0, end).toString();
        const accept = createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
          .digest("base64");
        if (!headers.startsWith("HTTP/1.1 101") || !headers.includes(accept)) {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error("Invalid upgrade"));
          return;
        }
        buffer = buffer.subarray(end + 4);
        ready = true;
        clearTimeout(timer);
        resolve();
      }
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15;
        let length = buffer[1] & 127;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        }
        if (length === 127 || buffer[1] & 128 || length > 65535) {
          socket.destroy();
          return;
        }
        if (buffer.length < offset + length) return;
        const payload = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        if (opcode === 1) messages.push(JSON.parse(payload.toString()));
        else if (opcode === 8) {
          ended = true;
          socket.end();
        }
        flush();
      }
    });
  });
  return {
    send(value) {
      const payload = Buffer.from(JSON.stringify(value));
      const mask = randomBytes(4);
      const head = Buffer.alloc(payload.length < 126 ? 2 : 4);
      head[0] = 0x81;
      if (payload.length < 126) head[1] = 0x80 | payload.length;
      else {
        head[1] = 0xfe;
        head.writeUInt16BE(payload.length, 2);
      }
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
      socket.write(Buffer.concat([head, mask, masked]));
    },
    next(timeoutMs = 5000) {
      if (messages.length) return Promise.resolve(messages.shift());
      if (ended) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        const reader = {
          resolve,
          timer: setTimeout(() => {
            readers.splice(readers.indexOf(reader), 1);
            reject(new Error("WebSocket read timeout"));
          }, timeoutMs),
        };
        readers.push(reader);
      });
    },
    close() {
      socket.destroy();
    },
  };
}

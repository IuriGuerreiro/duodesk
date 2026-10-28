import { spawn } from "node:child_process";
export class Host {
  pending = new Map();
  sequence = 0;
  buffer = "";
  closed = false;
  constructor(binary, emit, failed, dataDir) {
    this.onFailure = failed;
    this.child = spawn(binary, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: dataDir
        ? { ...process.env, DUODESK_DATA_DIR: dataDir }
        : process.env,
    });
    this.child.stderr.on("data", () => {});
    this.child.stdin.on("error", () => this.close(true));
    this.child.on("error", () => this.close(true));
    this.child.on("exit", () => this.close(true));
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString();
      if (this.buffer.length > 140_000) return this.close(true);
      let end;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        try {
          const value = JSON.parse(line);
          if (value.event) emit(value.event);
          else {
            const pending = this.pending.get(value.id);
            if (!pending) continue;
            this.pending.delete(value.id);
            clearTimeout(pending.timer);
            if (value.error) pending.reject(new Error(value.error));
            else pending.resolve(value.result);
          }
        } catch {
          this.close(true);
        }
      }
    });
  }
  request(method, args) {
    if (
      this.pending.size >= 16 ||
      this.child.killed ||
      this.child.exitCode !== null
    )
      return Promise.reject(new Error("Desktop host unavailable or busy"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.close(true);
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(
        JSON.stringify({ id, method, args }) + "\n",
        (error) => {
          if (error) this.close();
        },
      );
    });
  }
  close(unexpected = false) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Desktop signaling host stopped"));
    }
    this.pending.clear();
    this.child.stdin.end();
    this.child.kill();
    if (unexpected) this.onFailure();
  }
}
/** Signal fields by type the desktop may send, per direction. Mirrors SIGNAL_ROUTES[direction].desktop in @duodesk/protocol. */
export const DESKTOP_SENDS = {
  "phone-to-desktop": {
    answer: ["sdp"],
    candidate: ["candidate", "sdpMid", "sdpMLineIndex"],
    stop: [],
  },
  "desktop-to-phone": {
    offer: ["sdp"],
    candidate: ["candidate", "sdpMid", "sdpMLineIndex"],
    stop: [],
  },
};
export function validateCommand(method, args, direction) {
  if (method.startsWith("trust_")) {
    const fields = {
      trust_status: [],
      trust_rename: ["deviceId", "name"],
      trust_forget: ["deviceId"],
      trust_endpoint: ["ip"],
      trust_enroll: ["action", "name?"],
      trust_connect: ["deviceId", "direction"],
      trust_respond: ["requestId", "accept"],
      trust_cancel: ["requestId"],
      trust_ready: ["requestId"],
      trust_start: ["requestId"],
    }[method];
    if (!fields) throw new Error("Unknown trust command");
    const value = args ?? {};
    if (typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid trust arguments");
    const required = fields.filter((f) => !f.endsWith("?"));
    if (
      !required.every((f) => Object.hasOwn(value, f)) ||
      Object.keys(value).some(
        (f) => !fields.includes(f) && !fields.includes(`${f}?`),
      )
    )
      throw new Error("Invalid trust fields");
    for (const [key, v] of Object.entries(value)) {
      if (key === "accept") {
        if (typeof v !== "boolean") throw new Error("Invalid acceptance");
      } else if (key === "ip" && v === null) {
        /* Explicitly turn off the endpoint. */
      } else if (typeof v !== "string" || v.length > 256)
        throw new Error("Invalid trust value");
    }
    if (value.direction && !Object.hasOwn(DESKTOP_SENDS, value.direction))
      throw new Error("Invalid direction");
    if (value.requestId && !/^[a-f0-9]{32}$/.test(value.requestId))
      throw new Error("Invalid request");
    return;
  }
  if (method === "stream_interfaces" || method === "stream_stop") {
    if (args !== undefined) throw new Error("Unexpected arguments");
  } else if (method === "stream_start") {
    if (
      !args ||
      Object.keys(args).sort().join() !== "direction,ip" ||
      typeof args.ip !== "string" ||
      !/^\d{1,3}(\.\d{1,3}){3}$/.test(args.ip) ||
      !Object.hasOwn(DESKTOP_SENDS, args.direction)
    )
      throw new Error("Invalid stream request");
  } else if (method === "stream_pair_reply") {
    const reply = args?.reply;
    if (
      !args ||
      Object.keys(args).join() !== "reply" ||
      !reply ||
      Object.keys(reply).sort().join() !== "complete,message,requestId" ||
      typeof reply.requestId !== "string" ||
      !/^[a-f0-9]{32}$/.test(reply.requestId) ||
      typeof reply.message !== "string" ||
      Buffer.byteLength(reply.message) > 8192 ||
      reply.message.includes("\n") ||
      typeof reply.complete !== "boolean"
    )
      throw new Error("Invalid pairing reply");
  } else if (method === "stream_send") {
    if (
      !args ||
      Object.keys(args).join() !== "signal" ||
      JSON.stringify(args).length > 66_000
    )
      throw new Error("Invalid signal");
    const s = args.signal;
    if (
      !s ||
      s.v !== 1 ||
      typeof s.sessionId !== "string" ||
      !/^[a-f0-9]{32}$/.test(s.sessionId)
    )
      throw new Error("Invalid session");
    const fields = DESKTOP_SENDS[direction]?.[s.type];
    if (
      !fields ||
      Object.keys(s).sort().join() !==
        ["v", "sessionId", "type", ...fields].sort().join()
    )
      throw new Error("Invalid signal fields");
    if (
      (s.type === "answer" || s.type === "offer") &&
      (typeof s.sdp !== "string" || !s.sdp.length || s.sdp.length > 60_000)
    )
      throw new Error("Invalid SDP");
    if (
      s.type === "candidate" &&
      (typeof s.candidate !== "string" ||
        !s.candidate.length ||
        s.candidate.length > 8192 ||
        !(
          s.sdpMid === null ||
          (typeof s.sdpMid === "string" && s.sdpMid.length <= 256)
        ) ||
        !Number.isInteger(s.sdpMLineIndex) ||
        s.sdpMLineIndex < 0 ||
        s.sdpMLineIndex > 32)
    )
      throw new Error("Invalid candidate");
  } else throw new Error("Unknown command");
}

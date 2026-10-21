import { secureStorageReason } from "./trust-store.mjs";

export class TrustBackend {
  enabled = false;
  pending = [];
  configured = null;
  constructor(store, emit) {
    this.store = store;
    this.emit = emit;
  }
  reset() {
    this.enabled = false;
    this.pending = [];
    this.configured = null;
  }
  status() {
    const reason =
      this.store.reason ??
      secureStorageReason(this.store.storage, this.store.platform);
    return {
      available: reason === null,
      reason,
      enabled: this.enabled,
      address: this.store.data?.address ?? null,
      fingerprint: this.store.fingerprint(),
      devices: this.store.data?.devices ?? [],
      pending: this.pending,
    };
  }
  changed() {
    this.emit({ kind: "trust_status", status: this.status() });
  }
  async configure(host, ip) {
    if (this.configured === host) return;
    await this.store.initialize(() => host.request("identity_generate"));
    const data = this.store.data;
    await host.request("trust_configure", {
      identity: data.identity,
      devices: data.devices,
      address: data.address ?? `${ip}:${data.port}`,
    });
    this.configured = host;
  }
  async beforeStart(host, ip) {
    if (!this.status().available) return;
    try {
      await this.configure(host, ip);
    } catch {
      this.store.reason =
        "Trusted device persistence is unavailable. Ordinary pairing is still available.";
      this.enabled = false;
      this.changed();
    }
  }
  async command(host, method, args) {
    if (method === "trust_status") {
      if (this.configured === host)
        this.pending = await host.request("trust_pending");
      return this.status();
    }
    try {
      if (
        !this.status().available &&
        method !== "trust_revoke" &&
        !(method === "trust_allow" && !args.allow)
      )
        throw new Error(this.status().reason);
      if (method === "trust_allow") {
        if (!args.allow && this.configured !== host) {
          this.enabled = false;
          this.changed();
          return this.status();
        }
        await this.configure(host, args.ip);
        this.enabled = false;
        try {
          const result = await host.request("trust_allow", {
            ...args,
            port: this.store.data.port,
          });
          if (args.allow) {
            const port = Number(result.address.split(":").at(-1));
            await this.store.save({
              ...this.store.data,
              address: result.address,
              port,
            });
            this.enabled = true;
          }
        } catch (error) {
          await host
            .request("trust_allow", {
              ...args,
              allow: false,
              port: this.store.data.port,
            })
            .catch(() => host.close(true));
          this.changed();
          throw error;
        }
      } else if (method === "trust_approve") {
        if (this.configured !== host) throw new Error("No enrollment pending");
        if (args.approve) {
          const phone = await host.request("trust_pending_phone", {
            requestId: args.requestId,
          });
          const devices = this.store.data.devices.filter(
            (p) => p.phoneId !== phone.phoneId,
          );
          devices.push(phone);
          await this.store.save({ ...this.store.data, devices });
          await host.request("trust_update", { devices });
        }
        await host.request("trust_decide", args);
        this.pending = await host.request("trust_pending");
      } else if (method === "trust_revoke") {
        const data = this.store.data;
        if (!data) return this.status();
        const devices = data.devices.filter((p) => p.phoneId !== args.phoneId);
        // Remove in-memory authorization before disk I/O can delay revocation.
        if (this.configured === host)
          await host.request("trust_update", { devices });
        try {
          await this.store.save({ ...data, devices });
        } catch (error) {
          host.close(true);
          this.reset();
          throw error;
        }
      }
      this.changed();
      return this.status();
    } catch (error) {
      if (this.store.reason) {
        this.enabled = false;
        if (this.configured === host) {
          await host
            .request("trust_allow", {
              ip: "0.0.0.0",
              allow: false,
              port: this.store.data.port,
            })
            .catch(() => host.close(true));
        }
        this.changed();
      }
      throw error;
    }
  }

  onEvent(event, host) {
    if (event.kind === "trust_enrollment") {
      this.pending = [
        ...this.pending.filter((p) => p.requestId !== event.request.requestId),
        event.request,
      ];
      this.emit(event);
      this.changed();
      return true;
    }
    if (event.kind === "trust_pending_changed") {
      void host
        .request("trust_pending")
        .then((pending) => {
          if (this.configured === host) {
            this.pending = pending;
            this.changed();
          }
        })
        .catch(() => {});
      return true;
    }
    return false;
  }
}

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { BigInteger } from "../src/features/pairing/srp-integer.ts";

const require = createRequire(import.meta.url);
const protocolRequire = createRequire(
  require.resolve("@duodesk/protocol/pairing"),
);
const srpRequire = createRequire(protocolRequire.resolve("@swan-io/srp"));
const { BigInteger: Reference } = srpRequire("jsbn");
const hex = (size) => randomBytes(size).toString("hex");

test("native integers match SRP's jsbn backend, including negative session bases", () => {
  for (let run = 0; run < 12; run += 1) {
    const inputs = [hex(256), hex(256), hex(run % 2 === 0 ? 32 : 64), hex(256)];
    const [a, b, exponent, modulus] = inputs.map((v) => new BigInteger(v, 16));
    const [ra, rb, re, rm] = inputs.map((v) => new Reference(v, 16));
    for (const operation of ["add", "subtract", "multiply", "xor", "mod"]) {
      assert.equal(
        a[operation](b).toString(16),
        ra[operation](rb).toString(16),
        operation,
      );
    }
    assert.equal(
      a.modPow(exponent, modulus).toString(16),
      ra.modPow(re, rm).toString(16),
    );
    const negative = a.subtract(b.multiply(a));
    const referenceNegative = ra.subtract(rb.multiply(ra));
    assert.equal(
      negative.mod(modulus).toString(16),
      referenceNegative.mod(rm).toString(16),
    );
    assert.equal(
      negative.modPow(exponent, modulus).toString(16),
      referenceNegative.modPow(re, rm).toString(16),
    );
  }
});

test("SRP zero, equality and hexadecimal padding inputs preserve jsbn behavior", () => {
  for (const value of ["0", "00", "000001", "ff", "a".repeat(512)]) {
    const native = new BigInteger(value, 16);
    const reference = new Reference(value, 16);
    assert.equal(native.toString(16), reference.toString(16));
    assert.equal(native.equals(new BigInteger(value, 16)), true);
    assert.equal(
      native.equals(new BigInteger(0n)),
      reference.equals(new Reference("0")),
    );
    assert.equal(
      native.modPow(new BigInteger(0n), new BigInteger(17n)).toString(),
      "1",
    );
  }
});

// Load the actual SRP library with only its integer dependency substituted.
// This checks compatibility against the unchanged desktop implementation.
test("Android arithmetic authenticates with the unchanged SRP implementation in both roles", async () => {
  const { readFileSync } = await import("node:fs");
  const original = srpRequire("@swan-io/srp");
  const substituted = { exports: {} };
  const load = new Function(
    "require",
    "module",
    "exports",
    readFileSync(protocolRequire.resolve("@swan-io/srp"), "utf8"),
  );
  load(
    (name) => (name === "jsbn" ? { BigInteger } : srpRequire(name)),
    substituted,
    substituted.exports,
  );
  for (const [clientLibrary, serverLibrary] of [
    [substituted.exports, original],
    [original, substituted.exports],
  ]) {
    const client = clientLibrary.createSRPClient("SHA-256", 2048);
    const server = serverLibrary.createSRPServer("SHA-256", 2048);
    const salt = client.generateSalt();
    const key = await client.derivePrivateKey(
      salt,
      "duodesk-pair-v1",
      "012345",
    );
    const verifier = client.deriveVerifier(key);
    const clientEphemeral = client.generateEphemeral();
    const serverEphemeral = await server.generateEphemeral(verifier);
    const clientSession = await client.deriveSession(
      clientEphemeral.secret,
      serverEphemeral.public,
      salt,
      "duodesk-pair-v1",
      key,
    );
    const serverSession = await server.deriveSession(
      serverEphemeral.secret,
      clientEphemeral.public,
      salt,
      "duodesk-pair-v1",
      verifier,
      clientSession.proof,
    );
    assert.equal(clientSession.key, serverSession.key);
    await client.verifySession(
      clientEphemeral.public,
      clientSession,
      serverSession.proof,
    );
    await assert.rejects(
      client.verifySession(
        clientEphemeral.public,
        clientSession,
        "0".repeat(64),
      ),
    );
    await assert.rejects(
      server.deriveSession(
        serverEphemeral.secret,
        clientEphemeral.public,
        salt,
        "duodesk-pair-v1",
        verifier,
        "0".repeat(64),
      ),
    );
    await assert.rejects(
      client.deriveSession(
        clientEphemeral.secret,
        "0".repeat(512),
        salt,
        "duodesk-pair-v1",
        key,
      ),
    );
  }
});

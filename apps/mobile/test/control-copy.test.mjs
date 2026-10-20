import test from "node:test";
import assert from "node:assert/strict";
import { controlCopy } from "../src/features/stream-sender/session-copy.ts";

test("nothing is offered before a screen session reports control", () => {
  assert.equal(controlCopy(undefined), undefined);
  assert.equal(
    controlCopy({ state: "off", reason: "unsupported", serviceEnabled: false }),
    undefined,
  );
});

test("a disabled accessibility service sends the owner to settings, not to Allow", () => {
  const copy = controlCopy({
    state: "off",
    reason: "service-disabled",
    serviceEnabled: false,
  });
  assert.equal(copy?.action, "settings");
  assert.match(copy?.detail ?? "", /cannot read your screen/);
  assert.match(copy?.detail ?? "", /does not give your PC control yet/);
});

test("an enabled service still needs an explicit per-session Allow", () => {
  const copy = controlCopy({
    state: "off",
    reason: "not-allowed",
    serviceEnabled: true,
  });
  assert.equal(copy?.action, "allow");
  assert.match(copy?.detail ?? "", /this screen share only/);
});

test("after a stop or an unknown screen size the owner is told why", () => {
  assert.match(
    controlCopy({ state: "off", reason: "revoked", serviceEnabled: true })
      ?.detail ?? "",
    /^Control was stopped/,
  );
  assert.match(
    controlCopy({
      state: "off",
      reason: "geometry-unknown",
      serviceEnabled: true,
    })?.detail ?? "",
    /screen size could not be confirmed/,
  );
});

test("while on, the only action is to stop", () => {
  const copy = controlCopy({ state: "on", serviceEnabled: true });
  assert.equal(copy?.state, "on");
  assert.equal(copy?.action, "stop");
});

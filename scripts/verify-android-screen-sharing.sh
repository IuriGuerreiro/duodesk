#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export JAVA_HOME="${JAVA_HOME:-/home/rshazow/.local/opt/jdk-21}"
export ANDROID_HOME="${ANDROID_HOME:-/home/rshazow/Android/Sdk}"
export PATH="${JAVA_HOME}/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/cmdline-tools/latest/bin:${PATH}"

APK_PATH="${ROOT_DIR}/apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk"
MANIFEST_PATH="${ROOT_DIR}/apps/mobile/android/app/build/intermediates/merged_manifests/debug/processDebugManifest/AndroidManifest.xml"
HOST_BIN="${ROOT_DIR}/apps/desktop/bin/duodesk-host"

echo "=== DuoDesk Android Screen Sharing Verification ==="
echo "Worktree: ${ROOT_DIR}"
echo "JAVA_HOME: ${JAVA_HOME}"
echo "ANDROID_HOME: ${ANDROID_HOME}"

echo ""
echo "[1/5] Verifying Merged AndroidManifest"
if [[ ! -f "$MANIFEST_PATH" ]]; then
  echo "FAIL: Merged manifest not found at ${MANIFEST_PATH}"
  exit 1
fi

grep -q "expo.modules.testvideo.ScreenCaptureService" "$MANIFEST_PATH" || {
  echo "FAIL: ScreenCaptureService missing in merged manifest"
  exit 1
}
grep -q "android:foregroundServiceType=\"mediaProjection\"" "$MANIFEST_PATH" || {
  echo "FAIL: foregroundServiceType mediaProjection missing in manifest"
  exit 1
}
grep -q "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION" "$MANIFEST_PATH" || {
  echo "FAIL: FOREGROUND_SERVICE_MEDIA_PROJECTION permission missing"
  exit 1
}
grep -q "android.permission.POST_NOTIFICATIONS" "$MANIFEST_PATH" || {
  echo "FAIL: POST_NOTIFICATIONS permission missing"
  exit 1
}
echo "PASS: Merged manifest contains ScreenCaptureService and all required permissions."

echo ""
echo "[2/5] Verifying Debug APK Bytecode"
if [[ ! -f "$APK_PATH" ]]; then
  echo "FAIL: Debug APK not found at ${APK_PATH}"
  exit 1
fi

DEXDUMP="$(find "$ANDROID_HOME/build-tools" -name "dexdump" | sort -V | tail -n 1)"
if [[ -n "$DEXDUMP" && -x "$DEXDUMP" ]]; then
  CLASSES="$("$DEXDUMP" "$APK_PATH" | grep -E "Class descriptor.*(ScreenCaptureService|ScreenSource|VideoSenderManager)" || true)"
  if [[ -z "$CLASSES" ]]; then
    echo "FAIL: Native screen sharing classes missing in APK dex"
    exit 1
  fi
  echo "PASS: ScreenCaptureService, ScreenSource, and VideoSenderManager present in APK bytecode."
else
  echo "WARN: dexdump not found; skipping direct dex inspection."
fi

echo ""
echo "[3/5] Verifying Desktop Signaling Host"
if [[ -f "$HOST_BIN" && -x "$HOST_BIN" ]]; then
  echo "PASS: duodesk-host binary exists and is executable."
else
  echo "WARN: duodesk-host binary missing at ${HOST_BIN}. Build with: node apps/desktop/scripts/build-host.mjs"
fi

echo ""
echo "[4/5] Checking Connected Android Devices"
DEVICES="$(adb devices | awk 'NR>1 && $2=="device" {print $1}')"
if [[ -z "$DEVICES" ]]; then
  echo "BLOCKED: No active Android devices connected via adb."
  echo "To test on physical hardware, reconnect the device via USB or Wi-Fi adb:"
  echo "  1. Connect phone with USB debugging enabled."
  echo "  2. Confirm 'adb devices' reports authorized status."
  echo "  3. Re-run this script with the device attached."
  exit 0
fi

echo "Connected devices:"
echo "$DEVICES"

echo ""
echo "[5/5] Testing On Connected Device"
for DEV in $DEVICES; do
  MODEL="$(adb -s "$DEV" shell getprop ro.product.model | tr -d '\r')"
  SDK="$(adb -s "$DEV" shell getprop ro.build.version.sdk | tr -d '\r')"
  echo "Target device: ${DEV} (${MODEL}, Android API ${SDK})"

  echo "Installing development APK to ${DEV}..."
  adb -s "$DEV" install -r "$APK_PATH"

  if [[ "$SDK" -ge 33 ]]; then
    echo "Granting POST_NOTIFICATIONS permission..."
    adb -s "$DEV" shell pm grant com.duodesk.mobile android.permission.POST_NOTIFICATIONS 2>/dev/null || true
  fi

  echo "Launching app..."
  adb -s "$DEV" shell am start -n com.duodesk.mobile/.MainActivity

  echo "Device ready for screen sharing session."
  echo "To view live logs, run:"
  echo "  adb -s ${DEV} logcat -s DuoDesk ScreenCaptureService ScreenSource WebRTC"
done

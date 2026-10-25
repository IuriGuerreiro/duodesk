const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");
const path = require("node:path");

const config = getDefaultConfig(__dirname);
// Use Hermes's native BigInt arithmetic for SRP exponentiation on Android.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    platform === "android" &&
    moduleName === "jsbn" &&
    /[/\\]@swan-io[/\\]srp[/\\]/.test(context.originModulePath)
  ) {
    return {
      type: "sourceFile",
      filePath: path.resolve(__dirname, "src/features/pairing/srp-integer.ts"),
    };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = withNativeWind(config, {
  input: "./src/shared/global.css",
  inlineRem: 16,
});

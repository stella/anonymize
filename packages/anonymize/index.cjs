"use strict";

exports.loadNativeBinding = () => {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return require("@stll/anonymize-darwin-arm64");
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return require("@stll/anonymize-darwin-x64");
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return require("@stll/anonymize-linux-arm64-gnu");
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return require("@stll/anonymize-linux-x64-gnu");
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return require("@stll/anonymize-win32-x64-msvc");
  }
  throw new Error(
    `No native anonymize binding is published for ${process.platform}-${process.arch}`,
  );
};

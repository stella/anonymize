"use strict";

exports.loadNativeBinding = () => {
  if (process.platform === "linux") {
    return require(`@stll/anonymize-linux-${process.arch}-gnu`);
  }
  if (process.platform === "win32") {
    return require(`@stll/anonymize-win32-${process.arch}-msvc`);
  }
  return require(`@stll/anonymize-${process.platform}-${process.arch}`);
};

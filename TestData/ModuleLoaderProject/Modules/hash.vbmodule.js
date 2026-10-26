// Project 声明的 hash 与文件字节不符：module.hashMismatch，且不会执行 bundle。
module.exports = {
  manifest: {
    id: "visualbridge.fixture.hash",
    version: "0.1.0",
    apiVersion: 1,
    editors: ["fixture-hash"],
  },
  activate() {
    throw new Error("hash fixture must never be activated.");
  },
  webviews: {},
};

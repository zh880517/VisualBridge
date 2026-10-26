// 顶层 require 非内置模块：module.loadFailed。
const lodash = require("lodash");

module.exports = {
  manifest: {
    id: "visualbridge.fixture.require",
    version: "0.1.0",
    apiVersion: 1,
    editors: ["fixture-require"],
  },
  activate() {
    return { editors: [] };
  },
  webviews: {},
  lodash,
};

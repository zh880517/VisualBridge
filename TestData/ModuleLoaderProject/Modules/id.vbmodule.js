// manifest.id 与 Project 声明不一致：module.idMismatch。
module.exports = {
  manifest: {
    id: "visualbridge.fixture.other",
    version: "0.1.0",
    apiVersion: 1,
    editors: ["fixture-id"],
  },
  activate() {
    return { editors: [] };
  },
  webviews: {},
};

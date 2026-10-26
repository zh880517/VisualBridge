// activate 返回的 registration 形状非法：module.registrationInvalid。
module.exports = {
  manifest: {
    id: "visualbridge.fixture.registration",
    version: "0.1.0",
    apiVersion: 1,
    editors: ["fixture-registration"],
  },
  activate() {
    return { editors: [{}] };
  },
  webviews: {},
};

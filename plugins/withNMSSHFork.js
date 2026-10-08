const { withPodfile } = require('@expo/config-plugins');

const NMSSH_SOURCE = "pod 'NMSSH', :git => 'https://github.com/speam/NMSSH.git', :branch => 'master'";

module.exports = function withNMSSHFork(config) {
  return withPodfile(config, (config) => {
    const podfile = config.modResults.contents;
    if (podfile.includes("pod 'NMSSH', :git => 'https://github.com/speam/NMSSH.git'")) return config;

    const targetLine = /(^\s*target\s+['"][^\r\n]+?\s+do\s*\r?\n)/m;
    if (!targetLine.test(podfile)) {
      throw new Error('Could not find the iOS app target in the generated Podfile to configure the NMSSH compatibility fork.');
    }
    config.modResults.contents = podfile.replace(targetLine, `$1  ${NMSSH_SOURCE}\n`);
    return config;
  });
};

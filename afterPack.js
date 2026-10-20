const { execSync } = require("child_process");
const path = require("path");

// 정식 서명 인증서(유료 개발자 계정)가 없으므로, Apple Silicon에서 서명 없는 앱이
// "손상되어 열 수 없습니다" 오류로 실행이 막히는 것을 막기 위해 앱 번들 전체를
// ad-hoc 서명한다. (정식 서명/공증은 아니며, 사용자는 첫 실행 시 우클릭→열기가 필요하다.)
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, {
    stdio: "inherit",
  });
  console.log(`ad-hoc signed: ${appPath}`);
};

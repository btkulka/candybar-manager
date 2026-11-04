// electron-builder afterPack hook. Makes each .dmg's bundled binaries match its
// architecture: ffmpeg-static downloads only the build machine's ffmpeg at
// `npm install`, and ffprobe-static ships every platform's ffprobe (the
// non-Mac ones are already left out by electron-builder.yml's files list).
// Then signs the app ad-hoc, since there's no Developer ID to sign with.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// builder-util's Arch enum → npm's arch name and lipo's.
const ARCH = { 1: { npm: 'x64', lipo: 'x86_64' }, 3: { npm: 'arm64', lipo: 'arm64' } };

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const arch = ARCH[context.arch];
  if (!arch) throw new Error(`after-pack: no binaries for arch ${context.arch}`);
  const appBundle = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const modules = path.join(appBundle, 'Contents', 'Resources', 'app', 'node_modules');

  const probeDarwin = path.join(modules, 'ffprobe-static', 'bin', 'darwin');
  for (const a of fs.readdirSync(probeDarwin)) {
    if (a !== arch.npm) fs.rmSync(path.join(probeDarwin, a), { recursive: true, force: true });
  }

  const ffmpegDir = path.join(modules, 'ffmpeg-static');
  const ffmpeg = path.join(ffmpegDir, 'ffmpeg');
  if (lipoArchs(ffmpeg) !== arch.lipo) {
    fs.rmSync(ffmpeg, { force: true });
    execFileSync(process.execPath, [path.join(ffmpegDir, 'install.js')], {
      cwd: ffmpegDir,
      env: { ...process.env, npm_config_arch: arch.npm, npm_config_platform: 'darwin' },
      stdio: 'inherit',
    });
  }
  const got = lipoArchs(ffmpeg);
  if (got !== arch.lipo) throw new Error(`after-pack: ffmpeg is ${got || 'missing'}, wanted ${arch.lipo}`);

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appBundle], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appBundle], { stdio: 'inherit' });
};

function lipoArchs(file) {
  try {
    return execFileSync('lipo', ['-archs', file], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

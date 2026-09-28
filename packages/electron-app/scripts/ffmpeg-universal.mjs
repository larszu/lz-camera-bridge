/**
 * Makes the ffmpeg of `ffmpeg-static` a universal binary (arm64 + x64).
 *
 * ffmpeg-static downloads only the build machine's architecture. `dist:mac`
 * builds for both; without this step an Intel Mac would get an arm64 ffmpeg
 * and the video tiles would stay black. macOS only (lipo); elsewhere a no-op.
 * Ported from av-control-center.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

if (process.platform !== 'darwin') process.exit(0);

const require = createRequire(import.meta.url);
const target = require('ffmpeg-static');
const dir = dirname(target);
const archs = execFileSync('lipo', ['-archs', target], { encoding: 'utf8' }).trim().split(/\s+/);
if (archs.includes('x86_64') && archs.includes('arm64')) {
  console.log('ffmpeg is already universal.');
  process.exit(0);
}

const parts = [];
for (const arch of ['arm64', 'x64']) {
  const part = join(dir, `ffmpeg-${arch}`);
  rmSync(target, { force: true });
  execFileSync(process.execPath, [join(dir, 'install.js')], {
    cwd: dir,
    stdio: 'inherit',
    env: { ...process.env, npm_config_arch: arch, npm_config_platform: 'darwin' },
  });
  if (!existsSync(target)) throw new Error(`ffmpeg for ${arch} missing after download.`);
  renameSync(target, part);
  parts.push(part);
}
execFileSync('lipo', ['-create', ...parts, '-output', target]);
for (const part of parts) rmSync(part);
console.log(`ffmpeg universal: ${execFileSync('lipo', ['-archs', target], { encoding: 'utf8' }).trim()}`);

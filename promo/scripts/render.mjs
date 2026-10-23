import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
mkdirSync('out', {recursive: true});

function run(command, args) {
  const result = spawnSync(command, args, {stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Rasterize text at 1920 × 1080 and feed lossless PNGs directly to the GIF
// encoder. A compressed H.264 intermediate blurs small math and serif strokes.
const browser = process.env.REMOTION_BROWSER_EXECUTABLE;
const frames = mkdtempSync(path.resolve(root, 'out/frames-'));
run(process.execPath, [
  'node_modules/@remotion/cli/remotion-cli.js', 'render', 'src/index.ts',
  'LatexReview', frames, '--sequence', '--image-format=png',
  '--scale=1.6', '--every-nth-frame=2',
  '--concurrency=4', '--log=error', ...(browser ? [`--browser-executable=${browser}`] : []),
]);

const target = path.resolve(root, '../docs/demo.gif');
const input = ['-framerate', '12', '-pattern_type', 'glob', '-i', path.join(frames, '*.png')];
// A full palette without dithering keeps flat UI surfaces clean and compact.
run('ffmpeg', [
  '-hide_banner', '-loglevel', 'warning', '-y', ...input,
  '-filter_complex',
  '[0:v]split[a][b];' +
  '[a]palettegen=max_colors=256:reserve_transparent=1:stats_mode=full[p];' +
  '[b][p]paletteuse=dither=none:diff_mode=rectangle',
  '-loop', '0', target,
]);
// A separate local MP4 is convenient for playback; it is never a GIF input.
run('ffmpeg', [
  '-hide_banner', '-loglevel', 'warning', '-y', ...input,
  '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', 'out/promo.mp4',
]);
rmSync(frames, {recursive: true});
console.log(`GIF: ${target} (${(statSync(target).size / 1024 / 1024).toFixed(2)} MiB)`);

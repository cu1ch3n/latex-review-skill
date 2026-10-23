import {spawnSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
mkdirSync('out/stills', {recursive: true});
const browser = process.env.REMOTION_BROWSER_EXECUTABLE;
for (const frame of [0, 49, 100, 121, 180, 199, 225, 239]) {
  const result = spawnSync(process.execPath, [
    'node_modules/@remotion/cli/remotion-cli.js', 'still', 'src/index.ts',
    'LatexReview', `out/stills/${frame}.png`, `--frame=${frame}`, '--scale=1.6', '--log=error',
    ...(browser ? [`--browser-executable=${browser}`] : []),
  ], {stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

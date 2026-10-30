// Wrapper around electron-vite that strips ELECTRON_RUN_AS_NODE before spawn.
//
// Why: Playwright (and some test harnesses) set ELECTRON_RUN_AS_NODE=1 to make
// the Electron binary behave as plain Node. If that variable leaks into a
// parent shell, every subsequent `npm run dev` / `npm start` will crash at
// startup with `electron.protocol is undefined` because Electron's API
// surface isn't installed under "run as Node" mode. Stripping it here makes
// our dev/build/start scripts robust to a poisoned shell environment.

import { spawn } from 'child_process';

delete process.env.ELECTRON_RUN_AS_NODE;

const args = process.argv.slice(2);

// On Windows, npm installs `electron-vite` as a `.cmd` shim. Node's spawn()
// can't exec .cmd directly without a shell — that's the EINVAL error. Using
// shell:true makes the shell resolve the binary, which works on both
// platforms.
const child = spawn('electron-vite', args, {
  stdio: 'inherit',
  env: process.env,
  shell: true,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

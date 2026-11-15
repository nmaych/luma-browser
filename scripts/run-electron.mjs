import { spawn } from 'node:child_process';
import electron from 'electron';

// Some IDE sandboxes inherit ELECTRON_RUN_AS_NODE=1. It forces Electron into headless Node mode,
// so the desktop launcher always removes it before starting the real Chromium app.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.'], {
  cwd: import.meta.dirname ? `${import.meta.dirname}/..` : process.cwd(),
  env,
  stdio: 'inherit',
  windowsHide: false,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code) => process.exit(code ?? 0));

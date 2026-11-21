const { execFile } = require('node:child_process');
const { app, shell } = require('electron');

/**
 * Windows default-browser registration.
 *
 * Since Windows 10 a program cannot take the association silently: it may only
 * register itself (ProgID + Capabilities + RegisteredApplications) and then ask
 * the user to confirm in Settings. Browsers that claim otherwise are changing
 * registry keys Windows ignores. `register()` therefore does the legal part and
 * hands the user to `ms-settings:defaultapps`; `status()` reports the truth by
 * reading the UserChoice keys Explorer actually honours.
 */

const PROG_ID = 'LumaBrowser';
const APP_NAME = 'Luma Browser';
const PROG_KEY = `HKCU\\Software\\Classes\\${PROG_ID}`;
const CAPABILITIES_KEY = `HKCU\\Software\\${APP_NAME}\\Capabilities`;
const REGISTERED_KEY = 'HKCU\\Software\\RegisteredApplications';
const USER_CHOICE = {
  http: 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice',
  https: 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
  html: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.html\\UserChoice',
};

function runReg(args) {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        // A missing key is a normal "no" answer; a spawn failure is not.
        spawnFailed: Boolean(error && (error.code === 'EPERM' || error.code === 'ENOENT' || error.code === 'EACCES')),
        code: error?.code ?? 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

async function addValue(key, name, value, type = 'REG_SZ') {
  const args = ['add', key];
  if (name === null) args.push('/ve');
  else args.push('/v', name);
  args.push('/t', type, '/d', value, '/f');
  return runReg(args);
}

/** Reads a value; returns '' when the key or value does not exist. */
async function readValue(key, name) {
  const result = await runReg(['query', key, name === null ? '/ve' : '/v', name]);
  if (result.spawnFailed) return { value: '', blocked: true };
  if (!result.ok) return { value: '', blocked: false };
  // Output looks like: "    http    REG_SZ    ChromeHTML"
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.includes('REG_'));
  if (!line) return { value: '', blocked: false };
  const match = line.trim().match(/\s(REG_[A-Z_]+)\s+(.*)$/);
  return { value: match ? match[2].trim() : '', blocked: false };
}

function executablePath() {
  // The packaged binary is the one Windows must launch; in development this is
  // electron.exe, which cannot boot the app by itself.
  return process.execPath;
}

async function status() {
  const supported = process.platform === 'win32';
  if (!supported) {
    let protocol = false;
    try {
      protocol = app.isDefaultProtocolClient('https');
    } catch {
      protocol = false;
    }
    return {
      supported: false,
      registered: false,
      isDefault: Boolean(protocol),
      canRegister: false,
      reason: '当前系统只支持在应用设置里选择默认浏览器。',
    };
  }
  const [httpsChoice, httpChoice, registered] = await Promise.all([
    readValue(USER_CHOICE.https, 'ProgId'),
    readValue(USER_CHOICE.http, 'ProgId'),
    readValue(REGISTERED_KEY, APP_NAME),
  ]);
  if (httpsChoice.blocked || httpChoice.blocked || registered.blocked) {
    return {
      supported: true,
      registered: false,
      isDefault: false,
      canRegister: Boolean(app.isPackaged),
      exePath: executablePath(),
      reason: '无法访问系统注册表（可能被安全软件拦截），请手动在系统设置中选择默认浏览器。',
    };
  }
  return {
    supported: true,
    registered: registered.value.length > 0,
    // Both protocols must point at this app before claiming the title.
    isDefault: httpsChoice.value === PROG_ID && httpChoice.value === PROG_ID,
    canRegister: Boolean(app.isPackaged),
    exePath: executablePath(),
    reason: app.isPackaged ? '' : '开发模式下注册的会是 Electron 调试程序，请使用安装版。',
  };
}

/** Writes the Capabilities block and opens the system default-apps page. */
async function register() {
  if (process.platform !== 'win32') {
    return { ok: false, error: '当前系统需要在小程序/系统设置中手动选择默认浏览器。', status: await status() };
  }
  if (!app.isPackaged) {
    return { ok: false, error: '开发模式下无法注册为默认浏览器，请在安装版中设置。', status: await status() };
  }
  const exe = executablePath();
  const command = `"${exe}" "%1"`;
  const icon = `${exe},0`;
  const steps = [
    [PROG_KEY, null, APP_NAME, 'REG_SZ'],
    [`${PROG_KEY}\\Application`, 'ApplicationName', APP_NAME, 'REG_SZ'],
    [`${PROG_KEY}\\Application`, 'ApplicationIcon', icon, 'REG_SZ'],
    [`${PROG_KEY}\\Application`, 'ApplicationCompany', APP_NAME, 'REG_SZ'],
    [`${PROG_KEY}\\DefaultIcon`, null, icon, 'REG_SZ'],
    [`${PROG_KEY}\\shell\\open\\command`, null, command, 'REG_SZ'],
    [CAPABILITIES_KEY, 'ApplicationName', APP_NAME, 'REG_SZ'],
    [CAPABILITIES_KEY, 'ApplicationDescription', '轻盈、有序、专注的现代浏览器', 'REG_SZ'],
    [CAPABILITIES_KEY, 'ApplicationIcon', icon, 'REG_SZ'],
    [`${CAPABILITIES_KEY}\\URLAssociations`, 'http', PROG_ID, 'REG_SZ'],
    [`${CAPABILITIES_KEY}\\URLAssociations`, 'https', PROG_ID, 'REG_SZ'],
    [`${CAPABILITIES_KEY}\\FileAssociations`, '.html', PROG_ID, 'REG_SZ'],
    [`${CAPABILITIES_KEY}\\FileAssociations`, '.htm', PROG_ID, 'REG_SZ'],
    [`${CAPABILITIES_KEY}\\StartMenu`, 'StartMenuInternet', `${PROG_ID}.exe`, 'REG_SZ'],
    [REGISTERED_KEY, APP_NAME, `Software\\${APP_NAME}\\Capabilities`, 'REG_SZ'],
  ];
  for (const [key, name, value, type] of steps) {
    const result = await addValue(key, name, value, type);
    if (!result.ok) {
      const reason = result.spawnFailed
        ? '无法调用系统注册命令（可能被安全软件拦截）。'
        : `写入注册表失败：${result.stderr.trim() || key}`;
      return { ok: false, error: reason, status: await status() };
    }
  }
  // Windows requires the user's confirmation in Settings; open it directly.
  const opened = await shell.openExternal('ms-settings:defaultapps').then(() => true).catch(() => false);
  return { ok: true, openedSettings: opened, status: await status() };
}

module.exports = { status, register, PROG_ID };

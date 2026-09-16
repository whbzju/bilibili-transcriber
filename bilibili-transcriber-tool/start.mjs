import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const dir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.BILI_TOOL_PORT || 8719);
const url = `http://127.0.0.1:${port}`;
async function healthy() {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok && (await response.json()).app === 'bilibili-transcriber';
  } catch { return false; }
}
if (!await healthy()) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(`Port ${port} is occupied. Set BILI_TOOL_PORT to another port.`)));
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
  const log = fs.openSync(path.join(dir, 'server.log'), 'a');
  const child = spawn(process.execPath, [path.join(dir, 'server.mjs')], {
    cwd: dir, detached: true, stdio: ['ignore', log, log],
    env: { ...process.env, BILI_TOOL_PORT: String(port), BILI_TOOL_HOST: '127.0.0.1' },
  });
  child.unref();
  fs.closeSync(log);
  for (let attempt = 0; attempt < 30 && !await healthy(); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!await healthy()) throw new Error('Startup failed. See bilibili-transcriber-tool/server.log');
}
console.log(url);
if (process.env.BILI_TOOL_NO_OPEN !== '1') spawn('open', [url], { stdio: 'ignore' }).unref();

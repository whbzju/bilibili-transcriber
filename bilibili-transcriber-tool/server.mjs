#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const APP_DIR = path.dirname(__filename);
const ROOT = path.resolve(APP_DIR, '..');
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const DATA_DIR = path.resolve(ROOT, process.env.BILI_TOOL_DATA_DIR || path.join('data', 'bilibili-tool'));
const PORT = Number(process.env.BILI_TOOL_PORT || process.env.PORT || 8719);
const HOST = process.env.BILI_TOOL_HOST || '127.0.0.1';

const jobs = new Map();

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(`${body}\n`);
}

function textResponse(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body is too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function parseJsonBody(req) {
  return readRequestBody(req).then((body) => {
    if (!body.trim()) return {};
    return JSON.parse(body);
  });
}

function slugify(value, fallback = 'job') {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || fallback;
}

function normalizeBilibiliInput(value) {
  const input = String(value || '').trim();
  if (!input) throw new Error('请输入 B 站视频 URL、空间 URL 或 BV 号。');
  const bv = input.match(/BV[a-zA-Z0-9]{8,}/)?.[0];
  if (bv && !/^https?:\/\//i.test(input)) return `https://www.bilibili.com/video/${bv}/`;
  if (/^https?:\/\/(www\.)?bilibili\.com\/video\/BV/i.test(input)) return input;
  if (/^https?:\/\/space\.bilibili\.com\/\d+/i.test(input)) return input;
  if (/^https?:\/\/b23\.tv\//i.test(input)) return input;
  if (bv) return `https://www.bilibili.com/video/${bv}/`;
  throw new Error('只接受 bilibili.com、space.bilibili.com、b23.tv 链接或 BV 号。');
}

function publicJob(job, options = {}) {
  const includeArtifacts = options.includeArtifacts !== false;
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    step: job.step,
    completedSteps: job.completedSteps || [],
    failedStep: job.failedStep || '',
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt || '',
    inputUrl: job.inputUrl,
    normalizedUrl: job.normalizedUrl,
    outputDir: job.outputDir,
    logFile: job.logFile,
    error: job.error || '',
    config: job.config,
    artifacts: includeArtifacts ? job.artifacts || [] : [],
    summary: job.summary || null,
  };
}

function persistJob(job) {
  job.updatedAt = new Date().toISOString();
  fs.mkdirSync(job.outputDir, { recursive: true });
  fs.writeFileSync(job.jobFile, `${JSON.stringify(publicJob(job, { includeArtifacts: false }), null, 2)}\n`);
}

function loadPersistedJobs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobFile = path.join(DATA_DIR, entry.name, 'job.json');
    if (!fs.existsSync(jobFile)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
      const job = {
        ...raw,
        clients: new Set(),
        currentChild: null,
        jobFile,
        logFile: raw.logFile || path.join(DATA_DIR, entry.name, 'job.log'),
        outputDir: raw.outputDir || path.join(DATA_DIR, entry.name),
      };
      if (['running', 'queued', 'stopping'].includes(job.status)) {
        job.failedStep = job.step;
        job.status = 'failed';
        job.error = '上次服务退出时任务仍在运行，已标记为失败。';
        job.finishedAt = new Date().toISOString();
      }
      job.artifacts = scanArtifacts(job.outputDir, job.id);
      jobs.set(job.id, job);
    } catch {
      // Ignore broken historical job metadata.
    }
  }
}

function inferCatalogName(catalogDir) {
  const videos = readJsonIfExists(path.join(catalogDir, 'videos.json'));
  if (Array.isArray(videos) && videos.length) {
    const first = videos.find((item) => item?.title || item?.uploader) || videos[0];
    const uploader = first?.uploader ? `${first.uploader} / ` : '';
    return `${uploader}${path.basename(catalogDir)}`;
  }
  return path.basename(catalogDir);
}

function importedJobFromDir(catalogDir) {
  const markers = ['audio-manifest.json', 'download-summary.json', 'investment-reference-index.md', 'summary.md'];
  if (!markers.some((name) => fs.existsSync(path.join(catalogDir, name)))) return null;

  const stat = fs.statSync(catalogDir);
  const id = `history-${slugify(path.relative(ROOT, catalogDir), path.basename(catalogDir))}`;
  const summary = {
    download: readJsonIfExists(path.join(catalogDir, 'download-summary.json')),
    transcribe: latestTranscriptSummary(catalogDir),
  };
  return {
    id,
    name: inferCatalogName(catalogDir),
    status: 'succeeded',
    step: 'imported',
    createdAt: new Date(stat.birthtimeMs || stat.ctimeMs).toISOString(),
    updatedAt: new Date(stat.mtimeMs).toISOString(),
    finishedAt: new Date(stat.mtimeMs).toISOString(),
    inputUrl: summary.download?.inputUrl || '',
    normalizedUrl: summary.download?.rootUrl || '',
    outputDir: catalogDir,
    jobFile: '',
    logFile: path.join(catalogDir, 'job.log'),
    error: '',
    config: { imported: true },
    artifacts: [],
    summary,
    clients: new Set(),
    currentChild: null,
  };
}

function loadHistoricalCatalogJobs() {
  const candidates = [];
  const bilibiliData = path.join(ROOT, 'data', 'bilibili');
  if (fs.existsSync(bilibiliData)) {
    for (const entry of fs.readdirSync(bilibiliData, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(bilibiliData, entry.name));
    }
  }
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('bilibili_BV')) {
      candidates.push(path.join(ROOT, entry.name));
    }
  }

  for (const dir of candidates) {
    const job = importedJobFromDir(dir);
    if (!job || jobs.has(job.id)) continue;
    job.artifacts = scanArtifacts(job.outputDir, job.id);
    jobs.set(job.id, job);
  }
}

function appendLog(job, chunk) {
  const text = String(chunk);
  fs.appendFileSync(job.logFile, text);
  broadcast(job, 'log', { chunk: text });
}

function logLine(job, line) {
  appendLog(job, `${line}\n`);
}

function broadcast(job, event, payload) {
  const data = JSON.stringify(payload);
  for (const client of job.clients || []) {
    client.write(`event: ${event}\n`);
    client.write(`data: ${data}\n\n`);
  }
}

function updateJob(job, patch = {}) {
  Object.assign(job, patch);
  job.artifacts = scanArtifacts(job.outputDir, job.id);
  if (job.jobFile) persistJob(job);
  broadcast(job, 'snapshot', publicJob(job));
}

function relOutputDir(job) {
  return path.relative(ROOT, job.outputDir) || job.outputDir;
}

function commandOutput(command, args = []) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) return { ok: false, value: result.error.message };
  const text = `${result.stdout || ''}${result.stderr || ''}`.trim();
  return { ok: result.status === 0, value: text.split('\n')[0] || `exit ${result.status}` };
}

function dependencyStatus() {
  const pythonProbe = [
    'import importlib.util, json',
    "mods=['faster_whisper','whisper','mlx_whisper']",
    'print(json.dumps({m: importlib.util.find_spec(m) is not None for m in mods}))',
  ].join(';');
  const python = commandOutput('python3', ['-c', pythonProbe]);
  let packages = {};
  try {
    packages = JSON.parse(python.value);
  } catch {
    packages = {};
  }
  return {
    root: ROOT,
    dataDir: DATA_DIR,
    node: commandOutput('node', ['--version']),
    ytDlp: commandOutput('yt-dlp', ['--version']),
    ffmpeg: commandOutput('ffmpeg', ['-version']),
    python3: commandOutput('python3', ['--version']),
    conda: commandOutput('conda', ['--version']),
    pythonPackages: packages,
    scripts: {
      download: fs.existsSync(path.join(ROOT, 'scripts', 'download_bilibili_audio.js')),
      transcribe: fs.existsSync(path.join(ROOT, 'scripts', 'transcribe_audio_local.py')),
      reference: fs.existsSync(path.join(ROOT, 'scripts', 'build_transcript_reference.py')),
    },
  };
}

function buildJob(config) {
  const normalizedUrl = normalizeBilibiliInput(config.url);
  const id = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(4).toString('hex')}`;
  const name = slugify(config.name || normalizedUrl.match(/BV[a-zA-Z0-9]{8,}/)?.[0] || id, id);
  const outputDir = path.join(DATA_DIR, `${id}-${name}`);
  return {
    id,
    name,
    status: 'queued',
    step: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    inputUrl: String(config.url || '').trim(),
    normalizedUrl,
    outputDir,
    jobFile: path.join(outputDir, 'job.json'),
    logFile: path.join(outputDir, 'job.log'),
    error: '',
    config,
    artifacts: [],
    summary: null,
    clients: new Set(),
    currentChild: null,
  };
}

function runCommand(job, label, command, args, envPatch) {
  return new Promise((resolve, reject) => {
    logLine(job, `\n$ ${[command, ...args].join(' ')}`);
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...envPatch },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    job.currentChild = child;

    child.stdout.on('data', (chunk) => appendLog(job, chunk));
    child.stderr.on('data', (chunk) => appendLog(job, chunk));
    child.on('error', (error) => {
      job.currentChild = null;
      reject(error);
    });
    child.on('close', (code, signal) => {
      job.currentChild = null;
      if (code === 0) {
        logLine(job, `[${label}] done`);
        resolve();
      } else {
        reject(new Error(`${label} failed: ${signal || `exit ${code}`}`));
      }
    });
  });
}

function baseDownloadEnv(job) {
  const config = job.config;
  const env = {
    BILI_COOKIES_FILE: '',
    BILI_COOKIES_FROM_BROWSER: config.cookiesBrowser || 'chrome',
    BILI_OUTPUT_DIR: relOutputDir(job),
    BILI_SCOPE: config.scope || 'input',
    BILI_FORMAT: config.format || 'bestaudio/best',
    BILI_AUDIO_FORMAT: config.audioFormat || 'm4a',
    BILI_AUDIO_QUALITY: String(config.audioQuality ?? '0'),
    BILI_START_INDEX: String(config.startIndex || 1),
    BILI_MAX_VIDEOS: String(config.maxVideos || 0),
    BILI_OVERWRITE: config.overwrite ? '1' : '0',
  };
  if (config.skipDownload) env.BILI_SKIP_DOWNLOAD = '1';
  if (config.cookiesMode === 'none') env.BILI_COOKIES_FROM_BROWSER = 'none';
  if (config.cookiesMode === 'browser') env.BILI_COOKIES_FROM_BROWSER = config.cookiesBrowser || 'chrome';
  if (config.cookiesMode === 'file' && config.cookiesFile) env.BILI_COOKIES_FILE = config.cookiesFile;
  return env;
}

function baseTranscribeEnv(job) {
  const config = job.config;
  return {
    AUDIO_CATALOG_DIR: relOutputDir(job),
    WHISPER_BACKEND: config.backend || 'faster',
    WHISPER_MODEL: config.model || 'small',
    WHISPER_DEVICE: config.device || '',
    WHISPER_COMPUTE_TYPE: config.computeType || 'int8',
    AUDIO_LANGUAGE: config.language || 'zh',
    AUDIO_MAX_EPISODES: String(config.transcribeMaxEpisodes || 0),
    AUDIO_OVERWRITE: config.overwriteTranscripts ? '1' : '0',
    AUDIO_WORD_TIMESTAMPS: config.wordTimestamps ? '1' : '0',
    AUDIO_VAD_FILTER: config.vadFilter === false ? '0' : '1',
  };
}

function transcribeCommand(config) {
  if (config.pythonMode === 'conda') {
    return {
      command: 'conda',
      args: ['run', '-n', config.condaEnv || 'video-trans', 'python', 'scripts/transcribe_audio_local.py'],
    };
  }
  return { command: 'python3', args: ['scripts/transcribe_audio_local.py'] };
}

async function executeJob(job, resume = false) {
  const completed = new Set(resume ? job.completedSteps || [] : []);
  const finishStep = (step) => {
    completed.add(step);
    updateJob(job, { completedSteps: [...completed] });
  };
  try {
    fs.mkdirSync(job.outputDir, { recursive: true });
    if (!resume) fs.writeFileSync(job.logFile, '');
    job.cancelRequested = false;
    updateJob(job, { status: 'running', step: 'download', error: '', failedStep: '', finishedAt: '' });
    logLine(job, `Job: ${job.name}`);
    logLine(job, `URL: ${job.normalizedUrl}`);
    logLine(job, `Output: ${job.outputDir}`);

    if (!completed.has('download')) {
    try {
      await runCommand(
        job,
        'download',
        'node',
        ['scripts/download_bilibili_audio.js', job.normalizedUrl],
        baseDownloadEnv(job),
      );
    } catch (error) {
      const canFallback =
        job.config.directFallback !== false &&
        (job.config.scope || 'input') === 'input' &&
        /BV[a-zA-Z0-9]{8,}|b23\.tv|bilibili\.com\/video\//i.test(job.normalizedUrl);
      if (!canFallback || job.cancelRequested) throw error;
      logLine(job, `\n标准 yt-dlp 下载失败，改用历史验证过的 B 站 playurl 直连兜底：${error.message}`);
      await runCommand(
        job,
        'download-direct',
        'node',
        ['scripts/download_bilibili_audio_direct.mjs', job.normalizedUrl],
        baseDownloadEnv(job),
      );
    }
    finishStep('download');
    }
    if (job.cancelRequested) throw new Error('任务已停止');
    const videos = readJsonIfExists(path.join(job.outputDir, 'videos.json'));
    if (!job.config.name && Array.isArray(videos) && videos[0]?.title) updateJob(job, { name: videos[0].title });

    if (job.config.transcribe !== false && !completed.has('transcribe')) {
      updateJob(job, { step: 'transcribe' });
      const cmd = transcribeCommand(job.config);
      await runCommand(job, 'transcribe', cmd.command, cmd.args, baseTranscribeEnv(job));
      finishStep('transcribe');
    }
    if (job.cancelRequested) throw new Error('任务已停止');

    if (job.config.buildIndex !== false && !completed.has('index')) {
      updateJob(job, { step: 'index' });
      await runCommand(job, 'index', 'python3', ['scripts/build_transcript_reference.py'], {
        REF_CATALOG_DIR: relOutputDir(job),
      });
      finishStep('index');
    }

    const summary = readJsonIfExists(path.join(job.outputDir, 'download-summary.json'));
    const transcriptSummary = latestTranscriptSummary(job.outputDir);
    updateJob(job, {
      status: 'succeeded',
      step: 'done',
      finishedAt: new Date().toISOString(),
      summary: { download: summary, transcribe: transcriptSummary },
    });
    logLine(job, '\n任务完成。');
  } catch (error) {
    updateJob(job, {
      status: 'failed',
      failedStep: job.step,
      step: 'failed',
      finishedAt: new Date().toISOString(),
      error: error.message,
    });
    logLine(job, `\n任务失败：${error.message}`);
  }
}

function readJsonIfExists(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function latestTranscriptSummary(outputDir) {
  const transcriptRoot = path.join(outputDir, 'transcripts');
  if (!fs.existsSync(transcriptRoot)) return null;
  const dirs = fs
    .readdirSync(transcriptRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(transcriptRoot, entry.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const dir of dirs) {
    const summary = readJsonIfExists(path.join(dir, 'transcription-summary.json'));
    if (summary) return summary;
  }
  return null;
}

function scanArtifacts(outputDir, jobId = '') {
  if (!fs.existsSync(outputDir)) return [];
  const wanted = new Set([
    '.m4a',
    '.m4s',
    '.mp3',
    '.opus',
    '.wav',
    '.flac',
    '.aac',
    '.json',
    '.txt',
    '.srt',
    '.md',
    '.csv',
    '.log',
  ]);
  const rows = [];
  const walk = (dir, depth = 0) => {
    if (depth > 5 || rows.length > 400) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!wanted.has(ext)) continue;
      const stat = fs.statSync(full);
      const rel = path.relative(outputDir, full);
      rows.push({
        path: rel,
        name: entry.name,
        size: stat.size,
        modifiedAt: new Date(stat.mtimeMs).toISOString(),
        url: jobId
          ? `/api/jobs/${encodeURIComponent(jobId)}/files/${rel.split(path.sep).map(encodeURIComponent).join('/')}`
          : `/files/${encodeURIComponent(path.basename(outputDir))}/${rel.split(path.sep).map(encodeURIComponent).join('/')}`,
      });
    }
  };
  walk(outputDir);
  rows.sort((a, b) => a.path.localeCompare(b.path));
  return rows;
}

function serveStatic(req, res, pathname) {
  const file = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
  const resolved = path.resolve(file);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    textResponse(res, 403, 'Forbidden');
    return true;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return false;
  const ext = path.extname(resolved).toLowerCase();
  const type =
    ext === '.html'
      ? 'text/html; charset=utf-8'
      : ext === '.css'
        ? 'text/css; charset=utf-8'
        : ext === '.js'
          ? 'application/javascript; charset=utf-8'
          : 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  fs.createReadStream(resolved).pipe(res);
  return true;
}

function serveArtifact(res, jobDirName, relativeParts) {
  const outputDir = path.join(DATA_DIR, jobDirName);
  const resolvedOutput = path.resolve(outputDir);
  const file = path.resolve(outputDir, ...relativeParts);
  if (!file.startsWith(`${resolvedOutput}${path.sep}`)) {
    textResponse(res, 403, 'Forbidden');
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    textResponse(res, 404, 'Not found');
    return;
  }
  serveFile(res, file);
}

function serveJobArtifact(res, job, relativeParts) {
  const resolvedOutput = path.resolve(job.outputDir);
  const file = path.resolve(job.outputDir, ...relativeParts);
  if (!file.startsWith(`${resolvedOutput}${path.sep}`)) {
    textResponse(res, 403, 'Forbidden');
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    textResponse(res, 404, 'Not found');
    return;
  }
  serveFile(res, file);
}

function serveFile(res, file) {
  const ext = path.extname(file).toLowerCase();
  const type =
    ext === '.json'
      ? 'application/json; charset=utf-8'
      : ext === '.md' || ext === '.txt' || ext === '.srt' || ext === '.log' || ext === '.csv'
        ? 'text/plain; charset=utf-8'
        : ext === '.m4a' || ext === '.mp4' || ext === '.m4s'
          ? 'audio/mp4'
          : ext === '.mp3'
            ? 'audio/mpeg'
            : 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-length': fs.statSync(file).size,
    'cache-control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

function handleEvents(req, res, job) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  res.write(`event: snapshot\n`);
  res.write(`data: ${JSON.stringify(publicJob(job))}\n\n`);
  if (fs.existsSync(job.logFile)) {
    const recent = fs.readFileSync(job.logFile, 'utf8').slice(-12000);
    if (recent) {
      res.write('event: log\n');
      res.write(`data: ${JSON.stringify({ chunk: recent })}\n\n`);
    }
  }
  job.clients.add(res);
  req.on('close', () => job.clients.delete(res));
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/health') {
    jsonResponse(res, 200, { app: 'bilibili-transcriber', pid: process.pid });
    return true;
  }
  const retryMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/retry$/);
  if (req.method === 'POST' && retryMatch) {
    const job = jobs.get(retryMatch[1]);
    if (!job || !job.jobFile) jsonResponse(res, 404, { error: '任务不存在或为导入任务' });
    else if (job.status !== 'failed') jsonResponse(res, 409, { error: '只有失败或中断任务可以续跑' });
    else {
      updateJob(job, { status: 'queued' });
      jsonResponse(res, 200, publicJob(job));
      setImmediate(() => executeJob(job, true));
    }
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/status') {
    jsonResponse(res, 200, dependencyStatus());
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/jobs') {
    const rows = [...jobs.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((job) => publicJob(job, { includeArtifacts: false }));
    jsonResponse(res, 200, rows);
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/jobs') {
    try {
      const config = await parseJsonBody(req);
      const job = buildJob(config);
      jobs.set(job.id, job);
      persistJob(job);
      jsonResponse(res, 201, publicJob(job));
      setImmediate(() => executeJob(job));
    } catch (error) {
      jsonResponse(res, 400, { error: error.message });
    }
    return true;
  }

  const eventMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/events$/);
  if (req.method === 'GET' && eventMatch) {
    const job = jobs.get(eventMatch[1]);
    if (!job) jsonResponse(res, 404, { error: 'Job not found' });
    else handleEvents(req, res, job);
    return true;
  }

  const stopMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/stop$/);
  if (req.method === 'POST' && stopMatch) {
    const job = jobs.get(stopMatch[1]);
    if (!job) {
      jsonResponse(res, 404, { error: 'Job not found' });
    } else if (job.currentChild) {
      job.cancelRequested = true;
      job.currentChild.kill('SIGTERM');
      updateJob(job, { status: 'stopping', step: 'stopping' });
      jsonResponse(res, 200, publicJob(job));
    } else {
      jsonResponse(res, 409, { error: 'Job is not running' });
    }
    return true;
  }

  const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (req.method === 'GET' && jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) jsonResponse(res, 404, { error: 'Job not found' });
    else {
      job.artifacts = scanArtifacts(job.outputDir, job.id);
      jsonResponse(res, 200, publicJob(job));
    }
    return true;
  }

  const fileMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/files\/(.+)$/);
  if (req.method === 'GET' && fileMatch) {
    const job = jobs.get(fileMatch[1]);
    if (!job) jsonResponse(res, 404, { error: 'Job not found' });
    else serveJobArtifact(res, job, fileMatch[2].split('/').filter(Boolean));
    return true;
  }

  return false;
}

async function router(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/api/')) {
    const handled = await handleApi(req, res, pathname);
    if (!handled) jsonResponse(res, 404, { error: 'Not found' });
    return;
  }

  if (pathname.startsWith('/files/')) {
    const parts = pathname.split('/').slice(2).filter(Boolean);
    const jobDirName = parts.shift();
    if (!jobDirName || !parts.length) textResponse(res, 404, 'Not found');
    else serveArtifact(res, jobDirName, parts);
    return;
  }

  if (!serveStatic(req, res, pathname)) {
    textResponse(res, 404, 'Not found');
  }
}

loadPersistedJobs();
loadHistoricalCatalogJobs();

const server = http.createServer((req, res) => {
  router(req, res).catch((error) => {
    jsonResponse(res, 500, { error: error.message });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Bilibili Transcriber Tool running at http://${HOST}:${PORT}`);
  console.log(`Data dir: ${DATA_DIR}`);
});

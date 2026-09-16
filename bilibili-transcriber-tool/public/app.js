const form = document.querySelector('#jobForm');
const jobList = document.querySelector('#jobList');
const statusGrid = document.querySelector('#statusGrid');
const artifactList = document.querySelector('#artifactList');
const artifactCount = document.querySelector('#artifactCount');
const logBox = document.querySelector('#logBox');
const activeJobLabel = document.querySelector('#activeJobLabel');
const formHint = document.querySelector('#formHint');
const stopJobButton = document.querySelector('#stopJob');

let activeJobId = '';
let eventSource = null;
let logText = '';
let refreshPending = false;
let artifactSignature = '';
let previewRequest = 0;
const retryJobButton = document.querySelector('#retryJob');

function savedJobId() {
  try { return localStorage.getItem('biliActiveJobId') || ''; } catch { return ''; }
}

function fmtBytes(size) {
  if (!Number.isFinite(size)) return '-';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function fmtTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

function setLog(text) {
  logText = text.slice(-60000);
  logBox.textContent = logText;
  logBox.scrollTop = logBox.scrollHeight;
}

function appendLog(chunk) {
  setLog(`${logText}${chunk}`);
}

function collectForm() {
  const data = Object.fromEntries(new FormData(form).entries());
  return {
    url: data.url,
    name: data.name,
    scope: data.scope,
    maxVideos: Number(data.maxVideos || 0),
    startIndex: 1,
    cookiesMode: data.cookiesMode,
    cookiesBrowser: data.cookiesBrowser || 'chrome',
    cookiesFile: data.cookiesFile,
    backend: data.backend,
    model: data.model,
    pythonMode: data.pythonMode,
    condaEnv: data.condaEnv,
    audioFormat: 'm4a',
    audioQuality: '0',
    language: 'zh',
    transcribe: document.querySelector('#transcribe').checked,
    buildIndex: document.querySelector('#buildIndex').checked,
    directFallback: document.querySelector('#directFallback').checked,
    overwrite: document.querySelector('#overwrite').checked,
    overwriteTranscripts: document.querySelector('#overwriteTranscripts').checked,
    wordTimestamps: false,
    vadFilter: true,
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function renderStatus(status) {
  const rows = [
    ['数据目录', status.dataDir],
    ['yt-dlp', status.ytDlp?.ok ? status.ytDlp.value : `缺失：${status.ytDlp?.value || '-'}`],
    ['ffmpeg', status.ffmpeg?.ok ? status.ffmpeg.value : `缺失：${status.ffmpeg?.value || '-'}`],
    ['python3', status.python3?.ok ? status.python3.value : `缺失：${status.python3?.value || '-'}`],
    ['conda', status.conda?.ok ? status.conda.value : `可选：${status.conda?.value || '-'}`],
    [
      '模型包',
      Object.entries(status.pythonPackages || {})
        .map(([name, ok]) => `${name}:${ok ? 'yes' : 'no'}`)
        .join('  '),
    ],
  ];
  statusGrid.innerHTML = rows
    .map(
      ([label, value]) => `
        <div class="statusItem">
          <strong>${escapeHtml(label)}</strong>
          <span class="mono">${escapeHtml(value || '-')}</span>
        </div>
      `,
    )
    .join('');
}

function renderJobs(jobs) {
  if (!jobs.length) {
    jobList.innerHTML = '<div class="muted">暂无任务。</div>';
    return;
  }
  jobList.innerHTML = jobs
    .map(
      (job) => `
        <button class="jobRow ${job.id === activeJobId ? 'active' : ''}" type="button" data-job-id="${job.id}">
          <div>
            <div class="jobName">${escapeHtml(job.name)}</div>
            <div class="muted mono">${escapeHtml(job.step)} · ${escapeHtml(fmtTime(job.createdAt))}</div>
          </div>
          <span class="badge ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span>
        </button>
      `,
    )
    .join('');
}

function renderArtifacts(job) {
  const signature = JSON.stringify([job?.id, job?.artifacts]);
  if (signature === artifactSignature) return;
  artifactSignature = signature;
  const fileKind = (file) => {
    if (/\.srt$/i.test(file.path)) return [0, '字幕 SRT'];
    if (/\.txt$/i.test(file.path)) return [1, '文稿 TXT'];
    if (/\.md$/i.test(file.path)) return [2, '文稿 / 索引'];
    if (/\.(m4a|m4s|mp3|wav|opus|flac|aac)$/i.test(file.path)) return [3, '音频'];
    return [4, ''];
  };
  const artifacts = [...(job?.artifacts || [])].sort((a, b) => fileKind(a)[0] - fileKind(b)[0]);
  artifactCount.textContent = artifacts.length ? `${artifacts.length} 个文件` : '';
  if (!artifacts.length) {
    artifactList.innerHTML = '<div class="muted">当前任务还没有可用产物。</div>';
    return;
  }
  const rows = (files) => files
    .map(
      (file) => `
        <div class="artifactRow">
          <a href="${file.url}" target="_blank" rel="noreferrer" ${/\.(srt|txt)$/i.test(file.path) ? 'download' : ''}>${fileKind(file)[1] ? `<strong>${fileKind(file)[1]}</strong> · ` : ''}${escapeHtml(file.path)}</a>
          <span>${/\.(txt|srt|md)$/i.test(file.path) ? `<button type="button" class="ghost compact" data-preview="${escapeHtml(file.url)}" data-title="${escapeHtml(file.name)}">预览</button>` : escapeHtml(fmtBytes(file.size))}</span>
          <span class="mono muted">${escapeHtml(fmtTime(file.modifiedAt))}</span>
        </div>
      `,
    )
    .join('');
  const outputs = artifacts.filter(file => fileKind(file)[0] < 4);
  const metadata = artifacts.filter(file => fileKind(file)[0] === 4);
  artifactList.innerHTML = rows(outputs) + (metadata.length ? `<details><summary>其他文件 (${metadata.length})</summary>${rows(metadata)}</details>` : '');
}

function renderActive(job) {
  if (job.id !== activeJobId) return;
  activeJobLabel.textContent = `${job.name} · ${job.status} · ${job.step}`;
  retryJobButton.disabled = job.status !== 'failed' || job.config?.imported;
  const labels = { download: '下载', transcribe: '转录', index: '索引' };
  formHint.textContent = job.error || (job.completedSteps || []).map(step => `${labels[step] || step}完成`).join(' · ');
  stopJobButton.disabled = !['queued', 'running', 'stopping'].includes(job.status);
  renderArtifacts(job);
}

function connectJob(jobId) {
  if (eventSource) eventSource.close();
  activeJobId = jobId;
  try { localStorage.setItem('biliActiveJobId', jobId); } catch {}
  setLog('');
  artifactSignature = '';
  previewRequest++;
  document.querySelector('#previewPanel').hidden = true;
  artifactCount.textContent = '';
  artifactList.innerHTML = '<div class="muted">正在加载产物...</div>';
  refreshJob(jobId).catch(() => {});
  eventSource = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);
  eventSource.addEventListener('snapshot', (event) => {
    if (activeJobId !== jobId) return;
    renderActive(JSON.parse(event.data));
    refreshJobs().catch(() => {});
  });
  eventSource.addEventListener('log', (event) => {
    if (activeJobId !== jobId) return;
    appendLog(JSON.parse(event.data).chunk || '');
  });
  eventSource.onerror = () => {
    refreshJob(jobId).catch(() => {});
  };
}

async function refreshStatus() {
  renderStatus(await api('/api/status'));
}

async function refreshJobs() {
  if (refreshPending) return;
  refreshPending = true;
  try {
  const jobs = await api('/api/jobs');
  if (!jobs.some((job) => job.id === activeJobId)) {
    const selected = jobs.find((job) => job.id === savedJobId()) || jobs[0];
    if (selected) connectJob(selected.id);
    else renderArtifacts(null);
  }
  renderJobs(jobs);
  if (activeJobId) await refreshJob(activeJobId);
  } finally {
    refreshPending = false;
  }
}

async function refreshJob(jobId) {
  const job = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
  renderActive(job);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  formHint.textContent = '正在创建任务...';
  try {
    const job = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify(collectForm()),
    });
    formHint.textContent = `任务已创建：${job.id}`;
    connectJob(job.id);
    await refreshJobs();
  } catch (error) {
    formHint.textContent = error.message;
  }
});

jobList.addEventListener('click', async (event) => {
  const row = event.target.closest('[data-job-id]');
  if (!row) return;
  connectJob(row.dataset.jobId);
});

stopJobButton.addEventListener('click', async () => {
  if (!activeJobId) return;
  try {
    await api(`/api/jobs/${encodeURIComponent(activeJobId)}/stop`, { method: 'POST', body: '{}' });
    await refreshJob(activeJobId);
  } catch (error) {
    appendLog(`\n停止失败：${error.message}\n`);
  }
});

document.querySelector('#refreshStatus').addEventListener('click', refreshStatus);
retryJobButton.addEventListener('click', async () => {
  retryJobButton.disabled = true;
  try {
    await api(`/api/jobs/${encodeURIComponent(activeJobId)}/retry`, { method: 'POST', body: '{}' });
    connectJob(activeJobId);
  } catch (error) { formHint.textContent = error.message; retryJobButton.disabled = false; }
});
artifactList.addEventListener('click', async event => {
  const button = event.target.closest('[data-preview]');
  if (!button) return;
  const request = ++previewRequest;
  const panel = document.querySelector('#previewPanel');
  const preview = document.querySelector('#transcriptPreview');
  panel.hidden = false;
  document.querySelector('#previewTitle').textContent = button.dataset.title;
  preview.textContent = '加载中...';
  try {
    const response = await fetch(button.dataset.preview);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (request === previewRequest) preview.textContent = text;
  } catch (error) { if (request === previewRequest) preview.textContent = error.message; }
});
document.querySelector('#copyTranscript').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(document.querySelector('#transcriptPreview').textContent);
    formHint.textContent = '文稿已复制';
  } catch { formHint.textContent = '复制失败，请在预览中选择文字复制'; }
});
document.querySelector('#refreshJobs').addEventListener('click', refreshJobs);

document.querySelector('#backend').addEventListener('change', (event) => {
  const model = document.querySelector('#model');
  if (event.target.value === 'faster' && !model.value) model.value = 'small';
  if (event.target.value === 'mlx' && (model.value === 'small' || !model.value)) {
    model.value = 'mlx-community/whisper-large-v3-turbo';
  }
  if (event.target.value === 'openai' && (model.value.startsWith('mlx-') || !model.value)) model.value = 'large-v3';
});

await Promise.all([refreshStatus(), refreshJobs()]);
setInterval(() => refreshJobs().catch(() => {}), 5000);

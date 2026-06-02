// ─── State ────────────────────────────────────────────────────────────────────
const API     = 'http://localhost:3002';
const GATEWAY = 'http://localhost:8081';

let selectedRuntime    = 'python';
let warmCount          = 1;
let maxContainersCount = 10;
let uploadedFiles      = [];
let dashboardTimer     = null;
let isDeploying        = false;

// ─── Tab switching ───────────────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
  if (name === 'dashboard') {
    loadDashboard();
    dashboardTimer = setInterval(loadDashboard, 5000);
  } else {
    if (dashboardTimer) clearInterval(dashboardTimer);
  }
}

// ─── Runtime selection ───────────────────────────────────────────────────────
function selectRuntime(btn) {
  if (btn.classList.contains('disabled')) { showToast('This runtime is coming soon!', 'err'); return; }
  document.querySelectorAll('.runtime-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  selectedRuntime = btn.dataset.runtime;
  suggestSelections();
}

// ─── Warm count ───────────────────────────────────────────────────────────────
function adjustWarm(delta) {
  warmCount = Math.max(1, Math.min(20, warmCount + delta));
  document.getElementById('warmCount').textContent = warmCount;
}

function adjustMaxContainers(delta) {
  maxContainersCount = Math.max(warmCount, Math.min(50, maxContainersCount + delta));
  document.getElementById('maxContainersCount').textContent = maxContainersCount;
}

// ─── File / Directory handling ────────────────────────────────────────────────
function onFilesSelected(fileList) {
  uploadedFiles = Array.from(fileList).filter(f => {
    const path = f.webkitRelativePath || f.name;
    return !path.split('/').some(p => p.startsWith('.') || p === '__pycache__' || p === 'node_modules');
  });
  if (!uploadedFiles.length) { showToast('No files found in selected directory', 'err'); return; }

  renderFileTree(uploadedFiles);
  populateDropdowns(uploadedFiles);
  suggestSelections();

  document.getElementById('uploadZone').style.display = 'none';
  document.getElementById('fileTreeWrap').style.display = 'block';

  const dirPath = uploadedFiles[0].webkitRelativePath || '';
  document.getElementById('dirName').textContent = (dirPath.split('/')[0] || 'project') + '/';
  showToast(`${uploadedFiles.length} file(s) loaded`, 'ok');
}

function clearFiles() {
  uploadedFiles = [];
  document.getElementById('dirInput').value = '';
  document.getElementById('uploadZone').style.display = 'flex';
  document.getElementById('fileTreeWrap').style.display = 'none';
  document.getElementById('fileTree').innerHTML = '';
  document.getElementById('entryPoint').innerHTML = '<option value="">— upload files first —</option>';
  document.getElementById('requirementsFile').innerHTML = '<option value="">— None (no dependencies) —</option>';
}

function renderFileTree(files) {
  const root = {};
  for (const f of files) {
    const parts = (f.webkitRelativePath || f.name).split('/');
    let node = root;
    for (let i = 1; i < parts.length - 1; i++) {
      if (!node[parts[i]]) node[parts[i]] = { __dir: true, __children: {} };
      node = node[parts[i]].__children;
    }
    node[parts[parts.length - 1]] = { __file: true, __obj: f };
  }
  document.getElementById('fileTree').innerHTML = renderNode(root);
}

function renderNode(node) {
  let html = '';
  const entries = Object.entries(node).sort(([a, av], [b, bv]) => {
    return (av.__dir ? 0 : 1) - (bv.__dir ? 0 : 1) || a.localeCompare(b);
  });
  for (const [name, val] of entries) {
    if (val.__dir) {
      html += `<li class="ft-dir"><span class="ft-icon">📂</span>${name}/<ul>${renderNode(val.__children)}</ul></li>`;
    } else {
      const ext  = name.split('.').pop();
      const icon = { py: '🐍', js: '💛', ts: '💙', json: '📋', txt: '📄', md: '📝', php: '🐘' }[ext] || '📄';
      const kb   = (val.__obj.size / 1024).toFixed(1);
      html += `<li class="ft-file"><span class="ft-icon">${icon}</span>${name}<span class="ft-size">${kb}KB</span></li>`;
    }
  }
  return html;
}

function populateDropdowns(files) {
  const allPaths = files.map(f => (f.webkitRelativePath || f.name).split('/').slice(1).join('/'));
  const entrySelect = document.getElementById('entryPoint');
  const reqSelect   = document.getElementById('requirementsFile');

  entrySelect.innerHTML = '<option value="">— select entry point —</option>';
  reqSelect.innerHTML   = '<option value="">— None (no dependencies) —</option>';

  for (const p of allPaths) {
    const name = p.split('/').pop();
    if (/\.(py|js|php)$/.test(name))
      entrySelect.innerHTML += `<option value="${p}">${p}</option>`;
    if (/^(requirements.*\.txt|requirements\.in|package\.json|composer\.json)$/.test(name))
      reqSelect.innerHTML += `<option value="${p}">${p}</option>`;
  }
}

function suggestSelections() {
  const entrySelect = document.getElementById('entryPoint');
  const reqSelect   = document.getElementById('requirementsFile');
  const entryMap = { python: ['handler.py','main.py','index.py'], nodejs: ['handler.js','index.js','main.js'], php: ['handler.php','index.php'] };
  const reqMap   = { python: ['requirements.txt'], nodejs: ['package.json'], php: ['composer.json'] };

  const trySelect = (sel, candidates) => {
    for (const opt of sel.options) {
      if (candidates.includes(opt.value.split('/').pop())) { sel.value = opt.value; return; }
    }
  };
  trySelect(entrySelect, entryMap[selectedRuntime] || []);
  trySelect(reqSelect,   reqMap[selectedRuntime]   || []);
}

// ─── Deploy ──────────────────────────────────────────────────────────────────
async function deploy() {
  if (isDeploying) return;

  const name    = document.getElementById('funcName').value.trim();
  const region  = document.getElementById('funcRegion').value.trim();
  const entry   = document.getElementById('entryPoint').value;
  const reqFile = document.getElementById('requirementsFile').value;
  const memory  = document.getElementById('funcMemory').value;
  const cpu     = document.getElementById('funcCpu').value;
  const storage = document.getElementById('funcStorage').value;
  const envVars = document.getElementById('funcEnv').value;

  if (!name)               { showToast('Enter a function name', 'err'); return; }
  if (!region)             { showToast('Enter a region', 'err'); return; }
  if (!uploadedFiles.length) { showToast('Upload a directory first', 'err'); return; }
  if (!entry)              { showToast('Select an entry point file', 'err'); return; }
  
  let parsedEnv = null;
  if (envVars.trim()) {
      try { parsedEnv = JSON.stringify(JSON.parse(envVars)); }
      catch(e) { showToast('Invalid JSON in Environment Variables', 'err'); return; }
  }

  isDeploying = true;
  const btn     = document.getElementById('deployBtn');
  const btnText = document.getElementById('deployBtnText');
  btn.disabled  = true;
  btnText.textContent = 'Building…';
  clearTerminal();
  setLogStatus('building', 'Building…');

  const fd = new FormData();
  fd.append('name',    name.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
  fd.append('region',  region);
  fd.append('runtime', selectedRuntime);
  fd.append('entry_point', entry);
  fd.append('warm_count',  warmCount);
  fd.append('max_containers', maxContainersCount);
  fd.append('memory_limit', memory || '512');
  fd.append('cpu_limit', cpu || '1.0');
  fd.append('storage_limit', storage || '3072');
  if (parsedEnv) fd.append('env_vars', parsedEnv);
  if (reqFile) fd.append('requirements_file', reqFile);

  for (const f of uploadedFiles) {
    const rel = f.webkitRelativePath || f.name;
    const withoutRoot = rel.split('/').slice(1).join('/') || f.name;
    fd.append('file_paths', withoutRoot);   // explicit path — backend uses this
    fd.append('files', f, withoutRoot);     // multer may strip dir, that's ok now
  }

  try {
    const resp    = await fetch(`${API}/functions/deploy`, { method: 'POST', body: fd });
    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      let eventType = null;
      for (const line of lines) {
        if (line.startsWith('event: '))      eventType = line.slice(7).trim();
        else if (line.startsWith('data: ') && eventType) {
          try { handleSSEEvent(eventType, JSON.parse(line.slice(6))); } catch (_) {}
          eventType = null;
        }
      }
    }
  } catch (err) {
    appendLog(`❌ Network error: ${err.message}`, 'error');
    setLogStatus('failed', 'Failed');
    showToast(`Deploy failed: ${err.message}`, 'err');
  }

  isDeploying = false;
  btn.disabled = false;
  btnText.textContent = 'Deploy & Warm';
}

function handleSSEEvent(type, data) {
  if (type === 'log') {
    const lvl = data.level === 'error' ? 'error' : data.level === 'step' ? 'step' : null;
    appendLog(data.message, lvl);
  } else if (type === 'done') {
    if (data.success) {
      appendLog(`\n🎉 Deploy successful! ${data.warm_containers} warm containers ready.`, 'done-ok');
      setLogStatus('success', 'Success');
      showToast(`Deployed with ${data.warm_containers} warm containers 🔥`, 'ok');
      clearDeployForm();
    } else {
      appendLog(`\n❌ Deploy failed: ${data.error}`, 'done-fail');
      setLogStatus('failed', 'Failed');
      showToast(`Deploy failed: ${data.error}`, 'err');
    }
  }
}

/** Auto-clear deploy form after successful deploy */
function clearDeployForm() {
  document.getElementById('funcName').value = '';
  document.getElementById('entryPoint').innerHTML = '<option value="">— upload files first —</option>';
  document.getElementById('requirementsFile').innerHTML = '<option value="">— auto-detect —</option>';
  document.querySelectorAll('.runtime-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.runtime-btn[data-runtime="python"]').classList.add('active');
  selectedRuntime = 'python';
  warmCount = 2;
  document.getElementById('warmCount').textContent = '2';
  clearFiles();
}

// ─── Terminal helpers ─────────────────────────────────────────────────────────
function clearTerminal() {
  document.getElementById('terminal').innerHTML = '';
}
function appendLog(text, level = null) {
  const term = document.getElementById('terminal');
  const div  = document.createElement('div');
  if (level === 'step')           div.className = 'log-step';
  else if (level === 'error')     div.className = 'log-error';
  else if (level === 'done-ok')   div.className = 'log-done-ok';
  else if (level === 'done-fail') div.className = 'log-done-fail';
  div.textContent = text;
  term.appendChild(div);
  term.scrollTop = term.scrollHeight;
}
function setLogStatus(type, label) {
  const el = document.getElementById('logStatus');
  el.className = `log-status ${type}`;
  el.textContent = label;
}

// ─── Dashboard ───────────────────────────────────────────────────────────────
async function loadDashboard() { loadFunctions(); loadWorkers(); }

async function loadFunctions() {
  try {
    const resp = await fetch(`${API}/functions/deploy/status`);
    const { functions } = await resp.json();
    renderFunctions(functions || []);
  } catch (_) {}
}

function renderFunctions(funcs) {
  const grid = document.getElementById('functionsGrid');
  if (!funcs.length) {
    grid.innerHTML = `
      <div class="empty-state glass">
        <div class="empty-icon">🌙</div>
        <div class="empty-title">No functions yet</div>
        <div class="empty-sub">Deploy your first function to get started</div>
        <button class="btn-primary" onclick="showTab('deploy')">+ Deploy Function</button>
      </div>`;
    return;
  }

  grid.innerHTML = funcs.map(f => {
    const warmMax = 5;
    const pct = Math.min(100, (f.warm_count / warmMax) * 100);
    const icon = { python: '🐍', nodejs: '💛', php: '🐘' }[f.runtime] || '⚡';
    const pathUrl = `${GATEWAY}/fn/${f.name}`;
    const subUrl  = `http://${f.name}.localhost:8081`;
    // Encode function data safely for the onclick attribute
    const fJson   = encodeURIComponent(JSON.stringify(f));

    return `
      <div class="func-card glass">
        <div class="func-name">${icon} ${f.name}</div>
        <div class="func-meta">
          <span class="tag">${f.region}</span>
          <span class="tag runtime-${f.runtime || 'python'}">${f.runtime || 'python'}</span>
          <span class="tag" style="${f.status === 'active' ? 'background:rgba(16,185,129,0.15);color:#6ee7b7;border-color:rgba(16,185,129,0.3)' : ''}">${f.status}</span>
        </div>
        <div class="func-url">
          <div class="func-url-row">
            <span class="func-url-badge local">LOCAL</span>
            <code class="func-url-val" id="url-path-${f.name}">${pathUrl}</code>
            <button class="url-copy-btn" onclick="copyUrl('url-path-${f.name}')">⎘</button>
          </div>
          <div class="func-url-row">
            <span class="func-url-badge prod">HOST</span>
            <code class="func-url-val" id="url-sub-${f.name}">${subUrl}</code>
            <button class="url-copy-btn" onclick="copyUrl('url-sub-${f.name}')">⎘</button>
          </div>
        </div>
        <div class="func-warm">
          <span>🔥 ${f.warm_count} warm</span>
          <div class="warm-bar"><div class="warm-fill" style="width:${pct}%"></div></div>
          <span style="font-size:0.7rem;color:var(--text-muted)">${f.claimed_count} active</span>
        </div>
        <div class="func-actions">
          <button class="btn-ghost" onclick="openTestDialog('${fJson}')">⚡ Test</button>
          <button class="btn-ghost" onclick="openHistoryDialog('${fJson}')">📊 History</button>
          <button class="btn-ghost" onclick="replenishFunction('${f.id}')">🔥 Replenish</button>
          <button class="btn-ghost btn-danger" onclick="deleteFunction('${f.id}', '${f.name}')">🗑 Delete</button>
        </div>
      </div>`;
  }).join('');
}

async function loadWorkers() {
  try {
    const resp = await fetch(`${API}/workers`);
    const { workers } = await resp.json();
    renderWorkers(workers || []);
  } catch (_) {}
}

function renderWorkers(workers) {
  const grid = document.getElementById('workersGrid');
  if (!workers.length) {
    grid.innerHTML = `<div class="worker-empty glass">No workers registered. Use POST /init to add one.</div>`;
    return;
  }
  grid.innerHTML = workers.map(w => `
    <div class="worker-card">
      <div class="worker-dot ${w.status}"></div>
      <div class="worker-info">
        <div class="worker-ip">${w.ip}</div>
        <div class="worker-status">${w.status} · ${w.consecutive_failures || 0} failures</div>
      </div>
    </div>`).join('');
}

// ─── Test Dialog ──────────────────────────────────────────────────────────────
let testDialogFunc = null;
let testIsSending  = false;

function openTestDialog(fJson) {
  testDialogFunc = JSON.parse(decodeURIComponent(fJson));
  const f = testDialogFunc;

  document.getElementById('tdFuncName').textContent = f.name;
  document.getElementById('tdUrl').textContent = `${GATEWAY}/fn/${f.name}`;
  document.getElementById('tdMethod').value = 'POST';
  document.getElementById('tdBody').value = JSON.stringify({ hello: 'world' }, null, 2);
  document.getElementById('tdResponse').innerHTML = '<span style="color:var(--text-muted)">Hit Send to see the response…</span>';
  document.getElementById('tdStatus').textContent = '';
  document.getElementById('tdStatus').className = 'td-status';
  document.getElementById('tdLatency').textContent = '';
  onMethodChange();
  document.getElementById('testDialog').classList.add('open');
}

function closeTestDialog() {
  document.getElementById('testDialog').classList.remove('open');
  testDialogFunc = null;
}

function onMethodChange() {
  const method = document.getElementById('tdMethod').value;
  document.getElementById('tdBodyGroup').style.display = ['POST','PUT','PATCH'].includes(method) ? 'block' : 'none';
}

async function sendTestRequest() {
  if (testIsSending || !testDialogFunc) return;

  const method  = document.getElementById('tdMethod').value;
  const bodyRaw = document.getElementById('tdBody').value.trim();
  const url     = `${GATEWAY}/fn/${testDialogFunc.name}`;

  const respEl    = document.getElementById('tdResponse');
  const statusEl  = document.getElementById('tdStatus');
  const latencyEl = document.getElementById('tdLatency');
  const sendBtn   = document.getElementById('tdSendBtn');

  testIsSending = true;
  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending…';
  respEl.innerHTML = '<span style="color:var(--text-muted)">Waiting…</span>';
  statusEl.textContent = '';
  latencyEl.textContent = '';

  const opts = { method, headers: {} };
  if (['POST','PUT','PATCH'].includes(method)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = bodyRaw || '{}';
  }

  const t0 = performance.now();
  try {
    const resp = await fetch(url, opts);
    const ms   = (performance.now() - t0).toFixed(0);
    const ct   = resp.headers.get('content-type') || '';
    let body;
    if (ct.includes('application/json')) {
      body = JSON.stringify(await resp.json(), null, 2);
    } else {
      body = await resp.text();
    }
    respEl.textContent = body;
    latencyEl.textContent = `${ms}ms`;
    statusEl.textContent  = `${resp.status} ${resp.statusText}`;
    statusEl.className    = `td-status ${resp.ok ? 'ok' : 'err'}`;
  } catch (err) {
    const ms = (performance.now() - t0).toFixed(0);
    respEl.textContent    = err.message;
    statusEl.textContent  = 'Network error';
    statusEl.className    = 'td-status err';
    latencyEl.textContent = `${ms}ms`;
  }

  testIsSending = false;
  sendBtn.disabled = false;
  sendBtn.textContent = 'Send';
}

// ─── History Dialog ───────────────────────────────────────────────────────────
async function openHistoryDialog(fJson) {
  const f = JSON.parse(decodeURIComponent(fJson));
  document.getElementById('hdFuncName').textContent = f.name;
  
  let memLabel = (f.memory_limit || 512) >= 1024 ? `${(f.memory_limit || 512)/1024} GB` : `${f.memory_limit || 512} MB`;
  let storageLabel = (f.storage_limit || 512) >= 1024 ? `${(f.storage_limit || 512)/1024} GB` : `${f.storage_limit || 512} MB`;
  
  document.getElementById('hdMemory').textContent = memLabel;
  document.getElementById('hdCpu').textContent = `${f.cpu_limit || 1.0} vCPU`;
  document.getElementById('hdStorage').textContent = storageLabel;
  document.getElementById('hdTotal').textContent = 'Loading...';
  document.getElementById('hdLogBody').innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px;opacity:0.6;">Loading history...</td></tr>';
  
  document.getElementById('historyDialog').classList.add('open');

  try {
    const resp = await fetch(`${API}/functions/${f.id}`);
    const data = await resp.json();
    const invs = data.invocations || [];
    
    document.getElementById('hdTotal').textContent = invs.length;
    
    if (invs.length === 0) {
      document.getElementById('hdLogBody').innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px;opacity:0.6;">No invocations yet</td></tr>';
      return;
    }
    
    document.getElementById('hdLogBody').innerHTML = invs.map(i => {
        const d = new Date(i.created_at + 'Z');
        const time = isNaN(d) ? i.created_at : d.toLocaleString();
        const statusColor = (i.status_code >= 200 && i.status_code < 300) ? '#10b981' : '#ef4444';
        return `
            <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                <td style="padding: 10px; font-size: 12px; color: var(--text-muted);">${time}</td>
                <td style="padding: 10px;">
                    <span style="font-weight: 600; font-size: 12px; background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; margin-right: 6px;">${i.request_method}</span>
                    <span style="font-family: monospace; font-size: 13px;">${i.request_path}</span>
                </td>
                <td style="padding: 10px; color: ${statusColor}; font-weight: 600;">${i.status_code}</td>
                <td style="padding: 10px; font-family: monospace;">${i.latency_ms} ms <span style="color:var(--text-muted)">(${(i.latency_ms/1000).toFixed(2)}s)</span></td>
            </tr>
        `;
    }).join('');
  } catch (err) {
    document.getElementById('hdLogBody').innerHTML = `<tr><td colspan="4" style="text-align:center;padding:20px;color:#ef4444;">Failed to load history: ${err.message}</td></tr>`;
  }
}

function closeHistoryDialog() {
  document.getElementById('historyDialog').classList.remove('open');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function replenishFunction(funcId) {
  try {
    await fetch(`${API}/warm-pool/replenish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ function_id: funcId }),
    });
    showToast('Replenishment triggered 🔥', 'ok');
    loadDashboard();
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'err');
  }
}

async function deleteFunction(funcId, funcName) {
  if (!confirm(`Delete function "${funcName}"?\n\nThis will:\n• Stop all warm + active containers\n• Remove the image from the worker\n• Delete the build directory\n\nThis cannot be undone.`)) return;

  showToast(`Deleting ${funcName}…`, 'ok');
  try {
    const resp = await fetch(`${API}/functions/${funcId}`, { method: 'DELETE' });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Delete failed');
    showToast(`✅ ${funcName} deleted`, 'ok');
    loadDashboard();
  } catch (err) {
    showToast(`Delete failed: ${err.message}`, 'err');
  }
}

function copyUrl(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent.trim()).then(() => showToast('Copied!', 'ok'));
}

async function checkApi() {
  try {
    const resp  = await fetch(`${API}/health`);
    const dot   = document.getElementById('apiStatus');
    const label = document.getElementById('apiStatusLabel');
    if (resp.ok) {
      dot.className = 'status-dot online';
      label.textContent = 'API connected';
    } else {
      dot.className = 'status-dot error';
      label.textContent = 'API error';
    }
  } catch (_) {
    document.getElementById('apiStatus').className = 'status-dot error';
    document.getElementById('apiStatusLabel').textContent = 'API offline';
  }
}

function showToast(message, type = 'ok') {
  const t = document.getElementById('toast');
  t.textContent = message;
  t.className = `toast show ${type}`;
  setTimeout(() => { t.className = 'toast'; }, 3500);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  checkApi();
  setInterval(checkApi, 10000);

  // Close test dialog when clicking the backdrop
  const dlg = document.getElementById('testDialog');
  if (dlg) dlg.addEventListener('click', e => { if (e.target === dlg) closeTestDialog(); });

  // Drag & drop for the upload zone
  const zone = document.getElementById('uploadZone');
  if (zone) {
    zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', ()  => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const files = [];
      for (const item of (e.dataTransfer.items || [])) {
        if (item.kind === 'file') files.push(item.getAsFile());
      }
      if (files.length) onFilesSelected(files);
    });
  }
});

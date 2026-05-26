// ── IndexedDB History Manager ─────────────────────────────────────────────────
// All report data lives in the user's own browser. The server never stores it.
const HistoryDB = (() => {
  const DB_NAME = 'econtract-history'
  const STORE   = 'reports'
  const VERSION = 1

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION)
      req.onupgradeneeded = e => {
        const db = e.target.result
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true })
          store.createIndex('savedAt', 'savedAt', { unique: false })
        }
      }
      req.onsuccess = e => resolve(e.target.result)
      req.onerror   = e => reject(e.target.error)
    })
  }

  async function save(report, filename) {
    const db = await open()
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      const entry = {
        savedAt:   Date.now(),
        filename:  filename || `report-${report.docId?.slice(0,8) ?? 'unknown'}.json`,
        docId:     report.docId,
        analysedAt: report.analysedAt,
        pages:     report.pages,
        riskCount: report.risks?.length ?? 0,
        topLevel:  report.risks?.sort((a,b)=>({critical:4,high:3,medium:2,low:1}[b.level]-({critical:4,high:3,medium:2,low:1}[a.level])))[0]?.level ?? 'none',
        report,    // full report stored locally
      }
      const req = store.add(entry)
      req.onsuccess = () => resolve(req.result)
      req.onerror   = e => reject(e.target.error)
      tx.commit?.()
    })
  }

  async function list() {
    const db = await open()
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE, 'readonly')
      const store = tx.objectStore(STORE)
      const index = store.index('savedAt')
      const req   = index.getAll()
      req.onsuccess = () => resolve(req.result.reverse()) // newest first
      req.onerror   = e => reject(e.target.error)
    })
  }

  async function remove(id) {
    const db = await open()
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readwrite')
      const req = tx.objectStore(STORE).delete(id)
      req.onsuccess = () => resolve()
      req.onerror   = e => reject(e.target.error)
      tx.commit?.()
    })
  }

  return { save, list, remove }
})()

// ── DOM refs ──────────────────────────────────────────────────────────────────
const form         = document.querySelector('#analyze-form')
const fileInput    = document.querySelector('#contract-file')
const fileLabel    = document.querySelector('#file-label')
const statusText   = document.querySelector('#status')
const results      = document.querySelector('#results')
const dropzone     = document.querySelector('#dropzone')
const submitBtn    = document.querySelector('#submit-btn')
const submitLabel  = document.querySelector('#submit-label')
const progressCtr  = document.querySelector('#progress-container')
const progressFill = document.querySelector('#progress-fill')
const progressStep = document.querySelector('#progress-step')
const progressPct  = document.querySelector('#progress-percent')
const queueInfo    = document.querySelector('#queue-info')
const sideStats    = document.querySelector('#side-stats')
const emptyState   = document.querySelector('#empty-state')
const historyList  = document.querySelector('#history-list')

const riskRank = { critical: 4, high: 3, medium: 2, low: 1 }

// ── View switching ─────────────────────────────────────────────────────────────
window.switchView = function (view, event) {
  event?.preventDefault?.()
  document.querySelectorAll('.view').forEach(v => v.hidden = true)
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'))
  document.getElementById(`view-${view}`).hidden = false
  document.getElementById(`nav-${view}`).classList.add('active')
  if (view === 'history') loadHistory()
}

// ── File input ─────────────────────────────────────────────────────────────────
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0]
  fileLabel.textContent = f ? `${f.name}  ·  ${formatBytes(f.size)}` : 'Up to 20 MB · Text-layer PDF'
})

for (const evt of ['dragenter', 'dragover']) {
  dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.add('is-over') })
}
for (const evt of ['dragleave', 'drop']) {
  dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.remove('is-over') })
}
dropzone.addEventListener('drop', e => {
  const f = e.dataTransfer?.files?.[0]
  if (!f) return
  const dt = new DataTransfer(); dt.items.add(f)
  fileInput.files = dt.files
  fileInput.dispatchEvent(new Event('change'))
})

// ── Form submit ────────────────────────────────────────────────────────────────
form.addEventListener('submit', async e => {
  e.preventDefault()
  const file = fileInput.files?.[0]
  if (!file) return setStatus('Choose a PDF first.', true)
  if (file.type !== 'application/pdf') return setStatus('Only PDF files are supported.', true)

  const body = new FormData()
  body.append('contract', file)

  setLoading(true)
  hideQueueInfo()
  showProgress(0, 'ocr', 'Uploading…')

  try {
    const res = await fetch('/api/analyze', { method: 'POST', body })
    const payload = await res.json()

    if (res.status === 200) {
      renderReport(payload)
      setStatus('⚡ Returned from cache instantly.')
      hideProgress()
      setLoading(false)
      // Also save to local history on cache hit (different filename, same data)
      const fname = fileInput.files?.[0]?.name ?? 'contract.pdf'
      HistoryDB.save(payload, fname).catch(() => {})
      return
    }

    if (res.status === 202 && payload.jobId) {
      setStatus(payload.message ?? 'Analysis queued…')
      showProgress(5, 'ocr', payload.message ?? 'Starting pipeline…')
      connectSSE(payload.jobId)
      return
    }

    throw new Error(buildErrorMessage(payload))
  } catch (err) {
    renderError(err.message)
    setStatus(err.message, true)
    hideProgress()
    setLoading(false)
  }
})

// ── SSE ────────────────────────────────────────────────────────────────────────
function connectSSE(jobId) {
  const es = new EventSource(`/api/jobs/${jobId}/stream`)

  es.onmessage = e => {
    try {
      const data = JSON.parse(e.data)
      showProgress(data.progress, data.step, data.message)

      if (data.status === 'queued') showQueueInfo(`⏳ ${data.message}`)
      else hideQueueInfo()

      if (data.status === 'completed') {
        es.close(); hideProgress(); setLoading(false)
        if (data.result) {
          const fname = fileInput.files?.[0]?.name ?? 'contract.pdf'
          renderReport(data.result)
          setStatus(`✅ Analysis complete in ${formatDuration(data.result._meta?.durationMs)}.`)
          HistoryDB.save(data.result, fname).catch(() => {})
        }
      }

      if (data.status === 'failed') {
        es.close(); hideProgress(); setLoading(false)
        renderError(data.message)
        setStatus(data.message, true)
      }
    } catch {}
  }

  es.onerror = () => {
    es.close()
    setTimeout(async () => {
      try {
        const r = await fetch(`/api/jobs/${jobId}`)
        const job = await r.json()
        if (job.status === 'completed' && job.result) {
          renderReport(job.result)
          setStatus(`✅ Done in ${formatDuration(job.result._meta?.durationMs)}.`)
        } else if (job.status === 'failed') {
          renderError(job.message)
          setStatus(job.message, true)
        } else {
          setStatus('Connection lost. Refresh to check.', true)
        }
      } catch { setStatus('Connection lost. Try again.', true) }
      hideProgress(); setLoading(false)
    }, 1500)
  }
}

// ── Report rendering ───────────────────────────────────────────────────────────
function renderReport(report) {
  window.__lastReport = report
  if (emptyState) emptyState.remove()

  const risks = [...(report.risks ?? [])].sort((a, b) => riskRank[b.level] - riskRank[a.level])
  const topLevel = risks[0]?.level ?? 'low'
  const isCached = report._meta?.cached

  // Compute an intuitive risk score out of 100
  const riskScore = computeRiskScore(risks)
  const { verdictClass, verdictIcon, verdictTitle, verdictSub } = getVerdict(topLevel, risks.length)

  // Render side stats
  renderSideStats(report, riskScore)

  results.innerHTML = `
    ${isCached ? '<div style="text-align:right;margin-bottom:8px"><span class="cached-badge">⚡ Instant — cached</span></div>' : ''}

    <!-- Verdict banner -->
    <div class="verdict-banner ${verdictClass}">
      <div class="verdict-left">
        <div class="verdict-icon">${verdictIcon}</div>
        <div>
          <div class="verdict-label">Overall Assessment</div>
          <div class="verdict-title">${verdictTitle}</div>
          <div class="verdict-sub">${verdictSub}</div>
        </div>
      </div>
      <div class="verdict-score">
        <div class="score-number">${riskScore}</div>
        <div class="score-sub">Risk Score</div>
      </div>
    </div>

    <!-- Executive summary -->
    <div class="executive-summary">
      <div class="section-header">
        <span class="section-title">Executive Summary</span>
      </div>
      <div class="summary-body">${formatSummary(report.summary)}</div>
    </div>

    <!-- Risk flags -->
    <div class="section-label">⚠ Risk Flags (${risks.length})</div>
    <div class="risks-section">
      ${risks.length
        ? risks.map(renderRiskCard).join('')
        : `<div class="no-risks-card"><span class="no-risks-icon">✅</span><span>No risk flags identified — this contract looks clean.</span></div>`
      }
    </div>

    <!-- Clauses -->
    <div class="section-label">📋 Clauses (${report.clauses?.length ?? 0})</div>
    <div class="clauses-section">
      ${renderClauseGroups(report.clauses ?? [], risks)}
    </div>

    <!-- Actions -->
    <div class="report-actions">
      <button class="btn btn-primary" onclick="downloadReportJSON()">⬇ Download JSON</button>
      <button class="btn" onclick="copyReportSummary()">📋 Copy Summary</button>
      <button class="btn" onclick="copyMarkdownReport()">📝 Copy as Markdown</button>
    </div>
  `

  // Attach collapsible clause group handlers
  document.querySelectorAll('.clause-group-header').forEach(header => {
    header.addEventListener('click', () => {
      header.closest('.clause-group').classList.toggle('open')
    })
  })

  // Attach clause expand/collapse (raw text)
  document.querySelectorAll('.clause-toggle').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const card = btn.closest('.clause-card')
      const expanded = card.classList.toggle('expanded')
      btn.textContent = expanded ? 'Hide original text ▲' : 'Show original text ▼'
    })
  })
}

// ── Verdict helpers ────────────────────────────────────────────────────────────
function computeRiskScore(risks) {
  if (!risks.length) return 0
  const weights = { critical: 40, high: 20, medium: 10, low: 3 }
  const raw = risks.reduce((sum, r) => sum + (weights[r.level] ?? 0), 0)
  return Math.min(100, raw)
}

function getVerdict(topLevel, riskCount) {
  if (riskCount === 0)
    return { verdictClass: 'safe', verdictIcon: '✅', verdictTitle: 'No Risks Found', verdictSub: 'All clauses appear standard and balanced.' }
  if (topLevel === 'critical')
    return { verdictClass: 'critical', verdictIcon: '🚨', verdictTitle: 'Critical Issues Found', verdictSub: `${riskCount} flag${riskCount > 1 ? 's' : ''} require immediate attention before signing.` }
  if (topLevel === 'high')
    return { verdictClass: 'high', verdictIcon: '⚠️', verdictTitle: 'High Risk Detected', verdictSub: `${riskCount} clause${riskCount > 1 ? 's' : ''} should be negotiated or reviewed by counsel.` }
  if (topLevel === 'medium')
    return { verdictClass: 'medium', verdictIcon: '🔶', verdictTitle: 'Moderate Risk', verdictSub: `${riskCount} clause${riskCount > 1 ? 's' : ''} worth discussing with the other party.` }
  return { verdictClass: 'safe', verdictIcon: '🟢', verdictTitle: 'Low Risk', verdictSub: `${riskCount} minor flag${riskCount > 1 ? 's' : ''} noted — likely acceptable.` }
}

// ── Risk card ──────────────────────────────────────────────────────────────────
function renderRiskCard(risk) {
  const level = risk.level ?? 'medium'
  const levelLabel = { critical: '🔴 Critical', high: '🟠 High', medium: '🟡 Medium', low: '🟢 Low' }[level] ?? level

  return `
    <div class="risk-card level-${level}">
      <div class="risk-topline">
        <span class="badge ${level}">${levelLabel}</span>
        ${risk.clauseId ? `<span class="badge type">${formatType(risk.clauseId.split('-')[0])}</span>` : ''}
        <span class="risk-location">§ ${escapeHtml(risk.sectionId ?? '')} · p.${risk.pageNumber ?? '?'}</span>
      </div>
      <p class="risk-description">${escapeHtml(risk.description)}</p>
      <div class="risk-recommendation">
        <span class="rec-icon">💡</span>
        <span class="rec-text"><strong>Recommendation:</strong> ${escapeHtml(risk.recommendation)}</span>
      </div>
      ${risk.precedent ? `
        <div class="precedent-box">
          <div class="precedent-label">Standard precedent language</div>
          "${escapeHtml(risk.precedent)}"
        </div>
      ` : ''}
    </div>
  `
}

// ── Clause groups (collapsible, grouped by type) ───────────────────────────────
function renderClauseGroups(clauses, risks) {
  if (!clauses.length) return '<p style="color:var(--ink-muted);font-size:0.9rem">No clauses extracted.</p>'

  const flaggedIds = new Set(risks.map(r => r.clauseId))

  // Group by type
  const groups = {}
  for (const c of clauses) {
    const key = c.type ?? 'other'
    if (!groups[key]) groups[key] = []
    groups[key].push(c)
  }

  // Sort: flagged groups first
  const sortedKeys = Object.keys(groups).sort((a, b) => {
    const aFlagged = groups[a].some(c => flaggedIds.has(c.clauseId)) ? 1 : 0
    const bFlagged = groups[b].some(c => flaggedIds.has(c.clauseId)) ? 1 : 0
    return bFlagged - aFlagged
  })

  return sortedKeys.map(type => {
    const items = groups[type]
    const hasFlagged = items.some(c => flaggedIds.has(c.clauseId))
    const label = formatType(type)
    const icon = clauseTypeIcon(type)
    const isOpen = hasFlagged // auto-open flagged groups

    return `
      <div class="clause-group ${isOpen ? 'open' : ''}">
        <div class="clause-group-header" role="button" aria-expanded="${isOpen}">
          <span>${icon}</span>
          <span class="clause-group-title">${label} ${hasFlagged ? '⚠' : ''}</span>
          <span class="clause-group-count">${items.length} clause${items.length !== 1 ? 's' : ''}</span>
          <span class="clause-group-arrow">▼</span>
        </div>
        <div class="clause-group-body">
          ${items.map(c => renderClauseCard(c, flaggedIds)).join('')}
        </div>
      </div>
    `
  }).join('')
}

function renderClauseCard(clause, flaggedIds) {
  const isFlagged = flaggedIds.has(clause.clauseId)
  return `
    <div class="clause-card ${isFlagged ? 'flagged' : ''}">
      <div class="clause-meta">
        ${isFlagged ? '<span class="badge critical" style="font-size:0.65rem;padding:2px 7px">⚠ Flagged</span>' : ''}
        <span class="clause-section">§ ${escapeHtml(clause.sectionId ?? '')} · p.${clause.pageNumber ?? '?'}</span>
      </div>
      <p class="clause-summary">${escapeHtml(clause.summary)}</p>
      ${clause.rawText ? `
        <button class="clause-toggle">Show original text ▼</button>
        <div class="clause-raw">${escapeHtml(clause.rawText)}</div>
      ` : ''}
    </div>
  `
}

// ── Side stats ─────────────────────────────────────────────────────────────────
function renderSideStats(report, riskScore) {
  sideStats.removeAttribute('hidden')
  const criticalCount = (report.risks ?? []).filter(r => r.level === 'critical').length
  const highCount = (report.risks ?? []).filter(r => r.level === 'high').length

  sideStats.innerHTML = [
    { label: 'Risk Score', value: `${riskScore}/100` },
    { label: 'Pages', value: report.pages ?? '—' },
    { label: 'Clauses', value: report.clauses?.length ?? 0 },
    { label: 'Flags', value: report.risks?.length ?? 0 },
    criticalCount ? { label: '🔴 Critical', value: criticalCount } : null,
    highCount     ? { label: '🟠 High',     value: highCount }     : null,
    report._meta?.durationMs ? { label: 'Analysis time', value: formatDuration(report._meta.durationMs) } : null,
  ]
  .filter(Boolean)
  .map(s => `
    <div class="stat-box">
      <div class="stat-label">${s.label}</div>
      <div class="stat-value">${s.value}</div>
    </div>
  `).join('')
}

// ── Error rendering ────────────────────────────────────────────────────────────
function renderError(message) {
  results.innerHTML = `
    <div class="error-card">
      <div style="font-size:2.5rem">❌</div>
      <div class="error-card-title">Analysis Failed</div>
      <div class="error-card-msg">${escapeHtml(message)}</div>
    </div>
  `
}

// ── Report actions ─────────────────────────────────────────────────────────────
window.downloadReportJSON = function () {
  if (!window.__lastReport) return
  const blob = new Blob([JSON.stringify(window.__lastReport, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `risk-report-${window.__lastReport.docId?.slice(0, 8) ?? 'export'}.json`
  a.click()
  URL.revokeObjectURL(url)
}

window.copyReportSummary = function () {
  if (!window.__lastReport?.summary) return
  navigator.clipboard.writeText(window.__lastReport.summary).then(() => {
    setStatus('Summary copied to clipboard!')
    setTimeout(() => setStatus(''), 2000)
  })
}

window.copyMarkdownReport = function () {
  const r = window.__lastReport
  if (!r) return
  const risks = [...(r.risks ?? [])].sort((a, b) => riskRank[b.level] - riskRank[a.level])
  const lines = [
    `# Contract Risk Report`,
    ``,
    `**Analyzed:** ${new Date(r.analysedAt).toLocaleString()}  `,
    `**Pages:** ${r.pages}  |  **Clauses:** ${r.clauses?.length}  |  **Risk Flags:** ${risks.length}`,
    ``,
    `## Executive Summary`,
    r.summary,
    ``,
    `## Risk Flags`,
    ...risks.map(risk => [
      `### [${risk.level.toUpperCase()}] Section ${risk.sectionId} (p.${risk.pageNumber})`,
      risk.description,
      ``,
      `**Recommendation:** ${risk.recommendation}`,
      risk.precedent ? `\n> Standard precedent: "${risk.precedent}"` : '',
    ].join('\n')),
    ``,
    `---`,
    `*${r.disclaimer}*`,
  ]
  navigator.clipboard.writeText(lines.join('\n')).then(() => {
    setStatus('Full report copied as Markdown!')
    setTimeout(() => setStatus(''), 2500)
  })
}

// ── History (client-side IndexedDB) ───────────────────────────────────────────
async function loadHistory() {
  try {
    const entries = await HistoryDB.list()
    if (!entries.length) {
      historyList.innerHTML = `
        <div style="padding:32px;text-align:center">
          <div style="font-size:2.5rem;opacity:0.3;margin-bottom:12px">📂</div>
          <p style="color:var(--ink-secondary);font-size:0.95rem">No reports yet.</p>
          <p style="color:var(--ink-muted);font-size:0.82rem;margin-top:6px">Your history is stored privately in this browser — no one else can see it.</p>
        </div>
      `
      return
    }
    historyList.innerHTML = entries.slice(0, 50).map(entry => {
      const levelColors = { critical:'var(--red)', high:'var(--orange)', medium:'var(--yellow)', low:'var(--green)', none:'var(--ink-muted)' }
      const levelColor  = levelColors[entry.topLevel] ?? 'var(--ink-muted)'
      return `
        <div class="history-card">
          <div style="display:flex;align-items:center;gap:10px;min-width:0">
            <span style="font-size:1.4rem;flex-shrink:0">📄</span>
            <div style="min-width:0">
              <div class="history-card-name" title="${escapeHtml(entry.filename)}">${escapeHtml(entry.filename)}</div>
              <div class="history-card-meta">
                ${formatDate(new Date(entry.savedAt).toISOString())}
                · ${entry.pages ?? '?'} page${entry.pages !== 1 ? 's' : ''}
                · <span style="color:${levelColor};font-weight:600">${entry.riskCount} flag${entry.riskCount !== 1 ? 's' : ''}</span>
              </div>
            </div>
          </div>
          <div class="history-card-actions">
            <button class="btn" onclick="viewLocalReport(${entry.id})">View</button>
            <button class="btn" onclick="downloadLocalReport(${entry.id})">⬇</button>
            <button class="btn" style="color:var(--red);border-color:rgba(248,113,113,0.2)" onclick="deleteLocalReport(${entry.id})">🗑</button>
          </div>
        </div>
      `
    }).join('')
  } catch (err) {
    historyList.innerHTML = '<p class="empty-copy">Could not load history.</p>'
  }
}

window.viewLocalReport = async function (id) {
  switchView('analyze')
  try {
    const entries = await HistoryDB.list()
    const entry = entries.find(e => e.id === id)
    if (!entry?.report) { setStatus('Report not found in local storage.', true); return }
    renderReport(entry.report)
    setStatus('Viewing saved report from local history.')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  } catch {
    setStatus('Failed to load local report.', true)
  }
}

window.downloadLocalReport = async function (id) {
  try {
    const entries = await HistoryDB.list()
    const entry = entries.find(e => e.id === id)
    if (!entry?.report) return
    const blob = new Blob([JSON.stringify(entry.report, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = entry.filename
    a.click()
    URL.revokeObjectURL(url)
  } catch {}
}

window.deleteLocalReport = async function (id) {
  if (!confirm('Remove this report from your local history?')) return
  try {
    await HistoryDB.remove(id)
    loadHistory()
  } catch {}
}

// ── Progress helpers ───────────────────────────────────────────────────────────
function showProgress(progress, step, message) {
  progressCtr.classList.add('active')
  progressFill.style.width = `${progress}%`
  progressStep.textContent = formatStepName(step)
  progressPct.textContent = `${progress}%`
  if (message) { statusText.textContent = message; statusText.classList.remove('error') }
}

function hideProgress() {
  progressCtr.classList.remove('active')
  progressFill.style.width = '0%'
}

function showQueueInfo(msg) { queueInfo.textContent = msg; queueInfo.classList.add('visible') }
function hideQueueInfo()    { queueInfo.classList.remove('visible') }

function formatStepName(step) {
  return { queued:'In Queue', ocr:'OCR Extraction', embedding:'Embedding', analysis:'AI Analysis', verifying:'Verification', completed:'Done', failed:'Failed' }[step] ?? step
}

// ── Misc helpers ───────────────────────────────────────────────────────────────
function setLoading(on) {
  submitBtn.disabled = on
  submitLabel.textContent = on ? 'Analyzing…' : 'Analyze Contract'
  submitBtn.classList.toggle('analyzing-pulse', on)
}

function setStatus(msg, isError = false) {
  statusText.textContent = msg
  statusText.classList.toggle('error', isError)
}

function buildErrorMessage(payload) {
  if (payload?.details?.length) return payload.details.join(' ')
  if (payload?.issues?.length) return payload.issues.join(' ')
  return payload?.error ?? 'The analysis request failed.'
}

function formatBytes(bytes) {
  if (!bytes) return '—'
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return 'a few moments'
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatDate(iso) {
  try { return new Date(iso).toLocaleDateString('en-IN', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) }
  catch { return iso }
}

function formatType(v) {
  return String(v).replaceAll('_', ' ').replace(/\b\w/g, l => l.toUpperCase())
}

function clauseTypeIcon(type) {
  return { confidentiality:'🔒', termination:'⏱', liability:'⚖', indemnification:'🛡', payment:'💰', ip:'💡', governing_law:'🏛', other:'📄' }[type] ?? '📄'
}

function formatSummary(text) {
  if (!text) return ''
  // Bold **...** patterns and render newlines as <br>
  return escapeHtml(text)
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n\*/g, '\n•')
    .replace(/\n/g, '<br>')
}

function escapeHtml(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;')
}

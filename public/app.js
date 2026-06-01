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
  
  const targetView = document.getElementById(`view-${view}`)
  const targetNav = document.getElementById(`nav-${view}`)
  
  if (targetView) targetView.hidden = false
  if (targetNav) targetNav.classList.add('active')
  
  if (view === 'history') loadHistory()
  window.scrollTo({ top: 0, behavior: 'instant' })
}

// ── File input ─────────────────────────────────────────────────────────────────
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0]
  fileLabel.textContent = f ? `${f.name}  ·  ${formatBytes(f.size)}` : 'Max 20 MB · Text-layer PDF'
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

// ── Quick-Try Sample NDA ────────────────────────────────────────────────
async function loadAndAnalyzeSample() {
  const trySampleLink = document.querySelector('#try-sample-link')
  const heroTrySampleBtn = document.querySelector('#hero-try-sample-btn')

  const setSampleLoading = (loading) => {
    if (trySampleLink) {
      trySampleLink.textContent = loading ? 'Loading…' : 'try our Sample NDA →'
      trySampleLink.style.pointerEvents = loading ? 'none' : ''
    }
    if (heroTrySampleBtn) {
      heroTrySampleBtn.textContent = loading ? 'Analyzing Sample…' : 'Try Sample Contract \u2192'
      heroTrySampleBtn.disabled = loading
    }
  }

  setSampleLoading(true)
  switchView('analyze') // Transition immediately to analyzer dashboard

  try {
    const response = await fetch('/sample-nda.pdf')
    if (!response.ok) throw new Error('Failed to fetch sample')
    const blob = await response.blob()
    const file = new File([blob], 'sample-nda.pdf', { type: 'application/pdf' })
    const dt = new DataTransfer()
    dt.items.add(file)
    fileInput.files = dt.files
    fileInput.dispatchEvent(new Event('change'))
    
    // Trigger submit
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  } catch (err) {
    setSampleLoading(false)
    setStatus('Could not load sample contract PDF.', true)
  }
}

const trySampleLink = document.querySelector('#try-sample-link')
if (trySampleLink) {
  trySampleLink.addEventListener('click', async e => {
    e.preventDefault()
    e.stopPropagation()
    await loadAndAnalyzeSample()
  })
}

const heroTrySampleBtn = document.querySelector('#hero-try-sample-btn')
if (heroTrySampleBtn) {
  heroTrySampleBtn.addEventListener('click', async e => {
    e.preventDefault()
    e.stopPropagation()
    await loadAndAnalyzeSample()
  })
}

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
  showProgress(0, 'ocr', 'Uploading agreement…')

  try {
    const res = await fetch('/api/analyze', { method: 'POST', body })
    const payload = await res.json()

    if (res.status === 200) {
      const fname = fileInput.files?.[0]?.name ?? 'contract.pdf'
      window.__lastReportFilename = fname
      renderReport(payload)
      setStatus('⚡ Analysis fetched instantly from local cache.')
      hideProgress()
      setLoading(false)
      // Also save to local history on cache hit (different filename, same data)
      HistoryDB.save(payload, fname).catch(() => {})
      return
    }

    if (res.status === 202 && payload.jobId) {
      setStatus(payload.message ?? 'Analysis queued…')
      showProgress(5, 'ocr', payload.message ?? 'Preparing pipelines…')
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
          window.__lastReportFilename = fname
          renderReport(data.result)
          setStatus(`✅ Analysis completed in ${formatDuration(data.result._meta?.durationMs)}.`)
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
          setStatus(`✅ Analysis completed in ${formatDuration(job.result._meta?.durationMs)}.`)
        } else if (job.status === 'failed') {
          renderError(job.message)
          setStatus(job.message, true)
        } else {
          setStatus('Connection lost. Refresh dashboard to re-verify status.', true)
        }
      } catch { setStatus('Network connection lost. Try running again.', true) }
      hideProgress(); setLoading(false)
    }, 1500)
  }
}

// ── Interactive Filters ────────────────────────────────────────────────────────
window.filterRisks = function (level, btnElement) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'))
  btnElement.classList.add('active')

  const cards = document.querySelectorAll('.risks-section .risk-card')
  let shownCount = 0

  cards.forEach(card => {
    if (level === 'all') {
      card.style.display = 'block'
      shownCount++
    } else {
      if (card.classList.contains(`level-${level}`)) {
        card.style.display = 'block'
        shownCount++
      } else {
        card.style.display = 'none'
      }
    }
  })

  // Update visual state if no cards exist
  const noRisksCard = document.querySelector('.no-risks-placeholder')
  if (noRisksCard) {
    noRisksCard.style.display = (shownCount === 0) ? 'flex' : 'none'
  }
}

// ── Word Diff Engine (LCS-based, no external library) ──────────────────────
// Returns HTML with <del> (removed) and <ins> (added) spans
function computeWordDiff(original, revised) {
  const aWords = original.split(/\s+/)
  const bWords = revised.split(/\s+/)
  const m = aWords.length, n = bWords.length
  // LCS DP table
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = aWords[i-1] === bWords[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1])
  // Backtrack
  const ops = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aWords[i-1] === bWords[j-1]) { ops.unshift({ type: 'eq', val: aWords[i-1] }); i--; j-- }
    else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) { ops.unshift({ type: 'ins', val: bWords[j-1] }); j-- }
    else { ops.unshift({ type: 'del', val: aWords[i-1] }); i-- }
  }
  // Group consecutive ops for cleaner output
  return ops.map(op => {
    const esc = escapeHtml(op.val)
    if (op.type === 'eq')  return esc
    if (op.type === 'del') return `<del class="diff-del">${esc}</del>`
    if (op.type === 'ins') return `<ins class="diff-ins">${esc}</ins>`
  }).join(' ')
}

// ── Negotiation Checklist Renderer ─────────────────────────────────────
function renderNegotiationChecklist(risks) {
  if (!risks.length) return ''
  const levelOrder = { critical: 0, high: 1, medium: 2, low: 3 }
  const sorted = [...risks].sort((a, b) => (levelOrder[a.level] ?? 4) - (levelOrder[b.level] ?? 4))
  const items = sorted.map((r, idx) => {
    const lvlLabel  = { critical: '🔴 Critical', high: '🟠 High', medium: '🟡 Medium', low: '🟢 Low' }[r.level] ?? r.level
    const lvlClass  = { critical: 'checklist-critical', high: 'checklist-high', medium: 'checklist-medium', low: 'checklist-low' }[r.level] ?? ''
    return `
      <label class="checklist-item" for="chk-${idx}">
        <input type="checkbox" id="chk-${idx}" class="checklist-checkbox">
        <div class="checklist-item-body">
          <div class="checklist-topline">
            <span class="checklist-badge ${lvlClass}">${lvlLabel}</span>
            <span class="checklist-ref">§${escapeHtml(r.sectionId ?? '')} &middot; Page ${r.pageNumber ?? '?'}</span>
          </div>
          <div class="checklist-action">${escapeHtml(r.recommendation)}</div>
        </div>
      </label>`
  }).join('')
  return `
    <div class="negotiation-checklist">
      <div class="checklist-header">
        <div class="checklist-header-left">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
          </svg>
          Negotiation Action Checklist
          <span class="checklist-count">${risks.length} item${risks.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="checklist-header-right" style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <input type="text" id="checklist-your-name" class="checklist-name-input" placeholder="Your Name" />
          <input type="text" id="checklist-counterparty" class="checklist-name-input" placeholder="Counterparty Name" />
          <button class="checklist-email-btn" onclick="copyNegotiationEmail()">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            Copy Email
          </button>
          <button class="btn-primary-gmail" onclick="openInGmail()">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:2px;"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
            Open in Gmail &rarr;
          </button>
        </div>
      </div>
      <div class="checklist-list">${items}</div>
    </div>`
}

window.copyNegotiationEmail = function () {
  const r = window.__lastReport
  if (!r?.risks?.length) return
  
  const yourName = document.getElementById('checklist-your-name')?.value || '[Your Name]'
  const counterpartyName = document.getElementById('checklist-counterparty')?.value || '[Counterparty Name]'

  const levelOrder = { critical: 0, high: 1, medium: 2, low: 3 }
  const sorted = [...r.risks].sort((a, b) => (levelOrder[a.level] ?? 4) - (levelOrder[b.level] ?? 4))
  const lines = [
    'Subject: Contract Review — Action Items Requiring Resolution',
    '',
    `Dear ${counterpartyName},`,
    '',
    'Following our review of the attached agreement, we have identified the following',
    'items that require discussion and resolution before we can proceed to execution:',
    '',
    ...sorted.map((r, i) => `${i + 1}. [${r.level.toUpperCase()}] Section §${r.sectionId ?? ''} (Page ${r.pageNumber ?? '?'}) — ${r.recommendation}`),
    '',
    'We are happy to discuss any of these points and look forward to reaching a mutually',
    'acceptable resolution.',
    '',
    'Best regards,',
    yourName,
  ]
  navigator.clipboard.writeText(lines.join('\n')).then(() => {
    showToast('Negotiation email draft copied to clipboard.')
  })
}

window.openInGmail = function() {
  const r = window.__lastReport
  if (!r?.risks?.length) return

  const yourName = document.getElementById('checklist-your-name')?.value || '[Your Name]'
  const counterpartyName = document.getElementById('checklist-counterparty')?.value || '[Counterparty Name]'

  const levelOrder = { critical: 0, high: 1, medium: 2, low: 3 }
  const sorted = [...r.risks].sort((a, b) => (levelOrder[a.level] ?? 4) - (levelOrder[b.level] ?? 4))
  
  const bodyIntro = `Dear ${counterpartyName},\n\nFollowing our review of the attached agreement, we have identified the following items that require discussion and resolution before we can proceed to execution:\n\n`;
  const bodyItems = sorted.map((r, i) => `${i + 1}. [${r.level.toUpperCase()}] Section §${r.sectionId ?? ''} (Page ${r.pageNumber ?? '?'}) — ${r.recommendation}`).join('\n');
  const bodyOutro = `\n\nWe are happy to discuss any of these points and look forward to reaching a mutually acceptable resolution.\n\nBest regards,\n${yourName}`;

  let fullBody = bodyIntro + bodyItems + bodyOutro;
  
  if (fullBody.length > 1800) {
    const trimmedItems = sorted.slice(0, 8).map((r, i) => `${i + 1}. [${r.level.toUpperCase()}] Section §${r.sectionId ?? ''} (Page ${r.pageNumber ?? '?'}) — ${r.recommendation}`).join('\n');
    const note = `\n\n[Note: Action items list truncated for email length. ${sorted.length - 8} additional items are available in the full report.]`;
    fullBody = bodyIntro + trimmedItems + note + bodyOutro;
  }

  const subject = "Contract Review — Action Items Requiring Resolution";
  const gmailUrl = `https://mail.google.com/mail/?view=cm&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(fullBody)}`;
  
  window.open(gmailUrl, '_blank');
  showToast('Opening Gmail compose tab...');
}

// ── Report rendering ───────────────────────────────────────────────────────────
function renderReport(report) {
  window.__lastReport = report
  const existingEmptyState = document.querySelector('#empty-state')
  if (existingEmptyState) existingEmptyState.remove()

  const risks = [...(report.risks ?? [])].sort((a, b) => riskRank[b.level] - riskRank[a.level])
  const topLevel = risks[0]?.level ?? 'low'
  const isCached = report._meta?.cached

  // Calculate risk score
  const riskScore = computeRiskScore(risks)
  const { verdictClass, verdictTitle, verdictSub, verdictSvgPath } = getVerdict(topLevel, risks.length)

  // Render sidebar stats
  renderSideStats(report, riskScore)

  results.innerHTML = `
    ${isCached ? '<div style="text-align:right;margin-bottom:12px"><span class="cached-badge"><svg width="10" height="10" style="fill:currentColor" viewBox="0 0 24 24"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>⚡ Instant (Cached)</span></div>' : ''}

    <!-- Verdict Banner with Circular Dial Gauge -->
    <div class="verdict-banner ${verdictClass}">
      <div class="verdict-left">
        <div class="verdict-badge-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            ${verdictSvgPath}
          </svg>
        </div>
        <div>
          <div class="verdict-label">Audit Conclusion</div>
          <div class="verdict-title">${verdictTitle}</div>
          <div class="verdict-sub">${verdictSub}</div>
        </div>
      </div>
      
      <!-- Circular Progress Score Gauge -->
      <div class="verdict-score-gauge-wrapper">
        <svg class="score-gauge-svg" viewBox="0 0 80 80">
          <circle class="gauge-track" cx="40" cy="40" r="35" fill="none" stroke-width="6"></circle>
          <circle class="gauge-fill" cx="40" cy="40" r="35" fill="none" stroke-width="6"
                  stroke-dasharray="220" stroke-dashoffset="${220 - (220 * riskScore) / 100}"></circle>
        </svg>
        <div class="gauge-text-overlay">
          <span class="gauge-val">${riskScore}</span>
          <span class="gauge-lbl">Risk</span>
        </div>
      </div>
    </div>

    <!-- Executive Summary Card -->
    <div class="executive-summary">
      <div class="section-header">
        <span class="section-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
          Executive Summary
        </span>
      </div>
      <div class="summary-body">${formatSummary(report.summary)}</div>
    </div>

    <!-- Negotiation Action Checklist -->
    ${renderNegotiationChecklist(risks)}

    <!-- Risk Level Filter Tabs -->
    <div class="section-label">Identified Liabilities</div>
    
    <div class="dashboard-filter-bar">
      <button class="filter-btn active" onclick="filterRisks('all', this)">
        All <span class="filter-badge">${risks.length}</span>
      </button>
      <button class="filter-btn" onclick="filterRisks('critical', this)">
        🔴 Critical <span class="filter-badge">${risks.filter(r => r.level === 'critical').length}</span>
      </button>
      <button class="filter-btn" onclick="filterRisks('high', this)">
        🟠 High <span class="filter-badge">${risks.filter(r => r.level === 'high').length}</span>
      </button>
      <button class="filter-btn" onclick="filterRisks('medium', this)">
        🟡 Medium <span class="filter-badge">${risks.filter(r => r.level === 'medium').length}</span>
      </button>
      <button class="filter-btn" onclick="filterRisks('low', this)">
        🟢 Low <span class="filter-badge">${risks.filter(r => r.level === 'low').length}</span>
      </button>
    </div>

    <!-- Risk Flags List -->
    <div class="risks-section">
      ${risks.length
        ? risks.map((r, idx) => renderRiskCard(r, idx, report.clauses ?? [])).join('')
        : `<div class="no-risks-card"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg><span>No risk flags identified — this contract layout appears compliant.</span></div>`
      }
      <!-- Filter placeholder when all items in standard categories are filtered out -->
      <div class="no-risks-card no-risks-placeholder" style="display:none">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
        <span>No matching risk flags for this specific selection tier.</span>
      </div>
    </div>

    <!-- Clauses Accordion Section -->
    <div class="section-label">Clause-by-Clause Index</div>
    <div class="clauses-section">
      ${renderClauseGroups(report.clauses ?? [], risks)}
    </div>

    <!-- Action Center -->
    <div class="report-actions">
      <button class="btn btn-primary" onclick="downloadReportJSON()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download JSON
      </button>
      <button class="btn" onclick="copyReportSummary()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copy Summary
      </button>
      <button class="btn" onclick="copyMarkdownReport()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
        Copy as Markdown
      </button>
      <button class="btn" onclick="printReport()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
        Print Report
      </button>
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
      
      // Update indicator text and arrow icon
      btn.innerHTML = expanded 
        ? `Hide original text <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transform:rotate(180deg)"><polyline points="6 9 12 15 18 9"/></svg>`
        : `Show original text <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>`
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
  if (riskCount === 0) {
    return {
      verdictClass: 'safe',
      verdictTitle: 'No Risks Detected',
      verdictSub: 'All clauses align perfectly with standard industry guidelines.',
      verdictSvgPath: `<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 11 11 13 15 9"/>`
    }
  }
  if (topLevel === 'critical') {
    return {
      verdictClass: 'critical',
      verdictTitle: 'Critical Assessment Required',
      verdictSub: `${riskCount} high-liability flag${riskCount > 1 ? 's' : ''} require structural negotiation before execution.`,
      verdictSvgPath: `<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>`
    }
  }
  if (topLevel === 'high') {
    return {
      verdictClass: 'high',
      verdictTitle: 'Notable Risk Identified',
      verdictSub: `${riskCount} high-risk element${riskCount > 1 ? 's' : ''} require explicit signoff or counsel review.`,
      verdictSvgPath: `<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>`
    }
  }
  if (topLevel === 'medium') {
    return {
      verdictClass: 'medium',
      verdictTitle: 'Moderate Warnings Present',
      verdictSub: `${riskCount} issue${riskCount > 1 ? 's' : ''} should be reviewed or amended with the counterparty.`,
      verdictSvgPath: `<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>`
    }
  }
  return {
    verdictClass: 'safe',
    verdictTitle: 'Compliant Layout',
    verdictSub: `${riskCount} minor audit trace${riskCount > 1 ? 's' : ''} recorded. Standard clean contract.`,
    verdictSvgPath: `<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>`
  }
}

// ── Risk card renderer ────────────────────────────────────────────────────────
function renderRiskCard(risk, riskIdx, clauses) {
  const level = risk.level ?? 'medium'
  const levelLabel = { critical: '🔴 Critical', high: '🟠 High', medium: '🟡 Medium', low: '🟢 Low' }[level] ?? level
  const matchedClause = (clauses ?? []).find(c => c.clauseId === risk.clauseId) ?? (clauses ?? []).find(c => c.sectionId === risk.sectionId)
  const rawClauseText = matchedClause?.rawText ?? ''

  const comparisonPanel = risk.precedent ? `
    <div class="clause-comparison">
      <div class="comparison-header">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/>
        </svg>
        Compare with Industry Standard
      </div>
      <div class="comparison-columns">
        ${rawClauseText ? `
          <div class="comparison-col col-yours">
            <div class="comparison-col-label">Your Clause</div>
            <div class="comparison-col-text">${escapeHtml(rawClauseText)}</div>
          </div>
        ` : `
          <div class="comparison-col col-yours" style="background:#f8fafc; border-right:1px solid #e5e7eb;">
            <div class="comparison-col-label" style="color:#64748b;">Your Clause</div>
            <div class="comparison-col-text" style="color:var(--ink-muted); font-style:italic;">[Clause text not found in index. You can still paste it in the Copilot box below to draft revisions.]</div>
          </div>
        `}
        <div class="comparison-col col-standard">
          <div class="comparison-col-label">Industry Standard</div>
          <div class="comparison-col-text">${escapeHtml(risk.precedent)}</div>
        </div>
      </div>
    </div>` : ''

  const chips = ['Make it mutual', 'Add a liability cap', 'Shorten notice period', 'Add termination for convenience', 'Remove exclusivity']
  const chipsHtml = chips.map(c =>
    `<button class="copilot-chip" onclick="setCopilotInstruction(${riskIdx}, '${c.replace(/'/g, "\\'")}')">${ c}</button>`
  ).join('')

  const copilotPanel = `
    <div class="copilot-panel" id="copilot-panel-${riskIdx}">
      <div class="copilot-panel-header">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
        </svg>
        AI Counter-Proposal Copilot
        <span class="copilot-badge">Powered by Gemma</span>
      </div>
      
      ${!rawClauseText ? `
        <div style="font-size:0.75rem; color:var(--ink-secondary); font-weight:600; margin-bottom:6px;">Paste the contract clause here to draft a counter-proposal using AI:</div>
        <textarea
          id="copilot-custom-clause-${riskIdx}"
          class="copilot-input"
          style="width:100%; height:70px; margin-bottom:10px; padding:8px 12px; border-radius:8px; border:1px solid #d1d5db; font-size:0.8rem; resize:vertical; display:block;"
          placeholder="Paste original contract clause text here..."
        ></textarea>
      ` : ''}

      <div class="copilot-chips">${chipsHtml}</div>
      <div class="copilot-input-row">
        <input
          type="text"
          id="copilot-input-${riskIdx}"
          class="copilot-input"
          placeholder="e.g. Limit liability to ₹50,000 and make it mutual…"
        />
        <button class="copilot-draft-btn" id="copilot-btn-${riskIdx}" onclick="draftCounterProposal(${riskIdx})">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
          Draft
        </button>
      </div>
      <div class="copilot-result" id="copilot-result-${riskIdx}" style="display:none">
        <div class="copilot-result-header">
          <span>Tracked-Change View</span>
          <div style="display:flex; gap:6px;">
            <button class="copilot-copy-btn" onclick="draftCounterProposal(${riskIdx})">&#x21BA; Regenerate</button>
            <button class="copilot-copy-btn" onclick="copyCopilotText(${riskIdx})">Copy Revised</button>
          </div>
        </div>
        <div class="copilot-diff" id="copilot-diff-${riskIdx}"></div>
        <div class="copilot-revised-raw" id="copilot-revised-${riskIdx}" style="display:none"></div>
      </div>
    </div>`

  return `
    <div class="risk-card level-${level}" data-risk-idx="${riskIdx}">
      <div class="risk-topline">
        <span class="badge ${level}">${levelLabel}</span>
        ${risk.clauseId ? `<span class="badge type">${formatType(risk.clauseId.split('-')[0])}</span>` : ''}
        <span class="risk-location">Section ${escapeHtml(risk.sectionId ?? '')} &middot; Page ${risk.pageNumber ?? '?'}</span>
      </div>
      <p class="risk-description">${escapeHtml(risk.description)}</p>
      
      <div class="risk-recommendation">
        <svg width="14" height="14" class="rec-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A5 5 0 0 0 8 8c0 1 .3 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/>
          <path d="M9 18h6"/>
          <path d="M10 22h4"/>
        </svg>
        <span class="rec-text"><strong>Recommendation:</strong> ${escapeHtml(risk.recommendation)}</span>
      </div>

      ${comparisonPanel}
      ${copilotPanel}
    </div>
  `
}

// ── Counter-Proposal Copilot Handlers ─────────────────────────────────────────
window.setCopilotInstruction = function(riskIdx, text) {
  const input = document.getElementById(`copilot-input-${riskIdx}`)
  if (input) { input.value = text; input.focus() }
}

window.draftCounterProposal = async function(riskIdx) {
  const report = window.__lastReport
  if (!report) return
  const risks = [...(report.risks ?? [])].sort((a, b) => riskRank[b.level] - riskRank[a.level])
  const risk = risks[riskIdx]
  if (!risk) return

  const matchedClause = (report.clauses ?? []).find(c => c.clauseId === risk.clauseId) ?? (report.clauses ?? []).find(c => c.sectionId === risk.sectionId)
  let clauseText = matchedClause?.rawText ?? ''
  if (!clauseText) {
    clauseText = document.getElementById(`copilot-custom-clause-${riskIdx}`)?.value ?? ''
  }
  const userInstructions = document.getElementById(`copilot-input-${riskIdx}`)?.value ?? ''

  const btn    = document.getElementById(`copilot-btn-${riskIdx}`)
  const result = document.getElementById(`copilot-result-${riskIdx}`)
  const diffEl = document.getElementById(`copilot-diff-${riskIdx}`)
  const rawEl  = document.getElementById(`copilot-revised-${riskIdx}`)

  if (!clauseText) { setStatus('Please paste the original clause text first to draft revisions.', true); return }
  if (btn) { btn.disabled = true; btn.textContent = 'Drafting…' }
  if (result) result.style.display = 'none'

  try {
    const res = await fetch('/api/refine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clauseText, riskDescription: risk.description, userInstructions }),
    })
    const data = await res.json()
    if (!res.ok || data.error) throw new Error(data.error || 'Drafting failed.')

    const revisedText = data.revisedText
    if (diffEl)  diffEl.innerHTML = computeWordDiff(clauseText, revisedText)
    if (rawEl)   rawEl.textContent = revisedText
    if (result) result.style.display = 'block'
    showToast('Counter-proposal ready — review below')
  } catch (err) {
    setStatus(err.message || 'Failed to generate counter-proposal.', true)
  } finally {
    if (btn) {
      btn.disabled = false
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Draft`
    }
  }
}

window.copyCopilotText = function(riskIdx) {
  const rawEl = document.getElementById(`copilot-revised-${riskIdx}`)
  if (!rawEl?.textContent) return
  navigator.clipboard.writeText(rawEl.textContent).then(() => {
    showToast('Revised clause copied to clipboard.')
  })
}

function generatePrintDocument(report) {
  if (!report) return '';
  const risks = [...(report.risks ?? [])].sort((a, b) => riskRank[b.level] - riskRank[a.level]);
  const riskScore = computeRiskScore(risks);
  const topLevel = risks[0]?.level ?? 'low';
  const { verdictTitle, verdictSub } = getVerdict(topLevel, risks.length);
  
  // Format Date
  const dateStr = formatDate(new Date(report.analysedAt || Date.now()).toISOString());

  // Risks list HTML
  const risksHtml = risks.map((risk, index) => {
    const lvlLabel = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' }[risk.level] ?? risk.level;
    const clauseType = risk.clauseId ? formatType(risk.clauseId.split('-')[0]) : '';
    const sectionStr = risk.sectionId ? `Section ${escapeHtml(risk.sectionId)}` : 'Section N/A';
    const pageStr = risk.pageNumber ? `Page ${risk.pageNumber}` : 'Page ?';

    const matchedClause = (report.clauses ?? []).find(c => c.clauseId === risk.clauseId) ?? (report.clauses ?? []).find(c => c.sectionId === risk.sectionId);
    const originalText = matchedClause?.rawText ?? '';

    return `
      <div class="risk-card ${risk.level}">
        <div class="risk-card-header">
          <span class="risk-loc">${escapeHtml(sectionStr)} &middot; ${pageStr} ${clauseType ? `&middot; <strong>${clauseType}</strong>` : ''}</span>
          <span class="risk-level-badge ${risk.level}">${lvlLabel}</span>
        </div>
        <div class="risk-card-body">
          <div class="risk-desc">${escapeHtml(risk.description)}</div>
          
          <div class="risk-meta-box risk-recommendation">
            <div class="box-title rec">Recommendation</div>
            <div>${escapeHtml(risk.recommendation)}</div>
          </div>
          
          ${originalText ? `
            <div class="risk-meta-box original-clause">
              <div class="box-title" style="color:#475569">Your Contract Clause</div>
              <div style="font-family:monospace; font-size:11px; white-space:pre-wrap; margin-top:5px; background:rgba(0,0,0,0.02); padding:8px; border-radius:4px; border:1px solid #e2e8f0;">${escapeHtml(originalText)}</div>
            </div>
          ` : ''}

          ${risk.precedent ? `
            <div class="risk-meta-box risk-precedent">
              <div class="box-title prec">Industry Standard Precedent Benchmark</div>
              <div>"${escapeHtml(risk.precedent)}"</div>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');

  // Action plan list HTML
  const actionPlanHtml = risks.map((r, i) => {
    const lvlLabel = { critical: '🔴 Critical', high: '🟠 High', medium: '🟡 Medium', low: '🟢 Low' }[r.level] ?? r.level;
    return `
      <div class="action-plan-item">
        <div class="action-number">${i + 1}</div>
        <div class="action-content">
          <div class="action-item-title">[${lvlLabel}] Section §${escapeHtml(r.sectionId ?? '')} (Page ${r.pageNumber ?? '?'})</div>
          <div class="action-item-desc">${escapeHtml(r.recommendation)}</div>
        </div>
      </div>
    `;
  }).join('');

  // Clauses list HTML
  const clausesHtml = (report.clauses ?? []).map(clause => {
    const sectionStr = clause.sectionId ? `Section ${escapeHtml(clause.sectionId)}` : 'Section N/A';
    const pageStr = clause.pageNumber ? `Page ${clause.pageNumber}` : 'Page ?';
    return `
      <div class="clause-card">
        <div class="clause-header">
          <span class="clause-type-badge">${formatType(clause.type ?? 'other')}</span>
          <span>${escapeHtml(sectionStr)} &middot; ${pageStr}</span>
        </div>
        <div class="clause-summary">${escapeHtml(clause.summary)}</div>
        ${clause.rawText ? `<div class="clause-text">${escapeHtml(clause.rawText)}</div>` : ''}
      </div>
    `;
  }).join('');

  const disclaimerText = report.disclaimer || 'This report is AI-generated for analytical purposes and does not constitute formal legal advice. Verify all actions with qualified legal counsel.';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>eContract AI Risk Audit Report — ${escapeHtml(window.__lastReportFilename || 'Contract')}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
    body {
      font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
      color: #0f172a;
      background: #ffffff;
      margin: 0;
      padding: 40px;
      line-height: 1.6;
      font-size: 14px;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .header {
      border-bottom: 2px solid #4f46e5;
      padding-bottom: 20px;
      margin-bottom: 30px;
    }
    .header-title-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .brand {
      font-size: 24px;
      font-weight: 800;
      color: #4f46e5;
      letter-spacing: -0.02em;
    }
    .report-badge {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      background: #f5f3ff;
      color: #7c3aed;
      padding: 6px 12px;
      border-radius: 20px;
      letter-spacing: 0.05em;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 15px;
      margin-top: 20px;
      background: #f8fafc;
      padding: 12px 18px;
      border-radius: 8px;
      border: 1px solid #e2e8f0;
    }
    .meta-item {
      font-size: 12px;
    }
    .meta-label {
      color: #94a3b8;
      font-weight: 600;
      text-transform: uppercase;
      font-size: 10px;
      letter-spacing: 0.03em;
    }
    .meta-val {
      font-weight: 700;
      color: #334155;
      word-break: break-all;
    }
    .section-title {
      font-size: 18px;
      font-weight: 700;
      color: #1e293b;
      margin-top: 40px;
      margin-bottom: 15px;
      border-left: 4px solid #4f46e5;
      padding-left: 10px;
      page-break-after: avoid;
    }
    .summary-box {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 20px;
      font-size: 14px;
      color: #334155;
      white-space: pre-wrap;
    }
    .verdict-banner {
      display: flex;
      align-items: center;
      gap: 20px;
      margin: 25px 0;
      padding: 20px;
      background: linear-gradient(135deg, #f5f3ff 0%, #ede9fe 100%);
      border: 1px solid #c084fc;
      border-radius: 12px;
      page-break-inside: avoid;
    }
    .score-circle {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      width: 70px;
      height: 70px;
      border-radius: 50%;
      background: #ffffff;
      border: 4px solid #7c3aed;
      color: #7c3aed;
      font-weight: 800;
      font-size: 22px;
      box-shadow: 0 4px 10px rgba(124, 58, 237, 0.1);
      flex-shrink: 0;
    }
    .score-circle-label {
      font-size: 8px;
      text-transform: uppercase;
      color: #94a3b8;
      font-weight: 700;
      margin-top: -2px;
    }
    .verdict-info {
      flex: 1;
    }
    .verdict-headline {
      font-size: 16px;
      font-weight: 800;
      color: #581c87;
      margin-bottom: 4px;
    }
    .verdict-description {
      font-size: 13px;
      color: #6b21a8;
    }
    .action-plan-list {
      margin: 0;
      padding: 0;
      list-style-type: none;
    }
    .action-plan-item {
      display: flex;
      gap: 15px;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 14px 18px;
      margin-bottom: 12px;
      page-break-inside: avoid;
    }
    .action-number {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      border-radius: 50%;
      background: #4f46e5;
      color: #ffffff;
      font-weight: 700;
      font-size: 12px;
      flex-shrink: 0;
    }
    .action-content {
      flex: 1;
    }
    .action-item-title {
      font-weight: 700;
      color: #1e293b;
      font-size: 13px;
      margin-bottom: 2px;
    }
    .action-item-desc {
      color: #475569;
      font-size: 13px;
    }
    .risk-card {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      margin-bottom: 20px;
      overflow: hidden;
      page-break-inside: avoid;
    }
    .risk-card.critical { border-left: 6px solid #ef4444; }
    .risk-card.high     { border-left: 6px solid #f97316; }
    .risk-card.medium   { border-left: 6px solid #f59e0b; }
    .risk-card.low      { border-left: 6px solid #10b981; }
    
    .risk-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 20px;
      background: #f8fafc;
      border-bottom: 1px solid #e2e8f0;
    }
    .risk-loc {
      font-size: 12px;
      font-weight: 700;
      color: #475569;
    }
    .risk-level-badge {
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      padding: 3px 10px;
      border-radius: 20px;
      letter-spacing: 0.05em;
    }
    .risk-level-badge.critical { background: #fee2e2; color: #b91c1c; }
    .risk-level-badge.high     { background: #ffedd5; color: #c2410c; }
    .risk-level-badge.medium   { background: #fef3c7; color: #b45309; }
    .risk-level-badge.low      { background: #dcfce7; color: #15803d; }
    
    .risk-card-body {
      padding: 20px;
    }
    .risk-desc {
      font-size: 14px;
      color: #1e293b;
      margin-bottom: 15px;
      font-weight: 500;
    }
    .risk-meta-box {
      margin-top: 12px;
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 13px;
    }
    .risk-recommendation {
      background: #f0fdf4;
      border: 1px solid #bbf7d0;
      color: #166534;
    }
    .risk-precedent {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      color: #475569;
      font-style: italic;
      margin-top: 10px;
    }
    .box-title {
      font-weight: 700;
      text-transform: uppercase;
      font-size: 10px;
      letter-spacing: 0.05em;
      margin-bottom: 4px;
    }
    .box-title.rec { color: #15803d; }
    .box-title.prec { color: #64748b; }
    
    .clause-card {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 15px;
      margin-bottom: 15px;
      page-break-inside: avoid;
    }
    .clause-header {
      display: flex;
      justify-content: space-between;
      margin-bottom: 10px;
      font-size: 12px;
      font-weight: 700;
      color: #64748b;
    }
    .clause-type-badge {
      background: #f1f5f9;
      color: #475569;
      padding: 2px 8px;
      border-radius: 4px;
      text-transform: capitalize;
    }
    .clause-summary {
      font-weight: 500;
      color: #1e293b;
      margin-bottom: 10px;
    }
    .clause-text {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      padding: 10px 14px;
      border-radius: 6px;
      font-size: 12px;
      color: #475569;
      white-space: pre-wrap;
      font-family: monospace;
    }
    .footer {
      margin-top: 60px;
      border-top: 1px solid #e2e8f0;
      padding-top: 20px;
      font-size: 11px;
      color: #94a3b8;
      text-align: center;
      page-break-inside: avoid;
    }
    
    @media print {
      body {
        padding: 20px;
      }
      .page-break {
        page-break-before: always;
      }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-title-row">
      <div class="brand">eContract AI</div>
      <div class="report-badge">Risk Audit Report</div>
    </div>
    
    <div class="meta-grid">
      <div class="meta-item">
        <div class="meta-label">Contract Document</div>
        <div class="meta-val">${escapeHtml(window.__lastReportFilename || 'Contract Document')}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Analysis Date</div>
        <div class="meta-val">${dateStr}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Total Clauses</div>
        <div class="meta-val">${report.clauses?.length ?? 0} indexed</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Risk Flags</div>
        <div class="meta-val">${risks.length} issues</div>
      </div>
    </div>
  </div>

  <div class="verdict-banner">
    <div class="score-circle">
      <span>${riskScore}</span>
      <span class="score-circle-label">Risk</span>
    </div>
    <div class="verdict-info">
      <div class="verdict-headline">${escapeHtml(verdictTitle)}</div>
      <div class="verdict-description">${escapeHtml(verdictSub)}</div>
    </div>
  </div>

  <div class="section-title">Executive Summary</div>
  <div class="summary-box">${formatSummary(report.summary)}</div>

  ${risks.length ? `
    <div class="section-title">Negotiation Action Plan</div>
    <div class="action-plan-list">
      ${actionPlanHtml}
    </div>
    
    <div class="page-break"></div>
    
    <div class="section-title">Detailed Risk Liability Flags</div>
    <div class="risks-list">
      ${risksHtml}
    </div>
  ` : ''}

  ${(report.clauses ?? []).length ? `
    <div class="page-break"></div>
    <div class="section-title">Clause-by-Clause Index</div>
    <div class="clauses-list">
      ${clausesHtml}
    </div>
  ` : ''}

  <div class="footer">
    ${escapeHtml(disclaimerText)}
    <br><br>
    Generated by eContract AI. Confidential legal audit document.
  </div>

  <script>
    window.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => {
        window.print();
      }, 600);
    });
  </script>
</body>
</html>
  `;
}

window.printReport = function() {
  const r = window.__lastReport;
  if (!r) return;
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('Popup blocker active. Please allow popups for eContract AI to generate the print report.');
    return;
  }
  const html = generatePrintDocument(r);
  printWindow.document.write(html);
  printWindow.document.close();
}

// ── Clause groups accordions ───────────────────────────────────────────────────

function renderClauseGroups(clauses, risks) {
  if (!clauses.length) return '<p style="color:var(--ink-muted);font-size:0.9rem">No agreement clauses extracted.</p>'

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
    const iconSvg = getClauseIconSvg(type)
    const isOpen = hasFlagged // Auto-open if risk items are flagged in group

    return `
      <div class="clause-group ${isOpen ? 'open' : ''}">
        <div class="clause-group-header" role="button" aria-expanded="${isOpen}">
          ${iconSvg}
          <span class="clause-group-title">${label} ${hasFlagged ? '<span style="color:var(--orange)">⚠️</span>' : ''}</span>
          <span class="clause-group-count">${items.length} clause${items.length !== 1 ? 's' : ''}</span>
          <span class="clause-group-arrow">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
          </span>
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
        ${isFlagged ? '<span class="badge critical" style="font-size:0.6rem;padding:2px 7px">⚠️ Flagged</span>' : ''}
        <span class="clause-section">Section ${escapeHtml(clause.sectionId ?? '')} · Page ${clause.pageNumber ?? '?'}</span>
      </div>
      <p class="clause-summary">${escapeHtml(clause.summary)}</p>
      ${clause.rawText ? `
        <button class="clause-toggle">
          Show original text 
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div class="clause-raw">${escapeHtml(clause.rawText)}</div>
      ` : ''}
    </div>
  `
}

function getClauseIconSvg(type) {
  const svgMap = {
    confidentiality: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
    termination:     `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    liability:       `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
    indemnification: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
    payment:         `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`,
    ip:              `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A5 5 0 0 0 8 8c0 1 .3 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>`,
    governing_law:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10v6M2 10v6M4 10h16M12 4v16M9 20h6"/></svg>`,
    other:           `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`
  }
  return svgMap[type] || svgMap.other
}

// ── Sidebar stats rendering ────────────────────────────────────────────────────
function renderSideStats(report, riskScore) {
  sideStats.removeAttribute('hidden')
  const criticalCount = (report.risks ?? []).filter(r => r.level === 'critical').length
  const highCount = (report.risks ?? []).filter(r => r.level === 'high').length

  sideStats.innerHTML = [
    { label: 'Risk Score', value: `${riskScore}/100` },
    { label: 'Total Pages', value: report.pages ?? '—' },
    { label: 'Clauses Indexed', value: report.clauses?.length ?? 0 },
    { label: 'Total Flags', value: report.risks?.length ?? 0 },
    criticalCount ? { label: '🔴 Critical', value: criticalCount } : null,
    highCount     ? { label: '🟠 High',     value: highCount }     : null,
    report._meta?.durationMs ? { label: 'Processing time', value: formatDuration(report._meta.durationMs) } : null,
  ]
  .filter(Boolean)
  .map(s => `
    <div class="stat-box">
      <div class="stat-label">${s.label}</div>
      <div class="stat-value">${s.value}</div>
    </div>
  `).join('')
}

// ── Error state rendering ──────────────────────────────────────────────────────
function renderError(message) {
  results.innerHTML = `
    <div class="error-card">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <div class="error-card-title">Analysis Aborted</div>
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
    showToast('Summary outline copied to clipboard.')
  })
}

window.copyMarkdownReport = function () {
  const r = window.__lastReport
  if (!r) return
  const risks = [...(r.risks ?? [])].sort((a, b) => riskRank[b.level] - riskRank[a.level])
  const lines = [
    `# Contract Risk Assessment Audit`,
    ``,
    `**Analyzed:** ${new Date(r.analysedAt).toLocaleString()}  `,
    `**Pages:** ${r.pages}  |  **Clauses:** ${r.clauses?.length}  |  **Risk Flags:** ${risks.length}`,
    ``,
    `## Executive Summary`,
    r.summary,
    ``,
    `## Risk Flags List`,
    ...risks.map(risk => [
      `### [${risk.level.toUpperCase()}] Section ${risk.sectionId} (Page ${risk.pageNumber})`,
      risk.description,
      ``,
      `**Recommendation:** ${risk.recommendation}`,
      risk.precedent ? `\n> Benchmark Precedent: "${risk.precedent}"` : '',
    ].join('\n')),
    ``,
    `---`,
    `*${r.disclaimer}*`,
  ]
  navigator.clipboard.writeText(lines.join('\n')).then(() => {
    showToast('Markdown report copied to clipboard.')
  })
}

// ── History (client-side IndexedDB) ───────────────────────────────────────────
async function loadHistory() {
  try {
    const entries = await HistoryDB.list()
    if (!entries.length) {
      historyList.innerHTML = `
        <div style="padding:40px;text-align:center;background:var(--surface-card);border:1px solid var(--border-strong);border-radius:var(--radius)">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--ink-muted);opacity:0.6;margin-bottom:12px">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          <p style="color:var(--ink-secondary);font-size:0.95rem;font-weight:700">No Audits Documented Yet</p>
          <p style="color:var(--ink-muted);font-size:0.82rem;margin-top:6px;max-width:320px;margin-inline:auto">All historical audits are stored securely and privately strictly on your local browser sandboxed database.</p>
        </div>
      `
      return
    }
    historyList.innerHTML = entries.slice(0, 50).map(entry => {
      const levelColors = { critical:'var(--red)', high:'var(--orange)', medium:'var(--yellow)', low:'var(--green)', none:'var(--ink-muted)' }
      const levelColor  = levelColors[entry.topLevel] ?? 'var(--ink-muted)'
      
      return `
        <div class="history-card">
          <div style="display:flex;align-items:center;gap:14px;min-width:0">
            <div style="display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:8px;background:rgba(15,23,42,0.01);border:1px solid var(--border-strong);color:var(--primary);flex-shrink:0">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            </div>
            <div style="min-width:0">
              <div class="history-card-name" title="${escapeHtml(entry.filename)}">${escapeHtml(entry.filename)}</div>
              <div class="history-card-meta">
                ${formatDate(new Date(entry.savedAt).toISOString())}
                · ${entry.pages ?? '?'} page${entry.pages !== 1 ? 's' : ''}
                · <span style="color:${levelColor};font-weight:700">${entry.riskCount} liability flag${entry.riskCount !== 1 ? 's' : ''}</span>
              </div>
            </div>
          </div>
          <div class="history-card-actions">
            <button class="btn btn-primary" onclick="viewLocalReport(${entry.id})">Open Audit</button>
            <button class="btn" onclick="downloadLocalReport(${entry.id})" title="Download raw JSON report">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </button>
            <button class="btn" style="color:var(--red);border-color:rgba(239,68,68,0.15);background:rgba(239,68,68,0.02)" onclick="deleteLocalReport(${entry.id})" title="Delete report history">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
            </button>
          </div>
        </div>
      `
    }).join('')
  } catch (err) {
    historyList.innerHTML = '<div class="history-loading-msg">Could not recover session database catalog entries.</div>'
  }
}

window.viewLocalReport = async function (id) {
  switchView('analyze')
  try {
    const entries = await HistoryDB.list()
    const entry = entries.find(e => e.id === id)
    if (!entry?.report) { setStatus('Session data entry reference was not found in browser storage.', true); return }
    window.__lastReportFilename = entry.filename
    renderReport(entry.report)
    setStatus('Viewing saved audit layout from local history.')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  } catch {
    setStatus('Failed to load local document report.', true)
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
  if (!confirm('Remove this assessment report permanently from your local history index?')) return
  try {
    await HistoryDB.remove(id)
    loadHistory()
  } catch {}
}

window.showToast = function(message, type = 'success') {
  const container = document.getElementById('toast-container') || (() => {
    const c = document.createElement('div')
    c.id = 'toast-container'
    c.style.cssText = 'position:fixed; bottom:24px; right:24px; z-index:9999; display:flex; flex-direction:column; gap:10px; pointer-events:none;'
    document.body.appendChild(c)
    return c
  })()

  const toast = document.createElement('div')
  toast.className = `toast toast-${type}`
  toast.innerHTML = `
    <span class="toast-icon">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </span>
    <span class="toast-message">${escapeHtml(message)}</span>
  `
  container.appendChild(toast)

  setTimeout(() => {
    toast.style.animation = 'toastOut 0.25s cubic-bezier(0.36, 0.07, 0.19, 0.97) forwards'
    toast.addEventListener('animationend', () => {
      toast.remove()
    })
  }, 2500)
}

// ── Progress helpers ───────────────────────────────────────────────────────────
function showProgress(progress, step, message) {
  progressCtr.classList.add('active')
  progressFill.style.width = `${progress}%`
  progressStep.textContent = formatStepName(step)
  progressPct.textContent = `${progress}%`
  if (message) { statusText.textContent = message; statusText.classList.remove('error') }
}

// Ensure the page boots to the landing view
window.addEventListener('DOMContentLoaded', () => {
  switchView('landing')
})

function hideProgress() {
  progressCtr.classList.remove('active')
  progressFill.style.width = '0%'
}

// Dynamic window scope declaration so that inline templates can invoke it
window.downloadReportJSON = downloadReportJSON
window.copyReportSummary = copyReportSummary
window.copyMarkdownReport = copyMarkdownReport

function showQueueInfo(msg) { queueInfo.textContent = msg; queueInfo.classList.add('visible') }
function hideQueueInfo()    { queueInfo.classList.remove('visible') }

function formatStepName(step) {
  return { queued:'In Queue', ocr:'OCR Extraction', embedding:'Embedding Index', analysis:'AI Assessment', verifying:'Validation filters', completed:'Done', failed:'Failed' }[step] ?? step
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
  return payload?.error ?? 'The analysis request was aborted by the network.'
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

/* ──────────────────────────────────────────────────────────────────────────
   HERO CONTRACT SCAN ANIMATION ORCHESTRATOR
   Drives: scanner highlighting, chip pop-ins, score ring, counters, pills
   Loops every ~11 seconds.
   ────────────────────────────────────────────────────────────────────────── */
;(function initHeroScanAnimation() {
  // Config
  const SCAN_DURATION  = 3200  // ms — matches CSS @keyframes scannerSweep
  const SCAN_DELAY     = 500   // initial delay before first scan
  const LOOP_PAUSE     = 2500  // ms pause after full animation before reset
  const TARGET_RISK    = 74
  const TARGET_CLAUSES = 18
  const TARGET_FLAGS   = 5

  const riskPills = [
    { label: '● Critical ×2', cls: 'risk-pill-critical', delay: 200 },
    { label: '● High ×2',     cls: 'risk-pill-high',     delay: 500 },
    { label: '● Medium ×1',   cls: 'risk-pill-medium',   delay: 800 },
  ]

  // Clause sections: each entry maps to a doc-section index and scan % range
  // The scanner sweeps 0→100% of doc-body height. These %s trigger highlights.
  const clauseTriggers = [
    // { sectionIndex, riskClass (null = safe), chipId, notifEl, scanPercent }
    { sectionIdx: 1, riskClass: 'risk-highlighted-medium',   chipId: 'chip1', scanPct: 0.35 },
    { sectionIdx: 2, riskClass: 'risk-highlighted-critical', chipId: 'chip2', scanPct: 0.58 },
    { sectionIdx: 3, riskClass: 'risk-highlighted-high',     chipId: 'chip3', scanPct: 0.79 },
  ]

  // Timeout registry to prevent overlapping animation cycles
  let activeTimeouts = []

  function scheduleTimeout(fn, delay) {
    const handle = setTimeout(fn, delay)
    activeTimeouts.push(handle)
    return handle
  }

  function clearAllTimeouts() {
    activeTimeouts.forEach(clearTimeout)
    activeTimeouts = []
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  function qs(id)  { return document.getElementById(id) }
  function qsa(sel){ return document.querySelectorAll(sel) }

  function lerp(from, to, t) { return Math.round(from + (to - from) * t) }

  // Animate a numeric counter element from 0 → target over `duration` ms
  function animCount(el, target, duration) {
    if (!el) return
    const start = performance.now()
    function step(now) {
      const t = Math.min((now - start) / duration, 1)
      el.textContent = lerp(0, target, t)
      if (t < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  // Animate SVG ring from offset 157 → (157 - 157*fraction)
  function animRing(ringEl, valEl, targetScore, duration) {
    if (!ringEl || !valEl) return
    const circumference = 157
    const targetOffset  = circumference - (circumference * targetScore / 100)
    const startTime     = performance.now()

    // Colour thresholds
    const colour = targetScore >= 70 ? '#EF4444'
                 : targetScore >= 40 ? '#F97316'
                 : '#10B981'
    ringEl.style.stroke = colour
    valEl.style.color   = colour

    function step(now) {
      const t = Math.min((now - startTime) / duration, 1)
      const eased = 1 - Math.pow(1 - t, 3)  // ease-out-cubic
      ringEl.setAttribute('stroke-dashoffset', circumference - (circumference - targetOffset) * eased)
      valEl.textContent = lerp(0, targetScore, eased)
      if (t < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  // Highlight all lines in a section index
  function highlightSection(sectionIdx, riskClass) {
    const sections = qsa('.doc-section')
    if (!sections[sectionIdx]) return
    const lines = sections[sectionIdx].querySelectorAll('.doc-line')
    lines.forEach((ln, i) => {
      scheduleTimeout(() => {
        if (ln.dataset.risk) {
          ln.classList.add(riskClass)
        } else {
          ln.classList.add('highlighted')
        }
      }, i * 60)
    })
  }

  // ── Reset everything ─────────────────────────────────────────────────────
  function resetAll() {
    clearAllTimeouts()
    // Reset lines
    qsa('.doc-line').forEach(ln => {
      ln.className = ln.className
        .replace(/\s*(highlighted|risk-highlighted-\w+)/g, '')
    })
    // Reset chips
    qsa('.clause-chip').forEach(c => c.classList.remove('visible'))
    // Reset ring
    const ring = qs('riskRingFill')
    const val  = qs('riskRingVal')
    if (ring) ring.setAttribute('stroke-dashoffset', '157')
    if (val)  val.textContent = '0'
    // Reset counts
    const cc = qs('clauseCount')
    const fc = qs('flagCount')
    if (cc) cc.textContent = '0'
    if (fc) fc.textContent = '0'
    // Reset pills
    const pillRow = qs('riskPillRow')
    if (pillRow) pillRow.innerHTML = ''
  }

  // ── Run one full animation cycle ─────────────────────────────────────────
  function runCycle() {
    resetAll()

    // 1. Scan starts — the CSS animation handles the beam movement.
    //    We schedule highlights based on the scanner's progress (% of SCAN_DURATION).

    clauseTriggers.forEach(({ sectionIdx, riskClass, chipId, scanPct }) => {
      const triggerAt = SCAN_DELAY + SCAN_DURATION * scanPct
      scheduleTimeout(() => {
        highlightSection(sectionIdx, riskClass)
        const chip = qs(chipId)
        if (chip) chip.classList.add('visible')
      }, triggerAt)
    })

    // 2. After scan completes: animate score ring + counters
    const postScan = SCAN_DELAY + SCAN_DURATION + 300
    scheduleTimeout(() => {
      animRing(qs('riskRingFill'), qs('riskRingVal'), TARGET_RISK, 1400)
      animCount(qs('clauseCount'), TARGET_CLAUSES, 1200)
      animCount(qs('flagCount'),   TARGET_FLAGS,   1000)
    }, postScan)

    // 3. Risk pills appear staggered after ring
    riskPills.forEach(({ label, cls, delay }) => {
      scheduleTimeout(() => {
        const pillRow = qs('riskPillRow')
        if (!pillRow) return
        const pill = document.createElement('span')
        pill.className = `risk-pill ${cls}`
        pill.textContent = label
        pillRow.appendChild(pill)
        requestAnimationFrame(() => requestAnimationFrame(() => pill.classList.add('visible')))
      }, postScan + 800 + delay)
    })

    // 4. Schedule next loop
    const cycleLength = postScan + 2000 + LOOP_PAUSE
    scheduleTimeout(runCycle, cycleLength)
  }

  // ── Boot when landing view is visible ────────────────────────────────────
  // Start immediately if landing view is shown, else wait for switchView
  function bootIfLanding() {
    const landing = document.getElementById('view-landing')
    if (landing && !landing.classList.contains('hidden')) {
      runCycle()
    }
  }

  // Hook into the existing switchView function
  const _origSwitchView = window.switchView
  window.switchView = function(view, evt) {
    if (typeof _origSwitchView === 'function') _origSwitchView(view, evt)
    if (view === 'landing') {
      // Short delay so the view is visible before animation kicks off
      clearAllTimeouts()
      scheduleTimeout(runCycle, 400)
    }
  }

  // Kick off on DOMContentLoaded or immediately if already loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(bootIfLanding, 600))
  } else {
    setTimeout(bootIfLanding, 600)
  }
})()


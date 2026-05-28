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
      renderReport(payload)
      setStatus('⚡ Analysis fetched instantly from local cache.')
      hideProgress()
      setLoading(false)
      // Also save to local history on cache hit (different filename, same data)
      const fname = fileInput.files?.[0]?.name ?? 'contract.pdf'
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
        ? risks.map(renderRiskCard).join('')
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

// ── Risk card renderer ──────────────────────────────────────────────────────────
function renderRiskCard(risk) {
  const level = risk.level ?? 'medium'
  const levelLabel = { critical: '🔴 Critical', high: '🟠 High', medium: '🟡 Medium', low: '🟢 Low' }[level] ?? level

  return `
    <div class="risk-card level-${level}">
      <div class="risk-topline">
        <span class="badge ${level}">${levelLabel}</span>
        ${risk.clauseId ? `<span class="badge type">${formatType(risk.clauseId.split('-')[0])}</span>` : ''}
        <span class="risk-location">Section ${escapeHtml(risk.sectionId ?? '')} · Page ${risk.pageNumber ?? '?'}</span>
      </div>
      <p class="risk-description">${escapeHtml(risk.description)}</p>
      
      <!-- Recommendation -->
      <div class="risk-recommendation">
        <svg width="14" height="14" class="rec-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A5 5 0 0 0 8 8c0 1 .3 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/>
          <path d="M9 18h6"/>
          <path d="M10 22h4"/>
        </svg>
        <span class="rec-text"><strong>Recommendation:</strong> ${escapeHtml(risk.recommendation)}</span>
      </div>
      
      <!-- Standard Precedent -->
      ${risk.precedent ? `
        <div class="precedent-box">
          <div class="precedent-label">
            <svg width="12" height="12" class="precedent-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v1"/>
              <path d="M18 8h4a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-4"/>
              <circle cx="6" cy="12" r="2"/>
              <circle cx="14" cy="12" r="2"/>
            </svg>
            Precedent Benchmark Language
          </div>
          "${escapeHtml(risk.precedent)}"
        </div>
      ` : ''}
    </div>
  `
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
    setStatus('Summary outline copied to clipboard.')
    setTimeout(() => setStatus(''), 2000)
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
    setStatus('Markdown format report copied to clipboard.')
    setTimeout(() => setStatus(''), 2500)
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


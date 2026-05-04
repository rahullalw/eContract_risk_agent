const form = document.querySelector('#analyze-form')
const fileInput = document.querySelector('#contract-file')
const fileLabel = document.querySelector('#file-label')
const statusText = document.querySelector('#status')
const results = document.querySelector('#results')
const dropzone = document.querySelector('#dropzone')
const submitButton = form.querySelector('button')

const riskRank = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  fileLabel.textContent = file ? `${file.name} - ${formatBytes(file.size)}` : 'or drop it here, up to 20 MB'
})

for (const eventName of ['dragenter', 'dragover']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault()
    dropzone.classList.add('is-over')
  })
}

for (const eventName of ['dragleave', 'drop']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault()
    dropzone.classList.remove('is-over')
  })
}

dropzone.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files?.[0]
  if (!file) return

  const transfer = new DataTransfer()
  transfer.items.add(file)
  fileInput.files = transfer.files
  fileInput.dispatchEvent(new Event('change'))
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()

  const file = fileInput.files?.[0]
  if (!file) {
    setStatus('Choose a PDF first.', true)
    return
  }

  if (file.type !== 'application/pdf') {
    setStatus('Only PDF files are supported.', true)
    return
  }

  const body = new FormData()
  body.append('contract', file)

  setLoading(true)
  setStatus('Analyzing contract. This can take a moment.')

  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      body,
    })
    const payload = await response.json()

    if (!response.ok) {
      throw new Error(buildErrorMessage(payload))
    }

    renderReport(payload)
    setStatus(`Report ready in ${formatDuration(payload._meta?.durationMs)}.`)
  } catch (error) {
    renderError(error.message)
    setStatus(error.message, true)
  } finally {
    setLoading(false)
  }
})

function renderReport(report) {
  const sortedRisks = [...report.risks].sort((a, b) => riskRank[b.level] - riskRank[a.level])
  const highestRisk = sortedRisks[0]?.level ?? 'low'

  results.innerHTML = `
    <div class="report-header">
      <div>
        <h2>Risk report</h2>
        <p class="summary">${escapeHtml(report.summary)}</p>
      </div>
      <span class="pill ${highestRisk}">${highestRisk}</span>
    </div>

    <div class="score-row">
      ${renderMetric('Pages', report.pages)}
      ${renderMetric('Risks', report.risks.length)}
      ${renderMetric('OCR', `${Math.round(report.ocrConfidence * 100)}%`)}
    </div>

    <h3 class="section-title">Risk flags</h3>
    <div class="risk-list">
      ${sortedRisks.length ? sortedRisks.map(renderRisk).join('') : '<p class="summary">No risk flags returned.</p>'}
    </div>

    <h3 class="section-title">Clauses found</h3>
    <div class="clause-list">
      ${report.clauses.length ? report.clauses.map(renderClause).join('') : '<p class="summary">No clauses returned.</p>'}
    </div>
  `
}

function renderMetric(label, value) {
  return `
    <div class="metric">
      <p class="metric-label">${label}</p>
      <p class="metric-value">${value}</p>
    </div>
  `
}

function renderRisk(risk) {
  return `
    <article class="risk-item">
      <div class="risk-topline">
        <span class="pill ${risk.level}">${risk.level}</span>
        <span class="meta">${escapeHtml(risk.sectionId)} - page ${risk.pageNumber}</span>
      </div>
      <p>${escapeHtml(risk.description)}</p>
      <p class="recommendation"><strong>Recommendation:</strong> ${escapeHtml(risk.recommendation)}</p>
    </article>
  `
}

function renderClause(clause) {
  return `
    <article class="clause-item">
      <div class="clause-topline">
        <strong>${formatType(clause.type)}</strong>
        <span class="meta">${escapeHtml(clause.sectionId)} - page ${clause.pageNumber}</span>
      </div>
      <p>${escapeHtml(clause.summary)}</p>
    </article>
  `
}

function renderError(message) {
  results.innerHTML = `
    <div class="empty-state">
      <p class="empty-title error">Analysis failed</p>
      <p class="empty-copy">${escapeHtml(message)}</p>
    </div>
  `
}

function setLoading(isLoading) {
  submitButton.disabled = isLoading
  submitButton.querySelector('span').textContent = isLoading ? 'Analyzing...' : 'Analyze contract'
}

function setStatus(message, isError = false) {
  statusText.textContent = message
  statusText.classList.toggle('error', isError)
}

function buildErrorMessage(payload) {
  if (payload?.details?.length) return payload.details.join(' ')
  if (payload?.issues?.length) return payload.issues.join(' ')
  return payload?.error ?? 'The analysis request failed.'
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return 'a few moments'
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

function formatType(value) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

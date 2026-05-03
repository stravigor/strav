import type { Router, Context, Middleware, Next } from '@strav/http'
import { rateLimit } from '@strav/http'
import { Emitter } from '@strav/kernel'
import { dashboardAuth } from './middleware.ts'
import DevtoolsManager from '../devtools_manager.ts'
import type { EntryType, AggregateFunction } from '../types.ts'
import { PERIODS } from '../storage/aggregate_store.ts'

/**
 * Audit-friendly access event for every devtools API call. Apps can wire
 * this through `@strav/audit` to track who hit the inspector.
 *
 * @example
 * Emitter.on('devtools:access', e => {
 *   audit.by(e.actor ?? { type: 'system', id: 'unknown' })
 *     .on('devtools', e.path)
 *     .action('viewed')
 *     .meta({ method: e.method, ip: e.ip })
 *     .log()
 * })
 */
function emitAccessMiddleware(): Middleware {
  return async (ctx: Context, next: Next) => {
    if (Emitter.listenerCount('devtools:access') > 0) {
      const user = ctx.get<{ id?: unknown; auditActorType?: () => string } | undefined>('user')
      const actor = user?.id !== undefined ? user : null
      void Emitter.emit('devtools:access', {
        method: ctx.method,
        path: ctx.path,
        ip: ctx.header('x-forwarded-for') ?? ctx.header('x-real-ip') ?? null,
        actor,
      }).catch(() => {})
    }
    return next()
  }
}

/**
 * Register the devtools dashboard routes on a router.
 *
 * Uses route aliases from the devtools configuration for named routes.
 *
 * @example
 * import { registerDashboard } from '@strav/devtools/dashboard/routes'
 * registerDashboard(router)
 *
 * // With custom auth guard
 * registerDashboard(router, (ctx) => ctx.get('user')?.isAdmin)
 *
 * // After registration, use named routes:
 * const dashboardUrl = routeUrl('devtools.dashboard.home')
 * const apiResponse = await route('devtools.api.entries', { params: { limit: 50 } })
 */
export function registerDashboard(
  router: Router,
  guard?: (ctx: Context) => boolean | Promise<boolean>
): void {
  const config = DevtoolsManager.config
  const dashboardAlias = config.routes.aliases.dashboard
  const apiAlias = config.routes.aliases.api
  const subdomain = config.routes.subdomain

  router.group({ prefix: '/_devtools', middleware: [dashboardAuth(guard)], subdomain }, r => {
    // ---- Dashboard routes ----
    r.group({}, dashboardRoutes).as(dashboardAlias)

    // ---- API routes ----
    // Rate-limit + access-event emit on top of the dashboard guard.
    // The rate limit defends against log-mining via repeated /entries
    // hits; the event emit lets apps wire `@strav/audit`.
    r.group(
      {
        prefix: '/api',
        middleware: [
          rateLimit({ max: 120, window: 60_000 }),
          emitAccessMiddleware(),
        ],
      },
      apiRoutes
    ).as(apiAlias)
  })

  function dashboardRoutes(r: Router): void {
    r.get('', serveDashboard).as('home')
  }

  function apiRoutes(r: Router): void {
    // ---- Entries (Inspector) ----
    r.get('/entries', listEntries).as('entries')
    r.get('/entries/:uuid', showEntry).as('entry')
    r.get('/entries/:uuid/batch', showBatch).as('entry_batch')
    r.get('/entries/tag/:tag', entriesByTag).as('entries_by_tag')

    // ---- Aggregates (Metrics) ----
    r.get('/metrics/:type', queryMetrics).as('metrics')
    r.get('/metrics/:type/top', topKeys).as('metrics_top')

    // ---- Stats ----
    r.get('/stats', stats).as('stats')

    // ---- Prune ----
    r.delete('/entries', pruneEntries).as('prune_entries')
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function serveDashboard(ctx: Context): Response {
  return ctx.html(dashboardHtml())
}

async function listEntries(ctx: Context): Promise<Response> {
  const type = ctx.qs('type') as EntryType | null
  const limit = ctx.qs('limit', 50)
  const offset = ctx.qs('offset', 0)

  const entries = await DevtoolsManager.entryStore.list(type ?? undefined, limit, offset)
  return ctx.json({ data: entries })
}

async function showEntry(ctx: Context): Promise<Response> {
  const entry = await DevtoolsManager.entryStore.find(ctx.params.uuid!)
  if (!entry) return ctx.json({ error: 'Entry not found' }, 404)
  return ctx.json({ data: entry })
}

async function showBatch(ctx: Context): Promise<Response> {
  const entry = await DevtoolsManager.entryStore.find(ctx.params.uuid!)
  if (!entry) return ctx.json({ error: 'Entry not found' }, 404)

  const batch = await DevtoolsManager.entryStore.batch(entry.batchId)
  return ctx.json({ data: batch })
}

async function entriesByTag(ctx: Context): Promise<Response> {
  const limit = ctx.qs('limit', 50)
  const entries = await DevtoolsManager.entryStore.byTag(ctx.params.tag!, limit)
  return ctx.json({ data: entries })
}

async function queryMetrics(ctx: Context): Promise<Response> {
  const type = ctx.params.type!
  const period = ctx.qs('period', PERIODS.ONE_HOUR)
  const aggregate = (ctx.qs('aggregate') ?? 'count') as AggregateFunction
  const limit = ctx.qs('limit', 24)

  const data = await DevtoolsManager.aggregateStore.query(type, period, aggregate, limit)
  return ctx.json({ data })
}

async function topKeys(ctx: Context): Promise<Response> {
  const type = ctx.params.type!
  const period = ctx.qs('period', PERIODS.ONE_HOUR)
  const aggregate = (ctx.qs('aggregate') ?? 'count') as AggregateFunction
  const limit = ctx.qs('limit', 10)

  const data = await DevtoolsManager.aggregateStore.topKeys(type, period, aggregate, limit)
  return ctx.json({ data })
}

async function stats(ctx: Context): Promise<Response> {
  const [requests, queries, exceptions, logs, jobs] = await Promise.all([
    DevtoolsManager.entryStore.count('request'),
    DevtoolsManager.entryStore.count('query'),
    DevtoolsManager.entryStore.count('exception'),
    DevtoolsManager.entryStore.count('log'),
    DevtoolsManager.entryStore.count('job'),
  ])

  return ctx.json({
    data: {
      requests,
      queries,
      exceptions,
      logs,
      jobs,
      total: requests + queries + exceptions + logs + jobs,
    },
  })
}

async function pruneEntries(ctx: Context): Promise<Response> {
  const hours = ctx.qs('hours', DevtoolsManager.config.storage.pruneAfter)
  const entries = await DevtoolsManager.entryStore.prune(hours)
  const aggregates = await DevtoolsManager.aggregateStore.prune(hours)
  return ctx.json({ data: { entries, aggregates } })
}

// ---------------------------------------------------------------------------
// Dashboard HTML
// ---------------------------------------------------------------------------

function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Strav Devtools</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0f1117;--surface:#1a1d27;--border:#2a2d3a;--text:#e4e4e7;--text-muted:#71717a;--accent:#6366f1;--accent-hover:#818cf8;--success:#22c55e;--warning:#eab308;--danger:#ef4444;--info:#3b82f6;--radius:8px;--font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;--mono:"SF Mono","Fira Code","Fira Mono",monospace}
body{font-family:var(--font);background:var(--bg);color:var(--text);line-height:1.6;min-height:100vh}
a{color:var(--accent);text-decoration:none}
a:hover{color:var(--accent-hover)}

.layout{display:flex;min-height:100vh}
.sidebar{width:220px;background:var(--surface);border-right:1px solid var(--border);padding:1rem 0;position:fixed;height:100vh;overflow-y:auto}
.sidebar h1{font-size:.875rem;letter-spacing:.05em;text-transform:uppercase;color:var(--text-muted);padding:0 1rem;margin-bottom:1rem}
.sidebar .logo{font-size:1.125rem;font-weight:700;color:var(--accent);padding:0 1rem;margin-bottom:1.5rem;letter-spacing:-.02em;text-transform:none}
.sidebar nav a{display:flex;align-items:center;gap:.5rem;padding:.5rem 1rem;color:var(--text-muted);font-size:.875rem;transition:all .15s}
.sidebar nav a:hover,.sidebar nav a.active{color:var(--text);background:rgba(99,102,241,.1)}
.sidebar nav a.active{border-right:2px solid var(--accent)}
.sidebar nav .section{margin-top:1.25rem;padding:0 1rem;font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin-bottom:.25rem}

.main{margin-left:220px;flex:1;padding:1.5rem}
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem}
.header h2{font-size:1.25rem;font-weight:600}
.header .actions{display:flex;gap:.5rem}

.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.75rem;margin-bottom:1.5rem}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1rem}
.stat .label{font-size:.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em}
.stat .value{font-size:1.5rem;font-weight:700;margin-top:.25rem}

.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.card-header{padding:.75rem 1rem;border-bottom:1px solid var(--border);font-size:.875rem;font-weight:600;display:flex;align-items:center;justify-content:space-between}

table{width:100%;border-collapse:collapse;font-size:.8125rem}
thead th{text-align:left;padding:.625rem 1rem;border-bottom:1px solid var(--border);color:var(--text-muted);font-weight:500;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
tbody tr{border-bottom:1px solid var(--border);cursor:pointer;transition:background .1s}
tbody tr:hover{background:rgba(99,102,241,.05)}
tbody tr:last-child{border-bottom:none}
tbody td{padding:.625rem 1rem;vertical-align:middle}

.badge{display:inline-block;padding:.125rem .5rem;border-radius:100px;font-size:.6875rem;font-weight:600}
.badge-success{background:rgba(34,197,94,.15);color:var(--success)}
.badge-warning{background:rgba(234,179,8,.15);color:var(--warning)}
.badge-danger{background:rgba(239,68,68,.15);color:var(--danger)}
.badge-info{background:rgba(59,130,246,.15);color:var(--info)}
.badge-muted{background:rgba(113,113,122,.15);color:var(--text-muted)}

.tag{display:inline-block;padding:.0625rem .375rem;border-radius:4px;font-size:.6875rem;background:rgba(99,102,241,.15);color:var(--accent);margin-right:.25rem}

.btn{display:inline-flex;align-items:center;gap:.375rem;padding:.375rem .75rem;border-radius:6px;font-size:.8125rem;font-weight:500;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer;transition:all .15s}
.btn:hover{border-color:var(--accent);color:var(--accent)}
.btn-sm{padding:.25rem .5rem;font-size:.75rem}
.btn-danger{border-color:var(--danger);color:var(--danger)}
.btn-danger:hover{background:rgba(239,68,68,.1)}

.tabs{display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:1rem}
.tab{padding:.5rem 1rem;font-size:.8125rem;color:var(--text-muted);cursor:pointer;border-bottom:2px solid transparent;transition:all .15s}
.tab:hover{color:var(--text)}
.tab.active{color:var(--accent);border-bottom-color:var(--accent)}

.detail{padding:1rem}
.detail-row{display:flex;gap:1rem;padding:.5rem 0;border-bottom:1px solid var(--border)}
.detail-row:last-child{border-bottom:none}
.detail-label{width:120px;flex-shrink:0;font-size:.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em}
.detail-value{flex:1;font-family:var(--mono);font-size:.8125rem;word-break:break-all}

.sql{font-family:var(--mono);font-size:.8125rem;color:#a78bfa;white-space:pre-wrap}
.duration{font-family:var(--mono);font-size:.8125rem}
.duration.slow{color:var(--danger)}
.method{font-weight:600;font-size:.75rem;letter-spacing:.03em}
.method.GET{color:var(--success)}
.method.POST{color:var(--info)}
.method.PUT,.method.PATCH{color:var(--warning)}
.method.DELETE{color:var(--danger)}

.empty{text-align:center;padding:3rem;color:var(--text-muted);font-size:.875rem}
.loading{text-align:center;padding:2rem;color:var(--text-muted)}

.json-view{font-family:var(--mono);font-size:.8125rem;white-space:pre-wrap;background:var(--bg);padding:.75rem;border-radius:6px;max-height:400px;overflow-y:auto}

@media(max-width:768px){.sidebar{display:none}.main{margin-left:0}}
</style>
</head>
<body>
<div class="layout">
  <aside class="sidebar">
    <div class="logo">Strav Devtools</div>
    <nav>
      <div class="section">Inspector</div>
      <a href="#" data-view="requests" class="active">Requests</a>
      <a href="#" data-view="queries">Queries</a>
      <a href="#" data-view="exceptions">Exceptions</a>
      <a href="#" data-view="logs">Logs</a>
      <a href="#" data-view="jobs">Jobs</a>
      <div class="section">Metrics</div>
      <a href="#" data-view="slow-requests">Slow Requests</a>
      <a href="#" data-view="slow-queries">Slow Queries</a>
    </nav>
  </aside>
  <main class="main" id="app">
    <div class="loading">Loading...</div>
  </main>
</div>
<script>
const API = '/_devtools/api'
let currentView = 'requests'
let polling = null

// ---- Navigation ----
document.querySelectorAll('.sidebar nav a').forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault()
    document.querySelectorAll('.sidebar nav a').forEach(a => a.classList.remove('active'))
    link.classList.add('active')
    currentView = link.dataset.view
    render()
  })
})

// ---- Fetch helpers ----
async function api(path) {
  const res = await fetch(API + path)
  return res.json()
}

function timeAgo(date) {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000)
  if (seconds < 60) return seconds + 's ago'
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago'
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago'
  return Math.floor(seconds / 86400) + 'd ago'
}

function statusBadge(status) {
  if (status >= 500) return '<span class="badge badge-danger">' + status + '</span>'
  if (status >= 400) return '<span class="badge badge-warning">' + status + '</span>'
  if (status >= 300) return '<span class="badge badge-info">' + status + '</span>'
  return '<span class="badge badge-success">' + status + '</span>'
}

function durationEl(ms) {
  const cls = ms > 1000 ? 'duration slow' : 'duration'
  return '<span class="' + cls + '">' + ms.toFixed(1) + 'ms</span>'
}

function tagsHtml(tags) {
  return (tags || []).map(t => '<span class="tag">' + escHtml(t) + '</span>').join('')
}

function escHtml(s) {
  const d = document.createElement('div')
  d.textContent = s
  return d.innerHTML
}

function jsonView(obj) {
  return '<div class="json-view">' + escHtml(JSON.stringify(obj, null, 2)) + '</div>'
}

// ---- Views ----
async function renderRequests() {
  const { data } = await api('/entries?type=request&limit=100')
  if (!data.length) return '<div class="empty">No requests recorded yet.</div>'

  let html = '<div class="header"><h2>Requests</h2><div class="actions"><button class="btn btn-sm" onclick="render()">Refresh</button></div></div>'
  html += '<div class="card"><table><thead><tr><th>Method</th><th>Path</th><th>Status</th><th>Duration</th><th>Time</th></tr></thead><tbody>'
  for (const e of data) {
    const c = e.content
    html += '<tr onclick="showDetail(\\'' + e.uuid + '\\')">'
    html += '<td><span class="method ' + escHtml(c.method) + '">' + escHtml(c.method) + '</span></td>'
    html += '<td>' + escHtml(c.path) + '</td>'
    html += '<td>' + statusBadge(c.status) + '</td>'
    html += '<td>' + durationEl(c.duration) + '</td>'
    html += '<td style="color:var(--text-muted);font-size:.75rem">' + timeAgo(e.createdAt) + '</td>'
    html += '</tr>'
  }
  html += '</tbody></table></div>'
  return html
}

async function renderQueries() {
  const { data } = await api('/entries?type=query&limit=100')
  if (!data.length) return '<div class="empty">No queries recorded yet.</div>'

  let html = '<div class="header"><h2>Queries</h2></div>'
  html += '<div class="card"><table><thead><tr><th>SQL</th><th>Duration</th><th>Slow</th><th>Time</th></tr></thead><tbody>'
  for (const e of data) {
    const c = e.content
    const sqlPreview = (c.sql || '').substring(0, 120) + ((c.sql || '').length > 120 ? '...' : '')
    html += '<tr onclick="showDetail(\\'' + e.uuid + '\\')">'
    html += '<td><span class="sql">' + escHtml(sqlPreview) + '</span></td>'
    html += '<td>' + durationEl(c.duration) + '</td>'
    html += '<td>' + (c.slow ? '<span class="badge badge-danger">Slow</span>' : '<span class="badge badge-muted">OK</span>') + '</td>'
    html += '<td style="color:var(--text-muted);font-size:.75rem">' + timeAgo(e.createdAt) + '</td>'
    html += '</tr>'
  }
  html += '</tbody></table></div>'
  return html
}

async function renderExceptions() {
  const { data } = await api('/entries?type=exception&limit=100')
  if (!data.length) return '<div class="empty">No exceptions recorded.</div>'

  let html = '<div class="header"><h2>Exceptions</h2></div>'
  html += '<div class="card"><table><thead><tr><th>Class</th><th>Message</th><th>Path</th><th>Time</th></tr></thead><tbody>'
  for (const e of data) {
    const c = e.content
    html += '<tr onclick="showDetail(\\'' + e.uuid + '\\')">'
    html += '<td><span class="badge badge-danger">' + escHtml(c.class || 'Error') + '</span></td>'
    html += '<td>' + escHtml((c.message || '').substring(0, 80)) + '</td>'
    html += '<td style="color:var(--text-muted)">' + escHtml(c.path || '-') + '</td>'
    html += '<td style="color:var(--text-muted);font-size:.75rem">' + timeAgo(e.createdAt) + '</td>'
    html += '</tr>'
  }
  html += '</tbody></table></div>'
  return html
}

async function renderLogs() {
  const { data } = await api('/entries?type=log&limit=100')
  if (!data.length) return '<div class="empty">No log entries recorded.</div>'

  let html = '<div class="header"><h2>Logs</h2></div>'
  html += '<div class="card"><table><thead><tr><th>Level</th><th>Message</th><th>Time</th></tr></thead><tbody>'
  for (const e of data) {
    const c = e.content
    const badge = c.level === 'error' || c.level === 'fatal' ? 'badge-danger' : c.level === 'warn' ? 'badge-warning' : c.level === 'info' ? 'badge-info' : 'badge-muted'
    html += '<tr onclick="showDetail(\\'' + e.uuid + '\\')">'
    html += '<td><span class="badge ' + badge + '">' + escHtml(c.level) + '</span></td>'
    html += '<td>' + escHtml((c.message || '').substring(0, 120)) + '</td>'
    html += '<td style="color:var(--text-muted);font-size:.75rem">' + timeAgo(e.createdAt) + '</td>'
    html += '</tr>'
  }
  html += '</tbody></table></div>'
  return html
}

async function renderJobs() {
  const { data } = await api('/entries?type=job&limit=100')
  if (!data.length) return '<div class="empty">No jobs recorded yet.</div>'

  let html = '<div class="header"><h2>Jobs</h2></div>'
  html += '<div class="card"><table><thead><tr><th>Name</th><th>Status</th><th>Queue</th><th>Duration</th><th>Time</th></tr></thead><tbody>'
  for (const e of data) {
    const c = e.content
    const badge = c.status === 'processed' ? 'badge-success' : c.status === 'failed' ? 'badge-danger' : 'badge-info'
    html += '<tr onclick="showDetail(\\'' + e.uuid + '\\')">'
    html += '<td>' + escHtml(c.name) + '</td>'
    html += '<td><span class="badge ' + badge + '">' + escHtml(c.status) + '</span></td>'
    html += '<td style="color:var(--text-muted)">' + escHtml(c.queue || 'default') + '</td>'
    html += '<td>' + (c.duration != null ? durationEl(c.duration) : '-') + '</td>'
    html += '<td style="color:var(--text-muted);font-size:.75rem">' + timeAgo(e.createdAt) + '</td>'
    html += '</tr>'
  }
  html += '</tbody></table></div>'
  return html
}

async function renderSlowRequests() {
  const { data } = await api('/metrics/slow_request/top?period=3600&aggregate=count&limit=15')
  let html = '<div class="header"><h2>Slow Requests</h2></div>'

  if (!data.length) return html + '<div class="empty">No slow requests recorded.</div>'

  html += '<div class="card"><table><thead><tr><th>Endpoint</th><th>Count</th><th>Max (ms)</th></tr></thead><tbody>'

  const topMax = await api('/metrics/slow_request/top?period=3600&aggregate=max&limit=15')
  const maxMap = {}
  for (const r of topMax.data) maxMap[r.key] = r.value

  for (const r of data) {
    html += '<tr>'
    html += '<td>' + escHtml(r.key) + '</td>'
    html += '<td><span class="badge badge-danger">' + Math.round(r.value) + '</span></td>'
    html += '<td>' + (maxMap[r.key] != null ? durationEl(maxMap[r.key]) : '-') + '</td>'
    html += '</tr>'
  }
  html += '</tbody></table></div>'
  return html
}

async function renderSlowQueries() {
  const { data } = await api('/metrics/slow_query/top?period=3600&aggregate=count&limit=15')
  let html = '<div class="header"><h2>Slow Queries</h2></div>'

  if (!data.length) return html + '<div class="empty">No slow queries recorded.</div>'

  html += '<div class="card"><table><thead><tr><th>Query</th><th>Count</th><th>Max (ms)</th></tr></thead><tbody>'

  const topMax = await api('/metrics/slow_query/top?period=3600&aggregate=max&limit=15')
  const maxMap = {}
  for (const r of topMax.data) maxMap[r.key] = r.value

  for (const r of data) {
    html += '<tr>'
    html += '<td><span class="sql">' + escHtml(r.key.substring(0, 100)) + '</span></td>'
    html += '<td><span class="badge badge-danger">' + Math.round(r.value) + '</span></td>'
    html += '<td>' + (maxMap[r.key] != null ? durationEl(maxMap[r.key]) : '-') + '</td>'
    html += '</tr>'
  }
  html += '</tbody></table></div>'
  return html
}

async function showDetail(uuid) {
  const app = document.getElementById('app')
  app.innerHTML = '<div class="loading">Loading...</div>'

  const { data: entry } = await api('/entries/' + uuid)
  const { data: batch } = await api('/entries/' + uuid + '/batch')

  let html = '<div class="header"><h2>Entry Detail</h2><div class="actions"><button class="btn btn-sm" onclick="render()">Back</button></div></div>'
  html += '<div class="card"><div class="detail">'
  html += '<div class="detail-row"><div class="detail-label">UUID</div><div class="detail-value">' + escHtml(entry.uuid) + '</div></div>'
  html += '<div class="detail-row"><div class="detail-label">Type</div><div class="detail-value"><span class="badge badge-info">' + escHtml(entry.type) + '</span></div></div>'
  html += '<div class="detail-row"><div class="detail-label">Batch ID</div><div class="detail-value">' + escHtml(entry.batchId) + '</div></div>'
  html += '<div class="detail-row"><div class="detail-label">Tags</div><div class="detail-value">' + tagsHtml(entry.tags) + '</div></div>'
  html += '<div class="detail-row"><div class="detail-label">Created</div><div class="detail-value">' + new Date(entry.createdAt).toLocaleString() + '</div></div>'
  html += '<div class="detail-row"><div class="detail-label">Content</div><div class="detail-value">' + jsonView(entry.content) + '</div></div>'
  html += '</div></div>'

  if (batch.length > 1) {
    html += '<div style="margin-top:1rem"><div class="card"><div class="card-header">Related Entries (' + batch.length + ')</div>'
    html += '<table><thead><tr><th>Type</th><th>Summary</th><th>Time</th></tr></thead><tbody>'
    for (const b of batch) {
      if (b.uuid === entry.uuid) continue
      const summary = b.type === 'query' ? (b.content.sql || '').substring(0, 80) : b.type === 'log' ? b.content.message : b.type === 'exception' ? b.content.message : JSON.stringify(b.content).substring(0, 80)
      html += '<tr onclick="showDetail(\\'' + b.uuid + '\\')" style="cursor:pointer">'
      html += '<td><span class="badge badge-info">' + escHtml(b.type) + '</span></td>'
      html += '<td>' + escHtml(summary) + '</td>'
      html += '<td style="color:var(--text-muted);font-size:.75rem">' + timeAgo(b.createdAt) + '</td>'
      html += '</tr>'
    }
    html += '</tbody></table></div></div>'
  }

  app.innerHTML = html
}

// ---- Render ----
async function render() {
  const app = document.getElementById('app')
  app.innerHTML = '<div class="loading">Loading...</div>'

  try {
    let html = ''
    switch (currentView) {
      case 'requests': html = await renderRequests(); break
      case 'queries': html = await renderQueries(); break
      case 'exceptions': html = await renderExceptions(); break
      case 'logs': html = await renderLogs(); break
      case 'jobs': html = await renderJobs(); break
      case 'slow-requests': html = await renderSlowRequests(); break
      case 'slow-queries': html = await renderSlowQueries(); break
    }
    app.innerHTML = html
  } catch (err) {
    app.innerHTML = '<div class="empty">Error loading data: ' + escHtml(err.message) + '</div>'
  }
}

// Make showDetail available globally
window.showDetail = showDetail

// Initial render + auto-refresh
render()
polling = setInterval(render, 5000)
</script>
</body>
</html>`
}

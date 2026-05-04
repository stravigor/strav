import { join } from 'node:path'
import { Archetype } from '@strav/database/schema/types'
import type { SchemaDefinition } from '@strav/database/schema/types'
import type {
  DatabaseRepresentation,
  TableDefinition,
  ColumnDefinition,
} from '@strav/database/schema/database_representation'
import type { FieldDefinition, FieldValidator } from '@strav/database/schema/field_definition'
import type { PostgreSQLCustomType } from '@strav/database/schema/postgres'
import {
  toSnakeCase,
  toCamelCase,
  toPascalCase,
  pluralize,
} from '@strav/kernel/helpers/strings'
import { existsSync } from 'node:fs'
import type { GeneratedFile } from './model_generator.ts'
import type { GeneratorConfig, GeneratorPaths, WriteResult } from './config.ts'
import { resolvePaths } from './config.ts'
import { ApiRouting, toRouteSegment, toChildSegment } from './route_generator.ts'
import type { ApiRoutingConfig } from './route_generator.ts'

// ---------------------------------------------------------------------------
// Archetype behaviour (mirrored from api_generator.ts)
// ---------------------------------------------------------------------------

const ARCHETYPE_CONTROLLER: Record<Archetype, string[]> = {
  [Archetype.Entity]: ['index', 'show', 'store', 'update', 'destroy'],
  [Archetype.Attribute]: ['index', 'show', 'store', 'update', 'destroy'],
  [Archetype.Contribution]: ['index', 'show', 'store', 'update', 'destroy'],
  [Archetype.Reference]: ['index', 'show', 'store', 'update', 'destroy'],
  [Archetype.Component]: ['index', 'show', 'update'],
  [Archetype.Event]: ['index', 'show', 'store'],
  [Archetype.Configuration]: ['show', 'update', 'destroy'],
  [Archetype.Association]: [],
}

const DEPENDENT_ARCHETYPES: Set<Archetype> = new Set([
  Archetype.Component,
  Archetype.Attribute,
  Archetype.Event,
  Archetype.Configuration,
  Archetype.Contribution,
])

const SYSTEM_COLUMNS = new Set(['id', 'created_at', 'updated_at', 'deleted_at'])

const ARCHETYPE_DESCRIPTIONS: Record<Archetype, string> = {
  [Archetype.Entity]: 'A standalone entity with full CRUD operations and soft delete support.',
  [Archetype.Contribution]:
    'A user-contributed resource under a parent entity. Full CRUD with soft delete.',
  [Archetype.Reference]:
    'A lookup/reference table with full CRUD. No soft delete &mdash; records are permanently removed.',
  [Archetype.Attribute]: 'A dependent attribute of a parent entity. Full CRUD with soft delete.',
  [Archetype.Component]:
    'A tightly-coupled component of a parent entity. Can be listed, viewed, and updated &mdash; but not independently created or deleted.',
  [Archetype.Event]:
    'An append-only event log under a parent entity. Events can be listed, viewed, and appended &mdash; but never updated or deleted.',
  [Archetype.Configuration]:
    'A singleton configuration record under a parent entity. One record per parent. Supports show, upsert, and reset.',
  [Archetype.Association]: 'A join table linking two entities.',
}

const API_DEFAULTS: ApiRoutingConfig = {
  routing: ApiRouting.Prefix,
  prefix: '/api',
  subdomain: 'api',
}

// ---------------------------------------------------------------------------
// DocGenerator
// ---------------------------------------------------------------------------

export default class DocGenerator {
  private apiConfig: ApiRoutingConfig
  private paths: GeneratorPaths
  private schemaMap: Map<string, SchemaDefinition>

  constructor(
    private schemas: SchemaDefinition[],
    private representation: DatabaseRepresentation,
    config?: GeneratorConfig,
    apiConfig?: Partial<ApiRoutingConfig>
  ) {
    this.apiConfig = { ...API_DEFAULTS, ...apiConfig }
    this.paths = resolvePaths(config)
    this.schemaMap = new Map(schemas.map(s => [s.name, s]))
  }

  generate(): GeneratedFile[] {
    return [this.generateIndexPage()]
  }

  async writeAll(force?: boolean): Promise<WriteResult> {
    const files = this.generate()
    const written: GeneratedFile[] = []
    const skipped: GeneratedFile[] = []

    for (const file of files) {
      if (existsSync(file.path) && !force) {
        skipped.push(file)
        continue
      }
      await Bun.write(file.path, file.content)
      written.push(file)
    }

    return { written, skipped }
  }

  // ---------------------------------------------------------------------------
  // Main page
  // ---------------------------------------------------------------------------

  private generateIndexPage(): GeneratedFile {
    const routable = this.schemas.filter(s => s.archetype !== Archetype.Association)

    // Group by parent for sidebar
    const rootSchemas: SchemaDefinition[] = []
    const childrenOf = new Map<string, SchemaDefinition[]>()

    for (const s of routable) {
      const routeParent = s.parents?.[0]
      if (DEPENDENT_ARCHETYPES.has(s.archetype) && routeParent) {
        if (!childrenOf.has(routeParent)) childrenOf.set(routeParent, [])
        childrenOf.get(routeParent)!.push(s)
      } else {
        rootSchemas.push(s)
      }
    }

    const sidebar = this.buildSidebar(rootSchemas, childrenOf)
    const content = this.buildContent(routable)

    const html = `<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API Reference</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: {
            sans: ['Inter', 'system-ui', 'sans-serif'],
            mono: ['JetBrains Mono', 'monospace'],
          },
        },
      },
    }
  </script>
  <style>
    html { scroll-padding-top: 6rem; }
    .sidebar-link.active { color: #fff; background: rgba(255,255,255,0.06); }
    .sidebar-link:hover { color: #e4e4e7; background: rgba(255,255,255,0.04); }
    .method-badge { font-size: 0.65rem; font-weight: 600; letter-spacing: 0.05em; padding: 0.15rem 0.5rem; border-radius: 9999px; text-transform: uppercase; }
    pre code { font-size: 0.8125rem; line-height: 1.625; }
    @media (max-width: 1023px) {
      .sidebar { transform: translateX(-100%); position: fixed; z-index: 50; }
      .sidebar.open { transform: translateX(0); }
    }
  </style>
</head>
<body class="bg-white font-sans text-zinc-900 antialiased">

  <!-- Mobile menu button -->
  <button onclick="document.getElementById('sidebar').classList.toggle('open')"
    class="lg:hidden fixed top-4 left-4 z-50 p-2 rounded-lg bg-zinc-900 text-white shadow-lg">
    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>
    </svg>
  </button>

  <!-- Sidebar -->
  <aside id="sidebar" class="sidebar fixed inset-y-0 left-0 w-72 bg-zinc-900 overflow-y-auto transition-transform duration-200 lg:translate-x-0">
    <div class="px-6 py-8">
      <h1 class="text-lg font-semibold text-white tracking-tight">API Reference</h1>
      <p class="mt-1 text-xs text-zinc-500">Generated by Strav</p>
    </div>
    <nav class="px-3 pb-8">
${sidebar}
    </nav>
  </aside>

  <!-- Main content -->
  <main class="lg:pl-72">
    <div class="max-w-4xl mx-auto px-6 sm:px-8 py-16">
${content}
    </div>
  </main>

  <script>
    // Highlight active sidebar link on scroll
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          document.querySelectorAll('.sidebar-link').forEach(l => l.classList.remove('active'));
          const link = document.querySelector('.sidebar-link[href="#' + entry.target.id + '"]');
          if (link) link.classList.add('active');
        }
      }
    }, { rootMargin: '-20% 0px -70% 0px' });
    document.querySelectorAll('section[id]').forEach(s => observer.observe(s));

    // Close mobile sidebar on link click
    document.querySelectorAll('.sidebar-link').forEach(link => {
      link.addEventListener('click', () => {
        document.getElementById('sidebar').classList.remove('open');
      });
    });
  </script>
</body>
</html>`

    return {
      path: join(this.paths.docs, 'index.html'),
      content: html,
    }
  }

  // ---------------------------------------------------------------------------
  // Sidebar
  // ---------------------------------------------------------------------------

  private buildSidebar(
    rootSchemas: SchemaDefinition[],
    childrenOf: Map<string, SchemaDefinition[]>
  ): string {
    const lines: string[] = []

    // Introduction & Auth
    lines.push('      <div class="mb-6">')
    lines.push(
      '        <p class="px-3 text-[0.6875rem] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Getting Started</p>'
    )
    lines.push(
      '        <a href="#introduction" class="sidebar-link block px-3 py-1.5 text-sm text-zinc-400 rounded-md transition-colors">Introduction</a>'
    )
    lines.push(
      '        <a href="#authentication" class="sidebar-link block px-3 py-1.5 text-sm text-zinc-400 rounded-md transition-colors">Authentication</a>'
    )
    lines.push('      </div>')

    // Resources
    lines.push('      <div>')
    lines.push(
      '        <p class="px-3 text-[0.6875rem] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Resources</p>'
    )

    const emitSchema = (schema: SchemaDefinition): void => {
      const anchor = toSnakeCase(schema.name)
      const label = this.displayName(schema.name)
      lines.push(
        `        <a href="#${anchor}" class="sidebar-link block px-3 py-1.5 text-sm text-zinc-400 rounded-md transition-colors">${label}</a>`
      )

      const children = childrenOf.get(schema.name)
      if (children?.length) {
        for (const child of children) emitSchema(child)
      }
    }

    for (const schema of rootSchemas) emitSchema(schema)

    lines.push('      </div>')
    return lines.join('\n')
  }

  // ---------------------------------------------------------------------------
  // Main content
  // ---------------------------------------------------------------------------

  private buildContent(routable: SchemaDefinition[]): string {
    const sections: string[] = []

    sections.push(this.buildIntroduction())
    sections.push(this.buildAuthentication())

    for (const schema of routable) {
      const table = this.representation.tables.find(t => t.name === toSnakeCase(schema.name))
      if (!table) continue
      sections.push(this.buildResourceSection(schema, table))
    }

    return sections.join('\n\n')
  }

  // ---------------------------------------------------------------------------
  // Introduction section
  // ---------------------------------------------------------------------------

  private buildIntroduction(): string {
    const baseUrl =
      this.apiConfig.routing === ApiRouting.Subdomain
        ? `https://${this.apiConfig.subdomain}.&lt;domain&gt;`
        : `https://&lt;domain&gt;${this.apiConfig.prefix}`

    return `      <section id="introduction" class="mb-20">
        <h2 class="text-2xl font-semibold tracking-tight text-zinc-900">Introduction</h2>
        <div class="mt-4 text-sm leading-relaxed text-zinc-600 space-y-3">
          <p>Welcome to the API reference. This documentation is auto-generated from the application schema definitions.</p>
          <div class="rounded-lg border border-zinc-200 overflow-hidden">
            <table class="w-full text-sm">
              <tbody>
                <tr class="border-b border-zinc-100">
                  <td class="px-4 py-2.5 font-medium text-zinc-700 bg-zinc-50 w-40">Base URL</td>
                  <td class="px-4 py-2.5 font-mono text-xs text-zinc-600">${baseUrl}</td>
                </tr>
                <tr class="border-b border-zinc-100">
                  <td class="px-4 py-2.5 font-medium text-zinc-700 bg-zinc-50">Content-Type</td>
                  <td class="px-4 py-2.5 font-mono text-xs text-zinc-600">application/json</td>
                </tr>
                <tr>
                  <td class="px-4 py-2.5 font-medium text-zinc-700 bg-zinc-50">Authentication</td>
                  <td class="px-4 py-2.5 font-mono text-xs text-zinc-600">Bearer token</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>`
  }

  // ---------------------------------------------------------------------------
  // Authentication section
  // ---------------------------------------------------------------------------

  private buildAuthentication(): string {
    return `      <section id="authentication" class="mb-20">
        <h2 class="text-2xl font-semibold tracking-tight text-zinc-900">Authentication</h2>
        <div class="mt-4 text-sm leading-relaxed text-zinc-600 space-y-4">
          <p>All API endpoints require authentication via a bearer token. Include the token in the <code class="text-xs font-mono bg-zinc-100 px-1.5 py-0.5 rounded">Authorization</code> header of every request.</p>
          <div class="rounded-lg bg-zinc-900 p-4 overflow-x-auto">
            <pre><code class="text-zinc-100 font-mono">GET ${this.apiConfig.routing === ApiRouting.Prefix ? this.apiConfig.prefix : ''}/resources HTTP/1.1
Host: &lt;domain&gt;
Authorization: Bearer &lt;your-token&gt;
Content-Type: application/json</code></pre>
          </div>
          <div class="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <p class="text-amber-800 text-xs font-medium">Unauthenticated requests</p>
            <p class="text-amber-700 text-xs mt-1">Requests without a valid bearer token will receive a <code class="font-mono bg-amber-100 px-1 py-0.5 rounded">401 Unauthenticated</code> response.</p>
          </div>
          <h3 class="text-base font-semibold text-zinc-900 pt-2">Error responses</h3>
          <div class="rounded-lg bg-zinc-900 p-4 overflow-x-auto">
            <pre><code class="text-zinc-100 font-mono">// 401 Unauthenticated
{ "error": "Unauthenticated" }

// 422 Validation Error
{ "errors": { "fieldName": ["Validation message"] } }

// 404 Not Found
{ "error": "Not Found" }</code></pre>
          </div>
        </div>
      </section>`
  }

  // ---------------------------------------------------------------------------
  // Per-resource section
  // ---------------------------------------------------------------------------

  private buildResourceSection(schema: SchemaDefinition, table: TableDefinition): string {
    const anchor = toSnakeCase(schema.name)
    const label = this.displayName(schema.name)
    const actions = ARCHETYPE_CONTROLLER[schema.archetype] ?? []
    const archetypeColor = this.archetypeBadgeColor(schema.archetype)
    const description = ARCHETYPE_DESCRIPTIONS[schema.archetype]

    const fieldsTable = this.buildFieldsTable(schema, table)
    const endpoints = actions.map(action => this.buildEndpoint(action, schema, table)).join('\n')

    return `      <section id="${anchor}" class="mb-20">
        <div class="flex items-center gap-3">
          <h2 class="text-2xl font-semibold tracking-tight text-zinc-900">${label}</h2>
          <span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-[0.625rem] font-semibold ${archetypeColor}">${schema.archetype}</span>
        </div>
        <p class="mt-2 text-sm text-zinc-500">${description}</p>
${schema.parents?.length ? `        <p class="mt-4 text-sm text-zinc-500">Parents: <span class="font-semibold text-zinc-700">${schema.parents.map(p => this.displayName(p)).join(', ')}</span></p>` : ''}

        <div class="mt-6">
          <h3 class="text-sm font-semibold text-zinc-900 mb-3">Fields</h3>
${fieldsTable}
        </div>

        <div class="mt-8 space-y-8">
          <h3 class="text-sm font-semibold text-zinc-900">Endpoints</h3>
${endpoints}
        </div>
      </section>`
  }

  // ---------------------------------------------------------------------------
  // Fields table
  // ---------------------------------------------------------------------------

  private buildFieldsTable(schema: SchemaDefinition, table: TableDefinition): string {
    const rows: string[] = []

    for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
      if (fieldDef.primaryKey) continue
      const colName = toSnakeCase(fieldName)
      if (SYSTEM_COLUMNS.has(colName)) continue

      const camelName = toCamelCase(fieldName)
      const typeLabel = this.fieldTypeLabel(fieldDef)
      const required = fieldDef.required
        ? '<span class="text-rose-500 text-[0.625rem] font-semibold">required</span>'
        : '<span class="text-zinc-400 text-[0.625rem]">optional</span>'
      const sensitive = fieldDef.sensitive
        ? ' <span class="text-amber-500 text-[0.625rem] font-semibold">sensitive</span>'
        : ''
      const validators = this.validatorSummary(fieldDef)
      const validatorHtml = validators
        ? `<span class="text-zinc-400 text-[0.625rem]">${validators}</span>`
        : ''

      rows.push(`            <tr class="border-b border-zinc-100 last:border-0">
              <td class="py-2.5 pl-4 pr-4 font-mono text-xs text-emerald-600 whitespace-nowrap">${camelName}</td>
              <td class="py-2.5 pr-4 text-xs text-zinc-500 whitespace-nowrap">${typeLabel}</td>
              <td class="py-2.5 pr-4">${required}${sensitive}</td>
              <td class="py-2.5 text-xs text-zinc-400">${validatorHtml}</td>
            </tr>`)
    }

    if (rows.length === 0) {
      return '          <p class="text-xs text-zinc-400 italic">No user-editable fields.</p>'
    }

    return `          <div class="rounded-lg border border-zinc-200 overflow-hidden">
            <table class="w-full text-sm">
              <thead>
                <tr class="bg-zinc-50 border-b border-zinc-200">
                  <th class="text-left px-4 py-2 text-[0.6875rem] font-semibold text-zinc-500 uppercase tracking-wider">Name</th>
                  <th class="text-left px-4 py-2 text-[0.6875rem] font-semibold text-zinc-500 uppercase tracking-wider">Type</th>
                  <th class="text-left px-4 py-2 text-[0.6875rem] font-semibold text-zinc-500 uppercase tracking-wider">Status</th>
                  <th class="text-left px-4 py-2 text-[0.6875rem] font-semibold text-zinc-500 uppercase tracking-wider">Constraints</th>
                </tr>
              </thead>
              <tbody class="px-4">
${rows.join('\n')}
              </tbody>
            </table>
          </div>`
  }

  // ---------------------------------------------------------------------------
  // Per-endpoint block
  // ---------------------------------------------------------------------------

  private buildEndpoint(action: string, schema: SchemaDefinition, table: TableDefinition): string {
    const { method, pathPattern, description } = this.actionMeta(action, schema)
    const methodColor = this.methodBadgeColor(method)
    const anchor = `${toSnakeCase(schema.name)}-${action}`

    const bodyFields = this.endpointBodyFields(action, schema, table)
    const bodySection = bodyFields.length > 0 ? this.buildBodyFieldsTable(bodyFields) : ''

    const exampleRequest = this.buildExampleRequest(method, pathPattern, action, schema, table)
    const exampleResponse = this.buildExampleResponse(action, schema, table)

    return `          <div id="${anchor}" class="rounded-lg border border-zinc-200 overflow-hidden">
            <div class="flex items-center gap-3 px-4 py-3 bg-zinc-50 border-b border-zinc-200">
              <span class="method-badge ${methodColor}">${method}</span>
              <code class="text-sm font-mono text-zinc-700">${this.escapeHtml(pathPattern)}</code>
            </div>
            <div class="px-4 py-4 space-y-4">
              <p class="text-sm text-zinc-600">${description}</p>
${bodySection}
${exampleRequest}
${exampleResponse}
            </div>
          </div>`
  }

  // ---------------------------------------------------------------------------
  // Body fields table (for store/update endpoints)
  // ---------------------------------------------------------------------------

  private buildBodyFieldsTable(
    fields: { name: string; type: string; required: boolean; description: string }[]
  ): string {
    const rows = fields.map(f => {
      const req = f.required
        ? '<span class="text-rose-500 text-[0.625rem] font-semibold">required</span>'
        : '<span class="text-zinc-400 text-[0.625rem]">optional</span>'
      return `                  <tr class="border-b border-zinc-100 last:border-0">
                    <td class="py-2 pl-4 pr-3 font-mono text-xs text-emerald-600 whitespace-nowrap">${f.name}</td>
                    <td class="py-2 pr-3 text-xs text-zinc-500">${f.type}</td>
                    <td class="py-2 pr-3">${req}</td>
                    <td class="py-2 pr-4 text-xs text-zinc-400">${f.description}</td>
                  </tr>`
    })

    return `              <div>
                <p class="text-xs font-semibold text-zinc-700 mb-2">Request body</p>
                <div class="rounded-md border border-zinc-200 overflow-hidden">
                  <table class="w-full text-sm">
                    <tbody>
${rows.join('\n')}
                    </tbody>
                  </table>
                </div>
              </div>`
  }

  // ---------------------------------------------------------------------------
  // Example request
  // ---------------------------------------------------------------------------

  private buildExampleRequest(
    method: string,
    path: string,
    action: string,
    schema: SchemaDefinition,
    table: TableDefinition
  ): string {
    const hasBody = action === 'store' || action === 'update'

    if (!hasBody) {
      return `              <div>
                <p class="text-xs font-semibold text-zinc-700 mb-2">Example request</p>
                <div class="rounded-md bg-zinc-900 p-3 overflow-x-auto">
                  <pre><code class="text-zinc-100 font-mono">curl -X ${method} \\
  https://&lt;domain&gt;${this.escapeHtml(path)} \\
  -H "Authorization: Bearer &lt;token&gt;"</code></pre>
                </div>
              </div>`
    }

    const payload = this.buildJsonPayload(action, schema, table)

    return `              <div>
                <p class="text-xs font-semibold text-zinc-700 mb-2">Example request</p>
                <div class="rounded-md bg-zinc-900 p-3 overflow-x-auto">
                  <pre><code class="text-zinc-100 font-mono">curl -X ${method} \\
  https://&lt;domain&gt;${this.escapeHtml(path)} \\
  -H "Authorization: Bearer &lt;token&gt;" \\
  -H "Content-Type: application/json" \\
  -d '${this.escapeHtml(payload)}'</code></pre>
                </div>
              </div>`
  }

  // ---------------------------------------------------------------------------
  // Example response
  // ---------------------------------------------------------------------------

  private buildExampleResponse(
    action: string,
    schema: SchemaDefinition,
    table: TableDefinition
  ): string {
    const { statusCode, responseBody } = this.sampleResponse(action, schema, table)

    return `              <div>
                <p class="text-xs font-semibold text-zinc-700 mb-2">Example response &mdash; <span class="text-emerald-600">${statusCode}</span></p>
                <div class="rounded-md bg-zinc-900 p-3 overflow-x-auto">
                  <pre><code class="text-zinc-100 font-mono">${this.escapeHtml(responseBody)}</code></pre>
                </div>
              </div>`
  }

  // ---------------------------------------------------------------------------
  // Action metadata
  // ---------------------------------------------------------------------------

  private actionMeta(
    action: string,
    schema: SchemaDefinition
  ): { method: string; pathPattern: string; description: string } {
    const isDependent = DEPENDENT_ARCHETYPES.has(schema.archetype) && !!schema.parents?.length
    const isConfig = schema.archetype === Archetype.Configuration
    const isEvent = schema.archetype === Archetype.Event
    const basePath = this.buildRoutePath(schema)

    switch (action) {
      case 'index':
        return {
          method: 'GET',
          pathPattern: basePath,
          description: isDependent
            ? `List all ${this.displayNamePlural(schema.name)} under the parent.`
            : `List all ${this.displayNamePlural(schema.name)}.`,
        }
      case 'show':
        return {
          method: 'GET',
          pathPattern: isConfig ? basePath : `${basePath}/:id`,
          description: isConfig
            ? `Retrieve the ${this.displayName(schema.name)} for the parent.`
            : `Retrieve a single ${this.displayName(schema.name)} by ID.`,
        }
      case 'store':
        return {
          method: 'POST',
          pathPattern: basePath,
          description: isEvent
            ? `Append a new ${this.displayName(schema.name)} event.`
            : `Create a new ${this.displayName(schema.name)}.`,
        }
      case 'update':
        return {
          method: 'PUT',
          pathPattern: isConfig ? basePath : `${basePath}/:id`,
          description: isConfig
            ? `Create or update the ${this.displayName(schema.name)} for the parent.`
            : `Update an existing ${this.displayName(schema.name)}.`,
        }
      case 'destroy':
        return {
          method: 'DELETE',
          pathPattern: isConfig ? basePath : `${basePath}/:id`,
          description: isConfig
            ? `Reset the ${this.displayName(schema.name)} to defaults.`
            : `Delete a ${this.displayName(schema.name)}.`,
        }
      default:
        return { method: 'GET', pathPattern: basePath, description: '' }
    }
  }

  // ---------------------------------------------------------------------------
  // Body fields for an endpoint
  // ---------------------------------------------------------------------------

  private endpointBodyFields(
    action: string,
    schema: SchemaDefinition,
    table: TableDefinition
  ): { name: string; type: string; required: boolean; description: string }[] {
    if (action !== 'store' && action !== 'update') return []

    const isStore = action === 'store'
    const fields: { name: string; type: string; required: boolean; description: string }[] = []

    const parentFkCols = new Set(
      (schema.parents ?? []).map(p => `${toSnakeCase(p)}_${toSnakeCase(this.findSchemaPK(p))}`)
    )

    for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
      if (fieldDef.primaryKey) continue
      if (fieldDef.references) {
        const refPK = this.findSchemaPK(fieldDef.references)
        const fkColName = `${toSnakeCase(fieldName)}_${toSnakeCase(refPK)}`
        if (parentFkCols.has(fkColName)) continue
        if (SYSTEM_COLUMNS.has(fkColName)) continue

        fields.push({
          name: toCamelCase(fkColName),
          type: 'string',
          required: isStore && fieldDef.required,
          description: `ID of the referenced ${this.displayName(fieldDef.references)}`,
        })
        continue
      }

      const colName = toSnakeCase(fieldName)
      if (SYSTEM_COLUMNS.has(colName)) continue
      if (parentFkCols.has(colName)) continue

      fields.push({
        name: toCamelCase(fieldName),
        type: this.fieldTypeLabel(fieldDef),
        required: isStore && fieldDef.required,
        description: this.validatorSummary(fieldDef),
      })
    }

    return fields
  }

  // ---------------------------------------------------------------------------
  // JSON payloads
  // ---------------------------------------------------------------------------

  private buildJsonPayload(
    action: string,
    schema: SchemaDefinition,
    table: TableDefinition
  ): string {
    const entries: Record<string, unknown> = {}

    const parentFkCols = new Set(
      (schema.parents ?? []).map(p => `${toSnakeCase(p)}_${toSnakeCase(this.findSchemaPK(p))}`)
    )

    for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
      if (fieldDef.primaryKey) continue
      if (fieldDef.references) {
        const refPK = this.findSchemaPK(fieldDef.references)
        const fkColName = `${toSnakeCase(fieldName)}_${toSnakeCase(refPK)}`
        if (parentFkCols.has(fkColName)) continue
        if (SYSTEM_COLUMNS.has(fkColName)) continue
        entries[toCamelCase(fkColName)] = '<uuid>'
        continue
      }

      const colName = toSnakeCase(fieldName)
      if (SYSTEM_COLUMNS.has(colName)) continue
      if (parentFkCols.has(colName)) continue
      if (fieldDef.sensitive) continue

      const camelName = toCamelCase(fieldName)
      entries[camelName] = this.sampleValueLiteral(fieldName, fieldDef)
    }

    return JSON.stringify(entries, null, 2)
  }

  private sampleResponse(
    action: string,
    schema: SchemaDefinition,
    table: TableDefinition
  ): { statusCode: number; responseBody: string } {
    if (action === 'destroy') {
      return { statusCode: 200, responseBody: JSON.stringify({ ok: true }, null, 2) }
    }

    const obj: Record<string, unknown> = {}
    const pkName = this.findSchemaPK(schema.name)
    obj[toCamelCase(pkName)] = this.getPkSample(schema)

    for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
      if (fieldDef.primaryKey) continue
      const colName = toSnakeCase(fieldName)
      if (colName === 'deleted_at') continue

      if (fieldDef.references) {
        const refPK = this.findSchemaPK(fieldDef.references)
        const fkColName = `${toSnakeCase(fieldName)}_${toSnakeCase(refPK)}`
        obj[toCamelCase(fkColName)] = '<uuid>'
        continue
      }

      const camelName = toCamelCase(fieldName)
      if (fieldDef.sensitive) {
        obj[camelName] = '[REDACTED]'
        continue
      }

      if (colName === 'created_at' || colName === 'updated_at') {
        obj[camelName] = '2025-01-15T10:30:00.000Z'
        continue
      }

      obj[camelName] = this.sampleValueLiteral(fieldName, fieldDef)
    }

    const statusCode = action === 'store' ? 201 : 200
    const body = action === 'index' ? JSON.stringify([obj], null, 2) : JSON.stringify(obj, null, 2)

    return { statusCode, responseBody: body }
  }

  // ---------------------------------------------------------------------------
  // Route path building (shared with route_generator)
  // ---------------------------------------------------------------------------

  private buildRoutePath(schema: SchemaDefinition): string {
    const isDependent = DEPENDENT_ARCHETYPES.has(schema.archetype)
    const prefix = this.apiConfig.routing === ApiRouting.Prefix ? this.apiConfig.prefix : ''

    const routeParent = schema.parents?.[0]
    if (!isDependent || !routeParent) {
      return `${prefix}/${toRouteSegment(schema.name)}`
    }

    const parentSegment = toRouteSegment(routeParent)
    const childSegment = toChildSegment(schema.name, routeParent)

    return `${prefix}/${parentSegment}/:parentId/${childSegment}`
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private displayName(name: string): string {
    return toPascalCase(name)
      .replace(/([A-Z])/g, ' $1')
      .trim()
  }

  private displayNamePlural(name: string): string {
    const display = this.displayName(name).toLowerCase()
    const lastWord = display.split(' ').pop() ?? display
    const pluralLast = pluralize(lastWord)
    const words = display.split(' ')
    words[words.length - 1] = pluralLast
    return words.join(' ')
  }

  private findSchemaPK(schemaName: string): string {
    const schema = this.schemaMap.get(schemaName)
    if (!schema) return 'id'
    for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
      if (fieldDef.primaryKey) return fieldName
    }
    return 'id'
  }

  private getPkSample(schema: SchemaDefinition): string {
    for (const [, fieldDef] of Object.entries(schema.fields)) {
      if (fieldDef.primaryKey) {
        if (String(fieldDef.pgType) === 'uuid') return 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
        return '1'
      }
    }
    return '1'
  }

  private fieldTypeLabel(fieldDef: FieldDefinition): string {
    if (isCustomType(fieldDef.pgType)) {
      return `enum(${toPascalCase((fieldDef.pgType as PostgreSQLCustomType).name)})`
    }
    if (fieldDef.enumValues?.length) {
      return `enum(${fieldDef.enumValues.join(' | ')})`
    }
    const pgType = String(fieldDef.pgType)
    switch (pgType) {
      case 'varchar':
      case 'character_varying':
      case 'char':
      case 'character':
      case 'text':
        return fieldDef.length ? `string(${fieldDef.length})` : 'string'
      case 'uuid':
        return 'uuid'
      case 'integer':
      case 'smallint':
      case 'serial':
      case 'smallserial':
        return 'integer'
      case 'bigint':
      case 'bigserial':
        return 'bigint'
      case 'real':
      case 'double_precision':
      case 'decimal':
      case 'numeric':
      case 'money':
        return fieldDef.precision
          ? `decimal(${fieldDef.precision},${fieldDef.scale ?? 0})`
          : 'number'
      case 'boolean':
        return 'boolean'
      case 'json':
      case 'jsonb':
        return 'json'
      case 'timestamp':
      case 'timestamptz':
      case 'timestamp_with_time_zone':
        return 'datetime'
      case 'date':
        return 'date'
      case 'time':
      case 'timetz':
        return 'time'
      default:
        return pgType
    }
  }

  private validatorSummary(fieldDef: FieldDefinition): string {
    const parts: string[] = []
    if (fieldDef.unique) parts.push('unique')
    if (fieldDef.length) parts.push(`max ${fieldDef.length} chars`)
    for (const v of fieldDef.validators) {
      switch (v.type) {
        case 'min':
          parts.push(`min: ${v.params?.value ?? 0}`)
          break
        case 'max':
          parts.push(`max: ${v.params?.value ?? 0}`)
          break
        case 'email':
          parts.push('email format')
          break
        case 'url':
          parts.push('URL format')
          break
        case 'regex':
          parts.push('pattern')
          break
      }
    }
    if (fieldDef.enumValues?.length) {
      parts.push(`one of: ${fieldDef.enumValues.join(', ')}`)
    }
    return parts.join(' &middot; ')
  }

  private sampleValueLiteral(fieldName: string, fieldDef: FieldDefinition): unknown {
    if (fieldDef.enumValues?.length) return fieldDef.enumValues[0]!

    const pgType = String(fieldDef.pgType)
    switch (pgType) {
      case 'uuid':
        return 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
      case 'boolean':
        return true
      case 'integer':
      case 'smallint':
      case 'serial':
      case 'smallserial':
        return 42
      case 'bigint':
      case 'bigserial':
        return 42
      case 'real':
      case 'double_precision':
      case 'decimal':
      case 'numeric':
      case 'money':
        return 9.99
      case 'json':
      case 'jsonb':
        return { key: 'value' }
      case 'varchar':
      case 'character_varying':
      case 'char':
      case 'character':
      case 'text':
      default: {
        const snake = toSnakeCase(fieldName)
        if (snake === 'email' || snake.endsWith('_email')) return 'user@example.com'
        if (
          snake === 'url' ||
          snake.endsWith('_url') ||
          snake === 'website' ||
          snake === 'homepage'
        )
          return 'https://example.com'
        const label = toPascalCase(fieldName)
          .replace(/([A-Z])/g, ' $1')
          .trim()
        return `Sample ${label}`
      }
    }
  }

  private archetypeBadgeColor(archetype: Archetype): string {
    switch (archetype) {
      case Archetype.Entity:
        return 'bg-sky-100 text-sky-700'
      case Archetype.Contribution:
        return 'bg-violet-100 text-violet-700'
      case Archetype.Reference:
        return 'bg-zinc-100 text-zinc-700'
      case Archetype.Attribute:
        return 'bg-teal-100 text-teal-700'
      case Archetype.Component:
        return 'bg-indigo-100 text-indigo-700'
      case Archetype.Event:
        return 'bg-amber-100 text-amber-700'
      case Archetype.Configuration:
        return 'bg-rose-100 text-rose-700'
      case Archetype.Association:
        return 'bg-zinc-100 text-zinc-700'
    }
  }

  private methodBadgeColor(method: string): string {
    switch (method) {
      case 'GET':
        return 'bg-emerald-500/10 text-emerald-600'
      case 'POST':
        return 'bg-sky-500/10 text-sky-600'
      case 'PUT':
      case 'PATCH':
        return 'bg-amber-500/10 text-amber-600'
      case 'DELETE':
        return 'bg-rose-500/10 text-rose-600'
      default:
        return 'bg-zinc-500/10 text-zinc-600'
    }
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }
}

function isCustomType(pgType: unknown): pgType is PostgreSQLCustomType {
  return typeof pgType === 'object' && pgType !== null && (pgType as any).type === 'custom'
}

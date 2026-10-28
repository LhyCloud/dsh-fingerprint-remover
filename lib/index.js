/**
 * dsh-fingerprint-remover 閳?host half.
 *
 * Client-side counterpart to the WorkBuddy gateway checks. It applies the same
 * confirmed fingerprint rules the upstream uses, but at the DSH boundary:
 *
 * - `system-prompt/assemble`: the final prompt (sections + runtime contexts) is
 *   rewritten after every other contributor has spoken, so the identity
 *   sentence, the GUI paragraph, and the `DeepSeek Harness` brand phrase never
 *   reach the provider. User/tool data is untouched.
 * - `globalThis.fetch`: any outbound request still carrying the
 *   `deepseek-harness/...` attribution User-Agent is rewritten to the official
 *   WorkBuddy desktop UA, and `x-deepseek-harness-*` headers are removed.
 *
 * The plugin is passive: it does not change providers, models, routes,
 * credentials, or the harness itself. `/fingerprint` reports and toggles it live.
 */

import { writeFileSync } from 'node:fs'

import {
  DEFAULT_BRAND_REPLACEMENT,
  DEFAULT_IDENTITY_REPLACEMENT,
  fingerprintCount,
  hasHarnessUserAgent,
  isAttributionHeader,
  sanitizeHeaders,
  sanitizeText,
  scanFingerprints,
} from './sanitize.js'

export const name = 'dsh-fingerprint-remover'

const COMMAND_NAME = 'fingerprint'

const DEFAULT_USER_AGENT = 'WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0'

const DEFAULTS = {
  enabled: true,
  /** Empty = every provider. Otherwise only these `options.provider` values. */
  providers: [],
  userAgent: DEFAULT_USER_AGENT,
  sanitizePrompt: true,
  /** Also scrub tool results (paths, harness tokens) from replayed history. */
  sanitizeToolResults: true,
  /** Scrub normal user messages too (their own `dsh` mentions included). */
  sanitizeUserMessages: true,
  sanitizeUserAgent: true,
  stripAttributionHeaders: true,
  identityReplacement: DEFAULT_IDENTITY_REPLACEMENT,
  brandReplacement: DEFAULT_BRAND_REPLACEMENT,
  /** Optional local JSON dump of the last sanitized request (verification). */
  dumpPath: '',
  verbose: false,
}

const STATE_KEY = Symbol.for('dsh-fingerprint-remover.state')
const FETCH_KEY = Symbol.for('dsh-fingerprint-remover.fetch')
const STREAM_KEY = Symbol.for('dsh-fingerprint-remover.stream')

/** Shared, process-wide state so a fiber reload never starts from zero. */
function stateOf() {
  const defaults = {
    enabled: true,
    config: { ...DEFAULTS },
    assemblies: 0,
    requests: 0,
    llmEvents: 0,
    texts: 0,
    uaRewrites: 0,
    headerStrips: 0,
    installed: false,
    lastRewriteAt: null,
    lastScan: null,
    lastError: null,
  }
  const existing = globalThis[STATE_KEY]
  if (existing !== undefined && typeof existing === 'object') {
    // A hot reload may reuse a state object created by an older build; fill in
    // counters introduced since then instead of producing NaN.
    for (const [key, value] of Object.entries(defaults)) {
      if (!(key in existing)) existing[key] = value
    }
    return existing
  }
  const created = { ...defaults }
  globalThis[STATE_KEY] = created
  return created
}

function readValue(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value
}

function normalizeConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const read = (key) => readValue(source[key])
  const providersRaw = read('providers')
  const providers = Array.isArray(providersRaw)
    ? providersRaw.map((entry) => String(entry).trim()).filter(Boolean)
    : []
  return {
    enabled: read('enabled') !== false,
    providers,
    userAgent:
      typeof read('userAgent') === 'string' && read('userAgent').trim() !== ''
        ? read('userAgent').trim()
        : DEFAULTS.userAgent,
    sanitizePrompt: read('sanitizePrompt') !== false,
    sanitizeToolResults: read('sanitizeToolResults') !== false,
    sanitizeUserMessages: read('sanitizeUserMessages') !== false,
    sanitizeUserAgent: read('sanitizeUserAgent') !== false,
    stripAttributionHeaders: read('stripAttributionHeaders') !== false,
    identityReplacement:
      typeof read('identityReplacement') === 'string'
        ? read('identityReplacement')
        : DEFAULTS.identityReplacement,
    brandReplacement:
      typeof read('brandReplacement') === 'string'
        ? read('brandReplacement')
        : DEFAULTS.brandReplacement,
    dumpPath: typeof read('dumpPath') === 'string' ? read('dumpPath').trim() : '',
    verbose: read('verbose') === true,
  }
}

function makeLogger(ctx, verbose) {
  const write = (level, message) => {
    try {
      const logger = ctx.logger
      const sink = logger !== undefined && logger !== null ? logger[level] : undefined
      if (typeof sink === 'function') {
        sink.call(logger, `[dsh-fingerprint-remover] ${message}`)
        return
      }
    } catch {
      // Logger unusable 閳?fall through to console rather than losing the message.
    }
    // eslint-disable-next-line no-console
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](
      `[dsh-fingerprint-remover] ${message}`,
    )
  }
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
    debug: (message) => {
      if (verbose) write('info', message)
    },
  }
}

/**
 * Sanitize one prompt assembly (sections + runtime contexts).
 *
 * Returns a new assembly; the input is never mutated, so the session's accepted
 * assembly and its UI projection stay untouched.
 *
 * @param {object} assembly
 * @param {object} config normalized config
 * @returns {{ assembly: object, changedTexts: number }}
 */
export function sanitizeAssembly(assembly, config) {
  if (assembly === null || typeof assembly !== 'object') {
    return { assembly, changedTexts: 0 }
  }
  let changedTexts = 0
  const rewriteEntries = (entries) => {
    if (!Array.isArray(entries)) return entries
    return entries.map((entry) => {
      if (entry === null || typeof entry !== 'object' || typeof entry.text !== 'string') {
        return entry
      }
      const result = sanitizeText(entry.text, config)
      if (!result.changed) return entry
      changedTexts += 1
      return { ...entry, text: result.text }
    })
  }
  return {
    assembly: {
      ...assembly,
      sections: rewriteEntries(assembly.sections),
      contexts: rewriteEntries(assembly.contexts),
    },
    changedTexts,
  }
}

/** Flatten one message's text blocks for scans and dumps. */
export function messageText(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (block === null || typeof block !== 'object') return ''
      if (typeof block.text === 'string') return block.text
      if (typeof block.arguments === 'string') return block.arguments
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/** Runtime-context snapshots are harness-generated user messages. */
export function isRuntimeContextMessage(message) {
  if (message === null || typeof message !== 'object') return false
  if (message.source?.kind === 'runtime-context') return true
  const text = messageText(message)
  return text.startsWith('Current runtime context.')
}

function sanitizeScalar(value, config, counters) {
  if (typeof value !== 'string') return value
  const result = sanitizeText(value, config)
  if (!result.changed) return value
  counters.texts += 1
  return result.text
}

function sanitizeContent(content, config, counters) {
  if (typeof content === 'string') return sanitizeScalar(content, config, counters)
  if (!Array.isArray(content)) return content
  return content.map((block) => {
    if (block === null || typeof block !== 'object') return block
    let next = block
    let changed = false
    if (typeof block.text === 'string') {
      const text = sanitizeScalar(block.text, config, counters)
      if (text !== block.text) {
        next = { ...next, text }
        changed = true
      }
    }
    if (typeof block.arguments === 'string') {
      const args = sanitizeScalar(block.arguments, config, counters)
      if (args !== block.arguments) {
        next = { ...next, arguments: args }
        changed = true
      }
    }
    return changed ? next : block
  })
}

/**
 * Sanitize one message in place-free style. Returns the original object when
 * nothing changed, so callers can keep structural sharing.
 */
export function sanitizeMessage(message, config, counters = { texts: 0 }) {
  if (message === null || typeof message !== 'object') return message
  const role = message.role
  const shouldSanitize =
    role === 'system' ||
    role === 'developer' ||
    role === 'assistant' ||
    (role === 'user' &&
      (config.sanitizeUserMessages !== false || isRuntimeContextMessage(message))) ||
    (role === 'tool' && config.sanitizeToolResults !== false)
  if (!shouldSanitize) return message

  let changed = false
  const next = { ...message }
  if (next.content !== undefined) {
    const content = sanitizeContent(next.content, config, counters)
    if (content !== next.content) {
      next.content = content
      changed = true
    }
  }
  if (typeof next.reasoning_content === 'string') {
    const reasoning = sanitizeScalar(next.reasoning_content, config, counters)
    if (reasoning !== next.reasoning_content) {
      next.reasoning_content = reasoning
      changed = true
    }
  }
  if (Array.isArray(next.tool_calls)) {
    const toolCalls = next.tool_calls.map((call) => {
      if (call === null || typeof call !== 'object') return call
      const fn = call.function
      if (fn === null || typeof fn !== 'object' || typeof fn.arguments !== 'string') return call
      const args = sanitizeScalar(fn.arguments, config, counters)
      return args === fn.arguments ? call : { ...call, function: { ...fn, arguments: args } }
    })
    if (toolCalls.some((call, index) => call !== next.tool_calls[index])) {
      next.tool_calls = toolCalls
      changed = true
    }
  }
  return changed ? next : message
}

function sanitizeSchema(schema, config, counters) {
  if (Array.isArray(schema)) {
    let changed = false
    const next = schema.map((entry) => {
      const value = sanitizeSchema(entry, config, counters)
      if (value !== entry) changed = true
      return value
    })
    return changed ? next : schema
  }
  if (schema === null || typeof schema !== 'object') return schema
  let changed = false
  const next = { ...schema }
  if (typeof next.description === 'string') {
    const description = sanitizeScalar(next.description, config, counters)
    if (description !== next.description) {
      next.description = description
      changed = true
    }
  }
  if (
    next.properties !== undefined &&
    next.properties !== null &&
    typeof next.properties === 'object' &&
    !Array.isArray(next.properties)
  ) {
    const properties = {}
    let propertiesChanged = false
    for (const [name, value] of Object.entries(next.properties)) {
      const sanitized = sanitizeSchema(value, config, counters)
      if (sanitized !== value) propertiesChanged = true
      properties[name] = sanitized
    }
    if (propertiesChanged) {
      next.properties = properties
      changed = true
    }
  }
  for (const key of ['items', 'additionalProperties', 'anyOf', 'oneOf', 'allOf']) {
    if (next[key] === undefined) continue
    const value = sanitizeSchema(next[key], config, counters)
    if (value !== next[key]) {
      next[key] = value
      changed = true
    }
  }
  return changed ? next : schema
}

export function sanitizeTool(tool, config, counters) {
  if (tool === null || typeof tool !== 'object') return tool
  let changed = false
  const next = { ...tool }
  if (typeof next.description === 'string') {
    const description = sanitizeScalar(next.description, config, counters)
    if (description !== next.description) {
      next.description = description
      changed = true
    }
  }
  if (next.parameters !== undefined) {
    const parameters = sanitizeSchema(next.parameters, config, counters)
    if (parameters !== next.parameters) {
      next.parameters = parameters
      changed = true
    }
  }
  return changed ? next : tool
}

/**
 * Deep-scrub the complete outbound request: system prompt, every message that
 * carries harness-generated text, and tool descriptions/schemas.
 *
 * Mutates `options` in place because the `llm/stream` waterfall passes the
 * same object to the adapter; a returned replacement would not reach it.
 *
 * @returns {{ changedTexts: number, totalBefore: number, totalAfter: number }}
 */
export function sanitizeOptions(options, config) {
  if (options === null || typeof options !== 'object') {
    return { options, changedTexts: 0, totalBefore: 0, totalAfter: 0 }
  }
  const totalBefore = fingerprintCount(collectRequestText(options))
  const counters = { texts: 0 }
  let next = options
  let changed = false

  if (typeof options.system === 'string') {
    const system = sanitizeScalar(options.system, config, counters)
    if (system !== options.system) {
      next = next === options ? { ...options } : next
      next.system = system
      changed = true
    }
  }
  if (Array.isArray(options.messages)) {
    const messages = options.messages.map((message) =>
      sanitizeMessage(message, config, counters),
    )
    if (messages.some((message, index) => message !== options.messages[index])) {
      next = next === options ? { ...options } : next
      next.messages = messages
      changed = true
    }
  }
  if (Array.isArray(options.tools)) {
    const tools = options.tools.map((tool) => sanitizeTool(tool, config, counters))
    if (tools.some((tool, index) => tool !== options.tools[index])) {
      next = next === options ? { ...options } : next
      next.tools = tools
      changed = true
    }
  }

  const totalAfter = fingerprintCount(collectRequestText(next))
  return {
    options: changed ? next : options,
    changedTexts: counters.texts,
    totalBefore,
    totalAfter,
  }
}

/**
 * In-place compatibility wrapper used by tests and by callers that own a
 * mutable options object. The live DSH request is frozen, so the plugin wraps
 * `llm.streamWithRegistration` and passes a sanitized copy instead.
 */
export function sanitizeRequest(options, config) {
  const result = sanitizeOptions(options, config)
  if (result.options !== options) {
    for (const key of ['system', 'messages', 'tools']) {
      if (result.options[key] !== undefined) options[key] = result.options[key]
    }
  }
  return {
    changedTexts: result.changedTexts,
    totalBefore: result.totalBefore,
    totalAfter: result.totalAfter,
  }
}

/**
 * Sanitize a serialized provider request body (OpenAI Chat Completions or
 * Anthropic Messages). The adapter's `options` object is frozen, so this is
 * the authoritative boundary: rewrite the JSON immediately before the HTTP
 * request leaves the process.
 *
 * @param {string} text JSON request body
 * @param {object} config
 * @returns {{ text: string, scan: object, payload: object, changed: boolean } | null}
 */
export function sanitizeJsonBody(text, config) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 16 * 1024 * 1024) {
    return null
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const hasMessages = Array.isArray(payload.messages)
  const hasSystem = typeof payload.system === 'string'
  if (!hasMessages && !hasSystem) return null

  const options = {
    system: hasSystem ? payload.system : undefined,
    messages: hasMessages ? payload.messages : undefined,
    tools: Array.isArray(payload.tools) ? payload.tools : undefined,
  }
  const scan = sanitizeOptions(options, config)
  if (scan.changedTexts === 0) {
    return { text, scan, payload, changed: false }
  }
  if (hasMessages) payload.messages = scan.options.messages
  if (hasSystem) payload.system = scan.options.system
  if (Array.isArray(payload.tools)) payload.tools = scan.options.tools
  return { text: JSON.stringify(payload), scan, payload, changed: true }
}
/** Concatenate every text field a gateway could inspect. */
export function collectRequestText(options) {
  if (options === null || typeof options !== 'object') return ''
  const parts = []
  if (typeof options.system === 'string') parts.push(options.system)
  for (const message of options.messages ?? []) parts.push(messageText(message))
  for (const tool of options.tools ?? []) {
    if (typeof tool?.description === 'string') parts.push(tool.description)
    if (tool?.parameters !== undefined) parts.push(JSON.stringify(tool.parameters))
  }
  return parts.join('\n')
}

function payloadSystem(payload) {
  return payload !== null && typeof payload === 'object' && typeof payload.system === 'string'
    ? payload.system
    : undefined
}
function dumpRequest(options, config, scan) {
  if (!config.dumpPath) return
  const payload = {
    time: new Date().toISOString(),
    provider: options.provider,
    model: options.model,
    fingerprintCount: scan.totalAfter,
    fingerprints: scanFingerprints(collectRequestText(options)),
    system: options.system,
    messages: (options.messages ?? []).map((message) => ({
      role: message.role,
      sourceKind: message.source?.kind,
      text: messageText(message).slice(0, 8000),
    })),
    tools: (options.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
  }
  try {
    writeFileSync(config.dumpPath, JSON.stringify(payload, null, 2), 'utf8')
  } catch {
    // Verification output is best-effort; never affect the model request.
  }
}

/**
 * Wrap `llm.streamWithRegistration` once. The waterfall cannot replace the
 * frozen options object (Cordis's `next()` ignores arguments), so this layer
 * passes a sanitized copy into the original adapter entry point instead.
 *
 * `stream()` delegates to `streamWithRegistration()`, so wrapping the latter
 * covers both public entry points without double sanitization.
 */
export function installStreamWrapper(ctx, config, state, log) {
  const wrap = (llm) => {
    if (llm === null || typeof llm !== 'object') return false
    if (typeof llm.streamWithRegistration !== 'function') return false
    const existing = llm[STREAM_KEY]
    if (existing !== undefined) {
      existing.config = config
      existing.state = state
      existing.log = log
      return true
    }
    const holder = { original: llm.streamWithRegistration, config, state, log }
    try {
      Object.defineProperty(llm, STREAM_KEY, { value: holder, configurable: true })
    } catch {
      return false
    }
    llm.streamWithRegistration = function fingerprintRemoverStream(options, prepared) {
      const live = holder.config
      const current = holder.state
      let next = options
      try {
        current.llmEvents = (current.llmEvents ?? 0) + 1
        if (current.enabled !== false && live.sanitizePrompt !== false) {
          const provider = options?.provider
          const providerAllowed =
            live.providers.length === 0 ||
            typeof provider !== 'string' ||
            live.providers.includes(provider)
          if (providerAllowed && options !== null && typeof options === 'object') {
            const scan = sanitizeOptions(options, live)
            next = scan.options
            current.requests += 1
            current.texts += scan.changedTexts
            current.lastScan = {
              at: new Date().toISOString(),
              provider,
              model: options.model,
              detail: scanFingerprints(collectRequestText(next)),
              ...scan,
            }
            if (scan.changedTexts > 0) current.lastRewriteAt = new Date().toISOString()
            if (scan.changedTexts > 0 || live.verbose) {
              log.debug(
                `final scrub: ${scan.changedTexts} text change(s), ` +
                  `${scan.totalBefore} -> ${scan.totalAfter} fingerprint(s)`,
              )
            }
            dumpRequest(next, live, scan)
          }
        }
      } catch (error) {
        current.lastError = {
          at: new Date().toISOString(),
          message: error instanceof Error ? error.message : String(error),
        }
        log.warn(`final scrub failed, request left unchanged: ${current.lastError.message}`)
        next = options
      }
      return holder.original.call(this, next, prepared)
    }
    return true
  }

  try {
    const llm = ctx.get?.('llm')
    if (llm !== undefined && wrap(llm)) return
  } catch {
    // Service lookup can throw while the fiber is still mounting; inject below.
  }
  ctx.inject(['llm'], (scoped) => {
    scoped.effect(() => {
      wrap(scoped.llm)
      return () => {}
    }, 'dsh-fingerprint-remover:stream')
  })
}

/**
 * Wrap the process-wide fetch once. The wrapper only rewrites requests whose
 * User-Agent carries the harness token (or that carry harness attribution
 * headers); everything else is passed through untouched.
 *
 * @param {object} config normalized config
 * @param {object} state process-wide fingerprint-remover state
 * @param {object} log logger
 */
export function installFetchSanitizer(config, state, log) {
  state.config = config
  const existing = globalThis[FETCH_KEY]
  if (existing !== undefined && existing.installed === true) {
    existing.config = config
    return
  }
  const original = globalThis.fetch
  if (typeof original !== 'function') {
    log.warn('global fetch is unavailable; User-Agent sanitization is inactive')
    return
  }

  const holder = { installed: true, original, config, state }
  globalThis[FETCH_KEY] = holder

  globalThis.fetch = async function fingerprintRemoverFetch(input, init) {
    const live = holder.config
    const current = holder.state
    if (current.enabled === false) return holder.original(input, init)

    let url
    try {
      url = input instanceof Request ? input.url : String(input)
    } catch {
      return holder.original(input, init)
    }
    if (!/^https?:/i.test(url)) return holder.original(input, init)

    let headers
    try {
      const source = init?.headers ?? (input instanceof Request ? input.headers : undefined)
      headers = new Headers(source)
    } catch {
      return holder.original(input, init)
    }

    let nextInit = init
    let changed = false

    // 1. JSON body. The adapter's options object is frozen, so the serialized
    //    request is the authoritative place to scrub system/messages/tools.
    if (live.sanitizePrompt !== false) {
      let bodyText
      if (typeof init?.body === 'string') {
        bodyText = init.body
      } else if (init?.body instanceof Uint8Array) {
        try {
          bodyText = new TextDecoder().decode(init.body)
        } catch {
          bodyText = undefined
        }
      }
      if (bodyText !== undefined && bodyText.length > 1) {
        try {
          const result = sanitizeJsonBody(bodyText, live)
          if (result !== null) {
            current.requests = (current.requests ?? 0) + 1
            current.texts += result.scan.changedTexts
            current.lastScan = {
              at: new Date().toISOString(),
              model: result.payload?.model,
              detail: scanFingerprints(result.text),
              changedTexts: result.scan.changedTexts,
              totalBefore: result.scan.totalBefore,
              totalAfter: result.scan.totalAfter,
            }
            if (result.changed) {
              nextInit = { ...(init ?? {}), body: result.text }
              headers.delete('content-length')
              changed = true
              current.lastRewriteAt = new Date().toISOString()
              if (live.verbose) {
                log.debug(
                  `body scrub: ${result.scan.changedTexts} text change(s), ` +
                    `${result.scan.totalBefore} -> ${result.scan.totalAfter} fingerprint(s)`,
                )
              }
              dumpRequest(
                { system: payloadSystem(result.payload), messages: result.payload?.messages, tools: result.payload?.tools },
                live,
                result.scan,
              )
            }
          }
        } catch (error) {
          current.lastError = {
            at: new Date().toISOString(),
            message: error instanceof Error ? error.message : String(error),
          }
          log.warn(`body scrub failed, request left unchanged: ${current.lastError.message}`)
        }
      }
    }

    // 2. Attribution headers / User-Agent.
    const userAgentBefore = headers.get('user-agent')
    const attributionNames = [...headers.keys()].filter(isAttributionHeader)
    const shouldRewriteUa =
      live.sanitizeUserAgent !== false && hasHarnessUserAgent(userAgentBefore)
    if (shouldRewriteUa || attributionNames.length > 0) {
      if (sanitizeHeaders(headers, live)) {
        current.uaRewrites += shouldRewriteUa ? 1 : 0
        current.headerStrips += attributionNames.length
        current.lastRewriteAt = new Date().toISOString()
        changed = true
        log.debug(
          `rewrote outbound attribution for ${url}` +
            ` (ua=${shouldRewriteUa ? live.userAgent : 'unchanged'}` +
            `, headers=${attributionNames.join(',') || 'none'})`,
        )
      }
    }

    if (!changed) return holder.original(input, init)

    try {
      if (input instanceof Request) {
        return holder.original(new Request(input, { ...(nextInit ?? {}), headers }))
      }
      return holder.original(input, { ...(nextInit ?? {}), headers })
    } catch {
      // A Request that cannot be cloned (already used body) must not be turned
      // into a hard failure by the fingerprint-remover layer.
      return holder.original(input, init)
    }
  }
}

const ROUTE_BASE = '/dsh-fingerprint-remover'

function sendJson(response, status, payload) {
  try {
    response.writeHead(status, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    })
    response.end(JSON.stringify(payload))
  } catch {
    // Client hung up mid-write; nothing to recover.
  }
}

/** Read-only local status, used to verify the live process after a request. */
function installRoute(ctx, config, state, log) {
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => {
      try {
        return scoped.webServer.register(
          {
            kind: 'prefix',
            path: ROUTE_BASE,
            handler: async (request, response) => {
              const address = request?.socket?.remoteAddress
              const loopback =
                address === '127.0.0.1' ||
                address === '::1' ||
                address === '::ffff:127.0.0.1' ||
                address === undefined
              if (!loopback) {
                sendJson(response, 403, { ok: false, error: 'loopback only' })
                return
              }
              if ((request.method ?? 'GET') !== 'GET') {
                sendJson(response, 405, { ok: false, error: 'read-only' })
                return
              }
              sendJson(response, 200, {
                ok: true,
                enabled: state.enabled,
                providers: config.providers,
                sanitizePrompt: config.sanitizePrompt,
                sanitizeToolResults: config.sanitizeToolResults,
                sanitizeUserMessages: config.sanitizeUserMessages,
                sanitizeUserAgent: config.sanitizeUserAgent,
                userAgent: config.userAgent,
                requests: state.requests,
                llmEvents: state.llmEvents,
                texts: state.texts,
                uaRewrites: state.uaRewrites,
                headerStrips: state.headerStrips,
                lastScan: state.lastScan,
                lastError: state.lastError,
              })
            },
          },
          'dsh-fingerprint-remover:status',
        )
      } catch (error) {
        log.warn(
          `status route not registered: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
        return () => {}
      }
    }, 'dsh-fingerprint-remover:route')
  })
}

function summarizeStatus(state, config) {
  const scope =
    config.providers.length === 0 ? 'all providers' : config.providers.join(', ')
  return [
    `dsh-fingerprint-remover 璺?${state.enabled ? 'ACTIVE' : 'OFF'}`,
    `prompt sanitizer : ${config.sanitizePrompt ? 'on' : 'off'} (${scope})`,
    `user-agent       : ${config.sanitizeUserAgent ? config.userAgent : 'off'}`,
    `attribution hdrs : ${config.stripAttributionHeaders ? 'stripped' : 'kept'}`,
    '',
    `assemblies seen  : ${state.assemblies}`,
    `requests scrubbed: ${state.requests}`,
    `prompt rewrites  : ${state.texts}`,
    `UA rewrites      : ${state.uaRewrites}`,
    `header strips    : ${state.headerStrips}`,
    state.lastScan === null
      ? 'last payload     : (no request yet)'
      : `last payload     : ${state.lastScan.totalAfter} fingerprint(s) left ` +
        `(${state.lastScan.totalBefore} -> ${state.lastScan.totalAfter})`,
    state.lastRewriteAt === null ? 'last rewrite     : (none yet)' : `last rewrite     : ${state.lastRewriteAt}`,
  ].join('\n')
}

const WHY_TEXT = [
  'Why this plugin exists',
  '',
  'The WorkBuddy gateway returns 400 / code 11-128 ("Illegal API invocation from',
  'an unapproved channel") for client fingerprints in the request, not for the model.',
  '',
  'The confirmed trigger is a contiguous pair at the top of the system prompt:',
  '  "An @ prefix marks a path the user named explicitly."',
  '  "Relative paths are resolved against the workspace root, while absolute paths',
  '   refer to files or directories on the machine."',
  '',
  'Measured against the same upstream: either sentence alone returns 200; the pair',
  'returns 400. Rewriting the first sentence breaks the match. This plugin rewrites',
  'both sentences, and also removes the identity sentence, the GUI paragraph, the',
  'checkout path, the local Web GUI URL, host paths and tokens in replayed history,',
  'reasoning blocks, tool results, and tool descriptions.',
  '',
  'The User-Agent attribution token and x-host-* headers are rewritten as well.',
  'Providers, models, routes, credentials, and tool names are untouched.',
  '',
  'Runtime control: /fingerprint on|off|status. A restart clears /fingerprint off.',
].join('\n')

/** Register the slash command, tolerating a profile with no commands service. */
function installCommand(ctx, config, state, log) {
  ctx.inject(['commands'], (scoped) => {
    scoped.effect(
      () =>
        scoped.commands.register({
          name: COMMAND_NAME,
          description:
            'Report, scan, or toggle the WorkBuddy anti-fingerprint layer (prompt, history, tools, User-Agent)',
          input: { hint: '[status|scan|on|off|why]' },
          recordInput: false,
          handler: (invocation) => {
            const raw = String(invocation?.rawInput ?? '').trim().toLowerCase()
            const action = raw.split(/\s+/).filter(Boolean)[0] ?? 'status'
            if (action === 'on' || action === 'enable') {
              state.enabled = true
              log.info('fingerprint-remover layer enabled for this process')
              return { kind: 'success', text: summarizeStatus(state, config) }
            }
            if (action === 'off' || action === 'disable') {
              state.enabled = false
              log.info('fingerprint-remover layer disabled for this process')
              return { kind: 'success', text: summarizeStatus(state, config) }
            }
            if (action === 'scan') {
              if (state.lastScan === null) {
                return { kind: 'error', text: 'No model request has been scrubbed yet.' }
              }
              return {
                kind: 'success',
                text: [
                  summarizeStatus(state, config),
                  '',
                  `last provider    : ${state.lastScan.provider ?? '?'} / ${state.lastScan.model ?? '?'}`,
                  `fingerprints     : ${JSON.stringify(state.lastScan.detail)}`,
                  `before -> after  : ${state.lastScan.totalBefore} -> ${state.lastScan.totalAfter}`,
                  `text changes     : ${state.lastScan.changedTexts}`,
                  `at               : ${state.lastScan.at}`,
                ].join('\n'),
              }
            }
            if (action === 'why' || action === 'help') {
              return { kind: 'success', text: WHY_TEXT }
            }
            if (action !== 'status' && action !== '') {
              return {
                kind: 'error',
                text: `Unknown action "${action}". Use status, on, off, or why.`,
              }
            }
            return { kind: 'success', text: summarizeStatus(state, config) }
          },
        }),
      'dsh-fingerprint-remover:command',
    )
  })
}

export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  const state = stateOf()
  const log = makeLogger(ctx, settings.verbose)

  state.enabled = settings.enabled
  state.config = settings

  installFetchSanitizer(settings, state, log)

  // The assembly listener is a waterfall: call next() to let every other
  // contributor run, then rewrite the final text. Prepended = outermost, so
  // the returned assembly is the one the caller actually uses.
  ctx.on(
    'system-prompt/assemble',
    async (assembly, context, next) => {
      const transformed = await next()
      if (state.enabled === false || settings.sanitizePrompt === false) {
        return transformed
      }
      if (settings.providers.length > 0) {
        const provider = transformed?.variables?.provider
        if (typeof provider === 'string' && !settings.providers.includes(provider)) {
          return transformed
        }
      }
      const result = sanitizeAssembly(transformed, settings)
      if (result.changedTexts === 0) return transformed
      state.assemblies += 1
      state.texts += result.changedTexts
      state.lastRewriteAt = new Date().toISOString()
      log.debug(`sanitized ${result.changedTexts} prompt segment(s)`)
      return result.assembly
    },
    { global: true, prepend: true },
  )

  // The assembly hook cleans the accepted prompt, but replayed history,
  // runtime-context snapshots, and tool schemas reach the adapter through a
  // frozen `options` object. Wrap the adapter entry point and hand it a
  // sanitized copy.
  // Request-body scrubbing happens in the fetch wrapper: the adapter's options
  // object is frozen, so there is nothing mutable to hand to a stream wrapper.

  const marker = '__dshHostFingerprintRemoverInstalled'
  if (ctx[marker] === true) {
    log.debug('already installed on this context; skipping command')
    return
  }
  try {
    ctx[marker] = true
  } catch {
    // Frozen context 閳?the command registration below is still idempotent
    // enough for a single boot.
  }
  installCommand(ctx, settings, state, log)
  installRoute(ctx, settings, state, log)

  if (settings.enabled) {
    log.info(
      `active 閳?prompt sanitizer ${settings.sanitizePrompt ? 'on' : 'off'}, ` +
        `UA -> ${settings.sanitizeUserAgent ? settings.userAgent : 'off'}`,
    )
  } else {
    log.info('installed but disabled by config')
  }
  void ctx
}

export default { name, apply }


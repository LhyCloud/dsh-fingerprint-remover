import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_IDENTITY_REPLACEMENT,
  hasHarnessUserAgent,
  sanitizeHeaders,
  sanitizeText,
  scanFingerprints,
} from '../lib/sanitize.js'
import {
  apply,
  name as pluginName,
  sanitizeAssembly,
  sanitizeJsonBody,
  sanitizeRequest,
} from '../lib/index.js'

test('plugin identity matches the published package', () => {
  assert.equal(pluginName, 'dsh-fingerprint-remover')
})

const CONFIG = {
  identityReplacement: DEFAULT_IDENTITY_REPLACEMENT,
  brandReplacement: 'DeepSeek',
}

function makeCtx() {
  const listeners = []
  const commands = []
  const streamed = []
  const llm = {
    streamWithRegistration(options) {
      streamed.push(options)
      return 'stream'
    },
  }
  return {
    listeners,
    commands,
    streamed,
    llm,
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      return name === 'llm' ? llm : undefined
    },
    on(event, handler, options) {
      listeners.push({ event, handler, options })
    },
    inject(_names, callback) {
      callback({
        effect(fn) {
          fn()
          return () => {}
        },
        commands: {
          register(spec) {
            commands.push(spec)
            return () => {}
          },
        },
      })
    },
  }
}

test('identity sentence is removed without disturbing the rest', () => {
  const input = 'You are an AI agent powered by DeepSeek Harness.\n\nBe concise.'
  const result = sanitizeText(input, CONFIG)
  assert.equal(result.changed, true)
  assert.equal(result.text, 'Be concise.')
  assert.doesNotMatch(result.text, /DeepSeek Harness/i)
})

test('identity matching is case-insensitive and verb-flexible', () => {
  for (const sentence of [
    'You are a coding agent powered by the deepseek-v4.1-flash model.',
    'You are an AI assistant built on DeepSeek.',
    'You are an assistant, created by Acme.',
  ]) {
    const result = sanitizeText(sentence, CONFIG)
    assert.equal(result.text, DEFAULT_IDENTITY_REPLACEMENT, sentence)
    assert.equal(result.text, '')
  }
})

test('GUI paragraph pair is reworded without losing the sentence', () => {
  const input =
    'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.'
  const result = sanitizeText(input, CONFIG)
  assert.equal(
    result.text,
    'You are interacting with the user through the DeepSeek Web GUI whose URL is named in the runtime context.',
  )
})

test('brand, identifiers, and product paths are all deep-scrubbed', () => {
  const input =
    'This is the DeepSeek Harness implementation checkout at D:\\Program Files\\Deepseek Harness\\resources\\app.asar\\dsh\\. ' +
    'The package is deepseek-harness and the module is @deepseek-ai/dsh. ' +
    'The DeepSeek Harness Web GUI is local.'
  const result = sanitizeText(input, CONFIG)
  assert.ok(result.text.includes('This is the DeepSeek implementation checkout'))
  assert.ok(result.text.includes('<host-install>'))
  assert.ok(!result.text.includes('Deepseek Harness'))
  assert.ok(!result.text.includes('app.asar'))
  assert.ok(!result.text.includes('deepseek-harness'))
  assert.ok(!result.text.includes('@deepseek-ai/dsh'))
  assert.ok(result.text.includes('The DeepSeek Web GUI'))
  assert.equal(
    Object.values(scanFingerprints(result.text)).reduce((a, b) => a + b, 0),
    0,
  )
})

test('user-like prose without an attribution verb is untouched', () => {
  const input = 'You are free to use tools built by the plugin.'
  assert.equal(sanitizeText(input, CONFIG).changed, false)
})

test('billing header and cc_ key-value fingerprints are removed', () => {
  const input =
    'hello x-anthropic-billing-header: abc123; cc_entrypoint=cli; world'
  const result = sanitizeText(input, CONFIG)
  assert.equal(result.changed, true)
  assert.ok(!result.text.includes('x-anthropic-billing-header'))
  assert.ok(!result.text.includes('cc_entrypoint='))
})

test('sanitizeAssembly rewrites sections and contexts without mutating input', () => {
  const input = {
    sections: [{ name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' }],
    contexts: [{ name: 'dsh', text: 'Current DeepSeek Harness Web GUI URL: http://127.0.0.1:1' }],
    variables: { provider: 'workbuddy' },
    tools: [],
  }
  const { assembly, changedTexts } = sanitizeAssembly(input, CONFIG)
  assert.equal(changedTexts, 2)
  assert.equal(assembly.sections[0].text, '')
  assert.equal(assembly.contexts[0].text, '')
  // Original remains the unmodified accepted assembly.
  assert.equal(input.sections[0].text, 'You are an AI agent powered by DeepSeek Harness.')
})

test('runtime-context snapshot loses checkout, GUI URL, DSH and .dsh paths', () => {
  const input = [
    'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
    '',
    'Current working directory: "D:\\\\DSH".',
    '',
    'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications.',
    '',
    'Current DeepSeek Harness implementation checkout: "D:\\\\Program Files (x86)\\\\Deepseek Harness\\\\resources\\\\app.asar\\\\dsh\\\\".',
    '',
    'Current DeepSeek Harness Web GUI URL: "http://127.0.0.1:50106".',
  ].join('\n')
  const result = sanitizeText(input, {})
  assert.equal(
    Object.values(scanFingerprints(result.text)).reduce((a, b) => a + b, 0),
    0,
  )
  assert.ok(!result.text.includes('implementation checkout'))
  assert.ok(!result.text.includes('Web GUI URL'))
  assert.ok(!result.text.includes('app.asar'))
  assert.ok(result.text.includes('Current file policy'))
  assert.ok(result.text.includes('The file sandbox'))
  assert.ok(result.text.includes('<workspace>'))
})

test('sanitizeRequest cleans system, runtime context, tool text, and tool results', () => {
  const options = {
    provider: 'workbuddy',
    model: 'hy4-preview-f',
    system: 'You are an AI agent powered by DeepSeek Harness.\n\nNever infer the checkout path. Use this checkout only to inspect or extend DSH itself.',
    messages: [
      {
        role: 'user',
        source: { kind: 'runtime-context' },
        content: [
          {
            type: 'text',
            text: 'Current runtime context.\n\nCurrent DSH file policy: danger-full-access.\n\nCurrent DeepSeek Harness Web GUI URL: "http://127.0.0.1:50106".',
          },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'please keep my DSH note intact' }] },
      { role: 'tool', content: [{ type: 'text', text: 'cwd is D:\\DSH and binary is dsh.cmd' }] },
    ],
    tools: [
      {
        name: 'pwsh',
        description: 'Managed `$env:DSH_*` variables expose current harness environment facts.',
        parameters: {
          type: 'object',
          properties: { workdir: { type: 'string', description: 'Defaults to the DSH workspace.' } },
        },
      },
    ],
  }
  const scan = sanitizeRequest(options, { ...CONFIG, sanitizeUserMessages: false })
  const all = [
    options.system,
    // The runtime-context snapshot and the tool result are harness-generated;
    // messages[1] is a normal user message and is deliberately not scrubbed.
    options.messages[0].content[0].text,
    options.messages[2].content[0].text,
    options.tools[0].description,
    JSON.stringify(options.tools[0].parameters),
  ].join('\n')
  assert.ok(scan.changedTexts >= 4)
  assert.equal(
    Object.values(scanFingerprints(all)).reduce((a, b) => a + b, 0),
    0,
  )
  // Normal user messages are user data and must survive verbatim.
  assert.equal(options.messages[1].content[0].text, 'please keep my DSH note intact')
  // Tool results are harness-generated history and are scrubbed by default.
  assert.ok(!options.messages[2].content[0].text.includes('D:\\DSH'))
  assert.ok(!options.tools[0].description.includes('DSH_'))
  assert.ok(!options.tools[0].parameters.properties.workdir.description.includes('DSH'))
})

test('normal user messages are scrubbed by default and preserved when disabled', () => {
  const make = () => ({
    provider: 'workbuddy',
    system: '',
    messages: [{ role: 'user', content: 'my dsh note' }],
    tools: [],
  })
  const scrubbed = make()
  sanitizeRequest(scrubbed, CONFIG)
  assert.equal(scrubbed.messages[0].content, 'my host note')

  const preserved = make()
  sanitizeRequest(preserved, { ...CONFIG, sanitizeUserMessages: false })
  assert.equal(preserved.messages[0].content, 'my dsh note')
})

test('hasHarnessUserAgent is case-insensitive and token-bounded', () => {
  assert.equal(hasHarnessUserAgent('deepseek-harness/0.2.1-rc.3 (+https://x)'), true)
  assert.equal(hasHarnessUserAgent('DeepSeek Harness/0.2.1'), true)
  assert.equal(hasHarnessUserAgent('WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0'), false)
  assert.equal(hasHarnessUserAgent(undefined), false)
})

test('sanitizeHeaders rewrites UA and drops attribution headers', () => {
  const headers = new Headers({
    'user-agent': 'deepseek-harness/0.2.1-rc.3',
    'x-deepseek-harness-user-id': 'u1',
    'content-type': 'application/json',
  })
  const changed = sanitizeHeaders(headers, {
    userAgent: 'WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0',
    sanitizeUserAgent: true,
    stripAttributionHeaders: true,
  })
  assert.equal(changed, true)
  assert.equal(headers.get('user-agent'), 'WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0')
  assert.equal(headers.get('x-deepseek-harness-user-id'), null)
  assert.equal(headers.get('content-type'), 'application/json')
})

test('apply registers the advice command and the assembly waterfall', () => {
  const originalFetch = globalThis.fetch
  try {
    const ctx = makeCtx()
    apply(ctx, { verbose: false })
    assert.ok(ctx.commands.some((command) => command.name === 'fingerprint'))
    const listener = ctx.listeners.find((entry) => entry.event === 'system-prompt/assemble')
    assert.ok(listener)
    assert.equal(listener.options.prepend, true)
    assert.equal(listener.options.global, true)

    // The serialized body is the mutable boundary used by the fetch wrapper.
    const body = JSON.stringify({
      model: 'hy4-preview-f',
      messages: [{ role: 'system', content: 'Use this checkout only to inspect or extend the DSH itself.' }],
      tools: [],
    })
    const result = sanitizeJsonBody(body, {})
    assert.ok(result)
    assert.equal(result.changed, true)
    assert.doesNotMatch(result.text, /DSH/)
  } finally {
    globalThis.fetch = originalFetch
    delete globalThis[Symbol.for('dsh-fingerprint-remover.fetch')]
    delete globalThis[Symbol.for('dsh-fingerprint-remover.state')]
  }
})

test('installed fetch rewrites harness attribution and passes other traffic through', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    calls.push({ url: String(input instanceof Request ? input.url : input), headers })
    return new Response('ok', { status: 200 })
  }
  try {
    const ctx = makeCtx()
    apply(ctx, { verbose: false })
    await globalThis.fetch('http://127.0.0.1:8788/v1/chat/completions', {
      method: 'POST',
      headers: {
        'user-agent': 'deepseek-harness/0.2.1-rc.3 (+https://github.com/deepseek-ai/deepseek-harness)',
        'x-deepseek-harness-user-id': 'u1',
        'content-type': 'application/json',
      },
      body: '{}',
    })
    assert.equal(calls[0].headers.get('user-agent'), 'WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0')
    assert.equal(calls[0].headers.get('x-deepseek-harness-user-id'), null)

    await globalThis.fetch('http://127.0.0.1:8788/v1/chat/completions', {
      headers: { 'user-agent': 'curl/8.5.0' },
    })
    assert.equal(calls[1].headers.get('user-agent'), 'curl/8.5.0')

    // `/fingerprint off` must stop UA rewrites without reinstalling the wrapper.
    const command = ctx.commands.find((entry) => entry.name === 'fingerprint')
    command.handler({ rawInput: 'off' })
    await globalThis.fetch('http://127.0.0.1:8788/v1/chat/completions', {
      headers: { 'user-agent': 'deepseek-harness/0.2.1-rc.3' },
    })
    assert.equal(calls[2].headers.get('user-agent'), 'deepseek-harness/0.2.1-rc.3')
    command.handler({ rawInput: 'on' })
    await globalThis.fetch('http://127.0.0.1:8788/v1/chat/completions', {
      headers: { 'user-agent': 'deepseek-harness/0.2.1-rc.3' },
    })
    assert.equal(calls[3].headers.get('user-agent'), 'WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0')
  } finally {
    globalThis.fetch = originalFetch
    delete globalThis[Symbol.for('dsh-fingerprint-remover.fetch')]
    delete globalThis[Symbol.for('dsh-fingerprint-remover.state')]
  }
})

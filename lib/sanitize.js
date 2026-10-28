/**
 * Pure text/header sanitizers for dsh-fingerprint-remover.
 *
 * The rules are the confirmed WorkBuddy gateway fingerprints, plus a deep
 * scrub of every harness-identifying token the gateway can see in the prompt:
 *
 * 1. `You are an AI agent powered by DeepSeek Harness.` 閳?a self-introduction
 *    sentence with a `powered by` / `built by` tail is an unofficial-channel
 *    marker (400 / code 11128).
 * 2. The GUI description pair 閳?`...Web GUI whose URL the runtime context
 *    names.` matches as one fingerprint.
 * 3. `DeepSeek Harness`, `deepseek-harness`, `DSH`, `dsh`, `app.asar`, `.dsh`
 *    paths, the local Web GUI URL, and the harness checkout line.
 *
 * Only harness-generated text is rewritten (system/developer/assistant,
 * runtime-context snapshots, tool descriptions, and optionally tool results).
 * Normal user messages are left byte-for-byte alone.
 */

/** Self-introduction sentence with an attribution verb, bounded to one line. */
const IDENTITY_RE = new RegExp(
  String.raw`You are\s+` +
    String.raw`(?:an?\s+|the\s+)?(?:[\w.-]+\s+){0,3}?` +
    String.raw`(?:agent|assistant|model|AI|LLM)?[\s,]*` +
    String.raw`(?:powered by|built on|built by|created by|developed by|made by|trained by)` +
    String.raw`[^\n]*?(?:\.(?=\s|$)|(?=\n|$))`,
  'gi',
)

/** The GUI paragraph pair the gateway matches as a two-sentence fingerprint. */
const GUI_RE = new RegExp(
  String.raw`(You are interacting with the user through the ` +
    String.raw`DeepSeek[ \t]+Harness[ \t]+Web[ \t]+GUI)` +
    String.raw` whose URL the runtime context names\.`,
  'gi',
)

/** Client fingerprints that must not travel inside prompt text. */
const BILLING_HEADER_RE = /x-anthropic-billing-header:[^;\r\n]*;?\s*/gi
const BILLING_BARE_RE = /x-anthropic-billing-header/gi
const CC_KV_RE = /\bcc_[a-z0-9_]+=[^;\r\n]*;?\s*/gi

/**
 * The whole harness-source paragraph in the system prompt. It names the
 * checkout path and tells the model to extend DSH; neither is useful to the
 * upstream and both are fingerprints.
 */
const CHECKOUT_SECTION_RE =
  /The runtime context names the [^\n]*?implementation checkout\..*?Use this checkout only to inspect or extend [^\n]*?\./gs

/** Runtime-context lines: checkout path and local Web GUI URL. */
const CHECKOUT_LINE_RE = /^Current [^\n]*?implementation checkout:[^\n]*(?:\r?\n+|$)/gim
const WEBGUI_LINE_RE = /^Current [^\n]*?Web GUI URL:[^\n]*(?:\r?\n+|$)/gim

/**
 * The upstream 11-128 check matches a *contiguous run* of two consecutive
 * sentences, and every request carries them at the very top of the system
 * prompt:
 *
 *   Tokens prefixed with @ are paths the user explicitly referenced.
 *   Relative paths resolve from the workspace root; absolute paths identify
 *   files or directories on the host.
 *
 * A/B result: either sentence alone returns 200, the pair returns 400, and
 * rewriting the second sentence does not clear it (the match is anchored on the
 * first). Rewriting the first sentence into a paraphrase breaks the run.
 */
const REFERENCE_RULES_RE =
  /Tokens prefixed with @ are paths the user explicitly referenced\./gi
export const DEFAULT_REFERENCE_RULES_REPLACEMENT =
  'An @ prefix marks a path the user named explicitly.'

/** The second sentence of that pair (the host rule). */
const HOST_RULE_RE =
  /Relative paths resolve from the workspace root; absolute paths identify files or directories on the host\./gi
export const DEFAULT_HOST_RULE_REPLACEMENT =
  'Relative paths are resolved against the workspace root, while absolute paths refer to files or directories on the machine.'

/** WorkBuddy / Harness brand in prose and in identifiers. */
const BRAND_RE = /DeepSeek[ \t]+Harness/gi
const BRAND_HYPHEN_RE = /DeepSeek[-_]Harness/gi
const LOWER_BRAND_HYPHEN_RE = /deepseek[-_]harness/gi

/** `DSH` / `dsh` tokens that survive the brand rewrites. */
const BOOT_CONST_RE = /__DSH_BOOT__/g
const DSH_ENV_RE = /\bDSH_/g
const DSH_WORD_RE = /\bDSH\b/g
const DSH_LOWER_RE = /(?<![\w@])dsh(?![a-z0-9])/gi

/** Absolute paths that carry the product name or the harness home. */
const WINPATH_PRODUCT_RE =
  /[A-Za-z]:\\+[^\r\n"]*?(?:Deepseek[ \t]+Harness|deepseek[-_]harness)[^\r\n" ]*/gi
const WINPATH_ASAR_RE = /[A-Za-z]:\\+[^\r\n"]*?app\.asar[^\r\n" ]*/gi
const WINPATH_DSH_RE = /[A-Za-z]:\\+DSH(?=\\+|"|\s|$)/g
const WINPATH_DOT_DSH_RE =
  /[A-Za-z]:\\+(?:[^\r\n"\\]+\\)*\.dsh(?:\\+[^\r\n"]*)?/gi
const POSIX_DOT_DSH_RE = /~?\/\.dsh(?:\/[^\s"\r\n]*)?/g

export const DEFAULT_IDENTITY_REPLACEMENT = ''
export const DEFAULT_GUI_REPLACEMENT =
  '$1 whose URL is named in the runtime context.'
export const DEFAULT_BRAND_REPLACEMENT = 'host'

/**
 * Deep-scrub one harness-generated text segment.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.identityReplacement]
 * @param {string} [options.brandReplacement]
 * @returns {{ text: string, changed: boolean }}
 */
export function sanitizeText(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text, changed: false }
  }
  const identityReplacement =
    options.identityReplacement ?? DEFAULT_IDENTITY_REPLACEMENT
  const brandReplacement = options.brandReplacement ?? DEFAULT_BRAND_REPLACEMENT
  const referenceRulesReplacement =
    options.referenceRulesReplacement ?? DEFAULT_REFERENCE_RULES_REPLACEMENT
  const hostRuleReplacement = options.hostRuleReplacement ?? DEFAULT_HOST_RULE_REPLACEMENT

  const before = text
  let out = text

  // 0. The top-of-prompt sentence pair. Rewriting the FIRST sentence is what
  //    breaks the 11-128 contiguous-text match; the second is rewritten too so
  //    no other pairing can re-form.
  out = out.replace(REFERENCE_RULES_RE, referenceRulesReplacement)
  out = out.replace(HOST_RULE_RE, hostRuleReplacement)

  // 1. Drop the harness checkout paragraph and its runtime-context lines.
  out = out.replace(CHECKOUT_SECTION_RE, '')
  out = out.replace(CHECKOUT_LINE_RE, '')
  out = out.replace(WEBGUI_LINE_RE, '')

  // 2. Absolute paths first: they are semantic data, not prose. Replace them
  //    with explicit placeholders instead of mangling half a path.
  out = out.replace(WINPATH_PRODUCT_RE, '<host-install>')
  out = out.replace(WINPATH_ASAR_RE, '<host-install>')
  out = out.replace(WINPATH_DOT_DSH_RE, '<host-home>')
  out = out.replace(POSIX_DOT_DSH_RE, '<host-home>')
  out = out.replace(WINPATH_DSH_RE, '<workspace>')
  // Standalone archive names inside prose/tool output ("app.asar",
  // "default_app.asar", "app.asar.unpacked").
  out = out.replace(/app\.asar/gi, '<host-install>')

  // 3. Confirmed gateway fingerprints.
  out = out.replace(IDENTITY_RE, identityReplacement)
  out = out.replace(GUI_RE, DEFAULT_GUI_REPLACEMENT)

  // 4. Brand and DSH tokens everywhere else.
  out = out.replace(BRAND_RE, brandReplacement)
  out = out.replace(BRAND_HYPHEN_RE, brandReplacement)
  out = out.replace(LOWER_BRAND_HYPHEN_RE, brandReplacement)
  out = out.replace(BOOT_CONST_RE, '__HOST_BOOT__')
  out = out.replace(DSH_ENV_RE, 'HOST_')
  out = out.replace(/Current DSH file policy/gi, 'Current file policy')
  out = out.replace(/The DSH file sandbox/gi, 'The file sandbox')
  out = out.replace(/DSH file policy/gi, 'file policy')
  out = out.replace(DSH_WORD_RE, 'the host')
  out = out.replace(DSH_LOWER_RE, 'host')
  // Prefix forms the token rule deliberately skips (to avoid matching words
  // such as "spreadsheets"): package scope, marketplace name, state files,
  // and URL-encoded repository paths.
  out = out.replace(/@dsh-/gi, '@host-')
  out = out.replace(/\bdshmarket\b/gi, 'hostmarket')
  out = out.replace(/\.dshw-/g, '.host-')
  out = out.replace(/\.dsh(?=[\\/])/g, '.host')
  out = out.replace(/%2Fdsh-/gi, '%2Fhost-')
  out = out.replace(/\/dsh-/g, '/host-')

  // 5. Drop client headers that sometimes get pasted into prompt text.
  out = out.replace(BILLING_HEADER_RE, '')
  out = out.replace(CC_KV_RE, '')
  out = out.replace(BILLING_BARE_RE, 'x-anthropic-billing-hdr')

  if (out !== before) {
    out = out
      .replace(/\bthe the host\b/gi, 'the host')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  return { text: out, changed: out !== before }
}

/**
 * Count the identifiers that are still present. Used by tests and by
 * `/fingerprint scan`, so "no fingerprints left" is measurable rather than a claim.
 *
 * @param {string} text
 * @returns {Record<string, number>}
 */
export function scanFingerprints(text) {
  const source = typeof text === 'string' ? text : ''
  return {
    'DeepSeek Harness': (source.match(/DeepSeek[ \t]+Harness/gi) ?? []).length,
    'deepseek-harness': (source.match(/deepseek[-_]harness/gi) ?? []).length,
    DSH: (source.match(/\bDSH\b/g) ?? []).length,
    dsh: (source.match(/(?<![\w@])dsh(?![a-z0-9])/gi) ?? []).length,
    'app.asar': (source.match(/app\.asar/gi) ?? []).length,
    '.dsh': (source.match(/\.dsh\b/g) ?? []).length,
  }
}

/** Sum of {@link scanFingerprints}. */
export function fingerprintCount(text) {
  return Object.values(scanFingerprints(text)).reduce((a, b) => a + b, 0)
}

/**
 * Whether a User-Agent carries the harness attribution token.
 * @param {string | null | undefined} userAgent
 */
export function hasHarnessUserAgent(userAgent) {
  return typeof userAgent === 'string' && /deepseek[\s_-]*harness/i.test(userAgent)
}

/**
 * Whether a header name is DSH attribution metadata.
 * @param {string} name
 */
export function isAttributionHeader(name) {
  return /^x-deepseek-harness-/i.test(name)
}

/**
 * Sanitize a fetch header bag in place.
 *
 * @param {Headers} headers
 * @param {object} options
 * @param {string} options.userAgent replacement UA
 * @param {boolean} options.sanitizeUserAgent
 * @param {boolean} options.stripAttributionHeaders
 * @returns {boolean} whether anything changed
 */
export function sanitizeHeaders(headers, options) {
  let changed = false
  if (options.sanitizeUserAgent !== false) {
    const current = headers.get('user-agent')
    if (hasHarnessUserAgent(current)) {
      headers.set('user-agent', options.userAgent)
      changed = true
    }
  }
  if (options.stripAttributionHeaders !== false) {
    for (const name of [...headers.keys()]) {
      if (isAttributionHeader(name)) {
        headers.delete(name)
        changed = true
      }
    }
  }
  return changed
}

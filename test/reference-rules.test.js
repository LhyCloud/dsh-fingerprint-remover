import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeText } from '../lib/sanitize.js'

// The upstream 11-128 check matches the two sentences as one contiguous run.
const S1 = 'Tokens prefixed with @ are paths the user explicitly referenced.'
const S2 = 'Relative paths resolve from the workspace root; absolute paths identify files or directories on the host.'

test('reference-rules pair is broken by rewriting the first sentence', () => {
  const result = sanitizeText(`${S1} ${S2}`, {})
  assert.equal(result.changed, true)
  assert.ok(!result.text.includes(S1), 'first sentence must not survive verbatim')
  assert.ok(!result.text.includes(S2), 'second sentence is rewritten too')
  assert.match(result.text, /^An @ prefix marks a path the user named explicitly\./)
})

test('the full prompt paragraph keeps its meaning after the rewrite', () => {
  const input = [
    S1,
    'A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @"..." quotes a path containing spaces.',
    '',
    S2,
    'Non-zero exits are reported as `[exit code: N]` markers.',
  ].join(' ')
  const result = sanitizeText(input, {})
  assert.ok(result.text.includes('A trailing slash marks a directory'))
  assert.ok(result.text.includes('Non-zero exits are reported'))
  assert.ok(!result.text.includes(S1))
  assert.ok(!result.text.includes(S2))
})

test('replacement text is configurable', () => {
  const result = sanitizeText(S1, { referenceRulesReplacement: 'Paths the user named with @ are explicit.' })
  assert.equal(result.text, 'Paths the user named with @ are explicit.')
})

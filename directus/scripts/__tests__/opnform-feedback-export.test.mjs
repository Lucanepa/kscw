/**
 * The EN+DE feedback merge rests on two claims that are invisible in the output
 * when they are wrong, so they are asserted here rather than trusted.
 *
 * 1. The two forms share field UUIDs. If they drift, a merged CSV would put two
 *    different questions under one header and nobody reading it would notice.
 *    `assertSameShape` must refuse, not degrade.
 * 2. An OpnForm select stores the option NAME, so "Yes" and "Ja" are the same
 *    click recorded differently. They are folded together via the option `id`,
 *    which means the fold must survive someone rewording an option in the
 *    builder — a hardcoded word list would not.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertSameShape, buildValueMap, normalizeValue, formatZurich, toCsv, parseArgs,
} from '../opnform-feedback-export.mjs'

const en = {
  slug: 'feedback-en',
  fields: [
    { id: 'aaa', name: 'Would you like to be anonymous?', type: 'select', options: [{ id: 'Option 1', name: 'Yes' }, { id: 'Option 2', name: 'No' }] },
    { id: 'bbb', name: 'Your name', type: 'text', options: null },
  ],
}
const de = {
  slug: 'feedback-de',
  fields: [
    { id: 'aaa', name: 'Möchtest du anonym bleiben?', type: 'select', options: [{ id: 'Option 1', name: 'Ja' }, { id: 'Option 2', name: 'Nein' }] },
    { id: 'bbb', name: 'Dein Name', type: 'text', options: null },
  ],
}

test('same field ids in the same order merge cleanly', () => {
  assert.doesNotThrow(() => assertSameShape([en, de]))
})

test('a field only one form has is refused, and named in the error', () => {
  const drifted = { ...de, fields: [...de.fields, { id: 'ccc', name: 'Extra Frage', type: 'text', options: null }] }
  assert.throws(() => assertSameShape([en, drifted]), /only there:.*Extra Frage/s)
})

test('a dropped field is refused, and named in the error', () => {
  const drifted = { ...de, fields: [de.fields[0]] }
  assert.throws(() => assertSameShape([en, drifted]), /missing there:.*Your name/s)
})

test('a retyped field is refused even when the ids all match', () => {
  const drifted = { ...de, fields: [de.fields[0], { ...de.fields[1], type: 'number' }] }
  assert.throws(() => assertSameShape([en, drifted]), /type or order differs/)
})

test('localised option names fold back to the canonical wording via option id', () => {
  const map = buildValueMap([en, de])
  assert.deepEqual(map, { aaa: { Ja: 'Yes', Nein: 'No' } })
  assert.equal(normalizeValue('Ja', 'aaa', map), 'Yes')
  assert.equal(normalizeValue('Yes', 'aaa', map), 'Yes')
})

test('the fold follows a reworded option instead of a hardcoded word list', () => {
  // Someone edits the DE label in the builder; the option id is untouched.
  const reworded = { ...de, fields: [{ ...de.fields[0], options: [{ id: 'Option 1', name: 'Jawohl' }, { id: 'Option 2', name: 'Nein' }] }, de.fields[1]] }
  const map = buildValueMap([en, reworded])
  assert.equal(normalizeValue('Jawohl', 'aaa', map), 'Yes')
})

test('free text is never rewritten by the option fold', () => {
  const map = buildValueMap([en, de])
  assert.equal(normalizeValue('Ja', 'bbb', map), 'Ja', 'bbb has no options — leave the answer alone')
})

test('multi-select answers keep every choice, folded and joined', () => {
  const map = buildValueMap([en, de])
  assert.equal(normalizeValue(['Ja', 'Nein'], 'aaa', map), 'Yes, No')
})

test('missing answers become empty cells, not "undefined"', () => {
  assert.equal(normalizeValue(undefined, 'aaa', {}), '')
  assert.equal(normalizeValue(null, 'aaa', {}), '')
})

test('timestamps render Swiss and in Zurich time, not the runner locale', () => {
  assert.equal(formatZurich('2026-08-20T05:07:00Z'), '20.08.2026 07:07') // CEST = UTC+2
  assert.equal(formatZurich('2026-01-15T23:30:00Z'), '16.01.2026 00:30') // CET, day rolls over
  assert.equal(formatZurich(null), '')
})

test('CSV quotes the separators a free-text answer will eventually contain', () => {
  const csv = toCsv(['a', 'b'], [['plain', 'has, comma'], ['say "hi"', 'two\nlines']])
  assert.equal(csv, 'a,b\r\nplain,"has, comma"\r\n"say ""hi""","two\nlines"\r\n')
})

test('args: file, --json and a custom form pair', () => {
  assert.deepEqual(parseArgs(['out.csv']).file, 'out.csv')
  assert.equal(parseArgs(['--json']).json, true)
  assert.deepEqual(parseArgs(['--forms', 'a,b']).forms, ['a', 'b'])
  assert.throws(() => parseArgs(['--forms', 'only-one']), /at least two slugs/)
})

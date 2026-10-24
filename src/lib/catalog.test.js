import { describe, expect, it } from 'vitest'
import { initials, searchRelations } from './catalog'
describe('relation catalog', () => { it('searches English and Gujarati transliteration', () => { expect(searchRelations('uncle').some((x) => x.term === 'Kaka')).toBe(true); expect(searchRelations('masi')[0].english).toBe('Maternal aunt') }); it('creates initials', () => expect(initials('Prashant Patel')).toBe('PP')) })

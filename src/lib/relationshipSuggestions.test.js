import { describe, expect, it } from 'vitest'
import { relationshipSuggestions } from './relationshipSuggestions'

describe('relationship suggestions', () => {
  it('recognizes the unified Sibling label when proposing a missing parent', () => {
    const members = [
      { id: 'parent', fullName: 'Parent', gender: 'male' },
      { id: 'first', fullName: 'First child', gender: 'female' },
      { id: 'second', fullName: 'Second child', gender: 'male' },
    ]
    const relationships = [
      { id: 'parent-first', fromMemberId: 'parent', toMemberId: 'first', type: 'parent_child', label: 'Papa' },
      { id: 'siblings', fromMemberId: 'first', toMemberId: 'second', type: 'relative', label: 'Sibling' },
    ]
    expect(relationshipSuggestions(members, relationships)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'missing-parent', sourceId: 'parent', targetId: 'second', label: 'Papa' }),
    ]))
  })

  it('suggests the unified Sibling label for children who share a parent', () => {
    const members = [{ id: 'parent', fullName: 'Parent' }, { id: 'first', fullName: 'First' }, { id: 'second', fullName: 'Second' }]
    const relationships = [
      { id: 'first-link', fromMemberId: 'parent', toMemberId: 'first', type: 'parent_child', label: 'Papa' },
      { id: 'second-link', fromMemberId: 'parent', toMemberId: 'second', type: 'parent_child', label: 'Papa' },
    ]
    expect(relationshipSuggestions(members, relationships)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'missing-sibling', label: 'Sibling' }),
    ]))
  })
})

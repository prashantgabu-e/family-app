import { describe, expect, it } from 'vitest'
import { duplicateCandidates, layoutMembers, relationshipPath, validateRelationships } from './tree'

const members = [{ id: 'a', fullName: 'A' }, { id: 'b', fullName: 'B' }, { id: 'c', fullName: 'C' }]
const parent = { id: 'parent', type: 'parent_child', fromMemberId: 'a', toMemberId: 'b' }

describe('tree safety', () => {
  it('keeps generations top to bottom', () => expect(layoutMembers(members, [parent]).find((member) => member.id === 'b').position.y).toBeGreaterThan(0))
  it('finds a direct relationship path', () => expect(relationshipPath('a', 'b', [parent]).map((item) => item.id)).toEqual(['parent']))
  it('rejects duplicate links and ancestry cycles', () => expect(validateRelationships(members, [parent], { ...parent, id: 'reverse', fromMemberId: 'b', toMemberId: 'a' })).toEqual(expect.arrayContaining(['These two family members already have a relationship.', 'Parent and child links cannot form a circular ancestry.'])))
  it('flags matching member names as merge candidates', () => expect(duplicateCandidates({ id: 'b', fullName: 'A' }, members).map((member) => member.id)).toEqual(['a']))
})

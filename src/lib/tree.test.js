import { describe, expect, it } from 'vitest'
import { layoutMembers } from './tree'
describe('tree layout', () => { it('places children below their parent', () => { const laidOut = layoutMembers([{ id: 'a' }, { id: 'b' }], [{ fromMemberId: 'a', toMemberId: 'b', type: 'parent_child' }]); expect(laidOut.find((x) => x.id === 'b').position.y).toBeGreaterThan(laidOut.find((x) => x.id === 'a').position.y) }) })

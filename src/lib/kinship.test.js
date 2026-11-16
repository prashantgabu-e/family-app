import { describe, expect, it } from 'vitest'
import { inferKinship } from './kinship'

describe('kinship inference', () => {
  it('uses a sibling member gender after Bhai and Ben are migrated to Sibling', () => {
    const members = [
      { id: 'root', fullName: 'Root', gender: 'male' },
      { id: 'sibling', fullName: 'Sister', gender: 'female' },
      { id: 'spouse', fullName: 'Sibling spouse', gender: 'male' },
    ]
    const relationships = [
      { id: 'siblings', fromMemberId: 'root', toMemberId: 'sibling', type: 'relative', label: 'Sibling' },
      { id: 'marriage', fromMemberId: 'sibling', toMemberId: 'spouse', type: 'spouse', label: 'Spouse' },
    ]
    expect(inferKinship('root', 'spouse', members, relationships)).toMatchObject({ term: 'Jijaji / Banevi', english: 'Sister’s husband' })
  })
})

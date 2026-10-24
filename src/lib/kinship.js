import { relationCatalog } from './catalog'

const sexOf = (member, hint = '') => {
  const value = `${member?.gender || ''} ${hint}`.toLowerCase()
  if (/woman|female|mummy|mother|dadi|nani|kaki|foi|mami|masi|ben|wife|daughter|dikri|saas|bhabhi|jethani|devrani/.test(value)) return 'female'
  if (/man|male|papa|father|dada|nana|kaka|fua|mama|masa|bhai|husband|son|dikro|jamai|jijaji|banevi|sasra|jeth|devar|salo/.test(value)) return 'male'
  return 'unknown'
}

const bySex = (sex, male, female, neutral) => sex === 'male' ? male : sex === 'female' ? female : neutral
const result = (term, english, distance, path) => ({ term, english, distance, path })

export function inferKinship(rootId, targetId, members, relationships) {
  if (!rootId || !targetId) return null
  if (rootId === targetId) return result('Self', 'Primary person', 0, [])
  const membersById = Object.fromEntries(members.map((member) => [member.id, member]))
  const graph = new Map(members.map((member) => [member.id, []]))
  const add = (from, to, kind, label) => graph.get(from)?.push({ to, kind, label: label || '' })
  relationships.forEach((link) => {
    if (link.type === 'parent_child') { add(link.toMemberId, link.fromMemberId, 'P', link.label); add(link.fromMemberId, link.toMemberId, 'C', link.label) }
    else if (link.type === 'spouse') { add(link.fromMemberId, link.toMemberId, 'S', link.label); add(link.toMemberId, link.fromMemberId, 'S', link.label) }
    else { add(link.fromMemberId, link.toMemberId, 'R', link.label); add(link.toMemberId, link.fromMemberId, 'R', link.label) }
  })
  // Prefer factual parent/child/spouse links over a free-form label. A direct label such
  // as “Jamai” describes the relationship from the other person's perspective, while
  // the family structure can correctly infer “Sasra” for the primary person.
  const findPath = (allowRelative) => {
    const queue = [{ id: rootId, steps: [] }]; const visited = new Set([rootId])
    while (queue.length) { const current = queue.shift(); if (current.steps.length >= 6) continue; for (const edge of graph.get(current.id) || []) { if (!allowRelative && edge.kind === 'R') continue; if (visited.has(edge.to)) continue; const next = [...current.steps, { ...edge, member: membersById[edge.to] }]; if (edge.to === targetId) return next; visited.add(edge.to); queue.push({ id: edge.to, steps: next }) } }
    return null
  }
  const steps = findPath(false) || findPath(true)
  if (!steps) return result('Relative', 'Connection unavailable', 0, [])
  const pattern = steps.map((step) => step.kind).join(''); const directRootLabel = relationships.find((relationship) => (relationship.fromMemberId === targetId && relationship.toMemberId === rootId) || (relationship.toMemberId === targetId && relationship.fromMemberId === rootId))?.label; const targetSex = sexOf(membersById[targetId], directRootLabel || steps.at(-1)?.label); const firstParentSex = sexOf(steps[0]?.member, steps[0]?.label)
  if (pattern === 'R') { const direct = steps[0].label || 'Relative'; const inverse = { jamai: ['Sasra', 'Father-in-law'], vahu: ['Saas', 'Mother-in-law'], dikri: ['Mummy', 'Mother'], dikro: ['Papa', 'Father'], papa: ['Dikro', 'Son'], mummy: ['Dikri', 'Daughter'], husband: ['Wife', 'Wife'], wife: ['Husband', 'Husband'] }; const stored = relationships.find((relationship) => relationship.fromMemberId === targetId && relationship.toMemberId === rootId); const swapped = stored && inverse[direct.toLowerCase()]; const match = relationCatalog.find((item) => item.term.toLowerCase() === direct.toLowerCase()); return result(swapped?.[0] || direct, swapped?.[1] || match?.english || 'Direct relative', 1, steps) }
  if (pattern === 'RS') { const direct = steps[0].label.toLowerCase(); if (/ben|bahen|sister|didi/.test(direct)) return result('Jijaji / Banevi', 'Sister’s husband', 2, steps); if (/bhai|brother/.test(direct)) return result('Bhabhi', 'Brother’s wife', 2, steps); if (/kaka|chacha|mota papa/.test(direct)) return result('Kaki', 'Paternal uncle’s wife', 2, steps); if (/foi|fai|fui/.test(direct)) return result('Fua', 'Paternal aunt’s husband', 2, steps); if (/mama/.test(direct)) return result('Mami', 'Maternal uncle’s wife', 2, steps); if (/masi/.test(direct)) return result('Masa', 'Maternal aunt’s husband', 2, steps); if (/nanand/.test(direct)) return result('Nandoi', 'Husband’s sister’s husband', 2, steps); if (/sali/.test(direct)) return result('Sadhu Bhai', 'Wife’s sister’s husband', 2, steps); return result('In-law', `${steps[0].label || 'Relative'}’s spouse`, 2, steps) }
  if (pattern === 'RC') { const direct = steps[0].label.toLowerCase(); const sisterSide = /ben|bahen|sister|didi/.test(direct); return result(...(sisterSide ? bySex(targetSex, ['Bhanjo', 'Sister’s son'], ['Bhanji', 'Sister’s daughter'], ['Bhanej', 'Sister’s child']) : bySex(targetSex, ['Bhatrijo', 'Brother’s son'], ['Bhatriji', 'Brother’s daughter'], ['Nibling', 'Sibling’s child'])), 2, steps) }
  if (pattern === 'P') return result(...bySex(targetSex, ['Papa', 'Father'], ['Mummy', 'Mother'], ['Parent', 'Parent']), 1, steps)
  if (pattern === 'C') return result(...bySex(targetSex, ['Dikro', 'Son'], ['Dikri', 'Daughter'], ['Child', 'Child']), 1, steps)
  if (pattern === 'S') return result('Spouse', 'Spouse', 1, steps)
  if (pattern === 'PP') { const paternal = firstParentSex === 'male'; return result(...(paternal ? bySex(targetSex, ['Dada', 'Paternal grandfather'], ['Dadi', 'Paternal grandmother'], ['Grandparent', 'Paternal grandparent']) : bySex(targetSex, ['Nana', 'Maternal grandfather'], ['Nani', 'Maternal grandmother'], ['Grandparent', 'Maternal grandparent'])), 2, steps) }
  if (pattern === 'CC') return result(...bySex(targetSex, ['Pautra', 'Grandson'], ['Pautri', 'Granddaughter'], ['Grandchild', 'Grandchild']), 2, steps)
  if (pattern === 'PC') return result(...bySex(targetSex, ['Bhai', 'Brother'], ['Ben', 'Sister'], ['Sibling', 'Sibling']), 2, steps)
  if (pattern === 'PPC') { const paternal = firstParentSex === 'male'; return result(...(paternal ? bySex(targetSex, ['Kaka', 'Paternal uncle'], ['Foi', 'Paternal aunt'], ['Paternal relative', 'Parent’s sibling']) : bySex(targetSex, ['Mama', 'Maternal uncle'], ['Masi', 'Maternal aunt'], ['Maternal relative', 'Parent’s sibling'])), 3, steps) }
  if (pattern === 'PCC') { const siblingSex = sexOf(steps[1]?.member, steps[1]?.label); return result(...(siblingSex === 'female' ? bySex(targetSex, ['Bhanjo', 'Sister’s son'], ['Bhanji', 'Sister’s daughter'], ['Bhanej', 'Sister’s child']) : bySex(targetSex, ['Bhatrijo', 'Brother’s son'], ['Bhatriji', 'Brother’s daughter'], ['Nibling', 'Brother’s child'])), 3, steps) }
  if (pattern === 'PPCC') { const parentSiblingSex = sexOf(steps[2]?.member, steps[2]?.label); const base = firstParentSex === 'male' ? (parentSiblingSex === 'female' ? 'Foiyai' : 'Pitarai') : (parentSiblingSex === 'female' ? 'Masiyai' : 'Mamerai'); const suffix = targetSex === 'female' ? 'Ben' : targetSex === 'male' ? 'Bhai' : 'Cousin'; return result(`${base} ${suffix}`, `${firstParentSex === 'male' ? 'Paternal' : 'Maternal'} cousin${targetSex === 'female' ? ' (female)' : targetSex === 'male' ? ' (male)' : ''}`, 4, steps) }
  if (pattern === 'SP') return result(...bySex(targetSex, ['Sasra', 'Father-in-law'], ['Saas', 'Mother-in-law'], ['Parent-in-law', 'Parent-in-law']), 2, steps)
  if (pattern === 'CS') return result(...bySex(targetSex, ['Jamai', 'Son-in-law'], ['Vahu', 'Daughter-in-law'], ['Child-in-law', 'Child-in-law']), 2, steps)
  if (pattern === 'PCS') { const siblingSex = sexOf(steps[1]?.member, steps[1]?.label); return siblingSex === 'female' ? result('Jijaji / Banevi', 'Sister’s husband', 3, steps) : result('Bhabhi', 'Brother’s wife', 3, steps) }
  if (pattern === 'PPCS') { const parentSiblingSex = sexOf(steps[2]?.member, steps[2]?.label); const paternal = firstParentSex === 'male'; const term = paternal ? (parentSiblingSex === 'female' ? 'Fua' : 'Kaki') : (parentSiblingSex === 'female' ? 'Masa' : 'Mami'); const english = paternal ? (parentSiblingSex === 'female' ? 'Paternal aunt’s husband' : 'Paternal uncle’s wife') : (parentSiblingSex === 'female' ? 'Maternal aunt’s husband' : 'Maternal uncle’s wife'); return result(term, english, 4, steps) }
  if (pattern === 'SPC') { const rootSex = sexOf(membersById[rootId]); if (rootSex === 'male') return result(...bySex(targetSex, ['Salo', 'Wife’s brother'], ['Sali', 'Wife’s sister'], ['Sibling-in-law', 'Wife’s sibling']), 3, steps); return result(...bySex(targetSex, ['Jeth / Devar', 'Husband’s brother'], ['Nanand', 'Husband’s sister'], ['Sibling-in-law', 'Husband’s sibling']), 3, steps) }
  if (pattern === 'SPCS') return result(...bySex(targetSex, ['Sadhu Bhai / Nandoi', 'Spouse’s sibling’s husband'], ['Sadaveli / Jethani / Devrani', 'Spouse’s sibling’s wife'], ['In-law', 'Spouse’s sibling’s spouse']), 4, steps)
  if (/^P{3,}$/.test(pattern)) return result(bySex(targetSex, 'Par-Dada', 'Par-Dadi', 'Ancestor'), bySex(targetSex, 'Great-grandfather', 'Great-grandmother', 'Great-grandparent'), steps.length, steps)
  if (/^C{3,}$/.test(pattern)) return result(bySex(targetSex, 'Par-Pautra', 'Par-Pautri', 'Descendant'), bySex(targetSex, 'Great-grandson', 'Great-granddaughter', 'Great-grandchild'), steps.length, steps)
  return result('Extended relative', `${steps.length} family connections away`, steps.length, steps)
}

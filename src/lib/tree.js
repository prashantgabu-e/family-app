const canonical = (value = '') => value.trim().toLocaleLowerCase()
const spouseLabels = new Set(['spouse', 'wife', 'husband', 'partner'])
export const isSpouseRelationship = (relationship) => relationship.type === 'spouse' || spouseLabels.has(canonical(relationship.label))

export function generationMap(members, relationships) {
  const parentsOf = new Map(members.map(({ id }) => [id, []]))
  relationships.filter((r) => r.type === 'parent_child').forEach((r) => parentsOf.get(r.toMemberId)?.push(r.fromMemberId))
  const generation = new Map()
  const visit = (id, stack = new Set()) => {
    if (generation.has(id)) return generation.get(id)
    if (stack.has(id)) return 0
    const parents = parentsOf.get(id) || []
    const level = parents.length ? Math.max(...parents.map((parent) => visit(parent, new Set([...stack, id])) + 1)) : 0
    generation.set(id, level); return level
  }
  members.forEach((member) => visit(member.id))
  let changed = true
  while (changed) { changed = false; relationships.filter(isSpouseRelationship).forEach((r) => { const level = Math.max(generation.get(r.fromMemberId) || 0, generation.get(r.toMemberId) || 0); [r.fromMemberId, r.toMemberId].forEach((id) => { if (generation.get(id) !== level) { generation.set(id, level); changed = true } }) }) }
  return generation
}

export function layoutMembers(members, relationships) {
  const generations = generationMap(members, relationships); const spouses = new Map()
  relationships.filter(isSpouseRelationship).forEach((r) => { spouses.set(r.fromMemberId, r.toMemberId); spouses.set(r.toMemberId, r.fromMemberId) })
  const rows = new Map(); members.forEach((member) => { const generation = generations.get(member.id) || 0; rows.set(generation, [...(rows.get(generation) || []), member]) })
  for (const row of rows.values()) row.sort((a, b) => ([a.id, spouses.get(a.id) || a.id].sort()[0]).localeCompare([b.id, spouses.get(b.id) || b.id].sort()[0]) || a.fullName.localeCompare(b.fullName))
  return members.map((member) => { const row = rows.get(generations.get(member.id) || 0); const index = row.findIndex((item) => item.id === member.id); return { ...member, generation: generations.get(member.id) || 0, position: { x: (index - (row.length - 1) / 2) * 300, y: (generations.get(member.id) || 0) * 210 } } })
}

export function relationshipPath(rootId, targetId, relationships) {
  if (!rootId || !targetId) return []
  const graph = new Map(); const add = (from, to, relationship) => graph.set(from, [...(graph.get(from) || []), { to, relationship }])
  relationships.forEach((relationship) => { add(relationship.fromMemberId, relationship.toMemberId, relationship); add(relationship.toMemberId, relationship.fromMemberId, relationship) })
  const findShortestRoutes = (allowCustomRelative) => {
    const queue = [{ id: rootId, path: [], visited: new Set([rootId]) }]; const routes = []; let shortestLength = Infinity
    while (queue.length) {
      const current = queue.shift()
      if (current.path.length > shortestLength || current.path.length >= 8) continue
      if (current.id === targetId) { shortestLength = current.path.length; routes.push(current.path); continue }
      for (const next of graph.get(current.id) || []) {
        if (!allowCustomRelative && next.relationship.type === 'relative') continue
        if (!current.visited.has(next.to)) queue.push({ id: next.to, path: [...current.path, next.relationship], visited: new Set([...current.visited, next.to]) })
      }
    }
    return routes
  }
  const routes = findShortestRoutes(false); const usableRoutes = routes.length ? routes : findShortestRoutes(true)
  return [...new Map(usableRoutes.flat().map((relationship) => [relationship.id, relationship])).values()]
}

export function relatedMemberIds(rootId, relationships, mode = 'all') {
  const map = new Map(); const parentSide = mode === 'ancestors'
  relationships.filter((r) => r.type === 'parent_child').forEach((r) => { const from = parentSide ? r.toMemberId : r.fromMemberId; const to = parentSide ? r.fromMemberId : r.toMemberId; map.set(from, [...(map.get(from) || []), to]) })
  const found = new Set(); const queue = [...(map.get(rootId) || [])]
  while (queue.length) { const id = queue.shift(); if (!found.has(id)) { found.add(id); queue.push(...(map.get(id) || [])) } }
  return found
}

export function validateRelationships(members, relationships, candidate) {
  const all = candidate ? [...relationships.filter((r) => r.id !== candidate.id), candidate] : relationships; const issues = []; const memberIds = new Set(members.map((member) => member.id)); const pairs = new Set()
  all.forEach((relationship) => { const key = [relationship.fromMemberId, relationship.toMemberId].sort().join('::'); if (!memberIds.has(relationship.fromMemberId) || !memberIds.has(relationship.toMemberId)) issues.push('Every relationship must connect two members in this branch.'); if (relationship.fromMemberId === relationship.toMemberId) issues.push('A person cannot be related to themself.'); if (pairs.has(key)) issues.push('These two family members already have a relationship.'); pairs.add(key) })
  const children = new Map(); all.filter((r) => r.type === 'parent_child').forEach((r) => children.set(r.fromMemberId, [...(children.get(r.fromMemberId) || []), r.toMemberId]))
  const visiting = new Set(); const complete = new Set(); const cyclic = (id) => { if (visiting.has(id)) return true; if (complete.has(id)) return false; visiting.add(id); const result = (children.get(id) || []).some(cyclic); visiting.delete(id); complete.add(id); return result }
  if (members.some((member) => cyclic(member.id))) issues.push('Parent and child links cannot form a circular ancestry.')
  return [...new Set(issues)]
}

export function duplicateCandidates(member, members) { const name = canonical(member.fullName); return name ? members.filter((other) => other.id !== member.id && canonical(other.fullName) === name && (!member.birthDate || !other.birthDate || other.birthDate === member.birthDate)) : [] }

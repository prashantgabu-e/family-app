export function layoutMembers(members, relationships) {
  const parents = new Map(members.map((member) => [member.id, []]))
  relationships.filter((r) => r.type === 'parent_child').forEach((r) => parents.get(r.toMemberId)?.push(r.fromMemberId))
  const spouseOf = new Map()
  relationships.filter((r) => r.type === 'spouse').forEach((r) => { spouseOf.set(r.fromMemberId, r.toMemberId); spouseOf.set(r.toMemberId, r.fromMemberId) })
  const level = new Map()
  const visit = (id, seen = new Set()) => {
    if (level.has(id)) return level.get(id)
    if (seen.has(id)) return 0
    const value = Math.max(0, ...(parents.get(id) || []).map((parent) => visit(parent, new Set([...seen, id])) + 1))
    level.set(id, value); return value
  }
  members.forEach((member) => visit(member.id))
  // A spouse belongs in the same generation as their partner, even if only one has recorded parents.
  let changed = true
  while (changed) {
    changed = false
    spouseOf.forEach((partnerId, memberId) => { const sharedLevel = Math.max(level.get(memberId) || 0, level.get(partnerId) || 0); if (level.get(memberId) !== sharedLevel) { level.set(memberId, sharedLevel); changed = true } if (level.get(partnerId) !== sharedLevel) { level.set(partnerId, sharedLevel); changed = true } })
  }
  const rows = {}
  members.forEach((member) => { const l = level.get(member.id) || 0; (rows[l] ||= []).push(member) })
  Object.values(rows).forEach((row) => row.sort((first, second) => {
    const firstKey = [first.id, spouseOf.get(first.id) || first.id].sort()[0]
    const secondKey = [second.id, spouseOf.get(second.id) || second.id].sort()[0]
    return firstKey.localeCompare(secondKey)
  }))
  return members.map((member) => {
    const row = rows[level.get(member.id) || 0]; const index = row.findIndex((item) => item.id === member.id)
    // Fixed, centered, top-to-bottom hierarchy; manual positions are deliberately ignored.
    return { ...member, position: { x: (index - (row.length - 1) / 2) * 390, y: (level.get(member.id) || 0) * 220 } }
  })
}

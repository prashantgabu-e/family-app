const parentLabelFor = (member) => member?.gender === 'female' ? 'Mummy' : member?.gender === 'male' ? 'Papa' : null

const pairKey = (first, second) => [first, second].sort().join('::')
const parentTerms = new Set(['papa', 'mummy', 'father', 'mother', 'dad', 'mom'])
const siblingTerms = new Set(['bhai', 'ben', 'brother', 'sister'])
const spouseTerms = new Set(['spouse', 'wife', 'husband', 'partner'])
const normalized = (value = '') => value.trim().toLowerCase()
const labelFromParentLink = (relationship) => {
  const label = normalized(relationship?.label)
  if (['papa', 'father', 'dad'].includes(label)) return 'Papa'
  if (['mummy', 'mother', 'mom'].includes(label)) return 'Mummy'
  return null
}

/**
 * Finds only conservative, explainable missing links. A suggestion is never
 * persisted automatically: the user reviews it in the member form first.
 */
export function relationshipSuggestions(members, relationships) {
  const memberById = new Map(members.map((member) => [member.id, member]))
  const parentLinks = relationships.filter((relationship) => relationship.type === 'parent_child' || parentTerms.has(normalized(relationship.label)))
  const parentsByChild = new Map()
  const childrenByParent = new Map()
  const knownPairs = new Set(relationships.map((relationship) => pairKey(relationship.fromMemberId, relationship.toMemberId)))
  const suggestions = new Map()
  const siblingsByMember = new Map()
  const spousesByMember = new Map()

  parentLinks.forEach((relationship) => {
    parentsByChild.set(relationship.toMemberId, [...(parentsByChild.get(relationship.toMemberId) || []), relationship.fromMemberId])
    childrenByParent.set(relationship.fromMemberId, [...(childrenByParent.get(relationship.fromMemberId) || []), relationship.toMemberId])
  })
  relationships.filter((relationship) => siblingTerms.has(normalized(relationship.label))).forEach((relationship) => {
    siblingsByMember.set(relationship.fromMemberId, [...(siblingsByMember.get(relationship.fromMemberId) || []), relationship.toMemberId])
    siblingsByMember.set(relationship.toMemberId, [...(siblingsByMember.get(relationship.toMemberId) || []), relationship.fromMemberId])
  })
  relationships.filter((relationship) => relationship.type === 'spouse' || spouseTerms.has(normalized(relationship.label))).forEach((relationship) => {
    spousesByMember.set(relationship.fromMemberId, [...(spousesByMember.get(relationship.fromMemberId) || []), relationship.toMemberId])
    spousesByMember.set(relationship.toMemberId, [...(spousesByMember.get(relationship.toMemberId) || []), relationship.fromMemberId])
  })

  const siblingComponent = (memberId) => {
    const found = new Set(); const queue = [...(siblingsByMember.get(memberId) || [])]
    while (queue.length) { const id = queue.shift(); if (!found.has(id) && id !== memberId) { found.add(id); queue.push(...(siblingsByMember.get(id) || [])) } }
    return [...found]
  }
  const siblingsFor = (memberId) => [...new Set([
    ...siblingComponent(memberId),
    ...(parentsByChild.get(memberId) || []).flatMap((parentId) => childrenByParent.get(parentId) || []).filter((id) => id !== memberId),
  ])]

  const add = (suggestion) => {
    if (!memberById.has(suggestion.sourceId) || !memberById.has(suggestion.targetId)) return
    if (knownPairs.has(pairKey(suggestion.sourceId, suggestion.targetId))) return
    const samePair = [...suggestions.entries()].find(([, item]) => pairKey(item.sourceId, item.targetId) === pairKey(suggestion.sourceId, suggestion.targetId))
    if (samePair) {
      if (samePair[1].confidence === 'High confidence' || suggestion.confidence !== 'High confidence') return
      suggestions.delete(samePair[0])
    }
    const key = `${suggestion.kind}:${suggestion.sourceId}:${suggestion.targetId}`
    if (!suggestions.has(key)) suggestions.set(key, suggestion)
  }

  // If two people share a recorded parent and one already has another parent,
  // the other parent is very likely missing for their sibling too.
  parentLinks.forEach((sharedParentLink) => {
    const sharedParentId = sharedParentLink.fromMemberId
    const siblingId = sharedParentLink.toMemberId
    const siblingParents = parentsByChild.get(siblingId) || []
    const siblings = [...new Set([...(childrenByParent.get(sharedParentId) || []), ...siblingComponent(siblingId)])]
    siblingParents.filter((parentId) => parentId !== sharedParentId).forEach((otherParentId) => {
      siblings.filter((childId) => childId !== siblingId && !parentsByChild.get(childId)?.includes(otherParentId)).forEach((childId) => {
        const parent = memberById.get(otherParentId)
        const sharedParent = memberById.get(sharedParentId)
        const sibling = memberById.get(siblingId)
        const child = memberById.get(childId)
        const knownParentLink = parentLinks.find((link) => link.fromMemberId === otherParentId && link.toMemberId === siblingId)
        const label = parentLabelFor(parent) || labelFromParentLink(knownParentLink)
        if (!label) return
        add({
          id: `parent:${otherParentId}:${childId}`,
          kind: 'missing-parent',
          sourceId: otherParentId,
          targetId: childId,
          label,
          confidence: 'High confidence',
          evidenceMemberIds: [otherParentId, sharedParentId, siblingId, childId],
          evidenceRelationshipIds: relationships.filter((link) => (link.fromMemberId === sharedParentId && link.toMemberId === siblingId) || (link.fromMemberId === sharedParentId && link.toMemberId === childId) || (link.fromMemberId === otherParentId && link.toMemberId === siblingId) || (siblingTerms.has(normalized(link.label)) && ((link.fromMemberId === siblingId && link.toMemberId === childId) || (link.toMemberId === siblingId && link.fromMemberId === childId)))).map((link) => link.id),
          title: `Add ${parent?.fullName || 'parent'} as ${child?.fullName || 'child'}’s ${label}`,
          reason: childrenByParent.get(sharedParentId)?.includes(childId) ? `${child?.fullName || 'This person'} and ${sibling?.fullName || 'their sibling'} already share ${sharedParent?.fullName || 'one parent'}, and ${parent?.fullName || 'this person'} is recorded as ${sibling?.fullName || 'their sibling'}’s ${label}.` : `${child?.fullName || 'This person'} is recorded as a sibling of ${sibling?.fullName || 'their sibling'}, and ${parent?.fullName || 'this person'} is recorded as ${sibling?.fullName || 'their sibling'}’s ${label}.`,
        })
      })
    })
  })

  // A directly recorded Bhai/Ben relationship is also sufficient evidence to
  // propose the same parent for siblings. This is the common real-world case
  // where only one child's Papa/Mummy was entered first.
  parentLinks.forEach((parentLink) => {
    const parentId = parentLink.fromMemberId; const knownChildId = parentLink.toMemberId
    const parent = memberById.get(parentId); const knownChild = memberById.get(knownChildId); const label = parentLabelFor(parent) || labelFromParentLink(parentLink)
    if (!label) return
    siblingComponent(knownChildId).forEach((siblingId) => {
      if ((parentsByChild.get(siblingId) || []).includes(parentId)) return
      const sibling = memberById.get(siblingId)
      const siblingLinkIds = relationships.filter((relationship) => siblingTerms.has(normalized(relationship.label)) && ((relationship.fromMemberId === knownChildId && relationship.toMemberId === siblingId) || (relationship.toMemberId === knownChildId && relationship.fromMemberId === siblingId))).map((relationship) => relationship.id)
      add({
        id: `sibling-parent:${parentId}:${siblingId}`,
        kind: 'missing-parent',
        sourceId: parentId,
        targetId: siblingId,
        label,
        confidence: 'High confidence',
        evidenceMemberIds: [parentId, knownChildId, siblingId],
        evidenceRelationshipIds: [parentLink.id, ...siblingLinkIds],
        title: `Add ${parent?.fullName || 'parent'} as ${sibling?.fullName || 'sibling'}’s ${label}`,
        reason: `${sibling?.fullName || 'This person'} is recorded as a sibling of ${knownChild?.fullName || 'their sibling'}, and ${parent?.fullName || 'this person'} is recorded as ${knownChild?.fullName || 'their sibling'}’s ${label}.`,
      })
    })
  })

  // Children with a shared parent are siblings even when a Bhai/Ben link has
  // not been entered yet. This is a convenient, low-risk suggestion.
  childrenByParent.forEach((childIds, parentId) => {
    for (let index = 0; index < childIds.length; index += 1) {
      for (let next = index + 1; next < childIds.length; next += 1) {
        const sourceId = childIds[index]; const targetId = childIds[next]; const source = memberById.get(sourceId); const target = memberById.get(targetId); const parent = memberById.get(parentId)
        const label = source?.gender === 'female' ? 'Ben' : source?.gender === 'male' ? 'Bhai' : null
        if (!label) continue
        add({ id: `siblings:${sourceId}:${targetId}`, kind: 'missing-sibling', sourceId, targetId, label, confidence: 'High confidence', evidenceMemberIds: [sourceId, targetId, parentId], evidenceRelationshipIds: parentLinks.filter((link) => link.fromMemberId === parentId && (link.toMemberId === sourceId || link.toMemberId === targetId)).map((link) => link.id), title: `Link ${source?.fullName || 'sibling'} and ${target?.fullName || 'sibling'} as siblings`, reason: `Both are recorded as children of ${parent?.fullName || 'the same parent'}.` })
      }
    }
  })

  // A recorded spouse often belongs in the children's parent group, but this
  // remains review-only because a spouse may be a step-parent.
  spousesByMember.forEach((partnerIds, parentId) => {
    partnerIds.forEach((partnerId) => (childrenByParent.get(parentId) || []).forEach((childId) => {
      if ((parentsByChild.get(childId) || []).includes(partnerId)) return
      const partner = memberById.get(partnerId); const parent = memberById.get(parentId); const child = memberById.get(childId); const label = parentLabelFor(partner)
      if (!label) return
      const spouseLink = relationships.find((link) => (link.fromMemberId === parentId && link.toMemberId === partnerId) || (link.fromMemberId === partnerId && link.toMemberId === parentId))
      const parentLink = parentLinks.find((link) => link.fromMemberId === parentId && link.toMemberId === childId)
      add({ id: `spouse-parent:${partnerId}:${childId}`, kind: 'possible-step-parent', sourceId: partnerId, targetId: childId, label, confidence: 'Review suggested', evidenceMemberIds: [partnerId, parentId, childId], evidenceRelationshipIds: [spouseLink?.id, parentLink?.id].filter(Boolean), title: `Consider adding ${partner?.fullName || 'spouse'} as ${child?.fullName || 'child'}’s ${label}`, reason: `${partner?.fullName || 'This person'} is recorded as spouse of ${parent?.fullName || 'a recorded parent'}. Confirm this is a parent relationship, not a step-parent or separate family connection.` })
    }))
  })

  // Indian family labels based on an explicit parent plus that parent's
  // sibling. These are review-only because every household may prefer a
  // different custom term.
  parentLinks.forEach((parentLink) => {
    const parentId = parentLink.fromMemberId; const childId = parentLink.toMemberId; const parent = memberById.get(parentId); const child = memberById.get(childId); const parentRole = parentLabelFor(parent) || labelFromParentLink(parentLink)
    siblingsFor(parentId).forEach((relativeId) => {
      const relative = memberById.get(relativeId)
      const label = parentRole === 'Papa' ? relative?.gender === 'male' ? 'Kaka' : relative?.gender === 'female' ? 'Foi' : null : parentRole === 'Mummy' ? relative?.gender === 'male' ? 'Mama' : relative?.gender === 'female' ? 'Masi' : null : null
      if (!label) return
      add({ id: `parent-sibling:${relativeId}:${childId}`, kind: 'parent-sibling', sourceId: relativeId, targetId: childId, label, confidence: 'Review suggested', evidenceMemberIds: [relativeId, parentId, childId], evidenceRelationshipIds: relationships.filter((link) => (link.fromMemberId === parentId && link.toMemberId === childId) || (siblingTerms.has(normalized(link.label)) && ((link.fromMemberId === parentId && link.toMemberId === relativeId) || (link.toMemberId === parentId && link.fromMemberId === relativeId)))).map((link) => link.id), title: `Consider ${relative?.fullName || 'this relative'} as ${child?.fullName || 'child'}’s ${label}`, reason: `${relative?.fullName || 'This person'} is a recorded sibling of ${parent?.fullName || 'a parent'}, who is ${child?.fullName || 'the child'}’s ${parentRole}.` })
    })
  })

  // A sibling's spouse is commonly Jijaji or Bhabhi. We only suggest the
  // terms when the sibling and spouse genders make the label unambiguous.
  members.forEach((member) => siblingsFor(member.id).forEach((siblingId) => (spousesByMember.get(siblingId) || []).forEach((partnerId) => {
    const sibling = memberById.get(siblingId); const partner = memberById.get(partnerId); const label = sibling?.gender === 'female' && partner?.gender === 'male' ? 'Jijaji' : sibling?.gender === 'male' && partner?.gender === 'female' ? 'Bhabhi' : null
    if (!label) return
    const spouseLink = relationships.find((link) => (link.fromMemberId === siblingId && link.toMemberId === partnerId) || (link.fromMemberId === partnerId && link.toMemberId === siblingId))
    add({ id: `sibling-spouse:${partnerId}:${member.id}`, kind: 'sibling-spouse', sourceId: partnerId, targetId: member.id, label, confidence: 'Review suggested', evidenceMemberIds: [partnerId, siblingId, member.id], evidenceRelationshipIds: [spouseLink?.id].filter(Boolean), title: `Consider ${partner?.fullName || 'spouse'} as ${member.fullName}’s ${label}`, reason: `${partner?.fullName || 'This person'} is recorded as spouse of ${sibling?.fullName || 'a sibling'} of ${member.fullName}.` })
  })))

  // Parents of a recorded spouse become Saas/Sasra candidates.
  spousesByMember.forEach((partnerIds, memberId) => partnerIds.forEach((spouseId) => (parentsByChild.get(spouseId) || []).forEach((parentId) => {
    const parent = memberById.get(parentId); const spouse = memberById.get(spouseId); const member = memberById.get(memberId); const label = parent?.gender === 'female' ? 'Saas' : parent?.gender === 'male' ? 'Sasra' : null
    if (!label) return
    add({ id: `inlaw-parent:${parentId}:${memberId}`, kind: 'inlaw-parent', sourceId: parentId, targetId: memberId, label, confidence: 'Review suggested', evidenceMemberIds: [parentId, spouseId, memberId], evidenceRelationshipIds: parentLinks.filter((link) => link.fromMemberId === parentId && link.toMemberId === spouseId).map((link) => link.id), title: `Consider ${parent?.fullName || 'parent'} as ${member?.fullName || 'family member'}’s ${label}`, reason: `${parent?.fullName || 'This person'} is recorded as parent of ${spouse?.fullName || 'a spouse'} of ${member?.fullName || 'this person'}.` })
  })))

  // Two recorded parents of the same child are commonly a couple. Keep this
  // as medium confidence because a family may deliberately record co-parents
  // without a spouse relationship.
  parentsByChild.forEach((parentIds, childId) => {
    for (let index = 0; index < parentIds.length; index += 1) {
      for (let next = index + 1; next < parentIds.length; next += 1) {
        const sourceId = parentIds[index]; const targetId = parentIds[next]
        const first = memberById.get(sourceId); const second = memberById.get(targetId); const child = memberById.get(childId)
        add({
          id: `spouse:${sourceId}:${targetId}`,
          kind: 'co-parent-spouse',
          sourceId,
          targetId,
          label: 'Spouse',
          confidence: 'Review suggested',
          evidenceMemberIds: [sourceId, targetId, childId],
          evidenceRelationshipIds: parentLinks.filter((link) => link.toMemberId === childId && (link.fromMemberId === sourceId || link.fromMemberId === targetId)).map((link) => link.id),
          title: `Consider linking ${first?.fullName || 'these parents'} and ${second?.fullName || ''} as spouses`,
          reason: `Both are recorded as parents of ${child?.fullName || 'the same child'}. Confirm this only if they should be shown as spouses in your family tree.`,
        })
      }
    }
  })

  return [...suggestions.values()].sort((first, second) => {
    const confidence = { 'High confidence': 0, 'Review suggested': 1 }
    return confidence[first.confidence] - confidence[second.confidence] || first.title.localeCompare(second.title)
  })
}

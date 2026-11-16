import { addDoc, collection, deleteDoc, doc, getDoc, getDocs, orderBy, query, runTransaction, serverTimestamp, setDoc, Timestamp, updateDoc, where, writeBatch } from 'firebase/firestore'
import { auth, db } from './firebase'
import { relationRule } from './catalog'
import { duplicateCandidates, validateRelationships } from './tree'

const clean = (data) => Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined))
const nameParts = (firstName = '', lastName = '') => ({ firstName: firstName.trim(), lastName: lastName?.trim() || null, fullName: [firstName.trim(), lastName?.trim()].filter(Boolean).join(' ') })
const actor = () => ({ actorEmail: auth.currentUser?.email || 'unknown', actorName: auth.currentUser?.displayName || 'Family administrator' })
const log = (batch, groupId, action, entityType, entityId, summary) => batch.set(doc(collection(db, 'activityLogs')), clean({ familyGroupId: groupId, action, entityType, entityId, summary, ...actor(), createdAt: serverTimestamp() }))

export async function loadGroupData(groupId, { includeArchived = false } = {}) {
  const [members, relationships, group] = await Promise.all([getDocs(query(collection(db, 'members'), where('familyGroupId', '==', groupId))), getDocs(query(collection(db, 'relationships'), where('familyGroupId', '==', groupId))), getDoc(doc(db, 'familyGroups', groupId))])
  let memberData = members.docs.map((item) => ({ id: item.id, ...item.data() })).filter((member) => includeArchived || !member.archived)
  if (!memberData.some((member) => member.isRootPerson)) {
    const firstMember = memberData[0]
    if (firstMember) {
      await updateDoc(doc(db, 'members', firstMember.id), { isRootPerson: true, updatedAt: serverTimestamp() })
      memberData = memberData.map((member) => ({ ...member, isRootPerson: member.id === firstMember.id }))
    } else if (members.empty) {
      const name = group.data()?.rootPersonName?.trim() || auth.currentUser?.displayName?.trim() || 'Primary person'
      const rootRef = doc(db, 'members', `${groupId}--root`)
      await setDoc(rootRef, { familyGroupId: groupId, fullName: name, preferredName: name, isRootPerson: true, archived: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true })
      memberData = [...memberData, { id: rootRef.id, familyGroupId: groupId, fullName: name, preferredName: name, isRootPerson: true, archived: false }]
    }
  }
  // Earlier versions created a generated account-name root. If the branch now has a real member
  // and that generated root is not connected to anyone, promote the real member instead.
  const generatedRoot = memberData.find((member) => member.id === `${groupId}--root` && member.isRootPerson)
  const replacementRoot = memberData.find((member) => member.id !== generatedRoot?.id)
  const generatedRootHasLinks = generatedRoot && relationships.docs.some((item) => { const relationship = item.data(); return relationship.fromMemberId === generatedRoot.id || relationship.toMemberId === generatedRoot.id })
  if (generatedRoot && replacementRoot && !generatedRootHasLinks) {
    const batch = writeBatch(db)
    batch.update(doc(db, 'members', generatedRoot.id), { archived: true, archivedAt: serverTimestamp(), legacyGeneratedRoot: true, updatedAt: serverTimestamp() })
    batch.update(doc(db, 'members', replacementRoot.id), { isRootPerson: true, updatedAt: serverTimestamp() })
    await batch.commit()
    memberData = memberData.filter((member) => member.id !== generatedRoot.id).map((member) => ({ ...member, isRootPerson: member.id === replacementRoot.id }))
  }
  // Legacy versions created a literal “Self” root before a real primary person was known.
  // Retire that placeholder only when this branch already has another root person.
  const rootPeople = memberData.filter((member) => member.isRootPerson)
  const placeholderRoots = rootPeople.filter((member) => ['self', 'primary person'].includes(member.fullName?.trim().toLowerCase()))
  const realRoot = rootPeople.find((member) => !placeholderRoots.some((placeholder) => placeholder.id === member.id))
  if (realRoot && placeholderRoots.length) {
    const batch = writeBatch(db)
    placeholderRoots.forEach((placeholder) => batch.update(doc(db, 'members', placeholder.id), { archived: true, archivedAt: serverTimestamp(), legacyPlaceholder: true, updatedAt: serverTimestamp() }))
    await batch.commit()
    memberData = memberData.filter((member) => !placeholderRoots.some((placeholder) => placeholder.id === member.id))
  }
  const activeIds = new Set(memberData.map((member) => member.id))
  return { group: group.exists() ? { id: group.id, ...group.data() } : null, members: memberData, relationships: relationships.docs.map((item) => ({ id: item.id, ...item.data() })).filter((relationship) => activeIds.has(relationship.fromMemberId) && activeIds.has(relationship.toMemberId)) }
}

export async function listGroups() { const snapshot = await getDocs(query(collection(db, 'familyGroups'), orderBy('updatedAt', 'desc'))); return snapshot.docs.map((item) => ({ id: item.id, ...item.data() })) }
export async function listBranchMemberCounts() { const snapshot = await getDocs(collection(db, 'members')); return snapshot.docs.reduce((counts, item) => { const member = item.data(); if (!member.archived && member.familyGroupId) counts[member.familyGroupId] = (counts[member.familyGroupId] || 0) + 1; return counts }, {}) }
export async function saveGroup(data, id) { if (id) return updateDoc(doc(db, 'familyGroups', id), clean({ ...data, updatedAt: serverTimestamp() })); const ref = await addDoc(collection(db, 'familyGroups'), clean({ ...data, ownerEmail: auth.currentUser?.email || '', createdAt: serverTimestamp(), updatedAt: serverTimestamp() })); return ref }

const globalGroupName = (name) => name.trim().replace(/\s+/g, ' ')
const normalizedGlobalGroupName = (name) => globalGroupName(name).toLocaleLowerCase()
const membershipId = (globalGroupId, memberId) => `${globalGroupId}__${memberId}`

export async function listGlobalGroups() { const snapshot = await getDocs(query(collection(db, 'globalGroups'), orderBy('name'))); return snapshot.docs.map((item) => ({ id: item.id, ...item.data() })) }
export async function saveGlobalGroup(data, id) {
  const name = globalGroupName(data.name || '')
  if (!name) throw new Error('A group name is required.')
  const normalizedName = normalizedGlobalGroupName(name)
  const matches = await getDocs(query(collection(db, 'globalGroups'), where('normalizedName', '==', normalizedName)))
  if (matches.docs.some((item) => item.id !== id)) throw new Error('A group with this name already exists.')
  const groupData = clean({ name, normalizedName, description: data.description?.trim() || '', color: data.color || '#5f2f92', updatedAt: serverTimestamp() })
  if (id) { await updateDoc(doc(db, 'globalGroups', id), groupData); return { id } }
  const ref = await addDoc(collection(db, 'globalGroups'), { ...groupData, createdAt: serverTimestamp() })
  return { id: ref.id }
}
export async function listMemberGlobalGroupIds(memberId) { const snapshot = await getDocs(query(collection(db, 'globalGroupMemberships'), where('memberId', '==', memberId))); return snapshot.docs.map((item) => item.data().globalGroupId).filter(Boolean) }
export async function syncMemberGlobalGroups(memberId, familyGroupId, globalGroupIds = []) {
  const desired = new Set(globalGroupIds.filter(Boolean))
  const existing = await getDocs(query(collection(db, 'globalGroupMemberships'), where('memberId', '==', memberId)))
  const operations = []
  existing.docs.forEach((item) => { const groupId = item.data().globalGroupId; if (!desired.has(groupId)) operations.push({ type: 'delete', ref: item.ref }); else desired.delete(groupId) })
  desired.forEach((groupId) => operations.push({ type: 'set', ref: doc(db, 'globalGroupMemberships', membershipId(groupId, memberId)), data: { globalGroupId: groupId, memberId, familyGroupId, updatedAt: serverTimestamp(), createdAt: serverTimestamp() } }))
  await commitWriteOperations(operations)
}
export async function bulkUpdateMembers(groupId, memberIds, { groupActions = {}, hometown = { mode: 'keep', value: '' }, birthPlace = { mode: 'keep', value: '' } } = {}) {
  const ids = [...new Set(memberIds.filter(Boolean))]
  if (!ids.length) throw new Error('Select at least one member.')
  const operations = []
  ids.forEach((memberId) => {
    Object.entries(groupActions).forEach(([globalGroupId, action]) => {
      const ref = doc(db, 'globalGroupMemberships', membershipId(globalGroupId, memberId))
      if (action === 'add') operations.push({ type: 'set', ref, data: { globalGroupId, memberId, familyGroupId: groupId, createdAt: serverTimestamp(), updatedAt: serverTimestamp() } })
      if (action === 'remove') operations.push({ type: 'delete', ref })
    })
    const updates = { updatedAt: serverTimestamp() }
    if (hometown.mode === 'set') updates.hometown = hometown.value.trim()
    if (hometown.mode === 'clear') updates.hometown = ''
    if (birthPlace.mode === 'set') updates.birthPlace = birthPlace.value.trim()
    if (birthPlace.mode === 'clear') updates.birthPlace = ''
    if (Object.keys(updates).length > 1) operations.push({ type: 'set', ref: doc(db, 'members', memberId), data: updates })
  })
  ;[hometown, birthPlace].filter((field) => field.mode === 'set' && field.value.trim()).forEach((field) => operations.push({ type: 'set', ref: doc(db, 'locations', locationId(field.value)), data: { name: field.value.trim(), normalizedName: field.value.trim().toLowerCase(), createdAt: serverTimestamp(), updatedAt: serverTimestamp() } }))
  await commitWriteOperations(operations)
  return ids.length
}
export async function loadGlobalGroupMembers(globalGroupId) {
  const memberships = await getDocs(query(collection(db, 'globalGroupMemberships'), where('globalGroupId', '==', globalGroupId)))
  const entries = await Promise.all(memberships.docs.map(async (item) => { const membership = item.data(); const member = await getDoc(doc(db, 'members', membership.memberId)); return member.exists() ? { membership, member: { id: member.id, ...member.data() } } : null }))
  return entries.filter(Boolean).filter(({ member }) => !member.archived).map(({ membership, member }) => ({ ...member, familyGroupId: membership.familyGroupId || member.familyGroupId }))
}
export async function removeGlobalGroup(globalGroupId) {
  const memberships = await getDocs(query(collection(db, 'globalGroupMemberships'), where('globalGroupId', '==', globalGroupId)))
  await commitWriteOperations(memberships.docs.map((item) => ({ type: 'delete', ref: item.ref })))
  await deleteDoc(doc(db, 'globalGroups', globalGroupId))
}

const locationId = (name) => name.trim().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'location'
export async function listLocations() { const snapshot = await getDocs(collection(db, 'locations')); return snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((first, second) => (first.name || '').localeCompare(second.name || '')) }
export async function listMemberLocationNames() { const snapshot = await getDocs(collection(db, 'members')); return [...new Set(snapshot.docs.flatMap((item) => [item.data().hometown?.trim(), item.data().birthPlace?.trim()]).filter(Boolean))].sort((first, second) => first.localeCompare(second)) }
export async function listMemberLastNames() { const snapshot = await getDocs(collection(db, 'members')); return [...new Set(snapshot.docs.map((item) => { const member = item.data(); return member.lastName?.trim() || String(member.fullName || '').trim().split(/\s+/).slice(1).join(' ') }).filter(Boolean))].sort((first, second) => first.localeCompare(second)) }
export async function saveLocation(name) { const cleanName = name?.trim(); if (!cleanName) return null; const ref = doc(db, 'locations', locationId(cleanName)); const current = await getDoc(ref); await setDoc(ref, { name: cleanName, normalizedName: cleanName.toLowerCase(), updatedAt: serverTimestamp(), createdAt: current.exists() ? current.data().createdAt : serverTimestamp() }, { merge: true }); return { id: ref.id, name: cleanName } }
export async function removeLocation(id) { return deleteDoc(doc(db, 'locations', id)) }

export async function saveMember(data, id) {
  await Promise.all([data.hometown?.trim(), data.birthPlace?.trim()].filter(Boolean).map(saveLocation))
  const { isRootPerson, ...editableData } = data; const names = nameParts(data.firstName, data.lastName)
  const memberData = clean({ ...editableData, ...names, searchText: [names.fullName, data.nickname, data.hometown, data.birthPlace].filter(Boolean).join(' ').toLowerCase(), updatedAt: serverTimestamp() })
  if (id) { await updateDoc(doc(db, 'members', id), memberData); const batch = writeBatch(db); log(batch, data.familyGroupId, 'member.updated', 'member', id, `Updated ${names.fullName}`); await batch.commit(); return { id } }
  const ref = await addDoc(collection(db, 'members'), { ...memberData, archived: false, createdAt: serverTimestamp() }); const batch = writeBatch(db); log(batch, data.familyGroupId, 'member.created', 'member', ref.id, `Added ${names.fullName}`); await batch.commit(); return ref
}

export async function migrateMemberNames() {
  const snapshot = await getDocs(collection(db, 'members')); const updates = snapshot.docs.filter((item) => !item.data().firstName?.trim()).map((item) => { const parts = String(item.data().fullName || '').trim().split(/\s+/).filter(Boolean); const names = nameParts(parts[0] || '', parts.slice(1).join(' ')); return { ref: item.ref, data: { ...names, searchText: [names.fullName, item.data().nickname, item.data().hometown, item.data().birthPlace].filter(Boolean).join(' ').toLowerCase(), updatedAt: serverTimestamp() } } }); for (let start = 0; start < updates.length; start += 400) { const batch = writeBatch(db); updates.slice(start, start + 400).forEach((item) => batch.update(item.ref, item.data)); await batch.commit() } return updates.length
}

export async function migrateSiblingLabels() {
  const snapshot = await getDocs(collection(db, 'relationships'))
  const updates = snapshot.docs.filter((item) => ['bhai', 'ben', 'brother', 'sister'].includes(String(item.data().label || '').trim().toLowerCase()))
  for (let start = 0; start < updates.length; start += 400) { const batch = writeBatch(db); updates.slice(start, start + 400).forEach((item) => batch.update(item.ref, { label: 'Sibling', type: 'relative', updatedAt: serverTimestamp() })); await batch.commit() }
  return updates.length
}

export async function saveBulkMembers(groupId, rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('Add at least one member.')
  if (rows.length > 50) throw new Error('A bulk entry can contain up to 50 members.')
  const current = await loadGroupData(groupId)
  const refs = new Map(rows.map((row) => [row.id, doc(collection(db, 'members'))]))
  const candidates = rows.map((row) => ({ id: refs.get(row.id).id, familyGroupId: groupId, ...nameParts(row.firstName, row.lastName), hometown: row.hometown?.trim() || '', gender: row.gender || 'male', lifeStatus: row.lifeStatus || 'living', archived: false, isRootPerson: false }))
  rows.forEach((row, index) => { if (!row.firstName?.trim()) throw new Error(`Row ${index + 1}: first name is required.`); if (duplicateCandidates(candidates[index], [...current.members, ...candidates.filter((_, other) => other !== index)]).length) throw new Error(`Row ${index + 1}: this looks like a duplicate member.`); if (Boolean(row.relatedTo) !== Boolean(row.label?.trim())) throw new Error(`Row ${index + 1}: choose both a related person and relationship label, or leave both blank.`) })
  const resolveTarget = (value) => value?.startsWith('new:') ? refs.get(value.slice(4))?.id : value
  const links = rows.filter((row) => row.relatedTo && row.label?.trim()).map((row) => { const memberId = refs.get(row.id).id; const targetId = resolveTarget(row.relatedTo); if (!targetId || targetId === memberId) throw new Error('A member cannot be related to themself.'); const rule = relationRule(row.label); return { familyGroupId: groupId, label: row.label.trim(), type: rule.type, fromMemberId: rule.relatedIs === 'parent' ? targetId : memberId, toMemberId: rule.relatedIs === 'parent' ? memberId : targetId } })
  const issues = validateRelationships([...current.members, ...candidates], [...current.relationships, ...links]); if (issues.length) throw new Error(issues[0])
  const batch = writeBatch(db)
  candidates.forEach((member) => batch.set(refs.get(rows.find((row) => refs.get(row.id).id === member.id).id), { ...member, searchText: [member.fullName, member.hometown].filter(Boolean).join(' ').toLowerCase(), createdAt: serverTimestamp(), updatedAt: serverTimestamp() }))
  links.forEach((relationship) => batch.set(doc(db, 'relationships', `${groupId}__${[relationship.fromMemberId, relationship.toMemberId].sort().join('__')}`), { ...relationship, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }))
  ;[...new Set(candidates.map((member) => member.hometown).filter(Boolean))].forEach((name) => batch.set(doc(db, 'locations', locationId(name)), { name, normalizedName: name.toLowerCase(), createdAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true }))
  log(batch, groupId, 'members.bulk_created', 'member', groupId, `Added ${candidates.length} members and ${links.length} relationships`)
  await batch.commit(); return candidates
}

export async function setPrimaryPerson(groupId, memberId) { const snapshot = await getDocs(query(collection(db, 'members'), where('familyGroupId', '==', groupId))); const batch = writeBatch(db); snapshot.docs.forEach((item) => batch.update(item.ref, { isRootPerson: item.id === memberId, updatedAt: serverTimestamp() })); log(batch, groupId, 'member.primary_changed', 'member', memberId, 'Changed the primary person'); return batch.commit() }

export async function saveRelationship(data, existingId) {
  const { editingMemberId, ...relationshipData } = data
  const rule = editingMemberId ? relationRule(relationshipData.label || '') : null
  const relatedMemberId = editingMemberId && (relationshipData.fromMemberId === editingMemberId ? relationshipData.toMemberId : relationshipData.fromMemberId)
  const oriented = relatedMemberId && rule?.relatedIs === 'parent' ? { ...relationshipData, fromMemberId: relatedMemberId, toMemberId: editingMemberId, type: rule.type } : relatedMemberId && rule?.relatedIs === 'child' ? { ...relationshipData, fromMemberId: editingMemberId, toMemberId: relatedMemberId, type: rule.type } : relationshipData
  if (oriented.fromMemberId === oriented.toMemberId) throw new Error('A person cannot be related to themself.')
  const normalized = clean({ ...oriented, label: oriented.label.trim(), type: oriented.type || 'relative', updatedAt: serverTimestamp() })
  const pairId = [normalized.fromMemberId, normalized.toMemberId].sort().join('__'); const id = existingId || `${normalized.familyGroupId}__${pairId}`; const ref = doc(db, 'relationships', id)
  await runTransaction(db, async (transaction) => {
    const current = await transaction.get(ref)
    transaction.set(ref, { ...normalized, createdAt: current.exists() ? current.data().createdAt : serverTimestamp() }, { merge: true })
  })
  const batch = writeBatch(db); log(batch, normalized.familyGroupId, existingId ? 'relationship.updated' : 'relationship.created', 'relationship', id, normalized.label || normalized.type); await batch.commit(); return { id }
}

export async function updateRelationship(id, data) { const ref = doc(db, 'relationships', id); const existing = await getDoc(ref); if (!existing.exists()) throw new Error('Relationship no longer exists.'); return saveRelationship({ ...existing.data(), ...data }, id) }
export async function deleteRelationship(id) { const ref = doc(db, 'relationships', id); const item = await getDoc(ref); if (!item.exists()) return; const batch = writeBatch(db); batch.delete(ref); log(batch, item.data().familyGroupId, 'relationship.deleted', 'relationship', id, item.data().label || item.data().type); return batch.commit() }
const dismissedSuggestionId = (groupId, suggestionId) => `${groupId}__${encodeURIComponent(suggestionId)}`
export async function listDismissedSuggestions(groupId) { const snapshot = await getDocs(query(collection(db, 'dismissedSuggestions'), where('familyGroupId', '==', groupId))); return snapshot.docs.map((item) => ({ id: item.id, ...item.data() })) }
export async function dismissSuggestion(groupId, suggestion) { const ref = doc(db, 'dismissedSuggestions', dismissedSuggestionId(groupId, suggestion.id)); await setDoc(ref, { familyGroupId: groupId, suggestionId: suggestion.id, sourceId: suggestion.sourceId, targetId: suggestion.targetId, label: suggestion.label, kind: suggestion.kind, dismissedAt: serverTimestamp(), ...actor() }, { merge: true }); return suggestion.id }
export async function listMemberRelationships(groupId, memberId) { const snapshot = await getDocs(query(collection(db, 'relationships'), where('familyGroupId', '==', groupId))); return snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).filter((item) => item.fromMemberId === memberId || item.toMemberId === memberId) }
export async function getRelationship(id) { const item = await getDoc(doc(db, 'relationships', id)); return item.exists() ? { id: item.id, ...item.data() } : null }
export async function archiveMember(id, groupId) { const batch = writeBatch(db); batch.update(doc(db, 'members', id), { archived: true, archivedAt: serverTimestamp(), updatedAt: serverTimestamp() }); log(batch, groupId, 'member.archived', 'member', id, 'Moved member to Trash'); return batch.commit() }
export async function restoreMember(id, groupId) { const batch = writeBatch(db); batch.update(doc(db, 'members', id), { archived: false, archivedAt: null, updatedAt: serverTimestamp() }); log(batch, groupId, 'member.restored', 'member', id, 'Restored member from Trash'); return batch.commit() }
export async function listTrash(groupId) { const snapshot = await getDocs(query(collection(db, 'members'), where('familyGroupId', '==', groupId))); return snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).filter((item) => item.archived) }
export async function listActivity(groupId) { const snapshot = await getDocs(query(collection(db, 'activityLogs'), where('familyGroupId', '==', groupId))); return snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)).slice(0, 50) }
export async function mergeMembers(primaryId, duplicateId, groupId) { const [links, duplicate, duplicateMemberships] = await Promise.all([getDocs(query(collection(db, 'relationships'), where('familyGroupId', '==', groupId))), getDoc(doc(db, 'members', duplicateId)), getDocs(query(collection(db, 'globalGroupMemberships'), where('memberId', '==', duplicateId)))]); if (!duplicate.exists()) throw new Error('Duplicate member no longer exists.')
  const batch = writeBatch(db); links.docs.forEach((item) => { const data = item.data(); if (data.fromMemberId === duplicateId || data.toMemberId === duplicateId) { const replacement = { ...data, fromMemberId: data.fromMemberId === duplicateId ? primaryId : data.fromMemberId, toMemberId: data.toMemberId === duplicateId ? primaryId : data.toMemberId }; if (replacement.fromMemberId === replacement.toMemberId) batch.delete(item.ref); else { batch.set(doc(db, 'relationships', `${groupId}__${[replacement.fromMemberId, replacement.toMemberId].sort().join('__')}`), replacement, { merge: true }); batch.delete(item.ref) } } }); duplicateMemberships.docs.forEach((item) => { const data = item.data(); batch.set(doc(db, 'globalGroupMemberships', membershipId(data.globalGroupId, primaryId)), { ...data, memberId: primaryId, familyGroupId: groupId, updatedAt: serverTimestamp() }, { merge: true }); batch.delete(item.ref) }); batch.update(doc(db, 'members', duplicateId), { archived: true, mergedInto: primaryId, updatedAt: serverTimestamp() }); log(batch, groupId, 'member.merged', 'member', duplicateId, `Merged into ${primaryId}`); return batch.commit() }
export async function removeGroup(groupId) { const [data, memberships, dismissed, activity] = await Promise.all([loadGroupData(groupId, { includeArchived: true }), getDocs(query(collection(db, 'globalGroupMemberships'), where('familyGroupId', '==', groupId))), getDocs(query(collection(db, 'dismissedSuggestions'), where('familyGroupId', '==', groupId))), getDocs(query(collection(db, 'activityLogs'), where('familyGroupId', '==', groupId)))]); await commitWriteOperations(memberships.docs.map((item) => ({ type: 'delete', ref: item.ref }))); const operations = [...data.members.map((item) => ({ type: 'delete', ref: doc(db, 'members', item.id) })), ...data.relationships.map((item) => ({ type: 'delete', ref: doc(db, 'relationships', item.id) })), ...dismissed.docs.map((item) => ({ type: 'delete', ref: item.ref })), ...activity.docs.map((item) => ({ type: 'delete', ref: item.ref }))]; await commitWriteOperations(operations); return deleteDoc(doc(db, 'familyGroups', groupId)) }

const isEmptyExportValue = (value) => value === null || value === undefined || (typeof value === 'string' && (!value.trim() || ['none', 'n/a', 'na', 'null', 'undefined'].includes(value.trim().toLowerCase())))
const compactForExport = (value) => {
  if (Array.isArray(value)) return value.map(compactForExport).filter((item) => !isEmptyExportValue(item))
  if (value && typeof value === 'object' && !(value instanceof Date)) return Object.fromEntries(Object.entries(value).filter(([, item]) => !isEmptyExportValue(item)).map(([key, item]) => [key, compactForExport(item)]))
  return value
}
export function exportBackup(group, members, relationships) { return JSON.stringify(compactForExport({ version: 2, exportedAt: new Date().toISOString(), group, members, relationships }), null, 2) }
const importableMember = (member) => { const { id, familyGroupId, createdAt, updatedAt, archivedAt, mergedInto, ...data } = member || {}; return clean({ ...data, archived: false }) }
const importableRelationship = (relationship) => { const { id, familyGroupId, createdAt, updatedAt, ...data } = relationship || {}; return clean(data) }
const commitWriteOperations = async (operations) => { for (let start = 0; start < operations.length; start += 400) { const batch = writeBatch(db); operations.slice(start, start + 400).forEach((operation) => { if (operation.type === 'delete') batch.delete(operation.ref); else batch.set(operation.ref, operation.data, { merge: true }) }); await batch.commit() } }
const commitChunks = async (items, write) => { for (let start = 0; start < items.length; start += 400) { const batch = writeBatch(db); items.slice(start, start + 400).forEach((item) => write(batch, item)); await batch.commit() } }
export async function importBranchBackup(backup, branchName) {
  if (!backup || !Array.isArray(backup.members) || !Array.isArray(backup.relationships)) throw new Error('This is not a valid Family Tree branch backup.')
  const name = branchName?.trim() || backup.group?.name?.trim() || 'Imported family branch'
  const groupRef = await addDoc(collection(db, 'familyGroups'), { name, description: backup.group?.description || 'Imported from a Family Tree backup.', coverColor: backup.group?.coverColor || '#5f2f92', ownerEmail: auth.currentUser?.email || '', importedAt: serverTimestamp(), createdAt: serverTimestamp(), updatedAt: serverTimestamp() })
  const memberMap = new Map(); const importedMembers = backup.members.filter((member) => member?.id && member.fullName)
  const rootId = importedMembers.find((member) => member.isRootPerson)?.id || importedMembers[0]?.id
  const memberWrites = importedMembers.map((member) => { const ref = doc(collection(db, 'members')); memberMap.set(member.id, ref.id); return { ref, member } })
  await commitChunks(memberWrites, (batch, { ref, member }) => batch.set(ref, { ...importableMember(member), familyGroupId: groupRef.id, isRootPerson: member.id === rootId, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }))
  const relationshipWrites = backup.relationships.filter((relationship) => memberMap.has(relationship?.fromMemberId) && memberMap.has(relationship?.toMemberId) && relationship.fromMemberId !== relationship.toMemberId).map((relationship) => ({ ref: doc(collection(db, 'relationships')), relationship }))
  await commitChunks(relationshipWrites, (batch, { ref, relationship }) => batch.set(ref, { ...importableRelationship(relationship), familyGroupId: groupRef.id, fromMemberId: memberMap.get(relationship.fromMemberId), toMemberId: memberMap.get(relationship.toMemberId), label: String(relationship.label || relationship.type || 'Relative').trim(), type: ['parent_child', 'spouse', 'relative'].includes(relationship.type) ? relationship.type : 'relative', createdAt: serverTimestamp(), updatedAt: serverTimestamp() }))
  const batch = writeBatch(db); log(batch, groupRef.id, 'branch.imported', 'familyGroup', groupRef.id, `Imported ${importedMembers.length} members and ${relationshipWrites.length} relationships`); await batch.commit()
  return { id: groupRef.id, name }
}
export function exportCsv(members) { const columns = ['fullName', 'nickname', 'hometown', 'birthPlace', 'birthDate', 'gender', 'occupation']; const esc = (value) => `"${String(value || '').replaceAll('"', '""')}"`; return [columns.join(','), ...members.map((member) => columns.map((key) => esc(member[key])).join(','))].join('\n') }

// Full backups deliberately preserve document IDs.  Relationships and global memberships
// refer to those IDs, so generating new IDs during a disaster recovery restore would corrupt
// the tree even if every individual document was copied successfully.
export const FULL_BACKUP_COLLECTIONS = ['familyGroups', 'members', 'relationships', 'globalGroups', 'globalGroupMemberships', 'locations', 'memberLabels', 'dismissedSuggestions', 'activityLogs']
const FULL_BACKUP_VERSION = 1
const BACKUP_TIMESTAMP = '__familyTreeTimestamp__'
const isTimestamp = (value) => value instanceof Timestamp || (value && typeof value.toDate === 'function' && typeof value.seconds === 'number')
const encodeBackupValue = (value) => {
  if (isTimestamp(value)) return { [BACKUP_TIMESTAMP]: true, seconds: value.seconds, nanoseconds: value.nanoseconds || 0 }
  if (value instanceof Date) return { [BACKUP_TIMESTAMP]: true, seconds: Math.floor(value.getTime() / 1000), nanoseconds: (value.getTime() % 1000) * 1000000 }
  if (Array.isArray(value)) return value.map(encodeBackupValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeBackupValue(item)]))
  return value
}
const decodeBackupValue = (value) => {
  if (Array.isArray(value)) return value.map(decodeBackupValue)
  if (value && typeof value === 'object') {
    if (value[BACKUP_TIMESTAMP] === true && Number.isFinite(value.seconds)) return new Timestamp(value.seconds, value.nanoseconds || 0)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeBackupValue(item)]))
  }
  return value
}
const backupPayload = (backup) => ({ format: backup.format, version: backup.version, exportedAt: backup.exportedAt, collections: backup.collections })
const digest = async (value) => {
  if (!globalThis.crypto?.subtle) throw new Error('This browser cannot verify secure backup checksums.')
  const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
const backupSummary = (backup) => Object.fromEntries(FULL_BACKUP_COLLECTIONS.map((name) => [name, backup.collections[name]?.length || 0]))

export async function createFullBackup() {
  const snapshots = await Promise.all(FULL_BACKUP_COLLECTIONS.map((name) => getDocs(collection(db, name))))
  const collections = Object.fromEntries(FULL_BACKUP_COLLECTIONS.map((name, index) => [name, snapshots[index].docs.map((item) => ({ id: item.id, data: encodeBackupValue(item.data()) }))]))
  const backup = { format: 'family-tree-full-backup', version: FULL_BACKUP_VERSION, exportedAt: new Date().toISOString(), collections }
  backup.checksum = await digest(backupPayload(backup))
  return { backup, text: JSON.stringify(backup, null, 2), summary: backupSummary(backup) }
}

const backupEntries = (backup, name) => backup.collections[name] || []
const assertReferences = (backup) => {
  const ids = (name) => new Set(backupEntries(backup, name).map((entry) => entry.id))
  const groupIds = ids('familyGroups'); const memberIds = ids('members'); const globalGroupIds = ids('globalGroups')
  backupEntries(backup, 'members').forEach(({ data }, index) => { if (!groupIds.has(data.familyGroupId)) throw new Error(`Member ${index + 1} references a missing family branch.`) })
  backupEntries(backup, 'relationships').forEach(({ data }, index) => {
    if (!groupIds.has(data.familyGroupId) || !memberIds.has(data.fromMemberId) || !memberIds.has(data.toMemberId) || data.fromMemberId === data.toMemberId) throw new Error(`Relationship ${index + 1} has invalid member or branch references.`)
  })
  backupEntries(backup, 'globalGroupMemberships').forEach(({ data }, index) => {
    if (!globalGroupIds.has(data.globalGroupId) || !memberIds.has(data.memberId) || !groupIds.has(data.familyGroupId)) throw new Error(`Global group membership ${index + 1} has invalid references.`)
  })
}

export async function parseFullBackup(text) {
  let backup
  try { backup = JSON.parse(text) } catch { throw new Error('This file is not valid JSON.') }
  if (backup?.format !== 'family-tree-full-backup' || backup.version !== FULL_BACKUP_VERSION || !backup.collections || typeof backup.checksum !== 'string') throw new Error('This is not a supported full Family Tree backup.')
  FULL_BACKUP_COLLECTIONS.forEach((name) => {
    if (!Array.isArray(backup.collections[name])) throw new Error(`Backup is missing the ${name} collection.`)
    const seen = new Set()
    backup.collections[name].forEach((entry) => { if (!entry || typeof entry.id !== 'string' || !entry.id || !entry.data || typeof entry.data !== 'object' || seen.has(entry.id)) throw new Error(`Backup has an invalid record in ${name}.`); seen.add(entry.id) })
  })
  if (await digest(backupPayload(backup)) !== backup.checksum) throw new Error('Backup checksum does not match. Choose an unmodified backup file.')
  assertReferences(backup)
  return { backup, summary: backupSummary(backup) }
}

const restoreOrder = ['familyGroups', 'locations', 'globalGroups', 'members', 'memberLabels', 'relationships', 'globalGroupMemberships', 'dismissedSuggestions', 'activityLogs']
const deleteOrder = [...restoreOrder].reverse()
const commitBackupChunks = async (entries, write, progress, phase, collectionName, total, completed) => {
  for (let start = 0; start < entries.length; start += 400) {
    const batch = writeBatch(db)
    entries.slice(start, start + 400).forEach((entry) => write(batch, entry))
    await batch.commit()
    completed.value += Math.min(400, entries.length - start)
    progress?.({ phase, collection: collectionName, completed: completed.value, total })
  }
}

export async function restoreFullBackup(backup, onProgress) {
  const { backup: validBackup } = await parseFullBackup(JSON.stringify(backup))
  const existingSnapshots = await Promise.all(FULL_BACKUP_COLLECTIONS.map((name) => getDocs(collection(db, name))))
  const total = existingSnapshots.reduce((sum, snapshot) => sum + snapshot.size, 0) + FULL_BACKUP_COLLECTIONS.reduce((sum, name) => sum + backupEntries(validBackup, name).length, 0)
  const completed = { value: 0 }
  for (const collectionName of deleteOrder) {
    const snapshot = existingSnapshots[FULL_BACKUP_COLLECTIONS.indexOf(collectionName)]
    await commitBackupChunks(snapshot.docs.map((item) => ({ id: item.id })), (batch, entry) => batch.delete(doc(db, collectionName, entry.id)), onProgress, 'Removing current data', collectionName, total, completed)
  }
  for (const collectionName of restoreOrder) {
    await commitBackupChunks(backupEntries(validBackup, collectionName), (batch, entry) => batch.set(doc(db, collectionName, entry.id), decodeBackupValue(entry.data)), onProgress, 'Restoring backup', collectionName, total, completed)
  }
  const restored = await Promise.all(FULL_BACKUP_COLLECTIONS.map((name) => getDocs(collection(db, name))))
  const expected = backupSummary(validBackup)
  FULL_BACKUP_COLLECTIONS.forEach((name, index) => { if (restored[index].size !== expected[name]) throw new Error(`Restore verification failed for ${name}. Keep the recovery backup and try again.`) })
  assertReferences(validBackup)
  onProgress?.({ phase: 'Verified', collection: '', completed: total, total })
  return expected
}

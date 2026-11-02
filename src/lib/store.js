import { addDoc, collection, deleteDoc, doc, getDoc, getDocs, orderBy, query, runTransaction, serverTimestamp, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore'
import { auth, db } from './firebase'

const clean = (data) => Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined))
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
    } else {
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
export async function saveGroup(data, id) { if (id) return updateDoc(doc(db, 'familyGroups', id), clean({ ...data, updatedAt: serverTimestamp() })); const ref = await addDoc(collection(db, 'familyGroups'), clean({ ...data, ownerEmail: auth.currentUser?.email || '', createdAt: serverTimestamp(), updatedAt: serverTimestamp() })); return ref }

const locationId = (name) => name.trim().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'location'
export async function listLocations() { const snapshot = await getDocs(collection(db, 'locations')); return snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((first, second) => (first.name || '').localeCompare(second.name || '')) }
export async function listMemberLocationNames() { const snapshot = await getDocs(collection(db, 'members')); return [...new Set(snapshot.docs.map((item) => item.data().hometown?.trim()).filter(Boolean))].sort((first, second) => first.localeCompare(second)) }
export async function saveLocation(name) { const cleanName = name?.trim(); if (!cleanName) return null; const ref = doc(db, 'locations', locationId(cleanName)); const current = await getDoc(ref); await setDoc(ref, { name: cleanName, normalizedName: cleanName.toLowerCase(), updatedAt: serverTimestamp(), createdAt: current.exists() ? current.data().createdAt : serverTimestamp() }, { merge: true }); return { id: ref.id, name: cleanName } }
export async function removeLocation(id) { return deleteDoc(doc(db, 'locations', id)) }

export async function saveMember(data, id) {
  if (data.hometown?.trim()) await saveLocation(data.hometown)
  const { isRootPerson, ...editableData } = data
  const memberData = clean({ ...editableData, fullName: data.fullName?.trim(), searchText: [data.fullName, data.preferredName, data.nickname, data.hometown, data.surname].filter(Boolean).join(' ').toLowerCase(), updatedAt: serverTimestamp() })
  if (id) { await updateDoc(doc(db, 'members', id), memberData); const batch = writeBatch(db); log(batch, data.familyGroupId, 'member.updated', 'member', id, `Updated ${data.fullName}`); await batch.commit(); return { id } }
  const ref = await addDoc(collection(db, 'members'), { ...memberData, archived: false, createdAt: serverTimestamp() }); const batch = writeBatch(db); log(batch, data.familyGroupId, 'member.created', 'member', ref.id, `Added ${data.fullName}`); await batch.commit(); return ref
}

export async function setPrimaryPerson(groupId, memberId) { const snapshot = await getDocs(query(collection(db, 'members'), where('familyGroupId', '==', groupId))); const batch = writeBatch(db); snapshot.docs.forEach((item) => batch.update(item.ref, { isRootPerson: item.id === memberId, updatedAt: serverTimestamp() })); log(batch, groupId, 'member.primary_changed', 'member', memberId, 'Changed the primary person'); return batch.commit() }

export async function saveRelationship(data, existingId) {
  if (data.fromMemberId === data.toMemberId) throw new Error('A person cannot be related to themself.')
  const normalized = clean({ ...data, label: data.label.trim(), type: data.type || 'relative', updatedAt: serverTimestamp() })
  const pairId = [normalized.fromMemberId, normalized.toMemberId].sort().join('__'); const id = existingId || `${normalized.familyGroupId}__${pairId}`; const ref = doc(db, 'relationships', id)
  await runTransaction(db, async (transaction) => {
    const current = await transaction.get(ref)
    transaction.set(ref, { ...normalized, createdAt: current.exists() ? current.data().createdAt : serverTimestamp() }, { merge: true })
  })
  const batch = writeBatch(db); log(batch, normalized.familyGroupId, existingId ? 'relationship.updated' : 'relationship.created', 'relationship', id, normalized.label || normalized.type); await batch.commit(); return { id }
}

export async function updateRelationship(id, data) { const ref = doc(db, 'relationships', id); const existing = await getDoc(ref); if (!existing.exists()) throw new Error('Relationship no longer exists.'); return saveRelationship({ ...existing.data(), ...data }, id) }
export async function deleteRelationship(id) { const ref = doc(db, 'relationships', id); const item = await getDoc(ref); if (!item.exists()) return; const batch = writeBatch(db); batch.delete(ref); log(batch, item.data().familyGroupId, 'relationship.deleted', 'relationship', id, item.data().label || item.data().type); return batch.commit() }
export async function listMemberRelationships(groupId, memberId) { const snapshot = await getDocs(query(collection(db, 'relationships'), where('familyGroupId', '==', groupId))); return snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).filter((item) => item.fromMemberId === memberId || item.toMemberId === memberId) }
export async function getRelationship(id) { const item = await getDoc(doc(db, 'relationships', id)); return item.exists() ? { id: item.id, ...item.data() } : null }
export async function archiveMember(id, groupId) { const batch = writeBatch(db); batch.update(doc(db, 'members', id), { archived: true, archivedAt: serverTimestamp(), updatedAt: serverTimestamp() }); log(batch, groupId, 'member.archived', 'member', id, 'Moved member to Trash'); return batch.commit() }
export async function restoreMember(id, groupId) { const batch = writeBatch(db); batch.update(doc(db, 'members', id), { archived: false, archivedAt: null, updatedAt: serverTimestamp() }); log(batch, groupId, 'member.restored', 'member', id, 'Restored member from Trash'); return batch.commit() }
export async function listTrash(groupId) { const snapshot = await getDocs(query(collection(db, 'members'), where('familyGroupId', '==', groupId))); return snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).filter((item) => item.archived) }
export async function listActivity(groupId) { const snapshot = await getDocs(query(collection(db, 'activityLogs'), where('familyGroupId', '==', groupId))); return snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)).slice(0, 50) }
export async function mergeMembers(primaryId, duplicateId, groupId) { const [links, duplicate] = await Promise.all([getDocs(query(collection(db, 'relationships'), where('familyGroupId', '==', groupId))), getDoc(doc(db, 'members', duplicateId))]); if (!duplicate.exists()) throw new Error('Duplicate member no longer exists.')
  const batch = writeBatch(db); links.docs.forEach((item) => { const data = item.data(); if (data.fromMemberId === duplicateId || data.toMemberId === duplicateId) { const replacement = { ...data, fromMemberId: data.fromMemberId === duplicateId ? primaryId : data.fromMemberId, toMemberId: data.toMemberId === duplicateId ? primaryId : data.toMemberId }; if (replacement.fromMemberId === replacement.toMemberId) batch.delete(item.ref); else { batch.set(doc(db, 'relationships', `${groupId}__${[replacement.fromMemberId, replacement.toMemberId].sort().join('__')}`), replacement, { merge: true }); batch.delete(item.ref) } } }); batch.update(doc(db, 'members', duplicateId), { archived: true, mergedInto: primaryId, updatedAt: serverTimestamp() }); log(batch, groupId, 'member.merged', 'member', duplicateId, `Merged into ${primaryId}`); return batch.commit() }
export async function removeGroup(groupId) { const data = await loadGroupData(groupId, { includeArchived: true }); const batch = writeBatch(db); data.members.forEach((item) => batch.delete(doc(db, 'members', item.id))); data.relationships.forEach((item) => batch.delete(doc(db, 'relationships', item.id))); batch.delete(doc(db, 'familyGroups', groupId)); return batch.commit() }

const isEmptyExportValue = (value) => value === null || value === undefined || (typeof value === 'string' && (!value.trim() || ['none', 'n/a', 'na', 'null', 'undefined'].includes(value.trim().toLowerCase())))
const compactForExport = (value) => {
  if (Array.isArray(value)) return value.map(compactForExport).filter((item) => !isEmptyExportValue(item))
  if (value && typeof value === 'object' && !(value instanceof Date)) return Object.fromEntries(Object.entries(value).filter(([, item]) => !isEmptyExportValue(item)).map(([key, item]) => [key, compactForExport(item)]))
  return value
}
export function exportBackup(group, members, relationships) { return JSON.stringify(compactForExport({ version: 2, exportedAt: new Date().toISOString(), group, members, relationships }), null, 2) }
const importableMember = (member) => { const { id, familyGroupId, createdAt, updatedAt, archivedAt, mergedInto, ...data } = member || {}; return clean({ ...data, archived: false }) }
const importableRelationship = (relationship) => { const { id, familyGroupId, createdAt, updatedAt, ...data } = relationship || {}; return clean(data) }
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
export function exportCsv(members) { const columns = ['fullName', 'preferredName', 'nickname', 'surname', 'hometown', 'birthDate', 'gender', 'occupation']; const esc = (value) => `"${String(value || '').replaceAll('"', '""')}"`; return [columns.join(','), ...members.map((member) => columns.map((key) => esc(member[key])).join(','))].join('\n') }

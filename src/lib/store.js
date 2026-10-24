import { addDoc, collection, doc, getDoc, getDocs, orderBy, query, runTransaction, serverTimestamp, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore'
import { auth, db } from './firebase'

const clean = (data) => Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined))
const actor = () => ({ actorEmail: auth.currentUser?.email || 'unknown', actorName: auth.currentUser?.displayName || 'Family administrator' })
const log = (batch, groupId, action, entityType, entityId, summary) => batch.set(doc(collection(db, 'activityLogs')), clean({ familyGroupId: groupId, action, entityType, entityId, summary, ...actor(), createdAt: serverTimestamp() }))

export async function loadGroupData(groupId, { includeArchived = false } = {}) {
  const [members, relationships, group] = await Promise.all([getDocs(query(collection(db, 'members'), where('familyGroupId', '==', groupId))), getDocs(query(collection(db, 'relationships'), where('familyGroupId', '==', groupId))), getDoc(doc(db, 'familyGroups', groupId))])
  let memberData = members.docs.map((item) => ({ id: item.id, ...item.data() })).filter((member) => includeArchived || !member.archived)
  if (!memberData.some((member) => member.isRootPerson)) {
    const name = group.data()?.rootPersonName?.trim() || auth.currentUser?.displayName?.trim() || 'Primary person'
    const rootRef = doc(db, 'members', `${groupId}--root`)
    await setDoc(rootRef, { familyGroupId: groupId, fullName: name, preferredName: name, isRootPerson: true, archived: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true })
    memberData = [...memberData, { id: rootRef.id, familyGroupId: groupId, fullName: name, preferredName: name, isRootPerson: true, archived: false }]
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

export async function saveMember(data, id) {
  const memberData = clean({ ...data, fullName: data.fullName?.trim(), searchText: [data.fullName, data.preferredName, data.nickname, data.hometown, data.surname].filter(Boolean).join(' ').toLowerCase(), updatedAt: serverTimestamp() })
  if (id) { await updateDoc(doc(db, 'members', id), memberData); const batch = writeBatch(db); log(batch, data.familyGroupId, 'member.updated', 'member', id, `Updated ${data.fullName}`); await batch.commit(); return { id } }
  const ref = await addDoc(collection(db, 'members'), { ...memberData, archived: false, createdAt: serverTimestamp() }); const batch = writeBatch(db); log(batch, data.familyGroupId, 'member.created', 'member', ref.id, `Added ${data.fullName}`); await batch.commit(); return ref
}

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

export function exportBackup(group, members, relationships) { return JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), group, members, relationships }, null, 2) }
export function exportCsv(members) { const columns = ['fullName', 'preferredName', 'nickname', 'surname', 'hometown', 'birthDate', 'gender', 'occupation']; const esc = (value) => `"${String(value || '').replaceAll('"', '""')}"`; return [columns.join(','), ...members.map((member) => columns.map((key) => esc(member[key])).join(','))].join('\n') }

import { addDoc, collection, deleteDoc, doc, getDoc, getDocs, orderBy, query, serverTimestamp, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore'
import { auth, db } from './firebase'

const clean = (data) => Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined && value !== ''))
export async function loadGroupData(groupId) {
  await cleanupVoidMembers()
  const [members, relationships, group] = await Promise.all([
    getDocs(query(collection(db, 'members'), where('familyGroupId', '==', groupId))),
    getDocs(query(collection(db, 'relationships'), where('familyGroupId', '==', groupId))),
    getDoc(doc(db, 'familyGroups', groupId)),
  ])
  let memberData = members.docs.map((d) => ({ id: d.id, ...d.data() }))
  // Older or interrupted branches get their saved primary person as an editable root.
  if (!memberData.some((member) => !member.archived)) {
    const primaryName = group.data()?.rootPersonName?.trim() || auth.currentUser?.displayName?.trim() || 'Primary person'
    const rootRef = doc(db, 'members', `${groupId}--root`)
    await setDoc(rootRef, {
      familyGroupId: groupId,
      fullName: primaryName,
      preferredName: primaryName,
      isRootPerson: true,
      archived: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true })
    memberData.push({ id: rootRef.id, fullName: primaryName, preferredName: primaryName, isRootPerson: true, archived: false, familyGroupId: groupId })
  }
  const placeholderRoots = memberData.filter((member) => member.isRootPerson && member.fullName === 'Self')
  if (placeholderRoots.length) {
    const primaryName = group.data()?.rootPersonName?.trim() || auth.currentUser?.displayName?.trim() || 'Primary person'
    const firstPlaceholder = placeholderRoots[0].id
    memberData = memberData.filter((member) => member.fullName !== 'Self' || !member.isRootPerson || member.id === firstPlaceholder).map((member) => member.id === firstPlaceholder ? { ...member, fullName: primaryName, preferredName: primaryName } : member)
  }
  const rootPeople = memberData.filter((member) => member.isRootPerson && !member.archived)
  const primaryRoot = rootPeople.find((member) => member.id === group.data()?.rootMemberId) || rootPeople.find((member) => member.fullName !== 'Self' && member.fullName !== 'Primary person') || rootPeople[0]
  const duplicateRootIds = new Set(rootPeople.filter((member) => member.id !== primaryRoot?.id).map((member) => member.id))
  if (duplicateRootIds.size) memberData = memberData.filter((member) => !duplicateRootIds.has(member.id))
  const spouseLabels = new Set(['wife', 'husband', 'spouse', 'partner'])
  const relationshipData = relationships.docs.map((d) => ({ id: d.id, ...d.data() })).map((relationship) => {
    const fromMemberId = duplicateRootIds.has(relationship.fromMemberId) ? primaryRoot.id : relationship.fromMemberId
    const toMemberId = duplicateRootIds.has(relationship.toMemberId) ? primaryRoot.id : relationship.toMemberId
    const type = spouseLabels.has((relationship.label || '').trim().toLowerCase()) ? 'spouse' : relationship.type
    return { ...relationship, fromMemberId, toMemberId, type }
  })
  return { members: memberData, relationships: relationshipData }
}
export async function cleanupVoidMembers() {
  const voidMembers = await getDocs(query(collection(db, 'members'), where('isVoid', '==', true)))
  if (voidMembers.empty) return
  const voidIds = new Set(voidMembers.docs.map((item) => item.id))
  const relationships = await getDocs(collection(db, 'relationships'))
  const batch = writeBatch(db)
  voidMembers.docs.forEach((item) => batch.delete(item.ref))
  relationships.docs.filter((item) => voidIds.has(item.data().fromMemberId) || voidIds.has(item.data().toMemberId)).forEach((item) => batch.delete(item.ref))
  await batch.commit()
}
export async function listGroups() { await cleanupVoidMembers(); const snap = await getDocs(query(collection(db, 'familyGroups'), orderBy('updatedAt', 'desc'))); return snap.docs.map((d) => ({ id: d.id, ...d.data() })) }
export async function saveGroup(data, id) { if (id) return updateDoc(doc(db, 'familyGroups', id), clean({ ...data, updatedAt: serverTimestamp() })); return addDoc(collection(db, 'familyGroups'), clean({ ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })) }
export async function saveMember(data, id) { if (id) return updateDoc(doc(db, 'members', id), clean({ ...data, updatedAt: serverTimestamp() })); return addDoc(collection(db, 'members'), clean({ ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })) }
export async function saveRelationship(data) {
  const spouseLabels = new Set(['wife', 'husband', 'spouse', 'partner'])
  const isSpouse = spouseLabels.has((data.label || '').trim().toLowerCase())
  const normalizedData = { ...data, label: isSpouse ? 'Spouse' : data.label, type: isSpouse ? 'spouse' : data.type }
  if (normalizedData.fromMemberId === normalizedData.toMemberId) throw new Error('A member cannot be related to themself.')
  const snapshot = await getDocs(query(collection(db, 'relationships'), where('familyGroupId', '==', data.familyGroupId)))
  const existing = snapshot.docs.find((item) => {
    const value = item.data()
    return (value.fromMemberId === normalizedData.fromMemberId && value.toMemberId === normalizedData.toMemberId) || (value.fromMemberId === normalizedData.toMemberId && value.toMemberId === normalizedData.fromMemberId)
  })
  if (existing) return updateDoc(existing.ref, { ...normalizedData, updatedAt: serverTimestamp() })
  const pairId = [normalizedData.fromMemberId, normalizedData.toMemberId].sort().join('__')
  const relationshipRef = doc(db, 'relationships', `${normalizedData.familyGroupId}__${pairId}`)
  await setDoc(relationshipRef, { ...normalizedData, createdAt: serverTimestamp() })
  return relationshipRef
}
export async function findRelationship(familyGroupId, firstMemberId, secondMemberId) {
  const snapshot = await getDocs(query(collection(db, 'relationships'), where('familyGroupId', '==', familyGroupId)))
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).find((item) => (item.fromMemberId === firstMemberId && item.toMemberId === secondMemberId) || (item.fromMemberId === secondMemberId && item.toMemberId === firstMemberId)) || null
}
export async function listMemberRelationships(familyGroupId, memberId) {
  const snapshot = await getDocs(query(collection(db, 'relationships'), where('familyGroupId', '==', familyGroupId)))
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).filter((item) => item.fromMemberId === memberId || item.toMemberId === memberId)
}
export async function deleteRelationship(id) { return deleteDoc(doc(db, 'relationships', id)) }
export async function getRelationship(id) {
  const snapshot = await getDoc(doc(db, 'relationships', id))
  if (!snapshot.exists()) return null
  const relationship = { id: snapshot.id, ...snapshot.data() }
  const [fromMember, toMember] = await Promise.all([getDoc(doc(db, 'members', relationship.fromMemberId)), getDoc(doc(db, 'members', relationship.toMemberId))])
  return { ...relationship, fromMemberName: fromMember.data()?.preferredName || fromMember.data()?.fullName || 'Unknown member', toMemberName: toMember.data()?.preferredName || toMember.data()?.fullName || 'Unknown member' }
}
export async function updateRelationship(id, data) { return updateDoc(doc(db, 'relationships', id), { ...data, updatedAt: serverTimestamp() }) }
export async function archiveMember(id) { return updateDoc(doc(db, 'members', id), { archived: true, updatedAt: serverTimestamp() }) }
export async function voidMember(id) {
  const memberRef = doc(db, 'members', id)
  const member = await getDoc(memberRef)
  if (!member.exists()) return
  const relationshipSnapshot = await getDocs(query(collection(db, 'relationships'), where('familyGroupId', '==', member.data().familyGroupId)))
  const hasRelationships = relationshipSnapshot.docs.some((item) => { const relationship = item.data(); return relationship.fromMemberId === id || relationship.toMemberId === id })
  if (!hasRelationships) return deleteDoc(memberRef)
  return updateDoc(memberRef, { isVoid: true, fullName: 'Void', preferredName: '', nickname: '', avatarDataUrl: '', phone: '', email: '', address: '', social: '', notes: '', updatedAt: serverTimestamp() })
}
export async function removeGroup(groupId) { const data = await loadGroupData(groupId); const batch = writeBatch(db); data.members.forEach((x) => batch.delete(doc(db, 'members', x.id))); data.relationships.forEach((x) => batch.delete(doc(db, 'relationships', x.id))); batch.delete(doc(db, 'familyGroups', groupId)); return batch.commit() }

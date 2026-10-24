export const relationCatalog = [
  ['Papa', 'Father'], ['Mummy', 'Mother'], ['Dada', 'Paternal grandfather'], ['Dadi', 'Paternal grandmother'],
  ['Nana', 'Maternal grandfather'], ['Nani', 'Maternal grandmother'], ['Kaka', 'Paternal uncle'], ['Kaki', 'Paternal aunt'],
  ['Foi', 'Paternal aunt'], ['Fua', 'Paternal aunt’s husband'], ['Mama', 'Maternal uncle'], ['Mami', 'Maternal aunt'],
  ['Masi', 'Maternal aunt'], ['Masa', 'Maternal aunt’s husband'], ['Bhai', 'Brother'], ['Ben', 'Sister'],
  ['Spouse', 'Marriage partner'],
  ['Bhabhi', 'Sister-in-law'], ['Jeth', 'Elder brother-in-law'], ['Jethani', 'Elder sister-in-law'],
  ['Devar', 'Younger brother-in-law'], ['Devrani', 'Younger sister-in-law'], ['Nanand', 'Sister-in-law'],
  ['Jijaji', 'Sister’s husband'], ['Banevi', 'Sister’s husband'], ['Nandoi', 'Husband’s sister’s husband'],
  ['Salo', 'Wife’s brother'], ['Sali', 'Wife’s sister'], ['Sadhu Bhai', 'Wife’s sister’s husband'],
  ['Mota Papa', 'Father’s elder brother'], ['Moti Ma', 'Father’s elder brother’s wife'],
  ['Saas', 'Mother-in-law'], ['Sasra', 'Father-in-law'], ['Jamai', 'Daughter’s husband'], ['Vahu', 'Son’s wife'],
  ['Bhatrijo', 'Brother’s son'], ['Bhatriji', 'Brother’s daughter'], ['Bhanjo', 'Sister’s son'], ['Bhanji', 'Sister’s daughter'],
  ['Dikro', 'Son'], ['Dikri', 'Daughter'],
].map(([term, english]) => ({ id: term.toLowerCase(), term, english }))

export const searchRelations = (query = '') => {
  const q = query.trim().toLowerCase()
  return relationCatalog.filter((item) => !q || `${item.term} ${item.english}`.toLowerCase().includes(q))
}

export const relationRule = (label = '') => {
  const value = label.trim().toLowerCase()
  if (['papa', 'mummy', 'father', 'mother', 'dada', 'dadi', 'nana', 'nani'].includes(value)) return { type: 'parent_child', relatedIs: 'parent' }
  if (['dikro', 'dikri', 'son', 'daughter'].includes(value)) return { type: 'parent_child', relatedIs: 'child' }
  if (['wife', 'husband', 'spouse', 'partner'].includes(value)) return { type: 'spouse', relatedIs: 'spouse' }
  return { type: 'relative', relatedIs: 'relative' }
}

export const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?'

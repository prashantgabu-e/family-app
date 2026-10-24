import imageCompression from 'browser-image-compression'

export async function compressAvatar(file) {
  if (!file?.type.startsWith('image/')) throw new Error('Please select an image file.')
  const compressed = await imageCompression(file, { maxSizeMB: 0.12, maxWidthOrHeight: 256, useWebWorker: true, fileType: 'image/webp' })
  const dataUrl = await imageCompression.getDataUrlFromFile(compressed)
  if (new Blob([dataUrl]).size > 180000) throw new Error('This image is still too large. Try a simpler photo.')
  return dataUrl
}

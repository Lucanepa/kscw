export function getFileUrl(collection: string, recordId: string, filename: string): string {
  return `${import.meta.env.VITE_PB_URL}/api/files/${collection}/${recordId}/${filename}`
}

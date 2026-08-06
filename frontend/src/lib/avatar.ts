// Mirrors the backend's own MAX_AVATAR_BYTES (routes/auth.ts) - checked
// client-side too, purely so a too-big file is rejected instantly instead
// of only after a round trip to the server.
export const MAX_AVATAR_BYTES = 400 * 1024

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

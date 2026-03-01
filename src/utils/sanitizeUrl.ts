/**
 * Sanitize a URL to prevent javascript: protocol XSS attacks.
 * Returns the URL if it uses http: or https:, empty string otherwise.
 */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return url
  } catch {
    /* invalid URL */
  }
  return ''
}

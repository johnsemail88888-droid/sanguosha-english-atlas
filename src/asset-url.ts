export function resolveAssetUrl(path: string, baseUrl = import.meta.env.BASE_URL) {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return `${normalizedBase}${path.replace(/^\/+/, '')}`
}

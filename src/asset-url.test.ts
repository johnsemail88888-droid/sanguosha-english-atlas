import { describe, expect, it } from 'vitest'
import { resolveAssetUrl } from './asset-url'

describe('resolveAssetUrl', () => {
  it('uses relative paths for a portable Electron or Pages build', () => {
    expect(resolveAssetUrl('/images/cards/slash.png', './')).toBe('./images/cards/slash.png')
  })

  it('supports a repository base path', () => {
    expect(resolveAssetUrl('/images/cards/slash.png', '/sanguosha-english-atlas/')).toBe('/sanguosha-english-atlas/images/cards/slash.png')
  })
})

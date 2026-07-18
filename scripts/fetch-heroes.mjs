import * as cheerio from 'cheerio'
import { mkdir, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const DATA_DIR = join(ROOT, 'data')
const IMAGE_DIR = join(ROOT, 'public', 'images', 'generals')

const ranges = [
  { series: 'standard', labelZh: '标准武将', ids: Array.from({ length: 25 }, (_, index) => index + 1) },
  { series: 'wind', labelZh: '风', ids: Array.from({ length: 8 }, (_, index) => index + 26) },
  { series: 'fire', labelZh: '火', ids: Array.from({ length: 8 }, (_, index) => index + 34) },
  { series: 'forest', labelZh: '林', ids: Array.from({ length: 8 }, (_, index) => index + 42) },
  { series: 'mountain', labelZh: '山', ids: Array.from({ length: 8 }, (_, index) => index + 50) },
  { series: 'yin', labelZh: '阴', ids: Array.from({ length: 8 }, (_, index) => index + 249) },
  { series: 'thunder', labelZh: '雷', ids: Array.from({ length: 8 }, (_, index) => index + 339) },
  { series: 'god', labelZh: '神将', ids: [...Array.from({ length: 8 }, (_, index) => index + 139), 271, 272, 347, 348] },
  { series: 'boundary', labelZh: '界限突破', ids: [...Array.from({ length: 5 }, (_, index) => index + 152), ...Array.from({ length: 16 }, (_, index) => index + 158), ...Array.from({ length: 6 }, (_, index) => index + 233)] },
]

function clean(value = '') {
  return value.replace(/\s+/g, ' ').replace(/：\s*：/g, '：').trim()
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 SanguoshaAtlas/1.0' } })
  if (!response.ok) throw new Error(`${url} → ${response.status}`)
  return response.text()
}

async function fetchHero(id, series, seriesLabelZh) {
  const sourceUrl = `https://www.sanguosha.cn/pc/hero-detail-${id}.html`
  const html = await fetchText(sourceUrl)
  const $ = cheerio.load(html)
  const title = $('.hero-title').first()
  const nameZh = clean(title.find('span').first().text())
  const kingdom = clean(title.find('i').first().text())
  if (!nameZh) throw new Error(`武将 ${id} 没有名称`)

  const featureLine = clean($('.hero-desc p').filter((_, node) => $(node).text().includes('武将特点')).first().text())
  const keyCardsLine = clean($('.hero-desc p').filter((_, node) => $(node).text().includes('关键卡牌')).first().text())
  const identitySkill = $('.skill').first()
  const skillNames = identitySkill.find('.skill-nav li').map((_, node) => clean($(node).text())).get()
  const skillTexts = identitySkill.find('.skill-info li').map((_, node) => clean($(node).text())).get()
  const skillsZh = skillNames.map((name, index) => ({ name, text: skillTexts[index] || '' })).filter((skill) => skill.text)

  const imageUrl = $('#heroInfo1 .swiper-slide img').first().attr('src')
    || $('.hero-right img').first().attr('src')
    || ''
  const imageExtension = ['.png', '.webp'].includes(extname(new URL(imageUrl).pathname).toLowerCase()) ? extname(new URL(imageUrl).pathname).toLowerCase() : '.jpg'
  const imageName = `hero-${id}${imageExtension}`
  if (imageUrl) {
    const imageResponse = await fetch(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0 SanguoshaAtlas/1.0' } })
    if (!imageResponse.ok) throw new Error(`${imageUrl} → ${imageResponse.status}`)
    await writeFile(join(IMAGE_DIR, imageName), Buffer.from(await imageResponse.arrayBuffer()))
  }

  return {
    id: `hero-${id}`,
    kind: 'general',
    officialId: id,
    nameZh,
    kingdom,
    series,
    seriesLabelZh,
    image: `/images/generals/${imageName}`,
    sourceImageUrl: imageUrl,
    sourceUrl,
    introZh: clean($('.hero-intro').first().text()),
    featureZh: featureLine.replace(/^【武将特点】\s*[：:]?\s*/, ''),
    keyCardsZh: keyCardsLine.replace(/^【关键卡牌】\s*[：:]?\s*/, ''),
    playZh: clean($('.play').first().text()),
    skillsZh,
  }
}

await mkdir(DATA_DIR, { recursive: true })
await mkdir(IMAGE_DIR, { recursive: true })

const heroes = []
for (const group of ranges) {
  for (const id of group.ids) {
    process.stdout.write(`\r正在抓取 ${group.labelZh} ${id}…`)
    heroes.push(await fetchHero(id, group.series, group.labelZh))
  }
}

await writeFile(join(DATA_DIR, 'heroes.zh.json'), `${JSON.stringify(heroes, null, 2)}\n`)
console.log(`\n完成：${heroes.length} 名武将。`)

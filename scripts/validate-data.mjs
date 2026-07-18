import { access, readFile } from 'node:fs/promises'
const root=new URL('../',import.meta.url)
const heroes=JSON.parse(await readFile(new URL('data/heroes.zh.json',root),'utf8'))
const guides=JSON.parse(await readFile(new URL('data/heroes.en.json',root),'utf8'))
const cards=JSON.parse(await readFile(new URL('data/game-cards.json',root),'utf8'))
const problems=[];const guideMap=new Map(guides.map(x=>[x.id,x]))
if(heroes.length!==112)problems.push(`武将应为112，实际${heroes.length}`)
if(cards.length!==43)problems.push(`游戏牌应为43，实际${cards.length}`)
for(const hero of heroes){const guide=guideMap.get(hero.id);if(!guide){problems.push(`${hero.nameZh}缺少英文牌解`);continue}if(guide.skillsEn?.length!==hero.skillsZh.length)problems.push(`${hero.nameZh}技能翻译数量不符`);for(let i=0;i<hero.skillsZh.length;i++){if(guide.skillsEn[i]?.nameZh!==hero.skillsZh[i].name)problems.push(`${hero.nameZh}第${i+1}个技能未对齐`)}await access(new URL(`public${hero.image}`,root)).catch(()=>problems.push(`${hero.nameZh}缺牌图`))}
for(const card of cards){for(const key of ['rulesEn','plainEn','timingEn','exampleEn'])if(!card[key]?.trim())problems.push(`${card.nameZh}缺少${key}`);if(!card.misunderstandingsEn?.length)problems.push(`${card.nameZh}缺少误区`);await access(new URL(`public${card.image}`,root)).catch(()=>problems.push(`${card.nameZh}缺牌图`))}
if(new Set([...heroes,...cards].map(x=>x.id)).size!==heroes.length+cards.length)problems.push('存在重复ID')
for(const [series,count] of [['yin',8],['thunder',8]])if(heroes.filter(x=>x.series===series).length!==count)problems.push(`${series}武将数量应为${count}`)
for(const id of [271,272,347,348])if(!guideMap.has(`hero-${id}`))problems.push(`神将hero-${id}未收录`)
if(problems.length){console.error(problems.slice(0,100).join('\n'));process.exit(1)}
console.log(`数据校验通过：${heroes.length}名武将、${cards.length}种游戏牌、${guides.length}份英文武将牌解，全部牌图可用。`)

import { readFile, writeFile } from 'node:fs/promises'
import { pinyin } from 'pinyin-pro'
const path=new URL('../data/heroes.en.json',import.meta.url)
const heroes=JSON.parse(await readFile(new URL('../data/heroes.zh.json',import.meta.url),'utf8'))
const guides=JSON.parse(await readFile(path,'utf8'));const source=new Map(heroes.map(x=>[x.id,x]))
const toName=value=>pinyin(value,{toneType:'none',type:'array'}).map(part=>part[0].toUpperCase()+part.slice(1)).join(' ')
const normalizeTerms=value=>typeof value==='string'?value.replaceAll('Lightning Slash','Thunder Slash').replaceAll('Dragon’s Wrath','Long Nu').replaceAll("Dragon's Wrath",'Long Nu').replaceAll('Dragon Encampment','Jie Ying').replaceAll('Cripple Strike','Cui Ke').replaceAll('Flame Bloom','Zhan Huo'):Array.isArray(value)?value.map(normalizeTerms):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,normalizeTerms(item)])):value
for(let index=0;index<guides.length;index++){guides[index]=normalizeTerms(guides[index]);const guide=guides[index],hero=source.get(guide.id);guide.nameEn=toName(hero.nameZh);guide.skillsEn.forEach((skill,skillIndex)=>{skill.nameZh=hero.skillsZh[skillIndex].name;skill.nameEn=toName(skill.nameZh)})}
await writeFile(path,`${JSON.stringify(guides,null,2)}\n`)
console.log(`拼音校正完成：${guides.length}名武将。`)

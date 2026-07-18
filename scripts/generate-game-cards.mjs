import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const cards = [
  ['slash','杀','Slash','basic','standard'],['fire_slash','火杀','Fire Slash','basic','maneuvering'],['thunder_slash','雷杀','Thunder Slash','basic','maneuvering'],['jink','闪','Jink','basic','standard'],['peach','桃','Peach','basic','standard'],['analeptic','酒','Analeptic','basic','maneuvering'],
  ['duel','决斗','Duel','trick','standard'],['dismantlement','过河拆桥','Dismantlement','trick','standard'],['snatch','顺手牵羊','Snatch','trick','standard'],['ex_nihilo','无中生有','Ex Nihilo','trick','standard'],['collateral','借刀杀人','Collateral','trick','standard'],['nullification','无懈可击','Nullification','trick','standard'],['amazing_grace','五谷丰登','Amazing Grace','trick','standard'],['god_salvation','桃园结义','God Salvation','trick','standard'],['savage_assault','南蛮入侵','Savage Assault','trick','standard'],['archery_attack','万箭齐发','Archery Attack','trick','standard'],['indulgence','乐不思蜀','Indulgence','trick','standard'],['lightning','闪电','Lightning','trick','standard'],['supply_shortage','兵粮寸断','Supply Shortage','trick','maneuvering'],['fire_attack','火攻','Fire Attack','trick','maneuvering'],['iron_chain','铁索连环','Iron Chain','trick','maneuvering'],
  ['crossbow','诸葛连弩','Crossbow','equipment','standard'],['double_sword','雌雄双股剑','Double Sword','equipment','standard'],['qinggang_sword','青釭剑','Qinggang Sword','equipment','standard'],['blade','青龙偃月刀','Green Dragon Blade','equipment','standard'],['ice_sword','寒冰剑','Ice Sword','equipment','standard'],['spear','丈八蛇矛','Spear','equipment','standard'],['axe','贯石斧','Axe','equipment','standard'],['halberd','方天画戟','Halberd','equipment','standard'],['kylin_bow','麒麟弓','Kylin Bow','equipment','standard'],['fan','朱雀羽扇','Fan','equipment','maneuvering'],['guding_blade','古锭刀','Guding Blade','equipment','maneuvering'],['eight_diagram','八卦阵','Eight Trigrams','equipment','standard'],['renwang_shield','仁王盾','Renwang Shield','equipment','standard'],['vine','藤甲','Vine','equipment','maneuvering'],['silver_lion','白银狮子','Silver Lion','equipment','maneuvering'],['chitu','赤兔','Chitu','equipment','standard'],['dayuan','大宛','Dayuan','equipment','standard'],['zixing','紫骍','Zixing','equipment','standard'],['jueying','绝影','Jueying','equipment','standard'],['dilu','的卢','Dilu','equipment','standard'],['zhuahuangfeidian','爪黄飞电','Zhuahuang Feidian','equipment','standard'],['hualiu','骅骝','Hualiu','equipment','maneuvering'],
].map(([slug,nameZh,nameEn,category,pack]) => ({ id:`card-${slug}`, slug, nameZh, nameEn, category, pack, image:`/images/cards/${slug}.png` }))

const schema = { type:'object', additionalProperties:false, required:['cards'], properties:{ cards:{ type:'array', items:{ type:'object', additionalProperties:false, required:['id','rulesEn','plainEn','timingEn','exampleEn','misunderstandingsEn'], properties:{ id:{type:'string'}, rulesEn:{type:'string'}, plainEn:{type:'string'}, timingEn:{type:'string'}, exampleEn:{type:'string'}, misunderstandingsEn:{type:'array',minItems:1,maxItems:4,items:{type:'string'}} } } } } }

const dir = new URL('../data/', import.meta.url)
await mkdir(dir, { recursive:true })
const schemaPath = new URL('game-card-schema.json', dir)
await writeFile(schemaPath, JSON.stringify(schema))
const generated=[]
for(let i=0;i<cards.length;i+=15){
  const batch=cards.slice(i,i+15);const outPath=new URL(`game-card-output-${i}.json`,dir)
  const prompt=`You are a precise rules editor for classic Sanguosha. Write English beginner guides for every supplied Standard/Maneuvering card type. Use classic QSanguosha rules and common terminology. Do not invent effects. Preserve every id and return exactly one entry per input. rulesEn must completely but concisely include limits, range, timing, response, judgment suit/number, damage type, and weapon range where applicable. plainEn explains ordinary use. timingEn gives best-use advice. exampleEn gives a concrete sequence. misunderstandingsEn directly corrects mistakes. For horses clearly state -1/+1 distance.\n\nCards:\n${JSON.stringify(batch,null,2)}`
  const args=['exec','--ephemeral','--ignore-user-config','--ignore-rules','--skip-git-repo-check','--sandbox','read-only','--color','never','--model',process.env.OPENAI_MODEL||'gpt-5.6-luna','--output-schema',schemaPath.pathname,'--output-last-message',outPath.pathname,'--cd',process.cwd(),'-']
  await new Promise((resolve,reject)=>{const child=spawn('codex',args,{stdio:['pipe','ignore','pipe']});let err='';child.stderr.on('data',x=>{if(err.length<4000)err+=String(x)});child.on('exit',c=>{if(c===0)resolve();else reject(new Error(err||`codex exited ${c}`))});child.on('error',reject);child.stdin.end(prompt)})
  generated.push(...JSON.parse(await readFile(outPath,'utf8')).cards);console.log(`Game cards: ${generated.length}/${cards.length}`)
}
const byId=Object.fromEntries(generated.map(x=>[x.id,x]))
await writeFile(new URL('../data/game-cards.json', import.meta.url), `${JSON.stringify(cards.map(card=>({...card,...byId[card.id]})),null,2)}\n`)
console.log(`Game cards: ${generated.length}/${cards.length}`)

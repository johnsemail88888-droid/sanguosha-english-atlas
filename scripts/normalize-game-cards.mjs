import { readFile, writeFile } from 'node:fs/promises'
const path=new URL('../data/game-cards.json',import.meta.url),cards=JSON.parse(await readFile(path,'utf8'))
for(const card of cards){for(const key of ['rulesEn','plainEn','timingEn','exampleEn'])card[key]=card[key].replaceAll('Barbarian Invasion','Savage Assault').replaceAll('Dodge','Jink');card.misunderstandingsEn=card.misunderstandingsEn.map(x=>x.replaceAll('Barbarian Invasion','Savage Assault').replaceAll('Dodge','Jink'))}
const patch=(nameZh,value)=>Object.assign(cards.find(x=>x.nameZh===nameZh),value)
patch('酒',{
  rulesEn:'During your Play Phase, use this on yourself to make your next Slash this turn deal 1 additional damage; you may normally use only one Analeptic in a Play Phase. When you are in the Dying state, you may use Analeptic on yourself to recover 1 HP. The damage bonus applies only to the next Slash and keeps that Slash’s damage type.',
  plainEn:'Drink it before one important Slash for +1 damage. If you are dying, you may drink it yourself to recover 1 HP instead.',
  misunderstandingsEn:['The Dying use is only for yourself; unlike Peach, you cannot use Analeptic to save another character.','It boosts only your next Slash that turn, not every Slash.','The boosted Slash can still be answered with Jink.'],
})
patch('方天画戟',{
  rulesEn:'Weapon range 4. When the Slash you use is your last hand card, you may choose up to two additional legal targets for it, for up to three targets total. Each target responds separately. The normal Slash-use limit still applies unless another effect changes it.',
  plainEn:'If you spend your final hand card as Slash, that Slash can attack as many as three legal targets.',
  misunderstandingsEn:['The Slash must be your last hand card; merely having a low hand is not enough.','You get up to three total targets, not three additional targets.','Every chosen target must still be a legal target for that Slash.'],
})
await writeFile(path,`${JSON.stringify(cards,null,2)}\n`)
console.log('关键游戏牌规则校正完成。')

import { describe, expect, it } from 'vitest'
import heroes from '../data/heroes.zh.json'
import guides from '../data/heroes.en.json'
import cards from '../data/game-cards.json'
describe('atlas data',()=>{it('contains the agreed classic collection',()=>{expect(heroes).toHaveLength(92);expect(cards).toHaveLength(43);expect(guides).toHaveLength(92)});it('keeps every translated skill aligned with its Chinese card',()=>{const map=new Map(guides.map(x=>[x.id,x]));for(const hero of heroes)expect(map.get(hero.id)?.skillsEn.map(x=>x.nameZh)).toEqual(hero.skillsZh.map(x=>x.name))})})

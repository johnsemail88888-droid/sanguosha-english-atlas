import { describe, expect, it } from 'vitest'
import heroes from '../data/heroes.zh.json'
import guides from '../data/heroes.en.json'
import cards from '../data/game-cards.json'
describe('atlas data',()=>{it('contains the agreed classic collection',()=>{expect(heroes).toHaveLength(112);expect(cards).toHaveLength(43);expect(guides).toHaveLength(112)});it('includes the complete Yin and Thunder packs with their gods',()=>{const ids=new Set(heroes.map(x=>x.id));for(const id of [249,250,251,252,253,254,255,256,271,272,339,340,341,342,343,344,345,346,347,348])expect(ids.has(`hero-${id}`)).toBe(true);expect(heroes.filter(x=>x.series==='yin')).toHaveLength(8);expect(heroes.filter(x=>x.series==='thunder')).toHaveLength(8)});it('keeps every translated skill aligned with its Chinese card',()=>{const map=new Map(guides.map(x=>[x.id,x]));for(const hero of heroes)expect(map.get(hero.id)?.skillsEn.map(x=>x.nameZh)).toEqual(hero.skillsZh.map(x=>x.name))})})

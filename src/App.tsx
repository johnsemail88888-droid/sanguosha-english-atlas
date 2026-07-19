import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowLeft, BookOpen, ChevronRight, Download, Search, Shield, Sparkles, Swords, X } from 'lucide-react'
import heroesZh from '../data/heroes.zh.json'
import heroesEn from '../data/heroes.en.json'
import gameCards from '../data/game-cards.json'
import { resolveAssetUrl } from './asset-url'
import './App.css'

type SkillZh = { name: string; text: string }
type SkillEn = { nameZh: string; nameEn: string; textEn: string; plainEn: string }
type General = (typeof heroesZh)[number] & { kind: 'general'; nameEn: string; roleEn: string; difficulty: string; summaryEn: string; timingEn: string; exampleEn: string; misunderstandingsEn: string[]; skillsEn: SkillEn[]; skillsZh: SkillZh[] }
type GameCard = (typeof gameCards)[number] & { kind: 'game-card' }
type Item = General | GameCard

const seriesOrder = ['standard', 'boundary', 'wind', 'fire', 'forest', 'mountain', 'yin', 'thunder', 'god']
const seriesLabels: Record<string, string> = { standard:'标将', boundary:'界武将', wind:'风', fire:'火', forest:'林', mountain:'山', yin:'阴', thunder:'雷', god:'经典神将' }
const categoryLabels: Record<string, string> = { basic:'基本牌', trick:'锦囊牌', equipment:'装备牌' }
const kingdomLabels: Record<string, string> = { 魏:'魏', 蜀:'蜀', 吴:'吴', 群:'群', 神:'神' }
const desktopDownloadUrl = 'https://github.com/johnsemail88888-droid/sanguosha-english-atlas/releases/latest'

function App() {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [selected, setSelected] = useState<Item | null>(null)
  const guideMap = useMemo(() => new Map(heroesEn.map(x => [x.id, x])), [])
  const generals = useMemo(() => heroesZh.map(h => ({ ...h, ...guideMap.get(h.id) })) as General[], [guideMap])
  const cards = gameCards as GameCard[]
  const all: Item[] = [...generals, ...cards]
  const normalized = query.trim().toLowerCase()
  const results = all.filter(item => {
    const haystack = item.kind === 'general'
      ? [item.nameZh,item.nameEn,item.kingdom,item.seriesLabelZh,item.roleEn,...item.skillsZh.flatMap(s=>[s.name,s.text]),...item.skillsEn.flatMap(s=>[s.nameEn,s.textEn,s.plainEn])].join(' ')
      : [item.nameZh,item.nameEn,item.category,item.rulesEn,item.plainEn].join(' ')
    const matchesQuery = !normalized || haystack.toLowerCase().includes(normalized)
    const matchesFilter = filter === 'all' || (filter === 'cards' ? item.kind === 'game-card' : item.kind === 'general' && item.series === filter)
    return matchesQuery && matchesFilter
  })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelected(null) }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => { document.body.style.overflow = selected ? 'hidden' : ''; return () => { document.body.style.overflow = '' } }, [selected])

  return <div className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={() => {setQuery('');setFilter('all')}} aria-label="返回图鉴首页">
        <span className="seal">译</span><span><b>三国杀英文图鉴</b><small>CHINESE CARD · ENGLISH GUIDE</small></span>
      </button>
      <label className="search"><Search size={18}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜中文牌名、英文名或技能…" />{query&&<button onClick={()=>setQuery('')} aria-label="清空"><X size={16}/></button>}</label>
      <a className="download" href={desktopDownloadUrl} target="_blank" rel="noreferrer"><Download size={16}/> 下载 macOS App</a>
      <span className="count">{generals.length} 武将 · {cards.length} 游戏牌</span>
    </header>

    <main>
      <section className="hero-intro">
        <div><span className="eyebrow">MOBILE EDITION · CLASSIC COLLECTION</span><h1>看中文牌，<em>马上会用英文。</em></h1><p>为标将、界武将、风火林山阴雷与经典神将制作。认图点开，直接看准确英文效果、大白话打法、时机、例子和误区。</p></div>
        <div className="hero-stat"><span>{all.length}</span><small>张可识别牌图</small><div>不含谋将、势将等超标扩展</div></div>
      </section>

      <nav className="filters" aria-label="图鉴分类">
        {[['all','全部'],['cards','游戏牌'],...seriesOrder.map(x=>[x,seriesLabels[x]])].map(([id,label])=><button key={id} className={filter===id?'active':''} onClick={()=>setFilter(id)}>{label}</button>)}
      </nav>

      {(query || filter !== 'all') ? <section className="results"><div className="section-title"><div><span>SEARCH RESULTS</span><h2>找到 {results.length} 张牌</h2></div></div><div className="grid">{results.map(item=><CardTile key={item.id} item={item} onClick={()=>setSelected(item)}/>)}</div></section> : <>
        <Shelf title="先认游戏牌" kicker="STANDARD + MANEUVERING" note="基本牌、锦囊、武器、防具与坐骑" items={cards} onSelect={setSelected}/>
        {seriesOrder.map(series=><Shelf key={series} title={seriesLabels[series]} kicker={series==='boundary'?'BOUNDARY BREAKTHROUGH':series.toUpperCase()} note={`${generals.filter(x=>x.series===series).length} 名武将`} items={generals.filter(x=>x.series===series)} onSelect={setSelected}/>) }
      </>}
    </main>
    <footer><span>资料范围：三国杀移动版经典卡池</span><span>武将资料与牌图来源：三国杀移动版官网 · 游戏牌图：QSanguosha（非商业学习用途）</span></footer>
    {selected && <Detail item={selected} onClose={()=>setSelected(null)}/>} 
  </div>
}

function Shelf({title,kicker,note,items,onSelect}:{title:string;kicker:string;note:string;items:Item[];onSelect:(x:Item)=>void}) {
  return <section className="shelf"><div className="section-title"><div><span>{kicker}</span><h2>{title}</h2></div><small>{note}</small></div><div className="rail">{items.map(item=><CardTile key={item.id} item={item} onClick={()=>onSelect(item)}/>)}</div></section>
}

function CardTile({item,onClick}:{item:Item;onClick:()=>void}) {
  const sub = item.kind==='general' ? `${kingdomLabels[item.kingdom]||item.kingdom} · ${item.roleEn}` : categoryLabels[item.category]
  return <button className={`tile ${item.kind}`} onClick={onClick}><div className="art"><img src={resolveAssetUrl(item.image)} alt={`${item.nameZh}牌图`} loading="lazy"/><span className="badge">{item.kind==='general' ? seriesLabels[item.series] : categoryLabels[item.category]}</span><span className="peek"><BookOpen size={17}/> 查看英文详解</span></div><div className="tile-copy"><strong>{item.nameZh}</strong><span>{item.nameEn}</span><small>{sub}</small></div></button>
}

function Detail({item,onClose}:{item:Item;onClose:()=>void}) {
  const isGeneral = item.kind==='general'
  return <div className="overlay" role="dialog" aria-modal="true"><button className="scrim" onClick={onClose} aria-label="关闭详情"/><article className="detail">
    <button className="close" onClick={onClose}><ArrowLeft size={18}/> 回到图鉴</button>
    <div className="detail-grid"><aside><img src={resolveAssetUrl(item.image)} alt={`${item.nameZh}牌图`}/><div className="source-note"><Shield size={15}/><span>按左侧中文牌图认牌<br/>右侧为英文教学说明</span></div></aside>
      <div className="detail-copy"><div className="detail-head"><div className="meta">{isGeneral ? `${seriesLabels[item.series]} · ${item.kingdom}势力` : `${categoryLabels[item.category]} · ${item.pack==='standard'?'标准版':'军争篇'}`}</div><h1>{item.nameZh}</h1><h2>{item.nameEn}</h2>{isGeneral&&<div className="chips"><span>{item.roleEn}</span><span>{item.difficulty}</span></div>}</div>
        {isGeneral ? <GeneralGuide item={item}/> : <CardGuide item={item}/>} 
      </div>
    </div>
  </article></div>
}

function GeneralGuide({item}:{item:General}) { return <>
  <GuideBlock icon={<Sparkles/>} label="PLAIN ENGLISH · 核心打法" title="How to play this general"><p>{item.summaryEn}</p></GuideBlock>
  <section className="skills"><div className="block-label">SKILLS · 技能逐条对照</div>{item.skillsEn.map((skill,i)=><div className="skill" key={skill.nameZh}><div className="skill-name"><span>{skill.nameZh}</span><b>{skill.nameEn}</b></div><p className="rules">{skill.textEn}</p><p className="plain">In plain English: {skill.plainEn}</p><details><summary>查看牌面中文原文</summary><p>{item.skillsZh[i]?.text}</p></details></div>)}</section>
  <GuideBlock icon={<Swords/>} label="WHEN TO USE · 使用时机" title="Best timing"><p>{item.timingEn}</p></GuideBlock>
  <GuideBlock icon={<ChevronRight/>} label="EXAMPLE · 实战例子" title="A simple turn"><p>{item.exampleEn}</p></GuideBlock>
  <Mistakes items={item.misunderstandingsEn}/>
  <a className="source-link" href={item.sourceUrl} target="_blank" rel="noreferrer">查看移动版官方武将资料 ↗</a>
  </> }

function CardGuide({item}:{item:GameCard}) { return <>
  <GuideBlock icon={<BookOpen/>} label="ENGLISH RULE TEXT · 英文效果" title="What the card does"><p>{item.rulesEn}</p></GuideBlock>
  <GuideBlock icon={<Sparkles/>} label="PLAIN ENGLISH · 大白话" title="The easy version"><p>{item.plainEn}</p></GuideBlock>
  <GuideBlock icon={<Swords/>} label="WHEN TO USE · 使用时机" title="Best timing"><p>{item.timingEn}</p></GuideBlock>
  <GuideBlock icon={<ChevronRight/>} label="EXAMPLE · 实战例子" title="At the table"><p>{item.exampleEn}</p></GuideBlock>
  <Mistakes items={item.misunderstandingsEn}/>
  </> }

function GuideBlock({icon,label,title,children}:{icon:ReactNode;label:string;title:string;children:ReactNode}) { return <section className="guide-block"><div className="guide-icon">{icon}</div><div><div className="block-label">{label}</div><h3>{title}</h3>{children}</div></section> }
function Mistakes({items}:{items:string[]}) { return <section className="mistakes"><div className="block-label">COMMON MISTAKES · 常见误解</div><ul>{items.map((x,i)=><li key={i}>{x}</li>)}</ul></section> }

export default App

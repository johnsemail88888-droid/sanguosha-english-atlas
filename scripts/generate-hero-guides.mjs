import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const model = process.env.OPENAI_MODEL || 'gpt-5.6-luna'
const batchSize = Number(process.env.GUIDE_BATCH_SIZE || 23)
const heroes = JSON.parse(await readFile(new URL('../data/heroes.zh.json', import.meta.url), 'utf8'))
const outputUrl = new URL('../data/heroes.en.json', import.meta.url)

const schema = {
  type: 'object', additionalProperties: false, required: ['guides'], properties: {
    guides: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['id', 'nameEn', 'roleEn', 'difficulty', 'summaryEn', 'timingEn', 'exampleEn', 'misunderstandingsEn', 'skillsEn'],
      properties: {
        id: { type: 'string' }, nameEn: { type: 'string' }, roleEn: { type: 'string' },
        difficulty: { type: 'string', enum: ['Easy', 'Medium', 'Hard'] },
        summaryEn: { type: 'string' }, timingEn: { type: 'string' }, exampleEn: { type: 'string' },
        misunderstandingsEn: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' } },
        skillsEn: { type: 'array', minItems: 1, items: {
          type: 'object', additionalProperties: false,
          required: ['nameZh', 'nameEn', 'textEn', 'plainEn'],
          properties: { nameZh: { type: 'string' }, nameEn: { type: 'string' }, textEn: { type: 'string' }, plainEn: { type: 'string' } },
        } },
      },
    } },
  },
}

function promptFor(batch) {
  return `You are an expert rules editor for Sanguosha Mobile. Translate the supplied official Simplified Chinese general data into clear, accurate English for first-time English-speaking players who are holding Chinese cards.

Return exactly one guide per input hero and preserve id. Do not invent or omit effects. Translate every skill in skillsZh, preserving whether an effect is optional (\u201ccan/may\u201d), mandatory, locked, a lord skill, its timing, costs, targets, limits, and durations. Use standard Sanguosha English card terms: Slash, Jink, Peach, Duel, judgment, hand cards, equipment area, draw pile, discard pile, Play Phase, Draw Phase, Finish Phase, preparation phase, dying state, damage, health/HP. A \u201clocked skill\u201d is mandatory. A \u201clord skill\u201d only works when the general is the lord.

Fields:
- nameEn: common English/pinyin form, with the Chinese name still shown separately by the app.
- roleEn: 2-5 words such as Support / Burst damage / Control / Defense.
- difficulty: for a brand-new player.
- skillsEn: one entry for every Chinese skill, same order. nameZh must exactly match. textEn is a complete rules translation; plainEn is one or two plain-English sentences.
- summaryEn: 2-4 plain sentences describing the game plan and best use, based on the official feature/play tips and the skill text.
- timingEn: the most important timing advice.
- exampleEn: one concrete, sequential example using only effects present in the supplied data.
- misunderstandingsEn: 1-4 direct corrections of likely mistakes.

Official input:\n${JSON.stringify(batch, null, 2)}`
}

async function runBatch(batch) {
  const dir = await mkdtemp(join(tmpdir(), 'sgs-guides-'))
  const schemaPath = join(dir, 'schema.json')
  const outPath = join(dir, 'out.json')
  await writeFile(schemaPath, JSON.stringify(schema))
  try {
    const args = ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--model', model, '--output-schema', schemaPath, '--output-last-message', outPath, '--cd', dir, '-']
    await new Promise((resolve, reject) => {
      const child = spawn('codex', args, { cwd: dir, env: process.env, stdio: ['pipe', 'ignore', 'pipe'] })
      let stderr = ''
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('guide generation timeout')) }, 360_000)
      child.stderr.on('data', chunk => { if (stderr.length < 8000) stderr += String(chunk) })
      child.on('error', reject)
      child.on('exit', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(stderr || `codex exited ${code}`)) })
      child.stdin.end(promptFor(batch))
    })
    return JSON.parse(await readFile(outPath, 'utf8')).guides
  } finally { await rm(dir, { recursive: true, force: true }) }
}

let current = {}
try { current = Object.fromEntries(JSON.parse(await readFile(outputUrl, 'utf8')).map(x => [x.id, x])) } catch {}
const pending = heroes.filter(hero => !current[hero.id])
console.log(`English general guides: ${heroes.length - pending.length}/${heroes.length}`)
for (let i = 0; i < pending.length; i += batchSize) {
  const batch = pending.slice(i, i + batchSize)
  const result = await runBatch(batch)
  for (const guide of result) current[guide.id] = guide
  const ordered = heroes.map(hero => current[hero.id]).filter(Boolean)
  await writeFile(outputUrl, `${JSON.stringify(ordered, null, 2)}\n`)
  console.log(`English general guides: ${ordered.length}/${heroes.length}`)
}

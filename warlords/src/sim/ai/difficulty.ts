// Bot difficulty profiles (settings.botDifficulty). Every number that makes a
// bot "better" lives here so easy / normal / hard differ in one place:
//  - easy: slow reactions, loose tracking, wide aim error, rarely dodges, no
//    cover play, reads the table poorly — forgiving for new players;
//  - normal: a competent casual player;
//  - hard: quick, precise, uses cover, dodges, leads targets, times abilities
//    and reads the table well — a real challenge (but never aimbot-perfect).
import type { BotDifficulty } from '../../core/types';

export interface DifficultyProfile {
  name: BotDifficulty;
  // ── perception ──
  /** seconds between full threat scans */
  scanEvery: number;
  /** max distance (m) at which enemies are noticed */
  visionRange: number;
  /** seconds from acquiring a target to the first shot */
  reaction: number;
  // ── aim (see aimer.ts) ──
  /** tracking lag time constant (s) on a known target */
  trackTau: number;
  /** flick time constant (s) right after switching targets */
  flickTau: number;
  /** aim error (degrees, 1σ) right after acquiring a target */
  aimErrStart: number;
  /** aim error floor (degrees, 1σ) after settling on a target */
  aimErrFloor: number;
  /** seconds for the error to settle from start to floor */
  settleTime: number;
  /** extra error multiplier while moving / target moving fast */
  motionErr: number;
  /** 0..1 how well moving targets and projectile flight are led */
  leadSkill: number;
  /** 0..1 fraction of aim points raised toward the head */
  headBias: number;
  /** clicks per second cap for semi-auto weapons */
  clickRate: number;
  // ── combat ──
  /** chance to dodge-roll when bursted */
  dodgeChance: number;
  /** 0..1 strafing amplitude */
  strafe: number;
  /** 0..1 chance to seek cover to reload / heal / when outgunned */
  coverUse: number;
  /** HP fraction under which the bot disengages */
  retreatHp: number;
  /** seconds between ability evaluations */
  abilityEvery: number;
  /** 0..1 how picky ability timing is (low = fires abilities loosely) */
  abilitySkill: number;
  /** seconds between item evaluations */
  itemEvery: number;
  /** control recoil with short bursts at range */
  burstControl: boolean;
  /** avoid shooting through believed allies */
  friendlyFireCheck: boolean;
  // ── tactics ──
  /** multiplier on evidence gained by the suspicion model */
  evidenceGain: number;
  /** evidence half-life (s) */
  evidenceHalfLife: number;
  /** use subtle evidence (escort proximity, retro-deduction from reveals, lord-skill tells) */
  subtleReads: boolean;
  /** hostility needed before opening fire on a hero */
  engageThreshold: number;
  /** seconds of looting before hunting (rebels / bounty) */
  lootPhase: number;
  /** dodge incoming projectiles */
  dodgeProjectiles: boolean;
}

export const DIFFICULTY_PROFILES: Record<BotDifficulty, DifficultyProfile> = {
  easy: {
    name: 'easy',
    scanEvery: 0.5,
    visionRange: 60,
    reaction: 0.7,
    trackTau: 0.3,
    flickTau: 0.45,
    aimErrStart: 7,
    aimErrFloor: 3.2,
    settleTime: 2.2,
    motionErr: 1.6,
    leadSkill: 0.15,
    headBias: 0,
    clickRate: 2.5,
    dodgeChance: 0.08,
    strafe: 0.35,
    coverUse: 0,
    retreatHp: 0.22,
    abilityEvery: 3.5,
    abilitySkill: 0.2,
    itemEvery: 2,
    burstControl: false,
    friendlyFireCheck: true,
    evidenceGain: 0.6,
    evidenceHalfLife: 60,
    subtleReads: false,
    engageThreshold: 0.9,
    lootPhase: 135,
    dodgeProjectiles: false,
  },
  normal: {
    name: 'normal',
    scanEvery: 0.33,
    visionRange: 75,
    reaction: 0.38,
    trackTau: 0.16,
    flickTau: 0.26,
    aimErrStart: 4.2,
    aimErrFloor: 1.7,
    settleTime: 1.4,
    motionErr: 1.3,
    leadSkill: 0.55,
    headBias: 0.1,
    clickRate: 4,
    dodgeChance: 0.3,
    strafe: 0.75,
    coverUse: 0.55,
    retreatHp: 0.3,
    abilityEvery: 1.4,
    abilitySkill: 0.6,
    itemEvery: 1,
    burstControl: true,
    friendlyFireCheck: true,
    evidenceGain: 1,
    evidenceHalfLife: 100,
    subtleReads: true,
    engageThreshold: 0.84,
    lootPhase: 115,
    dodgeProjectiles: false,
  },
  hard: {
    name: 'hard',
    scanEvery: 0.22,
    visionRange: 90,
    reaction: 0.22,
    trackTau: 0.09,
    flickTau: 0.16,
    aimErrStart: 2.6,
    aimErrFloor: 0.95,
    settleTime: 0.9,
    motionErr: 1.15,
    leadSkill: 0.9,
    headBias: 0.25,
    clickRate: 6,
    dodgeChance: 0.55,
    strafe: 1,
    coverUse: 1,
    retreatHp: 0.35,
    abilityEvery: 0.7,
    abilitySkill: 0.9,
    itemEvery: 0.6,
    burstControl: true,
    friendlyFireCheck: true,
    evidenceGain: 1.2,
    evidenceHalfLife: 150,
    subtleReads: true,
    engageThreshold: 0.8,
    lootPhase: 100,
    dodgeProjectiles: true,
  },
};

export function difficultyProfile(d: BotDifficulty | undefined): DifficultyProfile {
  return DIFFICULTY_PROFILES[d ?? 'normal'] ?? DIFFICULTY_PROFILES.normal;
}

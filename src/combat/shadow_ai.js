// =============================================================================
// SHADOW IA — collecte de vérité terrain (Phase 2b.4 — recording d'abord)
// =============================================================================
// Le client envoie, pour chaque tour d'ennemi PVM, l'état AVANT + la SÉQUENCE
// d'actions atomiques réellement exécutées par l'IA (cf. js/combat.js
// beginShadowAITurn/recordShadowAIAction/endShadowAITurn) :
//   { before, casterId, isBoss, actions:[ {type:'cast',spellKey,targetX,targetY}
//                                        | {type:'move',toX,toY} ], after }
//
// À CE STADE on LOGGE seulement (count + séquence), sans rejouer ni comparer :
// le but est d'observer la DISTRIBUTION RÉELLE des séquences d'actions de l'IA
// (combien de casts/moves par tour, quels sorts, boss vs normal) pour ensuite
// écrire decideNextEnemyAction et le valider en le rejouant contre ces séquences.
// 100% passif : aucune écriture, aucun impact sur la réponse ni le stockage.
// =============================================================================

import { planEnemyTurn, castMovesCaster, diagnoseEnemyTurn } from "./enemy_ai_driver.js";
import { SPELLS } from "./engine/spells_data.js";
import { resolveEnemyTurn } from "./enemy_turn.js";
import { createRng, hashSeed } from "./engine/combat_engine.js";

// DIAGNOSTIC géométrique (temporaire S3 IA) : faits décisifs du tour côté driver
// (pm, zone, reachable, maxRange, dist, bestTile) pour élucider les écarts d'IA
// (notamment le "buff au coin / client ∅" — voir phase2b_combat_engine_progress).
function diagGeo(before, casterId, isBoss) {
  try {
    const d = diagnoseEnemyTurn(before, { casterId, isBoss: !!isBoss });
    return (
      `pos=${d.pos} pm=${d.pm} inZone=${d.inZone} paralyzed=${d.paralyzed}` +
      ` reachable=${d.reachableCount} maxRange=${d.maxRange} nearestDist=${d.nearestDist}` +
      ` bestTile=${d.bestTile} nTargets=${d.nTargets}${d.err ? " err=" + d.err : ""}`
    );
  } catch (e) {
    return "diagGeo-err:" + (e && e.message);
  }
}

// DIAGNOSTIC (temporaire S3 IA) : dump compact de l'état du lanceur au tour d'écart,
// pour comprendre pourquoi le driver diverge (cooldowns ? hp/maxHp ? sort filtré ?).
function diagCaster(before, casterId) {
  try {
    const ae = (before.entities || [])[casterId];
    if (!ae) return "caster=∅";
    const cd = ae.spellCooldowns || {};
    const spells = (ae.spells || [])
      .map((k) => {
        const s = SPELLS[k];
        const left = cd[k] || 0;
        return `${k}{cd${s ? s.cooldown || 0 : "?"}/left${left},dmg${s ? s.damage || 0 : "?"},r${s ? s.range : "?"}${s && s.effect_type ? "," + s.effect_type : ""}}`;
      })
      .join(" ");
    const eff = (ae.effects || [])
      .map((e) => `${e.type}${e.stat ? ":" + e.stat : ""}${e.control_effect ? ":" + e.control_effect : ""}(d${e.duration})`)
      .join(",");
    return `caster hp=${ae.hp}/${ae.maxHp} pm=${ae.pm} eff=[${eff}] spells=[${spells}]`;
  } catch (e) {
    return "diag-err:" + (e && e.message);
  }
}

// Représentation compacte d'une action pour le log.
function fmtAction(a) {
  if (!a || typeof a !== "object") return "?";
  if (a.type === "cast") return `cast:${a.spellKey}@(${a.targetX},${a.targetY})`;
  if (a.type === "move") return `move->(${a.toX},${a.toY})`;
  return String(a.type || "?");
}

// Égalité d'intentions (type + payload). endTurn comparé sur le seul type.
function actionsEqual(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === "cast") return a.spellKey === b.spellKey && a.targetX === b.targetX && a.targetY === b.targetY;
  if (a.type === "move") return a.toX === b.toX && a.toY === b.toY;
  return true;
}

/**
 * Rejoue le driver planEnemyTurn contre chaque tour ennemi enregistré et COMPARE la
 * séquence d'actions produite à la séquence RÉELLE du client (vérité terrain). 100%
 * passif (log seul). En cas de suffixUncertain (sort qui déplace le lanceur =
 * mouvement primaire non routé moteur), on ne valide que le PRÉFIXE jusqu'au cast
 * incriminé (inclus) → comptabilisé "partial".
 * @param {Array} aiTurns
 * @param {object} [meta]
 * @returns {{turns:number, matched:number, mismatched:number, partial:number}}
 */
export function runShadowAIComparison(aiTurns, meta = {}) {
  if (!Array.isArray(aiTurns) || aiTurns.length === 0) {
    return { turns: 0, matched: 0, mismatched: 0, partial: 0 };
  }
  const tag = `[shadow-ai${meta.addr ? " " + String(meta.addr).slice(0, 8) : ""}]`;
  let matched = 0, mismatched = 0, partial = 0;

  for (let i = 0; i < aiTurns.length; i++) {
    const turn = aiTurns[i];
    try {
      if (!turn || !turn.before || turn.casterId == null) continue;
      const recorded = Array.isArray(turn.actions) ? turn.actions : [];

      const plan = planEnemyTurn(turn.before, { casterId: turn.casterId, isBoss: !!turn.isBoss });
      // Retirer le endTurn final du plan (le client n'enregistre pas l'endTurn).
      let planned = plan.actions.filter((a) => a.type !== "endTurn");

      // Préfixe fiable si mouvement primaire : jusqu'au 1er cast qui déplace le lanceur (inclus).
      let isPartial = false;
      if (plan.suffixUncertain) {
        const idx = planned.findIndex((a) => a.type === "cast" && castMovesCaster(a.spellKey));
        if (idx !== -1) { planned = planned.slice(0, idx + 1); isPartial = true; }
      }

      // Comparaison élément par élément sur le préfixe fiable.
      let divergence = null;
      const cmpLen = isPartial ? planned.length : Math.max(planned.length, recorded.length);
      for (let k = 0; k < cmpLen; k++) {
        if (!actionsEqual(planned[k], recorded[k])) {
          divergence = { index: k, planned: planned[k] ? fmtAction(planned[k]) : "∅", recorded: recorded[k] ? fmtAction(recorded[k]) : "∅" };
          break;
        }
      }

      const ok = !divergence;
      if (ok && isPartial) partial++;
      else if (ok) matched++;
      else mismatched++;

      if (!ok) {
        console.warn(
          `${tag} ÉCART turn#${i} caster=${turn.casterId} boss=${!!turn.isBoss}` +
            ` div@${divergence.index} plan=${divergence.planned} client=${divergence.recorded}` +
            ` | plan=[${planned.map(fmtAction).join(", ")}]` +
            ` client=[${recorded.map(fmtAction).join(", ")}]` +
            ` | ${diagCaster(turn.before, turn.casterId)}` +
            ` | ${diagGeo(turn.before, turn.casterId, turn.isBoss)}`
        );
      } else {
        console.log(
          `${tag} turn#${i} caster=${turn.casterId} boss=${!!turn.isBoss} ` +
            `${isPartial ? "PARTIAL" : "MATCH"} seq=[${recorded.map(fmtAction).join(", ")}]`
        );
      }
    } catch (e) {
      mismatched++;
      console.warn(`${tag} ERREUR rejeu turn#${i}: ${e && e.message}`);
    }
  }

  console.log(
    `${tag} ${meta.action || ""} turns=${aiTurns.length} match=${matched} partial=${partial} mismatch=${mismatched}`
  );
  return { turns: aiTurns.length, matched, mismatched, partial };
}

// Graine déterministe pour rejouer un tour (même formule que enemyTurnHandler-like,
// dérivée de l'état → reproductible). Non transmise.
function turnSeed(before, casterId) {
  const key = (before.entities || []).map((e) => `${e.x},${e.y},${e.hp},${e.dead ? 1 : 0}`).join("|");
  return hashSeed(`res:${casterId}:${key}`);
}

/**
 * SHADOW DE RÉSOLUTION (Palier C — C1b). Rejoue resolveEnemyTurn(before) et compare
 * l'état final au `after` RÉEL du client, de façon STRUCTURELLE (RNG-insensible) :
 * positions, mort, DIRECTION de dégât (a pris des dégâts ou non, vs before), effets de
 * contrôle présents. But : débusquer les TROUS de résolution serveur (ex. confusion,
 * cost_hp_percent, chaînage) AVANT de flipper C. 100% passif (log seul).
 * NB : on NE compare PAS les HP exacts (le serveur tire son propre RNG ≠ Math.random
 * client) ; les écarts de MORT à la marge (cible presque morte) sont possibles et
 * bénins (loggés). Un vrai trou = direction de dégât inversée, mauvaise position,
 * effet de contrôle manquant/en trop.
 * @param {Array} aiTurns  { before, after, casterId, isBoss }
 * @param {object} [meta]
 * @returns {{turns:number, matched:number, mismatched:number}}
 */
export function runEnemyTurnResolutionShadow(aiTurns, meta = {}) {
  if (!Array.isArray(aiTurns) || aiTurns.length === 0) return { turns: 0, matched: 0, mismatched: 0 };
  const tag = `[shadow-res${meta.addr ? " " + String(meta.addr).slice(0, 8) : ""}]`;
  let matched = 0, mismatched = 0;

  for (let i = 0; i < aiTurns.length; i++) {
    const turn = aiTurns[i];
    try {
      if (!turn || !turn.before || !turn.after || turn.casterId == null) continue;
      const beforeEnts = turn.before.entities || [];
      const afterEnts = turn.after.entities || [];

      const result = resolveEnemyTurn(
        turn.before,
        { casterId: turn.casterId, isBoss: !!turn.isBoss },
        createRng(turnSeed(turn.before, turn.casterId)),
      );
      const got = result.finalEntities || [];

      const diffs = [];
      const n = Math.max(got.length, afterEnts.length);
      for (let k = 0; k < n; k++) {
        const b = beforeEnts[k], g = got[k], a = afterEnts[k];
        if (!g || !a) { if (!!g !== !!a) diffs.push(`e${k}:presence`); continue; }
        if (g.x !== a.x || g.y !== a.y) diffs.push(`e${k}:pos(${g.x},${g.y}≠${a.x},${a.y})`);
        if (!!g.dead !== !!a.dead) diffs.push(`e${k}:dead(${!!g.dead}≠${!!a.dead})`);
        if (b) {
          const gDmg = g.hp < b.hp, aDmg = a.hp < b.hp;
          if (gDmg !== aDmg) diffs.push(`e${k}:dmgDir(${gDmg}≠${aDmg})`);
        }
        // NB : on NE compare PAS les EFFETS ici. resolveEnemyTurn n'applique pas les
        // effets à son état de travail (ils voyagent dans les events → client) — limite
        // C1 assumée. La parité des effets par cast est déjà couverte par le SPELL-shadow
        // (pour les sorts routés). La shadow-res valide l'ORCHESTRATION : positions +
        // direction de dégât + mort (chaînage move/cast/atterrissage).
      }

      if (diffs.length === 0) {
        matched++;
      } else {
        mismatched++;
        console.warn(`${tag} ÉCART turn#${i} caster=${turn.casterId} boss=${!!turn.isBoss} : ${diffs.slice(0, 6).join(" ")}`);
      }
    } catch (e) {
      mismatched++;
      console.warn(`${tag} ERREUR turn#${i}: ${e && e.message}`);
    }
  }

  console.log(`${tag} ${meta.action || ""} turns=${aiTurns.length} match=${matched} mismatch=${mismatched}`);
  return { turns: aiTurns.length, matched, mismatched };
}

/**
 * Logge les tours d'IA observés. Pur log, aucune exception propagée.
 * @param {Array} aiTurns
 * @param {object} [meta] - contexte de log (ex. { addr, action }).
 * @returns {{turns:number, actions:number}}
 */
export function logShadowAITurns(aiTurns, meta = {}) {
  if (!Array.isArray(aiTurns) || aiTurns.length === 0) {
    return { turns: 0, actions: 0 };
  }

  const tag = `[shadow-ai${meta.addr ? " " + String(meta.addr).slice(0, 8) : ""}]`;
  let totalActions = 0;

  for (let i = 0; i < aiTurns.length; i++) {
    const turn = aiTurns[i];
    try {
      if (!turn || typeof turn !== "object") continue;
      const actions = Array.isArray(turn.actions) ? turn.actions : [];
      totalActions += actions.length;
      const nEntities = (turn.before && Array.isArray(turn.before.entities))
        ? turn.before.entities.length
        : "?";
      const seq = actions.map(fmtAction).join(", ");
      console.log(
        `${tag} turn#${i} caster=${turn.casterId} boss=${!!turn.isBoss} ` +
          `entities=${nEntities} actions=${actions.length} seq=[${seq}]`
      );
    } catch (e) {
      console.warn(`${tag} log tour#${i} ignoré: ${e && e.message}`);
    }
  }

  console.log(`${tag} ${meta.action || ""} turns=${aiTurns.length} actions=${totalActions}`);
  return { turns: aiTurns.length, actions: totalActions };
}

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

import { planEnemyTurn, castMovesCaster } from "./enemy_ai_driver.js";

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
            ` client=[${recorded.map(fmtAction).join(", ")}]`
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

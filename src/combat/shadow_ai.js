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

// Représentation compacte d'une action pour le log.
function fmtAction(a) {
  if (!a || typeof a !== "object") return "?";
  if (a.type === "cast") return `cast:${a.spellKey}@(${a.targetX},${a.targetY})`;
  if (a.type === "move") return `move->(${a.toX},${a.toY})`;
  return String(a.type || "?");
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

// =============================================================================
// DRIVER IA ENNEMIE SERVEUR (Phase 2b.4 — decideNextEnemyAction)
// =============================================================================
// `planEnemyTurn(before, options)` reproduit, côté serveur, la SÉQUENCE d'actions
// atomiques que l'IA client joue sur un tour d'ennemi PVM — SANS animation, SANS
// timer, SANS state. Il SIMULE fidèlement le graphe d'appels de combat.js :
//   enemyAI → bossEnemyAI | continueNormalEnemyAI → enemyMoveAndAttack / continueEnemyAI
//             + tryToAttack/tryToHeal/tryToBuff/tryToDebuff/tryToRetreat
// Au lieu d'appeler executeAction/moveEntityTo, chaque "exécution" ÉMET une intention
// et mute une COPIE de travail (position, pm, hasAttacked). La DÉCISION pure provient
// des leaves déjà extraits+fuzz-prouvés (combat_ai.js) ; la géométrie des primitifs
// purs (combat_geometry.js). AUCUN RNG (l'IA est 100% déterministe — constat 2b.4).
//
// Sortie : { actions:[ {type:'cast',spellKey,targetX,targetY}
//                     | {type:'move',toX,toY}
//                     | {type:'endTurn'} ], suffixUncertain, notes[] }
// `suffixUncertain` = true dès qu'un sort déplace le LANCEUR (charge/assault/
// teleport_self) : le mouvement primaire n'est pas (encore) routé par le moteur →
// la position post-cast est inconnue serveur → les actions SUIVANTES ne sont pas
// fiables (le comparateur shadow ne validera que jusque-là).
//
// Règle de case de cast (validée sur les logs shadow-ai réels) :
//   range 0 (self/heal/buff/auto-centré) → position du lanceur ; sinon → case cible.
//   (getCastTileForAreaSpell/getAssaultLandingTile ne sont pas encore extraits purs ;
//    sur les séquences observées, la case cible suffit. À affiner si écarts AoE.)
// =============================================================================

import { SPELLS } from "./engine/spells_data.js";
import {
  isInCombatZone,
  isTileWalkable,
  computeReachableTiles,
  computeLineOfSight,
  computeChargePathClear,
} from "./engine/combat_geometry.js";
import {
  selectClosestTargets,
  computeMaxAttackRange,
  hasPowerfulSelfBuffActive,
  selectHealCandidates,
  selectBuffCandidates,
  selectAttackSpells,
  computeBestRetreatTile,
  selectMoveTile,
  selectDebuffSpells,
  selectRetreatTile,
  canCastPrioritySelfSpell,
  canCastPriorityOffensiveSpell,
  selectApproachTileInRange,
} from "./engine/combat_ai.js";

// Constantes IA répliquées de combat.js (continueNormalEnemyAI l.~11800-11813).
const CTRL_SPELLS = ["electric_cage", "psychosis", "funeral_song", "flash"];
const POWERFUL_SELF_BUFFS = [
  "camouflage", "invulnerability", "mirror", "dragon_concentration", "ultra_instinct",
  "titanium_shield", "falcon_eye", "ancestral_root", "flaming_overpower", "bolt_shoes",
];

// Sorts qui déplacent le LANCEUR (mouvement primaire non routé par le moteur).
// Après l'un d'eux, la position serveur du lanceur est inconnue → suffixe non fiable.
const CASTER_MOVING_SPELLS = new Set(["charge", "assault"]);
function isCasterMoving(spell, spellKey) {
  if (CASTER_MOVING_SPELLS.has(spellKey) || CASTER_MOVING_SPELLS.has(spell && spell.id)) return true;
  if (spell && spell.effect_type === "movement" && spell.move_direction === "teleport_self") return true;
  return false;
}

// Variante par clé seule (pour le comparateur shadow qui n'a que spellKey).
export function castMovesCaster(spellKey) {
  return isCasterMoving(SPELLS[spellKey], spellKey);
}

const getSpell = (k) => SPELLS[k];
function hasControlEffect(entity, controlType) {
  if (!entity) return false;
  return (entity.effects || []).some(
    (e) => e.type === "control" && e.control_effect === controlType && e.duration > 0
  );
}

// effectiveRange : réplique getEffectiveSpellRange (combat_ai l'inline aussi). Utilisé
// hors leaves (CTRL offensif / priorité self), donc redéfini ici à l'identique.
function getEffectiveSpellRange(spell, entity) {
  const baseSpellRange = spell.range || 0;
  const aoeExtend = spell.area && (spell.aoe_size || 0) > 0 ? spell.aoe_size || 0 : 0;
  if (baseSpellRange === 0 && spell.area) return spell.aoe_size || 1;
  if (baseSpellRange === 0) return 0;
  let castRange;
  if (spell.fixedRange === true) {
    castRange = baseSpellRange;
  } else {
    let rangeBonus = 0;
    (entity && entity.effects ? entity.effects : []).forEach((effect) => {
      if ((effect.type === "buff" || effect.type === "debuff") && effect.stat === "range") rangeBonus += effect.value;
    });
    castRange = Math.max(1, baseSpellRange + rangeBonus);
  }
  if (aoeExtend > 0) {
    const isConeOrLine = spell.aoe_type === "cone" || spell.aoe_type === "line";
    return isConeOrLine ? castRange + aoeExtend - 1 : castRange + aoeExtend;
  }
  return castRange;
}

// --------------------------------------------------------------------------
// Contexte géométrique serveur (réplique du câblage combat.js des leaves/primitifs).
// --------------------------------------------------------------------------
function buildGeoCtx(before) {
  const m = before.combatMap;
  const mapBounds = m
    ? { width: m.width, height: m.height, offsetX: m.offsetX || 0, offsetY: m.offsetY || 0 }
    : null;
  const statueActive = !!(
    before.isPvp ||
    (before.dungeonInfo && (before.dungeonInfo.type || before.dungeonInfo.isChampionsTower))
  );
  const blocked = new Set(Array.isArray(before.blockedTerrain) ? before.blockedTerrain : []);
  const isTerrainBlocked = (x, y) => blocked.has(`${x},${y}`);
  const blocksLoS = isTerrainBlocked; // côté serveur, mur de terrain = bloque la LdV (parité gameMap===1/2)

  // entities = liste vivante de travail (mutée au fil du tour pour l'occupation/positions).
  return { mapBounds, statueActive, isTerrainBlocked, blocksLoS };
}

// Prédicats dépendant de la liste d'entités COURANTE (recalculés à chaque besoin car
// les positions changent quand l'ennemi se déplace).
function makePredicates(geo, entities) {
  const isWalkable = (x, y) =>
    isTileWalkable(x, y, {
      mapBounds: geo.mapBounds,
      statueActive: geo.statueActive,
      isTerrainBlocked: geo.isTerrainBlocked,
      entities,
    });
  const hasLoS = (x1, y1, x2, y2) =>
    computeLineOfSight(x1, y1, x2, y2, { mapBounds: geo.mapBounds, blocksLoS: geo.blocksLoS, entities });
  const isObstacleTile = (x, y) => geo.isTerrainBlocked(x, y);
  const isChargePathClear = (x1, y1, x2, y2, sourceEntity) =>
    computeChargePathClear(x1, y1, x2, y2, {
      mapBounds: geo.mapBounds,
      isTerrainBlocked: geo.isTerrainBlocked,
      entities,
      sourceEntity,
    });
  const hasCover = (x, y) => geo.isTerrainBlocked(x, y); // blocksLineOfSight ~ terrain bloquant
  const reachable = (entity) => computeReachableTiles(entity, { mapBounds: geo.mapBounds, isWalkable });
  return { isWalkable, hasLoS, isObstacleTile, isChargePathClear, hasCover, reachable };
}

// Case de cast générique (heal/buff/debuff/CTRL) : range 0 → lanceur, sinon → cible.
function castTileFor(spell, ae, target) {
  if (spell.range === 0) return { x: ae.x, y: ae.y };
  return { x: target.x, y: target.y };
}

// Case de cast pour les sorts de ZONE avec range>0 (cône/ligne/circulaire) — réplique
// VERBATIM de combat_utils.getCastTileForAreaSpell. La case visée est à castRange du
// lanceur EN DIRECTION de la cible (pas la case de la cible) pour que la zone la touche.
// Pure (lit attacker.effects pour le bonus de portée).
function getCastTileForAreaSpell(attacker, target, spell) {
  if (!spell.area || !(spell.range > 0)) return { x: target.x, y: target.y };
  const baseRange = spell.range || 0;
  let castRange = baseRange;
  if (!spell.fixedRange && attacker && attacker.effects) {
    let rangeBonus = 0;
    attacker.effects.forEach((e) => {
      if ((e.type === "buff" || e.type === "debuff") && e.stat === "range") rangeBonus += e.value;
    });
    castRange = Math.max(1, baseRange + rangeBonus);
  }
  const dx = target.x - attacker.x;
  const dy = target.y - attacker.y;
  const dist = Math.abs(dx) + Math.abs(dy);
  if (dist <= 0) return { x: attacker.x, y: attacker.y };
  const stepX = (dx !== 0 ? (dx > 0 ? 1 : -1) : 0) * Math.min(castRange, Math.abs(dx));
  const remaining = castRange - Math.min(castRange, Math.abs(dx));
  const stepY = (dy !== 0 ? (dy > 0 ? 1 : -1) : 0) * Math.min(remaining, Math.abs(dy));
  return { x: attacker.x + stepX, y: attacker.y + stepY };
}

// Case de cast d'une ATTAQUE — réplique le bloc de tryToAttack (combat.js l.~12313) :
// range 0 → lanceur ; zone (aoe_size>0) → getCastTileForAreaSpell ; sinon → cible.
// (La branche s.id==='assault' du client est morte : le sort brut n'a pas d'`id` →
//  ignorée ici aussi pour rester byte-identique.)
function attackCastTile(spell, ae, target) {
  if (spell.range === 0) return { x: ae.x, y: ae.y };
  if (spell.area && (spell.aoe_size || 0) > 0) return getCastTileForAreaSpell(ae, target, spell);
  return { x: target.x, y: target.y };
}

/**
 * Planifie la séquence d'actions d'un tour d'ennemi PVM.
 * @param {object} before - état type captureCombatShadowState : { entities, combatMap, blockedTerrain, isPvp, dungeonInfo }.
 * @param {{casterId:number, isBoss?:boolean}} options - identité de l'ennemi actif (INDEX dans before.entities).
 * @returns {{actions:Array, suffixUncertain:boolean, notes:string[]}}
 */
export function planEnemyTurn(before, options = {}) {
  const out = { actions: [], suffixUncertain: false, notes: [] };
  try {
    // Copie de travail des entités (positions/pm/hasAttacked mutés au fil du tour).
    const entities = (before.entities || []).map((e) => ({ ...e, effects: (e.effects || []).map((x) => ({ ...x })) }));
    const ae = entities[options.casterId];
    if (!ae || ae.dead || ae.type !== "enemy") {
      out.actions.push({ type: "endTurn" });
      return out;
    }
    if (!Array.isArray(ae.failedSpellsThisTurn)) ae.failedSpellsThisTurn = [];

    const geo = buildGeoCtx(before);

    // emit + mutations -----------------------------------------------------
    const emitCast = (spell, spellKey, tile) => {
      out.actions.push({ type: "cast", spellKey, targetX: tile.x, targetY: tile.y });
      ae.hasAttacked = true;
      if (spell.cooldown > 0) {
        ae.spellCooldowns = { ...(ae.spellCooldowns || {}) };
        ae.spellCooldowns[spellKey] = spell.cooldown;
      }
      if (isCasterMoving(spell, spellKey)) {
        out.suffixUncertain = true;
        out.notes.push(`mouvement primaire (${spellKey}) → position post-cast inconnue`);
      }
    };
    const emitMove = (tile) => {
      out.actions.push({ type: "move", toX: tile.x, toY: tile.y });
      ae.x = tile.x;
      ae.y = tile.y;
      ae.pm = Math.max(0, (ae.pm || 0) - (tile.cost || 0));
    };

    if (options.isBoss || ae.isBoss) planBossTurn(ae, entities, geo, emitCast, emitMove);
    else planNormalTurn(ae, entities, geo, emitCast, emitMove);

    out.actions.push({ type: "endTurn" });
    return out;
  } catch (e) {
    out.notes.push("exception: " + (e && e.message));
    if (out.actions.length === 0 || out.actions[out.actions.length - 1].type !== "endTurn") {
      out.actions.push({ type: "endTurn" });
    }
    return out;
  }
}

// ===========================================================================
// IA normale — réplique continueNormalEnemyAI (combat.js l.11732).
// ===========================================================================
function planNormalTurn(ae, entities, geo, emitCast, emitMove) {
  // Cibles triées.
  const targetDistances = selectClosestTargets(ae, entities);
  if (targetDistances.length === 0) return;

  let primaryTarget = targetDistances[0].target;
  const currentDist = targetDistances[0].dist;
  const maxRange = computeMaxAttackRange(ae, getSpell, { includeDebuff: true });

  // PRIORITÉ 0 : sorts de contrôle offensifs (héros puis dofemons adverses).
  const heroAdverse = entities.find((e) => e.type === "hero" && !e.dead && !hasControlEffect(e, "invisible"));
  const dofAdverses = entities.filter((e) => e.type === "ally" && !e.dead && !hasControlEffect(e, "invisible"));
  for (const spellKey of CTRL_SPELLS) {
    if (heroAdverse && tryPriorityOffensive(ae, heroAdverse, spellKey, entities, geo, emitCast, emitMove)) return;
    for (const dof of dofAdverses) {
      if (tryPriorityOffensive(ae, dof, spellKey, entities, geo, emitCast, emitMove)) return;
    }
  }

  // PRIORITÉ 1 : buffs puissants sur soi (sauf si déjà actif).
  if (!hasPowerfulSelfBuffActive(ae, getSpell, POWERFUL_SELF_BUFFS)) {
    for (const spellKey of POWERFUL_SELF_BUFFS) {
      const s = getSpell(spellKey);
      if (s && canCastPrioritySelfSpell(ae, s, spellKey)) {
        emitCast(s, spellKey, castTileFor(s, ae, ae));
        planContinue(ae, entities, geo, emitCast, emitMove); // → repositionnement
        return;
      }
    }
  }

  // Heal si HP < 50%.
  if (ae.hp / ae.maxHp < 0.5 && tryToHeal(ae, entities, geo, emitCast)) {
    planContinue(ae, entities, geo, emitCast, emitMove);
    return;
  }

  // Attaque si à portée.
  if (currentDist <= maxRange) {
    let attacked = tryToAttack(ae, primaryTarget, entities, geo, emitCast);
    if (!attacked && targetDistances.length > 1) {
      for (let i = 1; i < targetDistances.length; i++) {
        if (targetDistances[i].dist <= maxRange) {
          attacked = tryToAttack(ae, targetDistances[i].target, entities, geo, emitCast);
          if (attacked) { primaryTarget = targetDistances[i].target; break; }
        }
      }
    }
    if (attacked) {
      // Après attaque : recul si PM restant (et pas paralysé).
      if (ae.hasAttacked && ae.pm > 0 && !hasControlEffect(ae, "paralyzed")) {
        tryToRetreat(ae, primaryTarget, entities, geo, emitMove);
      }
    } else {
      moveAndAttack(ae, primaryTarget, maxRange, entities, geo, emitCast, emitMove);
    }
  } else {
    moveAndAttack(ae, primaryTarget, maxRange, entities, geo, emitCast, emitMove);
  }
}

// ===========================================================================
// IA boss — réplique bossEnemyAI (combat.js l.11591).
// ===========================================================================
function planBossTurn(ae, entities, geo, emitCast, emitMove) {
  const hero = entities.find((e) => e.type === "hero" && !e.dead && !hasControlEffect(e, "invisible"));
  const allyDofemons = entities.filter((e) => e.type === "ally" && !e.dead && !hasControlEffect(e, "invisible"));
  const maxRange = computeMaxAttackRange(ae, getSpell, { includeDebuff: false });

  // Soin d'urgence < 30%.
  if (ae.hp / ae.maxHp < 0.3 && tryToHeal(ae, entities, geo, emitCast)) return;

  const fallback = () => {
    if (tryToBuff(ae, entities, geo, emitCast)) return;
    if (allyDofemons.length > 0) {
      const sorted = [...allyDofemons].sort(
        (a, b) => Math.abs(a.x - ae.x) + Math.abs(a.y - ae.y) - (Math.abs(b.x - ae.x) + Math.abs(b.y - ae.y))
      );
      moveAndAttack(ae, sorted[0], maxRange, entities, geo, emitCast, emitMove);
    }
  };

  if (!hero) { fallback(); return; }

  const heroDist = Math.abs(ae.x - hero.x) + Math.abs(ae.y - hero.y);
  if (heroDist <= maxRange) {
    if (tryToAttack(ae, hero, entities, geo, emitCast)) return;
    fallback();
    return;
  }

  // Pas à portée : se rapprocher du héros (case reachable la plus proche, fallback LdV).
  if (ae.pm > 0) {
    const preds = makePredicates(geo, entities);
    const reachable = preds.reachable(ae);
    let bestTile = null;
    let bestDist = heroDist;
    reachable.forEach((tile) => {
      if (tile.x === ae.x && tile.y === ae.y) return;
      const td = Math.abs(tile.x - hero.x) + Math.abs(tile.y - hero.y);
      if (td < bestDist) { bestDist = td; bestTile = tile; }
    });
    if (!bestTile) {
      let bestLos = Infinity;
      reachable.forEach((tile) => {
        if (tile.x === ae.x && tile.y === ae.y) return;
        const td = Math.abs(tile.x - hero.x) + Math.abs(tile.y - hero.y);
        if (td <= maxRange && preds.hasLoS(tile.x, tile.y, hero.x, hero.y) && td < bestLos) {
          bestLos = td; bestTile = tile;
        }
      });
    }
    if (bestTile) {
      emitMove(bestTile);
      const newDist = Math.abs(ae.x - hero.x) + Math.abs(ae.y - hero.y);
      if (newDist <= maxRange && !ae.hasAttacked) {
        if (tryToAttack(ae, hero, entities, geo, emitCast)) return;
      }
      fallback();
      return;
    }
  }
  fallback();
}

// ===========================================================================
// continueEnemyAI — réplique combat.js l.12054 (après self-buff/heal).
// ===========================================================================
function planContinue(ae, entities, geo, emitCast, emitMove) {
  if (ae.dead) return;
  const targetDistances = selectClosestTargets(ae, entities);
  if (targetDistances.length === 0) return;
  const primaryTarget = targetDistances[0].target;
  const currentDist = targetDistances[0].dist;
  const maxRange = computeMaxAttackRange(ae, getSpell, { includeDebuff: true });

  if (ae.hp / ae.maxHp < 0.5 && tryToHeal(ae, entities, geo, emitCast)) return;

  if (currentDist <= maxRange) {
    if (tryToAttack(ae, primaryTarget, entities, geo, emitCast)) {
      if (ae.hasAttacked && ae.pm > 0 && !hasControlEffect(ae, "paralyzed")) {
        tryToRetreat(ae, primaryTarget, entities, geo, emitMove);
      }
      return;
    }
    moveAndAttack(ae, primaryTarget, maxRange, entities, geo, emitCast, emitMove);
  } else {
    moveAndAttack(ae, primaryTarget, maxRange, entities, geo, emitCast, emitMove);
  }
}

// ===========================================================================
// enemyMoveAndAttack — réplique combat.js l.11879.
// ===========================================================================
function moveAndAttack(ae, target, maxRange, entities, geo, emitCast, emitMove) {
  if (hasControlEffect(ae, "paralyzed")) {
    const dist = Math.abs(ae.x - target.x) + Math.abs(ae.y - target.y);
    const preds = makePredicates(geo, entities);
    if (dist <= maxRange && preds.hasLoS(ae.x, ae.y, target.x, target.y) && !ae.hasAttacked) {
      tryToAttack(ae, target, entities, geo, emitCast);
    }
    return;
  }

  const preds = makePredicates(geo, entities);
  const reachable = preds.reachable(ae);
  if (reachable.length === 0) {
    const dist = Math.abs(ae.x - target.x) + Math.abs(ae.y - target.y);
    if (dist <= maxRange && preds.hasLoS(ae.x, ae.y, target.x, target.y)) {
      tryToAttack(ae, target, entities, geo, emitCast);
    }
    return;
  }

  const retreatInfo = computeBestRetreatTile(ae, target, {
    mapBounds: geo.mapBounds,
    isWalkable: preds.isWalkable,
    hasLoS: preds.hasLoS,
    reachableTiles: reachable,
  });
  const bestTile = selectMoveTile(ae, target, maxRange, {
    reachableTiles: reachable,
    hasLoS: preds.hasLoS,
    getSpell,
    retreatInfo,
  });

  if (bestTile) {
    emitMove(bestTile);
    if (ae.dead) return;
    const newDist = Math.abs(ae.x - target.x) + Math.abs(ae.y - target.y);
    if (newDist <= maxRange && !ae.hasAttacked) {
      if (tryToAttack(ae, target, entities, geo, emitCast)) {
        if (ae.hasAttacked && ae.pm > 0 && !hasControlEffect(ae, "paralyzed")) {
          tryToRetreat(ae, target, entities, geo, emitMove);
        }
      } else if (!ae.hasAttacked) {
        if (!tryToDebuff(ae, target, entities, geo, emitCast)) {
          if (!tryToHeal(ae, entities, geo, emitCast)) tryToBuff(ae, entities, geo, emitCast);
        }
      }
    } else if (!ae.hasAttacked) {
      if (!tryToHeal(ae, entities, geo, emitCast)) tryToBuff(ae, entities, geo, emitCast);
    }
  } else {
    const currentDist = Math.abs(ae.x - target.x) + Math.abs(ae.y - target.y);
    if (currentDist <= maxRange) {
      if (!tryToAttack(ae, target, entities, geo, emitCast) && !ae.hasAttacked) {
        if (!tryToDebuff(ae, target, entities, geo, emitCast) && !tryToHeal(ae, entities, geo, emitCast)) {
          tryToBuff(ae, entities, geo, emitCast);
        }
      }
    } else if (!ae.hasAttacked) {
      if (!tryToHeal(ae, entities, geo, emitCast)) tryToBuff(ae, entities, geo, emitCast);
    }
  }
}

// ===========================================================================
// Leaves d'exécution (décision pure combat_ai + émission/mutation).
// ===========================================================================
function tryToAttack(ae, target, entities, geo, emitCast) {
  if (!target || target.dead || ae.dead || ae.hasAttacked) return false;
  const preds = makePredicates(geo, entities);
  const attackSpells = selectAttackSpells(ae, target, {
    getSpell,
    hasLoS: preds.hasLoS,
    isChargePathClear: (x1, y1, x2, y2) => preds.isChargePathClear(x1, y1, x2, y2, ae),
    isObstacleTile: preds.isObstacleTile,
  });
  if (attackSpells.length === 0) return false;
  const { spell, key } = attackSpells[0];
  emitCast(spell, key, attackCastTile(spell, ae, target));
  return true;
}

function tryToHeal(ae, entities, geo, emitCast) {
  if (!ae || ae.dead || ae.hasAttacked) return false;
  if (ae.hp / ae.maxHp >= 0.5) return false;
  const healSpells = selectHealCandidates(ae, getSpell);
  for (const { spell, key } of healSpells) {
    if (spell.range === 0 || spell.area) { emitCast(spell, key, { x: ae.x, y: ae.y }); return true; }
    if (getEffectiveSpellRange(spell, ae) >= 1) { emitCast(spell, key, { x: ae.x, y: ae.y }); return true; }
  }
  return false;
}

function tryToBuff(ae, entities, geo, emitCast) {
  if (!ae || ae.dead || ae.hasAttacked) return false;
  const buffSpells = selectBuffCandidates(ae, getSpell);
  for (const { spell, key } of buffSpells) {
    if (spell.range === 0 || spell.area) { emitCast(spell, key, { x: ae.x, y: ae.y }); return true; }
    if (getEffectiveSpellRange(spell, ae) >= 1) { emitCast(spell, key, { x: ae.x, y: ae.y }); return true; }
  }
  return false;
}

function tryToDebuff(ae, target, entities, geo, emitCast) {
  if (!ae || !target || ae.dead || target.dead || ae.hasAttacked) return false;
  const preds = makePredicates(geo, entities);
  const debuffSpells = selectDebuffSpells(ae, target, { getSpell, hasLoS: preds.hasLoS });
  if (debuffSpells.length === 0) return false;
  const { spell, key } = debuffSpells[0];
  // Client tryToDebuff : executeAction(target.x, target.y) — toujours la case cible.
  emitCast(spell, key, { x: target.x, y: target.y });
  return true;
}

function tryToRetreat(ae, enemy, entities, geo, emitMove) {
  if (!ae || !enemy || ae.dead || enemy.dead || !ae.hasAttacked || ae.pm <= 0) return false;
  if (hasControlEffect(ae, "paralyzed")) return false;
  const preds = makePredicates(geo, entities);
  const reachable = preds.reachable(ae);
  if (reachable.length === 0) return false;
  const bestTile = selectRetreatTile(ae, enemy, { reachableTiles: reachable, hasCover: preds.hasCover });
  if (bestTile) { emitMove(bestTile); return true; }
  return false;
}

// CTRL offensif prioritaire — réplique tryPriorityOffensiveSpellWild (combat.js l.11481).
function tryPriorityOffensive(ae, target, spellKey, entities, geo, emitCast, emitMove) {
  const spell = getSpell(spellKey);
  if (!spell) return false;
  if (!canCastPriorityOffensiveSpell(ae, target, spell, spellKey)) return false;
  const effectiveRange = getEffectiveSpellRange(spell, ae);
  const dist = Math.abs(ae.x - target.x) + Math.abs(ae.y - target.y);
  if (dist <= effectiveRange) {
    // Client tryPriorityOffensiveSpellWild : executeAction(target.x, target.y).
    emitCast(spell, spellKey, { x: target.x, y: target.y });
    return true;
  }
  if (ae.pm > 0) {
    const preds = makePredicates(geo, entities);
    const reachable = preds.reachable(ae);
    const bestTile = selectApproachTileInRange(reachable, target, effectiveRange);
    if (bestTile) {
      emitMove(bestTile);
      // Après le déplacement, lancer le CTRL si toujours valide (cf. callback client).
      if (!hasControlEffect(target, spell.control_effect) && !(ae.spellCooldowns && ae.spellCooldowns[spellKey] > 0)) {
        emitCast(spell, spellKey, { x: target.x, y: target.y });
      }
      return true;
    }
  }
  return false;
}

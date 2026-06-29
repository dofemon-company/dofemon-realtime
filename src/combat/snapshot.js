// =============================================================================
// SNAPSHOT SERVEUR (Phase 2b.3 — S1)
// =============================================================================
// Construit le snapshot pur attendu par le moteur (resolveSpell/resolveTargets)
// À PARTIR DE L'ÉTAT DE COMBAT STOCKÉ (player_saves.activeCombat), sans aucun DOM
// ni singleton `state`. Équivalent serveur de combat.js:buildSpellSnapshot.
//
// HYPOTHÈSES VALIDÉES (cf. analyse 2026-06-28) :
//  - heroStats=null : le baseStats du héros inclut DÉJÀ l'équipement (l'entité héros
//    est créée avec getHeroStats() au début du combat, l'équipement est figé pendant
//    le combat). Donc getActualStats côté serveur = identique sans getHeroStats.
//
// ⚠️ CHAMPS NON SÉRIALISÉS AUJOURD'HUI (enrichissements client requis pour parité 100%) :
//  - passiveEffect : absent de combat_serialization.js → les passifs (hp_boost…) sont
//    IGNORÉS côté serveur tant qu'on ne l'ajoute pas à la sérialisation.
//  - isWildWeakVillageMon : absent → attackerIsWildWeak=false (nerf début de jeu non
//    reproduit serveur → écart possible sur sauvages faibles).
//  - isPvpOpponent : absent → undefined (sans impact pour PVM).
//
// ✅ RÉSOLU : terrain (cases bloquées) désormais sérialisé via combatState.blockedTerrain
//    (captureCombatShadowState l'échantillonne comme buildSpellSnapshot) → walkability
//    serveur correcte pour le mouvement autoritatif (push/pull contre obstacle).
// =============================================================================

import { getActualStats } from "./engine/combat_stats.js";
import { TYPE_CHART } from "./engine/constants.js";

// maxHp d'une entité sans aucun effet (pour dispel) — équivalent maxHpWithoutEffects client.
function maxHpWithoutEffects(entity, ctx) {
    const saved = entity.effects;
    entity.effects = [];
    try { return getActualStats(entity, ctx).maxHp; }
    finally { entity.effects = saved; }
}

/**
 * @param {object} combatState - état stocké (activeCombat) : entities[], combatMap, dungeonInfo…
 * @returns {object} snapshot pour resolveSpell/resolveTargets (entities indexés).
 */
export function buildSnapshotFromState(combatState) {
    const live = combatState.entities || [];
    const m = combatState.combatMap;
    const mapBounds = m
        ? { width: m.width, height: m.height, offsetX: m.offsetX || 0, offsetY: m.offsetY || 0 }
        : null;

    const statueActive = !!(
        combatState.isPvp ||
        (combatState.dungeonInfo && (combatState.dungeonInfo.type || combatState.dungeonInfo.isChampionsTower))
    );

    // Terrain bloqué. Deux sources possibles :
    //  - SHADOW : `combatState.blockedTerrain` (captureCombatShadowState l'échantillonne
    //    comme buildSpellSnapshot client) → liste "x,y".
    //  - VRAI SAVE (flip S4) : pas de blockedTerrain mais `gameMap` 2D complet est sérialisé
    //    (serializeCombatState) → on dérive les cases bloquées (gameMap[x][y]===1||2), même
    //    règle que le repli de sampleBlockedTerrain client. (combatMap.isWalkable est une
    //    FONCTION perdue au JSON → indisponible serveur ; gameMap est la source autoritative.)
    // Évite de gonfler le save d'une liste redondante.
    const blockedTerrain = new Set();
    if (Array.isArray(combatState.blockedTerrain) && combatState.blockedTerrain.length > 0) {
        for (const key of combatState.blockedTerrain) blockedTerrain.add(key);
    } else if (Array.isArray(combatState.gameMap)) {
        const gm = combatState.gameMap;
        for (let x = 0; x < gm.length; x++) {
            const col = gm[x];
            if (!col) continue;
            for (let y = 0; y < col.length; y++) {
                if (col[y] === 1 || col[y] === 2) blockedTerrain.add(`${x},${y}`);
            }
        }
    }

    // ctx commun de résolution de stats. heroStats=null (équipement déjà dans baseStats).
    // entities = la liste (pour les passifs ; passiveEffect doit être présent sinon ignoré).
    const ctx = { heroStats: null, equipRange: 0, entities: live };

    return {
        typeChart: TYPE_CHART,
        mapBounds,
        statueActive,
        blockedTerrain,
        entities: live.map((e) => ({
            id: live.indexOf(e), // identité = INDEX (comme buildSpellSnapshot client)
            type: e.type,
            isPvpOpponent: e.isPvpOpponent,
            isNPC: e.isNPC,
            isNPCCreature: e.isNPCCreature,
            hp: e.hp,
            maxHp: e.maxHp,
            pm: e.pm,
            maxPm: e.maxPm,
            dead: e.dead,
            x: e.x,
            y: e.y,
            elemType: e.elemType,
            // L'effet sérialisé porte caster = ID d'entité → on le convertit en INDEX.
            effects: (e.effects || []).map((ef) => ({
                ...ef,
                caster: ef.caster != null ? live.findIndex((x) => x.id === ef.caster) : ef.caster,
            })),
            passiveEffect: e.passiveEffect, // non sérialisé aujourd'hui → undefined
            stats: getActualStats(e, ctx),
            maxHpNoEffects: maxHpWithoutEffects(e, ctx),
            attackerIsWildWeak: !!e.isWildWeakVillageMon, // non sérialisé → false
        })),
    };
}

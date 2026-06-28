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
//  - terrain (combatMap.isWalkable) : seules width/height/offset sont sérialisées →
//    blockedTerrain VIDE. OK pour les sorts NON-mouvement (le shadow castSpell vise
//    d'abord dégâts/effets) ; à enrichir pour le mouvement.
//  - isPvpOpponent : absent → undefined (sans impact pour PVM).
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

    // ⚠️ terrain non sérialisé → vide (suffisant pour les sorts non-mouvement).
    const blockedTerrain = new Set();

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

// =============================================================================
// RÉSOLVEUR DE STATS PUR — Phase 2b
// =============================================================================
// Calcul des stats effectives d'une entité (base + équipement héros + effets
// buff/debuff + effets passifs du plateau), sous forme PURE : aucune lecture du
// singleton `state`. Les valeurs impures sont injectées par `ctx` :
//   - heroStats : override équipement pour un HÉROS hors PVP/coop ({pm,init,force})
//                 ou null (les autres entités ont déjà baseStats correct).
//   - equipRange: bonus de portée d'équipement (0 aujourd'hui).
//   - entities  : toutes les entités du combat (pour les effets passifs), ou null.
//
// Réplique fidèle de combat_utils.getActualStats (qui en devient un wrapper lisant
// `state`). `applyPassiveEffects` est déjà pur (lit seulement targetEntity +
// allEntities) → importé tel quel. Objectif : pouvoir recalculer les stats côté
// serveur (dispel/tick de tour autoritatifs, IA headless, bascule).
// =============================================================================

import { applyPassiveEffects } from './passive_effects.js';

/**
 * @param {object} entity - entité (baseStats, effects, type, maxHp…).
 * @param {{heroStats?:?object, equipRange?:number, entities?:?object[]}} [ctx]
 * @returns {object} stats effectives.
 */
export function getActualStats(entity, ctx = {}) {
    let stats = { ...entity.baseStats };

    // Override équipement HÉROS (hors PVP/coop) — fourni par la coquille.
    if (ctx.heroStats) {
        stats.pm = ctx.heroStats.pm;
        stats.init = ctx.heroStats.init;
        stats.force = ctx.heroStats.force;
        stats.range = entity.baseStats.range + (ctx.equipRange || 0);
    }

    // Effets buff/debuff de l'entité.
    entity.effects.forEach(effect => {
        if (effect.type === 'buff' || effect.type === 'debuff') {
            const stat = effect.stat;
            const value = effect.value;
            if (stats[stat] !== undefined) stats[stat] += value;
            else if (entity[stat] !== undefined) stats[stat] += value;
        }
    });

    // Effets passifs de toutes les entités en combat.
    if (ctx.entities) {
        const passiveModifications = applyPassiveEffects(entity, ctx.entities);
        if (passiveModifications.maxHp !== undefined) stats.maxHp = (stats.maxHp || entity.maxHp || 0) + passiveModifications.maxHp;
        if (passiveModifications.force !== undefined) stats.force = (stats.force || 0) + passiveModifications.force;
        if (passiveModifications.init !== undefined) stats.init = (stats.init || 0) + passiveModifications.init;
        if (passiveModifications.pm !== undefined) stats.pm = (stats.pm || 0) + passiveModifications.pm;
        if (passiveModifications.accuracy !== undefined) stats.accuracy = (stats.accuracy || 100) + passiveModifications.accuracy;
        if (passiveModifications.crit_chance !== undefined) stats.crit_chance = (stats.crit_chance || 0.01) + passiveModifications.crit_chance;
        if (passiveModifications.evasion !== undefined) stats.evasion = (stats.evasion || 0) + passiveModifications.evasion;
    }

    stats.pm = Math.max(0, stats.pm);
    stats.init = Math.max(0, stats.init);
    stats.force = Math.max(0, stats.force);
    stats.range = Math.max(1, stats.range);

    if (stats.dmg_reduc === undefined) stats.dmg_reduc = 0;
    if (stats.evasion === undefined) stats.evasion = 0;
    if (stats.accuracy === undefined) stats.accuracy = 100;
    if (stats.crit_chance === undefined) stats.crit_chance = 0.01;

    return stats;
}

// =============================================================================
// TICK DE FIN DE TOUR (décision pure) — Phase 2b
// =============================================================================
// Décrémente la durée des effets d'UNE entité, retire ceux expirés, et applique
// la conséquence de l'expiration d'un buff maxHp (Vitalité) : recalcul de maxHp
// via getActualStats (résolveur pur, ctx injecté), baisse des PV courants, et MORT
// éventuelle. Réplique fidèle de la DÉCISION de combat_utils.decreaseEffectDurations
// (l.1007-1067) SANS les logs i18n. Mute `entity` (effects/maxHp/hp/dead) et renvoie
// la liste des effets expirés (descripteurs) pour que la coquille rejoue les logs.
//
// @param {object} entity - entité tickée (mutée).
// @param {object} [ctx]  - contexte du résolveur de stats (entities, heroStats…).
// @returns {Array<{effect:object, vitality:boolean, killed:boolean}>} expirés.
export function tickEffectDurations(entity, ctx = {}) {
    const expired = [];
    if (!entity || !entity.effects) return expired;

    for (let i = entity.effects.length - 1; i >= 0; i--) {
        const effect = entity.effects[i];
        if (effect.duration === undefined) continue;

        effect.duration--;
        if (effect.duration > 0) continue;

        if (effect.type === 'buff' && effect.stat === 'maxHp' && effect.value > 0) {
            // Vitalité : retirer l'effet puis recalculer maxHp, rogner les PV, mort possible.
            const oldMaxHp = entity.maxHp;
            entity.effects.splice(i, 1);
            const statsAfter = getActualStats(entity, ctx);
            entity.maxHp = statsAfter.maxHp;
            const hpDecrease = oldMaxHp - statsAfter.maxHp;
            entity.hp = Math.max(0, entity.hp - hpDecrease);
            if (entity.hp > entity.maxHp) entity.hp = entity.maxHp;
            let killed = false;
            if (entity.hp <= 0) { entity.dead = true; entity.hp = 0; killed = true; }
            expired.push({ effect, vitality: true, killed });
            continue; // pas de message générique pour cet effet
        }

        entity.effects.splice(i, 1);
        expired.push({ effect, vitality: false, killed: false });
    }

    return expired;
}

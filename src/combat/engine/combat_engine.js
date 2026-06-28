// =============================================================================
// MOTEUR DE COMBAT PUR — Phase 2b
// =============================================================================
// Ce module héberge la LOGIQUE de combat sous forme de fonctions PURES :
// aucune dépendance au DOM, au singleton `state`, à l'i18n (`t`), au rendu
// (animations, floating text), aux timers, à la persistance ou au réseau.
//
// Objectif : pouvoir exécuter exactement les mêmes règles côté navigateur ET
// côté serveur (combat autoritatif anti-triche). Le client devient une « vue »
// qui rejoue les résultats produits ici.
//
// Étape 2b.1.a : socle RNG déterministe réutilisable. Le reste (résolution de
// sorts, effets, IA, récompenses) sera extrait progressivement dans ce module.
// =============================================================================

// Géométrie pure partagée (aucune dépendance DOM/state) : sert à résoudre les
// cibles et le mouvement d'un sort côté moteur (combat autoritatif).
import {
    getTargets as geomGetTargets,
    computeSlideDirection,
    slidePush,
    isTileWalkable,
} from './combat_geometry.js';

/**
 * PRNG Mulberry32 — générateur pseudo-aléatoire déterministe.
 *
 * Même algorithme que le PRNG PVP historique de `combat.js` (`_mulberry32`),
 * mais encapsulé dans une closure : chaque appel à `createRng` produit un flux
 * indépendant avec son propre état (pas de variable globale partagée).
 *
 * Un même `seed` produit toujours exactement la même séquence → indispensable
 * pour la parité (rejouer un combat) et pour l'autorité serveur.
 *
 * @param {number} seed - Graine entière (32 bits).
 * @returns {() => number} Fonction renvoyant un flottant dans [0, 1).
 */
export function createRng(seed) {
    let s = seed | 0;
    return function rng() {
        let t = (s += 0x6D2B79F5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Hash déterministe d'une chaîne en entier signé 32 bits.
 *
 * Même algorithme que les dérivations de seed pvp/coop de `combat.js`
 * (`_pvpTurnSeed`, `_coopActionSeed`, …). Permet de dériver un seed
 * reproductible à partir d'identifiants (matchId, entité, tour…).
 *
 * @param {string|number} str - Valeur source.
 * @returns {number} Entier 32 bits.
 */
export function hashSeed(str) {
    let hash = 0;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
        hash = ((hash << 5) - hash) + s.charCodeAt(i);
        hash |= 0;
    }
    return hash;
}

// =============================================================================
// CALCUL DE DÉGÂTS (pur) — Phase 2b.1.b
// =============================================================================
// Réplique EXACTE de la formule de dégâts par cible de combat.js
// (continueSpellExecution, ~l.8073-8208), mais SANS rendu/i18n/mutation.
//
// IMPORTANT : l'ordre et le nombre de tirages RNG sont conservés à l'identique
// (miss → esquive → roll de base → critique) pour garantir la parité avec le
// comportement historique. Les tirages conditionnels le restent :
//   - miss : tiré seulement si missChance > 0
//   - esquive : tirée seulement si evasion > 0
//   - roll de base : seulement si damageMin/damageMax définis
//   - critique : toujours tiré
//
// La coquille (combat.js) rassemble les entrées impures (getActualStats, boucles
// d'effets passifs sur state.combat.entities, getDamageMultiplier, flags) puis
// applique le résultat (HP, réflexion) et le rejoue (floating text, log).
//
// @param {object} ctx - Données déjà rassemblées (voir champs ci-dessous).
// @param {() => number} rng - Générateur [0,1) (pvpRandom côté client).
// @returns {{outcome:'miss'|'dodge'|'invulnerable'|'hit', isCrit:boolean, finalDmg:number}}
export function computeDamage(ctx, rng) {
    const {
        spell,                       // { damage, damageMin, damageMax }
        attackerForce = 0,           // attackerStats.force
        accuracy = 100,              // attackerStats.accuracy (brut, clampé ici)
        critChance = 0.01,           // attackerStats.crit_chance (brut, clampé ici)
        evasion = 0,                 // targetStats.evasion (brut, clampé ici)
        typeMult = 1,                // getDamageMultiplier(spell.type, target.elemType)
        attackBoostMult = 1,         // produit des type_attack_boost alliés (rawMultiplier initial)
        dmgDealtMult = 1,            // effet dmg_dealt_multiplier de l'attaquant (1 si absent)
        dmgReduc = 0,                // targetStats.dmg_reduc
        defenseBoostFactors = [],    // facteurs (1 - réduction) des alliés de la cible, dans l'ordre
        dmgTakenMult = 1,            // effet dmg_taken_multiplier de la cible (1 si absent)
        invulnerable = false,        // hasControlEffect(target, 'invulnerable')
        attackerIsWildWeak = false,  // isWildWeakVillageMon(attacker)
    } = ctx;

    // 1. Précision → ratage
    const acc = Math.max(0, Math.min(100, accuracy || 100));
    const missChance = 100 - acc;
    if (missChance > 0 && rng() * 100 < missChance) {
        return { outcome: 'miss', isCrit: false, finalDmg: 0 };
    }

    // 2. Esquive
    const ev = Math.max(0, Math.min(100, evasion || 0));
    if (ev > 0) {
        if (rng() * 100 < ev) {
            return { outcome: 'dodge', isCrit: false, finalDmg: 0 };
        }
    }

    // 3. Dégât de base (roll min/max)
    let baseDmg = spell.damage;
    if (spell.damageMin !== undefined && spell.damageMax !== undefined) {
        baseDmg = Math.floor(rng() * (spell.damageMax - spell.damageMin + 1)) + spell.damageMin;
    }

    // 4. Multiplicateurs cumulés (un seul Math.floor à la fin avant la défense)
    const baseRawDmg = baseDmg * (1 + attackerForce / 100);
    let rawMultiplier = attackBoostMult; // initial = produit des boosts d'attaque alliés

    // 5. Critique (toujours tiré)
    const cc = Math.max(0, Math.min(1, critChance || 0.01));
    const isCrit = rng() < cc;
    if (isCrit) rawMultiplier *= 1.5;

    // 6. Multiplicateur de dégâts infligés (attaquant)
    rawMultiplier *= dmgDealtMult;

    let rawDmg = Math.floor(baseRawDmg * rawMultiplier);
    let finalDmg = Math.floor(rawDmg * typeMult);

    // 7. Aide début de jeu : sauvage faible = dégâts directs ÷2
    if (attackerIsWildWeak) {
        finalDmg = Math.max(1, Math.floor(finalDmg * 0.5));
    }

    // 8. Invulnérabilité (avant les réductions de défense)
    if (invulnerable) {
        return { outcome: 'invulnerable', isCrit, finalDmg: 0 };
    }

    // 9. Réduction de dégâts générale
    finalDmg = Math.max(1, finalDmg - (dmgReduc || 0));

    // 10. Boosts de défense des alliés de la cible (dans l'ordre)
    for (const factor of defenseBoostFactors) {
        finalDmg = Math.floor(finalDmg * factor);
    }

    // 11. Multiplicateur de dégâts subis (cible)
    finalDmg = Math.floor(finalDmg * dmgTakenMult);

    return { outcome: 'hit', isCrit, finalDmg };
}

// =============================================================================
// LOOT DE VICTOIRE (pur) — Phase 2b.1.g (1/2)
// =============================================================================
// Tirage des objets lâchés par UN ennemi vaincu. Réplique EXACTE des jets de
// loot de combat.js (applyVictoryRewards ~l.405-438 et checkVictory ~l.11543-11586),
// dans le MÊME ordre et avec la MÊME sémantique de consommation RNG :
//   - chaque consommable = 1 jet ;
//   - la clé de donjon : le jet est TOUJOURS consommé (court-circuit &&), mais
//     ne tombe que si l'ennemi a un elemType de clé valide (`validKeyElemType`) ;
//   - les équipements : le jet de TYPE (1 parmi 6) n'est consommé QUE si le jet
//     de chance réussit.
//
// C'est l'épicentre anti-triche : isolé et seedé, ce calcul pourra être exécuté
// côté serveur autoritatif. La coquille applique les drops (createItem, push,
// incréments state.consumables) — le XP/or déterministe reste hors de cette fonction.
//
// @param {{validKeyElemType?: boolean}} ctx
// @param {() => number} rng
// @returns {Array<{kind:'consumable',key:string}|{kind:'key'}|{kind:'equip',rarity:string,typeIndex:number}>}
export function rollLootDrops(ctx, rng) {
    const { validKeyElemType = false } = ctx || {};
    const drops = [];

    if (rng() < 0.05) drops.push({ kind: 'consumable', key: 'stones_common' });
    if (rng() < 0.002) drops.push({ kind: 'consumable', key: 'stones_rare' });
    if (rng() < 0.0002) drops.push({ kind: 'consumable', key: 'stones_legendary' });

    if (rng() < 0.05) drops.push({ kind: 'consumable', key: 'potions_common' });
    if (rng() < 0.002) drops.push({ kind: 'consumable', key: 'potions_rare' });
    if (rng() < 0.0002) drops.push({ kind: 'consumable', key: 'potions_legendary' });

    // Clé : jet toujours consommé, drop conditionné au type de clé valide.
    if (rng() < 0.005 && validKeyElemType) drops.push({ kind: 'key' });

    // Équipements : jet de type (floor(rng*7)) seulement si le jet de chance réussit.
    // 7 = nombre de slots dans ITEM_TYPES (weapon, head, body, feet, hands, finger, neck).
    // Doit couvrir tous les index pour que le collier (dernier index) soit droppable.
    if (rng() < 0.05) drops.push({ kind: 'equip', rarity: 'Commun', typeIndex: Math.floor(rng() * 7) });
    if (rng() < 0.002) drops.push({ kind: 'equip', rarity: 'Rare', typeIndex: Math.floor(rng() * 7) });
    if (rng() < 0.00002) drops.push({ kind: 'equip', rarity: 'Legendary', typeIndex: Math.floor(rng() * 7) });

    if (rng() < 0.05) drops.push({ kind: 'consumable', key: 'energy_spheres_common' });
    if (rng() < 0.003) drops.push({ kind: 'consumable', key: 'energy_spheres_rare' });
    if (rng() < 0.0003) drops.push({ kind: 'consumable', key: 'energy_spheres_legendary' });

    if (rng() < 0.05) drops.push({ kind: 'consumable', key: 'recall_potion' });

    return drops;
}

// =============================================================================
// ORCHESTRATEUR DE RÉSOLUTION DE SORT (pur) — Phase 2b.1.e, TRANCHES 1+2
// =============================================================================
// `resolveSpell` compose les feuilles pures pour résoudre un sort de dégât.
// TRANCHE 1 = dégât direct mono-cible ; TRANCHE 2 = AoE = même bloc de dégâts
// répété sur `action.targetIds[]` (la géométrie qui produit cette liste reste,
// pour l'instant, résolue par la coquille ; elle deviendra pure en 2.b via
// mapBounds). Sorts visés : `damage>0`, sans effet annexe / mouvement / id
// spécial / capture / rage / self_ko. Couvre tout le chemin d'écriture des
// dégâts de combat.js (continueSpellExecution l.8067-8321 + mort de la cible
// l.8918-8934) : computeDamage → reflect_damage → damage_transfer → HP → mort.
//
// Le moteur :
//   - travaille sur une COPIE des entités (newState), jamais sur le state global ;
//   - émet des EVENTS ordonnés (rendu/log/journal/routage de mort) que la coquille
//     rejoue avec les lignes t()/log()/addFloatingText() d'origine ;
//   - conserve l'ORDRE et le NOMBRE de tirages RNG à l'identique (via computeDamage).
//
// Les valeurs impures (getActualStats, isWildWeakVillageMon) sont pré-résolues par
// la coquille dans le snapshot. Le typeChart est injecté (aucun import client ici).
//
// @param {{entities: Array, typeChart: object}} snapshot
// @param {{casterId:any, spell:object, targetIds?:Array, targetId?:any}} action
// @param {() => number} rng
// @returns {{events: Array, newState: {entities: Array}}}

/** Réplique pure d'isSameTeam (combat_utils) : équipe 'bad' = enemy, sinon 'good'. */
function sameTeam(a, b) {
    const t1 = a.type === 'enemy' ? 'bad' : 'good';
    const t2 = b.type === 'enemy' ? 'bad' : 'good';
    return t1 === t2;
}

/** Réplique pure de getDamageMultiplier (combat_utils) avec typeChart injecté. */
function damageMultiplier(typeChart, atkType, defType) {
    if (atkType === 'normal' || !typeChart || !typeChart[atkType]) return 1;
    const logic = typeChart[atkType];
    if (logic.strong.includes(defType)) return 1.5;
    return 1;
}

/** Réplique pure de hasControlEffect (combat.js). */
function hasControl(entity, controlType) {
    if (!entity) return false;
    return entity.effects.some(e => e.type === 'control' && e.control_effect === controlType && e.duration > 0);
}

// Effets de statut « simples » appliqués via un addEffect unique (combat.js bloc
// générique l.8535-8611). debuff/control/DoT = sur l'ennemi (3.a) ; buff = sur
// l'allié (3.b.2). multi_buff/random_buff ont leur propre chemin (ci-dessous).
// heal/transfer/dispel/set_hp_to_one/type_change/movement et effect_type_2 : plus tard.
const SINGLE_STATUS_EFFECTS = ['debuff', 'control', 'damage_over_time', 'buff'];

// =============================================================================
// RÉSOLUTION DES CIBLES (pure) — Phase 2b.3
// =============================================================================
// Calcule, côté moteur, la liste des cibles d'un sort à partir de la case visée
// (targetX, targetY) et du snapshot (entités + mapBounds), au lieu de faire
// confiance à une liste fournie par le client. C'est la pièce « anti-triche » du
// ciblage : le serveur décide qui est touché.
//
// Réplique fidèle du pipeline de ciblage de combat.js (continueSpellExecution)
// pour les sorts ROUTABLES par le moteur (isEngineSpell) : getTargets géométrique
// → cible le lanceur si range 0 sans zone → filtre par équipe → retire murs/trous
// → exclut le lanceur des AoE de dégât. Les sorts à mouvement / typeChange /
// dispel / ids spéciaux (charge, lasso, attraction, rage, capture…) sont exclus
// par isEngineSpell, donc leurs filtres dédiés n'ont pas à être reproduits ici.
//
// @param {{entities: Array, mapBounds?: ?object}} snapshot
// @param {{casterId:any, spell:object, targetX:number, targetY:number}} action
// @returns {Array} indices (id) des cibles touchées, dans l'ordre
export function resolveTargets(snapshot, action) {
    const { spell, casterId, targetX, targetY } = action;
    const entities = snapshot.entities;
    const caster = entities.find(e => e.id === casterId);
    if (!caster) return [];

    let targets = geomGetTargets(targetX, targetY, spell, caster, {
        entities,
        mapBounds: snapshot.mapBounds || null,
    });

    // combat.js l.8267-8271 : range 0 sans zone → le lanceur est la cible.
    if (spell.range === 0 && !spell.area) {
        if (!targets.includes(caster)) targets = [caster];
    }

    // combat.js l.8359-8378 : filtrage par équipe. Les flags movement/typeChange/
    // dispel/displacement sont tous faux pour un sort moteur → le bloc s'applique.
    if (spell.damage > 0 || spell.effect_type === 'debuff') {
        // Dégâts / debuff → ennemis.
        targets = targets.filter(t => !sameTeam(caster, t));
    } else if (
        spell.effect_type === 'heal' || spell.effect_type === 'heal_percent' ||
        spell.effect_type === 'transfer' || spell.effect_type === 'buff'
    ) {
        // Soin / transfert / buff → alliés (soi inclus).
        targets = targets.filter(t => sameTeam(caster, t));
    }
    // multi_buff / random_buff / set_hp_to_one : aucun filtre d'équipe (parité
    // historique — ils ne figurent dans aucune branche du bloc combat.js).

    // combat.js l.8381 : ni murs ni trous.
    targets = targets.filter(t => t.type !== 'wall' && t.type !== 'hole');

    // combat.js l.8409-8411 : une AoE de dégât (hors self_ko) exclut le lanceur.
    if (spell.damage > 0 && spell.area && !spell.self_ko) {
        targets = targets.filter(t => t !== caster);
    }

    return targets.map(t => t.id);
}

// =============================================================================
// MOUVEMENT SECONDAIRE (effect_type_2: movement) — Phase 2b, pur
// =============================================================================
// Résout le déplacement secondaire d'une cible (push / pull / téléportation),
// réplique fidèle de combat.js l.9029-9055. Compose des pièces déjà prouvées
// (computeSlideDirection + slidePush pour away/toward) et ajoute la téléportation
// (1 tirage rng — décision gameable, à préserver dans le flux — + check walkable).
//
// @param {number} casterX
// @param {number} casterY
// @param {number} targetX
// @param {number} targetY
// @param {object} spell
// @param {?object} mapBounds
// @param {(x:number,y:number)=>boolean} isWalkableFn - walkability (snapshot/state).
// @param {()=>number} rng - flux pseudo-aléatoire (téléportation uniquement).
// @returns {{x:number, y:number, moved:number, teleported:boolean}}
export function resolveSecondaryMovement(casterX, casterY, targetX, targetY, spell, mapBounds, isWalkableFn, rng) {
    if (spell.move_direction_2 === 'teleport_target' && spell.move_distance_2) {
        // 1 tirage TOUJOURS consommé (comme combat.js l.9033), avant le check walkable.
        const teleX = targetX + (rng() > 0.5 ? spell.move_distance_2 : -spell.move_distance_2);
        const teleY = targetY;
        if (isWalkableFn(teleX, teleY)) {
            return { x: teleX, y: teleY, moved: 0, teleported: true };
        }
        return { x: targetX, y: targetY, moved: 0, teleported: false };
    }
    if ((spell.move_direction_2 === 'away' || spell.move_direction_2 === 'toward') && spell.move_distance_2) {
        const { dirX, dirY } = computeSlideDirection(casterX, casterY, targetX, targetY, spell.move_direction_2);
        const slid = slidePush(targetX, targetY, dirX, dirY, spell.move_distance_2, mapBounds, isWalkableFn);
        return { x: slid.x, y: slid.y, moved: slid.moved, teleported: false };
    }
    return { x: targetX, y: targetY, moved: 0, teleported: false };
}

export function resolveSpell(snapshot, action, rng) {
    const { spell, casterId } = action;
    // Cibles : liste explicite (compat coquille/ tests) ; sinon, le moteur les
    // calcule lui-même depuis la case visée (Phase 2b.3, ciblage autoritatif).
    const targetIds = action.targetIds
        || (action.targetX !== undefined ? resolveTargets(snapshot, action) : [action.targetId]);
    const events = [];

    // Copie de travail : on clone entités + effets pour ne jamais muter le snapshot.
    const entities = snapshot.entities.map(e => ({
        ...e,
        effects: (e.effects || []).map(ef => ({ ...ef })),
    }));
    const byId = id => entities.find(e => e.id === id);

    const caster = byId(casterId);

    // Boucle multi-cibles (AoE = même bloc de dégâts répété). La mort est marquée au
    // fil de l'eau dans la copie de travail → les multiplicateurs de boost/défense par
    // passif des cibles suivantes excluent les morts (parité avec le forEach historique
    // + recalculateAllStats mid-boucle, car ces multiplicateurs lisent !dead ici même
    // et getActualStats — pré-résolu — est self-contained).
    for (const targetId of targetIds) {
        const target = byId(targetId);
        if (!target) continue;

        // Dégâts effectivement infligés à la cible (sert au drain). 0 si pas de dégât.
        let damageDone = 0;

        // 1. Orientation de l'attaquant vers la cible (rejouée par la coquille).
        events.push({ type: 'facing', casterId, x: target.x, y: target.y });

        // 2. Chemin de dégâts.
        if (spell.damage > 0) {
            const aStats = caster.stats || {};
            const tStats = target.stats || {};
            const typeMult = damageMultiplier(snapshot.typeChart, spell.type, target.elemType);

            // Produit des type_attack_boost des alliés vivants de l'attaquant (même ordre).
            let attackBoostMult = 1.0;
            for (const ally of entities) {
                if (!ally.dead && sameTeam(caster, ally) &&
                    ally.passiveEffect && ally.passiveEffect.type === 'type_attack_boost' &&
                    ally.passiveEffect.elementType === spell.type) {
                    attackBoostMult *= 1 + (ally.passiveEffect.value / 100);
                }
            }

            // dmg_dealt_multiplier de l'attaquant.
            const dmgDealtEffect = caster.effects.find(e =>
                e.type === 'control' && e.control_effect === 'dmg_dealt_multiplier');
            const dmgDealtMult = dmgDealtEffect ? dmgDealtEffect.value : 1;

            // Facteurs de défense des alliés vivants de la cible (même ordre d'itération).
            const defenseBoostFactors = [];
            for (const ally of entities) {
                if (!ally.dead && sameTeam(target, ally) && ally.passiveEffect) {
                    if (ally.passiveEffect.type === 'type_defense_boost' &&
                        ally.passiveEffect.elementType === spell.type) {
                        defenseBoostFactors.push(1 - (ally.passiveEffect.value / 100));
                    }
                    if (ally.passiveEffect.type === 'defense_boost') {
                        defenseBoostFactors.push(1 - (ally.passiveEffect.value / 100));
                    }
                }
            }

            // dmg_taken_multiplier de la cible.
            const dmgTakenEffect = target.effects.find(e =>
                e.type === 'control' && e.control_effect === 'dmg_taken_multiplier');
            const dmgTakenMult = dmgTakenEffect ? dmgTakenEffect.value : 1;

            const dmgResult = computeDamage({
                spell,
                attackerForce: aStats.force || 0,
                accuracy: aStats.accuracy,
                critChance: aStats.crit_chance,
                evasion: tStats.evasion,
                typeMult,
                attackBoostMult,
                dmgDealtMult,
                dmgReduc: tStats.dmg_reduc || 0,
                defenseBoostFactors,
                dmgTakenMult,
                invulnerable: hasControl(target, 'invulnerable'),
                attackerIsWildWeak: !!caster.attackerIsWildWeak,
            }, rng);

            if (dmgResult.outcome === 'miss') {
                events.push({ type: 'miss', targetId, sourceId: casterId });
                continue;
            }
            if (dmgResult.outcome === 'dodge') {
                events.push({ type: 'dodge', targetId, sourceId: casterId });
                continue;
            }
            if (dmgResult.isCrit) {
                events.push({ type: 'crit', targetId });
            }
            if (dmgResult.outcome === 'invulnerable') {
                events.push({ type: 'invulnerable', targetId });
                continue;
            }

            if (dmgTakenEffect) {
                events.push({ type: 'dmgTakenMod', targetId, value: dmgTakenEffect.value });
            }

            const finalDmg = dmgResult.finalDmg;
            let damageAfterReflection = finalDmg;
            let reflectedDmg = 0;

            // Reflect_damage (miroir) : une partie est renvoyée au lanceur, effet consommé.
            const reflectEffect = target.effects.find(e =>
                e.type === 'control' && e.control_effect === 'reflect_damage');
            if (reflectEffect && reflectEffect.duration > 0) {
                reflectedDmg = Math.floor(finalDmg * reflectEffect.value);
                damageAfterReflection = finalDmg - reflectedDmg;
                const percent = Math.floor(reflectEffect.value * 100);
                if (!caster.dead) {
                    caster.hp -= reflectedDmg;
                    events.push({ type: 'reflectDamage', fromId: targetId, toId: casterId, amount: reflectedDmg, percent });
                    if (caster.hp <= 0) {
                        caster.dead = true;
                        caster.hp = 0;
                        events.push({ type: 'death', entityId: casterId, context: 'reflectCaster' });
                    }
                }
                target.effects = target.effects.filter(e => e !== reflectEffect);
                events.push({ type: 'removeEffect', entityId: targetId, control_effect: 'reflect_damage' });
                events.push({ type: 'effectRemovedReflectLog', targetId });
            }

            // Damage_transfer (loyauté/submission) : une partie va au lanceur de l'effet.
            const transferEffect = target.effects.find(e =>
                e.type === 'control' && e.control_effect === 'damage_transfer');
            if (transferEffect && transferEffect.caster != null) {
                const transferredDmg = Math.floor(damageAfterReflection * transferEffect.value);
                const remainingDmg = damageAfterReflection - transferredDmg;
                target.hp -= remainingDmg;
                damageDone = remainingDmg;
                const transferCaster = byId(transferEffect.caster);
                if (transferCaster && !transferCaster.dead) {
                    transferCaster.hp -= transferredDmg;
                    events.push({ type: 'damageTransfer', toId: transferEffect.caster, amount: transferredDmg });
                    if (transferCaster.hp <= 0) {
                        transferCaster.dead = true;
                        transferCaster.hp = 0;
                        events.push({ type: 'death', entityId: transferEffect.caster, context: 'transferCaster' });
                    }
                }
                events.push({
                    type: 'damage', targetId, sourceId: casterId, amount: remainingDmg, typeMult,
                    kind: 'afterTransfer', reflectedDmg, transferredDmg, transferToId: transferEffect.caster,
                });
            } else {
                target.hp -= damageAfterReflection;
                damageDone = damageAfterReflection;
                events.push({
                    type: 'damage', targetId, sourceId: casterId, amount: damageAfterReflection, typeMult,
                    kind: reflectedDmg > 0 ? 'afterReflect' : 'plain', reflectedDmg,
                });
            }

            if (typeMult > 1 || typeMult < 1) {
                events.push({ type: 'effectiveness', targetId, mult: typeMult });
            }

            if (damageDone <= 0) {
                events.push({ type: 'noDamage', spellId: spell.id, targetId });
            }
        }

        // 2ter. Soin direct (TRANCHE 3.b.1) — combat.js l.8323-8338. Cible alliée,
        // aucun tirage RNG. La force du lanceur (pré-résolue) module le soin plat.
        if (spell.effect_type === 'heal' && spell.value > 0) {
            const force = (caster.stats && caster.stats.force) || 0;
            const healAmount = Math.floor(spell.value * (1 + force / 100));
            target.hp = Math.min(target.maxHp, target.hp + healAmount);
            events.push({ type: 'heal', targetId, amount: healAmount });
        }
        if (spell.effect_type === 'heal_percent' && spell.value > 0) {
            const healAmount = Math.floor(target.maxHp * spell.value);
            target.hp = Math.min(target.maxHp, target.hp + healAmount);
            events.push({ type: 'heal', targetId, amount: healAmount });
        }

        // 2ter-b. Transfert de PV du lanceur vers l'allié (TRANCHE 3.b.3) — combat.js
        // l.8340-8387. Le lanceur perd un % de ses PV courants (et peut en MOURIR :
        // event death context 'transferSelf' → chemin inline comme reflect/transfer).
        if (spell.effect_type === 'transfer' && spell.transfer_percent > 0) {
            const transferAmount = Math.floor(caster.hp * spell.transfer_percent);
            if (transferAmount > 0) {
                caster.hp -= transferAmount;
                if (caster.hp < 0) caster.hp = 0;
                const oldHp = target.hp;
                target.hp = Math.min(target.maxHp, target.hp + transferAmount);
                const actualHeal = target.hp - oldHp;
                events.push({ type: 'transferHp', casterId, targetId, amount: transferAmount, actualHeal });
                if (caster.hp <= 0) {
                    caster.dead = true;
                    caster.hp = 0;
                    events.push({ type: 'death', entityId: casterId, context: 'transferSelf' });
                }
            }
        }

        // 2ter-c. set_hp_to_one : met les PV de l'ennemi à 1 (TRANCHE 3.b.3) — combat.js
        // l.8389-8408. Bloqué par l'invulnérabilité (continue = cible suivante).
        if (spell.effect_type === 'set_hp_to_one') {
            if (hasControl(target, 'invulnerable')) {
                events.push({ type: 'invulnerable', targetId });
                continue;
            }
            const oldHp = target.hp;
            if (oldHp > 1) {
                target.hp = 1;
                events.push({ type: 'setHpToOne', targetId, damageDealt: oldHp - 1 });
            } else {
                events.push({ type: 'alreadyAtOneHp', targetId });
            }
        }

        // 2bis. Effet de statut primaire sur la cible (TRANCHE 3.a). Le moteur
        // possède la DÉCISION RNG gameable (effect_chance, tiré ici après les dégâts,
        // comme combat.js l.8541) ; la coquille applique l'effet (addEffect + ajusts
        // PM/maxHp) en rejouant l'event. Atteint seulement sur un coup au but (miss/
        // dodge/invulnérable ont fait `continue`).
        if (spell.effect_type && SINGLE_STATUS_EFFECTS.includes(spell.effect_type)) {
            const applies = !spell.effect_chance || rng() < spell.effect_chance;
            if (applies) {
                events.push({ type: 'applyPrimaryEffect', targetId });
                // Buff de maxHp : le gain de PV max augmente AUSSI les PV courants (parité
                // combat.js l.8334-8340). Porté par newState pour l'autorité serveur (le
                // serveur n'a pas de coquille qui rejoue ce bump). La coquille NE le refait
                // PLUS (sinon double application : elle applique newState PUIS rejoue).
                if (spell.effect_type === 'buff' && spell.stat === 'maxHp' && spell.value > 0) {
                    target.hp = Math.min(target.maxHp + spell.value, target.hp + spell.value);
                }
            }
        }

        // 2bis-b. Changement de type (primaire) — combat.js l.8952-8956. Même gating
        // effect_chance que le statut primaire (un seul effect_type par sort → exclusif).
        // L'elemType est porté par newState ; la coquille rejoue addEffect.
        if (spell.effect_type === 'type_change') {
            const applies = !spell.effect_chance || rng() < spell.effect_chance;
            if (applies) {
                target.elemType = spell.type_value;
                events.push({ type: 'applyTypeChange', targetId });
            }
        }

        // 2bis-c. Dispel (primaire) — combat.js l.8911-8946. Retire TOUS les effets
        // (2 équipes). La baisse de maxHp (effets de buff maxHp retirés) peut réduire
        // les PV courants, voire TUER (mort via le chemin standard step-3 ci-dessous).
        // maxHpNoEffects est pré-calculé (getActualStats sans effets) dans le snapshot.
        // La coquille rejoue le vidage des effets + recompute maxHp + log (impur).
        if (spell.effect_type === 'dispel') {
            const hadEffects = target.effects.length > 0;
            if (hadEffects) {
                const hpDecrease = target.maxHp - target.maxHpNoEffects;
                if (hpDecrease > 0) {
                    target.hp = Math.max(0, target.hp - hpDecrease);
                    if (target.hp > target.maxHpNoEffects) target.hp = target.maxHpNoEffects;
                }
            }
            events.push({ type: 'applyDispel', targetId, hadEffects });
        }

        // 2quinquies. Buffs multiples / aléatoires (TRANCHE 3.b.2) — combat.js
        // l.8447-8534. multi_buff : déterministe (aucun tirage). random_buff : le
        // moteur tire l'INDEX (décision gameable) et l'émet ; la coquille applique.
        if (spell.effect_type === 'multi_buff' && Array.isArray(spell.multi_buffs)) {
            events.push({ type: 'applyMultiBuff', targetId });
            // Cumul des gains de maxHp → bump des PV courants en newState (parité l.8265-8271).
            let maxHpGain = 0;
            for (const buffDef of spell.multi_buffs) {
                if (buffDef.type === 'buff' && buffDef.stat === 'maxHp' && buffDef.value > 0) maxHpGain += buffDef.value;
            }
            if (maxHpGain > 0) target.hp = Math.min(target.maxHp + maxHpGain, target.hp + maxHpGain);
        } else if (spell.effect_type === 'random_buff' && Array.isArray(spell.random_buffs) && spell.random_buffs.length > 0) {
            const index = Math.floor(rng() * spell.random_buffs.length);
            events.push({ type: 'applyRandomBuff', targetId, index });
            // Buff choisi de maxHp → bump des PV courants en newState (parité l.8291-8297).
            const selectedBuff = spell.random_buffs[index];
            if (selectedBuff && selectedBuff.type === 'buff' && selectedBuff.stat === 'maxHp' && selectedBuff.value > 0) {
                target.hp = Math.min(target.maxHp + selectedBuff.value, target.hp + selectedBuff.value);
            }
        }

        // 2quinquies-bis. Mouvement secondaire (effect_type_2: movement) — combat.js
        // l.9029-9055. push/pull (slidePush) ou téléportation (1 tirage rng, comme
        // l'historique). La position franchie est portée par newState (x/y) ; la
        // coquille rejoue le log. Placé AVANT le drain pour respecter l'ordre du flux.
        if (spell.effect_type_2 === 'movement') {
            const engineIsWalkable = (wx, wy) => isTileWalkable(wx, wy, {
                mapBounds: snapshot.mapBounds,
                statueActive: snapshot.statueActive,
                isTerrainBlocked: (tx, ty) => snapshot.blockedTerrain.has(`${tx},${ty}`),
                entities, // copie de travail : positions à jour au fil des cibles
            });
            const r = resolveSecondaryMovement(
                caster.x, caster.y, target.x, target.y, spell,
                snapshot.mapBounds, engineIsWalkable, rng,
            );
            target.x = r.x;
            target.y = r.y;
            if (r.teleported) {
                events.push({ type: 'secondaryMovement', targetId, kind: 'teleport' });
            } else if (r.moved > 0) {
                events.push({ type: 'secondaryMovement', targetId, kind: spell.move_direction_2, moved: r.moved });
            }
        } else if (spell.effect_type_2 === 'pm_regen') {
            // pm_regen — combat.js l.9097-9100. Restaure des PM au LANCEUR. Les PM ne
            // sont pas portés par newState → la coquille applique ae.pm en rejouant.
            events.push({ type: 'secondaryPmRegen', casterId });
        } else if (spell.effect_type_2) {
            // Effet secondaire buff/debuff/DoT/heal_over_time/control — combat.js
            // l.9050-9132. Aucun tirage RNG ; addEffect + ajusts PM (via getActualStats,
            // impurs) rejoués par la coquille, qui reconstruit effect2 (lignes copiées).
            events.push({ type: 'secondarySpellEffect', targetId });
        }

        // 2sexies. Drain / vol de vie (TRANCHE 3.b.4) — combat.js l.8737-8742. Le
        // lanceur récupère une part des dégâts réellement infligés à cette cible.
        if (spell.drain) {
            const drainAmount = Math.floor(damageDone * spell.drain);
            caster.hp = Math.min(caster.maxHp, caster.hp + drainAmount);
            events.push({ type: 'drain', casterId, amount: drainAmount });
        }

        // 3. Mort de la cible (combat.js l.8918) — routage 'target' (applyDefeatSequence).
        if (target.hp <= 0 && !target.dead) {
            target.dead = true;
            target.hp = 0;
            events.push({ type: 'death', entityId: targetId, context: 'target' });
        }
    }

    return { events, newState: { entities } };
}

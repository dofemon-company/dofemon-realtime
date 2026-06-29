// =============================================================================
// IA ENNEMIE — DÉCISION PURE (Phase 2b.4 — extraction, en cours)
// =============================================================================
// But : extraire la DÉCISION de l'IA ennemie (quelle cible, quel sort, quel
// déplacement) en fonctions PURES — sans `state`, sans DOM, sans animation, sans
// timer. C'est le prérequis bloquant de l'autorité PVM serveur complète (le serveur
// doit pouvoir jouer les tours ennemis pour reconstruire un tour de combat).
//
// MÉTHODE (identique au moteur combat_engine / combat_geometry / combat_stats) :
//   1. fonction pure ici + fuzz différentiel (réplique historique verbatim comme
//      référence) → commit, combat.js INTACT, zéro risque prod ;
//   2. plus tard : câbler combat.js dessus (la coquille décide via ce module, puis
//      anime) → playtest ; 3. shadow serveur ; 4. flip d'autorité.
//
// Aujourd'hui l'IA (combat.js: enemyAI/bossEnemyAI/continueNormalEnemyAI/…) mêle
// décision ET exécution (moveEntityTo + callbacks, setTimeout, finishTurn). On
// extrait les décisions PURES une par une (leaves), en commençant par le ciblage.
// =============================================================================

import { isInCombatZone } from './combat_geometry.js';

// hasControlEffect PUR (réplique de combat.js:3293) — un effet de contrôle actif.
// Inliné ici pour que le module soit Node-safe / serveur-safe (pas d'import state).
function hasControlEffect(entity, controlType) {
    if (!entity) return false;
    return (entity.effects || []).some(
        e => e.type === 'control' && e.control_effect === controlType && e.duration > 0
    );
}

// getEffectiveSpellRange PUR — réplique VERBATIM de combat_utils.js:110-147 (déjà
// pure : lit seulement spell + entity.effects). Inlinée pour ne pas importer
// combat_utils (qui tire isometric_render → DOM, donc non Node-safe).
function getEffectiveSpellRange(spell, entity) {
    let baseSpellRange = spell.range || 0;
    const aoeExtend = (spell.area && (spell.aoe_size || 0) > 0) ? (spell.aoe_size || 0) : 0;

    if (baseSpellRange === 0 && spell.area) {
        return spell.aoe_size || 1;
    }
    if (baseSpellRange === 0) {
        return 0;
    }

    let castRange;
    if (spell.fixedRange === true) {
        castRange = baseSpellRange;
    } else {
        let rangeBonus = 0;
        if (entity && entity.effects) {
            entity.effects.forEach(effect => {
                if ((effect.type === 'buff' || effect.type === 'debuff') && effect.stat === 'range') {
                    rangeBonus += effect.value;
                }
            });
        }
        castRange = Math.max(1, baseSpellRange + rangeBonus);
    }

    if (aoeExtend > 0) {
        const isConeOrLine = spell.aoe_type === 'cone' || spell.aoe_type === 'line';
        return isConeOrLine ? (castRange + aoeExtend - 1) : (castRange + aoeExtend);
    }
    return castRange;
}

/**
 * Sélection des cibles d'un ennemi, triées par priorité d'attaque.
 * Réplique EXACTE de combat.js:continueNormalEnemyAI (l.11734-11771) :
 *   - cibles = héros/alliés vivants ET non invisibles ;
 *   - distance de Manhattan depuis l'ennemi actif ;
 *   - tri par distance croissante, départage en faveur du HÉROS.
 * Pure (aucune lecture de `state`). Le tri JS est stable → à distance+type égaux,
 * l'ordre d'origine des entités est préservé (parité avec l'historique).
 *
 * @param {{x:number, y:number}} activeEnemy - l'ennemi qui joue.
 * @param {Array<{type:string, x:number, y:number, dead?:boolean, effects?:Array}>} entities
 * @returns {Array<{target:object, dist:number}>} cibles ordonnées (vide si aucune).
 */
export function selectClosestTargets(activeEnemy, entities) {
    const targets = (entities || []).filter(e =>
        (e.type === 'hero' || e.type === 'ally') &&
        !e.dead &&
        !hasControlEffect(e, 'invisible')
    );

    const targetDistances = targets.map(target => ({
        target,
        dist: Math.abs(activeEnemy.x - target.x) + Math.abs(activeEnemy.y - target.y),
    }));

    targetDistances.sort((a, b) => {
        if (a.dist !== b.dist) {
            return a.dist - b.dist;
        }
        // Égalité de distance : prioriser le héros.
        if (a.target.type === 'hero' && b.target.type !== 'hero') return -1;
        if (b.target.type === 'hero' && a.target.type !== 'hero') return 1;
        return 0;
    });

    return targetDistances;
}

/**
 * Portée d'attaque maximale d'un ennemi (parmi ses sorts offensifs).
 * Réplique EXACTE de combat.js :
 *   - IA normale (l.11773-11783) : sorts `damage>0` OU `effect_type==='debuff'` → includeDebuff=true ;
 *   - IA boss   (l.11567-11577) : sorts `damage>0` uniquement                  → includeDebuff=false.
 * Portée minimale par défaut = 1. Pure (lookup de sort INJECTÉ pour rester
 * indépendant du singleton SPELLS / Node-safe).
 *
 * @param {{spells?:string[], effects?:Array}} activeEnemy
 * @param {(spellKey:string) => (object|undefined)} getSpell - résout un spellKey en données de sort.
 * @param {{includeDebuff?:boolean}} [options]
 * @returns {number} portée max (≥ 1).
 */
export function computeMaxAttackRange(activeEnemy, getSpell, options = {}) {
    const includeDebuff = !!options.includeDebuff;
    let maxRange = 1;
    const spells = activeEnemy.spells;
    if (spells && spells.length > 0) {
        for (const spellKey of spells) {
            const s = getSpell(spellKey);
            if (s && (s.damage > 0 || (includeDebuff && s.effect_type === 'debuff'))) {
                const r = getEffectiveSpellRange(s, activeEnemy);
                if (r > maxRange) maxRange = r;
            }
        }
    }
    return maxRange;
}

/**
 * Vrai si l'un des "buffs puissants sur soi" est DÉJÀ actif sur l'ennemi — garde
 * de l'IA pour ne pas empiler ces buffs (combat.js:continueNormalEnemyAI l.11813-11820).
 * Un buff est considéré actif si :
 *   - son control_effect est présent (effet de contrôle actif), OU
 *   - c'est un buff de stat et un effet `buff` sur la même `stat` existe déjà.
 * Pure (lookup de sort INJECTÉ ; liste des clés fournie par l'appelant).
 *
 * @param {{effects?:Array}} activeEnemy
 * @param {(spellKey:string) => (object|undefined)} getSpell
 * @param {string[]} buffKeys - clés des sorts "buffs puissants sur soi".
 * @returns {boolean}
 */
export function hasPowerfulSelfBuffActive(activeEnemy, getSpell, buffKeys) {
    return (buffKeys || []).some(spellKey => {
        const s = getSpell(spellKey);
        if (!s) return false;
        if (s.control_effect && hasControlEffect(activeEnemy, s.control_effect)) return true;
        if (s.effect_type === 'buff' && s.stat && activeEnemy.effects &&
            activeEnemy.effects.some(e => e.type === 'buff' && e.stat === s.stat)) {
            return true;
        }
        return false;
    });
}

/**
 * Sélection PRIORISÉE des sorts de SOIN auto-lançables d'un ennemi (décision pure de
 * tryToHeal, combat.js l.12286-12301). NB : la garde "HP < 50%" et l'exécution
 * (executeAction) restent dans la coquille. Filtre : effet de soin, hors cooldown.
 * Priorité : heal_percent=3 > heal(value>30)=2 > heal=1 > heal_over_time=0.5. Tri
 * stable décroissant. AUCUN RNG. Lookup de sort INJECTÉ.
 *
 * @param {{spells?:string[], spellCooldowns?:object}} entity
 * @param {(spellKey:string)=>(object|undefined)} getSpell
 * @returns {Array<{spell:object, key:string, priority:number}>}
 */
export function selectHealCandidates(entity, getSpell) {
    const healSpells = [];
    if (entity.spells && entity.spells.length > 0) {
        entity.spells.forEach(spellKey => {
            const s = getSpell(spellKey);
            if (s && (s.effect_type === 'heal' || s.effect_type === 'heal_percent' || s.effect_type === 'heal_over_time')) {
                if (s.cooldown > 0 && (entity.spellCooldowns || {})[spellKey] > 0) return;
                let priority = 0;
                if (s.effect_type === 'heal_percent') priority = 3;
                else if (s.effect_type === 'heal' && s.value > 30) priority = 2;
                else if (s.effect_type === 'heal') priority = 1;
                else if (s.effect_type === 'heal_over_time') priority = 0.5;
                healSpells.push({ spell: s, key: spellKey, priority });
            }
        });
        healSpells.sort((a, b) => b.priority - a.priority);
    }
    return healSpells;
}

/**
 * Sélection PRIORISÉE des sorts de BUFF sur soi d'un ennemi (décision pure de
 * tryToBuff, combat.js l.12325-12356). Ignore les buffs déjà actifs (par stat /
 * control_effect). Filtre : sans dégât, buff OU control dmg_dealt_multiplier OU
 * control dmg_taken_multiplier(value<1) ; hors cooldown ; stat pas déjà bufféé.
 * Priorité : dmg_dealt=3 > dmg_taken=2.5 > force=2 > pm=1.5 > evasion=1.2 > buff=1.
 * Tri stable décroissant. AUCUN RNG. Lookup INJECTÉ.
 *
 * @param {{spells?:string[], spellCooldowns?:object, effects?:Array}} entity
 * @param {(spellKey:string)=>(object|undefined)} getSpell
 * @returns {Array<{spell:object, key:string, priority:number}>}
 */
export function selectBuffCandidates(entity, getSpell) {
    const activeBuffStats = new Set();
    (entity.effects || []).forEach(e => {
        if (e.type === 'buff' && e.stat) activeBuffStats.add(e.stat);
        if (e.type === 'control' && e.control_effect) activeBuffStats.add(e.control_effect);
    });

    const buffSpells = [];
    if (entity.spells && entity.spells.length > 0) {
        entity.spells.forEach(spellKey => {
            const s = getSpell(spellKey);
            if (s && !s.damage && (s.effect_type === 'buff' ||
                (s.effect_type === 'control' && s.control_effect === 'dmg_dealt_multiplier') ||
                (s.effect_type === 'control' && s.control_effect === 'dmg_taken_multiplier' && s.value < 1))) {
                if (s.cooldown > 0 && (entity.spellCooldowns || {})[spellKey] > 0) return;
                const buffStat = s.effect_type === 'control' ? s.control_effect : s.stat;
                if (activeBuffStats.has(buffStat)) return;
                let priority = 0;
                if (s.effect_type === 'control' && s.control_effect === 'dmg_dealt_multiplier') priority = 3;
                else if (s.effect_type === 'control' && s.control_effect === 'dmg_taken_multiplier') priority = 2.5;
                else if (s.effect_type === 'buff' && s.stat === 'force') priority = 2;
                else if (s.effect_type === 'buff' && s.stat === 'pm') priority = 1.5;
                else if (s.effect_type === 'buff' && s.stat === 'evasion') priority = 1.2;
                else if (s.effect_type === 'buff') priority = 1;
                buffSpells.push({ spell: s, key: spellKey, priority });
            }
        });
        buffSpells.sort((a, b) => b.priority - a.priority);
    }
    return buffSpells;
}

/**
 * Sélection PRIORISÉE des sorts d'ATTAQUE d'un ennemi vers une cible (décision pure
 * de tryToAttack, combat.js l.12508-12590). Filtre : damage>0, hors cooldown, pas
 * dans failedSpellsThisTurn, dist≤portée, ligne de vue (sauf no_line_of_sight), et
 * cible valide (lasso/elasto/grappling = croix ; charge = croix + cible non-obstacle
 * + chemin libre). Priorité = damage (+10 area, +5 drain, +8 cooldown 0), SAUF dofemon
 * de PNJ tank/dps = damage seul. Tri stable décroissant. AUCUN RNG. L'exécution
 * (executeAction) + l'ajout à failedSpellsThisTurn restent dans la coquille.
 *
 * Géométrie impure INJECTÉE par `ctx` (bâtie sur les primitifs purs de combat_geometry) :
 *   - getSpell(spellKey)
 *   - hasLoS(x1,y1,x2,y2)            : ligne de vue (computeLineOfSight)
 *   - isChargePathClear(x1,y1,x2,y2) : chemin de charge libre (computeChargePathClear, lanceur déjà lié)
 *   - isObstacleTile(x,y)            : true si la case cible est un obstacle (charge interdite)
 *
 * Réplique le quirk historique : lasso/elasto/grappling testés sur `s.id` ; charge sur
 * `s.id==='charge' || spellKey==='charge'`.
 *
 * @param {{x:number,y:number,spells?:string[],spellCooldowns?:object,effects?:Array,failedSpellsThisTurn?:string[],isNPCCreature?:boolean,refData?:object}} attacker
 * @param {{x:number,y:number}} target
 * @param {{getSpell:Function, hasLoS:Function, isChargePathClear:Function, isObstacleTile:Function}} ctx
 * @returns {Array<{spell:object, key:string, priority:number, range:number}>}
 */
export function selectAttackSpells(attacker, target, ctx) {
    const dist = Math.abs(target.x - attacker.x) + Math.abs(target.y - attacker.y);
    const failed = attacker.failedSpellsThisTurn || [];
    const attackSpells = [];

    if (!attacker.spells || attacker.spells.length === 0) return attackSpells;

    attacker.spells.forEach(spellKey => {
        const s = ctx.getSpell(spellKey);
        if (s && s.damage > 0) {
            if (s.cooldown > 0 && (attacker.spellCooldowns || {})[spellKey] > 0) return;
            if (failed.includes(spellKey)) return;

            const effectiveRange = getEffectiveSpellRange(s, attacker);
            const hasLoS = s.no_line_of_sight ? true : ctx.hasLoS(attacker.x, attacker.y, target.x, target.y);

            let isValidTarget = true;
            if (s.id === 'lasso' || s.id === 'elasto_punch' || s.id === 'grappling_hook') {
                const dx = target.x - attacker.x;
                const dy = target.y - attacker.y;
                isValidTarget = (dx === 0 || dy === 0);
            } else if (s.id === 'charge' || spellKey === 'charge') {
                const dx = target.x - attacker.x;
                const dy = target.y - attacker.y;
                const isInLine = (dx === 0 || dy === 0);
                if (!isInLine) {
                    isValidTarget = false;
                } else if (ctx.isObstacleTile(target.x, target.y)) {
                    isValidTarget = false;
                } else {
                    isValidTarget = ctx.isChargePathClear(attacker.x, attacker.y, target.x, target.y);
                }
            }

            if (dist <= effectiveRange && hasLoS && isValidTarget) {
                let priority = s.damage;
                const isNPCDofemon = attacker.isNPCCreature === true;
                const isTankOrDPS = isNPCDofemon && attacker.refData &&
                    (attacker.refData.categorieMajeur === 'TANK' || attacker.refData.categorieMajeur === 'DPS');
                if (!isTankOrDPS) {
                    if (s.area) priority += 10;
                    if (s.drain) priority += 5;
                    if (s.cooldown === 0) priority += 8;
                }
                attackSpells.push({ spell: s, key: spellKey, priority, range: effectiveRange });
            }
        }
    });

    attackSpells.sort((a, b) => b.priority - a.priority);
    return attackSpells;
}

const RETREAT_DIRECTIONS = [[0, 1], [0, -1], [1, 0], [-1, 0]];

/**
 * Case de recul optimale quand un ennemi est bloqué (décision pure de
 * findBestRetreatTile, combat_utils l.1431-1539). Détecte le blocage (≤1 case
 * adjacente libre), puis score chaque case accessible : +50 LdV, +10/case gagnée
 * (ou +5 léger recul ≤+2), +5/adjacente libre, pénalités éloignement et coût PM.
 * Renvoie {tile, isBlocked:true} si non bloqué OU meilleur score > -50, sinon null.
 * Géométrie INJECTÉE par `ctx` (prédicats purs) :
 *   - mapBounds, isWalkable(x,y), hasLoS(x1,y1,x2,y2)
 *   - reachableTiles : sortie de computeReachableTiles(entity) (même ordre).
 *
 * @param {{x:number,y:number}} entity
 * @param {{x:number,y:number}} target
 * @param {{mapBounds:?object, isWalkable:Function, hasLoS:Function, reachableTiles:Array}} ctx
 * @returns {{tile:object, isBlocked:boolean}|null}
 */
export function computeBestRetreatTile(entity, target, ctx) {
    if (!entity || !target) return null;

    const currentX = entity.x;
    const currentY = entity.y;
    const currentDist = Math.abs(currentX - target.x) + Math.abs(currentY - target.y);

    let freeAdjacentCount0 = 0;
    for (const [dx, dy] of RETREAT_DIRECTIONS) {
        const nx = currentX + dx;
        const ny = currentY + dy;
        if (!isInCombatZone(nx, ny, ctx.mapBounds)) continue;
        if (ctx.isWalkable(nx, ny)) freeAdjacentCount0++;
    }
    const isBlocked = freeAdjacentCount0 <= 1;
    if (!isBlocked) return null;

    const reachableTiles = ctx.reachableTiles || [];
    if (reachableTiles.length === 0) return null;

    let bestRetreatTile = null;
    let bestScore = -Infinity;

    for (const tile of reachableTiles) {
        if (tile.x === currentX && tile.y === currentY) continue;
        const distFromTile = Math.abs(tile.x - target.x) + Math.abs(tile.y - target.y);

        let score = 0;
        if (ctx.hasLoS(tile.x, tile.y, target.x, target.y)) score += 50;
        if (distFromTile < currentDist) {
            score += (currentDist - distFromTile) * 10;
        } else if (distFromTile <= currentDist + 2) {
            score += 5;
        }
        let freeAdjacentCount = 0;
        for (const [dx, dy] of RETREAT_DIRECTIONS) {
            const nx = tile.x + dx;
            const ny = tile.y + dy;
            if (isInCombatZone(nx, ny, ctx.mapBounds) && ctx.isWalkable(nx, ny)) freeAdjacentCount++;
        }
        score += freeAdjacentCount * 5;
        if (distFromTile > currentDist + 3) {
            score -= (distFromTile - currentDist - 3) * 5;
        }
        score -= tile.cost * 2;

        if (score > bestScore) {
            bestScore = score;
            bestRetreatTile = tile;
        }
    }

    if (bestRetreatTile && bestScore > -50) {
        return { tile: bestRetreatTile, isBlocked: true };
    }
    return null;
}

/**
 * Choix de la case vers laquelle un ennemi se déplace pour atteindre/attaquer sa
 * cible (décision pure d'enemyMoveAndAttack, combat.js l.11922-12057). Greedy par
 * distance, avec priorités : 0 = se mettre en ligne+portée (si sorts ligne-droite &
 * actuellement en diagonale, avec LdV) ; 1 = entrer en portée ; 2 = se rapprocher ;
 * 3 = contournement (≤ dist+3) ; fallback LdV si déjà à portée mais sans vue ; et
 * fallback final priorité 4 trié si rien trouvé. Si bloqué, va sur la case de recul.
 * Renvoie la case choisie (réf. de reachableTiles, avec .cost) ou null. AUCUN RNG.
 *
 * Géométrie INJECTÉE par `ctx` :
 *   - reachableTiles : computeReachableTiles(ae) (ORDRE significatif).
 *   - hasLoS(x1,y1,x2,y2), getSpell(spellKey)
 *   - retreatInfo : computeBestRetreatTile(ae,target) (null ou {tile,isBlocked}).
 *
 * @param {{x:number,y:number,spells?:string[]}} ae
 * @param {{x:number,y:number}} target
 * @param {number} maxRange
 * @param {{reachableTiles:Array, hasLoS:Function, getSpell:Function, retreatInfo:object|null}} ctx
 * @returns {{x:number,y:number,cost:number}|null}
 */
export function selectMoveTile(ae, target, maxRange, ctx) {
    const reachableTiles = ctx.reachableTiles || [];
    const retreatInfo = ctx.retreatInfo;
    const isBlocked = !!(retreatInfo && retreatInfo.isBlocked);

    const currentDist = Math.abs(ae.x - target.x) + Math.abs(ae.y - target.y);
    let bestTile = null;
    let bestDist = currentDist;

    if (isBlocked && retreatInfo && retreatInfo.tile) {
        bestTile = retreatInfo.tile;
        bestDist = Math.abs(retreatInfo.tile.x - target.x) + Math.abs(retreatInfo.tile.y - target.y);
    }

    const candidateTiles = [];

    const hasLineOnlySpells = ae.spells && ae.spells.some(spellKey => {
        const spell = ctx.getSpell(spellKey);
        if (!spell || !spell.damage || spell.damage <= 0) return false;
        const id = spell.id || spellKey;
        return id === 'charge' || id === 'lasso' || id === 'elasto_punch' || id === 'grappling_hook';
    });

    const currentDx = target.x - ae.x;
    const currentDy = target.y - ae.y;
    const isCurrentlyDiagonal = (currentDx !== 0 && currentDy !== 0);

    if (!isBlocked) {
        reachableTiles.forEach(tile => {
            const tileDist = Math.abs(tile.x - target.x) + Math.abs(tile.y - target.y);
            const tileDx = target.x - tile.x;
            const tileDy = target.y - tile.y;
            const isInLineFromTile = (tileDx === 0 || tileDy === 0);

            if (hasLineOnlySpells && isCurrentlyDiagonal && tileDist <= maxRange && isInLineFromTile) {
                if (ctx.hasLoS(tile.x, tile.y, target.x, target.y)) {
                    candidateTiles.push({ tile, priority: 0, dist: tileDist, inLine: true });
                    if (!bestTile || tileDist < bestDist) { bestTile = tile; bestDist = tileDist; }
                }
            } else if (tileDist <= maxRange && currentDist > maxRange) {
                if (!bestTile || tileDist < bestDist) { bestTile = tile; bestDist = tileDist; }
                candidateTiles.push({ tile, priority: 1, dist: tileDist, inLine: isInLineFromTile });
            } else if (currentDist > maxRange && tileDist < currentDist) {
                if (!bestTile || tileDist < bestDist) { bestTile = tile; bestDist = tileDist; }
                candidateTiles.push({ tile, priority: 2, dist: tileDist, inLine: isInLineFromTile });
            } else if (tileDist <= currentDist + 3) {
                if (tile.x === ae.x && tile.y === ae.y) return;
                candidateTiles.push({ tile, priority: 3, dist: tileDist, inLine: isInLineFromTile });
                if (!bestTile || tileDist < bestDist) { bestTile = tile; bestDist = tileDist; }
            }
        });

        if (currentDist <= maxRange) {
            const hasLoSFromBest = bestTile ? ctx.hasLoS(bestTile.x, bestTile.y, target.x, target.y) : false;
            if (!hasLoSFromBest) {
                let bestLosTile = null;
                let bestLosDist = Infinity;
                reachableTiles.forEach(tile => {
                    if (tile.x === ae.x && tile.y === ae.y) return;
                    const td = Math.abs(tile.x - target.x) + Math.abs(tile.y - target.y);
                    if (td <= maxRange && ctx.hasLoS(tile.x, tile.y, target.x, target.y)) {
                        if (td < bestLosDist) { bestLosDist = td; bestLosTile = tile; }
                    }
                });
                if (bestLosTile) { bestTile = bestLosTile; bestDist = bestLosDist; }
            }
        }
    }

    if (!bestTile && candidateTiles.length === 0) {
        reachableTiles.forEach(tile => {
            if (tile.x === ae.x && tile.y === ae.y) return;
            const tileDist = Math.abs(tile.x - target.x) + Math.abs(tile.y - target.y);
            if (tileDist <= currentDist + 3) {
                candidateTiles.push({ tile, priority: 4, dist: tileDist });
            }
        });
        candidateTiles.sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            if (hasLineOnlySpells && a.inLine !== b.inLine) return a.inLine ? -1 : 1;
            return a.dist - b.dist;
        });
        if (candidateTiles.length > 0) { bestTile = candidateTiles[0].tile; }
    }

    return bestTile || null;
}

const DEBUFF_CONTROL_EFFECTS = ['sleep', 'paralyzed', 'skip_turn', 'confused', 'fragile', 'burn'];

/**
 * Sélection PRIORISÉE des sorts de DEBUFF/contrôle d'un ennemi vers une cible
 * (décision pure de tryToDebuff, combat.js l.12381-12404). Filtre : effet debuff OU
 * control (sleep/paralyzed/skip_turn/confused/fragile/burn) OU dmg_taken_multiplier>1 ;
 * hors cooldown ; dist≤portée ET ligne de vue. Priorité : sleep=3 > skip_turn=2.5 >
 * debuff pm=2 > debuff force=1.5 > debuff=1. Tri stable. AUCUN RNG. hasLoS injecté.
 *
 * @param {{x:number,y:number,spells?:string[],spellCooldowns?:object,effects?:Array}} entity
 * @param {{x:number,y:number}} target
 * @param {{getSpell:Function, hasLoS:Function}} ctx
 * @returns {Array<{spell:object, key:string, priority:number}>}
 */
export function selectDebuffSpells(entity, target, ctx) {
    const debuffSpells = [];
    if (entity.spells && entity.spells.length > 0) {
        entity.spells.forEach(spellKey => {
            const s = ctx.getSpell(spellKey);
            if (s && (s.effect_type === 'debuff' ||
                (s.effect_type === 'control' && s.control_effect && DEBUFF_CONTROL_EFFECTS.includes(s.control_effect)) ||
                (s.effect_type === 'control' && s.control_effect === 'dmg_taken_multiplier' && s.value > 1))) {
                if (s.cooldown > 0 && (entity.spellCooldowns || {})[spellKey] > 0) return;
                const dist = Math.abs(target.x - entity.x) + Math.abs(target.y - entity.y);
                const effectiveRange = getEffectiveSpellRange(s, entity);
                if (dist <= effectiveRange && ctx.hasLoS(entity.x, entity.y, target.x, target.y)) {
                    let priority = 0;
                    if (s.effect_type === 'control' && s.control_effect === 'sleep') priority = 3;
                    else if (s.effect_type === 'control' && s.control_effect === 'skip_turn') priority = 2.5;
                    else if (s.effect_type === 'debuff' && s.stat === 'pm') priority = 2;
                    else if (s.effect_type === 'debuff' && s.stat === 'force') priority = 1.5;
                    else if (s.effect_type === 'debuff') priority = 1;
                    debuffSpells.push({ spell: s, key: spellKey, priority });
                }
            }
        });
        debuffSpells.sort((a, b) => b.priority - a.priority);
    }
    return debuffSpells;
}

/**
 * Case de fuite après attaque (décision pure de tryToRetreat, combat.js l.12433-12453) :
 * parmi les cases accessibles, celle qui MAXIMISE la distance à l'ennemi (+2 si la case
 * offre un couvert / bloque la ligne de vue). Renvoie la case (avec .cost) seulement si
 * elle améliore strictement la distance actuelle, sinon null. AUCUN RNG.
 *   - reachableTiles : computeReachableTiles(entity).
 *   - hasCover(x,y)  : true si la case offre un couvert (blocksLineOfSight).
 *
 * @param {{x:number,y:number}} entity
 * @param {{x:number,y:number}} enemy
 * @param {{reachableTiles:Array, hasCover:Function}} ctx
 * @returns {{x:number,y:number,cost:number}|null}
 */
export function selectRetreatTile(entity, enemy, ctx) {
    let bestTile = null;
    let maxDist = 0;
    (ctx.reachableTiles || []).forEach(tile => {
        let dist = Math.abs(tile.x - enemy.x) + Math.abs(tile.y - enemy.y);
        if (ctx.hasCover(tile.x, tile.y)) dist += 2;
        if (dist > maxDist) { maxDist = dist; bestTile = tile; }
    });
    const currentDist = Math.abs(entity.x - enemy.x) + Math.abs(entity.y - enemy.y);
    if (bestTile && maxDist > currentDist) return bestTile;
    return null;
}

/**
 * Éligibilité d'un sort prioritaire sur SOI (prédicat pur de tryPrioritySelfSpell,
 * combat.js l.11423-11434) : entité vivante n'ayant pas encore attaqué, possède le
 * sort, hors cooldown, et effet pas déjà actif (control ou buff de même stat).
 *
 * @param {object} entity @param {object} spell @param {string} spellKey
 * @returns {boolean}
 */
export function canCastPrioritySelfSpell(entity, spell, spellKey) {
    if (!entity || entity.dead || entity.hasAttacked) return false;
    if (!entity.spells || !entity.spells.includes(spellKey)) return false;
    if (entity.spellCooldowns && entity.spellCooldowns[spellKey] > 0) return false;
    if (!spell) return false;
    if (spell.control_effect && hasControlEffect(entity, spell.control_effect)) return false;
    if (spell.effect_type === 'buff' && spell.stat) {
        if (entity.effects && entity.effects.some(e => e.type === 'buff' && e.stat === spell.stat)) return false;
    }
    return true;
}

/**
 * Éligibilité d'un sort de contrôle OFFENSIF prioritaire sur une cible (prédicat pur
 * de tryPriorityOffensiveSpellWild, combat.js l.11446-11455) : lanceur vivant n'ayant
 * pas attaqué, cible vivante, possède le sort, hors cooldown, et control_effect pas
 * déjà actif sur la cible. (La portée / le déplacement sont gérés séparément.)
 *
 * @param {object} caster @param {object} target @param {object} spell @param {string} spellKey
 * @returns {boolean}
 */
export function canCastPriorityOffensiveSpell(caster, target, spell, spellKey) {
    if (!caster || caster.dead || caster.hasAttacked) return false;
    if (!target || target.dead) return false;
    if (!caster.spells || !caster.spells.includes(spellKey)) return false;
    if (caster.spellCooldowns && caster.spellCooldowns[spellKey] > 0) return false;
    if (!spell) return false;
    if (spell.control_effect && hasControlEffect(target, spell.control_effect)) return false;
    return true;
}

/**
 * Parmi les cases accessibles, la plus PROCHE de la cible qui la met à portée
 * (≤ effectiveRange). Réplique de la boucle de rapprochement de
 * tryPriorityOffensiveSpellWild (combat.js l.11471-11477). Renvoie la case ou null.
 *
 * @param {Array<{x:number,y:number,cost:number}>} reachableTiles
 * @param {{x:number,y:number}} target
 * @param {number} effectiveRange
 * @returns {{x:number,y:number,cost:number}|null}
 */
export function selectApproachTileInRange(reachableTiles, target, effectiveRange) {
    let bestTile = null;
    let bestDist = Infinity;
    for (const tile of (reachableTiles || [])) {
        const distAfterMove = Math.abs(tile.x - target.x) + Math.abs(tile.y - target.y);
        if (distAfterMove <= effectiveRange && distAfterMove < bestDist) {
            bestDist = distAfterMove;
            bestTile = tile;
        }
    }
    return bestTile;
}

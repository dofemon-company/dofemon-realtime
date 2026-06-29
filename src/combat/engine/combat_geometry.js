// =============================================================================
// GÉOMÉTRIE DE COMBAT PURE — Phase 2b.1
// =============================================================================
// Fonctions de géométrie de combat sous forme PURE : aucune dépendance au DOM,
// au singleton `state`, à l'i18n ou au rendu. Tout ce qui était lu sur `state`
// (bornes de la map de combat, liste des entités) est passé en paramètre.
//
// Objectif : partager EXACTEMENT la même géométrie entre le client (combat_utils
// délègue ici) et le moteur autoritatif serveur (combat_engine). Le découpage des
// cibles d'un sort (AoE) doit être identique des deux côtés pour la parité.
//
// `mapBounds` = { width, height, offsetX, offsetY } décrivant la map de combat,
// ou `null` pour retomber sur la map carrée 20×20 à l'origine (même repli que
// l'historique `isInCombatZone`).
// =============================================================================

/**
 * Vérifie qu'une case (x, y) est une case valide de la grille de combat.
 *
 * Copie canonique PURE de la fonction historique de `isometric_render.js`
 * (qui sera rebranchée sur celle-ci en 2b.2). Les constantes des diagonales
 * sont en dur — elles décrivent la forme losange de l'arène et ne dépendent
 * d'aucun état.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} [mapWidth=20]
 * @param {number} [mapHeight=20]
 * @param {number} [offsetX=0]
 * @param {number} [offsetY=0]
 * @returns {boolean}
 */
export function isValidTile(x, y, mapWidth = 20, mapHeight = 20, offsetX = 0, offsetY = 0) {
    // Vérifier les limites de la map
    if (x < offsetX || x >= offsetX + mapWidth || y < offsetY || y >= offsetY + mapHeight) {
        return false;
    }

    // Mêmes règles de suppression que drawIsoMap / generateZoneMap (forme losange)
    if (y >= 9 && x <= (y - 15)) return false;
    if (x + y <= 7) return false;
    if (x - y >= 15) return false;
    if (x + y >= 26) return false;
    if (x - y >= 8) return false;
    if (x + y <= 8) return false;
    if (y - x >= 8) return false;
    if (y - x >= 6) return false;
    if (x - y >= 6) return false;

    return true;
}

/**
 * Détermine quelle équipe possède une entité (réplique fidèle et pure de
 * `combat_utils.isSameTeam`). Hero + Ally = 'good', Enemy = 'bad'.
 * Dupliquée ici car `combat_utils` n'est pas importable hors navigateur
 * (il tire `isometric_render` → DOM). `combat_utils` reste la source côté
 * client ; les deux corps sont identiques pour la parité.
 */
function sameTeam(ent1, ent2) {
    const team1 = ent1.type === 'enemy' ? 'bad' : 'good';
    const team2 = ent2.type === 'enemy' ? 'bad' : 'good';
    return team1 === team2;
}

/**
 * Vérifie si une case est dans la zone de combat (limites + diagonales du losange).
 *
 * @param {number} x
 * @param {number} y
 * @param {?{width:number, height:number, offsetX?:number, offsetY?:number}} mapBounds
 *        Bornes de la map de combat, ou `null` pour le repli 20×20 à l'origine.
 * @returns {boolean}
 */
export function isInCombatZone(x, y, mapBounds) {
    if (!mapBounds) {
        // Repli si pas de map : taille par défaut (20×20)
        return isValidTile(x, y, 20, 20, 0, 0);
    }
    return isValidTile(
        x, y,
        mapBounds.width, mapBounds.height,
        mapBounds.offsetX || 0, mapBounds.offsetY || 0
    );
}

/**
 * Indique si la case (x, y) est touchée par le sort `spell` lancé depuis (cx, cy)
 * et visant (tx, ty). Réplique fidèle et pure de `combat_utils.isInAoE`.
 *
 * @param {number} x
 * @param {number} y
 * @param {object} spell
 * @param {number} cx - position X du lanceur (centre)
 * @param {number} cy - position Y du lanceur (centre)
 * @param {number} tx - position X ciblée
 * @param {number} ty - position Y ciblée
 * @param {?object} mapBounds
 * @returns {boolean}
 */
export function isInAoE(x, y, spell, cx, cy, tx, ty, mapBounds) {
    // Vérifier que la case est dans la zone de combat
    if (!isInCombatZone(x, y, mapBounds)) return false;

    if (!spell.area) return (x === tx && y === ty);
    if (spell.aoe_type === 'global') return true;

    if (spell.aoe_type === 'circular') {
        return (Math.abs(x - tx) + Math.abs(y - ty) <= spell.aoe_size);
    }
    if (spell.aoe_type === 'cross') {
        // Pour les sorts avec range: 0 (auto-ciblage), centrer la croix sur le lanceur
        const centerX = (spell.range === 0) ? cx : tx;
        const centerY = (spell.range === 0) ? cy : ty;
        return (x === centerX && Math.abs(y - centerY) <= spell.aoe_size) ||
               (y === centerY && Math.abs(x - centerX) <= spell.aoe_size);
    }

    let dx = tx - cx; let dy = ty - cy;
    let dirX = 0; let dirY = 0;
    if (Math.abs(dx) >= Math.abs(dy)) dirX = dx > 0 ? 1 : -1;
    else dirY = dy > 0 ? 1 : -1;

    if (dx === 0 && dy === 0) dirX = 1;

    if (spell.aoe_type === 'line') {
        let dist = 0;
        if (dirX !== 0) {
            if (y !== ty) return false;
            dist = (x - tx) * dirX;
        } else {
            if (x !== tx) return false;
            dist = (y - ty) * dirY;
        }
        return (dist >= 0 && dist < spell.aoe_size);
    }

    if (spell.aoe_type === 'cone') {
        let rx = x - tx; let ry = y - ty;
        let localX, localY;
        if (dirX === 1)       { localX = rx;  localY = ry; }
        else if (dirX === -1) { localX = -rx; localY = -ry; }
        else if (dirY === 1)  { localX = ry;  localY = -rx; }
        else if (dirY === -1) { localX = -ry; localY = rx; }
        return (localX >= 0 && localX < spell.aoe_size && Math.abs(localY) <= localX);
    }

    if (spell.aoe_type === 'chain') {
        // Le type "chain" est géré dans getTargets ; ici on renvoie false.
        return false;
    }

    return (x === tx && y === ty);
}

/**
 * Calcule la liste des entités touchées par un sort. Réplique fidèle et pure de
 * `combat_utils.getTargets` : `state.combat.entities` et `isSameTeam` sont
 * remplacés par `ctx.entities` et le helper local `sameTeam`.
 *
 * @param {number} targetX
 * @param {number} targetY
 * @param {object} spell
 * @param {object} centerEntity - le lanceur
 * @param {{entities: object[], mapBounds?: ?object}} ctx
 * @returns {object[]} les entités touchées (références issues de ctx.entities)
 */
export function getTargets(targetX, targetY, spell, centerEntity, ctx) {
    const entities = ctx.entities;
    const mapBounds = ctx.mapBounds || null;
    let targets = [];

    // GLOBAL : vérifie l'équipe au lieu du type strict
    if (spell.aoe_type === 'global') {
        if (spell.effect_type === 'heal' || spell.effect_type === 'buff') {
            // Même équipe (soi + alliés)
            targets = entities.filter(e => !e.dead && sameTeam(e, centerEntity));
        } else {
            // Équipe adverse
            targets = entities.filter(e => !e.dead && !sameTeam(e, centerEntity));
        }
        return targets;
    }

    // CHAIN : propagation de proche en proche
    if (spell.aoe_type === 'chain') {
        let initialTarget = entities.find(e => e.x === targetX && e.y === targetY && !e.dead);
        if (!initialTarget) return targets;

        // Cible initiale = ennemi pour les sorts de dégâts
        if (spell.damage > 0 && sameTeam(initialTarget, centerEntity)) {
            return targets;
        }

        let hitTargets = new Set();
        let queue = [{ entity: initialTarget, jumpsLeft: spell.aoe_size }];

        while (queue.length > 0) {
            let current = queue.shift();
            let entity = current.entity;
            let jumpsLeft = current.jumpsLeft;

            let entityKey = `${entity.x},${entity.y}`;
            if (!hitTargets.has(entityKey)) {
                targets.push(entity);
                hitTargets.add(entityKey);
            }

            if (jumpsLeft > 0) {
                let directions = [
                    [0, 1], [0, -1], [1, 0], [-1, 0],
                    [1, 1], [1, -1], [-1, 1], [-1, -1]
                ];

                for (let [dx, dy] of directions) {
                    let adjX = entity.x + dx;
                    let adjY = entity.y + dy;

                    let adjacentEntity = entities.find(e =>
                        e.x === adjX &&
                        e.y === adjY &&
                        !e.dead &&
                        !hitTargets.has(`${adjX},${adjY}`)
                    );

                    if (adjacentEntity) {
                        let shouldChain = false;
                        if (spell.damage > 0) {
                            shouldChain = !sameTeam(adjacentEntity, centerEntity);
                        } else {
                            shouldChain = sameTeam(adjacentEntity, centerEntity);
                        }
                        if (shouldChain) {
                            queue.push({ entity: adjacentEntity, jumpsLeft: jumpsLeft - 1 });
                        }
                    }
                }
            }
        }

        return targets;
    }

    entities.forEach(ent => {
        if (!ent.dead) {
            if (isInAoE(ent.x, ent.y, spell, centerEntity.x, centerEntity.y, targetX, targetY, mapBounds)) {
                targets.push(ent);
            }
        }
    });

    if (!spell.area && targets.length === 0) {
        let directTarget = entities.find(e => e.x === targetX && e.y === targetY && !e.dead);
        if (directTarget) targets.push(directTarget);
    }

    return targets;
}

// =============================================================================
// MOUVEMENT (push / pull) — Phase 2b, kernel pur
// =============================================================================
// Logique de poussée/attraction d'une cible, extraite verbatim de combat.js
// (effect_type_2 movement l.9040-9078 ; même motif réutilisé par d'autres blocs).
// Pure : la walkability est injectée (`isWalkableFn`), aucune lecture de `state`.

/**
 * Direction de glissement (une seule case par pas) pour un push/pull.
 *
 * - `away`   : la cible s'éloigne du lanceur → direction = signe de (cible - lanceur)
 *              sur CHAQUE axe (peut donc être diagonale).
 * - `toward` : la cible se rapproche du lanceur → mouvement EN LIGNE DROITE, sur
 *              l'axe de plus grand écart (égalité → axe horizontal).
 *
 * Réplique fidèle de combat.js l.9042-9062.
 *
 * @param {number} casterX
 * @param {number} casterY
 * @param {number} targetX
 * @param {number} targetY
 * @param {'away'|'toward'} moveDirection
 * @returns {{dirX:number, dirY:number}}
 */
export function computeSlideDirection(casterX, casterY, targetX, targetY, moveDirection) {
    const dx = targetX - casterX;
    const dy = targetY - casterY;
    let dirX = 0;
    let dirY = 0;
    if (moveDirection === 'toward') {
        if (Math.abs(dx) > Math.abs(dy)) {
            dirX = (dx > 0 ? -1 : (dx < 0 ? 1 : 0));
        } else if (Math.abs(dy) > Math.abs(dx)) {
            dirY = (dy > 0 ? -1 : (dy < 0 ? 1 : 0));
        } else {
            dirX = (dx > 0 ? -1 : (dx < 0 ? 1 : 0));
        }
    } else {
        // away (comportement normal)
        dirX = (dx > 0 ? 1 : (dx < 0 ? -1 : 0));
        dirY = (dy > 0 ? 1 : (dy < 0 ? -1 : 0));
    }
    return { dirX, dirY };
}

/**
 * Fait glisser une entité de `distance` cases au maximum dans la direction
 * (dirX, dirY), case par case. S'arrête à la première case hors-zone (limites +
 * diagonales interdites via isValidTile) ou non-walkable. Réplique fidèle de la
 * boucle de poussée de combat.js l.9070-9078.
 *
 * @param {number} startX
 * @param {number} startY
 * @param {number} dirX
 * @param {number} dirY
 * @param {number} distance
 * @param {?object} mapBounds - bornes de la map ({width,height,offsetX,offsetY}) ou null (20×20).
 * @param {(x:number, y:number) => boolean} isWalkableFn - prédicat de walkability injecté.
 * @returns {{x:number, y:number, moved:number}} position finale + nombre de cases franchies.
 */
/**
 * Walkability d'une case (zone + statue centrale + terrain + occupation), PURE.
 * Réplique fidèle de combat_utils.isWalkable (l.1134-1165), avec les parties
 * impures injectées par `ctx` :
 *   - mapBounds            : bornes de la map (isInCombatZone).
 *   - statueActive         : bool — les 4 cases centrales (8/9 × 8/9) sont bloquées
 *                            (PvP ou donjon). Pré-calculé par l'appelant.
 *   - isTerrainBlocked(x,y): prédicat terrain (combatMap.isWalkable / gameMap), renvoie
 *                            true si la case est bloquée par un mur/structure.
 *   - entities             : pour l'occupation (une entité vivante bloque la case).
 *   - passThroughOccupant? : prédicat optionnel — true si l'occupant ne doit PAS bloquer
 *                            (transparence du camouflage côté client). Le moteur l'omet.
 *
 * @param {number} x
 * @param {number} y
 * @param {{mapBounds:?object, statueActive:boolean, isTerrainBlocked:Function,
 *          entities:object[], passThroughOccupant?:Function}} ctx
 * @returns {boolean}
 */
export function isTileWalkable(x, y, ctx) {
    // 1. Dans la zone de combat (limites + diagonales du losange).
    if (!isInCombatZone(x, y, ctx.mapBounds)) return false;

    // 2. Statue centrale : les 4 cases (8|9, 8|9) sont bloquées en PvP / donjon.
    if ((x === 8 || x === 9) && (y === 8 || y === 9)) {
        if (ctx.statueActive) return false;
    }

    // 3. Terrain (mur / structure).
    if (ctx.isTerrainBlocked(x, y)) return false;

    // 4. Occupation par une entité vivante (avec exception camouflage injectée).
    const occupant = (ctx.entities || []).find(e => e.x === x && e.y === y && !e.dead);
    if (!occupant) return true;
    if (ctx.passThroughOccupant && ctx.passThroughOccupant(occupant)) return true;
    return false;
}

export function slidePush(startX, startY, dirX, dirY, distance, mapBounds, isWalkableFn) {
    const mw = mapBounds ? mapBounds.width : 20;
    const mh = mapBounds ? mapBounds.height : 20;
    const ox = mapBounds ? (mapBounds.offsetX || 0) : 0;
    const oy = mapBounds ? (mapBounds.offsetY || 0) : 0;
    let x = startX;
    let y = startY;
    let moved = 0;
    for (let i = 0; i < distance; i++) {
        const nx = x + dirX;
        const ny = y + dirY;
        if (!isValidTile(nx, ny, mw, mh, ox, oy)) break;
        if (isWalkableFn(nx, ny)) { x = nx; y = ny; moved++; } else break;
    }
    return { x, y, moved };
}

/**
 * Cases accessibles par une entité (BFS limité par ses PM), PURE. Réplique fidèle de
 * combat_utils.calculateReachable (l.1366-1423) : BFS 4-directions, coût = distance,
 * inclut la case de départ (coût 0). L'ordre des cases est PRÉSERVÉ (FIFO + voisins
 * dans l'ordre [bas, haut, droite, gauche]) — important car l'IA départage les
 * meilleures cases dans cet ordre. Parties impures INJECTÉES par `ctx` :
 *   - mapBounds : bornes de la map (isInCombatZone).
 *   - isWalkable(x, y) : prédicat de walkability (déjà résolu : terrain + occupation +
 *     statue + exception camouflage éventuelle). Pour l'IA ennemie = walkability brute.
 *
 * Le `console.warn` et l'option camouflage (isPlayerControlledEntity) de l'original
 * sont hors décision : le 1er est cosmétique, la 2e est absorbée par `isWalkable`.
 *
 * @param {{x:number, y:number, pm?:number}} entity
 * @param {{mapBounds:?object, isWalkable:(x:number,y:number)=>boolean}} ctx
 * @returns {Array<{x:number, y:number, cost:number}>}
 */
export function computeReachableTiles(entity, ctx) {
    const reachableTiles = [];
    const currentX = entity.x;
    const currentY = entity.y;
    const currentPm = entity.pm || 0;

    if (currentPm <= 0) return [];
    if (!isInCombatZone(currentX, currentY, ctx.mapBounds)) return [];

    const q = [{ x: currentX, y: currentY, dist: 0 }];
    const v = new Set([currentX + "," + currentY]);

    // Case de départ accessible (coût 0).
    reachableTiles.push({ x: currentX, y: currentY, cost: 0 });

    while (q.length) {
        const c = q.shift();
        if (c.dist > 0 && isInCombatZone(c.x, c.y, ctx.mapBounds)) {
            reachableTiles.push({ x: c.x, y: c.y, cost: c.dist });
        }
        if (c.dist < currentPm) {
            [[0, 1], [0, -1], [1, 0], [-1, 0]].forEach(d => {
                const nx = c.x + d[0];
                const ny = c.y + d[1];
                if (isInCombatZone(nx, ny, ctx.mapBounds) && ctx.isWalkable(nx, ny) && !v.has(nx + "," + ny)) {
                    v.add(nx + "," + ny);
                    q.push({ x: nx, y: ny, dist: c.dist + 1 });
                }
            });
        }
    }
    return reachableTiles;
}

/**
 * Ligne de vue entre (x1,y1) et (x2,y2), PURE. Réplique fidèle de
 * combat_utils.checkLoS (l.1243-1364) : Bresenham + règles d'obstacle adjacent
 * (cardinal = bloque si la ligne passe par l'obstacle ; diagonal = bloque les 3
 * cases les plus éloignées derrière) + blocage par les ennemis (un allié ne bloque
 * pas). Parties impures INJECTÉES par `ctx` :
 *   - mapBounds : bornes de la map (isInCombatZone).
 *   - blocksLoS(x, y) : true si une structure de cette case bloque la ligne de vue.
 *   - entities : pour trouver le lanceur (case de départ) et les bloqueurs.
 * Le départage allié/ennemi utilise `sameTeam` local (== isSameTeam, byte-identique).
 *
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 * @param {{mapBounds:?object, blocksLoS:(x:number,y:number)=>boolean, entities:object[]}} ctx
 * @returns {boolean}
 */
export function computeLineOfSight(x1, y1, x2, y2, ctx) {
    const mapBounds = ctx.mapBounds;
    const blocksLoS = ctx.blocksLoS;
    const entities = ctx.entities || [];

    if (!isInCombatZone(x1, y1, mapBounds) || !isInCombatZone(x2, y2, mapBounds)) {
        return false;
    }

    const adjacentDirections = [
        { dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
        { dx: 1, dy: 1 }, { dx: 1, dy: -1 }, { dx: -1, dy: 1 }, { dx: -1, dy: -1 },
    ];

    function linePassesThrough(ax, ay, bx, by, px, py) {
        let ddx = Math.abs(bx - ax), ddy = Math.abs(by - ay);
        let sx = (ax < bx) ? 1 : -1, sy = (ay < by) ? 1 : -1;
        let err = ddx - ddy, cx = ax, cy = ay;
        while (true) {
            if (cx === px && cy === py) return true;
            if (cx === bx && cy === by) return false;
            if (!isInCombatZone(cx, cy, mapBounds)) return false;
            let e2 = 2 * err;
            if (e2 > -ddy) { err -= ddy; cx += sx; }
            if (e2 < ddx) { err += ddx; cy += sy; }
        }
    }
    const isCardinal = (dx, dy) => (dx === 0) !== (dy === 0);

    for (const dir of adjacentDirections) {
        const obstacleX = x1 + dir.dx;
        const obstacleY = y1 + dir.dy;

        let isObstacle = false;
        if (isInCombatZone(obstacleX, obstacleY, mapBounds)) {
            isObstacle = blocksLoS(obstacleX, obstacleY);
        }

        if (isObstacle) {
            if (isCardinal(dir.dx, dir.dy)) {
                if (linePassesThrough(x1, y1, x2, y2, obstacleX, obstacleY)) return false;
            } else {
                const tilesAroundObstacle = [];
                for (let ox = -1; ox <= 1; ox++) {
                    for (let oy = -1; oy <= 1; oy++) {
                        const tileX = obstacleX + ox;
                        const tileY = obstacleY + oy;
                        if (isInCombatZone(tileX, tileY, mapBounds)) {
                            const distance = Math.abs(tileX - x1) + Math.abs(tileY - y1);
                            tilesAroundObstacle.push({ x: tileX, y: tileY, distance });
                        }
                    }
                }
                tilesAroundObstacle.sort((a, b) => {
                    if (b.distance !== a.distance) return b.distance - a.distance;
                    const alignA = (a.x - obstacleX) * dir.dx + (a.y - obstacleY) * dir.dy;
                    const alignB = (b.x - obstacleX) * dir.dx + (b.y - obstacleY) * dir.dy;
                    return alignB - alignA;
                });
                const threeFarthest = tilesAroundObstacle.slice(0, 3);
                for (const tile of threeFarthest) {
                    if (tile.x === x2 && tile.y === y2) return false;
                }
            }
        }
    }

    const sourceEntity = entities.find(e => e.x === x1 && e.y === y1 && !e.dead);

    let dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
    let sx = (x1 < x2) ? 1 : -1, sy = (y1 < y2) ? 1 : -1;
    let err = dx - dy, cx = x1, cy = y1;
    while (true) {
        if (cx === x2 && cy === y2) return true;
        if (!isInCombatZone(cx, cy, mapBounds)) return false;

        // Case en zone ici (garde ci-dessus) → terrain bloquant la ligne de vue ?
        const blocks = blocksLoS(cx, cy);
        if (blocks && (cx !== x1 || cy !== y1)) return false;

        if (cx !== x1 || cy !== y1) {
            const entityOnTile = entities.find(e => e.x === cx && e.y === cy && !e.dead);
            if (entityOnTile && sourceEntity) {
                if (!sameTeam(entityOnTile, sourceEntity)) {
                    return false;
                }
            }
        }

        let e2 = 2 * err;
        if (e2 > -dy) { err -= dy; cx += sx; }
        if (e2 < dx) { err += dx; cy += sy; }
    }
}

/**
 * Chemin LIBRE pour le sort charge entre (x1,y1) et (x2,y2), PURE. Réplique de
 * combat_utils.isChargePathClear (l.1152-1241) : doit être en ligne droite (croix) ;
 * toutes les cases INTERMÉDIAIRES (hors case finale, qui peut contenir la cible)
 * doivent être en zone, non bloquées par le terrain, et libres de toute entité
 * vivante autre que le lanceur. Parties impures INJECTÉES par `ctx` :
 *   - mapBounds : bornes (isInCombatZone).
 *   - isTerrainBlocked(x,y) : true si le terrain bloque le mouvement (combatMap.isWalkable
 *     faux OU gameMap 1/2) — MÊME prédicat que isWalkable côté terrain.
 *   - entities + sourceEntity : entités du combat et le lanceur (exclu du blocage).
 *
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 * @param {{mapBounds:?object, isTerrainBlocked:(x:number,y:number)=>boolean, entities:object[], sourceEntity:object}} ctx
 * @returns {boolean}
 */
export function computeChargePathClear(x1, y1, x2, y2, ctx) {
    const { mapBounds, isTerrainBlocked, entities, sourceEntity } = ctx;

    if (!isInCombatZone(x1, y1, mapBounds) || !isInCombatZone(x2, y2, mapBounds)) return false;

    const dx = x2 - x1;
    const dy = y2 - y1;
    if (dx !== 0 && dy !== 0) return false; // pas en ligne droite

    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    if (steps <= 1) return true; // pas de case intermédiaire

    let cx = x1, cy = y1;
    const stepX = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
    const stepY = dy > 0 ? 1 : (dy < 0 ? -1 : 0);

    for (let i = 1; i < steps; i++) {
        cx += stepX;
        cy += stepY;
        if (!isInCombatZone(cx, cy, mapBounds)) return false;
        if (isTerrainBlocked(cx, cy)) return false;
        const entityOnTile = (entities || []).find(e => e.x === cx && e.y === cy && !e.dead && e !== sourceEntity);
        if (entityOnTile) return false;
    }
    return true;
}

// =============================================================================
// MOUVEMENT PRIMAIRE — cases d'atterrissage (Phase 2b.4 / FLIP S4 étape a)
// =============================================================================
// Helpers PURS calculant la case d'arrivée des sorts qui DÉPLACENT le lanceur
// (mouvement primaire, aujourd'hui inline dans startSpellAnimation). Extraits ici
// pour permettre au moteur/serveur de connaître la position post-cast (lève le
// `suffixUncertain` du driver IA). INERTES tant que combat.js ne les appelle pas.

/**
 * Case d'atterrissage du sort « assault » (le lanceur se téléporte sur/près de la
 * case visée), PURE. Réplique fidèle de combat.js startSpellAnimation (l.5794-5828) :
 *   - case visée si walkable ;
 *   - sinon, voisin orthogonal libre — ordre [haut, bas, gauche, droite] — le PLUS
 *     PROCHE (distance de Manhattan) du lanceur ; départage par cet ordre via un tri
 *     STABLE (Array.prototype.sort l'est depuis ES2019, comme le client) ;
 *   - aucun voisin libre → invalide (le client annule alors le sort).
 * Parties impures injectées par `ctx` :
 *   - mapBounds : bornes (isInCombatZone des voisins, comme le client).
 *   - isWalkable(x, y) : walkability complète (zone + terrain + occupation), déjà
 *     résolue par l'appelant — MÊME prédicat que le client (isWalkable).
 *
 * @param {{x:number, y:number}} attacker
 * @param {number} targetX
 * @param {number} targetY
 * @param {{mapBounds:?object, isWalkable:(x:number,y:number)=>boolean}} ctx
 * @returns {{valid:boolean, x?:number, y?:number}}
 */
export function computeAssaultLandingTile(attacker, targetX, targetY, ctx) {
    const { mapBounds, isWalkable } = ctx;
    let destX = targetX, destY = targetY;
    if (!isWalkable(destX, destY)) {
        const neighbors = [
            { x: targetX, y: targetY - 1 },
            { x: targetX, y: targetY + 1 },
            { x: targetX - 1, y: targetY },
            { x: targetX + 1, y: targetY }
        ].filter(p => isInCombatZone(p.x, p.y, mapBounds) && isWalkable(p.x, p.y));
        neighbors.forEach(p => { p.distance = Math.abs(p.x - attacker.x) + Math.abs(p.y - attacker.y); });
        neighbors.sort((a, b) => a.distance - b.distance);
        if (neighbors.length > 0) {
            destX = neighbors[0].x;
            destY = neighbors[0].y;
        } else {
            return { valid: false };
        }
    }
    return { valid: true, x: destX, y: destY };
}

/**
 * Case d'atterrissage du sort « charge » (le lanceur fonce d'UNE case vers la cible),
 * PURE. Réplique fidèle de la branche de CALCUL non-PVP de combat.js startSpellAnimation
 * (l.5856-5946). Reproduit toutes les invalidations sous forme `{valid:false, reason}` :
 *   - lanceur ennemi en PvE visant en diagonale → invalide (`diagonal`) ;
 *   - cible non alignée en croix (range) → invalide (`not_aligned`) ;
 *   - chemin non dégagé (isChargePathClear) → invalide (`path_blocked`) ;
 *   - case d'atterrissage hors-zone ou non walkable → invalide (`destination_blocked`).
 * Sinon `{valid:true, x, y}` : (x,y) = case du lanceur + UNE case vers la cible si
 * `chargeDist>1`, ou la case actuelle inchangée si `chargeDist<=1` (pas de mouvement).
 * NB : la branche PVP-récepteur (destination transmise `_pvpChargeTarget*`) n'est PAS
 * une décision → hors périmètre (le moteur/serveur PVM calcule lui-même).
 * Parties impures injectées par `ctx` :
 *   - mapBounds : bornes (isInCombatZone de la case d'atterrissage).
 *   - isWalkable(x, y) : walkability complète de la case d'atterrissage (même prédicat client).
 *   - isChargePathClear(x1,y1,x2,y2) : chemin dégagé (computeChargePathClear pré-lié aux
 *     entités + terrain + lanceur).
 *   - isPvp : booléen (la garde diagonale stricte ne s'applique qu'en PvE).
 *
 * @param {{x:number, y:number, type?:string}} attacker
 * @param {number} targetX @param {number} targetY
 * @param {object} spell - utilise `spell.range`.
 * @param {{mapBounds:?object, isWalkable:Function, isChargePathClear:Function, isPvp:boolean}} ctx
 * @returns {{valid:boolean, x?:number, y?:number, reason?:string}}
 */
export function computeChargeLandingTile(attacker, targetX, targetY, spell, ctx) {
    const { mapBounds, isWalkable, isChargePathClear, isPvp } = ctx;
    const dx = targetX - attacker.x;
    const dy = targetY - attacker.y;

    // IA (PvE uniquement) : jamais de diagonale.
    if (attacker.type === 'enemy' && !isPvp) {
        if (dx !== 0 && dy !== 0) return { valid: false, reason: 'diagonal' };
    }

    const isInCross = (dx === 0 && Math.abs(dy) <= spell.range) || (dy === 0 && Math.abs(dx) <= spell.range);
    const pathClear = isChargePathClear(attacker.x, attacker.y, targetX, targetY);

    if (!isInCross || !pathClear) {
        return { valid: false, reason: !isInCross ? 'not_aligned' : 'path_blocked' };
    }

    const chargeDist = Math.abs(dx) + Math.abs(dy);
    if (chargeDist > 1) {
        let chargeX = attacker.x;
        let chargeY = attacker.y;
        if (Math.abs(dx) > Math.abs(dy)) {
            chargeX += dx > 0 ? 1 : -1;
        } else if (Math.abs(dy) > 0) {
            chargeY += dy > 0 ? 1 : -1;
        } else if (dx !== 0) {
            chargeX += dx > 0 ? 1 : -1;
        } else if (dy !== 0) {
            chargeY += dy > 0 ? 1 : -1;
        }
        if (isInCombatZone(chargeX, chargeY, mapBounds) && isWalkable(chargeX, chargeY)) {
            return { valid: true, x: chargeX, y: chargeY };
        }
        return { valid: false, reason: 'destination_blocked' };
    }
    // chargeDist <= 1 : pas de mouvement, le lanceur reste sur place.
    return { valid: true, x: attacker.x, y: attacker.y };
}

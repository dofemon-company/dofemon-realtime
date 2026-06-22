// =========================================
// SIMULATION DE COMBAT CÔTÉ SERVEUR
// =========================================
// Ce module simule l'avance rapide du combat pendant la déconnexion
// Il calcule les tours qui se seraient passés et applique les actions

// Durées des tours en millisecondes
const TURN_DURATION_HERO_MS = 20000; // 20 secondes pour héros/alliés
const TURN_DURATION_ENEMY_MS = 2500; // 2.5 secondes en moyenne pour ennemis

// Sorts de base pour les ennemis (fallback si pas de sort disponible)
const DEFAULT_ENEMY_SPELL = {
    id: 'strike',
    damage: 10,
    type: 'neutral',
    range: 1,
    area: null
};

/**
 * Trouve la cible la plus proche pour un ennemi
 */
function findNearestTarget(enemy, entities) {
    const targets = entities.filter(e => 
        (e.type === 'hero' || e.type === 'ally') && 
        !e.dead
    );
    
    if (targets.length === 0) return null;
    
    // Calculer la distance de Manhattan
    let nearest = targets[0];
    let minDist = Math.abs(enemy.x - nearest.x) + Math.abs(enemy.y - nearest.y);
    
    for (const target of targets) {
        const dist = Math.abs(enemy.x - target.x) + Math.abs(enemy.y - target.y);
        if (dist < minDist) {
            minDist = dist;
            nearest = target;
        }
    }
    
    return nearest;
}

/**
 * Calcule le multiplicateur de dégâts selon les types
 * Version simplifiée du TYPE_CHART
 */
function getDamageMultiplier(atkType, defType) {
    if (atkType === 'normal' || !atkType) return 1;
    
    // Tableau de faiblesses/résistances simplifié
    const typeChart = {
        fire: { strong: ['grass', 'steel'], weak: ['water', 'ground'] },
        water: { strong: ['fire', 'ground'], weak: ['grass', 'electric'] },
        grass: { strong: ['water', 'ground'], weak: ['fire', 'steel'] },
        electric: { strong: ['water', 'steel'], weak: ['ground'] },
        ground: { strong: ['fire', 'electric', 'steel'], weak: ['water', 'grass'] },
        psychic: { strong: ['normal'], weak: ['dark', 'steel'] },
        wind: { strong: ['grass'], weak: ['steel'] },
        dark: { strong: ['psychic', 'light'], weak: ['light'] },
        light: { strong: ['dark', 'psychic'], weak: ['dark'] },
        steel: { strong: ['grass', 'wind'], weak: ['fire', 'ground'] },
        dragon: { strong: ['dragon'], weak: ['steel', 'dragon'] }
    };
    
    const logic = typeChart[atkType];
    if (!logic) return 1;
    
    // Cas spéciaux
    if ((atkType === 'dragon' && defType === 'steel') || (atkType === 'steel' && defType === 'dragon')) {
        return 1.5;
    }
    
    if (logic.strong.includes(defType)) return 1.5;
    if (logic.weak.includes(defType)) return 0.8;
    return 1;
}

/**
 * Simule une attaque d'un ennemi sur une cible
 * Version simplifiée sans rendu
 */
function simulateEnemyAttack(attacker, target, spells) {
    if (!attacker || !target || attacker.dead || target.dead) return false;
    
    // Vérifier l'invulnérabilité
    if (target.effects) {
        for (const effect of target.effects) {
            if (effect.type === 'control' && effect.control_effect === 'invulnerable') {
                return false; // Cible invulnérable
            }
        }
    }
    
    // Trouver un sort d'attaque disponible
    let attackSpell = null;
    
    if (spells && spells.length > 0) {
        // Prendre le premier sort de dégâts disponible
        for (const spellKey of spells) {
            const spell = getSpellData(spellKey);
            if (spell && spell.damage > 0) {
                attackSpell = spell;
                break;
            }
        }
    }
    
    // Fallback vers le sort par défaut
    if (!attackSpell) {
        attackSpell = DEFAULT_ENEMY_SPELL;
    }
    
    // Calculer la distance
    const dist = Math.abs(attacker.x - target.x) + Math.abs(attacker.y - target.y);
    const maxRange = attackSpell.range || 1;
    
    // Vérifier si à portée
    if (dist > maxRange) {
        return false; // Pas à portée, l'ennemi devrait se déplacer (simplifié)
    }
    
    // Calculer les stats réelles de l'attaquant
    let attackerForce = attacker.force || attacker.baseStats?.force || 10;
    if (attacker.effects) {
        for (const effect of attacker.effects) {
            if (effect.type === 'buff' && effect.stat === 'force') {
                attackerForce += effect.value || 0;
            }
        }
    }
    
    // Calculer les dégâts de base (formule: baseDmg * (1 + force / 100))
    const baseDamage = attackSpell.damage || 10;
    let rawDmg = Math.floor(baseDamage * (1 + attackerForce / 100));
    
    // Appliquer le multiplicateur de type
    const spellType = attackSpell.type || 'normal';
    const targetType = target.elemType || 'normal';
    const typeMultiplier = getDamageMultiplier(spellType, targetType);
    rawDmg = Math.floor(rawDmg * typeMultiplier);
    
    // Vérifier les critiques (10% de chance par défaut, peut être modifié par les effets)
    let critChance = 0.01; // 1% par défaut
    if (attacker.baseStats?.crit_chance !== undefined) {
        critChance = attacker.baseStats.crit_chance;
    }
    const isCrit = Math.random() < critChance;
    if (isCrit) {
        rawDmg = Math.floor(rawDmg * 1.5); // x1.5 pour les critiques
    }
    
    // Vérifier l'esquive (simplifié)
    const targetEvasion = target.baseStats?.evasion || 0;
    if (targetEvasion > 0 && Math.random() * 100 < targetEvasion) {
        return false; // Cible a esquivé
    }
    
    // Appliquer la réduction de dégâts de la cible
    const targetDefense = target.baseStats?.dmg_reduc || 0;
    let finalDamage = Math.max(1, rawDmg - targetDefense);
    
    // Appliquer les dégâts
    target.hp = Math.max(0, target.hp - finalDamage);
    
    // Marquer comme mort si HP <= 0
    if (target.hp <= 0) {
        target.dead = true;
        target.hp = 0;
    }
    
    // Marquer l'attaquant comme ayant attaqué
    attacker.hasAttacked = true;
    
    return true;
}

/**
 * Récupère les données d'un sort (version simplifiée)
 * En production, on devrait charger SPELLS depuis spells_data.js
 */
function getSpellData(spellKey) {
    // Pour l'instant, on retourne un sort basique
    // TODO: Charger les vraies données de sorts depuis spells_data.js
    return {
        id: spellKey,
        damage: 10,
        type: 'neutral',
        range: 1,
        area: null
    };
}

/**
 * Passe au tour suivant dans l'ordre des tours
 */
function advanceToNextTurn(combatState) {
    if (!combatState.turnOrder || combatState.turnOrder.length === 0) {
        return false;
    }
    
    // Filtrer les entités mortes du turnOrder avant d'avancer
    combatState.turnOrder = combatState.turnOrder.filter(e => !e.dead);
    if (combatState.turnOrder.length === 0) {
        return false;
    }

    // Trouver l'entité active actuelle pour re-syncer l'index après le filtrage
    const currentEntity = combatState.turnOrder.find(e => e.id === combatState.activeEntityId);
    if (currentEntity) {
        combatState.currentTurnIndex = combatState.turnOrder.indexOf(currentEntity);
    }

    combatState.currentTurnIndex = (combatState.currentTurnIndex + 1) % combatState.turnOrder.length;
    combatState.turnCount = (combatState.turnCount || 0) + 1;

    // Sauter les entités mortes qui seraient encore présentes
    let checked = 0;
    while (checked < combatState.turnOrder.length) {
        const candidate = combatState.turnOrder[combatState.currentTurnIndex];
        if (candidate && !candidate.dead) break;
        combatState.currentTurnIndex = (combatState.currentTurnIndex + 1) % combatState.turnOrder.length;
        checked++;
    }
    
    const nextEntityId = combatState.turnOrder[combatState.currentTurnIndex]?.id;
    if (nextEntityId) {
        combatState.activeEntityId = nextEntityId;
    }
    
    return true;
}

/**
 * Vérifie si le combat est terminé (victoire ou défaite)
 */
function checkCombatEnd(combatState) {
    const entities = combatState.entities || [];
    
    // Vérifier la défaite (tous les héros/alliés sont morts)
    const heroesAndAllies = entities.filter(e => 
        (e.type === 'hero' || e.type === 'ally') && !e.dead
    );
    if (heroesAndAllies.length === 0) {
        combatState.status = 'lost';
        combatState.gameEnded = true;
        return true;
    }
    
    // Vérifier la victoire (tous les ennemis sont morts)
    const enemies = entities.filter(e => e.type === 'enemy' && !e.dead);
    if (enemies.length === 0) {
        combatState.status = 'won';
        combatState.gameEnded = true;
        return true;
    }
    
    return false;
}

/**
 * Diminue les durées des effets de toutes les entités
 */
function decreaseAllEffectDurations(entities) {
    for (const entity of entities) {
        if (entity.dead || !entity.effects) continue;
        
        // Parcourir les effets en sens inverse pour pouvoir supprimer
        for (let i = entity.effects.length - 1; i >= 0; i--) {
            const effect = entity.effects[i];
            
            // Diminuer la durée seulement pour les effets temporaires
            if (effect.duration !== undefined && effect.duration > 0) {
                effect.duration--;
                
                // Supprimer l'effet si sa durée est épuisée
                if (effect.duration <= 0) {
                    entity.effects.splice(i, 1);
                }
            }
        }
    }
}

/**
 * Simule un tour complet (timeout pour héros/alliés, attaque pour ennemis)
 */
function simulateTurn(combatState) {
    if (combatState.gameEnded) return false;
    
    const entities = combatState.entities || [];
    const activeEntity = entities.find(e => e.id === combatState.activeEntityId);
    
    if (!activeEntity || activeEntity.dead) {
        // Entité morte ou introuvable, passer au tour suivant
        advanceToNextTurn(combatState);
        return true;
    }
    
    // Diminuer les durées des effets de toutes les entités
    decreaseAllEffectDurations(entities);
    
    // Si c'est le tour du héros ou d'un allié : timeout (passer le tour)
    if (activeEntity.type === 'hero' || activeEntity.type === 'ally') {
        // Incrémenter le compteur de timeouts consécutifs pour le héros
        if (activeEntity.type === 'hero') {
            combatState.consecutiveHeroTimeouts = (combatState.consecutiveHeroTimeouts || 0) + 1;
            
            // Si 5 tours passés automatiquement, le combat est perdu
            if (combatState.consecutiveHeroTimeouts >= 5) {
                combatState.status = 'lost';
                combatState.gameEnded = true;
                return false;
            }
        }
        
        // Réinitialiser les PM/PA pour le prochain tour (simplifié)
        activeEntity.pm = activeEntity.baseStats?.pm || 3;
        activeEntity.pa = activeEntity.baseStats?.pa || 6;
        activeEntity.hasAttacked = false;
        
        // Passer au tour suivant
        advanceToNextTurn(combatState);
        return true;
    }
    
    // Si c'est le tour d'un ennemi : simuler une attaque
    if (activeEntity.type === 'enemy') {
        const target = findNearestTarget(activeEntity, entities);
        
        if (target) {
            // Simuler l'attaque
            simulateEnemyAttack(activeEntity, target, activeEntity.spells);
        }
        
        // Réinitialiser les PM/PA pour le prochain tour
        activeEntity.pm = activeEntity.baseStats?.pm || 3;
        activeEntity.pa = activeEntity.baseStats?.pa || 6;
        activeEntity.hasAttacked = false;
        
        // Passer au tour suivant
        advanceToNextTurn(combatState);
        
        // Vérifier si le combat est terminé
        return !checkCombatEnd(combatState);
    }
    
    // Type d'entité inconnu, passer au tour suivant
    advanceToNextTurn(combatState);
    return true;
}

/**
 * Simule l'avance rapide du combat pendant la déconnexion
 * @param {Object} combatState - L'état du combat à simuler
 * @param {number} now - Timestamp actuel
 * @returns {Object} - L'état du combat après simulation
 */
export function fastForwardCombat(combatState, now) {
    if (!combatState || combatState.gameEnded) {
        return combatState;
    }
    
    const lastUpdate = combatState.lastUpdateAt || now;
    const elapsed = now - lastUpdate;
    
    // Si moins de 1 seconde s'est écoulée, pas besoin de fast-forward
    if (elapsed < 1000) {
        return combatState;
    }
    
    console.log(`[Simulation] Fast-forward de ${Math.floor(elapsed / 1000)} secondes`);
    
    // Créer une copie de l'état pour la simulation
    const simulatedState = JSON.parse(JSON.stringify(combatState));
    
    // Calculer combien de tours peuvent se passer
    // On simule tour par tour jusqu'à épuisement du temps
    let remainingTime = elapsed;
    let maxTurns = 1000; // Limite de sécurité pour éviter les boucles infinies
    let turnCount = 0;
    
    while (remainingTime > 0 && turnCount < maxTurns && !simulatedState.gameEnded) {
        const activeEntity = simulatedState.entities?.find(
            e => e.id === simulatedState.activeEntityId
        );
        
        if (!activeEntity) {
            break;
        }
        
        // Déterminer la durée du tour actuel
        let turnDuration;
        if (activeEntity.type === 'hero' || activeEntity.type === 'ally') {
            turnDuration = TURN_DURATION_HERO_MS;
        } else if (activeEntity.type === 'enemy') {
            turnDuration = TURN_DURATION_ENEMY_MS;
        } else {
            turnDuration = TURN_DURATION_HERO_MS; // Par défaut
        }
        
        // Si on n'a pas assez de temps pour ce tour, arrêter
        if (remainingTime < turnDuration) {
            break;
        }
        
        // Simuler le tour
        const continueSimulation = simulateTurn(simulatedState);
        
        if (!continueSimulation || simulatedState.gameEnded) {
            break;
        }
        
        // Déduire le temps du tour
        remainingTime -= turnDuration;
        turnCount++;
    }
    
    // Mettre à jour le timestamp
    simulatedState.lastUpdateAt = now;
    
    // Mettre à jour le timer state
    if (simulatedState.timerState) {
        const activeEntity = simulatedState.entities?.find(
            e => e.id === simulatedState.activeEntityId
        );
        
        if (activeEntity && (activeEntity.type === 'hero' || activeEntity.type === 'ally')) {
            // Recalculer le temps restant pour le tour actuel
            const turnStartTime = simulatedState.timerState.turnStartedAt || lastUpdate;
            const elapsedInCurrentTurn = now - turnStartTime;
            const remaining = Math.max(0, TURN_DURATION_HERO_MS - elapsedInCurrentTurn);
            
            simulatedState.timerState = {
                ...simulatedState.timerState,
                remaining: remaining,
                maxTime: TURN_DURATION_HERO_MS,
                turnStartedAt: turnStartTime
            };
        }
    }
    
    console.log(`[Simulation] ${turnCount} tours simulés, combat ${simulatedState.gameEnded ? 'terminé' : 'en cours'}`);
    
    return simulatedState;
}

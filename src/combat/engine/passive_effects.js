// =============================================================================
// PASSIFS — sous-ensemble PUR pour le serveur autoritatif
// =============================================================================
// Copie VERBATIM des parties PURES de DOFEMON/js/passive_effects.js
// (applyPassiveEffects + isSameTeam). Le fichier client importe aussi `state` et
// `translations` pour d'autres fonctions (descriptions i18n) dont le serveur n'a
// pas besoin ; on ne garde donc QUE la logique pure consommée par combat_stats.
//
// ⚠️ Source de vérité = DOFEMON/js/passive_effects.js (fonction applyPassiveEffects).
// Garder le CORPS verbatim pour que scripts/sync-engine.mjs détecte les divergences.
// =============================================================================

export function applyPassiveEffects(targetEntity, allEntities) {
    const modifications = {};

    // Parcourir toutes les entités pour trouver celles avec des effets passifs
    allEntities.forEach(entity => {
        if (!entity.passiveEffect || entity.dead) return;

        const effect = entity.passiveEffect;
        const isAlly = isSameTeam(entity, targetEntity) && entity !== targetEntity;
        const isEnemy = !isSameTeam(entity, targetEntity);

        switch (effect.type) {
            case 'hp_boost':
                if (isAlly) {
                    modifications.maxHp = (modifications.maxHp || 0) + effect.value;
                }
                break;

            case 'force_boost':
                if (isAlly) {
                    modifications.force = (modifications.force || 0) + effect.value;
                }
                break;

            case 'init_boost':
                if (isAlly) {
                    modifications.init = (modifications.init || 0) + effect.value;
                }
                break;

            case 'pm_boost':
                if (isAlly) {
                    modifications.pm = (modifications.pm || 0) + effect.value;
                }
                break;

            case 'accuracy_debuff':
                if (isEnemy) {
                    modifications.accuracy = (modifications.accuracy || 0) - effect.value;
                }
                break;

            case 'crit_boost':
                if (isAlly) {
                    modifications.crit_chance = (modifications.crit_chance || 0) + (effect.value / 100);
                }
                break;

            case 'evasion_boost':
                if (isAlly) {
                    modifications.evasion = (modifications.evasion || 0) + effect.value;
                }
                break;

            case 'defense_boost':
            case 'type_attack_boost':
            case 'type_defense_boost':
                // Ces effets sont appliqués lors du calcul de dégâts, pas ici
                break;
        }
    });

    return modifications;
}

/**
 * Vérifie si deux entités sont dans la même équipe
 */
function isSameTeam(ent1, ent2) {
    const team1 = ent1.type === 'enemy' ? 'bad' : 'good';
    const team2 = ent2.type === 'enemy' ? 'bad' : 'good';
    return team1 === team2;
}

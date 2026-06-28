// Sous-ensemble de DOFEMON/js/config.js nécessaire au moteur serveur.
// TYPE_CHART est injecté dans le snapshot (le moteur ne l'importe pas).
// ⚠️ Source de vérité = DOFEMON/js/config.js (TYPE_CHART). Garder synchro.

export const TYPE_CHART = {
    fire:     { strong: ['grass'],    weak: [] },
    water:    { strong: ['fire'],     weak: [] },
    grass:    { strong: ['water'],    weak: [] },
    electric: { strong: ['wind'],     weak: [] },
    ground:   { strong: ['electric'], weak: [] },
    wind:     { strong: ['ground'],   weak: [] },
    dragon:   { strong: ['psychic'],  weak: [] },
    steel:    { strong: ['dragon'],   weak: [] },
    psychic:  { strong: ['steel'],    weak: [] },
    light:    { strong: ['dark'],     weak: [] },
    dark:     { strong: ['light'],    weak: [] },
    normal:   { strong: [],           weak: [] }
};

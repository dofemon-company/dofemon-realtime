// =============================================================================
// RÉSOLUTION SERVEUR D'UN TOUR ENNEMI (Palier C — C1)
// =============================================================================
// Le serveur JOUE un tour d'ennemi PVM de bout en bout :
//   planEnemyTurn (décisions, déjà shadow-validées MATCH)  →  pour chaque action,
//   RÉSOUT le cast via le moteur pur (resolveSpell) ou applique le déplacement,
//   en enchaînant sur un état de travail. Produit une liste de STEPS que le client
//   (C2) animera/appliquera : { action, events?, newState? }.
//
// ⚠️ RNG : le SERVEUR tire les dés (D3 — tour ennemi = « serveur tire / client
//   affiche », pas de prédiction → pas besoin de graine partagée). `rng` est injecté.
//
// LIMITE CONNUE (C1, à lever si nécessaire) : on applique à l'état de travail les
// champs de `newState` (hp/dead/x/y/pm/elemType) mais PAS les EFFETS ajoutés (ils
// voyagent dans les events, appliqués par le client). Donc le CHAÎNAGE d'un tour à
// PLUSIEURS casts où le cast N+1 dépend d'un EFFET posé par le cast N n'est pas
// reproduit côté serveur. En pratique les tours ennemis sont quasi toujours mono-cast
// (le cast pose hasAttacked → au plus un repli/déplacement ensuite) → sans impact.
// À compléter (applyEffectEvents) si un cas multi-cast+effet apparaît au shadow.
// =============================================================================

import { planEnemyTurn } from "./enemy_ai_driver.js";
import { buildSnapshotFromState } from "./snapshot.js";
import { resolveSpell } from "./engine/combat_engine.js";
import { SPELLS } from "./engine/spells_data.js";

// Applique les champs d'état « durs » de newState (hp/dead/x/y/pm/elemType) aux
// entités de travail, par INDEX (identité du moteur). Miroir serveur de
// combat.js:applySpellNewState (sans le rendu ; effets = via events, cf. limite).
function applyNewStateToWorking(entities, newState) {
    (newState.entities || []).forEach((ne, i) => {
        const e = entities[i];
        if (!e) return;
        e.hp = ne.hp;
        e.dead = ne.dead;
        e.x = ne.x;
        e.y = ne.y;
        e.elemType = ne.elemType;
        if (ne.pm !== undefined) e.pm = ne.pm;
    });
}

/**
 * Joue et RÉSOUT un tour d'ennemi PVM côté serveur.
 * @param {object} before - état type captureCombatShadowState/activeCombat
 *   ({ entities, combatMap, blockedTerrain, isPvp, dungeonInfo }).
 * @param {{casterId:number, isBoss?:boolean}} options - ennemi actif (INDEX).
 * @param {() => number} rng - flux pseudo-aléatoire (tiré par le SERVEUR).
 * @returns {{steps:Array<{action:object, events?:Array, newState?:object}>,
 *            finalEntities:Array, suffixUncertain:boolean, notes:string[]}}
 */
export function resolveEnemyTurn(before, options = {}, rng) {
    const casterId = options.casterId;
    const out = { steps: [], finalEntities: [], suffixUncertain: false, notes: [] };
    try {
        // 1. Décisions (driver pur, aucun RNG) → séquence d'actions atomiques.
        const plan = planEnemyTurn(before, options);
        out.suffixUncertain = !!plan.suffixUncertain;

        // 2. État de travail (clone profond des entités) — muté au fil des actions.
        const working = {
            ...before,
            entities: (before.entities || []).map((e) => ({
                ...e,
                effects: (e.effects || []).map((x) => ({ ...x })),
            })),
        };

        // 3. Résoudre chaque action en enchaînant sur l'état de travail.
        for (const action of plan.actions) {
            if (action.type === "cast") {
                const raw = SPELLS[action.spellKey];
                if (!raw) {
                    out.notes.push(`sort inconnu: ${action.spellKey}`);
                    out.steps.push({ action });
                    continue;
                }
                const spell = { ...raw, id: action.spellKey };
                const snapshot = buildSnapshotFromState(working);
                const r = resolveSpell(
                    snapshot,
                    { casterId, spell, targetX: action.targetX, targetY: action.targetY },
                    rng,
                );
                applyNewStateToWorking(working.entities, r.newState);
                out.steps.push({ action, events: r.events, newState: r.newState });
            } else if (action.type === "move") {
                const ae = working.entities[casterId];
                if (ae) {
                    ae.x = action.toX;
                    ae.y = action.toY;
                    ae.pm = Math.max(0, (ae.pm || 0) - (action.cost || 0));
                }
                out.steps.push({ action });
            } else {
                // endTurn (ou inconnu) : rien à résoudre.
                out.steps.push({ action });
            }
        }

        out.finalEntities = working.entities;
        return out;
    } catch (e) {
        out.notes.push("exception: " + (e && e.message));
        return out;
    }
}

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
// effect_type que resolveSpell (moteur) + les portages (confusion/cost_hp/rage) savent
// résoudre côté serveur. Tout le reste (summon, self_ko, capture…) = NON géré → le tour
// bascule en FALLBACK (out.unhandled) : le client le résout localement (ancien chemin IA).
const HANDLED_EFFECT_TYPES = new Set([
    "damage", "heal", "heal_percent", "buff", "multi_buff", "random_buff",
    "transfer", "set_hp_to_one", "type_change", "dispel", "debuff", "control", "movement",
]);
function isUnhandledSpell(spell, key) {
    if (!spell) return true;
    if (spell.self_ko || spell.rest_turn || spell.summon) return true;
    if (key === "capture" || key === "summon") return true;
    // effect_type inconnu (ex. summon). Le dégât PUR (pas d'effect_type) reste géré.
    if (spell.effect_type && !HANDLED_EFFECT_TYPES.has(spell.effect_type)) return true;
    return false;
}

// Snapshot des champs d'état "durs" des entités de travail sous forme de newState (par
// INDEX), pour les steps qui mutent l'état HORS resolveSpell (confusion auto-dégât,
// cost_hp mortel) → le client (applySpellNewState) applique ces PV/mort.
function workingToNewState(entities) {
    return { entities: (entities || []).map((e) => ({ hp: e.hp, dead: e.dead, x: e.x, y: e.y, pm: e.pm, elemType: e.elemType })) };
}

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
    const out = { steps: [], finalEntities: [], suffixUncertain: false, unhandled: false, notes: [] };
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
                // Sort non résolu côté serveur (summon/self_ko/capture…) → FALLBACK : on marque
                // le tour, le client le résoudra localement (ancien chemin IA). On n'essaie pas
                // de le résoudre (résultat serveur ignoré de toute façon).
                if (isUnhandledSpell(raw, action.spellKey)) {
                    out.unhandled = true;
                    out.notes.push(`fallback client (sort non géré serveur): ${action.spellKey}`);
                    out.steps.push({ action, unhandled: true });
                    continue;
                }
                const spell = { ...raw, id: action.spellKey };
                const ae = working.entities[casterId];

                // --- Pré-résolution (réplique executeSpellLogic AVANT continueSpellExecution) ---
                // 1) CONFUSION (combat.js l.7912) : 50% qu'un ennemi confus rate une attaque de
                //    DÉGÂT → auto-dégât maxHp*0.10 + attaque ANNULÉE. Consomme 1 tirage TOUJOURS.
                const isConfused = ae && (ae.effects || []).some(
                    (e) => e.type === "control" && e.control_effect === "confused" && e.duration > 0,
                );
                if (isConfused && spell.damage > 0) {
                    if (rng() < 0.5) {
                        const selfDmg = Math.floor((ae.maxHp || 0) * 0.10);
                        ae.hp -= selfDmg;
                        const evs = [{ type: "confusionFail", casterId, amount: selfDmg }];
                        if (ae.hp <= 0) { ae.dead = true; ae.hp = 0; evs.push({ type: "death", entityId: casterId, context: "confusion" }); }
                        out.steps.push({ action, events: evs, newState: workingToNewState(working.entities) }); // attaque annulée
                        continue;
                    }
                    // sinon : le sort passe (le tirage a été consommé, comme le client).
                }

                // 2) cost_hp_percent (combat.js l.7958) : le lanceur perd des PV pour lancer.
                const preEvents = [];
                if (spell.cost_hp_percent && ae) {
                    const cost = Math.floor((ae.maxHp || 0) * spell.cost_hp_percent);
                    ae.hp -= cost;
                    preEvents.push({ type: "costHp", casterId, amount: cost });
                    if (ae.hp <= 0) {
                        ae.dead = true; ae.hp = 0;
                        preEvents.push({ type: "death", entityId: casterId, context: "costHp" });
                        out.steps.push({ action, events: preEvents, newState: workingToNewState(working.entities) }); // mort au coût
                        continue;
                    }
                }

                // --- rage : cas spécial (combat.js l.8822). Dégât AoE aux ENNEMIS (moteur, lanceur
                //     exclu) + buff force au LANCEUR. resolveSpell appliquerait le buff aux ennemis
                //     (isEngineSpell exclut rage) → on résout le DÉGÂT seul + on émet le buff ciblé
                //     sur le lanceur (le client reconstruit le buff depuis le sort rage). ---
                if (action.spellKey === "rage") {
                    const dmgOnly = { ...spell };
                    delete dmgOnly.effect_type; delete dmgOnly.stat; delete dmgOnly.value; delete dmgOnly.duration;
                    const rageSnap = buildSnapshotFromState(working);
                    const rr = resolveSpell(rageSnap, { casterId, spell: dmgOnly, targetX: action.targetX, targetY: action.targetY }, rng);
                    applyNewStateToWorking(working.entities, rr.newState);
                    out.steps.push({
                        action,
                        events: [...preEvents, ...rr.events, { type: "applyPrimaryEffect", targetId: casterId }],
                        newState: rr.newState,
                    });
                    continue;
                }

                // --- Résolution moteur (le lanceur a déjà subi confusion/coût dans le snapshot) ---
                const snapshot = buildSnapshotFromState(working);
                const r = resolveSpell(
                    snapshot,
                    { casterId, spell, targetX: action.targetX, targetY: action.targetY },
                    rng,
                );
                applyNewStateToWorking(working.entities, r.newState);
                out.steps.push({ action, events: [...preEvents, ...r.events], newState: r.newState });
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

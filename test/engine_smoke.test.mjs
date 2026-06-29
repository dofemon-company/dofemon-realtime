// Smoke test du moteur de combat porté côté serveur (Phase 2b.3 — S0/S1).
// Valide que : (1) le moteur pur vendoré charge dans le contexte Node/ESM du serveur ;
// (2) buildSnapshotFromState produit un snapshot exploitable depuis un état stocké ;
// (3) resolveTargets + resolveSpell résolvent un sort de dégât de bout en bout.
//
// Lancer : npm test (depuis dofemon-realtime).

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSpell, resolveTargets } from "../src/combat/engine/combat_engine.js";
import { getActualStats } from "../src/combat/engine/combat_stats.js";
import { buildSnapshotFromState } from "../src/combat/snapshot.js";

// État de combat stocké minimal (forme player_saves.activeCombat).
function makeCombatState() {
    return {
        status: "in_progress",
        combatType: "wild",
        combatMap: { width: 20, height: 20, offsetX: 0, offsetY: 0 },
        dungeonInfo: null,
        entities: [
            {
                id: 1, type: "hero", x: 6, y: 10, hp: 100, maxHp: 100, elemType: "normal",
                effects: [],
                baseStats: { maxHp: 100, pm: 6, init: 20, force: 30, range: 3, crit_chance: 0.01, dmg_reduc: 0, accuracy: 100, evasion: 0 },
            },
            {
                id: 10, type: "enemy", x: 8, y: 10, hp: 50, maxHp: 50, elemType: "grass",
                effects: [],
                baseStats: { maxHp: 50, pm: 4, init: 10, force: 10, range: 2, crit_chance: 0.01, dmg_reduc: 0, accuracy: 100, evasion: 0 },
            },
        ],
    };
}

test("S0 — le moteur pur charge côté serveur", () => {
    assert.equal(typeof resolveSpell, "function");
    assert.equal(typeof resolveTargets, "function");
    assert.equal(typeof getActualStats, "function");
    assert.equal(typeof buildSnapshotFromState, "function");
});

test("S1 — buildSnapshotFromState produit un snapshot exploitable", () => {
    const snap = buildSnapshotFromState(makeCombatState());
    assert.ok(snap.typeChart, "typeChart injecté");
    assert.deepEqual(snap.mapBounds, { width: 20, height: 20, offsetX: 0, offsetY: 0 });
    assert.equal(snap.entities.length, 2);
    // stats pré-résolues (héros : baseStats inclut l'équipement, heroStats=null).
    assert.equal(snap.entities[0].stats.force, 30);
    assert.equal(snap.entities[1].stats.force, 10);
    // identité = index.
    assert.equal(snap.entities[0].id, 0);
    assert.equal(snap.entities[1].id, 1);
});

test("S0+S1 — résolution autoritaire d'un sort de dégât (ciblage + résolution)", () => {
    const snap = buildSnapshotFromState(makeCombatState());
    const spell = { id: "strike", damage: 10, area: false, range: 5, type: "normal" };
    // Le moteur calcule lui-même les cibles depuis la case visée (anti-triche).
    const action = { casterId: 0, spell, targetX: 8, targetY: 10 };
    // rng déterministe : pas de miss (accuracy 100), pas de crit (>0.01).
    const rng = () => 0.5;

    const targetIds = resolveTargets(snap, action);
    assert.deepEqual(targetIds, [1], "la cible est l'ennemi (index 1)");

    const r = resolveSpell(snap, action, rng);
    const enemy = r.newState.entities[1];
    assert.equal(enemy.hp < 50, true, "l'ennemi a pris des dégâts");
    assert.ok(r.events.some((e) => e.type === "damage"), "event damage émis");
});

test("S1 — blockedTerrain dérivé de gameMap quand le champ dédié est absent (vrai save / flip)", () => {
    const cs = makeCombatState();
    // Pas de blockedTerrain (vrai save) mais gameMap 2D : (1,2)=mur(1), (3,4)=trou(2), reste libre.
    cs.gameMap = [];
    for (let x = 0; x < 5; x++) { cs.gameMap[x] = []; for (let y = 0; y < 5; y++) cs.gameMap[x][y] = 0; }
    cs.gameMap[1][2] = 1;
    cs.gameMap[3][4] = 2;
    const snap = buildSnapshotFromState(cs);
    assert.ok(snap.blockedTerrain.has("1,2"), "mur dérivé");
    assert.ok(snap.blockedTerrain.has("3,4"), "trou dérivé");
    assert.ok(!snap.blockedTerrain.has("0,0"), "case libre non bloquée");
});

test("S1 — blockedTerrain explicite (shadow) prioritaire sur gameMap", () => {
    const cs = makeCombatState();
    cs.blockedTerrain = ["7,7"];
    cs.gameMap = [[], []]; cs.gameMap[1] = []; cs.gameMap[1][1] = 1; // ne doit PAS être utilisé
    const snap = buildSnapshotFromState(cs);
    assert.ok(snap.blockedTerrain.has("7,7"));
    assert.ok(!snap.blockedTerrain.has("1,1"), "gameMap ignoré quand blockedTerrain fourni");
});

test("S1 — snapshot sans combatMap → mapBounds null (repli 20×20 du moteur)", () => {
    const cs = makeCombatState();
    cs.combatMap = null;
    const snap = buildSnapshotFromState(cs);
    assert.equal(snap.mapBounds, null);
    // resolveTargets fonctionne quand même (repli 20×20).
    const ids = resolveTargets(snap, { casterId: 0, spell: { damage: 10, area: false, range: 5 }, targetX: 8, targetY: 10 });
    assert.deepEqual(ids, [1]);
});

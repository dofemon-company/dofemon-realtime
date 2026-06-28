// Test de bout en bout du mode shadow (Phase 2b.3 — S2).
// Simule ce que le client envoie : un cast { before, intention(rngDraws), after }.
// Le `after` est produit en rejouant resolveSpell côté "client" (avec un rng qui
// enregistre ses tirages), puis runShadowComparison doit RE-rejouer à l'identique
// depuis `before` + rngDraws → 0 écart. Un `after` falsifié doit être détecté.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSpell } from "../src/combat/engine/combat_engine.js";
import { buildSnapshotFromState } from "../src/combat/snapshot.js";
import { runShadowComparison } from "../src/combat/shadow.js";

// État "before" (forme captureCombatShadowState client : entités légères + map).
function makeBefore() {
  return {
    combatMap: { width: 20, height: 20, offsetX: 0, offsetY: 0 },
    dungeonInfo: null,
    isPvp: false,
    entities: [
      {
        id: 1, type: "hero", x: 6, y: 10, hp: 100, maxHp: 100, elemType: "normal",
        level: 5, effects: [], passiveEffect: null, isWildWeakVillageMon: false,
        baseStats: { maxHp: 100, pm: 6, init: 20, force: 30, range: 3, crit_chance: 0.01, dmg_reduc: 0, accuracy: 100, evasion: 0 },
      },
      {
        id: 10, type: "enemy", x: 8, y: 10, hp: 50, maxHp: 50, elemType: "grass",
        level: 4, effects: [], passiveEffect: null, isWildWeakVillageMon: false,
        baseStats: { maxHp: 50, pm: 4, init: 10, force: 10, range: 2, crit_chance: 0.01, dmg_reduc: 0, accuracy: 100, evasion: 0 },
      },
    ],
  };
}

// Reproduit le câblage client : rng qui enregistre + entités "after" depuis newState
// + events du moteur (clone JSON, comme endShadowCast).
function clientCast(before, intention) {
  const snapshot = buildSnapshotFromState(before);
  const draws = [];
  const rng = () => { const v = Math.random(); draws.push(v); return v; };
  const r = resolveSpell(snapshot, intention, rng);
  const after = {
    entities: r.newState.entities.map((e) => ({
      hp: e.hp, dead: e.dead, x: e.x, y: e.y, elemType: e.elemType,
    })),
  };
  return {
    before,
    intention: { ...intention, rngDraws: draws },
    events: JSON.parse(JSON.stringify(r.events || [])),
    after,
  };
}

test("shadow — un cast fidèle ne produit AUCUN écart", () => {
  const before = makeBefore();
  const spell = { id: "strike", damage: 12, area: false, range: 5, type: "normal" };
  const intention = { type: "castSpell", casterId: 0, spell, targetX: 8, targetY: 10 };
  const cast = clientCast(before, intention);

  const res = runShadowComparison([cast], { addr: "testaddr", action: "endTurn" });
  assert.equal(res.casts, 1);
  assert.equal(res.mismatched, 0, "rejeu serveur identique au client");
  assert.equal(res.matched, 1);
});

test("shadow — un sort à effet (events) rejoué fidèlement = 0 écart", () => {
  const before = makeBefore();
  // Sort de dégât + debuff (effect_type) → émet un event applyPrimaryEffect en plus.
  const spell = {
    id: "venom", damage: 8, area: false, range: 5, type: "normal",
    effect_type: "debuff", effect_chance: 1, stat: "force", value: -5, duration: 3,
  };
  const intention = { type: "castSpell", casterId: 0, spell, targetX: 8, targetY: 10 };
  const cast = clientCast(before, intention);
  assert.ok(cast.events.length >= 2, "au moins un event d'effet émis");

  const res = runShadowComparison([cast], { addr: "testaddr" });
  assert.equal(res.mismatched, 0, "events serveur identiques au client");
  assert.equal(res.matched, 1);
});

test("shadow — une séquence d'events falsifiée EST détectée", () => {
  const before = makeBefore();
  const spell = { id: "strike", damage: 12, area: false, range: 5, type: "normal" };
  const intention = { type: "castSpell", casterId: 0, spell, targetX: 8, targetY: 10 };
  const cast = clientCast(before, intention);
  // triche : on retire un event côté client.
  cast.events.pop();

  const res = runShadowComparison([cast], { addr: "testaddr" });
  assert.equal(res.mismatched, 1, "l'écart de longueur d'events est détecté");
});

test("shadow — un `after` falsifié EST détecté comme écart", () => {
  const before = makeBefore();
  const spell = { id: "strike", damage: 12, area: false, range: 5, type: "normal" };
  const intention = { type: "castSpell", casterId: 0, spell, targetX: 8, targetY: 10 };
  const cast = clientCast(before, intention);
  // triche : le client prétend que l'ennemi n'a pas bougé de PV.
  cast.after.entities[1].hp = 50;

  const res = runShadowComparison([cast], { addr: "testaddr" });
  assert.equal(res.mismatched, 1, "l'écart hp est détecté");
});

test("shadow — liste vide / invalide = no-op", () => {
  assert.deepEqual(runShadowComparison([]), { casts: 0, matched: 0, mismatched: 0 });
  assert.deepEqual(runShadowComparison(null), { casts: 0, matched: 0, mismatched: 0 });
});

test("snapshot — blockedTerrain sérialisé est honoré (walkability serveur)", () => {
  const cs = makeBefore();
  cs.blockedTerrain = ["9,10", "9,11"];
  const snap = buildSnapshotFromState(cs);
  assert.ok(snap.blockedTerrain instanceof Set, "blockedTerrain reconstruit en Set");
  assert.equal(snap.blockedTerrain.has("9,10"), true);
  assert.equal(snap.blockedTerrain.has("9,11"), true);
  assert.equal(snap.blockedTerrain.has("5,5"), false);
});

test("snapshot — sans blockedTerrain → Set vide (rétro-compat)", () => {
  const snap = buildSnapshotFromState(makeBefore());
  assert.ok(snap.blockedTerrain instanceof Set);
  assert.equal(snap.blockedTerrain.size, 0);
});

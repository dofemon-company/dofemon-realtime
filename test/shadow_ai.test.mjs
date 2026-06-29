// Test du logging shadow IA (Phase 2b.4 — recording d'abord).
// À ce stade le module LOGGE seulement (pas de rejeu/comparaison). On vérifie donc
// le comptage (turns/actions) et la robustesse aux entrées vides/malformées — le
// logging ne doit jamais lever.

import { test } from "node:test";
import assert from "node:assert/strict";
import { logShadowAITurns, runShadowAIComparison } from "../src/combat/shadow_ai.js";
import { planEnemyTurn } from "../src/combat/enemy_ai_driver.js";

// `before` PVM map ouverte (réutilisé par les tests de comparaison).
function makeBeforeFor(entities) {
  return { combatMap: { width: 20, height: 20, offsetX: 0, offsetY: 0 }, blockedTerrain: [], isPvp: false, dungeonInfo: null, entities };
}
function en(x, y, spells, extra = {}) {
  return { type: "enemy", x, y, hp: 100, maxHp: 100, pm: 3, maxPm: 3, dead: false, elemType: "normal", spells, spellCooldowns: {}, effects: [], ...extra };
}
function he(x, y) {
  return { type: "hero", x, y, hp: 100, maxHp: 100, pm: 6, maxPm: 6, dead: false, elemType: "normal", spells: [], spellCooldowns: {}, effects: [] };
}
// Construit un tour enregistré dont la séquence = ce que le driver produirait (round-trip fidèle).
function recordedTurnFrom(before, casterId, isBoss = false) {
  const plan = planEnemyTurn(before, { casterId, isBoss });
  return { before, casterId, isBoss, actions: plan.actions.filter((a) => a.type !== "endTurn"), after: { entities: [] } };
}

function makeTurn(casterId, actions, isBoss = false) {
  return {
    before: { combatMap: { width: 20, height: 20 }, entities: [{ id: 1 }, { id: 10 }] },
    casterId,
    isBoss,
    actions,
    after: { entities: [{ id: 1 }, { id: 10 }] },
  };
}

test("logShadowAITurns — compte tours + actions", () => {
  const turns = [
    makeTurn(1, [
      { type: "move", toX: 5, toY: 6 },
      { type: "cast", spellKey: "ember", targetX: 6, targetY: 10 },
    ]),
    makeTurn(2, [{ type: "cast", spellKey: "rage", targetX: 7, targetY: 7 }], true),
  ];
  const r = logShadowAITurns(turns, { addr: "ABCDEFGH1234", action: "endTurn" });
  assert.equal(r.turns, 2);
  assert.equal(r.actions, 3);
});

test("logShadowAITurns — vide ou non-array = no-op sûr", () => {
  assert.deepEqual(logShadowAITurns([]), { turns: 0, actions: 0 });
  assert.deepEqual(logShadowAITurns(undefined), { turns: 0, actions: 0 });
  assert.deepEqual(logShadowAITurns(null), { turns: 0, actions: 0 });
});

test("logShadowAITurns — entrées malformées ne lèvent pas", () => {
  const turns = [null, {}, { actions: "pas-un-array" }, makeTurn(0, [{ type: "??" }])];
  const r = logShadowAITurns(turns, { addr: "X" });
  assert.equal(r.turns, 4);
  // seul le dernier tour a un tableau d'actions (1 action)
  assert.equal(r.actions, 1);
});

test("runShadowAIComparison — round-trip fidèle = MATCH", () => {
  const before = makeBeforeFor([he(5, 5), en(6, 5, ["strike", "bubble"], { pm: 3 })]);
  const r = runShadowAIComparison([recordedTurnFrom(before, 1)], { addr: "ABC" });
  assert.equal(r.turns, 1);
  assert.equal(r.matched, 1);
  assert.equal(r.mismatched, 0);
});

test("runShadowAIComparison — séquence falsifiée = MISMATCH", () => {
  const before = makeBeforeFor([he(5, 5), en(6, 5, ["strike", "bubble"], { pm: 3 })]);
  const turn = recordedTurnFrom(before, 1);
  turn.actions[0] = { type: "cast", spellKey: "bubble", targetX: 99, targetY: 99 }; // faux
  const r = runShadowAIComparison([turn], { addr: "ABC" });
  assert.equal(r.mismatched, 1);
});

test("runShadowAIComparison — mouvement primaire (charge) = PARTIAL", () => {
  const before = makeBeforeFor([he(5, 5), en(7, 5, ["charge"], { pm: 2 })]);
  const turn = recordedTurnFrom(before, 1);
  // Le client a aussi un suffixe (recul) après charge ; on simule un suffixe arbitraire
  // → seul le préfixe jusqu'au cast charge est validé.
  turn.actions.push({ type: "move", toX: 1, toY: 1 });
  const r = runShadowAIComparison([turn], { addr: "ABC" });
  assert.equal(r.partial, 1);
  assert.equal(r.mismatched, 0);
});

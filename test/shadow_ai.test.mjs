// Test du logging shadow IA (Phase 2b.4 — recording d'abord).
// À ce stade le module LOGGE seulement (pas de rejeu/comparaison). On vérifie donc
// le comptage (turns/actions) et la robustesse aux entrées vides/malformées — le
// logging ne doit jamais lever.

import { test } from "node:test";
import assert from "node:assert/strict";
import { logShadowAITurns } from "../src/combat/shadow_ai.js";

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

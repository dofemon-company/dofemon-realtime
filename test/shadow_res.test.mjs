// Tests de la SHADOW DE RÉSOLUTION (Palier C — C1b) : runEnemyTurnResolutionShadow
// rejoue resolveEnemyTurn(before) et compare STRUCTURELLEMENT à `after` (positions,
// mort, direction de dégât, effets de contrôle). But : débusquer les trous de
// résolution serveur avant le flip. On vérifie MATCH (après = résolution) et MISMATCH.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runEnemyTurnResolutionShadow } from "../src/combat/shadow_ai.js";
import { resolveEnemyTurn } from "../src/combat/enemy_turn.js";
import { createRng } from "../src/combat/engine/combat_engine.js";

function makeBefore(entities) {
  return { combatMap: { width: 20, height: 20, offsetX: 0, offsetY: 0 }, blockedTerrain: [], isPvp: false, dungeonInfo: null, entities };
}
function enemy(x, y, spells, extra = {}) {
  return { type: "enemy", x, y, hp: 100, maxHp: 100, pm: 3, maxPm: 3, dead: false, elemType: "normal", spells, spellCooldowns: {}, effects: [], ...extra };
}
function hero(x, y) {
  return { type: "hero", x, y, hp: 100, maxHp: 100, pm: 6, maxPm: 6, dead: false, elemType: "normal", spells: [], spellCooldowns: {}, effects: [] };
}

test("shadow-res : MATCH quand `after` reflète la résolution serveur", () => {
  const before = makeBefore([hero(5, 5), enemy(6, 5, ["strike"])]);
  // `after` = état final produit par resolveEnemyTurn (positions/dégât/effets = déterministes).
  const after = { entities: resolveEnemyTurn(before, { casterId: 1 }, createRng(42)).finalEntities };
  const r = runEnemyTurnResolutionShadow([{ before, after, casterId: 1 }]);
  assert.equal(r.matched, 1);
  assert.equal(r.mismatched, 0);
});

test("shadow-res : MISMATCH si le héros n'a PAS pris de dégât (ex. confusion non gérée serveur)", () => {
  const before = makeBefore([hero(5, 5), enemy(6, 5, ["strike"])]);
  // `after` falsifié : héros intact + ennemi immobile (comme si l'attaque avait été annulée).
  const after = { entities: [hero(5, 5), enemy(6, 5, ["strike"])] };
  const r = runEnemyTurnResolutionShadow([{ before, after, casterId: 1 }]);
  assert.equal(r.mismatched, 1);
});

test("shadow-res : aucun tour → compte nul, pas d'exception", () => {
  assert.deepEqual(runEnemyTurnResolutionShadow([]), { turns: 0, matched: 0, mismatched: 0 });
});

// Tests du driver IA serveur (Phase 2b.4). On reproduit les FORMES de séquences
// observées dans les logs shadow-ai réels (cast+move, move+cast, [move]/[cast] seul,
// self-buff→approche, suffixe incertain sur mouvement primaire) et on vérifie que
// planEnemyTurn émet la bonne séquence d'intentions. AUCUN RNG (IA déterministe).

import { test } from "node:test";
import assert from "node:assert/strict";
import { planEnemyTurn } from "../src/combat/enemy_ai_driver.js";

// Fabrique un `before` (forme captureCombatShadowState) : map 20x20 ouverte, PVM.
function makeBefore(entities) {
  return {
    combatMap: { width: 20, height: 20, offsetX: 0, offsetY: 0 },
    blockedTerrain: [],
    isPvp: false,
    dungeonInfo: null,
    entities,
  };
}

function enemy(x, y, spells, extra = {}) {
  return {
    type: "enemy", x, y, hp: 100, maxHp: 100, pm: 3, maxPm: 3, dead: false,
    elemType: "normal", spells, spellCooldowns: {}, effects: [], ...extra,
  };
}
function hero(x, y) {
  return {
    type: "hero", x, y, hp: 100, maxHp: 100, pm: 6, maxPm: 6, dead: false,
    elemType: "normal", spells: [], spellCooldowns: {}, effects: [],
  };
}

const types = (r) => r.actions.map((a) => a.type);

test("attaque à portée → cast puis recul (cast, move, endTurn)", () => {
  const before = makeBefore([hero(5, 5), enemy(6, 5, ["strike", "bubble"], { pm: 3 })]);
  const r = planEnemyTurn(before, { casterId: 1 });
  assert.equal(r.actions[0].type, "cast");
  assert.equal(r.actions[0].targetX, 5);
  assert.equal(r.actions[0].targetY, 5);
  assert.equal(r.actions[1].type, "move");
  assert.equal(r.actions[r.actions.length - 1].type, "endTurn");
  assert.equal(r.suffixUncertain, false);
});

test("hors portée → approche puis attaque (move, cast, …)", () => {
  const before = makeBefore([hero(5, 5), enemy(10, 5, ["bubble"], { pm: 4 })]);
  const r = planEnemyTurn(before, { casterId: 1 });
  assert.equal(r.actions[0].type, "move");
  assert.equal(r.actions[1].type, "cast");
  assert.equal(r.actions[1].spellKey, "bubble");
  assert.equal(r.actions[r.actions.length - 1].type, "endTurn");
});

test("aucune cible → endTurn seul", () => {
  const before = makeBefore([enemy(6, 5, ["strike"]), enemy(7, 5, ["strike"])]);
  const r = planEnemyTurn(before, { casterId: 0 });
  assert.deepEqual(types(r), ["endTurn"]);
});

test("self-buff prioritaire → cast à la position du lanceur puis approche", () => {
  const before = makeBefore([hero(5, 5), enemy(10, 5, ["camouflage", "bubble"], { pm: 3 })]);
  const r = planEnemyTurn(before, { casterId: 1 });
  assert.equal(r.actions[0].type, "cast");
  assert.equal(r.actions[0].spellKey, "camouflage");
  assert.equal(r.actions[0].targetX, 10); // position du lanceur
  assert.equal(r.actions[0].targetY, 5);
  assert.equal(r.actions[1].type, "move"); // continueEnemyAI → approche
});

test("mouvement primaire (charge) → suffixUncertain", () => {
  const before = makeBefore([hero(5, 5), enemy(7, 5, ["charge"], { pm: 2 })]);
  const r = planEnemyTurn(before, { casterId: 1 });
  assert.equal(r.actions[0].type, "cast");
  assert.equal(r.actions[0].spellKey, "charge");
  assert.equal(r.suffixUncertain, true);
});

test("ennemi mort/inexistant → endTurn sûr", () => {
  const before = makeBefore([hero(5, 5), enemy(6, 5, ["strike"], { dead: true })]);
  const r = planEnemyTurn(before, { casterId: 1 });
  assert.deepEqual(types(r), ["endTurn"]);
});

test("sort de zone cône (dragon_breath) → case de cast EN DIRECTION (pas la cible)", () => {
  // dragon_breath : range1, area cône aoe_size3 → portée effective 3. Lanceur (5,5),
  // héros (8,5) même rangée, dist3 ≤ 3. La case de cast doit être à castRange(1) du
  // lanceur vers la cible = (6,5), PAS la case du héros (8,5).
  const before = makeBefore([hero(8, 5), enemy(5, 5, ["dragon_breath"], { pm: 3 })]);
  const r = planEnemyTurn(before, { casterId: 1 });
  assert.equal(r.actions[0].type, "cast");
  assert.equal(r.actions[0].spellKey, "dragon_breath");
  assert.equal(r.actions[0].targetX, 6);
  assert.equal(r.actions[0].targetY, 5);
});

test("boss à portée → attaque le héros", () => {
  const before = makeBefore([hero(5, 5), enemy(6, 5, ["strike", "bubble"], { isBoss: true, pm: 3 })]);
  const r = planEnemyTurn(before, { casterId: 1, isBoss: true });
  assert.equal(r.actions[0].type, "cast");
  assert.equal(r.actions[0].targetX, 5);
  assert.equal(r.actions[0].targetY, 5);
});

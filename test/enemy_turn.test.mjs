// Tests de resolveEnemyTurn (Palier C — C1) : le serveur JOUE + RÉSOUT un tour ennemi
// PVM (décisions du driver + resolveSpell par cast). On vérifie la RÉSOLUTION (dégâts
// appliqués, déplacement enchaîné), pas seulement la séquence d'actions (couverte par
// enemy_ai_driver.test). RNG injecté (le serveur tire les dés — D3).

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEnemyTurn } from "../src/combat/enemy_turn.js";

function makeBefore(entities) {
  return { combatMap: { width: 20, height: 20, offsetX: 0, offsetY: 0 }, blockedTerrain: [], isPvp: false, dungeonInfo: null, entities };
}
function enemy(x, y, spells, extra = {}) {
  return { type: "enemy", x, y, hp: 100, maxHp: 100, pm: 3, maxPm: 3, dead: false, elemType: "normal", spells, spellCooldowns: {}, effects: [], ...extra };
}
function hero(x, y) {
  return { type: "hero", x, y, hp: 100, maxHp: 100, pm: 6, maxPm: 6, dead: false, elemType: "normal", spells: [], spellCooldowns: {}, effects: [] };
}
function queueRng(values) { let i = 0; return () => values[i++]; }

test("resolveEnemyTurn : attaque à portée → dégât RÉSOLU + step cast avec events", () => {
  const before = makeBefore([hero(5, 5), enemy(6, 5, ["strike"])]);
  const r = resolveEnemyTurn(before, { casterId: 1 }, queueRng([0.5, 0.99]));
  const castStep = r.steps.find((s) => s.action.type === "cast");
  assert.ok(castStep, "un step cast");
  assert.equal(castStep.action.spellKey, "strike");
  assert.ok(castStep.events.some((e) => e.type === "damage"), "event damage émis");
  assert.ok(r.finalEntities[0].hp < 100, "le héros a pris des dégâts (résolus)");
  assert.equal(r.steps[r.steps.length - 1].action.type, "endTurn");
});

test("resolveEnemyTurn : hors portée → move enchaîné PUIS cast résolu", () => {
  const before = makeBefore([hero(5, 5), enemy(10, 5, ["bubble"], { pm: 4 })]);
  const r = resolveEnemyTurn(before, { casterId: 1 }, queueRng([0.5, 0.99]));
  assert.ok(r.steps.some((s) => s.action.type === "move"), "un step move");
  const castStep = r.steps.find((s) => s.action.type === "cast");
  assert.ok(castStep, "un step cast après approche");
  assert.ok(r.finalEntities[1].x < 10, "l'ennemi s'est rapproché (move appliqué)");
  assert.ok(r.finalEntities[0].hp < 100, "le héros est touché après l'approche (cast résolu sur la nouvelle position)");
});

test("resolveEnemyTurn : aucune cible → endTurn seul, état inchangé", () => {
  const before = makeBefore([enemy(6, 5, ["strike"]), enemy(7, 5, ["strike"])]);
  const r = resolveEnemyTurn(before, { casterId: 0 }, queueRng([]));
  assert.deepEqual(r.steps.map((s) => s.action.type), ["endTurn"]);
  assert.equal(r.finalEntities[0].hp, 100);
});

test("resolveEnemyTurn : sort de mouvement (charge) → lanceur déplacé + dégât résolu", () => {
  // Ennemi (7,5) charge le héros (5,5) : atterrit à (6,5), frappe.
  const before = makeBefore([hero(5, 5), enemy(7, 5, ["charge"], { pm: 2 })]);
  const r = resolveEnemyTurn(before, { casterId: 1 }, queueRng([0.5, 0.99]));
  const castStep = r.steps.find((s) => s.action.type === "cast" && s.action.spellKey === "charge");
  assert.ok(castStep, "un step charge");
  // Le lanceur a avancé d'une case vers le héros (7,5) -> (6,5) DANS le newState du cast
  // (finalEntities peut différer : l'ennemi peut reculer après avoir chargé, PM restants).
  assert.deepEqual([castStep.newState.entities[1].x, castStep.newState.entities[1].y], [6, 5], "atterrissage charge");
  assert.ok(r.finalEntities[0].hp < 100, "héros touché par la charge");
});

// Tests du module de récompenses de victoire (Palier D — D1).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeVictoryRewards,
  isVictoryState,
  DUNGEON_KEY_ELEM_TYPES,
} from "../src/combat/victory.js";

// rng scripté : consomme `seq` puis retombe sur 0.99 (aucun drop).
function seqRng(seq) {
  let i = 0;
  return () => (i < seq.length ? seq[i++] : 0.99);
}

test("wild : xp/gold = formules client, tous les type enemy comptent", () => {
  const state = {
    entities: [
      { id: 1, type: "hero", dead: false },
      { id: 2, type: "enemy", name: "Braina", level: 3, elemType: "psychic", dead: true },
      { id: 3, type: "enemy", name: "Flamby", level: 5, elemType: "fire", dead: true },
    ],
  };
  const r = computeVictoryRewards(state, seqRng([]));
  assert.equal(r.mode, "wild");
  // (5+3)*10 + (5+5)*10
  assert.equal(r.xpTotal, 180);
  // (25+2*2) + (25+4*2)
  assert.equal(r.coinsTotal, 62);
  assert.deepEqual(r.monstersDefeated, ["Braina", "Flamby"]);
  assert.deepEqual(r.enemyDrops, []);
  assert.equal(r.npcDefeated, null);
});

test("npc : xp ×2/3 arrondi, seuls isNPC/isNPCCreature comptent", () => {
  const state = {
    entities: [
      { id: 1, type: "hero", dead: false },
      { id: 2, type: "enemy", name: "Garde", level: 3, isNPC: true, dead: true },
      { id: 3, type: "enemy", name: "Chien", level: 5, isNPCCreature: true, dead: true },
      { id: 4, type: "enemy", name: "Intrus", level: 50, dead: true }, // ignoré en mode npc
    ],
  };
  const r = computeVictoryRewards(state, seqRng([]));
  assert.equal(r.mode, "npc");
  // round(80*2/3) + round(100*2/3) = 53 + 67
  assert.equal(r.xpTotal, 120);
  assert.equal(r.coinsTotal, 29 + 33);
  assert.equal(r.npcDefeated, "Garde");
  assert.deepEqual(r.monstersDefeated, []);
});

test("loot : 1er jet < 0.05 => stones_common ; clé seulement si elemType valide", () => {
  const mk = (elemType) => ({
    entities: [{ id: 2, type: "enemy", name: "X", level: 1, elemType, dead: true }],
  });
  // Jets : stones c/r/l, potions c/r/l, clé, equip c/r/l, sphères c/r/l, recall.
  const keyHit = [0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.001];
  const withKey = computeVictoryRewards(mk("fire"), seqRng(keyHit));
  assert.deepEqual(withKey.enemyDrops[0].drops, [{ kind: "key" }]);
  // Même séquence mais elemType hors DUNGEON_KEY_ELEM_TYPES : jet consommé, pas de clé.
  const noKey = computeVictoryRewards(mk("normal"), seqRng(keyHit));
  assert.deepEqual(noKey.enemyDrops, []);
  assert.equal(DUNGEON_KEY_ELEM_TYPES.has("normal"), false);

  const stones = computeVictoryRewards(mk("fire"), seqRng([0.01]));
  assert.deepEqual(stones.enemyDrops[0].drops, [{ kind: "consumable", key: "stones_common" }]);
});

test("boss enregistré une seule fois", () => {
  const state = {
    entities: [
      { id: 2, type: "enemy", name: "BossX", level: 10, isBoss: true, dead: true },
      { id: 3, type: "enemy", name: "BossX", level: 10, isBoss: true, dead: true },
    ],
  };
  const r = computeVictoryRewards(state, seqRng([]));
  assert.deepEqual(r.defeatedBosses, ["BossX"]);
});

test("isVictoryState : wild = plus d'ennemi vivant ; npc = héros PNJ mort", () => {
  assert.equal(
    isVictoryState({ entities: [{ type: "enemy", dead: false }] }),
    false
  );
  assert.equal(
    isVictoryState({ entities: [{ type: "enemy", dead: true }, { type: "hero", dead: false }] }),
    true
  );
  // npc : le PNJ mort suffit (réplique checkVictory), même avec créature vivante.
  assert.equal(
    isVictoryState({
      entities: [
        { type: "enemy", isNPC: true, dead: true },
        { type: "enemy", isNPCCreature: true, dead: false },
      ],
    }),
    true
  );
  // état vide / sans ennemi : jamais une victoire.
  assert.equal(isVictoryState({ entities: [] }), false);
  assert.equal(isVictoryState({ entities: [{ type: "hero", dead: false }] }), false);
});

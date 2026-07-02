// =========================================
// RÉCOMPENSES DE VICTOIRE (Palier D — D1)
// =========================================
// Portage serveur de la logique de récompenses du client (combat.js) :
//   - applyVictoryRewards (victoire sauvage/donjon, ~l.440) : XP plein, tous les
//     type==='enemy', loot par ennemi via rollLootDrops ;
//   - checkVictory branche PNJ (~l.12883) : XP ×2/3 arrondi, ennemis isNPC ou
//     isNPCCreature, loot identique.
// Formules répliquées VERBATIM :
//   XP par monstre  = (5 + niveau) × 10          (getXpFromMonster)
//   GOLD par monstre = 25 + (niveau − 1) × 2      (getGoldFromMonster)
// Le module est PUR (état + rng en entrée → récompenses en sortie) : le serveur
// tire les dés de loot (D3 « serveur tire / client affiche ») ; le client applique
// les montants/drops renvoyés (createItem/gainXp/addGold restent côté client).
//
// ⚠️ ÉTAPE D : l'état final est fourni par le CLIENT (comme enemy-turn) car l'état
// stocké serveur est en retard d'un coup au moment de la victoire (le coup fatal
// n'a pas encore été flushé par endTurn). L'autorité complète sur l'état = Palier B.
// La valeur anti-triche immédiate = le LOOT n'est plus falsifiable/re-rollable :
// tirages serveur + idempotence par combat (voir handlers.victoryHandler).

import { rollLootDrops } from "./engine/combat_engine.js";

// Réplique de DUNGEON_KEY_TYPES (items_data.js) : seuls les elemType présents
// donnent droit au jet de clé de donjon.
export const DUNGEON_KEY_ELEM_TYPES = new Set([
  "fire", "water", "grass", "electric", "wind", "ground",
  "psychic", "dark", "light", "steel", "dragon",
]);

function xpFromMonster(level) {
  return (5 + (level || 5)) * 10;
}

function goldFromMonster(level) {
  return 25 + ((level || 5) - 1) * 2;
}

/**
 * Le combat est-il réellement gagné dans cet état ?
 * - mode PNJ (un héros PNJ présent) : victoire = le héros PNJ est mort ;
 * - mode sauvage/donjon : victoire = plus aucun type==='enemy' vivant.
 */
export function isVictoryState(combatState) {
  const entities = combatState?.entities;
  if (!Array.isArray(entities) || entities.length === 0) return false;
  const npcHero = entities.find((e) => e && e.isNPC === true);
  if (npcHero) return !!npcHero.dead;
  const hasEnemy = entities.some((e) => e && e.type === "enemy");
  if (!hasEnemy) return false;
  return !entities.some((e) => e && e.type === "enemy" && !e.dead);
}

/**
 * Calcule les récompenses de victoire depuis l'état final du combat.
 * @param {{entities: Array}} combatState état final (tous ennemis morts)
 * @param {() => number} rng générateur [0,1) — le serveur fournit une graine
 *   NON prédictible (crypto) ; jamais dérivée de l'état (sinon loot prévisible).
 * @returns {{ mode, xpTotal, coinsTotal, enemyDrops, defeatedBosses,
 *             monstersDefeated, npcDefeated }}
 */
export function computeVictoryRewards(combatState, rng) {
  const entities = Array.isArray(combatState?.entities) ? combatState.entities : [];
  const npcHero = entities.find((e) => e && e.isNPC === true);
  const mode = npcHero ? "npc" : "wild";

  let xpTotal = 0;
  let coinsTotal = 0;
  const enemyDrops = [];
  const defeatedBosses = [];
  const monstersDefeated = [];

  for (const e of entities) {
    if (!e || e.type !== "enemy") continue;
    // Mode PNJ : seuls le PNJ et ses créatures comptent (réplique checkVictory).
    if (mode === "npc" && !(e.isNPC || e.isNPCCreature)) continue;

    if (e.isBoss && e.name && !defeatedBosses.includes(e.name)) {
      defeatedBosses.push(e.name);
    }
    if (mode === "wild" && e.name && !e.isNPC && !e.isNPCCreature) {
      monstersDefeated.push(e.name);
    }

    xpTotal += mode === "npc"
      ? Math.round((xpFromMonster(e.level) * 2) / 3)
      : xpFromMonster(e.level);
    coinsTotal += goldFromMonster(e.level);

    // Même sémantique/ordre de tirage que le client : un bloc rollLootDrops
    // par ennemi, dans l'ordre des entités.
    const validKeyElemType = !!(e.elemType && DUNGEON_KEY_ELEM_TYPES.has(e.elemType));
    const drops = rollLootDrops({ validKeyElemType }, rng);
    if (drops.length > 0) {
      enemyDrops.push({ entityId: e.id ?? null, elemType: e.elemType ?? null, drops });
    }
  }

  return {
    mode,
    xpTotal,
    coinsTotal,
    enemyDrops,
    defeatedBosses,
    monstersDefeated,
    npcDefeated: mode === "npc" ? (npcHero.name || null) : null,
  };
}

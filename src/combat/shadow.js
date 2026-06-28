// =============================================================================
// SHADOW MODE — comparaison serveur autoritatif (Phase 2b.3 — S2)
// =============================================================================
// Le client envoie, à côté de l'état calculé, une liste de "casts" moteur joués
// pendant le tour (cf. js/combat.js beginShadowCast/endShadowCast). Chaque cast =
//   { before, intention:{type,casterId,spell,targetX,targetY,rngDraws[]}, after }
// Le serveur REJOUE resolveSpell depuis `before` (snapshot reconstruit) avec la
// MÊME file de tirages RNG (rngDraws) et COMPARE le résultat à `after` (vérité
// client). On LOGGE seulement : aucune écriture, aucun impact sur la réponse ni
// le stockage. But = mesurer la parité de logique (snapshot serveur + moteur ==
// client) en isolant le RNG. Les écarts pilotent S3.
//
// ⚠️ Adaptation au modèle "persist par tour" (le client ne tape le serveur qu'à
// endTurn, pas par coup) : l'état AVANT voyage AVEC chaque cast (self-contained),
// au lieu d'être relu du stockage serveur. Le stockage reste la confiance-client.
// =============================================================================

import { resolveSpell } from "./engine/combat_engine.js";
import { buildSnapshotFromState } from "./snapshot.js";

// File de tirages : rejoue les valeurs RNG du client dans l'ordre. Si le serveur
// en consomme PLUS que prévu → divergence de logique (nombre de tirages) → on le
// signale et on renvoie une valeur neutre pour ne pas planter le rejeu.
function makeRngQueue(draws) {
  const q = Array.isArray(draws) ? draws.slice() : [];
  let overflow = 0;
  const fn = () => {
    if (q.length > 0) return q.shift();
    overflow++;
    return 0.5;
  };
  fn.stats = () => ({ remaining: q.length, overflow });
  return fn;
}

const FIELDS = ["hp", "dead", "x", "y", "elemType", "pm"];

// Compare la SÉQUENCE d'events du moteur (serveur vs client). Comme les deux
// proviennent du MÊME code moteur, l'ordre des clés est identique → l'égalité
// JSON par event est valide et robuste. Valide l'application des effets
// (applyPrimaryEffect/applyMultiBuff/secondarySpellEffect…) absente de newState.
// Renvoie null si identiques (ou si le client n'envoie pas d'events = ancien client).
function diffEvents(serverEvents, clientEvents) {
  if (!Array.isArray(clientEvents)) return null; // rétro-compat : pas d'events client
  const sv = Array.isArray(serverEvents) ? serverEvents : [];
  if (sv.length !== clientEvents.length) {
    return { reason: "length", server: sv.length, client: clientEvents.length };
  }
  for (let i = 0; i < sv.length; i++) {
    const a = JSON.stringify(sv[i]);
    const b = JSON.stringify(clientEvents[i]);
    if (a !== b) return { reason: "event", index: i, server: sv[i], client: clientEvents[i] };
  }
  return null;
}

// Compare l'état d'arrivée serveur (newState) à l'état client (after).
// Renvoie la liste des écarts {index, field, expected, got}.
function diffEntities(serverEntities, clientAfter) {
  const diffs = [];
  const clientEntities = (clientAfter && clientAfter.entities) || [];
  const n = Math.max(serverEntities.length, clientEntities.length);
  for (let i = 0; i < n; i++) {
    const s = serverEntities[i];
    const c = clientEntities[i];
    if (!s || !c) {
      diffs.push({ index: i, field: "_presence", expected: !!c, got: !!s });
      continue;
    }
    for (const f of FIELDS) {
      // Normaliser dead (undefined ~ false) et arrondir hp pour éviter le bruit.
      let sv = s[f];
      let cv = c[f];
      if (f === "dead") { sv = !!sv; cv = !!cv; }
      if (sv !== cv) diffs.push({ index: i, field: f, expected: cv, got: sv });
    }
  }
  return diffs;
}

/**
 * Rejoue + compare une liste de casts shadow. Pur log, aucune exception propagée.
 * @param {Array} shadowCasts
 * @param {object} [meta] - contexte de log (ex. { addr, action }).
 * @returns {{casts:number, matched:number, mismatched:number}}
 */
export function runShadowComparison(shadowCasts, meta = {}) {
  if (!Array.isArray(shadowCasts) || shadowCasts.length === 0) {
    return { casts: 0, matched: 0, mismatched: 0 };
  }

  let matched = 0;
  let mismatched = 0;
  let eventsChecked = 0; // casts où le client a envoyé ses events (= comparaison events ACTIVE)
  const spellIds = []; // ids des sorts comparés (preuve positive de ce qui est exercé)
  const tag = `[shadow${meta.addr ? " " + String(meta.addr).slice(0, 8) : ""}]`;

  for (let k = 0; k < shadowCasts.length; k++) {
    const cast = shadowCasts[k];
    try {
      if (!cast || !cast.before || !cast.intention) continue;
      const { casterId, spell, targetX, targetY, rngDraws } = cast.intention;
      if (spell && spell.id) spellIds.push(spell.id);

      const snapshot = buildSnapshotFromState(cast.before);
      const rng = makeRngQueue(rngDraws);
      const r = resolveSpell(snapshot, { casterId, spell, targetX, targetY }, rng);

      const diffs = diffEntities(r.newState.entities, cast.after);
      const evDiff = diffEvents(r.events, cast.events);
      if (Array.isArray(cast.events)) eventsChecked++;
      const { remaining, overflow } = rng.stats();

      if (diffs.length === 0 && overflow === 0 && !evDiff) {
        matched++;
      } else {
        mismatched++;
        console.warn(
          `${tag} ÉCART cast#${k} spell=${spell && spell.id} ` +
            `caster=${casterId} target=(${targetX},${targetY}) ` +
            `rng[used=${(Array.isArray(rngDraws) ? rngDraws.length : 0) - remaining}` +
            `/${Array.isArray(rngDraws) ? rngDraws.length : 0}${overflow ? ` +${overflow} overflow` : ""}] ` +
            `diffs=${JSON.stringify(diffs.slice(0, 8))}` +
            (evDiff ? ` events=${JSON.stringify(evDiff)}` : "")
        );
      }
    } catch (e) {
      mismatched++;
      console.warn(`${tag} ERREUR rejeu cast#${k}: ${e && e.message}`);
    }
  }

  console.log(
    `${tag} ${meta.action || ""} casts=${shadowCasts.length} match=${matched} mismatch=${mismatched} ev=${eventsChecked}` +
      (spellIds.length ? ` spells=${JSON.stringify(spellIds)}` : "")
  );

  return { casts: shadowCasts.length, matched, mismatched, eventsChecked };
}

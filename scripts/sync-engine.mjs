// Synchronise le moteur de combat PUR depuis le repo DOFEMON vers le vendor serveur.
//
// Source de vérité = DOFEMON/js (combat_geometry/combat_engine/combat_stats). Ces
// modules sont purs (aucune dépendance DOM/state) → copiables tels quels côté serveur.
// `engine/passive_effects.js` est un TRIM manuel (applyPassiveEffects + isSameTeam) du
// passive_effects.js client (qui importe state/translations pour d'autres fonctions) :
// il change rarement ; ce script ne le régénère pas, mais VÉRIFIE que le corps de
// applyPassiveEffects côté client n'a pas divergé (avertit sinon).
//
// Usage : node scripts/sync-engine.mjs [chemin_repo_DOFEMON]
//   defaut : ../DOFEMON (sibling de dofemon-realtime)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(__dirname, "..");
const DOFEMON = process.argv[2] || join(SERVER_ROOT, "..", "DOFEMON");
const SRC = join(DOFEMON, "js");
const DST = join(SERVER_ROOT, "src", "combat", "engine");

const PURE_FILES = ["combat_geometry.js", "combat_engine.js", "combat_stats.js"];

if (!existsSync(SRC)) {
    console.error(`[sync-engine] Introuvable: ${SRC}\nPasser le chemin du repo DOFEMON en argument.`);
    process.exit(1);
}

for (const f of PURE_FILES) {
    const src = join(SRC, f);
    const dst = join(DST, f);
    writeFileSync(dst, readFileSync(src));
    console.log(`[sync-engine] copié ${f}`);
}

// Garde-fou : extraire le corps de applyPassiveEffects côté client et comparer
// (normalisé) à la version serveur. Avertit en cas de divergence (à re-trimer à la main).
function extractApplyPassive(text) {
    const start = text.indexOf("export function applyPassiveEffects");
    if (start === -1) return null;
    // Trouver l'accolade fermante de la fonction par comptage de profondeur.
    let i = text.indexOf("{", start);
    let depth = 0;
    for (; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") { depth--; if (depth === 0) { i++; break; } }
    }
    // Comparer la LOGIQUE seule : retirer les commentaires `//…` puis normaliser les blancs
    // (les commentaires diffèrent entre client et serveur sans changer le comportement).
    return text.slice(start, i).replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim();
}

try {
    const clientPassive = extractApplyPassive(readFileSync(join(SRC, "passive_effects.js"), "utf8"));
    const serverPassive = extractApplyPassive(readFileSync(join(DST, "passive_effects.js"), "utf8"));
    if (clientPassive && serverPassive && clientPassive !== serverPassive) {
        console.warn("[sync-engine] ⚠️ applyPassiveEffects a DIVERGÉ entre client et serveur.\n" +
            "  → re-trimer engine/passive_effects.js à la main depuis DOFEMON/js/passive_effects.js.");
    } else {
        console.log("[sync-engine] applyPassiveEffects: parité OK.");
    }
} catch (e) {
    console.warn("[sync-engine] vérif passive_effects impossible:", e.message);
}

console.log("[sync-engine] terminé.");

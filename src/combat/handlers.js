// =========================================
// HANDLERS COMBAT (portage des fonctions Vercel api/combat/*)
// =========================================
// Routes HTTP express servies par le VPS (remplacent les edge functions Vercel).
// Semantique IDENTIQUE aux originaux (read-modify-write sur player_saves) pour
// zero changement de comportement / zero risque de regression save.
//
// Le client Supabase est cree de maniere LAZY : si les variables d'env manquent,
// seules les routes combat renvoient 503 — le serveur de presence continue de tourner.

import { createClient } from "@supabase/supabase-js";
import { fastForwardCombat } from "./simulation.js";
import { runShadowComparison } from "./shadow.js";
import { runShadowAIComparison, runEnemyTurnResolutionShadow } from "./shadow_ai.js";
import { resolveEnemyTurn } from "./enemy_turn.js";
import { createRng, hashSeed } from "./engine/combat_engine.js";

const TURN_DURATION_MS = 20000; // 20 s par tour (heros/allie)

let _supabase = null;
let _supabaseChecked = false;

function getSupabase() {
  if (_supabaseChecked) return _supabase;
  _supabaseChecked = true;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn(
      "[combat] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants — routes combat desactivees (503)"
    );
    return null;
  }
  _supabase = createClient(url, key);
  console.log("[combat] client Supabase initialise");
  return _supabase;
}

/**
 * Resout solana_address depuis le token Bearer (table wallet_sessions).
 * Envoie la reponse d'erreur et retourne null si invalide.
 */
async function resolveSolanaAddress(req, res, supabase) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  const token = authHeader.substring(7);

  const { data: session, error: sessionError } = await supabase
    .from("wallet_sessions")
    .select("solana_address, expires_at")
    .eq("session_token", token)
    .single();

  if (sessionError || !session) {
    res.status(401).json({ error: "Invalid token" });
    return null;
  }
  if (new Date(session.expires_at) < new Date()) {
    res.status(401).json({ error: "Session expired" });
    return null;
  }
  return session.solana_address;
}

/**
 * Verifie le timer du heros et applique la regle des 5 tours.
 */
function checkHeroTimer(combatState, now) {
  if (!combatState.timerState || !combatState.activeEntityId) return combatState;
  const activeEntity = combatState.entities?.find(
    (e) => e.id === combatState.activeEntityId
  );
  if (!activeEntity || activeEntity.type !== "hero") return combatState;

  const turnStartTime = combatState.timerState.turnStartedAt || combatState.lastUpdateAt;
  const elapsed = now - turnStartTime;
  if (elapsed >= TURN_DURATION_MS) {
    combatState.consecutiveHeroTimeouts = (combatState.consecutiveHeroTimeouts || 0) + 1;
    if (combatState.consecutiveHeroTimeouts >= 5) {
      combatState.status = "lost";
      combatState.gameEnded = true;
    }
  }
  return combatState;
}

// =========================================
// POST /api/combat/start
// =========================================
export async function startHandler(req, res) {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ error: "Combat backend not configured" });

  try {
    const solanaAddress = await resolveSolanaAddress(req, res, supabase);
    if (!solanaAddress) return;

    const { combatType, zoneX, zoneY, npcName, dungeonInfo } = req.body || {};

    const { data: existingSave, error: fetchError } = await supabase
      .from("player_saves")
      .select("save_data")
      .eq("solana_address", solanaAddress)
      .single();

    if (fetchError && fetchError.code !== "PGRST116") {
      if (
        fetchError.code === "42501" ||
        fetchError.message?.includes("permission") ||
        fetchError.message?.includes("RLS")
      ) {
        // permissions : on continue avec saveData = {} (creation)
      } else {
        return res.status(500).json({
          error: "Database error",
          details: fetchError.message,
          code: fetchError.code,
        });
      }
    }

    const saveData = existingSave?.save_data || {};
    const activeCombat = saveData.activeCombat || null;

    // Reprise d'un combat en cours
    if (
      activeCombat &&
      (activeCombat.status === "in_progress" ||
        (activeCombat.entities?.length > 0 && !activeCombat.gameEnded))
    ) {
      return res.status(200).json({ combatState: activeCombat, resumed: true });
    }

    // Nouveau combat (squelette ; le vrai etat arrive via /action)
    const newCombatState = {
      status: "in_progress",
      combatType: combatType || "wild",
      zoneInfo: zoneX !== undefined && zoneY !== undefined ? { x: zoneX, y: zoneY } : null,
      npcName: npcName || null,
      dungeonInfo: dungeonInfo || null,
      createdAt: Date.now(),
      lastUpdateAt: Date.now(),
      consecutiveHeroTimeouts: 0,
    };

    saveData.activeCombat = newCombatState;
    const { error: updateError } = await supabase
      .from("player_saves")
      .upsert(
        { solana_address: solanaAddress, save_data: saveData },
        { onConflict: "solana_address" }
      );

    if (updateError) {
      return res.status(500).json({
        error: "Failed to save combat state",
        details: updateError.message,
        code: updateError.code,
      });
    }

    return res.status(200).json({ combatState: newCombatState, resumed: false });
  } catch (error) {
    console.error("[combat/start] erreur:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// =========================================
// POST /api/combat/action
// =========================================
export async function actionHandler(req, res) {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ error: "Combat backend not configured" });

  try {
    const solanaAddress = await resolveSolanaAddress(req, res, supabase);
    if (!solanaAddress) return;

    const { action, combatState: clientCombatState, shadowCasts, shadowAITurns } = req.body || {};
    if (!clientCombatState) {
      return res.status(400).json({ error: "combatState is required" });
    }

    // SHADOW (2b.3 S2) : rejeu + comparaison du moteur autoritatif. 100% passif
    // (log seul, ne touche ni la réponse ni le stockage). Jamais bloquant.
    try {
      runShadowComparison(shadowCasts, { addr: solanaAddress, action });
    } catch (e) {
      console.warn("[shadow] comparaison ignorée:", e && e.message);
    }

    // SHADOW IA (2b.4) : rejeu du driver planEnemyTurn + COMPARAISON à la séquence
    // d'actions réelle de chaque tour ennemi. 100% passif (log seul). Jamais bloquant.
    try {
      runShadowAIComparison(shadowAITurns, { addr: solanaAddress, action });
    } catch (e) {
      console.warn("[shadow-ai] comparaison ignorée:", e && e.message);
    }

    // SHADOW DE RÉSOLUTION (Palier C — C1b) : rejeu de resolveEnemyTurn(before) +
    // comparaison STRUCTURELLE à l'état après réel (débusque les trous de résolution
    // serveur — confusion, cost_hp_percent, chaînage — avant le flip C). Passif, log seul.
    try {
      runEnemyTurnResolutionShadow(shadowAITurns, { addr: solanaAddress, action });
    } catch (e) {
      console.warn("[shadow-res] comparaison ignorée:", e && e.message);
    }

    const { data: existingSave, error: fetchError } = await supabase
      .from("player_saves")
      .select("save_data")
      .eq("solana_address", solanaAddress)
      .single();

    if (fetchError) {
      if (fetchError.code === "PGRST116") {
        // pas de save : creer le combat depuis l'etat client
        const newCombatState = {
          ...clientCombatState,
          status: "in_progress",
          createdAt: Date.now(),
          lastUpdateAt: Date.now(),
        };
        const { error: createError } = await supabase
          .from("player_saves")
          .upsert(
            { solana_address: solanaAddress, save_data: { activeCombat: newCombatState } },
            { onConflict: "solana_address" }
          );
        if (createError) return res.status(500).json({ error: "Failed to create save" });
        return res.status(200).json({ combatState: newCombatState, actionResult: "success" });
      }
      return res.status(500).json({ error: "Failed to fetch combat state" });
    }

    let serverCombatState = existingSave?.save_data?.activeCombat;
    const hasServerCombat =
      serverCombatState &&
      (serverCombatState.status === "in_progress" ||
        (serverCombatState.entities?.length > 0 && !serverCombatState.gameEnded));

    if (!hasServerCombat) {
      const newCombatState = {
        ...clientCombatState,
        status: "in_progress",
        createdAt: Date.now(),
        lastUpdateAt: Date.now(),
      };
      const saveData = existingSave?.save_data || {};
      saveData.activeCombat = newCombatState;
      const { error: updateError } = await supabase
        .from("player_saves")
        .upsert(
          { solana_address: solanaAddress, save_data: saveData },
          { onConflict: "solana_address" }
        );
      if (updateError) return res.status(500).json({ error: "Failed to save combat state" });
      return res.status(200).json({ combatState: newCombatState, actionResult: "success" });
    }

    const now = Date.now();
    serverCombatState = fastForwardCombat(serverCombatState, now);
    serverCombatState = checkHeroTimer(serverCombatState, now);

    // Combat termine (perdu) pendant l'absence
    if (serverCombatState.status === "lost" || serverCombatState.gameEnded) {
      const saveData = existingSave?.save_data || {};
      delete saveData.activeCombat;
      await supabase
        .from("player_saves")
        .upsert(
          { solana_address: solanaAddress, save_data: saveData },
          { onConflict: "solana_address" }
        );
      return res.status(200).json({ combatState: serverCombatState, actionResult: "combat_lost" });
    }

    // Verifier le timer du heros/allie avant d'accepter l'action (sauf endTurn)
    const activeEntity = serverCombatState.entities?.find(
      (e) => e.id === serverCombatState.activeEntityId
    );
    if (activeEntity && (activeEntity.type === "hero" || activeEntity.type === "ally")) {
      const turnStartTime =
        serverCombatState.timerState?.turnStartedAt || serverCombatState.lastUpdateAt;
      if (now - turnStartTime >= TURN_DURATION_MS && action !== "endTurn") {
        return res.status(400).json({
          error: "Turn time expired",
          combatState: serverCombatState,
          actionResult: "turn_expired",
        });
      }
    }

    // On accepte l'etat client (modele confiance-client, inchange) + maj timestamps/timer
    const maxTime =
      clientCombatState.timerState?.maxTime || serverCombatState.timerState?.maxTime || 20;
    const updatedCombatState = {
      ...clientCombatState,
      lastUpdateAt: now,
      timerState: {
        ...clientCombatState.timerState,
        maxTime: maxTime,
        turnStartedAt:
          action === "endTurn" ? now : serverCombatState.timerState?.turnStartedAt || now,
        remaining:
          action === "endTurn" ? maxTime : clientCombatState.timerState?.remaining ?? maxTime,
      },
    };

    // ANTI-TRICHE : consecutiveHeroTimeouts = max(server, client)
    const serverHeroTimeouts = serverCombatState.consecutiveHeroTimeouts || 0;
    const clientHeroTimeouts = clientCombatState.consecutiveHeroTimeouts || 0;
    updatedCombatState.consecutiveHeroTimeouts = Math.max(serverHeroTimeouts, clientHeroTimeouts);

    if (action === "endTurn" && updatedCombatState.activeEntityId) {
      const activeEntityEndTurn = updatedCombatState.entities?.find(
        (e) => e.id === updatedCombatState.activeEntityId
      );
      if (activeEntityEndTurn && activeEntityEndTurn.type === "hero") {
        const heroTurnStart =
          serverCombatState.timerState?.turnStartedAt || serverCombatState.lastUpdateAt;
        const wasTimeout = now - heroTurnStart >= TURN_DURATION_MS;
        updatedCombatState.consecutiveHeroTimeouts = wasTimeout
          ? Math.max(serverHeroTimeouts + 1, clientHeroTimeouts)
          : 0;
      }
    }

    const saveData = existingSave?.save_data || {};
    saveData.activeCombat = updatedCombatState;
    const { error: updateError } = await supabase
      .from("player_saves")
      .upsert(
        { solana_address: solanaAddress, save_data: saveData },
        { onConflict: "solana_address" }
      );
    if (updateError) return res.status(500).json({ error: "Failed to update combat state" });

    return res.status(200).json({ combatState: updatedCombatState, actionResult: "success" });
  } catch (error) {
    console.error("[combat/action] erreur:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// =========================================
// GET /api/combat/current
// =========================================
export async function currentHandler(req, res) {
  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ error: "Combat backend not configured" });

  try {
    const solanaAddress = await resolveSolanaAddress(req, res, supabase);
    if (!solanaAddress) return;

    const { data: existingSave, error: fetchError } = await supabase
      .from("player_saves")
      .select("save_data")
      .eq("solana_address", solanaAddress)
      .single();

    if (fetchError) {
      if (fetchError.code === "PGRST116") return res.status(200).json({ combatState: null });
      return res.status(500).json({ error: "Database error" });
    }

    let activeCombat = existingSave?.save_data?.activeCombat || null;

    const hasValidStatus = activeCombat?.status === "in_progress";
    const hasEntities = activeCombat?.entities?.length > 0;
    const isNotEnded = !activeCombat?.gameEnded;
    if (!activeCombat || (!hasValidStatus && !hasEntities) || !isNotEnded) {
      return res.status(200).json({ combatState: null });
    }
    if (!activeCombat.status) activeCombat.status = "in_progress";

    const now = Date.now();
    const MAX_COMBAT_AGE = 4 * 60 * 60 * 1000; // 4 h (aligne avec COMBAT_RESUME_MAX_AGE_MS client)
    if (now - activeCombat.lastUpdateAt > MAX_COMBAT_AGE) {
      const saveData = existingSave.save_data;
      delete saveData.activeCombat;
      await supabase
        .from("player_saves")
        .upsert(
          { solana_address: solanaAddress, save_data: saveData },
          { onConflict: "solana_address" }
        );
      return res.status(200).json({ combatState: null });
    }

    // Sauvegarder l'etat initial (replay reconnexion) s'il manque
    if (!activeCombat.initialState) {
      activeCombat.initialState = JSON.parse(JSON.stringify(activeCombat));
      activeCombat.disconnectedAt = activeCombat.lastUpdateAt;
      const saveData = existingSave.save_data;
      saveData.activeCombat = activeCombat;
      await supabase
        .from("player_saves")
        .upsert(
          { solana_address: solanaAddress, save_data: saveData },
          { onConflict: "solana_address" }
        );
    }

    const snapshotTime =
      activeCombat.snapshotAt || activeCombat.disconnectedAt || activeCombat.lastUpdateAt;
    const elapsedTime = now - snapshotTime;

    return res.status(200).json({
      combatState: activeCombat,
      elapsedTime: elapsedTime,
      snapshot: activeCombat.snapshot || null,
    });
  } catch (error) {
    console.error("[combat/current] erreur:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// =========================================
// POST /api/combat/enemy-turn  (Palier C — C2)
// =========================================
// Le SERVEUR joue+résout un tour d'ennemi PVM et renvoie la liste des STEPS
// ({action, events?, newState?}) que le client anime/applique (le serveur tire les
// dés, le client affiche — D3). Entrée : { before, casterId, isBoss }.
//
// ⚠️ ÉTAPE C : `before` est fourni par le CLIENT (comme le shadow) → l'autorité
// anti-triche complète (le serveur résout depuis SON état stocké) viendra au Palier B
// (persistance serveur). Ici la STRUCTURE (le serveur joue le tour ennemi) est posée ;
// le shadow-ai a déjà prouvé que cette résolution = celle du client.
//
// Graine RNG DÉTERMINISTE dérivée de l'état (mêmes entrées → mêmes dés → idempotent
// sur retry), non transmise (le client n'en a pas besoin en approche « vue pure »).
export async function enemyTurnHandler(req, res) {
  try {
    const { before, casterId, isBoss } = req.body || {};
    if (!before || !Array.isArray(before.entities) || casterId == null) {
      return res.status(400).json({ error: "before (with entities) and casterId are required" });
    }

    // Graine déterministe : positions/hp des entités + casterId + tour (si présent).
    const stateKey = (before.entities || [])
      .map((e) => `${e.x},${e.y},${e.hp},${e.dead ? 1 : 0}`)
      .join("|");
    const seed = hashSeed(`${casterId}:${before.turnCount || 0}:${stateKey}`);
    const rng = createRng(seed);

    const result = resolveEnemyTurn(before, { casterId, isBoss: !!isBoss }, rng);
    return res.status(200).json({
      steps: result.steps,
      suffixUncertain: result.suffixUncertain,
      notes: result.notes,
    });
  } catch (error) {
    console.error("[combat/enemy-turn] erreur:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

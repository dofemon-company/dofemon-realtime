// =============================================================
// DOFEMON - Serveur de presence temps reel (Colyseus)
// =============================================================
// Positions des joueurs gardees en RAM (ephemere, aucune base).
// tools.listen() monte express + CORS + les routes /matchmake + l'arret
// propre. On passe l'objet de config directement : le helper config()
// de @colyseus/tools n'est qu'un typage TS et casse en ESM pur.
// =============================================================

import tools from "@colyseus/tools";
import { WorldRoom } from "./rooms/WorldRoom.js";

const PORT = Number(process.env.PORT) || 2567;

// Proxy RPC Solana (porte depuis Vercel api/solana-rpc.js).
// Round-robin sur des endpoints publics ; aucune cle requise.
const SOLANA_RPC_ENDPOINTS = [
  "https://api.mainnet-beta.solana.com",
  "https://rpc.ankr.com/solana",
  "https://solana.drpc.org",
];

// Lit le corps de la requete.
// @colyseus/tools monte deja un body-parser (express.json) qui CONSOMME le flux :
// dans ce cas req.body est deja parse et lire le flux brut bloquerait pour
// toujours (l'evenement "end" ne se redeclenche pas). On privilegie donc req.body,
// avec repli sur la lecture brute + timeout pour ne jamais rester bloque.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    const timer = setTimeout(() => reject(new Error("body read timeout")), 5000);
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        clearTimeout(timer);
        reject(new Error("payload too large"));
      }
    });
    req.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function getRpcBody(req) {
  // Corps deja parse par express.json (cas @colyseus/tools).
  if (req.body && typeof req.body === "object" && Object.keys(req.body).length) {
    return JSON.stringify(req.body);
  }
  if (typeof req.body === "string" && req.body.length) {
    return req.body;
  }
  // Aucun body-parser : lire le flux brut (avec timeout).
  return await readRawBody(req);
}

async function handleSolanaRpc(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  let body;
  try {
    body = await getRpcBody(req);
  } catch (e) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "Invalid body" }));
  }

  for (const rpcUrl of SOLANA_RPC_ENDPOINTS) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (!response.ok) continue;
      const data = await response.json();
      // Une erreur JSON-RPC est une reponse VALIDE d'un endpoint fonctionnel.
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 200;
      return res.end(JSON.stringify(data));
    } catch (e) {
      continue;
    }
  }

  res.statusCode = 500;
  return res.end(JSON.stringify({ error: "All RPC endpoints failed" }));
}

tools.listen(
  {
    initializeGameServer: (gameServer) => {
      // Une room "world" = 100 joueurs max ; Colyseus en ouvre une nouvelle
      // automatiquement au-dela (via joinOrCreate cote client).
      gameServer.define("world", WorldRoom);
    },

    initializeExpress: (app) => {
      // Healthcheck pour Coolify.
      app.get("/health", (req, res) => {
        res.json({ status: "ok", uptime: process.uptime() });
      });

      // Proxy RPC Solana (remplace Vercel /api/solana-rpc).
      app.post("/api/solana-rpc", handleSolanaRpc);
      app.options("/api/solana-rpc", handleSolanaRpc);
    },
  },
  PORT
);

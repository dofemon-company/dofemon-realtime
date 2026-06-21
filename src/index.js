// =============================================================
// DOFEMON - Serveur de presence temps reel (Colyseus)
// =============================================================
// Un seul process Node. Garde les positions des joueurs en RAM
// (ephemere : rien en base). Si ca redemarre, on perd juste les
// positions affichees, les vraies donnees restent sur Supabase.
// =============================================================

import http from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { WorldRoom } from "./rooms/WorldRoom.js";

const PORT = Number(process.env.PORT) || 2567;

// Petit serveur HTTP : healthcheck pour Coolify + support du WebSocket.
const httpServer = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

// Une room = un "monde" de 100 joueurs max. Quand elle est pleine,
// Colyseus en ouvre automatiquement une nouvelle (via joinOrCreate cote client).
gameServer.define("world", WorldRoom);

gameServer
  .listen(PORT)
  .then(() => console.log(`[presence] Colyseus en ecoute sur :${PORT}`))
  .catch((err) => {
    console.error("[presence] echec demarrage:", err);
    process.exit(1);
  });

// Arret propre (Coolify envoie SIGTERM lors d'un redeploiement).
const shutdown = () => {
  console.log("[presence] arret...");
  gameServer.gracefullyShutdown().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

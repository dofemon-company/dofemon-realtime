// Configuration Colyseus via @colyseus/tools : ce wrapper officiel monte
// express + CORS + les routes de matchmaking (/matchmake/...) + l'arret propre.
// C'est indispensable pour qu'un client navigateur cross-origin
// (game.dofemon.com -> play.dofemon.com) puisse rejoindre une room.

import config from "@colyseus/tools";
import { WorldRoom } from "./rooms/WorldRoom.js";

export default config({
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
  },
});

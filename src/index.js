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
    },
  },
  PORT
);

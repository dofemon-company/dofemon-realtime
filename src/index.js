// =============================================================
// DOFEMON - Serveur de presence temps reel (Colyseus)
// =============================================================
// Positions des joueurs gardees en RAM (ephemere, aucune base).
// @colyseus/tools gere express + CORS + matchmaking + /health + arret propre.
// =============================================================

import { listen } from "@colyseus/tools";
import appConfig from "./app.config.js";

const PORT = Number(process.env.PORT) || 2567;

// Demarre le serveur (HTTP matchmaking + WebSocket) sur le port fourni par Coolify.
listen(appConfig, PORT);

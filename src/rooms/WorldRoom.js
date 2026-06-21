// Room "world" : jusqu'a 100 joueurs. Pas de tick lourd : on se repose
// sur la synchro d'etat Colyseus (envoi des deltas a ~20 fps par defaut).
// Le filtrage par zone (ne voir que les joueurs de sa zone) est fait
// cote CLIENT, ce qui est suffisant et simple pour <= 100 joueurs/room.

import { Room } from "@colyseus/core";
import { WorldState, Player } from "../schema/WorldState.js";

export class WorldRoom extends Room {
  maxClients = 100;

  onCreate() {
    this.setState(new WorldState());

    // Mise a jour de position envoyee par un client.
    this.onMessage("move", (client, data = {}) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof data.x === "number") p.x = data.x;
      if (typeof data.y === "number") p.y = data.y;
      if (typeof data.zoneX === "number") p.zoneX = data.zoneX;
      if (typeof data.zoneY === "number") p.zoneY = data.zoneY;
      if (typeof data.facing === "string") p.facing = data.facing;
    });

    console.log(`[world] room creee ${this.roomId}`);
  }

  onJoin(client, options = {}) {
    const p = new Player();
    p.address = String(options.address || "");
    p.username = String(options.username || "hero");
    p.x = Number(options.x) || 0;
    p.y = Number(options.y) || 0;
    p.zoneX = Number(options.zoneX) || 0;
    p.zoneY = Number(options.zoneY) || 0;
    p.facing = options.facing === "left" ? "left" : "right";
    p.imageIdle = String(options.imageIdle || "");
    p.imageWalk1 = String(options.imageWalk1 || "");
    p.imageWalk2 = String(options.imageWalk2 || "");
    p.icon = String(options.icon || "\u{1F9DD}");
    this.state.players.set(client.sessionId, p);
    console.log(
      `[world] +${p.username} (${this.clients.length}/${this.maxClients}) room ${this.roomId}`
    );
  }

  onLeave(client) {
    this.state.players.delete(client.sessionId);
    console.log(`[world] -${client.sessionId} (${this.clients.length}/${this.maxClients})`);
  }
}

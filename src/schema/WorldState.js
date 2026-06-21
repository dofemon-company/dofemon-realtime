// Etat synchronise d'une room. Colyseus diffuse automatiquement les
// deltas (seuls les champs modifies partent sur le reseau).
// On utilise defineTypes (et pas les decorateurs) car on est en JS pur,
// sans TypeScript ni transpilation.

import { Schema, MapSchema, defineTypes } from "@colyseus/schema";

export class Player extends Schema {
  constructor() {
    super();
    this.x = 0; // position grille (0-9) dans la zone
    this.y = 0;
    this.zoneX = 0; // coordonnees de zone (-8..7)
    this.zoneY = 0;
    this.facing = "right"; // 'left' | 'right'
    this.username = "hero";
    this.address = ""; // adresse wallet = identifiant unique
    this.imageIdle = "";
    this.imageWalk1 = "";
    this.imageWalk2 = "";
    this.icon = "\u{1F9DD}"; // fallback emoji
  }
}
defineTypes(Player, {
  x: "number",
  y: "number",
  zoneX: "number",
  zoneY: "number",
  facing: "string",
  username: "string",
  address: "string",
  imageIdle: "string",
  imageWalk1: "string",
  imageWalk2: "string",
  icon: "string",
});

export class WorldState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema(); // clef = sessionId Colyseus
  }
}
defineTypes(WorldState, {
  players: { map: Player },
});

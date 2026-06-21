# dofemon-realtime

Serveur de **présence temps réel** pour DOFEMON (Colyseus / WebSocket).
Permet de voir les autres joueurs se déplacer dans l'open-world.

- État des joueurs gardé **en RAM** (éphémère, aucune base de données).
- Une room `world` = **100 joueurs max** ; une nouvelle s'ouvre automatiquement au-delà.
- Déployé sur un VPS via **Coolify**, exposé en `wss://play.dofemon.com`.

## Lancer en local

```bash
npm install
npm start
# Serveur sur ws://localhost:2567  (healthcheck: http://localhost:2567/health)
```

## Variables d'environnement

| Var | Défaut | Rôle |
|-----|--------|------|
| `PORT` | `2567` | Port d'écoute (Coolify le fournit en prod) |

## Structure

```
src/
  index.js              # Démarrage serveur + healthcheck /health
  rooms/WorldRoom.js    # Room "world" (maxClients 100), messages "move"
  schema/WorldState.js  # État synchronisé : MapSchema<Player>
```

## Protocole

- **join** (client → serveur, options) : `{ address, username, x, y, zoneX, zoneY, facing, imageIdle, imageWalk1, imageWalk2, icon }`
- **move** (client → serveur) : `{ x, y, zoneX, zoneY, facing }` (throttlé ~150-200 ms)
- **state** (serveur → clients) : `MapSchema` des joueurs (deltas automatiques Colyseus)

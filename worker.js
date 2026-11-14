
import { DurableObject } from "cloudflare:workers";

const initialGame = () => ({
  round: 1,
  status: "waiting",
  players: {},
  tickets: {},
  drawnNumbers: []
});

export class MyDurableObject extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);

    let game = await this.ctx.storage.get("game");

    if (!game) {
      game = initialGame();
      await this.ctx.storage.put("game", game);
    }

    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({
        success: true,
        message: "FUADX KENO Multiplayer Server",
        game
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        success: true,
        status: "online"
      });
    }

    if (request.method === "POST" && url.pathname === "/join") {
      const body = await request.json();
      const name = String(body.name || "").trim();

      if (!name) {
        return Response.json(
          { error: "Player name required" },
          { status: 400 }
        );
      }

      const playerId = crypto.randomUUID();

      game.players[playerId] = {
        id: playerId,
        name,
        joinedAt: Date.now()
      };

      await this.ctx.storage.put("game", game);

      return Response.json({
        success: true,
        player: game.players[playerId]
      });
    }

    if (request.method === "POST" && url.pathname === "/reset") {
      game = initialGame();
      await this.ctx.storage.put("game", game);

      return Response.json({
        success: true,
        game
      });
    }

    return Response.json(
      { error: "Not found" },
      { status: 404 }
    );
  }
}

export default {
  async fetch(request, env) {
    if (!env.MY_DURABLE_OBJECT) {
      return new Response(
        "Durable Object binding MY_DURABLE_OBJECT is missing.",
        { status: 500 }
      );
    }

    const id = env.MY_DURABLE_OBJECT.idFromName(
      "fuadx-keno-game"
    );

    const stub = env.MY_DURABLE_OBJECT.get(id);

    return stub.fetch(request);
  }
};


import { DurableObject } from "cloudflare:workers";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json"
    }
  });
}

const initialGame = () => ({
  round: 1,
  status: "waiting",
  players: {},
  tickets: {},
  drawnNumbers: [],
  selectionEndsAt: null
});

const rewards = {
  3:{3:120,2:60,1:2},
  4:{4:240,3:60,2:30,1:2},
  5:{5:300,4:120,3:60,2:20,1:0},
  6:{6:600,5:400,4:200,3:100,2:0,1:0},
  7:{7:900,6:500,5:200,4:60,3:2,2:0,1:0},
  8:{8:1200,7:900,6:600,5:300,4:60,3:2,2:0,1:0},
  9:{9:1500,8:1000,7:600,6:300,5:100,4:2,3:0,2:0,1:0},
  10:{10:2000,9:1500,8:1000,7:700,6:400,5:100,4:2,3:0,2:0,1:0}
};

export class MyDurableObject extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    let game = await this.ctx.storage.get("game");

    if (!game) {
      game = initialGame();
      await this.ctx.storage.put("game", game);
    }

    if (request.method === "GET" &&
        (url.pathname === "/" || url.pathname === "/state")) {
      return reply({ success: true, game });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return reply({ success: true, status: "online" });
    }

    let body = {};

    if (request.method === "POST") {
      try {
        body = await request.json();
      } catch {
        return reply({ error: "Invalid JSON" }, 400);
      }
    }

    if (request.method === "POST" && url.pathname === "/join") {
      const name = String(body.name || "").trim();

      if (!name || name.length > 30) {
        return reply({ error: "Valid player name required" }, 400);
      }

      const playerId = crypto.randomUUID();

      game.players[playerId] = {
        id: playerId,
        name,
        coins: 100,
        joinedAt: Date.now()
      };

      await this.ctx.storage.put("game", game);

      return reply({
        success: true,
        player: game.players[playerId],
        game
      });
    }

    if (request.method === "POST" && url.pathname === "/start") {
      if (game.status === "select" || game.status === "draw") {
        return reply({ error: "Game already running" }, 409);
      }

      if (Object.keys(game.players).length === 0) {
        return reply({ error: "No players joined" }, 400);
      }

      if (game.status === "finished") {
        game.round++;
      }

      game.status = "select";
      game.tickets = {};
      game.drawnNumbers = [];
      game.selectionEndsAt = Date.now() + 60000;

      await this.ctx.storage.put("game", game);

      return reply({ success: true, game });
    }

    if (request.method === "POST" && url.pathname === "/ticket") {
      const player = game.players[body.playerId];

      if (!player) {
        return reply({ error: "Player not found" }, 404);
      }

      if (game.status !== "select" ||
          Date.now() > game.selectionEndsAt) {
        return reply({ error: "Selection time ended" }, 409);
      }

      const numbers = body.numbers;
      const price = Number(body.price);

      if (!Array.isArray(numbers) ||
          numbers.length < 3 ||
          numbers.length > 10 ||
          new Set(numbers).size !== numbers.length ||
          numbers.some(n => !Number.isInteger(n) || n < 1 || n > 80)) {
        return reply({ error: "Choose 3 to 10 unique numbers" }, 400);
      }

      if (![2, 4, 8, 10, 20].includes(price)) {
        return reply({ error: "Invalid ticket price" }, 400);
      }

      const playerTickets = Object.values(game.tickets)
        .filter(t => t.playerId === body.playerId);

      if (playerTickets.length >= 10) {
        return reply({ error: "Ticket limit reached" }, 400);
      }

      if (player.coins < price) {
        return reply({ error: "Not enough COIN" }, 400);
      }

      player.coins -= price;

      const ticketId = crypto.randomUUID();

      game.tickets[ticketId] = {
        id: ticketId,
        playerId: body.playerId,
        name: player.name,
        numbers,
        price,
        matches: 0,
        reward: 0
      };

      await this.ctx.storage.put("game", game);

      return reply({
        success: true,
        ticket: game.tickets[ticketId],
        player,
        game
      });
    }

    if (request.method === "POST" && url.pathname === "/draw") {
      if (game.status !== "select") {
        return reply({ error: "Game is not ready for drawing" }, 409);
      }

      if (Date.now() < game.selectionEndsAt) {
        return reply({ error: "Selection time is not finished" }, 409);
      }

      const pool = Array.from({ length: 80 }, (_, i) => i + 1);

      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }

      game.drawnNumbers = pool.slice(0, 20);
      game.status = "finished";

      let totalReward = 0;

      for (const ticket of Object.values(game.tickets)) {
        ticket.matches = ticket.numbers.filter(
          n => game.drawnNumbers.includes(n)
        ).length;

        ticket.reward =
          rewards[ticket.numbers.length][ticket.matches] || 0;

        const player = game.players[ticket.playerId];

        if (player) {
          player.coins += ticket.reward;
        }

        totalReward += ticket.reward;
      }

      await this.ctx.storage.put("game", game);

      return reply({
        success: true,
        game,
        totalReward
      });
    }

    return reply({ error: "Not found" }, 404);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (!env.MY_DURABLE_OBJECT) {
      return reply({ error: "Durable Object binding missing" }, 500);
    }

    const id = env.MY_DURABLE_OBJECT.idFromName(
      "fuadx-keno-game"
    );

    const stub = env.MY_DURABLE_OBJECT.get(id);

    return stub.fetch(request);
  }
};
          

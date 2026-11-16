import { DurableObject } from "cloudflare:workers";

const PRICES = [2, 4, 8, 10, 20];

// ሽልማት = የቲኬት ዋጋ × ብዜት
const REWARDS = {
  1: {1:3},
  2: {2:7},
  3: {2:2, 3:20},
  4: {2:1, 3:5, 4:30},
  5: {3:2, 4:10, 5:40},
  6: {3:1, 4:5, 5:15, 6:45},
  7: {4:1, 5:4, 6:15, 7:50},
  8: {4:2, 5:5, 6:20, 7:30, 8:55},
  9: {5:3, 6:10, 7:35, 8:45, 9:65},
  10: {5:2, 6:7, 7:40, 8:60, 9:80, 10:100}
};

function initialGame() {
  return {
    round: 1,
    status: "waiting",
    players: {},
    tickets: [],
    drawnNumbers: [],
    selectionEndsAt: null,
    coinRequests: []
  };
}

function reply(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key"
    }
  });
}

export class MyDurableObject extends DurableObject {
  
async getGame() {
  let game = await this.ctx.storage.get("game");

  if (!game) {
    game = initialGame();
    await this.ctx.storage.put("game", game);
    return game;
  }

  // የቀድሞ የጨዋታ ውሂብን ሳይሰርዝ ማዘመን
  if (!Array.isArray(game.coinRequests)) {
    game.coinRequests = [];
    await this.ctx.storage.put("game", game);
  }

  return game;
}

  async save(game) {
  await this.ctx.storage.put("game", game);
}
 
  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method;

    if (method === "OPTIONS") {
      return reply({ success: true });
    }

    const game = await this.getGame();

    if (
      method === "GET" &&
      (url.pathname === "/" || url.pathname === "/state")
    ) {
      return reply({ success: true, game });
    }

    if (method === "GET" && url.pathname === "/health") {
      return reply({ success: true, status: "online" });
    }

    // ተጫዋች መቀላቀል
    if (method === "POST" && url.pathname === "/join") {
      const body = await request.json();
      const name = String(body.name || "").trim();
      let playerId = String(body.playerId || "");

      if (!name) {
        return reply({ error: "Player name required" }, 400);
      }

      if (playerId && game.players[playerId]) {
        game.players[playerId].name = name;
      } else {
        playerId = crypto.randomUUID();

        game.players[playerId] = {
          id: playerId,
          name,
          coins: 0,
          joinedAt: Date.now()
        };
      }

      await this.save(game);

      return reply({
        success: true,
        player: game.players[playerId]
      });
    }

    // የመጀመሪያውን ዙር Admin ያስጀምራል
    if (method === "POST" && url.pathname === "/start") {
      if (game.status === "select" || game.status === "draw") {
        return reply({ error: "Game already running" }, 409);
      }

      if (game.status === "finished") {
        game.round += 1;
      }

      game.status = "select";
      game.tickets = [];
      game.drawnNumbers = [];
      game.selectionEndsAt = Date.now() + 60000;

      await this.save(game);
      await this.ctx.storage.setAlarm(game.selectionEndsAt);

      return reply({ success: true, game });
    }

    // ቲኬት መግዛት
    if (method === "POST" && url.pathname === "/ticket") {
      const body = await request.json();
      const playerId = String(body.playerId || "");
      const numbers = body.numbers;
      const price = Number(body.price);
      const player = game.players[playerId];

      if (!player) {
        return reply({ error: "Player not found" }, 404);
      }

      if (game.status !== "select") {
        return reply({ error: "Ticket selection is closed" }, 400);
      }

      if (!PRICES.includes(price)) {
        return reply({ error: "Invalid ticket price" }, 400);
      }

      if (
        !Array.isArray(numbers) ||
        numbers.length < 1 ||
        numbers.length > 10 ||
        new Set(numbers).size !== numbers.length ||
        numbers.some(n => !Number.isInteger(n) || n < 1 || n > 80)
      ) {
        return reply({
          error: "Choose 1 to 10 different numbers from 1 to 80"
        }, 400);
      }

      const playerTickets = game.tickets.filter(
        t => t.playerId === playerId
      );

      if (playerTickets.length >= 10) {
        return reply({ error: "Maximum 10 tickets per round" }, 400);
      }

      if (player.coins < price) {
        return reply({ error: "Not enough COIN" }, 400);
      }

      player.coins -= price;

      game.tickets.push({
        id: crypto.randomUUID(),
        playerId,
        name: player.name,
        numbers,
        price,
        matches: 0,
        reward: 0
      });

      await this.save(game);

      return reply({
        success: true,
        coins: player.coins,
        game
      });
    }

    // COIN መጠየቅ
    if (method === "POST" && url.pathname === "/coin-request") {
      const body = await request.json();
      const playerId = String(body.playerId || "");
      const player = game.players[playerId];

      if (!player) {
        return reply({ error: "Player not found" }, 404);
      }

      if (player.coins > 0) {
        return reply({ error: "You still have COIN" }, 400);
      }

      const pending = game.coinRequests.find(
        r => r.playerId === playerId && r.status === "pending"
      );

      if (pending) {
        return reply({
          success: true,
          message: "Request already sent"
        });
      }

      game.coinRequests.push({
        id: crypto.randomUUID(),
        playerId,
        name: player.name,
        status: "pending",
        createdAt: Date.now()
      });

      await this.save(game);

      return reply({
        success: true,
        message: "COIN request sent"
      });
    }

    // Admin: የCOIN ጥያቄዎች
    if (method === "GET" && url.pathname === "/admin/requests") {
      return reply({
        success: true,
        requests: game.coinRequests
      });
    }

    // Admin: የፈለገውን COIN መስጠት
    if (method === "POST" && url.pathname === "/admin/give-coins") {
      const body = await request.json();
      const requestId = String(body.requestId || "");
      const amount = Number(body.amount);

      if (!Number.isInteger(amount) || amount < 1 || amount > 10000) {
        return reply({ error: "Invalid COIN amount" }, 400);
      }

      const coinRequest = game.coinRequests.find(
        r => r.id === requestId && r.status === "pending"
      );

      if (!coinRequest) {
        return reply({ error: "Request not found" }, 404);
      }

      const player = game.players[coinRequest.playerId];

      if (!player) {
        return reply({ error: "Player not found" }, 404);
      }

      player.coins += amount;
      player.coinNotice = {
        id: crypto.randomUUID(),
        amount,
        createdAt: Date.now()
      };

      coinRequest.status = "approved";
      coinRequest.amount = amount;
      coinRequest.approvedAt = Date.now();

      await this.save(game);

      return reply({
        success: true,
        player,
        message: "COIN added successfully"
      });
    }

    // Admin: ጨዋታውን ዳግም ማቆም
    if (method === "POST" && url.pathname === "/reset") {
      game.status = "waiting";
      game.tickets = [];
      game.drawnNumbers = [];
      game.selectionEndsAt = null;

      await this.save(game);
      await this.ctx.storage.deleteAlarm();

      return reply({ success: true, game });
    }

    return reply({ error: "Not found" }, 404);
  }

  async alarm() {
    const game = await this.getGame();

    // የምርጫ ጊዜ ሲያበቃ ዕጣ ማውጣት ይጀምራል
    if (game.status === "select") {
      game.status = "draw";
      game.selectionEndsAt = null;

      await this.save(game);
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return;
    }

    // 20 ቁጥሮችን አንድ በአንድ ማውጣት
    if (game.status === "draw") {
      const remaining = [];

      for (let n = 1; n <= 80; n++) {
        if (!game.drawnNumbers.includes(n)) {
          remaining.push(n);
        }
      }

      if (remaining.length > 0) {
        const index = crypto.getRandomValues(
          new Uint32Array(1)
        )[0] % remaining.length;

        game.drawnNumbers.push(remaining[index]);
      }

      if (game.drawnNumbers.length >= 20) {
        for (const ticket of game.tickets) {
          ticket.matches = ticket.numbers.filter(
            n => game.drawnNumbers.includes(n)
          ).length;

          const multiplier =
            REWARDS[ticket.numbers.length]?.[ticket.matches] || 0;

          ticket.reward = ticket.price * multiplier;

          const player = game.players[ticket.playerId];

          if (player) {
            player.coins += ticket.reward;
          }
        }

        game.status = "finished";

        await this.save(game);

        // ውጤቱ ለ5 ሰከንድ ከታየ በኋላ ቀጣይ ዙር
        await this.ctx.storage.setAlarm(Date.now() + 5000);
        return;
      }

      await this.save(game);
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return;
    }

    // ቀጣይ ዙር በራሱ ይጀምራል
    if (game.status === "finished") {
      game.round += 1;
      game.status = "select";
      game.tickets = [];
      game.drawnNumbers = [];
      game.selectionEndsAt = Date.now() + 60000;

      await this.save(game);
      await this.ctx.storage.setAlarm(game.selectionEndsAt);
      return;
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    // እነዚህ መንገዶች Admin Key ይፈልጋሉ
    const adminRoutes = [
      "/start",
      "/reset",
      "/admin/requests",
      "/admin/give-coins"
    ];

    if (adminRoutes.includes(url.pathname)) {
      const suppliedKey = request.headers.get("X-Admin-Key");

      if (!env.ADMIN_KEY || suppliedKey !== env.ADMIN_KEY) {
        return Response.json(
          { error: "Admin access denied" },
          { status: 401, headers }
        );
      }
    }

    if (!env.MY_DURABLE_OBJECT) {
      return Response.json(
        { error: "Durable Object binding missing" },
        { status: 500, headers }
      );
    }

    const id = env.MY_DURABLE_OBJECT.idFromName("fuadx-keno-game");
    const stub = env.MY_DURABLE_OBJECT.get(id);

    return stub.fetch(request);
  }
};

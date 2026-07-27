//////////////////////////////////////////////////////////////////////////////
// Main Thread
//////////////////////////////////////////////////////////////////////////////

const play = async ({ url, logging, debug, playerId }) => {
  const canvas = document.createElement("canvas");
  canvas.style.width = "100%";
  canvas.style.touchAction = "none";
  document.body.appendChild(canvas);
  const offscreen = canvas.transferControlToOffscreen();

  const workerUrl = "./playjs-worker.js?url=" + window.encodeURIComponent(url);
  const worker = new Worker(workerUrl, { type: "module" });

  const touches = {};

  const toCanvasCoords = ({ clientX, clientY }) => {
    const rect = canvas.getBoundingClientRect();
    const cssX = clientX - rect.left;
    const cssY = clientY - rect.top;
    const x = cssX * (canvas.width / rect.width);
    const y = cssY * (canvas.height / rect.height);
    return { x, y };
  };

  window.addEventListener("pointerdown", (e) => {
    audioManager.resumeAudioContext();

    touches[e.pointerId] = {};
    worker.postMessage({
      type: "pointerdown",
      pointerId: e.pointerId,
      ...toCanvasCoords(e),
    });
  });

  window.addEventListener("pointermove", (e) => {
    if (touches[e.pointerId]) {
      worker.postMessage({
        type: "pointermove",
        pointerId: e.pointerId,
        ...toCanvasCoords(e),
      });
    }
  });

  const onpointerup = (e) => {
    if (touches[e.pointerId]) {
      delete touches[e.pointerId];
      worker.postMessage({
        type: "pointerup",
        pointerId: e.pointerId,
      });
    }
  };

  window.addEventListener("pointerup", onpointerup);
  window.addEventListener("pointercancel", onpointerup);

  worker.onmessage = (e) => {
    switch (e.data.type) {
      case "ready":
        const { screen } = e.data;
        const resize = () => {
          const windowWidth = window.visualViewport?.width ?? window.innerWidth;
          const windowHeight = window.visualViewport?.height ?? window.innerHeight;
          if (windowHeight / windowWidth < screen.height / screen.width) {
            canvas.style.width = (windowHeight / screen.height) * screen.width + "px";
          } else {
            canvas.style.width = "100%";
          }
        };
        window.addEventListener("resize", resize);
        resize();

        worker.postMessage(
          {
            type: "play",
            canvas: offscreen,
            logging,
            debug,
            playerId,
          },
          [offscreen],
        );
        break;
      case "loadAudio":
        audioManager.register(e.data);
        break;
      case "playAudio":
        audioManager.play(e.data);
        break;
      case "stopAudio":
        audioManager.stop(e.data);
        break;
    }
  };

  worker.onerror = (e) => {
    console.error("Error on worker", e);
  };
};

//////////////////////////////////////////////////////////////////////////////
// Worker Thread
//////////////////////////////////////////////////////////////////////////////

const register = ({ game, audios, font, image, key }) => {
  self.onmessage = (e) => {
    switch (e.data.type) {
      case "play":
        startLoop(e.data);
        break;
      case "pointerdown":
        touchManager.onPointerDown(e.data);
        break;
      case "pointermove":
        touchManager.onPointerMove(e.data);
        break;
      case "pointerup":
        touchManager.onPointerUp(e.data);
        break;
    }
  };

  const startLoop = async ({ canvas, logging, debug, playerId }) => {
    canvas.width = game.screen.width;
    canvas.height = game.screen.height;

    await loadAudio(audios);
    await loadFont(font);
    await loadImage(image);
    await server.init(key, logging, debug);

    const loop = (timestamp) => {
      tpsManager.tick(timestamp);

      touchManager.update();

      game.update();

      game.draw(canvas);

      requestAnimationFrame(loop);
    };

    game.onGameStart(playerId, debug);

    requestAnimationFrame(loop);
  };

  self.postMessage({ type: "ready", screen: game.screen });
};

//////////////////////////////////////////////////////////////////////////////
// TPS
//////////////////////////////////////////////////////////////////////////////

const tpsManager = {
  timestamps: new Array(60).fill(undefined),
  index: 0,

  tick(timestamp) {
    this.timestamps[this.index] = timestamp;
    this.index = (this.index + 1) % this.timestamps.length;
  },

  tps() {
    const t = this.timestamps[(this.index - 1 + this.timestamps.length) % this.timestamps.length];
    const s = this.timestamps[this.index];
    return s === undefined ? undefined : ((this.timestamps.length - 1) / (t - s)) * 1000;
  },
};

const tps = () => tpsManager.tps();

//////////////////////////////////////////////////////////////////////////////
// User Input
//////////////////////////////////////////////////////////////////////////////

function Touch(id, x, y) {
  this.id = id;
  this.x = x;
  this.y = y;
  this.ticks = 0;
  this.endedTicks = null;

  this.cloneWith = function ({ id, x, y, ticks, endedTicks } = {}) {
    const touch = new Touch(id ?? this.id, x ?? this.x, y ?? this.y);
    touch.ticks = ticks ?? this.ticks;
    touch.endedTicks = endedTicks ?? this.endedTicks;
    return touch;
  };

  this.shouldBeRemoved = function () {
    return !this.active() && this.ticks > this.endedTicks;
  };

  this.started = function () {
    return this.ticks <= 1;
  };

  this.ended = function () {
    return !this.active() && this.endedTicks === this.ticks - 1;
  };

  this.active = function () {
    return this.endedTicks === null;
  };
}

const touchManager = {
  touches: new Map(),

  onPointerDown({ pointerId, x, y }) {
    this.touches.set(pointerId, new Touch(pointerId, x, y));
  },

  onPointerMove({ pointerId, x, y }) {
    if (this.touches.has(pointerId)) {
      const touch = this.touches.get(pointerId);
      touch.x = x;
      touch.y = y;
    }
  },

  onPointerUp({ pointerId }) {
    if (this.touches.has(pointerId)) {
      const touch = this.touches.get(pointerId);
      touch.endedTicks = touch.ticks;
    }
  },

  update() {
    for (const [pointerId, touch] of this.touches) {
      if (touch.shouldBeRemoved()) {
        this.touches.delete(pointerId);
      } else {
        touch.ticks++;
      }
    }
  },
};

function TouchSimulation() {
  this.simulation = [];
  this.index = 0;

  this.wait = function (t) {
    for (let i = 0; i < t; i++) {
      if (this.simulation.length === 0) {
        this.simulation.push([]);
      } else {
        const lastTouches = this.simulation[this.simulation.length - 1];
        const touches = lastTouches
          .map((touch) => touch.cloneWith({ ticks: touch.ticks + 1 }))
          .filter((touch) => !touch.shouldBeRemoved());
        this.simulation.push(touches);
      }
    }
    return this;
  };

  this.touch = function () {
    this.simulation.push([new Touch(0, 0, 0)]);
    return this;
  };

  this.release = function () {
    const lastTouches = this.simulation[this.simulation.length - 1];
    const touches = lastTouches.map((touch) =>
      touch.cloneWith({ ticks: touch.ticks + 1, endedTicks: touch.ticks + 1 }),
    );
    this.simulation.push(touches);
    return this;
  };

  this.next = function () {
    const touches = this.simulation[this.index];
    this.index = (this.index + 1) % this.simulation.length;
    return touches;
  };

  this.rewind = function () {
    this.index = 0;
  };
}

const firstTouchStarted = (touches) => {
  let found = false;
  for (const touch of touches) {
    if (touch.active() && !touch.started()) {
      return false;
    } else if (touch.started()) {
      found = true;
    }
  }
  return found;
};

const anyTouchActive = (touches) => {
  return touches.some((t) => t.active());
};

const allTouchesEnded = (touches) => {
  return touches.every((t) => t.ended());
};

//////////////////////////////////////////////////////////////////////////////
// Font
//////////////////////////////////////////////////////////////////////////////

const loadFont = async (url, fontFamily = "GameFont") => {
  const fontFace = new FontFace(fontFamily, `url(${url})`);
  self.fonts.add(fontFace);
  await fontFace.load();
};

//////////////////////////////////////////////////////////////////////////////
// Audio
//////////////////////////////////////////////////////////////////////////////

const loadAudio = async (audios) => {
  const promises = Object.entries(audios).map(async ([key, url]) => {
    const res = await fetch(url);
    return [key, await res.arrayBuffer()];
  });
  const bufs = await Promise.all(promises);
  const arrayBuffers = Object.fromEntries(bufs);

  self.postMessage(
    {
      type: "loadAudio",
      arrayBuffers,
    },
    Object.values(arrayBuffers),
  );
};

const audioManager = {
  audioCtx: null,
  audioBuffers: {},
  loopingSource: null,

  async register({ arrayBuffers }) {
    this.audioCtx = new window.AudioContext();

    const promises = Object.entries(arrayBuffers).map(async ([key, buf]) => {
      const audioBuffer = await this.audioCtx.decodeAudioData(buf);
      return [key, audioBuffer];
    });
    const bufs = await Promise.all(promises);
    this.audioBuffers = Object.fromEntries(bufs);
  },

  async resumeAudioContext() {
    if (this.audioCtx?.state === "suspended") {
      await this.audioCtx.resume();
    }
  },

  play({ key, loop }) {
    if (key in this.audioBuffers) {
      this.resumeAudioContext();

      const source = this.audioCtx.createBufferSource();
      source.buffer = this.audioBuffers[key];
      if (loop) {
        source.loop = true;
        this.loopingSource = source;
      }
      source.connect(this.audioCtx.destination);
      source.start(this.audioCtx.currentTime + 0.02);
    }
  },

  stop() {
    if (this.loopingSource) {
      this.loopingSource.stop(0);
      this.loopingSource = null;
    }
  },
};

const playAudio = (key, { loop } = {}) => {
  self.postMessage({
    type: "playAudio",
    key,
    loop,
  });
};

const stopAudio = (key) => {
  self.postMessage({
    type: "stopAudio",
    key,
  });
};

//////////////////////////////////////////////////////////////////////////////
// Image
//////////////////////////////////////////////////////////////////////////////

let imageBitmap;

const loadImage = async (url) => {
  const res = await fetch(url);
  const blob = await res.blob();
  imageBitmap = await self.createImageBitmap(blob);
};

//////////////////////////////////////////////////////////////////////////////
// Drawing
//////////////////////////////////////////////////////////////////////////////

const drawRect = (ctx, { x, y, width, height, origin = "center", color = "black" } = {}) => {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  let top, left;
  switch (origin) {
    case "center":
      top = -height / 2;
      left = -width / 2;
      break;
    case "topLeft":
      top = 0;
      left = 0;
      break;
  }
  ctx.fillRect(top, left, width, height);
  ctx.restore();
};

const drawCircle = (ctx, { x, y, radius, color = "black" }) => {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
};

const drawText = (
  ctx,
  { text, size = 16, color = "black", x = 0, y = 0, baseline = "top", align = "start", fontFamily = "GameFont" } = {},
) => {
  ctx.save();
  ctx.font = `${size}px "${fontFamily}"`;
  ctx.fillStyle = color;
  ctx.textBaseline = baseline;
  ctx.textAlign = align;
  ctx.fillText(text, x, y);
  ctx.restore();
};

const drawImage = (
  ctx,
  {
    image = imageBitmap,
    src: { left, top, right, bottom },
    dest: { x: destX, y: destY },
    scale = 1.0,
    origin = "center",
  },
) => {
  const srcX = left;
  const srcY = top;
  const srcWidth = right - left;
  const srcHeight = bottom - top;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  const destWidth = srcWidth * scale;
  const destHeight = srcHeight * scale;
  switch (origin) {
    case "center":
      destX -= destWidth / 2;
      destY -= destHeight / 2;
      break;
  }
  ctx.drawImage(
    image,
    srcX,
    srcY,
    srcWidth,
    srcHeight,
    Math.floor(destX),
    Math.floor(destY),
    Math.floor(destWidth),
    Math.floor(destHeight),
  );
  ctx.restore();
};

const drawTps = (ctx, opts = {}) => {
  drawText(ctx, { text: tps()?.toFixed(1), size: 8, ...opts });
};

//////////////////////////////////////////////////////////////////////////////
// PRNG
//////////////////////////////////////////////////////////////////////////////

function Random(seed) {
  if (typeof seed === "string") {
    seed = seed
      .split("")
      .map((c) => c.charCodeAt(0))
      .reduce((a, b) => a + b);
  }

  this.x = 123456789;
  this.y = 362436069;
  this.z = 521288629;
  this.w = seed;

  this.next = function () {
    let t = this.x ^ (this.x << 11);
    this.x = this.y;
    this.y = this.z;
    this.z = this.w;

    this.w = this.w ^ (this.w >>> 19) ^ (t ^ (t >>> 8));

    return (this.w >>> 0) / 4294967296;
  };

  this.nextInt = function (max = 4294967295, min = 0) {
    return Math.floor(this.next() * (max - min + 1)) + min;
  };

  this.nextFloat = function (max = 1.0, min = 0.0) {
    return this.next() * (max - min) + min;
  };

  this.nextNormal = function (mu = 0, sigma = 1) {
    let u1 = this.next();
    let u2 = this.next();

    if (u1 === 0) {
      u1 = 1.0e-8;
    }

    const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);

    return z0 * sigma + mu;
  };
}

//////////////////////////////////////////////////////////////////////////////
// Server
//////////////////////////////////////////////////////////////////////////////

const server = {
  host: "https://game-logging-server.tsujio.org",

  async init(key, logging, debug) {
    const encoder = new TextEncoder();
    const encoded = encoder.encode(key);
    const signKey = await self.crypto.subtle.importKey("raw", encoded, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    this.key = signKey;

    this.logging = logging;
    this.debug = debug;
  },

  async sign(data) {
    const encoder = new TextEncoder();
    const encoded = encoder.encode(data);
    const signature = await self.crypto.subtle.sign("HMAC", this.key, encoded);
    const array = Array.from(new Uint8Array(signature));
    const hex = array.map((b) => b.toString(16).padStart(2, "0")).join("");

    return hex;
  },

  async post(path, data) {
    if (!this.logging) {
      if (this.debug) {
        console.log(path, data);
      }
      return;
    }

    const body = JSON.stringify(data);
    const sig = await this.sign(body);

    const res = await fetch(this.host + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + sig,
      },
      body,
    });

    if (!res.ok) {
      throw new Error();
    }
  },

  async sendLog(game, action, data = {}) {
    await this.post("/log", {
      game_name: game.title,
      payload: {
        player_id: game.playerId,
        session_id: game.sessionId,
        play_id: game.playId,
        action,
        ...data,
      },
    });
  },

  touchBuffer: { touches: [] },

  async sendTouchLog(game, ticks, touches) {
    if (this.touchBuffer.playId !== game.playId) {
      const touchBuffer = this.touchBuffer;
      this.touchBuffer = { playId: game.playId, touches: [] };
      if (touchBuffer.touches.length > 0) {
        await this.sendLog(game, "touch", { play_id: touchBuffer.playId, touches: touchBuffer.touches });
      }
    }

    if (this.touchBuffer.touches.length > 0) {
      const lastTicks = this.touchBuffer.touches[this.touchBuffer.touches.length - 1].ticks;
      if (this.touchBuffer.touches.length >= 60 || lastTicks > ticks || ticks - lastTicks > 60) {
        const touchBuffer = this.touchBuffer;
        this.touchBuffer = { playId: game.playId, touches: [] };
        await this.sendLog(game, "touch", { play_id: touchBuffer.playId, touches: touchBuffer.touches });
      }
    }

    if (touches.length > 0) {
      this.touchBuffer.touches.push({
        ticks,
        touches: touches.map((t) => ({
          id: t.id,
          just_touched: t.started(),
          just_released: t.ended(),
          x: t.x,
          y: t.y,
        })),
      });
    }
  },

  async registerScore(game, score) {
    await this.post("/score", {
      game_name: game.title,
      player_id: game.playerId,
      play_id: game.playId,
      score,
    });
  },

  async fetchScores(game) {
    const res = await fetch(this.host + "/score?game_name=" + game.title);
    if (!res.ok) {
      throw new Error();
    }
    return await res.json();
  },
};

//////////////////////////////////////////////////////////////////////////////
// Game Template
//////////////////////////////////////////////////////////////////////////////

function Game({ title, screen, GamePlay, drawMode }) {
  const MODE_TITLE = 1;
  const MODE_PLAYING = 2;
  const MODE_GAME_OVER = 3;
  const MODE_RANKING = 4;

  this.title = title;
  this.screen = screen;

  this.onGameStart = function (playerId, debug) {
    this.playerId = playerId;
    this.debug = debug;
    this.sessionId = self.crypto.randomUUID();
    this.startNewPlay();
  };

  this.startNewPlay = function () {
    this.mode = MODE_TITLE;
    this.modeTicks = 0;
    this.playId = self.crypto.randomUUID();
    const seed = new Date().getTime();
    this.rand = new Random(seed);
    this.gamePlay = new GamePlay({ game: this, demo: true });
    server.sendLog(this, "initialize", { seed });
    this.ranking = undefined;
  };

  this.update = function () {
    this.modeTicks++;

    const touches = Array.from(touchManager.touches).map(([pointerId, touch]) => ({ id: pointerId, ...touch }));

    server.sendTouchLog(this, this.modeTicks, touches);

    switch (this.mode) {
      case MODE_TITLE:
        this.gamePlay.update();
        if (this.gamePlay.gameOver) {
          this.gamePlay = new GamePlay({ game: this, demo: true });
        }

        if (firstTouchStarted(touches)) {
          this.gamePlay = new GamePlay({ game: this, demo: false });

          this.mode = MODE_PLAYING;
          this.modeTicks = 0;
          playAudio("gameStart");
          playAudio("bgm", { loop: true });
          server.sendLog(this, "start_game");
        }

        break;

      case MODE_PLAYING:
        this.gamePlay.update(touches);

        if (this.gamePlay.gameOver) {
          this.mode = MODE_GAME_OVER;
          this.modeTicks = 0;
          server.sendLog(this, "game_over", { score: this.gamePlay.score });
          server
            .registerScore(this, this.gamePlay.score)
            .then(() => server.fetchScores(this))
            .then(({ scores }) => {
              this.ranking = scores;
            })
            .catch(() => {
              this.ranking = null;
            });
        }

        break;

      case MODE_GAME_OVER:
        if (this.modeTicks > 60 && this.ranking !== undefined && firstTouchStarted(touches)) {
          if (this.ranking) {
            this.mode = MODE_RANKING;
            this.modeTicks = 0;
            playAudio("ranking");
          } else {
            stopAudio("bgm");
            this.startNewPlay();
          }
        }

        break;

      case MODE_RANKING:
        if (this.modeTicks > 60 && firstTouchStarted(touches)) {
          stopAudio("bgm");
          this.startNewPlay();
        }

        break;
    }
  };

  this.draw = function (canvas) {
    const ctx = canvas.getContext("2d");

    switch (this.mode) {
      case MODE_TITLE:
        this.gamePlay.draw(ctx);
        drawMode.title.bind(this)(ctx);
        break;

      case MODE_PLAYING:
        this.gamePlay.draw(ctx);
        drawMode.playing.bind(this)(ctx);
        break;

      case MODE_GAME_OVER:
        this.gamePlay.draw(ctx);
        drawMode.gameOver.bind(this)(ctx);
        break;

      case MODE_RANKING:
        this.gamePlay.draw(ctx);
        drawMode.ranking.bind(this)(ctx);
        break;
    }

    if (this.debug) {
      drawTps(ctx, { color: "white" });
    }
  };

  this.drawRanking = function (ctx, { backgroundColor, textColor }) {
    ctx.save();
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(10, 10, screen.width - 10 * 2, screen.height - 10 * 2);
    ctx.restore();

    const ranking = this.ranking.slice(0, 10);
    const rankIn = ranking.some((r) => r.player_id === this.playerId);
    const text = "   SCORE    DATE   " + (rankIn ? "     " : "");
    drawText(ctx, { text, x: screen.width / 2, y: 72 - 28, size: 18, color: textColor, align: "center" });
    ranking.forEach((r, i) => {
      const rank = ranking.slice(0, i).filter((rnk) => rnk.score > r.score).length + 1;
      const ts = new Date(r.timestamp)
        .toLocaleDateString("ja-JP", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
        .replaceAll("/", ".");
      const score = String(r.score).padStart(5, " ");
      let text = `${rank}. ${score} ${ts}`;
      if (rankIn) {
        if (r.player_id === this.playerId) {
          text += " YOU!";
        } else {
          text += "     ";
        }
      }
      drawText(ctx, { text, x: screen.width / 2, y: 72 + 28 * i, size: 18, color: textColor, align: "center" });
    });
  };
}

//////////////////////////////////////////////////////////////////////////////
// Export
//////////////////////////////////////////////////////////////////////////////

let gamelib;

if (typeof window !== "undefined") {
  // Main thread
  gamelib = {
    play,
  };
} else {
  // Worker thread
  gamelib = {
    register,
    tps,
    TouchSimulation,
    firstTouchStarted,
    anyTouchActive,
    allTouchesEnded,
    playAudio,
    stopAudio,
    drawRect,
    drawCircle,
    drawText,
    drawImage,
    Random,
    Game,
  };
}

export default gamelib;

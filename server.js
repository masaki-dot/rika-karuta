// ✅ Render対応＆不具合修正済み server.js（2025年6月版）

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

let globalCards = [];
let globalSettings = {
  maxQuestions: 10,
  numCards: 5,
  showSpeed: 2000
};

let currentUsers = 0;
const states = {};

io.on("connection", (socket) => {
  currentUsers++;
  io.emit("user_count", currentUsers);

  let groupId = null;

  socket.on("disconnect", () => {
    currentUsers--;
    io.emit("user_count", currentUsers);
  });

  socket.on("set_cards_and_settings", ({ cards, settings }) => {
    globalCards = [...cards];
    globalSettings = settings;
    io.emit("start_group_selection");
  });

  socket.on("join", (gid) => {
    groupId = gid;
    socket.join(groupId);

    if (!states[groupId]) {
      states[groupId] = initState();
    }

    const state = states[groupId];
    let player = state.players.find(p => p.name === socket.id);
    if (!player) {
      state.players.push({
        socketId: socket.id,
        name: "(未設定)",
        hp: 20,
        answered: false
      });
    }
    io.to(groupId).emit("state", safeState(state));
  });

  socket.on("start", (data) => {
    const { groupId, numCards, maxQuestions, showSpeed } = data;
    const state = states[groupId] = initState();
    state.maxQuestions = maxQuestions;
    state.numCards = Math.min(Math.max(5, numCards), 10);
    globalSettings.showSpeed = showSpeed;
    nextQuestion(groupId);
  });

  socket.on("read_done", (groupId) => {
    const state = states[groupId];
    if (!state || state.readingCompleted || state.waitingNext) return;

    state.readingCompleted = true;
    state.timeoutId = setTimeout(() => {
      const st = states[groupId];
      if (st && st.readingCompleted && !st.waitingNext) {
        st.waitingNext = true;
        nextQuestion(groupId);
      }
    }, 30000);
  });

  socket.on("answer", ({ groupId, name, number }) => {
    console.log(`[📩 answer] ${name} => ${number} in ${groupId}`);
    const state = states[groupId];
    if (!state || !state.current || state.waitingNext || !name) {
      console.log("⚠️ 無効な状態: 回答無視");
      return;
    }

    let player = state.players.find(p => p.name === name);
    if (!player) {
      player = { socketId: socket.id, name, hp: 20, answered: false };
      state.players.push(player);
    }
    player.name = name;

    const correctCard = state.current.cards.find(c => c.number === number);

    if (correctCard && correctCard._answer && !player.answered) {
      player.answered = true;
      state.readingCompleted = true;
      state.waitingNext = true;

      if (state.timeoutId) clearTimeout(state.timeoutId);

      state.current.cards = state.current.cards.map(c => ({
        ...c,
        correct: c._answer || false
      }));

      const pointValue = state.current.pointValue;
      state.players.forEach(p => {
        if (p.name !== name && p.hp > 0) {
          p.hp -= pointValue;
          if (p.hp < 0) p.hp = 0;
        }
      });

      io.to(groupId).emit("state", safeState(state));

      setTimeout(() => {
        nextQuestion(groupId);
      }, 3000);
    } else {
      if (!state.lockedPlayers.includes(name)) {
        state.lockedPlayers.push(name);
        state.misclicks.push({ name, number });

        if (player.hp > 0) {
          player.hp -= state.current.pointValue;
          if (player.hp < 0) player.hp = 0;
        }

        socket.emit("lock", name);
        io.to(groupId).emit("state", safeState(state));
      }
    }
  });

  function initState() {
    return {
      players: [],
      cards: [],
      usedQuestions: [],
      numCards: 5,
      maxQuestions: 10,
      questionCount: 0,
      current: null,
      misclicks: [],
      lockedPlayers: [],
      waitingNext: false,
      readingCompleted: false,
      timeoutId: null
    };
  }

  function nextQuestion(groupId) {
    const state = states[groupId];
    if (!state) return;

    if (state.questionCount >= state.maxQuestions) {
      io.to(groupId).emit("end", state.players);
      return;
    }

    const remaining = globalCards.filter(q =>
      !state.usedQuestions.includes(q.text + "|" + q.number)
    );

    if (remaining.length === 0) {
      io.to(groupId).emit("end", state.players);
      return;
    }

    const question = shuffle(remaining)[0];
    state.usedQuestions.push(question.text + "|" + question.number);

    state.questionCount++;
    state.misclicks = [];
    state.lockedPlayers = [];
    state.readingCompleted = false;
    state.waitingNext = false;
    state.players.forEach(p => (p.answered = false));

    const distractors = shuffle(globalCards.filter(q => q.number !== question.number)).slice(0, state.numCards - 1);
    const allCards = shuffle([...distractors, question]);

    const rand = Math.random();
    let pointValue = 1;
    if (rand < 0.05) pointValue = 5;
    else if (rand < 0.2) pointValue = 3;
    else if (rand < 0.6) pointValue = 2;

    state.current = {
      text: question.text,
      answer: question.number,
      pointValue,
      cards: allCards.map(c => ({
        term: c.term,
        number: c.number,
        text: c.text,
        _answer: c.number === question.number
      }))
    };

    io.to(groupId).emit("state", safeState(state));
  }

  function safeState(state) {
    return {
      ...state,
      current: {
        text: state.current?.text,
        pointValue: state.current?.pointValue,
        cards: state.current?.cards.map(c => ({
          term: c.term,
          number: c.number,
          text: c.text,
          correct: c.correct || false
        })) || []
      }
    };
  }

  function shuffle(arr) {
    return [...arr].sort(() => Math.random() - 0.5);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

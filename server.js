// =======================
// 修正版 server.js 全文（正解札は正解後のみ表示）
// =======================

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const states = {};

io.on("connection", (socket) => {
  let groupId = null;

  socket.on("join", (gid) => {
    groupId = gid;
    socket.join(groupId);
    if (!states[groupId]) {
      states[groupId] = {
        players: [],
        cards: [],
        numCards: 5,
        maxQuestions: 10,
        questionCount: 0,
        current: null,
        misclicks: [],
        waitingNext: false
      };
    }
  });

  socket.on("start", (data) => {
    const { groupId, cards, numCards, maxQuestions } = data;
    states[groupId] = {
      cards: [...cards],
      numCards,
      maxQuestions,
      questionCount: 0,
      players: [],
      current: null,
      misclicks: [],
      waitingNext: false
    };
    nextQuestion(groupId);
  });

  socket.on("answer", ({ groupId, name, number }) => {
    const state = states[groupId];
    if (!state || !state.current || state.waitingNext) return;

    let player = state.players.find(p => p.name === name);
    if (!player) {
      player = { name, score: 0 };
      state.players.push(player);
    }

    const correct = state.current.answer === number;
    if (correct) {
      player.score += 1;
      state.waitingNext = true;

      // 正解札にのみ correct: true を付ける
      const updatedCards = state.current.cards.map(card => {
        return { ...card, correct: card.number === number };
      });

      state.current.cards = updatedCards;

      io.to(groupId).emit("state", {
        ...state,
        misclicks: state.misclicks,
        waitingNext: true
      });
    } else {
      state.misclicks.push({ name, number });
      io.to(groupId).emit("lock", name);
      io.to(groupId).emit("state", {
        ...state,
        misclicks: state.misclicks,
        waitingNext: false
      });
    }
  });

  socket.on("next", (groupId) => {
    const state = states[groupId];
    if (!state || !state.waitingNext) return;

    state.questionCount += 1;
    state.waitingNext = false;
    state.misclicks = [];

    if (state.questionCount >= state.maxQuestions) {
      io.to(groupId).emit("end", state.players);
    } else {
      nextQuestion(groupId);
    }
  });

  socket.on("reset", (groupId) => {
    if (states[groupId]) {
      states[groupId].players = [];
      states[groupId].questionCount = 0;
      states[groupId].misclicks = [];
      states[groupId].waitingNext = false;
      nextQuestion(groupId);
    }
  });

  function nextQuestion(groupId) {
    const state = states[groupId];
    if (!state || !state.cards || state.cards.length === 0) return;

    const shuffled = shuffle(state.cards).slice(0, state.numCards);
    const answerIndex = Math.floor(Math.random() * shuffled.length);

    state.current = {
      text: shuffled[answerIndex].text,
      answer: shuffled[answerIndex].number,
      cards: shuffled.map(c => ({ ...c })) // correctフラグを含まない初期状態
    };

    io.to(groupId).emit("state", {
      ...state,
      misclicks: state.misclicks,
      waitingNext: false
    });
  }

  function shuffle(arr) {
    return [...arr].sort(() => Math.random() - 0.5);
  }
});

server.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});

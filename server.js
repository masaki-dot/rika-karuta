const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const states = {}; // 🔁 グループごとに状態を保持

io.on("connection", (socket) => {
  let groupId = null;

  socket.on("join", (gid) => {
    groupId = gid;
    socket.join(groupId);
    if (!states[groupId]) {
      states[groupId] = { players: [], current: null, maxQuestions: 0, questionCount: 0 };
    }
  });

  socket.on("start", (data) => {
    const { groupId, cards, numCards, maxQuestions } = data;
    if (!states[groupId]) return;

    states[groupId].cards = [...cards];
    states[groupId].numCards = numCards;
    states[groupId].maxQuestions = maxQuestions;
    states[groupId].questionCount = 0;
    states[groupId].players = [];

    nextQuestion(groupId);
  });

  socket.on("answer", ({ groupId, name, number }) => {
    const state = states[groupId];
    if (!state || !state.current) return;

    if (!state.players.find(p => p.name === name)) {
      state.players.push({ name, score: 0 });
    }

    const player = state.players.find(p => p.name === name);
    const correct = state.current.cards.find(c => c.number === number);
    if (correct) {
      correct.correct = true;
      player.score += 1;

      io.to(groupId).emit("state", state);

      setTimeout(() => {
        states[groupId].questionCount += 1;
        if (states[groupId].questionCount >= states[groupId].maxQuestions) {
          io.to(groupId).emit("end", state.players);
        } else {
          nextQuestion(groupId);
        }
      }, 3000);
    } else {
      io.to(groupId).emit("lock", name);
    }
  });

  socket.on("reset", (groupId) => {
    if (states[groupId]) {
      states[groupId].players = [];
      states[groupId].questionCount = 0;
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
      cards: shuffled.map((c, i) => ({ ...c, correct: i === answerIndex }))
    };

    io.to(groupId).emit("state", state);
  }

  function shuffle(arr) {
    return arr.sort(() => Math.random() - 0.5);
  }
});

server.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});

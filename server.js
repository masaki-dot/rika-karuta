// ✅ server.js（最新版・フルリセット対応）
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

const states = {};

io.on("connection", (socket) => {
  socket.on("set_cards_and_settings", ({ cards, settings }) => {
    globalCards = [...cards];
    globalSettings = settings;
    io.emit("start_group_selection");
  });

  socket.on("join", (groupId) => {
    socket.join(groupId);

    if (!states[groupId]) states[groupId] = initState(groupId);
    const state = states[groupId];

    if (!state.players.find(p => p.id === socket.id)) {
      state.players.push({ id: socket.id, name: "未設定", hp: 20 });
    }

    io.to(groupId).emit("state", sanitizeState(state));
  });

  socket.on("set_name", ({ groupId, name }) => {
    const state = states[groupId];
    if (!state) return;
    const player = state.players.find(p => p.id === socket.id);
    if (player) player.name = name;
  });

  socket.on("start", (groupId) => {
    const state = states[groupId];
    if (!state) return;
    nextQuestion(groupId);
  });

  socket.on("answer", ({ groupId, number }) => {
    const state = states[groupId];
    if (!state || !state.current || state.waitingNext) return;
    const player = state.players.find(p => p.id === socket.id);
    if (!player || player.hp <= 0) return;

    const correct = state.current.answer === number;

    if (correct && !state.answered) {
      state.answered = true;
      state.waitingNext = true;
      state.correctPlayer = player.name;

      state.players.forEach(p => {
        if (p.id !== socket.id && p.hp > 0) p.hp -= state.current.point;
      });

      setTimeout(() => nextQuestion(groupId), 3000);
    } else {
      if (!state.misClicks.find(e => e.id === socket.id)) {
        state.misClicks.push({ id: socket.id, name: player.name, number });
        player.hp -= state.current.point;
      }
    }

    io.to(groupId).emit("state", sanitizeState(state));
  });
});

function initState(groupId) {
  return {
    groupId,
    players: [],
    questionCount: 0,
    maxQuestions: globalSettings.maxQuestions,
    numCards: globalSettings.numCards,
    showSpeed: globalSettings.showSpeed,
    current: null,
    answered: false,
    waitingNext: false,
    misClicks: [],
    usedQuestions: []
  };
}

function nextQuestion(groupId) {
  const state = states[groupId];
  if (!state || state.questionCount >= state.maxQuestions) {
    io.to(groupId).emit("end", state);
    return;
  }

  state.questionCount++;
  state.answered = false;
  state.waitingNext = false;
  state.misClicks = [];

  const remaining = globalCards.filter(q =>
    !state.usedQuestions.includes(q.text + q.number)
  );
  const question = remaining[Math.floor(Math.random() * remaining.length)];
  state.usedQuestions.push(question.text + question.number);

  const distractors = shuffle(globalCards.filter(c => c.number !== question.number)).slice(0, state.numCards - 1);
  const cards = shuffle([...distractors, question]);

  const rand = Math.random();
  let point = 1;
  if (rand < 0.05) point = 5;
  else if (rand < 0.2) point = 3;
  else if (rand < 0.6) point = 2;

  state.current = {
    text: question.text,
    answer: question.number,
    point,
    cards: cards.map(c => ({ number: c.number, term: c.term }))
  };

  io.to(groupId).emit("state", sanitizeState(state));

  setTimeout(() => {
    if (!state.answered) {
      state.waitingNext = true;
      io.to(groupId).emit("state", sanitizeState(state));
      setTimeout(() => nextQuestion(groupId), 1000);
    }
  }, 30000);
}

function sanitizeState(state) {
  return {
    groupId: state.groupId,
    players: state.players,
    questionCount: state.questionCount,
    maxQuestions: state.maxQuestions,
    current: state.current,
    misClicks: state.misClicks,
    showSpeed: state.showSpeed,
    waitingNext: state.waitingNext,
    answered: state.answered
  };
}

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

server.listen(3000, () => {
  console.log("✅ Server running http://localhost:3000");
});

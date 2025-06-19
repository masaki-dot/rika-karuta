// ✅ 完全統合版：リアルタイム理科カルタ server.js（HP制＋pointValue対応済）

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
    if (!states[groupId]) states[groupId] = initState();
    const state = states[groupId];

    if (!state.players.find(p => p.socketId === socket.id)) {
      state.players.push({ socketId: socket.id, name: "(未設定)", hp: 20 });
    }

    io.to(groupId).emit("state", state);
  });

  socket.on("start", (data) => {
    const { groupId, numCards, maxQuestions } = data;
    const state = states[groupId] = initState();
    state.maxQuestions = maxQuestions;
    state.numCards = Math.min(Math.max(5, numCards), 10);
    nextQuestion(groupId);
  });

  socket.on("read_done", (groupId) => {
    const state = states[groupId];
    if (!state || state.readingCompleted || state.waitingNext) return;
    state.readingCompleted = true;
    state.timeoutId = setTimeout(() => {
      if (state.readingCompleted && !state.waitingNext) {
        state.waitingNext = true;
        nextQuestion(groupId);
      }
    }, 30000);
  });

  socket.on("answer", ({ groupId, name, number }) => {
    const state = states[groupId];
    if (!state || !state.current || state.waitingNext || !name) return;
    if (state.lockedPlayers.includes(name)) return;

    let player = state.players.find(p => p.name === name);
    if (!player) {
      player = { name, hp: 20, socketId: socket.id };
      state.players.push(player);
    }

    const correctCard = state.current.cards.find(c => c.number === number);

    if (correctCard && correctCard._answer) {
      state.readingCompleted = true;
      state.waitingNext = true;

      if (state.timeoutId) {
        clearTimeout(state.timeoutId);
        state.timeoutId = null;
      }

      const point = state.current.pointValue;

      state.players.forEach(p => {
        if (p.name !== name) {
          p.hp = Math.max(0, (p.hp || 20) - point);
        }
      });

      state.current.cards = state.current.cards.map(c => ({
        ...c,
        correct: c._answer || false
      }));

      io.to(groupId).emit("state", { ...state, misclicks: state.misclicks, waitingNext: true });
      setTimeout(() => nextQuestion(groupId), 3000);

    } else {
      const point = state.current.pointValue;
      state.lockedPlayers.push(name);
      state.misclicks.push({ name, number });
      player.hp = Math.max(0, (player.hp || 20) - point);
      io.to(socket.id).emit("lock", name);

      state.current.cards = state.current.cards.map(c => ({
        ...c,
        correct: c._answer || false
      }));

      io.to(groupId).emit("state", {
        players: state.players,
        misclicks: state.misclicks,
        questionCount: state.questionCount,
        maxQuestions: state.maxQuestions,
        current: {
          text: state.current.text,
          cards: state.current.cards.map(c => ({ term: c.term, number: c.number, text: c.text }))
        }
      });
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

    // 終了条件
    const alive = state.players.filter(p => (p.hp || 0) > 0);
    if (alive.length <= 1 || state.questionCount >= state.maxQuestions) {
      io.to(groupId).emit("end", state.players);
      return;
    }

    state.questionCount++;
    state.misclicks = [];
    state.lockedPlayers = [];
    state.waitingNext = false;
    state.readingCompleted = false;

    const remaining = globalCards.filter(q => !state.usedQuestions.includes(q.text + "|" + q.number));
    const question = shuffle(remaining)[0];
    state.usedQuestions.push(question.text + "|" + question.number);

    const distractors = shuffle(globalCards.filter(q => q.number !== question.number)).slice(0, state.numCards - 1);
    const allCards = shuffle([...distractors, question]);

    const rand = Math.random();
    let pointValue = 1;
    if (rand < 0.05) pointValue = 5;
    else if (rand < 0.20) pointValue = 3;
    else if (rand < 0.60) pointValue = 2;

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

    io.to(groupId).emit("state", {
      ...state,
      showSpeed: globalSettings.showSpeed,
      misclicks: [],
      waitingNext: false,
      current: {
        ...state.current,
        cards: state.current.cards.map(c => ({ term: c.term, number: c.number, text: c.text }))
      }
    });
  }

  function shuffle(arr) {
    return [...arr].sort(() => Math.random() - 0.5);
  }
});

server.listen(3000, () => {
  console.log("🚀 Server running on http://localhost:3000");
});

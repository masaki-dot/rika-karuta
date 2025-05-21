const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

let globalCards = [];
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

  socket.on("set_cards", (cards) => {
    globalCards = cards;
    io.emit("csv_ready");
  });

  socket.on("join", (gid) => {
    groupId = gid;
    socket.join(groupId);
    if (!states[groupId]) {
      states[groupId] = initState();
    }
  });

  socket.on("start", (data) => {
    const { groupId, numCards, maxQuestions } = data;
    const state = states[groupId] = initState();

    // CSV全体からランダムに maxQuestions 件を抽出
    state.cards = shuffle([...globalCards]).slice(0, maxQuestions);
    state.numCards = numCards;
    state.maxQuestions = maxQuestions;
    nextQuestion(groupId);
  });

  socket.on("read_done", (groupId) => {
    const state = states[groupId];
    if (!state || state.readingCompleted) return;
    state.readingCompleted = true;

    setTimeout(() => {
      const st = states[groupId];
      if (st && !st.waitingNext) {
        st.waitingNext = true;
        io.to(groupId).emit("state", { ...st, waitingNext: true });
        nextQuestion(groupId);
      }
    }, 30000);
  });

  socket.on("answer", ({ groupId, name, number }) => {
    const state = states[groupId];
    if (!state || !state.current || state.waitingNext) return;
    if (state.lockedPlayers.includes(name)) return;

    let player = state.players.find(p => p.name === name);
    if (!player) {
      player = { name, score: 0 };
      state.players.push(player);
    }

    const correctCard = state.current.cards.find(c => c.number === number);

    if (correctCard && correctCard._answer) {
      let base = 1;
      const mis = state.misclicks.length;
      if (mis === 0) base = 3;
      else if (mis === 1) base = 2;
      if (!state.readingCompleted) base += 1;

      player.score += base;

      state.current.cards = state.current.cards.map(c => ({
        ...c,
        correct: c._answer || false
      }));

      state.waitingNext = true;

      io.to(groupId).emit("state", {
        ...state,
        misclicks: state.misclicks,
        waitingNext: true
      });

      setTimeout(() => {
        nextQuestion(groupId);
      }, 3000);
    } else {
      state.lockedPlayers.push(name);
      state.misclicks.push({ name, number });

      if (state.lockedPlayers.length >= 4) {
        state.waitingNext = true;
        io.to(groupId).emit("state", {
          ...state,
          misclicks: state.misclicks,
          waitingNext: true
        });
        nextQuestion(groupId);
      } else {
        io.to(groupId).emit("lock", name);
        io.to(groupId).emit("state", {
          ...state,
          misclicks: state.misclicks
        });
      }
    }
  });

  socket.on("reset", (groupId) => {
    states[groupId] = initState();
  });

  function initState() {
    return {
      players: [],
      cards: [],
      usedCards: [],
      numCards: 5,
      maxQuestions: 10,
      questionCount: 0,
      current: null,
      misclicks: [],
      lockedPlayers: [],
      waitingNext: false,
      readingCompleted: false
    };
  }

  function nextQuestion(groupId) {
    const state = states[groupId];
    if (!state) return;

    state.questionCount += 1;
    state.misclicks = [];
    state.lockedPlayers = [];
    state.waitingNext = false;
    state.readingCompleted = false;

    if (state.questionCount > state.maxQuestions) {
      io.to(groupId).emit("end", state.players);
      return;
    }

    const candidates = state.cards;
    const shuffled = shuffle(candidates).slice(0, state.numCards);
    const answerIndex = Math.floor(Math.random() * shuffled.length);
    const answerCard = shuffled[answerIndex];

    state.current = {
      text: answerCard.text,
      answer: answerCard.number,
      cards: shuffled.map((c, i) => ({
        term: c.term,
        number: c.number,
        text: c.text,
        _answer: i === answerIndex
      }))
    };

    io.to(groupId).emit("state", {
      ...state,
      misclicks: [],
      waitingNext: false,
      current: {
        ...state.current,
        cards: state.current.cards.map(c => ({
          term: c.term,
          number: c.number,
          text: c.text
        }))
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

});

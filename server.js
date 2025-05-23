// ✅ 完全修正版 server.js
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
    globalCards = [...cards];
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
});

socket.on("read_done", (groupId) => {
  console.log(`[DEBUG] read_done received for ${groupId}`);
  const state = states[groupId];
  if (!state || state.readingCompleted || state.waitingNext) return;
  state.readingCompleted = true;

  setTimeout(() => {
    const st = states[groupId];
    if (st && st.readingCompleted) {
      st.waitingNext = true;
      nextQuestion(groupId);
      io.to(groupId).emit("state", {
        ...st,
        misclicks: [],
        waitingNext: false,
        current: {
          ...st.current,
          cards: st.current.cards.map(c => ({
            term: c.term,
            number: c.number,
            text: c.text
          }))
        }
      });
    }
  }, 30000);
});


  socket.on("answer", ({ groupId, name, number }) => {
    const state = states[groupId];
    if (!state || !state.current || state.waitingNext || !name) return;
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
      state.readingCompleted = true;
      state.waitingNext = true;

      state.current.cards = state.current.cards.map(c => ({
        ...c,
        correct: c._answer || false
      }));

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
  state.readingCompleted = true; // ← 強制的に全文読み終わったとみなす
  io.to(groupId).emit("state", {
    ...state,
    misclicks: state.misclicks,
    waitingNext: true
  });

  // ✅ 30秒待って次の問題へ（正解が出ていない場合）
  setTimeout(() => {
    const st = states[groupId];
    if (st && !st.waitingNext) {
      st.waitingNext = true;
      nextQuestion(groupId);
    }
  }, 30000);
}
else {
        io.to(groupId).emit("lock", name);
        io.to(groupId).emit("state", {
          ...state,
          misclicks: state.misclicks
        });
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
      readingCompleted: false
    };
  }

  function nextQuestion(groupId) {
    const state = states[groupId];
    if (!state) return;

    console.log(`[DEBUG] nextQuestion: group=${groupId}, numCards=${state.numCards}`);

    state.questionCount++;
    state.misclicks = [];
    state.lockedPlayers = [];
    state.waitingNext = false;
    state.readingCompleted = false;

    if (state.questionCount > state.maxQuestions) {
      io.to(groupId).emit("end", state.players);
      return;
    }

    const remaining = state.cards.filter(q =>
      !state.usedQuestions.includes(q.text + "|" + q.number)
    );

    if (remaining.length === 0) {
      state.usedQuestions = [];
    }

    const question = shuffle(remaining)[0];
    state.usedQuestions.push(question.text + "|" + question.number);

    const distractors = shuffle(globalCards.filter(q => q.number !== question.number)).slice(0, state.numCards - 1);
    const allCards = shuffle([...distractors, question]);

    state.current = {
      text: question.text,
      answer: question.number,
      cards: allCards.map(c => ({
        term: c.term,
        number: c.number,
        text: c.text,
        _answer: c.number === question.number
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

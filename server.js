const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 静的ファイルを配信
app.use(express.static(path.join(__dirname, "public")));

const states = {};

io.on("connection", (socket) => {
  let groupId = null;

  socket.on("join", (gid) => {
    groupId = gid;
    socket.join(groupId);
    if (!states[groupId]) {
      states[groupId] = initState();
    }
  });

  socket.on("start", (data) => {
    const { groupId, cards, numCards, maxQuestions } = data;
    states[groupId] = initState();
    const state = states[groupId];
    state.cards = [...cards];
    state.numCards = numCards;
    state.maxQuestions = maxQuestions;
    nextQuestion(groupId);
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
      player.score += 1;

      // 正解札のみ correct: true を付加
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
      io.to(groupId).emit("lock", name);
      io.to(groupId).emit("state", {
        ...state,
        misclicks: state.misclicks,
        waitingNext: false
      });
    }
  });

  socket.on("reset", (groupId) => {
    if (states[groupId]) {
      states[groupId] = initState();
    }
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
      waitingNext: false
    };
  }

  function nextQuestion(groupId) {
    const state = states[groupId];
    if (!state) return;

    state.questionCount += 1;
    state.misclicks = [];
    state.lockedPlayers = [];
    state.waitingNext = false;

    if (state.questionCount > state.maxQuestions) {
      io.to(groupId).emit("end", state.players);
      return;
    }

    // 使用していないカードから取り札を選ぶ
    const remainingCards = state.cards.filter(c =>
      !state.usedCards.includes(c.text + "|" + c.number)
    );

    // 全カードを使い切ったらリセット
    if (remainingCards.length < state.numCards) {
      state.usedCards = [];
    }

    const candidates = state.cards.filter(c =>
      !state.usedCards.includes(c.text + "|" + c.number)
    );

    const shuffled = shuffle(candidates).slice(0, state.numCards);
    const answerIndex = Math.floor(Math.random() * shuffled.length);
    const answerCard = shuffled[answerIndex];

    // 使用済みに追加
    state.usedCards.push(answerCard.text + "|" + answerCard.number);

    state.current = {
      text: answerCard.text,
      answer: answerCard.number,
      cards: shuffled.map((c, i) => ({
        term: c.term,
        number: c.number,
        text: c.text,
        _answer: i === answerIndex  // internal flag for correct
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
          // correct: undefined → 最初は非表示
        }))
      }
    });
  }

  function shuffle(arr) {
    return [...arr].sort(() => Math.random() - 0.5);
  }
});

server.listen(3000, () => {
  console.log("Server running at http://localhost:3000");
});


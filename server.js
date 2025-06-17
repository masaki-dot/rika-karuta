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

  console.log("[DEBUG] 受信した共通設定:", settings);
  console.log("[DEBUG] 問題数:", globalCards.length);

  io.emit("start_group_selection");
});
;


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
    state.maxQuestions = maxQuestions;
    state.numCards = Math.min(Math.max(5, numCards), 10);
    console.log(`[DEBUG] ゲーム開始: group=${groupId}, numCards=${state.numCards}`);
    nextQuestion(groupId);
  });

 socket.on("read_done", (groupId) => {
  const state = states[groupId];
  if (!state || state.readingCompleted || state.waitingNext) return;

  state.readingCompleted = true;

  // ✅ 30秒後に次の問題へ進むタイマー
  state.timeoutId = setTimeout(() => {
    const st = states[groupId];
    if (st && st.readingCompleted && !st.waitingNext) {
      st.waitingNext = true;
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

  // ✅ 30秒タイマーが生きていたらキャンセル
  if (state.timeoutId) {
    clearTimeout(state.timeoutId);
    state.timeoutId = null;
  }

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

  return;
}
else {
  state.lockedPlayers.push(name);
  state.misclicks.push({ name, number });

  // ✅ 取り札に赤表示＋名前を追加できるように、correct情報も送る
  state.current.cards = state.current.cards.map(c => ({
    ...c,
    correct: c._answer || false
  }));

  // 該当プレイヤーをロック
  io.to(socket.id).emit("lock", name);

  // 状態を再送（misclicksとともにcurrentを含める）
 io.to(groupId).emit("state", {
  players: state.players,
  misclicks: state.misclicks,
  questionCount: state.questionCount,
  maxQuestions: state.maxQuestions,
  current: {
    text: state.current.text,
    cards: state.current.cards.map(c => ({
      term: c.term,
      number: c.number,
      text: c.text
    }))
  }
});


  // ✅ 次の問題への進行は read_done に任せる（ここでは進めない）
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
    timeoutId: null  // ←追加
  };
}


  function nextQuestion(groupId) {
    const state = states[groupId];
    if (!state) return;

    if (state.questionCount >= state.maxQuestions) {
      io.to(groupId).emit("end", state.players);
      return;
    }

    console.log(`[DEBUG] nextQuestion: group=${groupId}, numCards=${state.numCards}`);

    state.questionCount++;
    state.misclicks = [];
    state.lockedPlayers = [];
    state.waitingNext = false;
    state.readingCompleted = false;

    const remaining = globalCards.filter(q =>
  !state.usedQuestions.includes(q.text + "|" + q.number)
);

console.log("[DEBUG] usedQuestions数:", state.usedQuestions.length);
console.log("[DEBUG] remaining候補数:", remaining.length);

const question = shuffle(remaining)[0];

console.log("[DEBUG] 出題された問題:", question.number, question.text);

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
  showSpeed: globalSettings.showSpeed,  // ←追加
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

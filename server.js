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

  // 🔧 既存のグループ state をすべてリセット
  for (const key in states) {
    delete states[key];
  }

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

socket.on("read_done", (groupId) => {
  const group = groups[groupId];
  const state = states[groupId];
  if (!group || !state) return;

  // 読み終わったプレイヤーの記録
  if (!state.readDone) state.readDone = new Set();
  state.readDone.add(socket.id);

  const alivePlayers = group.players.filter(p => p.hp > 0);
  const finishedCount = state.readDone.size;

  // 全生存プレイヤーが読み終えたら即次の問題へ
  if (finishedCount >= alivePlayers.length && !state.answered && !state.waitingNext) {
    state.waitingNext = true;
    io.to(groupId).emit("state", sanitizeState(state));
    setTimeout(() => nextQuestion(groupId), 1000);
  }

  // 念のため 30秒経過後にも進む保険
  if (state.readTimer) clearTimeout(state.readTimer);
  state.readTimer = setTimeout(() => {
    if (!state.answered && !state.waitingNext) {
      state.waitingNext = true;
      io.to(groupId).emit("state", sanitizeState(state));
      setTimeout(() => nextQuestion(groupId), 1000);
    }
  }, 30000);
});


  
socket.on("start", ({ groupId }) => {
  console.log(`▶ 強制スタート: ${groupId}`);
  const state = states[groupId];
  if (!state) return;

  // 応急で設定を強制（あとで消してもOK）
  state.maxQuestions = 5;
  state.numCards = 5;

  nextQuestion(groupId);
});



  socket.on("answer", ({ groupId, number }) => {
    const state = states[groupId];
    if (!state || !state.current || state.waitingNext) return;
    const player = state.players.find(p => p.id === socket.id);
    if (!player || player.hp <= 0 || player.hasMissed) return;

    const correct = state.current.answer === number;

    // 正解のとき
if (correct && !state.answered) {
  state.answered = true;
  state.waitingNext = true;
  state.correctPlayer = player.name;

  // 誰が選んだかをカードに記録
  const card = state.current.cards.find(c => c.number === number);
  if (card) {
    card.correct = true;
    card.chosenBy = player.name;
  }

  state.players.forEach(p => {
    if (p.id !== socket.id && p.hp > 0) p.hp -= state.current.point;
  });

  setTimeout(() => nextQuestion(groupId), 3000);
} else {
  // 不正解でもカードに記録
 if (!state.misClicks.find(e => e.id === socket.id)) {
  state.misClicks.push({ id: socket.id, name: player.name, number });

  const card = state.current.cards.find(c => c.number === number);
  if (card) {
    card.incorrect = true;
    card.chosenBy = player.name;
  }

  player.hp -= state.current.point;
  player.hasMissed = true; // 🔴 この行を追加：お手つきマーク
}

}


    io.to(groupId).emit("state", sanitizeState(state));
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
    usedQuestions: [],
    readStarted: false,
    readTimer: null
  };
}

function nextQuestion(groupId) {
  const state = states[groupId];
  if (!state || state.questionCount >= state.maxQuestions) {
    io.to(groupId).emit("end", state);
    return;
  }

  // 🔍 デバッグログ
  console.log("📦 全カード数:", globalCards.length);
  console.log("🟨 使用済み:", state.usedQuestions);

  const remaining = globalCards.filter(q =>
    !state.usedQuestions.includes(q.text.trim() + q.number)
  );
  console.log("✅ 残り問題数:", remaining.length);

  if (remaining.length === 0) {
    io.to(groupId).emit("end", state);
    return;
  }

  const question = remaining[Math.floor(Math.random() * remaining.length)];
  const key = question.text.trim() + question.number;
  state.usedQuestions.push(key);

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

  state.questionCount++; // ← 重要

  console.log("✅ 問題設定完了:", state.current);

  io.to(groupId).emit("state", sanitizeState(state));
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

// ここで socket.io の connection ハンドラーを閉じる
});  

// サーバーを起動
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

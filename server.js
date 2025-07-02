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
const groups = {};

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

  // ✅ グループ初期化（追加）
  if (!groups[groupId]) groups[groupId] = { players: [] };

  // ✅ プレイヤーがいなければ追加（追加）
  if (!groups[groupId].players.find(p => p.id === socket.id)) {
    groups[groupId].players.push({ id: socket.id, name: "未設定", hp: 20, score: 0 });
  }

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

  // ✅ 追加：groups側も更新
  const gplayer = groups[groupId]?.players.find(p => p.id === socket.id);
  if (gplayer) gplayer.name = name;
});


socket.on("read_done", (groupId) => {
  const group = groups[groupId];
  const state = states[groupId];
  if (!group || !state || !state.current) return;

  // 読み終わったプレイヤーの記録
  if (!state.readDone) state.readDone = new Set();
  state.readDone.add(socket.id);

  const latestText = state.current.text; // ✅ この問題の識別子

  // 念のため 30秒経過後にも進む保険
  if (state.readTimer) clearTimeout(state.readTimer);
  state.readTimer = setTimeout(() => {
    // ✅ 条件を厳密化：誤進行を防止
    if (!state.answered && !state.waitingNext && state.current && state.current.text === latestText) {
      state.waitingNext = true;
      io.to(groupId).emit("state", sanitizeState(state));
      setTimeout(() => nextQuestion(groupId), 1000);
    }
  }, 30000);
});



  
socket.on("start", ({ groupId }) => {
  console.log(`▶ 強制スタート: ${groupId}`);
  const state = states[groupId];
  const group = groups[groupId];
  if (!state || !group) return;

  // プレイヤー状態を初期化（HP, スコア, 脱落記録など）
  state.players.forEach(p => {
    p.hp = 20;
    p.score = 0;
  });
  group.players.forEach(p => {
    p.hp = 20;
    p.score = 0;
  });

  state.eliminatedOrder = [];
  state.questionCount = 0;
  state.usedQuestions = [];
  state.readDone = new Set();
  state.answered = false;
  state.waitingNext = false;
  state.misClicks = [];

  nextQuestion(groupId);
});




socket.on("answer", ({ groupId, name, number }) => {
  const state = states[groupId];
  const group = groups[groupId];
  if (!state || !group || !state.current) return;

  if (state.answered || state.locked) return;

  const correct = state.current.answer === number;
  const player = group.players.find(p => p.name === name);
  if (!player) return;

  if (player.hp <= 0) {
  return; // 脱落者は回答できない
}
  
  const point = state.current.point;

  if (correct) {
  player.score += state.current.point;
  state.current.cards = state.current.cards.map(c =>
    c.number === number ? { ...c, correct: true, chosenBy: name } : c
  );
  state.answered = true;

  // ✅ 正解した人以外を減点
 group.players.forEach(p => {
  if (p.name !== name) {
    p.hp = Math.max(0, p.hp - point);
    const sp = state.players.find(sp => sp.id === p.id);
    if (sp) sp.hp = p.hp;

    // ✅【ここに追加】HPが0以下になったら脱落記録
    if (p.hp <= 0) {
      if (!state.eliminatedOrder.includes(p.name)) {
        state.eliminatedOrder.push(p.name);
      }
    }
  }
});


  if (!state.waitingNext) {
    state.waitingNext = true;
    io.to(groupId).emit("state", sanitizeState(state));
    setTimeout(() => nextQuestion(groupId), 3000);
  }
    checkGameEnd(groupId);
}
else {
  // ✅ 不正解時の処理
  player.hp -= state.current.point;
  const sp = state.players.find(sp => sp.id === player.id);
  if (sp) sp.hp = player.hp;  // ← state側も更新

  // ✅【ここに追加】HPが0以下になったら脱落記録
  if (player.hp <= 0) {
    player.hp = 0;
    if (!state.eliminatedOrder.includes(player.name)) {
      state.eliminatedOrder.push(player.name);
    }
  }

  state.misClicks.push({ name, number });
  state.current.cards = state.current.cards.map(c =>
    c.number === number ? { ...c, incorrect: true, chosenBy: name } : c
  );
}

  io.to(groupId).emit("state", sanitizeState(state));
  checkGameEnd(groupId);
});

// 他の関数（例：nextQuestionなど）の下あたりに追加
function checkGameEnd(groupId) {
  const state = states[groupId]; // ✅ これが正解

  if (!state) return;

  // 生き残りプレイヤーの数を確認
  const survivors = state.players.filter(p => p.hp > 0);

  // 🔹最後の1人なら勝者として終了
  if (survivors.length === 1) {
    const eliminated = [...(state.eliminatedOrder || [])].reverse();
    const finalRanking = [survivors[0], ...eliminated.map(name => state.players.find(p => p.name === name))];
    io.to(groupId).emit("end", finalRanking);
    return;
  }
}



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
    readTimer: null,
    eliminatedOrder: []
  };
}

function nextQuestion(groupId) {
  const state = states[groupId];
  if (!state) return;

  // ✅ 既存のタイマーをリセット（ここを追加！）
  if (state.readTimer) {
    clearTimeout(state.readTimer);
    state.readTimer = null;
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

// ✅ ここを追加！
state.waitingNext = false;
  state.answered = false;
  state.readDone = new Set();

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

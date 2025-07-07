// ✅ server.js（最新版・フルリセット対応）
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

let hostSocketId = null;

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
for (const key in groups) {
  delete groups[key]; // ✅ ← groups もリセット
}


  io.emit("start_group_selection");
});


  socket.on("join", (groupId) => {
  socket.join(groupId);

  // ✅ グループ初期化（追加）
  if (!groups[groupId]) groups[groupId] = { players: [] };

  // ✅ プレイヤーがいなければ追加（追加）
  if (!groups[groupId].players.find(p => p.id === socket.id)) {
    groups[groupId].players.push({ id: socket.id, name: "未設定", hp: 20, score: 0,　correctCount: 0,  totalScore: 0 });
  }

  if (!states[groupId]) states[groupId] = initState(groupId);
  const state = states[groupId];

  if (!state.players.find(p => p.id === socket.id)) {
    state.players.push({ id: socket.id, name: "未設定", hp: 20 });
  }

  io.to(groupId).emit("state", sanitizeState(state));
});

  // サーバー側に追加
socket.on("request_global_ranking", () => {
  const allPlayers = [];

  for (const group of Object.values(groups)) {
    for (const p of group.players) {
      allPlayers.push({
        name: p.name,
        totalScore: p.totalScore || 0
      });
    }
  }

  const sorted = allPlayers
    .filter(p => p.name !== "未設定")
    .sort((a, b) => b.totalScore - a.totalScore);

  socket.emit("global_ranking", sorted);
});

socket.on("leave_group", ({ groupId }) => {
  const group = groups[groupId];
  const state = states[groupId];
  if (!group || !state) return;

  // groups から削除
  group.players = group.players.filter(p => p.id !== socket.id);

  // states から削除
  state.players = state.players.filter(p => p.id !== socket.id);

  // Socket.IO のルームからも抜ける
  socket.leave(groupId);

  console.log(`🚪 ${socket.id} が ${groupId} を離脱`);
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
  if (!state.answered && !state.waitingNext && state.current && state.current.text === latestText) {
    state.waitingNext = true;
    io.to(groupId).emit("state", sanitizeState(state));
    setTimeout(() => nextQuestion(groupId), 1000);
  }
}, 30000);

// ✅ タイマー開始時にクライアントに通知（new）
io.to(groupId).emit("timer_start", { seconds: 30 });
});

socket.on("host_assign_groups", ({ groupCount, playersPerGroup, topGroupCount }) => {
  if (socket.id !== hostSocketId) return;

  const allPlayers = [];
  for (const group of Object.values(groups)) {
    for (const p of group.players) {
      if (p.name !== "未設定") {
        allPlayers.push(p);
      }
    }
  }

  // スコア順にソート（降順）
  allPlayers.sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));

  // グループの枠を用意
  const newGroups = {};
  for (let i = 1; i <= groupCount; i++) {
    newGroups[`group${i}`] = [];
  }

  // 上位者を topGroupCount グループに優先割り振り
  const topCount = topGroupCount * playersPerGroup;
  const topPlayers = allPlayers.slice(0, topCount);
  const others = allPlayers.slice(topCount);

  // 上位者を round-robin でグループ1～topGroupCount に入れる
  topPlayers.forEach((p, idx) => {
    const gnum = (idx % topGroupCount) + 1;
    newGroups[`group${gnum}`].push(p);
  });

  // 残りのプレイヤーをランダムに group(topGroupCount+1)～groupCount に分ける
  const restGroups = [];
  for (let i = topGroupCount + 1; i <= groupCount; i++) {
    restGroups.push(`group${i}`);
  }

  shuffle(others).forEach((p, idx) => {
    const groupId = restGroups[idx % restGroups.length];
    newGroups[groupId].push(p);
  });

  // グローバルgroupsを上書き
 // グローバルgroupsを上書き & statesも完全に再初期化
for (let i = 1; i <= groupCount; i++) {
  const groupId = `group${i}`;
  const players = newGroups[groupId] || [];

  // 🔄 完全上書き（旧データ削除）
  groups[groupId] = { players };

  // 🔄 以前のstateを削除（ここが重要！）
  if (states[groupId]) delete states[groupId];

  // 新たにstate初期化
  states[groupId] = initState(groupId);

  // プレイヤーを新たに構築（←残存データを防止）
  states[groupId].players = players.map(p => ({
    id: p.id,
    name: p.name,
    hp: 20,
    score: 0,
    correctCount: 0
  }));
}



// 各プレイヤーにグループ番号を通知＆正しいルームにjoinさせる
// 🔁 プレイヤーを正しいグループへ再参加（join）＆通知
for (const [groupId, group] of Object.entries(groups)) {
  for (const p of group.players) {
    const socketInstance = io.sockets.sockets.get(p.id);
    if (socketInstance) {
      for (const room of socketInstance.rooms) {
        if (room !== p.id) socketInstance.leave(room);
      }
      socketInstance.join(groupId);
      socketInstance.emit("assigned_group", groupId);
    }
  }
}


  console.log("✅ グループ割り振り完了");
});

  
socket.on("host_join", () => {
  hostSocketId = socket.id;
  console.log("👑 ホストが接続しました:", socket.id);
});

socket.on("host_request_state", () => {
  if (socket.id !== hostSocketId) return; // ホスト以外は無視

  const result = {};

  for (const [groupId, group] of Object.entries(groups)) {
    result[groupId] = {
      locked: states[groupId]?.locked ?? false, 
      players: group.players.map(p => ({
        name: p.name,
        hp: p.hp,
        correctCount: p.correctCount,
        totalScore: p.totalScore
      }))
    };
  }

  socket.emit("host_state", result);
});

socket.on("host_start", () => {
  if (socket.id !== hostSocketId) return;

  console.log("▶ ホストが全体スタートを実行");

  // グループ1～10まで強制的に全て扱う
  for (let i = 1; i <= 10; i++) {
    const groupId = `group${i}`;

    // 必要に応じて初期化
    if (!groups[groupId]) groups[groupId] = { players: [] };
    if (!states[groupId]) states[groupId] = initState(groupId);

    const state = states[groupId];
    const group = groups[groupId];

    // プレイヤーが存在しないグループにも空の初期化状態を与える
    state.players = group.players.map(p => ({
      id: p.id,
      name: p.name || "未設定",
      hp: 20,
      score: 0,
      correctCount: 0
    }));

    // スコアなどを初期化
    group.players.forEach(p => {
      p.hp = 20;
      p.score = 0;
      p.correctCount = 0;
    });

    state.locked = false;
    state.eliminatedOrder = [];
    state.questionCount = 0;
    state.usedQuestions = [];
    state.readDone = new Set();
    state.answered = false;
    state.waitingNext = false;
    state.misClicks = [];

    nextQuestion(groupId); // 強制出題（プレイヤー0人でも）
  }
});


  
socket.on("start", ({ groupId }) => {
  if (socket.id !== hostSocketId) return; // ← 追加
  console.log(`▶ 強制スタート: ${groupId}`);
  const state = states[groupId];
  const group = groups[groupId];
  if (!state || !group) return;

  state.locked = false; // ✅ ここで locked フラグを解除して再スタートできるようにする

  // プレイヤー状態を初期化
  state.players.forEach(p => {
    p.hp = 20;
    p.score = 0;
    p.correctCount = 0;
  });
  group.players.forEach(p => {
    p.hp = 20;
    p.score = 0;
    p.correctCount = 0;
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

  if (player.hp <= 0) return;

  const point = state.current.point;

  if (correct) {
    player.score += point;
    player.correctCount = (player.correctCount || 0) + 1;

    const sp = state.players.find(sp => sp.id === player.id);
    if (sp) sp.correctCount = (sp.correctCount || 0) + 1;

    state.current.cards = state.current.cards.map(c =>
      c.number === number ? { ...c, correct: true, chosenBy: name } : c
    );
    state.answered = true;

    group.players.forEach(p => {
      if (p.name !== name) {
        p.hp = Math.max(0, p.hp - point);
        const sp = state.players.find(sp => sp.id === p.id);
        if (sp) sp.hp = p.hp;

        if (p.hp <= 0 && !state.eliminatedOrder.includes(p.name)) {
          state.eliminatedOrder.push(p.name);
        }
      }
    });

    if (!state.waitingNext) {
      state.waitingNext = true;
      io.to(groupId).emit("state", sanitizeState(state));

      checkGameEnd(groupId);
      if (!state.locked) {
        setTimeout(() => nextQuestion(groupId), 3000);
      }
    }
  } else {
    // ✅ これが正しく「不正解時」に対応！
    player.hp -= point;
    const sp = state.players.find(sp => sp.id === player.id);
    if (sp) sp.hp = player.hp;

    if (player.hp <= 0) {
      player.hp = 0;
      if (sp) sp.hp = 0;
      if (!state.eliminatedOrder.includes(player.name)) {
        state.eliminatedOrder.push(player.name);
      }
    }

    state.misClicks.push({ name, number });
    state.current.cards = state.current.cards.map(c =>
      c.number === number ? { ...c, incorrect: true, chosenBy: name } : c
    );

    io.to(groupId).emit("state", sanitizeState(state));
    checkGameEnd(groupId);
    // 全員お手つきチェック（生存者のみ対象）
const activePlayers = state.players.filter(p => p.hp > 0);
const misSet = new Set(state.misClicks.map(mc => mc.name));
const allMisclicked = activePlayers.every(p => misSet.has(p.name));

if (allMisclicked && !state.waitingNext) {
  console.log("⚠ 全員お手つき");

  // 正解カードを目立たせる（正解表示用フラグを追加）
  state.current.cards = state.current.cards.map(c =>
    c.number === state.current.answer
      ? { ...c, correctAnswer: true }
      : c
  );

  state.waitingNext = true;
  io.to(groupId).emit("state", sanitizeState(state));

  setTimeout(() => nextQuestion(groupId), 3000);
}

  }
});


// 他の関数（例：nextQuestionなど）の下あたりに追加
function checkGameEnd(groupId) {
  const state = states[groupId];
  if (!state) return;

  if (state.locked) return; // ✅ すでに終了処理したら二重実行させない

  const survivors = state.players.filter(p => p.hp > 0);

  if (survivors.length === 1) {
    const eliminated = [...(state.eliminatedOrder || [])].reverse();

    const ranked = [survivors[0], ...eliminated
      .map(name => state.players.find(p => p.name === name))
      .filter(p => p !== undefined)];

    const alreadyUpdated = new Set(); // ✅ 2重加算防止

    ranked.forEach((p, i) => {
      const correctCount = p.correctCount || 0;
      let bonus = 0;
      if (i === 0) bonus = 200;
      else if (i === 1) bonus = 100;
      p.finalScore = correctCount * 10 + bonus;

      const gPlayer = groups[groupId].players.find(gp => gp.id === p.id);
      if (gPlayer && !alreadyUpdated.has(gPlayer.id)) {
        gPlayer.totalScore = (gPlayer.totalScore || 0) + p.finalScore;
        p.totalScore = gPlayer.totalScore;
        alreadyUpdated.add(gPlayer.id); // ✅ 一度だけ加算
      } else {
        p.totalScore = gPlayer?.totalScore ?? p.finalScore;
      }
    });

    ranked.sort((a, b) => b.finalScore - a.finalScore);

    io.to(groupId).emit("end", ranked);
    state.locked = true;
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
  if (!state || state.locked) return; // ✅ 終了していれば出題しない


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
    current: state.current
      ? {
          ...state.current,
          pointValue: state.current.point
        }
      : null,
    misClicks: state.misClicks,
    showSpeed: state.showSpeed,
    waitingNext: state.waitingNext,
    answered: state.answered,
    locked: state.locked   // ← ✅ 追加（ゲーム終了フラグ）
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

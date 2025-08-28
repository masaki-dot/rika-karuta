// server.js (修正版)

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// --- グローバル変数 ---
let hostSocketId = null;
let globalCards = [];
let globalSettings = {
  maxQuestions: 10,
  numCards: 5,
  showSpeed: 2000
};
let gamePhase = 'INITIAL';

const states = {};
const groups = {};

// -------------------------------------------------------------------
// ▼▼▼ ヘルパー関数群 ▼▼▼
// -------------------------------------------------------------------

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
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
    readDone: new Set(),
    readTimer: null,
    eliminatedOrder: [],
    locked: false
  };
}

function sanitizeState(state) {
  if (!state) return null;
  return {
    groupId: state.groupId,
    players: state.players,
    questionCount: state.questionCount,
    maxQuestions: state.maxQuestions,
    current: state.current
      ? {
          ...state.current,
          pointValue: state.current.point,
          cards: state.current.cards
        }
      : null,
    misClicks: state.misClicks,
    showSpeed: state.showSpeed,
    waitingNext: state.waitingNext,
    answered: state.answered,
    locked: state.locked
  };
}

function getHostState() {
  const result = {};
  for (const [groupId, group] of Object.entries(groups)) {
    const state = states[groupId];
    result[groupId] = {
      locked: state?.locked ?? false,
      players: group.players.map(p => ({
        name: p.name,
        hp: state?.players.find(sp => sp.id === p.id)?.hp ?? 20,
        correctCount: state?.players.find(sp => sp.id === p.id)?.correctCount ?? 0,
        totalScore: p.totalScore ?? 0
      }))
    };
  }
  return result;
}

// ★★★ ゲーム終了ロジックをこの関数に共通化 ★★★
function finalizeGame(groupId) {
    const state = states[groupId];
    if (!state || state.locked) return; // 既に処理済みなら何もしない

    state.locked = true;
    console.log(`[${groupId}] ゲーム終了処理を開始します。`);

    let finalRanking;
    const survivors = state.players.filter(p => p.hp > 0);

    if (survivors.length <= 1) { // 生存者基準で終了
        const eliminated = [...(state.eliminatedOrder || [])].reverse();
        finalRanking = [
            ...(survivors.length === 1 ? [survivors[0]] : []),
            ...eliminated.map(name => state.players.find(p => p.name === name)).filter(p => p)
        ];
    } else { // 問題切れなど、複数人生存している場合
        finalRanking = [...state.players].sort((a, b) => {
            if (b.hp !== a.hp) return b.hp - a.hp; // 1. HPが高い
            return (b.correctCount || 0) - (a.correctCount || 0); // 2. 正解数が多い
        });
    }

    // --- スコア計算ロジック (共通) ---
    const alreadyUpdated = new Set();
    finalRanking.forEach((p, i) => {
        const correctCount = p.correctCount || 0;
        let bonus = 0;
        if (i === 0) bonus = 200;
        else if (i === 1) bonus = 100;

        p.finalScore = (correctCount * 10) + bonus;

        const gPlayer = groups[groupId]?.players.find(gp => gp.id === p.id);
        if (gPlayer && !alreadyUpdated.has(gPlayer.id)) {
            gPlayer.totalScore = (gPlayer.totalScore || 0) + p.finalScore;
            p.totalScore = gPlayer.totalScore;
            alreadyUpdated.add(gPlayer.id);
        } else {
            p.totalScore = gPlayer?.totalScore ?? p.finalScore;
        }
    });

    finalRanking.sort((a, b) => b.finalScore - a.finalScore);
    io.to(groupId).emit("end", finalRanking);
}

function checkGameEnd(groupId) {
  const state = states[groupId];
  if (!state || state.locked) return;

  const survivors = state.players.filter(p => p.hp > 0);
  if (survivors.length <= 1) {
    finalizeGame(groupId); // 共通関数を呼び出す
  }
}

function nextQuestion(groupId) {
    const state = states[groupId];
    if (!state || state.locked) return;

    if (state.readTimer) {
        clearTimeout(state.readTimer);
        state.readTimer = null;
    }

    const remaining = globalCards.filter(q => !state.usedQuestions.includes(q.text.trim() + q.number));

    // 問題が尽きた、または規定問題数に達した場合
    if (remaining.length === 0 || state.questionCount >= state.maxQuestions) {
        finalizeGame(groupId); // 共通関数を呼び出して終了
        return;
    }

    const question = remaining[Math.floor(Math.random() * remaining.length)];
    const key = question.text.trim() + question.number;
    state.usedQuestions.push(key);

    const distractors = shuffle(globalCards.filter(c => c.number !== question.number)).slice(0, state.numCards - 1);
    const cards = shuffle([...distractors, question]);

    let point = 1;
    const rand = Math.random();
    if (rand < 0.05) point = 5;
    else if (rand < 0.2) point = 3;
    else if (rand < 0.6) point = 2;

    state.current = {
        text: question.text,
        answer: question.number,
        point,
        cards: cards.map(c => ({ number: c.number, term: c.term }))
    };
    state.questionCount++;
    state.waitingNext = false;
    state.answered = false;
    state.readDone = new Set();
    state.misClicks = [];

    io.to(groupId).emit("state", sanitizeState(state));
}

// -------------------------------------------------------------------
// ▼▼▼ メインの接続処理 ▼▼▼
// -------------------------------------------------------------------
io.on("connection", (socket) => {
  console.log(`✅ プレイヤーが接続しました: ${socket.id}`);

  socket.on('request_game_phase', () => {
    socket.emit('game_phase_response', { phase: gamePhase });
  });
  
  socket.on("set_cards_and_settings", ({ cards, settings }) => {
    globalCards = [...cards];
    globalSettings = { ...globalSettings, ...settings };
    
    Object.keys(states).forEach(key => delete states[key]);
    Object.keys(groups).forEach(key => delete groups[key]);
    gamePhase = 'GROUP_SELECTION';
    
    io.emit("start_group_selection");
  });

  socket.on("join", (groupId) => {
    socket.join(groupId);
    if (!groups[groupId]) groups[groupId] = { players: [] };
    if (!groups[groupId].players.find(p => p.id === socket.id)) {
      groups[groupId].players.push({ id: socket.id, name: "未設定", totalScore: 0 });
    }
    
    if (!states[groupId]) states[groupId] = initState(groupId);
    const state = states[groupId];
    if (!state.players.find(p => p.id === socket.id)) {
      state.players.push({ id: socket.id, name: "未設定", hp: 20 });
    }
    
    io.to(groupId).emit("state", sanitizeState(state));
  });

  socket.on("leave_group", ({ groupId }) => {
    socket.leave(groupId);
    if (groups[groupId]) {
      groups[groupId].players = groups[groupId].players.filter(p => p.id !== socket.id);
    }
    if (states[groupId]) {
      states[groupId].players = states[groupId].players.filter(p => p.id !== socket.id);
    }
    console.log(`🚪 ${socket.id} が ${groupId} を離脱`);
  });

  socket.on("set_name", ({ groupId, name }) => {
    const state = states[groupId];
    if (state?.players) {
        const player = state.players.find(p => p.id === socket.id);
        if (player) player.name = name;
    }
    const gplayer = groups[groupId]?.players.find(p => p.id === socket.id);
    if (gplayer) gplayer.name = name;
    
    if (state) {
      io.to(groupId).emit("state", sanitizeState(state));
    }
  });
  
  socket.on("read_done", (groupId) => {
    const state = states[groupId];
    if (!state || !state.current || state.readTimer || state.answered || state.waitingNext) {
        return;
    }
    
    const latestText = state.current.text;
    console.log(`[${groupId}] 最初の読み込み完了。タイマーを開始します。`);
    
    io.to(groupId).emit("timer_start", { seconds: 30 });
    
    state.readTimer = setTimeout(() => {
        if (state && !state.answered && !state.waitingNext && state.current?.text === latestText) {
            console.log(`[${groupId}] 30秒タイムアウト。次の問題へ。`);
            state.waitingNext = true;
            const correctCard = state.current.cards.find(c => c.number === state.current.answer);
            if (correctCard) {
                correctCard.correctAnswer = true;
            }
            io.to(groupId).emit("state", sanitizeState(state));
            
            setTimeout(() => nextQuestion(groupId), 3000);
        }
    }, 30000);
  });

  socket.on("host_join", () => {
    hostSocketId = socket.id;
    console.log("👑 ホストが接続しました:", socket.id);
  });

  socket.on("host_request_state", () => {
    if (socket.id === hostSocketId) {
      socket.emit("host_state", getHostState());
    }
  });
  
  socket.on("request_global_ranking", () => {
      const allPlayers = Object.values(groups)
          .flatMap(g => g.players)
          .filter(p => p.name !== "未設定")
          .map(p => ({ name: p.name, totalScore: p.totalScore || 0 }));
          
      const sorted = allPlayers.sort((a, b) => b.totalScore - a.totalScore);
      socket.emit("global_ranking", sorted);
  });

  socket.on("host_start", () => {
    if (socket.id !== hostSocketId) return;
    console.log("▶ ホストが全体スタートを実行");

    for (const groupId of Object.keys(groups)) {
        if (groups[groupId].players.length === 0) continue;

        states[groupId] = initState(groupId);
        const state = states[groupId];
        const group = groups[groupId];

        state.players = group.players.map(p => ({ id: p.id, name: p.name, hp: 20, score: 0, correctCount: 0 }));
        
        nextQuestion(groupId);
    }
  });
  
  socket.on("host_assign_groups", ({ groupCount, playersPerGroup, topGroupCount }) => {
    if (socket.id !== hostSocketId) return;

    const allPlayersSorted = Object.values(groups)
        .flatMap(g => g.players)
        .filter(p => p.name !== "未設定")
        .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));

    const topPlayerCount = topGroupCount * playersPerGroup;
    const topPlayers = allPlayersSorted.slice(0, topPlayerCount);
    const otherPlayers = allPlayersSorted.slice(topPlayerCount);
    const shuffledOtherPlayers = shuffle(otherPlayers);
    const finalPlayerList = [...topPlayers, ...shuffledOtherPlayers];

    const newGroupsConfig = {};
    for (let i = 1; i <= groupCount; i++) newGroupsConfig[i] = [];

    let playerIndex = 0;
    for (let i = 1; i <= groupCount; i++) {
        while (newGroupsConfig[i].length < playersPerGroup && playerIndex < finalPlayerList.length) {
            newGroupsConfig[i].push(finalPlayerList[playerIndex]);
            playerIndex++;
        }
    }
    while (playerIndex < finalPlayerList.length) {
        for (let i = groupCount; i >= 1; i--) {
            if (playerIndex >= finalPlayerList.length) break;
            newGroupsConfig[i].push(finalPlayerList[playerIndex]);
            playerIndex++;
        }
    }

    Object.keys(groups).forEach(key => delete groups[key]);
    Object.keys(states).forEach(key => delete states[key]);

    for (let i = 1; i <= groupCount; i++) {
        const players = newGroupsConfig[i];
        if (players.length === 0) continue;
        const groupId = `group${i}`;
        groups[groupId] = { players };
        states[groupId] = initState(groupId);
        states[groupId].players = players.map(p => ({ id: p.id, name: p.name, hp: 20, score: 0, correctCount: 0 }));
    }

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
    console.log("✅ 上位固定＆その他ランダムのロジックでグループ割り振り完了");

    if (hostSocketId) {
        io.to(hostSocketId).emit("host_state", getHostState());
    }
  });

  socket.on("answer", ({ groupId, name, number }) => {
    const state = states[groupId];
    if (!state || !state.current || state.answered || state.locked) return;
    
    const playerState = state.players.find(p => p.name === name);
    if (!playerState || playerState.hp <= 0) return;

    const correct = state.current.answer === number;
    const point = state.current.point;

    if (correct) {
        state.answered = true;
        playerState.correctCount = (playerState.correctCount || 0) + 1;
        
        state.current.cards.find(c => c.number === number).correct = true;
        state.current.cards.find(c => c.number === number).chosenBy = name;
        
        state.players.forEach(p => {
            if (p.name !== name) {
                p.hp = Math.max(0, p.hp - point);
                if (p.hp <= 0 && !state.eliminatedOrder.includes(p.name)) {
                    state.eliminatedOrder.push(p.name);
                }
            }
        });
        
        io.to(groupId).emit("state", sanitizeState(state));
        checkGameEnd(groupId);
        if (!state.locked) setTimeout(() => nextQuestion(groupId), 3000);

    } else {
        playerState.hp -= point;
        if (playerState.hp <= 0) {
            playerState.hp = 0;
            if (!state.eliminatedOrder.includes(playerState.name)) {
                state.eliminatedOrder.push(playerState.name);
            }
        }
        state.misClicks.push({ name, number });
        state.current.cards.find(c => c.number === number).incorrect = true;
        state.current.cards.find(c => c.number === number).chosenBy = name;
        
        io.to(groupId).emit("state", sanitizeState(state));
        checkGameEnd(groupId);
    }
  });

  socket.on("disconnect", () => {
    console.log(`🔌 プレイヤーが切断しました: ${socket.id}`);
    for (const groupId in groups) {
      const playerIndex = groups[groupId].players.findIndex(p => p.id === socket.id);
      if (playerIndex > -1) {
        const playerName = groups[groupId].players[playerIndex].name;
        console.log(`👻 ${groupId} から ${playerName} を削除します`);
        groups[groupId].players.splice(playerIndex, 1);
        
        const state = states[groupId];
        if (state?.players) {
          const statePlayerIndex = state.players.findIndex(p => p.id === socket.id);
          if (statePlayerIndex > -1) {
            state.players.splice(statePlayerIndex, 1);
          }
          if (state && !state.locked && playerName !== "未設定") {
             checkGameEnd(groupId);
          }
          io.to(groupId).emit("state", sanitizeState(state));
        }
        
        if (hostSocketId) {
          io.to(hostSocketId).emit("host_state", getHostState());
        }
        break;
      }
    }
  });
});

// サーバーを起動
const PORT = process.env.PORT || 3000; // ポートを3000に変更
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

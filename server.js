// server.js (改善・完全版)

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require('fs'); // ← ファイルシステムモジュールを追加
const { v4: uuidv4 } = require('uuid');

// (app, server, io の設定...)

app.use(express.static(path.join(__dirname, "public")));

const USER_PRESETS_DIR = path.join(__dirname, 'data', 'user_presets'); // ← ユーザーが保存した問題を置くフォルダのパスを定義

// --- グローバル変数 ---
let hostSocketId = null;
let globalCards = [];
let globalSettings = {};
let gamePhase = 'INITIAL';
let questionPresets = {};

// --- データ管理 ---
const players = {};
const groups = {};
const states = {};
const singlePlayStates = {};
const singlePlayRankings = {};

// --- サーバー初期化処理 ---
function loadPresets() {
  try {
    const data = fs.readFileSync(path.join(__dirname, 'data', 'questions.json'), 'utf8');
    questionPresets = JSON.parse(data);
    console.log('✅ 問題プリセットを読み込みました。');
  } catch (err) {
    console.error('⚠️ 問題プリセットの読み込みに失敗しました:', err);
  }
}
loadPresets();

// --- ヘルパー関数群 ---
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}
function getPlayerBySocketId(socketId) {
    return Object.values(players).find(p => p.socketId === socketId);
}

// --- マルチプレイ用ヘルパー ---
function initState(groupId) {
  return {
    groupId,
    players: [],
    questionCount: 0,
    maxQuestions: globalSettings.maxQuestions || 10,
    numCards: globalSettings.numCards || 5,
    showSpeed: globalSettings.showSpeed || 1000,
    gameMode: globalSettings.gameMode || 'normal',
    current: null, answered: false, waitingNext: false,
    misClicks: [], usedQuestions: [], readDone: new Set(),
    readTimer: null, eliminatedOrder: [], locked: false
  };
}

function sanitizeState(state) {
  if (!state) return null;
  const currentWithPoint = state.current ? { ...state.current, point: state.current.point } : null;
  return {
    groupId: state.groupId,
    players: state.players,
    questionCount: state.questionCount,
    maxQuestions: state.maxQuestions,
    gameMode: state.gameMode,
    showSpeed: state.showSpeed,
    current: currentWithPoint,
    locked: state.locked,
    answered: state.answered,
  };
}

function getHostState() {
  const result = {};
  for (const [groupId, group] of Object.entries(groups)) {
    const state = states[groupId];
    result[groupId] = {
      locked: state?.locked ?? false,
      gameMode: state?.gameMode ?? globalSettings.gameMode ?? 'normal',
      players: group.players.map(p => {
        const statePlayer = state?.players.find(sp => sp.playerId === p.playerId);
        return {
          name: p.name,
          hp: statePlayer?.hp ?? 20,
          correctCount: statePlayer?.correctCount ?? 0,
          totalScore: p.totalScore ?? 0
        };
      })
    };
  }
  return result;
}

function finalizeGame(groupId) {
    const state = states[groupId];
    if (!state || state.locked) return;

    if (state.readTimer) clearTimeout(state.readTimer);
    state.readTimer = null;

    state.locked = true;
    console.log(`[${groupId}] ゲーム終了処理を開始します。`);

    const finalRanking = [...state.players].sort((a, b) => {
        if (b.hp !== a.hp) return b.hp - a.hp;
        return (b.correctCount || 0) - (a.correctCount || 0);
    });

    const alreadyUpdated = new Set();
    finalRanking.forEach((p, i) => {
        const correctCount = p.correctCount || 0;
        let bonus = 0;
        if (i === 0) bonus = 200;
        else if (i === 1) bonus = 100;
        p.finalScore = (correctCount * 10) + bonus;

        const gPlayer = groups[groupId]?.players.find(gp => gp.playerId === p.playerId);
        if (gPlayer && !alreadyUpdated.has(gPlayer.playerId)) {
            gPlayer.totalScore = (gPlayer.totalScore || 0) + p.finalScore;
            p.totalScore = gPlayer.totalScore;
            alreadyUpdated.add(gPlayer.playerId);
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
    finalizeGame(groupId);
  }
}

function nextQuestion(groupId) {
    const state = states[groupId];
    if (!state || state.locked) return;

    if (state.readTimer) clearTimeout(state.readTimer);
    state.readTimer = null;
    
    const remaining = globalCards.filter(q => !state.usedQuestions.includes(q.text.trim() + q.number));
    if (remaining.length === 0 || state.questionCount >= state.maxQuestions) {
        return finalizeGame(groupId);
    }

    const question = remaining[Math.floor(Math.random() * remaining.length)];
    state.usedQuestions.push(question.text.trim() + question.number);

    const distractors = shuffle(globalCards.filter(c => c.number !== question.number)).slice(0, state.numCards - 1);
    const cards = shuffle([...distractors, question]);

    let point = 1;
    const rand = Math.random();
    if (rand < 0.05) { // 5%
        point = 5;
    } else if (rand < 0.20) { // 15%
        point = 3;
    } else if (rand < 0.60) { // 40%
        point = 2;
    }

    const originalText = question.text;
    let maskedIndices = [];
    if (state.gameMode === 'mask') {
        let indices = Array.from({length: originalText.length}, (_, i) => i);
        indices = indices.filter(i => originalText[i] !== ' ' && originalText[i] !== '　');
        shuffle(indices);
        maskedIndices = indices.slice(0, Math.floor(indices.length / 2));
    }
    
    state.current = {
        text: originalText,
        maskedIndices: maskedIndices,
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

// --- シングルプレイ用ヘルパー ---
function nextSingleQuestion(socketId) {
    const state = singlePlayStates[socketId];
    if (!state || state.questionCount >= state.maxQuestions) {
        const finalScore = state.score;
        const presetId = state.presetId;

        if (!singlePlayRankings[presetId]) singlePlayRankings[presetId] = [];
        singlePlayRankings[presetId].push({ name: state.name, score: finalScore, difficulty: state.difficulty });
        singlePlayRankings[presetId].sort((a, b) => b.score - a.score);
        if (singlePlayRankings[presetId].length > 10) singlePlayRankings[presetId].pop();
        
        io.to(socketId).emit('single_game_end', {
            score: finalScore,
            ranking: singlePlayRankings[presetId]
        });
        delete singlePlayStates[socketId];
        return;
    }

    const question = state.questions[state.questionCount];
    const distractors = shuffle(state.allCards.filter(c => c.number !== question.number)).slice(0, 3);
    const cards = shuffle([...distractors, question]);

    const originalText = question.text;
    let indices = Array.from({length: originalText.length}, (_, i) => i);
    indices = indices.filter(i => originalText[i] !== ' ' && originalText[i] !== '　');
    shuffle(indices);
    const maskedIndices = indices.slice(0, Math.floor(indices.length / 2));

    state.current = {
        text: originalText,
        maskedIndices: maskedIndices,
        answer: question.number,
        cards: cards.map(c => ({ number: c.number, term: c.term }))
    };
    state.questionCount++;
    state.answered = false;
    state.startTime = Date.now();

    io.to(socketId).emit('single_game_state', state);
    simulateCPUAnswer(socketId);
}

function simulateCPUAnswer(socketId) {
    const state = singlePlayStates[socketId];
    if (!state) return;
    const { difficulty, current } = state;

    const params = {
        easy:   { accuracy: 0.7, minSpeed: 3000, maxSpeed: 5000 },
        normal: { accuracy: 0.85, minSpeed: 2000, maxSpeed: 4000 },
        hard:   { accuracy: 0.95, minSpeed: 1000, maxSpeed: 3000 }
    };
    const cpu = params[difficulty] || params.normal;
    const answerTime = Math.random() * (cpu.maxSpeed - cpu.minSpeed) + cpu.minSpeed;

    setTimeout(() => {
        const currentState = singlePlayStates[socketId];
        if (!currentState || currentState.answered) return;
        
        currentState.answered = true;
        const cpuCorrect = Math.random() < cpu.accuracy;
        const card = currentState.current.cards.find(c => c.number === current.answer);
        
        if (cpuCorrect) {
            card.correctAnswer = true;
            card.isCPU = true;
        }

        io.to(socketId).emit('single_game_state', currentState);
        setTimeout(() => nextSingleQuestion(socketId), 3000);
    }, answerTime);
}

// --- メインの接続処理 ---
io.on("connection", (socket) => {
  console.log(`✅ プレイヤーが接続しました: ${socket.id}`);

  socket.on('request_new_player_id', () => {
    const playerId = uuidv4();
    players[playerId] = { playerId, socketId: socket.id, name: "未設定" };
    socket.emit('new_player_id_assigned', playerId);
  });

  socket.on('reconnect_player', ({ playerId, name }) => {
    if (players[playerId]) {
      players[playerId].socketId = socket.id;
      if (name) players[playerId].name = name;
    } else {
      players[playerId] = { playerId, socketId: socket.id, name: name || "未設定" };
    }
    console.log(`🔄 ${players[playerId].name}(${playerId.substring(0,4)})が再接続しました。`);
  });

  socket.on('request_game_phase', () => {
    const presetsForClient = {};
    for(const [id, data] of Object.entries(questionPresets)) {
        presetsForClient[id] = { category: data.category, name: data.name };
    }
    socket.emit('game_phase_response', { phase: gamePhase, presets: presetsForClient });
  });

  socket.on("set_preset_and_settings", ({ presetId, settings }) => {
    if (questionPresets[presetId]) {
        globalCards = [...questionPresets[presetId].cards]; // シャッフルしない
        globalSettings = { ...settings, maxQuestions: globalCards.length };
        Object.keys(states).forEach(key => delete states[key]);
        Object.keys(groups).forEach(key => delete groups[key]);
        gamePhase = 'GROUP_SELECTION';
        io.emit("start_group_selection");
    }
  });

  socket.on("set_cards_and_settings", ({ cards, settings }) => {
    globalCards = [...cards];
    globalSettings = { ...settings, maxQuestions: cards.length };
    Object.keys(states).forEach(key => delete states[key]);
    Object.keys(groups).forEach(key => delete groups[key]);
    gamePhase = 'GROUP_SELECTION';
    io.emit("start_group_selection");
  });

  socket.on("join", ({ groupId, playerId }) => {
    socket.join(groupId);
    const player = players[playerId];
    if (!player) return;
    
    if (!groups[groupId]) groups[groupId] = { players: [] };
    if (!groups[groupId].players.find(p => p.playerId === playerId)) {
      groups[groupId].players.push({ playerId, name: player.name, totalScore: 0 });
    }
    
    if (!states[groupId]) states[groupId] = initState(groupId);
    const state = states[groupId];
    if (!state.players.find(p => p.playerId === playerId)) {
      state.players.push({ playerId, name: player.name, hp: 20, correctCount: 0 });
    }
    
    io.to(groupId).emit("state", sanitizeState(state));
  });

  socket.on("leave_group", ({ groupId, playerId }) => {
    socket.leave(groupId);
    if (groups[groupId]) {
      groups[groupId].players = groups[groupId].players.filter(p => p.playerId !== playerId);
    }
    if (states[groupId]) {
      states[groupId].players = states[groupId].players.filter(p => p.playerId !== playerId);
    }
  });

  socket.on("set_name", ({ groupId, playerId, name }) => {
    if (players[playerId]) players[playerId].name = name;
    
    const state = states[groupId];
    if (state?.players) {
        const player = state.players.find(p => p.playerId === playerId);
        if (player) player.name = name;
    }
    const gPlayer = groups[groupId]?.players.find(p => p.playerId === playerId);
    if (gPlayer) gPlayer.name = name;

    if (state) {
      io.to(groupId).emit("state", sanitizeState(state));
    }
  });
  
  socket.on("read_done", (groupId) => {
    const state = states[groupId];
    if (!state || !state.current || state.readTimer || state.answered || state.waitingNext) return;
    
    const latestText = state.current.text;
    io.to(groupId).emit("timer_start", { seconds: 30 });
    
    state.readTimer = setTimeout(() => {
        if (state && !state.answered && !state.waitingNext && state.current?.text === latestText) {
            state.waitingNext = true;
            const correctCard = state.current.cards.find(c => c.number === state.current.answer);
            if (correctCard) correctCard.correctAnswer = true;
            io.to(groupId).emit("state", sanitizeState(state));
            setTimeout(() => nextQuestion(groupId), 3000);
        }
    }, 30000);
  });

  socket.on("host_join", ({ playerId }) => {
    hostSocketId = socket.id;
    if (players[playerId]) players[playerId].isHost = true;
    console.log("👑 ホストが接続しました:", players[playerId]?.name);
  });

  socket.on("host_request_state", () => {
    if (socket.id === hostSocketId) socket.emit("host_state", getHostState());
  });
  
  socket.on("request_global_ranking", () => {
      const allPlayers = Object.values(groups)
          .flatMap(g => g.players)
          .filter(p => p.name !== "未設定")
          .map(p => ({ name: p.name, totalScore: p.totalScore || 0 }));
      socket.emit("global_ranking", allPlayers.sort((a, b) => b.totalScore - a.totalScore));
  });

  socket.on("host_start", () => {
    if (socket.id !== hostSocketId) return;
    console.log("▶ ホストが全体スタートを実行");

    for (const groupId of Object.keys(groups)) {
        if (groups[groupId].players.length === 0) continue;
        
        if (states[groupId] && states[groupId].readTimer) {
            clearTimeout(states[groupId].readTimer);
        }

        // グループごとのモードを維持しつつstateを再初期化
        const currentGroupMode = states[groupId]?.gameMode || globalSettings.gameMode;
        states[groupId] = initState(groupId);
        states[groupId].gameMode = currentGroupMode;

        const state = states[groupId];
        const group = groups[groupId];

        state.players = group.players.map(p => ({ 
            playerId: p.playerId, name: p.name, hp: 20, score: 0, correctCount: 0 
        }));
        
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
    const finalPlayerList = [...topPlayers, ...shuffle(otherPlayers)];
    const newGroupsConfig = {};
    for (let i = 1; i <= groupCount; i++) newGroupsConfig[i] = [];
    let playerIndex = 0;
    for (let i = 1; i <= groupCount; i++) {
        while (newGroupsConfig[i].length < playersPerGroup && playerIndex < finalPlayerList.length) {
            newGroupsConfig[i].push(finalPlayerList[playerIndex++]);
        }
    }
    while (playerIndex < finalPlayerList.length) {
        for (let i = groupCount; i >= 1; i--) {
            if (playerIndex >= finalPlayerList.length) break;
            newGroupsConfig[i].push(finalPlayerList[playerIndex++]);
        }
    }
    Object.keys(groups).forEach(key => delete groups[key]);
    Object.keys(states).forEach(key => delete states[key]);
    for (let i = 1; i <= groupCount; i++) {
        const playersInGroup = newGroupsConfig[i];
        if (playersInGroup.length === 0) continue;
        const groupId = `group${i}`;
        groups[groupId] = { players: playersInGroup };
        states[groupId] = initState(groupId);
        states[groupId].players = playersInGroup.map(p => ({ playerId: p.playerId, name: p.name, hp: 20, score: 0, correctCount: 0 }));
    }
    for (const [groupId, group] of Object.entries(groups)) {
        for (const p of group.players) {
            const playerSocket = io.sockets.sockets.get(players[p.playerId]?.socketId);
            if (playerSocket) {
                for (const room of playerSocket.rooms) {
                    if (room !== playerSocket.id) playerSocket.leave(room);
                }
                playerSocket.join(groupId);
                playerSocket.emit("assigned_group", groupId);
            }
        }
    }
    if (hostSocketId) io.to(hostSocketId).emit("host_state", getHostState());
  });

  socket.on("answer", ({ groupId, playerId, name, number }) => {
    const state = states[groupId];
    if (!state || !state.current || state.answered || state.locked) return;
    
    const playerState = state.players.find(p => p.playerId === playerId);
    if (!playerState || playerState.hp <= 0) return;

    const correct = state.current.answer === number;
    const point = state.current.point;

    if (correct) {
        state.answered = true;
        playerState.correctCount = (playerState.correctCount || 0) + 1;
        
        state.current.cards.find(c => c.number === number).correct = true;
        state.current.cards.find(c => c.number === number).chosenBy = name;
        
        state.players.forEach(p => {
            if (p.playerId !== playerId) {
                p.hp = Math.max(0, p.hp - point);
                if (p.hp <= 0 && !state.eliminatedOrder.includes(p.playerId)) {
                    state.eliminatedOrder.push(p.playerId);
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
            if (!state.eliminatedOrder.includes(playerState.playerId)) {
                state.eliminatedOrder.push(playerState.playerId);
            }
        }
        state.misClicks.push({ name, number });
        state.current.cards.find(c => c.number === number).incorrect = true;
        state.current.cards.find(c => c.number === number).chosenBy = name;

        io.to(groupId).emit("state", sanitizeState(state));
        checkGameEnd(groupId);
    }
  });

  socket.on('host_full_reset', () => {
    if (socket.id !== hostSocketId) return;
    console.log('🚨 ホストによってゲームが完全にリセットされました。');
    hostSocketId = null;
    globalCards = [];
    globalSettings = {};
    gamePhase = 'INITIAL';
    Object.keys(players).forEach(key => delete players[key]);
    Object.keys(groups).forEach(key => delete groups[key]);
    Object.keys(states).forEach(key => delete states[key]);
    io.emit('force_reload', 'ホストによってゲームがリセットされました。ページをリロードします。');
  });

  socket.on('host_set_group_mode', ({ groupId, gameMode }) => {
    if (socket.id !== hostSocketId) return;
    if (states[groupId] && (gameMode === 'normal' || gameMode === 'mask')) {
      states[groupId].gameMode = gameMode;
      console.log(`👑 Host set ${groupId} to ${gameMode} mode.`);
      socket.emit("host_state", getHostState());
    }
  });

  // --- シングルプレイ用イベント ---
  socket.on('request_presets', () => {
    const presetsForClient = {};
    for(const [id, data] of Object.entries(questionPresets)) {
        presetsForClient[id] = { category: data.category, name: data.name };
    }
    socket.emit('presets_list', presetsForClient);
  });
  
  socket.on('start_single_play', ({ name, playerId, difficulty, presetId }) => {
    if (players[playerId]) players[playerId].name = name;
    const preset = questionPresets[presetId];
    if (!preset) return;

    const questions = shuffle([...preset.cards]);
    singlePlayStates[socket.id] = {
        name, playerId, difficulty, presetId,
        questions, allCards: preset.cards,
        maxQuestions: questions.length,
        questionCount: 0, score: 0,
        current: null, answered: false, startTime: 0
    };
    nextSingleQuestion(socket.id);
  });

  socket.on('single_answer', ({ number }) => {
    const state = singlePlayStates[socket.id];
    if (!state || state.answered) return;
    
    state.answered = true;
    const correct = state.current.answer === number;
    const card = state.current.cards.find(c => c.number === number);

    if (correct) {
        card.correct = true;
        const elapsedTime = Date.now() - state.startTime;
        const timeBonus = Math.max(0, 10000 - elapsedTime);
        state.score += (100 + Math.floor(timeBonus / 100));
    } else {
        card.incorrect = true;
    }

    io.to(socket.id).emit('single_game_state', state);
    setTimeout(() => nextSingleQuestion(socket.id), 3000);
  });

  socket.on("disconnect", () => {
    console.log(`🔌 プレイヤーが切断しました: ${socket.id}`);
    const player = getPlayerBySocketId(socket.id);
    if (player) {
      console.log(`👻 ${player.name} がオフラインになりました。復帰を待ちます。`);
    }
    delete singlePlayStates[socket.id];
  });
});

// サーバー起動
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

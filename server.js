// server.js (ステップ3: 個人戦新ルール実装版 - 全文)

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const DATA_DIR = path.join(__dirname, 'data');
const USER_PRESETS_DIR = path.join(DATA_DIR, 'user_presets');
const RANKINGS_DIR = path.join(DATA_DIR, 'rankings');

let hostSocketId = null;
let hostPlayerId = null; 
let globalTorifudas = [];
let globalYomifudas = [];
let globalSettings = {};
let gamePhase = 'INITIAL';
let questionPresets = {};

const players = {};
const groups = {};
const states = {};
const singlePlayStates = {};

let hostStateUpdateTimer = null;
const HOST_UPDATE_INTERVAL = 2000;

function initializeDirectories() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        if (!fs.existsSync(USER_PRESETS_DIR)) fs.mkdirSync(USER_PRESETS_DIR, { recursive: true });
        if (!fs.existsSync(RANKINGS_DIR)) fs.mkdirSync(RANKINGS_DIR, { recursive: true });
    } catch (err) {
        console.error("⚠️ Failed to create data directories:", err);
    }
}
initializeDirectories();

function loadPresets() {
  try {
    const defaultPresetPath = path.join(__dirname, 'data', 'questions.json');
    if (fs.existsSync(defaultPresetPath)) {
        questionPresets = JSON.parse(fs.readFileSync(defaultPresetPath, 'utf8'));
        console.log('✅ デフォルト問題プリセットを読み込みました。');
    } else {
        console.warn(`⚠️ デフォルト問題プリセットファイルが見つかりません: ${defaultPresetPath}`);
    }
  } catch (err) {
    console.error('⚠️ デフォルト問題プリセットの読み込みに失敗しました:', err);
  }
  
  try {
    if (fs.existsSync(USER_PRESETS_DIR)) {
        const userFiles = fs.readdirSync(USER_PRESETS_DIR).filter(file => file.endsWith('.json'));
        userFiles.forEach(file => {
            const filePath = path.join(USER_PRESETS_DIR, file);
            const presetId = `user_${path.basename(file, '.json')}`;
            questionPresets[presetId] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        });
        if (userFiles.length > 0) console.log(`✅ ユーザー作成プリセットを ${userFiles.length} 件読み込みました。`);
    }
  } catch(err) {
      console.error('⚠️ ユーザー作成プリセットの読み込みに失敗しました:', err);
  }
}
loadPresets();

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

function parseAndSetCards(data) {
    const torifudas = [];
    const yomifudas = [];
    const dataToParse = data.rawData || data.cards;
    const isNewFormat = !!data.rawData;
    for (const row of dataToParse) {
        if (isNewFormat) {
            if (row.col1.startsWith('def_')) {
                torifudas.push({ id: row.col1, term: row.col2 });
            } else {
                yomifudas.push({ answer: row.col1, term: row.col2, text: row.col3 });
            }
        } else {
            torifudas.push({ id: `def_${row.number}`, term: row.term });
            yomifudas.push({ answer: row.term, term: row.term, text: row.text });
        }
    }
    globalTorifudas = [...torifudas];
    globalYomifudas = [...yomifudas];
}

function resetAllGameData() {
    console.log('🚨 ゲームデータが完全にリセットされます...');
    hostSocketId = null;
    hostPlayerId = null;
    globalTorifudas = [];
    globalYomifudas = [];
    globalSettings = {};
    gamePhase = 'INITIAL';
    Object.keys(players).forEach(key => delete players[key]);
    Object.keys(groups).forEach(key => delete groups[key]);
    Object.keys(states).forEach(key => delete states[key]);
    console.log('🚨 リセットが完了しました。');
}

function initState(groupId) {
  return {
    groupId, players: [], questionCount: 0,
    maxQuestions: globalSettings.maxQuestions || 10,
    numCards: globalSettings.numCards || 5,
    showSpeed: globalSettings.showSpeed || 1000,
    gameMode: globalSettings.gameMode || 'normal',
    current: null, answered: false, waitingNext: false,
    misClicks: [], usedQuestions: [], readDone: new Set(),
    readTimer: null, eliminatedOrder: [], locked: false,
    answersThisRound: []
  };
}

function sanitizeState(state) {
  if (!state) return null;
  const currentWithDetails = state.current ? { 
      ...state.current, 
      point: state.current.point,
      roundResults: state.current.roundResults 
  } : null;
  return {
    groupId: state.groupId, players: state.players, questionCount: state.questionCount,
    maxQuestions: state.maxQuestions, gameMode: state.gameMode, showSpeed: state.showSpeed,
    current: currentWithDetails, locked: state.locked, answered: state.answered,
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
          name: p.name, hp: statePlayer?.hp ?? 20, correctCount: statePlayer?.correctCount ?? 0,
          currentScore: p.currentScore ?? 0, totalScore: p.totalScore ?? 0
        };
      })
    };
  }
  return result;
}

function finalizeGame(groupId) {
    const state = states[groupId];
    if (!state || state.locked) return;
    state.locked = true;
    if (state.readTimer) clearTimeout(state.readTimer);
    state.readTimer = null;
    
    console.log(`[${groupId}] ゲーム終了処理を開始します。`);
    
    const sortedPlayersByRank = [...state.players].sort((a, b) => {
        if (a.hp === 0 && b.hp > 0) return 1;
        if (b.hp === 0 && a.hp > 0) return -1;
        if (b.hp !== a.hp) return b.hp - a.hp;
        return (b.correctCount || 0) - (a.correctCount || 0);
    });

    const gPlayer1 = groups[groupId]?.players.find(p => p.playerId === sortedPlayersByRank[0]?.playerId);
    if (gPlayer1) {
        gPlayer1.currentScore = (gPlayer1.currentScore || 0) + 200;
    }
    const gPlayer2 = groups[groupId]?.players.find(p => p.playerId === sortedPlayersByRank[1]?.playerId);
    if (gPlayer2) {
        gPlayer2.currentScore = (gPlayer2.currentScore || 0) + 100;
    }
    
    const finalRanking = state.players.map(pState => {
        const gPlayer = groups[groupId]?.players.find(gp => gp.playerId === pState.playerId);
        const finalScore = gPlayer?.currentScore || 0;
        if (gPlayer) {
            gPlayer.totalScore = (gPlayer.totalScore || 0) + finalScore;
        }
        return { ...pState, finalScore, totalScore: gPlayer?.totalScore || finalScore };
    });

    finalRanking.sort((a, b) => b.finalScore - a.finalScore);
    io.to(groupId).emit("end", finalRanking);
    notifyHostStateChanged();
}

function checkGameEnd(groupId) {
    const state = states[groupId];
    if (!state || state.locked) return;
    const survivors = state.players.filter(p => p.hp > 0);
    if (survivors.length === 0 && state.players.length > 0) {
        finalizeGame(groupId);
    }
}

function processRoundResults(groupId) {
    const state = states[groupId];
    if (!state || state.answered) return; 
    state.answered = true; 
    if (state.readTimer) clearTimeout(state.readTimer);
    state.readTimer = null;

    const point = state.current.point;
    const correctCard = globalTorifudas.find(t => t.term === state.current.answer);
    if (!correctCard) {
        console.error(`[CRITICAL] Correct card not found for answer: ${state.current.answer}`);
        setTimeout(() => nextQuestion(groupId), 3000);
        return;
    }

    const sortedAnswers = state.answersThisRound.sort((a, b) => a.timestamp - b.timestamp);
    const correctAnswers = sortedAnswers.filter(ans => ans.id === correctCard.id);
    const incorrectPlayerIds = new Set(
        sortedAnswers.filter(ans => ans.id !== correctCard.id).map(ans => ans.playerId)
    );

    const firstPlace = correctAnswers[0] || null;
    const secondPlace = correctAnswers[1] || null;

    correctAnswers.forEach((answer, index) => {
        const pState = state.players.find(p => p.playerId === answer.playerId);
        const gPlayer = groups[groupId]?.players.find(p => p.playerId === answer.playerId);
        if (!pState || !gPlayer) return;

        pState.correctCount = (pState.correctCount || 0) + 1;

        if (pState.hp > 0) {
            if (index === 0) gPlayer.currentScore += 15;
            else gPlayer.currentScore += 10;
        } else {
            gPlayer.currentScore += 5;
        }
    });

    state.players.forEach(pState => {
        if (pState.hp <= 0) return;

        let damage = 0;
        let recovery = 0;

        if (pState.playerId !== firstPlace?.playerId) {
            damage += point;
        }
        if (incorrectPlayerIds.has(pState.playerId)) {
            damage += point;
        }
        if (pState.playerId === secondPlace?.playerId) {
            recovery = Math.round(damage / 2);
        }

        pState.hp = pState.hp - damage + recovery;
        if (pState.hp <= 0) {
            pState.hp = 0;
        }
    });

    state.current.roundResults = {
        first: firstPlace?.name || null,
        second: secondPlace?.name || null,
    };
    state.current.cards.forEach(card => {
        const choosers = sortedAnswers.filter(ans => ans.id === card.id).map(ans => ans.name);
        if (choosers.length > 0) card.chosenBy = choosers;
        if (card.id === correctCard.id) {
            card.correctAnswer = true;
        } else if (choosers.length > 0) {
            card.incorrect = true;
        }
    });

    io.to(groupId).emit("state", sanitizeState(state));
    checkGameEnd(groupId);
    if (!state.locked) setTimeout(() => nextQuestion(groupId), 5000);
}

function nextQuestion(groupId) {
    const state = states[groupId];
    if (!state || state.locked) return;
    if (state.readTimer) clearTimeout(state.readTimer);
    state.readTimer = null;
    const remainingYomifudas = globalYomifudas.filter(y => !state.usedQuestions.includes(y.text));
    if (remainingYomifudas.length === 0 || state.questionCount >= state.maxQuestions) return finalizeGame(groupId);
    const question = remainingYomifudas[Math.floor(Math.random() * remainingYomifudas.length)];
    state.usedQuestions.push(question.text);
    const correctTorifuda = globalTorifudas.find(t => t.term === question.answer);
    if (!correctTorifuda) {
        console.error(`[CRITICAL] 正解の取り札が見つかりません: "${question.answer}".`);
        setTimeout(() => nextQuestion(groupId), 100);
        return;
    }
    const distractors = shuffle([...globalTorifudas.filter(t => t.id !== correctTorifuda.id)]).slice(0, state.numCards - 1);
    const cards = shuffle([...distractors, correctTorifuda]);
    let point = 1;
    const rand = Math.random();
    if (rand < 0.05) point = 5; else if (rand < 0.20) point = 3; else if (rand < 0.60) point = 2;
    const originalText = question.text;
    let maskedIndices = [];
    if (state.gameMode === 'mask') {
        let indices = Array.from({length: originalText.length}, (_, i) => i).filter(i => !/\s/.test(originalText[i]));
        shuffle(indices);
        maskedIndices = indices.slice(0, Math.floor(indices.length / 2));
    }
    state.current = { text: originalText, maskedIndices, answer: question.answer, point, cards: cards.map(c => ({ id: c.id, term: c.term })) };
    state.questionCount++;
    state.waitingNext = false;
    state.answered = false;
    state.readDone = new Set();
    state.misClicks = [];
    state.answersThisRound = [];
    io.to(groupId).emit("state", sanitizeState(state));
}

function readRankingFile(filePath) { /* ... */ }
function writeRankingFile(filePath, data) { /* ... */ }
function nextSingleQuestion(socketId, isFirstQuestion) { /* ... */ }
function notifyHostStateChanged() { /* ... */ }

io.on("connection", (socket) => {
  console.log(`✅ プレイヤーが接続しました: ${socket.id}`);

  socket.on('request_new_player_id', () => {
    const playerId = uuidv4();
    players[playerId] = { playerId, socketId: socket.id, name: "未設定", isHost: false };
    socket.emit('new_player_id_assigned', playerId);
  });
  socket.on('reconnect_player', ({ playerId, name }) => {
    players[playerId] = { ...players[playerId], socketId: socket.id, name: name || players[playerId]?.name || "未設定" };
    console.log(`🔄 ${players[playerId].name}(${playerId.substring(0,4)})が再接続しました。`);
    if (players[playerId]?.isHost && playerId === hostPlayerId) {
        hostSocketId = socket.id;
        console.log("👑 ホストが復帰しました:", players[playerId].name);
        socket.emit('host_reconnect_success');
    }
  });
  socket.on('request_game_phase', ({ fromEndScreen = false } = {}) => {
    const presetsForClient = Object.fromEntries(Object.entries(questionPresets).map(([id, data]) => [id, { category: data.category, name: data.name }]));
    socket.emit('game_phase_response', { phase: gamePhase, presets: presetsForClient, fromEndScreen });
  });
  socket.on("set_preset_and_settings", ({ presetId, settings, isNextGame }) => { /* ... */ });
  socket.on("set_cards_and_settings", ({ rawData, settings, presetInfo, isNextGame, saveAction, presetId }) => { /* ... */ });
  socket.on("join", ({ groupId, playerId }) => { /* ... */ });
  socket.on("rejoin_game", ({ playerId }) => { /* ... */ });
  socket.on("set_name", ({ groupId, playerId, name }) => { /* ... */ });
  socket.on("read_done", (groupId) => {
    const player = getPlayerBySocketId(socket.id);
    if (!player) return;
    const state = states[groupId];
    if (!state || !state.current || state.readTimer || state.answered) return;
    state.readDone.add(player.playerId);
    const activePlayersCount = state.players.length; // 全員が対象
    if (state.readDone.size >= Math.ceil(activePlayersCount / 2)) {
        if (state.readTimer) return;
        io.to(groupId).emit("timer_start", { seconds: 30 });
        state.readTimer = setTimeout(() => {
            if (state && !state.answered) processRoundResults(groupId);
        }, 30000);
    }
  });
  socket.on("host_join", ({ playerId }) => { /* ... */ });
  socket.on("host_request_state", () => { /* ... */ });
  socket.on("request_global_ranking", () => { /* ... */ });
  socket.on("host_start", () => { /* ... */ });
  socket.on("host_assign_groups", ({ groupCount, topGroupCount, groupSizes }) => { /* ... */ });
  socket.on("answer", ({ groupId, playerId, name, id }) => {
    if (!socket.rooms.has(groupId)) return;
    const state = states[groupId];
    if (!state || !state.current || state.answered || state.locked) return;
    const playerState = state.players.find(p => p.playerId === playerId);
    if (!playerState) return;
    if (state.answersThisRound.some(ans => ans.playerId === playerId)) return;
    state.answersThisRound.push({ playerId, name, id, timestamp: Date.now() });
    const activePlayers = state.players;
    if (state.answersThisRound.length >= activePlayers.length) {
        if (state.readTimer) clearTimeout(state.readTimer);
        processRoundResults(groupId);
    }
  });
  socket.on('host_preparing_next_game', () => { /* ... */ });
  socket.on('host_full_reset', () => { /* ... */ });
  socket.on('host_set_group_mode', ({ groupId, gameMode }) => { /* ... */ });
  socket.on('host_export_data', () => { /* ... */ });
  socket.on('host_import_data', (data) => { /* ... */ });
  socket.on('host_delete_preset', ({ presetId }) => { /* ... */ });
  socket.on('request_presets', () => {
    const presetsForClient = Object.fromEntries(Object.entries(questionPresets).map(([id, data]) => [id, { category: data.category, name: data.name }]));
    socket.emit('presets_list', presetsForClient);
  });
  socket.on('start_single_play', ({ name, playerId, difficulty, presetId }) => { /* ... */ });
  socket.on('single_answer', ({ id }) => { /* ... */ });
  socket.on('single_game_timeup', () => { /* ... */ });
  socket.on("disconnect", () => { /* ... */ });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

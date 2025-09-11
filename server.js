// server.js (再接続処理 最終修正版 - 全文)

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

// --- グローバル変数 ---
let hostSocketId = null;
let hostPlayerId = null; 
let globalTorifudas = [];
let globalYomifudas = [];
let globalSettings = {};
let gamePhase = 'INITIAL';
let questionPresets = {};

// --- データ管理 ---
const players = {};
const groups = {};
const states = {};
const singlePlayStates = {};

let hostStateUpdateTimer = null;
const HOST_UPDATE_INTERVAL = 2000;

// --- サーバー初期化処理 ---
function initializeDirectories() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            console.log(`✅ Created directory: ${DATA_DIR}`);
        }
        if (!fs.existsSync(USER_PRESETS_DIR)) {
            fs.mkdirSync(USER_PRESETS_DIR, { recursive: true });
            console.log(`✅ Created directory: ${USER_PRESETS_DIR}`);
        }
        if (!fs.existsSync(RANKINGS_DIR)) {
            fs.mkdirSync(RANKINGS_DIR, { recursive: true });
            console.log(`✅ Created directory: ${RANKINGS_DIR}`);
        }
    } catch (err) {
        console.error("⚠️ Failed to create data directories:", err);
    }
}
initializeDirectories();

function loadPresets() {
  try {
    const defaultPresetPath = path.join(DATA_DIR, 'questions.json');
    if (fs.existsSync(defaultPresetPath)) {
        const data = fs.readFileSync(defaultPresetPath, 'utf8');
        questionPresets = JSON.parse(data);
        console.log('✅ デフォルト問題プリセットを読み込みました。');
    } else {
        console.warn(`⚠️ デフォルト問題プリセットファイルが見つかりません: ${defaultPresetPath}`);
        questionPresets = {};
    }
  } catch (err) {
    console.error('⚠️ デフォルト問題プリセットの読み込みに失敗しました:', err);
    questionPresets = {};
  }
  
  try {
    const userFiles = fs.readdirSync(USER_PRESETS_DIR).filter(file => file.endsWith('.json'));
    userFiles.forEach(file => {
        const filePath = path.join(USER_PRESETS_DIR, file);
        const data = fs.readFileSync(filePath, 'utf8');
        const presetId = `user_${path.basename(file, '.json')}`;
        questionPresets[presetId] = JSON.parse(data);
    });
    if (userFiles.length > 0) console.log(`✅ ユーザー作成プリセットを ${userFiles.length} 件読み込みました。`);
  } catch(err) {
      console.error('⚠️ ユーザー作成プリセットの読み込みに失敗しました:', err);
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

// --- マルチプレイ用ヘルパー ---
function initState(groupId) {
  return {
    groupId, players: [], questionCount: 0,
    maxQuestions: globalSettings.maxQuestions || 10,
    numCards: globalSettings.numCards || 5,
    showSpeed: globalSettings.showSpeed || 1000,
    gameMode: globalSettings.gameMode || 'normal',
    current: null, answered: false, waitingNext: false,
    misClicks: [], usedQuestions: [], readDone: new Set(),
    eliminatedOrder: [], locked: false,
    activeTimer: null,
    gameSubPhase: 'pending',
    bonusEligiblePlayers: new Set(),
    incorrectPlayers: new Set(),
  };
}
function sanitizeState(state) {
  if (!state) return null;
  const currentWithPoint = state.current ? { ...state.current, point: state.current.point } : null;
  return {
    groupId: state.groupId, players: state.players, questionCount: state.questionCount,
    maxQuestions: state.maxQuestions, gameMode: state.gameMode, showSpeed: state.showSpeed,
    current: currentWithPoint, locked: state.locked, answered: state.answered,
    gameSubPhase: state.gameSubPhase,
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
    if (state.activeTimer) clearTimeout(state.activeTimer);
    state.activeTimer = null;
    
    console.log(`[${groupId}] ゲーム終了処理を開始します。`);
    const finalRanking = [...state.players].sort((a, b) => {
        if (b.hp !== a.hp) return b.hp - a.hp;
        return (b.correctCount || 0) - (a.correctCount || 0);
    });
    const alreadyUpdated = new Set();
    finalRanking.forEach((p, i) => {
        const correctCount = p.correctCount || 0;
        let bonus = 0;
        if (i === 0) bonus = 200; else if (i === 1) bonus = 100;
        p.finalScore = (correctCount * 10) + bonus;
        p.currentScore = p.finalScore;

        const gPlayer = groups[groupId]?.players.find(gp => gp.playerId === p.playerId);
        if (gPlayer && !alreadyUpdated.has(gPlayer.playerId)) {
            gPlayer.totalScore = (gPlayer.totalScore || 0) + p.finalScore;
            gPlayer.currentScore = p.finalScore;
            p.totalScore = gPlayer.totalScore;
            alreadyUpdated.add(gPlayer.playerId);
        } else {
            p.totalScore = gPlayer?.totalScore ?? p.finalScore;
        }
    });
    finalRanking.sort((a, b) => b.finalScore - a.finalScore);
    io.to(groupId).emit("end", finalRanking);
    notifyHostStateChanged();
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
    
    if (state.activeTimer) clearTimeout(state.activeTimer);
    state.activeTimer = null;
    
    const usedYomifudaTexts = new Set(state.usedQuestions);
    const remainingYomifudas = globalYomifudas.filter(y => !usedYomifudaTexts.has(y.text));
    
    if (remainingYomifudas.length < (state.numCards || 5) || remainingYomifudas.length === 0 || state.questionCount >= state.maxQuestions) {
        console.log(`[${groupId}] 問題不足または最大質問数到達のためゲームを終了します。`);
        return finalizeGame(groupId);
    }

    const question = remainingYomifudas[Math.floor(Math.random() * remainingYomifudas.length)];
    state.usedQuestions.push(question.text);

    const correctTorifuda = globalTorifudas.find(t => t.term === question.answer);
    if (!correctTorifuda) {
        console.error(`[CRITICAL] 正解の取り札が見つかりません: "${question.answer}". スキップします。`);
        return setTimeout(() => nextQuestion(groupId), 100);
    }
    const distractors = shuffle([...globalTorifudas.filter(t => t.id !== correctTorifuda.id)]).slice(0, state.numCards - 1);
    const cards = shuffle([...distractors, correctTorifuda]);

    let point = 1;
    const rand = Math.random();
    if (rand < 0.05) { point = 5; } else if (rand < 0.20) { point = 3; } else if (rand < 0.60) { point = 2; }
    
    state.current = {
        text: question.text, maskedIndices: [], answer: question.answer, point,
        cards: cards.map(c => ({ id: c.id, term: c.term }))
    };
    if (state.gameMode === 'mask') {
        let indices = Array.from({length: question.text.length}, (_, i) => i)
                           .filter(i => question.text[i] !== ' ' && question.text[i] !== '　');
        shuffle(indices);
        state.current.maskedIndices = indices.slice(0, Math.floor(indices.length / 2));
    }
    
    state.questionCount++;
    state.waitingNext = false;
    state.answered = false;
    state.readDone = new Set();
    state.misClicks = [];
    state.gameSubPhase = 'answering';
    state.bonusEligiblePlayers = new Set(state.players.filter(p => p.hp > 0).map(p => p.playerId));
    state.incorrectPlayers = new Set();

    io.to(groupId).emit("state", sanitizeState(state));
}
function showResultAndProceed(groupId, delay = 3000) {
    const state = states[groupId];
    if (!state || state.locked) return;

    if (state.activeTimer) clearTimeout(state.activeTimer);
    state.activeTimer = null;

    state.gameSubPhase = 'showingResult';
    const correctCard = state.current.cards.find(c => c.term === state.current.answer);
    if (correctCard) {
        correctCard.correctAnswer = true;
    }
    io.to(groupId).emit("state", sanitizeState(state));

    state.activeTimer = setTimeout(() => {
        if (!state.locked) {
            nextQuestion(groupId);
        }
    }, delay);
}

// --- シングルプレイ用ヘルパー ---
function readRankingFile(filePath) {
    try {
        if (!fs.existsSync(RANKINGS_DIR)) fs.mkdirSync(RANKINGS_DIR, { recursive: true });
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (err) {
        console.error(`Error reading ranking file ${filePath}:`, err);
    }
    return {};
}
function writeRankingFile(filePath, data) {
    try {
        if (!fs.existsSync(RANKINGS_DIR)) fs.mkdirSync(RANKINGS_DIR, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error(`Error writing ranking file ${filePath}:`, err);
    }
}
function nextSingleQuestion(socketId, isFirstQuestion = false) {
    const state = singlePlayStates[socketId];
    if (!state) return;
    const question = state.allYomifudas[Math.floor(Math.random() * state.allYomifudas.length)];
    const correctTorifuda = state.allTorifudas.find(t => t.term === question.answer);
    if (!correctTorifuda) {
        console.error(`Single Play Error: Correct torifuda not found for answer "${question.answer}"`);
        return nextSingleQuestion(socketId);
    }
    const distractors = shuffle([...state.allTorifudas.filter(t => t.id !== correctTorifuda.id)]).slice(0, 3);
    const cards = shuffle([...distractors, correctTorifuda]);
    const originalText = question.text;
    let maskedIndices = [];
    if (state.difficulty === 'hard') {
        let indices = Array.from({length: originalText.length}, (_, i) => i);
        indices = indices.filter(i => originalText[i] !== ' ' && originalText[i] !== '　');
        shuffle(indices);
        maskedIndices = indices.slice(0, Math.floor(indices.length / 2));
    }
    state.current = {
        text: originalText, maskedIndices: maskedIndices, answer: question.answer,
        cards: cards.map(c => ({ id: c.id, term: c.term }))
    };
    state.answered = false;
    state.startTime = Date.now();
    if (!isFirstQuestion) {
        io.to(socketId).emit('single_game_state', state);
    }
}

function notifyHostStateChanged() {
    if (!hostSocketId) return;
    if (hostStateUpdateTimer) return;

    hostStateUpdateTimer = setTimeout(() => {
        if (hostSocketId) {
            io.to(hostSocketId).emit("host_state", getHostState());
        }
        hostStateUpdateTimer = null;
    }, HOST_UPDATE_INTERVAL);
}


// --- メインの接続処理 ---
io.on("connection", (socket) => {
  console.log(`✅ プレイヤーが接続しました: ${socket.id}`);

  socket.on('request_new_player_id', () => {
    const playerId = uuidv4();
    players[playerId] = { playerId, socketId: socket.id, name: "未設定", isHost: false };
    socket.emit('new_player_id_assigned', playerId);
  });

  socket.on('reconnect_player', ({ playerId, name, isHostClient }) => {
    if (players[playerId]) {
      players[playerId].socketId = socket.id;
      if (name) players[playerId].name = name;
    } else {
      players[playerId] = { playerId, socketId: socket.id, name: name || "未設定", isHost: isHostClient || false };
    }
    console.log(`🔄 ${players[playerId].name}(${playerId.substring(0,4)})が再接続しました。`);

    const presetsForClient = {};
    for(const [id, data] of Object.entries(questionPresets)) {
        presetsForClient[id] = { category: data.category, name: data.name };
    }

    if (isHostClient && players[playerId].isHost && playerId === hostPlayerId) {
        hostSocketId = socket.id;
        console.log("👑 ホストが復帰しました:", players[playerId].name);
        
        const totalPlayers = Object.values(groups).reduce((sum, group) => sum + group.players.length, 0);
        if (gamePhase !== 'INITIAL' && totalPlayers > 0) {
            socket.emit('host_reconnect_success');
        } else {
            socket.emit('game_phase_response', { phase: 'INITIAL', presets: presetsForClient });
        }
        return;
    }

    for (const [gId, group] of Object.entries(groups)) {
        if (group.players.find(p => p.playerId === playerId)) {
            const state = states[gId];
            if (state && !state.locked) {
                console.log(`[Rejoin] ${name} をグループ ${gId} に復帰させます。`);
                socket.join(gId);
                socket.emit('rejoin_game', sanitizeState(state));
            } else {
                socket.emit('game_phase_response', { phase: gamePhase, presets: presetsForClient });
            }
            return;
        }
    }

    console.log(`[Rejoin] ${name} はどのグループにも属していません。プレイヤーメニューへ誘導します。`);
    if (isHostClient) {
        players[playerId].isHost = false;
    }
    socket.emit('game_phase_response', { phase: gamePhase, presets: presetsForClient });
  });

  socket.on('request_game_phase', ({ fromEndScreen = false } = {}) => {
    const presetsForClient = {};
    for(const [id, data] of Object.entries(questionPresets)) {
        presetsForClient[id] = { category: data.category, name: data.name };
    }
    socket.emit('game_phase_response', { phase: gamePhase, presets: presetsForClient, fromEndScreen });
  });

  socket.on("set_preset_and_settings", ({ presetId, settings, isNextGame }) => {
    if (socket.id !== hostSocketId) return;
    if (questionPresets[presetId]) {
        parseAndSetCards(questionPresets[presetId]);
        globalSettings = { ...settings, maxQuestions: globalYomifudas.length };
        
        if (!isNextGame) {
            Object.keys(states).forEach(key => delete states[key]);
            Object.keys(groups).forEach(key => delete groups[key]);
            gamePhase = 'GROUP_SELECTION';
            io.emit("multiplayer_status_changed", gamePhase);
            socket.emit('host_setup_done');
        } else {
            Object.keys(states).forEach(key => delete states[key]);
            gamePhase = 'WAITING_FOR_NEXT_GAME';
            io.to(hostSocketId).emit('host_setup_done');
        }
    }
  });

  socket.on("set_cards_and_settings", ({ rawData, settings, presetInfo, isNextGame, saveAction, presetId }) => {
    if (socket.id !== hostSocketId) return;
    
    try {
        if (saveAction) {
            if (!fs.existsSync(USER_PRESETS_DIR)) fs.mkdirSync(USER_PRESETS_DIR, { recursive: true });
            let filePath;
            let dataToSave;
            if (saveAction === 'new') {
                const newPresetId = `${Date.now()}_${presetInfo.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
                filePath = path.join(USER_PRESETS_DIR, `${newPresetId}.json`);
                dataToSave = { category: presetInfo.category, name: presetInfo.name, rawData };
                fs.writeFileSync(filePath, JSON.stringify(dataToSave, null, 2));
                console.log(`💾 新規プリセットを保存: ${filePath}`);
            } else if (presetId && presetId.startsWith('user_')) {
                const fileName = `${presetId.replace('user_', '')}.json`;
                filePath = path.join(USER_PRESETS_DIR, fileName);
                if (fs.existsSync(filePath)) {
                    const existingData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    let finalRawData;
                    if (saveAction === 'append') {
                        finalRawData = existingData.rawData.concat(rawData);
                    } else {
                        finalRawData = rawData;
                    }
                    dataToSave = { ...existingData, rawData: finalRawData };
                    fs.writeFileSync(filePath, JSON.stringify(dataToSave, null, 2));
                    console.log(`💾 プリセットを更新 (${saveAction}): ${filePath}`);
                }
            }
            loadPresets();
        }
    } catch (err) {
        console.error('プリセットの保存/更新中にエラーが発生しました:', err);
    } finally {
        parseAndSetCards({ rawData });
        globalSettings = { ...settings, maxQuestions: globalYomifudas.length };
        if (!isNextGame) {
            Object.keys(states).forEach(key => delete states[key]);
            Object.keys(groups).forEach(key => delete groups[key]);
            gamePhase = 'GROUP_SELECTION';
            socket.emit('host_setup_done');
            io.emit("multiplayer_status_changed", gamePhase);
        } else {
            Object.keys(states).forEach(key => delete states[key]);
            gamePhase = 'WAITING_FOR_NEXT_GAME';
            io.to(hostSocketId).emit('host_setup_done');
        }
    }
  });
  
  socket.on("join", ({ groupId, playerId }) => {
    const player = players[playerId];
    if (!player) return;
    const previousGroupId = Object.keys(groups).find(gId => groups[gId]?.players.some(p => p.playerId === playerId));
    let existingPlayer = null;
    if (previousGroupId) {
        existingPlayer = groups[previousGroupId].players.find(p => p.playerId === playerId);
        groups[previousGroupId].players = groups[previousGroupId].players.filter(p => p.playerId !== playerId);
        if (states[previousGroupId]) {
            states[previousGroupId].players = states[previousGroupId].players.filter(p => p.playerId !== playerId);
        }
    }
    const socketInstance = io.sockets.sockets.get(player.socketId);
    if (socketInstance) {
        for (const room of socketInstance.rooms) {
            if (room !== socketInstance.id) socketInstance.leave(room);
        }
    }
    socket.join(groupId);
    if (!groups[groupId]) groups[groupId] = { players: [] };
    if (!states[groupId]) states[groupId] = initState(groupId);
    if (!groups[groupId].players.some(p => p.playerId === playerId)) {
      groups[groupId].players.push({ 
          playerId, name: player.name, 
          totalScore: existingPlayer?.totalScore || 0,
          currentScore: 0 
      });
    }
    notifyHostStateChanged();
  });

  socket.on("rejoin_game", ({ playerId }) => {
    for (const [gId, group] of Object.entries(groups)) {
        if (group.players.find(p => p.playerId === playerId)) {
            const state = states[gId];
            if (state && !state.locked) {
                socket.join(gId);
                socket.emit('rejoin_game', sanitizeState(state));
            } else {
                socket.emit('game_phase_response', { phase: gamePhase, presets: {} });
            }
            return;
        }
    }
    socket.emit('game_phase_response', { phase: gamePhase, presets: {} });
  });

  socket.on("leave_group", ({ groupId, playerId }) => {
    socket.leave(groupId);
    if (groups[groupId]) {
      groups[groupId].players = groups[groupId].players.filter(p => p.playerId !== playerId);
    }
    if (states[groupId]) {
      states[groupId].players = states[groupId].players.filter(p => p.playerId !== playerId);
    }
    notifyHostStateChanged();
  });

  socket.on("set_name", ({ groupId, playerId, name }) => {
    if (players[playerId]) players[playerId].name = name;
    if (groups[groupId]) {
        const gPlayer = groups[groupId].players.find(p => p.playerId === playerId);
        if (gPlayer) gPlayer.name = name;
    }
    if (states[groupId]) {
        const statePlayer = states[groupId].players.find(p => p.playerId === playerId);
        if (statePlayer) statePlayer.name = name;
    }
    if (states[groupId]) {
      io.to(groupId).emit("state", sanitizeState(states[groupId]));
    }
    notifyHostStateChanged();
  });
  
  socket.on("read_done", (groupId) => {
    const player = getPlayerBySocketId(socket.id);
    if (!player) return;
    const state = states[groupId];
    if (!state || !state.current || state.activeTimer || state.answered || state.waitingNext) return;
    state.readDone.add(player.playerId);
    const activePlayersInGroup = state.players.filter(p => p.hp > 0).length;
    if (state.readDone.size >= Math.ceil(activePlayersInGroup / 2)) {
        if (state.activeTimer) return;
        io.to(groupId).emit("timer_start", { seconds: 30 });
        state.activeTimer = setTimeout(() => {
            showResultAndProceed(groupId);
        }, 30000);
    }
  });

  socket.on("host_join", ({ playerId }) => {
    if (hostPlayerId && hostPlayerId !== playerId) {
        socket.emit('error_message', 'すでに別のホストがゲームを管理しています。');
        socket.emit('game_phase_response', { phase: gamePhase, presets: {} });
        return;
    }
    hostSocketId = socket.id;
    hostPlayerId = playerId;
    if (players[playerId]) {
        players[playerId].isHost = true;
    } else {
        players[playerId] = { playerId, socketId: socket.id, name: "Host", isHost: true };
    }
    console.log("👑 ホストが接続しました:", players[playerId]?.name);
    // ★★★ 修正: このイベントからは応答を返さない ★★★
    // クライアント側で request_game_phase を送るため、そちらで応答する
  });

  socket.on("host_request_state", () => {
    if (socket.id === hostSocketId) {
        socket.emit("host_state", getHostState());
    }
  });
  
  socket.on("request_global_ranking", () => {
      const allPlayers = Object.values(groups)
          .flatMap(g => g.players).filter(p => p.name !== "未設定")
          .map(p => ({ name: p.name, totalScore: p.totalScore || 0 }));
      socket.emit("global_ranking", allPlayers.sort((a, b) => b.totalScore - a.totalScore));
  });

  socket.on("host_start", () => {
    if (socket.id !== hostSocketId) return;
    console.log("▶ ホストが全体スタートを実行");
    gamePhase = 'GAME_IN_PROGRESS';
    for (const groupId of Object.keys(groups)) {
        if (!groups[groupId] || groups[groupId].players.length === 0) continue;
        const currentGroupMode = states[groupId]?.gameMode || globalSettings.gameMode;
        states[groupId] = initState(groupId);
        states[groupId].gameMode = currentGroupMode;
        const group = groups[groupId];
        states[groupId].players = group.players.map(p => ({ 
            playerId: p.playerId, name: p.name, hp: 20, score: 0, correctCount: 0
        }));
        nextQuestion(groupId);
    }
    notifyHostStateChanged();
  });

  socket.on("host_assign_groups", ({ groupCount, topGroupCount, groupSizes }) => {
    if (socket.id !== hostSocketId) return;
    const allPlayers = Object.values(groups).flatMap(g => g.players).filter(p => p.name !== "未設定");
    const sortedPlayers = allPlayers.sort((a, b) => (b.currentScore || 0) - (a.currentScore || 0));
    const numTopPlayers = groupSizes.slice(0, topGroupCount).reduce((sum, size) => sum + size, 0);
    const topPlayers = sortedPlayers.slice(0, numTopPlayers);
    const otherPlayers = shuffle(sortedPlayers.slice(numTopPlayers));
    const newGroupsConfig = {};
    for (let i = 1; i <= groupCount; i++) { newGroupsConfig[i] = []; }
    let topPlayerIndex = 0;
    for (let i = 1; i <= topGroupCount; i++) {
        const capacity = groupSizes[i - 1] || 0;
        while (newGroupsConfig[i].length < capacity && topPlayerIndex < topPlayers.length) {
            newGroupsConfig[i].push(topPlayers[topPlayerIndex]);
            topPlayerIndex++;
        }
    }
    let otherPlayerIndex = 0;
    while (otherPlayerIndex < otherPlayers.length) {
        let placed = false;
        for (let i = topGroupCount + 1; i <= groupCount; i++) {
            if (otherPlayerIndex >= otherPlayers.length) break;
            const capacity = groupSizes[i - 1] || 0;
            if (newGroupsConfig[i].length < capacity) {
                newGroupsConfig[i].push(otherPlayers[otherPlayerIndex]);
                otherPlayerIndex++;
                placed = true;
            }
        }
        if (!placed) break;
    }
    const unassignedPlayers = [...topPlayers.slice(topPlayerIndex), ...otherPlayers.slice(otherPlayerIndex)];
    if (unassignedPlayers.length > 0) {
      console.log(`${unassignedPlayers.length}人のプレイヤーが定員オーバーしました。`);
      let unassignedIndex = 0;
      while(unassignedIndex < unassignedPlayers.length) {
          for (let i = 1; i <= groupCount; i++) {
              if (unassignedIndex >= unassignedPlayers.length) break;
              newGroupsConfig[i].push(unassignedPlayers[unassignedIndex]);
              unassignedIndex++;
          }
      }
    }
    
    const allPlayerScores = new Map(allPlayers.map(p => [p.playerId, p.totalScore]));
    Object.keys(groups).forEach(k => delete groups[k]);
    Object.keys(states).forEach(k => delete states[k]);

    for (let i = 1; i <= groupCount; i++) {
        const pInGroup = newGroupsConfig[i];
        if (!pInGroup || pInGroup.length === 0) continue;
        const gId = `group${i}`;
        groups[gId] = { 
            players: pInGroup.map(p => ({
                ...p,
                totalScore: allPlayerScores.get(p.playerId) || 0,
                currentScore: 0
            }))
        };
        states[gId] = initState(gId);
    }
    for (const [gId, group] of Object.entries(groups)) {
        for (const p of group.players) {
            const pSocket = io.sockets.sockets.get(players[p.playerId]?.socketId);
            if (pSocket) {
                for (const room of pSocket.rooms) if (room !== pSocket.id) pSocket.leave(room);
                pSocket.join(gId);
                pSocket.emit("assigned_group", gId);
            }
        }
    }
    notifyHostStateChanged();
  });

  socket.on("answer", ({ groupId, playerId, name, id }) => {
    if (!socket.rooms.has(groupId)) return;
    const state = states[groupId];
    if (!state || !state.current || state.locked || state.answered) return;
    const playerState = state.players.find(p => p.playerId === playerId);
    if (!playerState || playerState.hp <= 0) return;

    const answeredTorifuda = globalTorifudas.find(t => t.id === id);
    if (!answeredTorifuda) return;

    const correct = state.current.answer === answeredTorifuda.term;
    const point = state.current.point;

    if (state.gameSubPhase === 'answering') {
        if (correct) {
            if (state.activeTimer) clearTimeout(state.activeTimer);
            state.activeTimer = null;
            state.answered = true;
            state.gameSubPhase = 'bonusTime';
            
            playerState.correctCount = (playerState.correctCount || 0) + 1;
            state.current.cards.find(c => c.id === id).correct = true;
            state.current.cards.find(c => c.id === id).chosenBy = name;
            
            state.players.forEach(p => {
                if (p.playerId !== playerId) p.hp = Math.max(0, p.hp - point);
            });
            
            io.to(groupId).emit("state", sanitizeState(state));
            checkGameEnd(groupId);
            
            if (!state.locked) {
                state.activeTimer = setTimeout(() => {
                    showResultAndProceed(groupId);
                }, 5000);
            }
        } else {
            playerState.hp -= point;
            state.bonusEligiblePlayers.delete(playerId);
            state.incorrectPlayers.add(playerId);

            state.current.cards.find(c => c.id === id).incorrect = true;
            state.current.cards.find(c => c.id === id).chosenBy = name;
            io.to(groupId).emit("state", sanitizeState(state));
            
            checkGameEnd(groupId);
            if (state.locked) return;

            const activePlayers = state.players.filter(p => p.hp > 0);
            if (state.incorrectPlayers.size >= activePlayers.length) {
                console.log(`[${groupId}] 全員が誤答しました。`);
                showResultAndProceed(groupId);
            }
        }
    }
    else if (state.gameSubPhase === 'bonusTime') {
        if (!state.bonusEligiblePlayers.has(playerId)) return;

        if (correct) {
            if (state.activeTimer) clearTimeout(state.activeTimer);
            state.activeTimer = null;
            
            playerState.correctCount = (playerState.correctCount || 0) + 1;
            state.current.cards.find(c => c.id === id).correct = true;
            state.current.cards.find(c => c.id === id).chosenBy = `(2着) ${name}`;
            
            showResultAndProceed(groupId);
        } else {
            playerState.hp -= point;
            state.bonusEligiblePlayers.delete(playerId);
            
            state.current.cards.find(c => c.id === id).incorrect = true;
            state.current.cards.find(c => c.id === id).chosenBy = name;
            io.to(groupId).emit("state", sanitizeState(state));
            
            checkGameEnd(groupId);
        }
    }
  });

  socket.on('host_preparing_next_game', () => {
    if (socket.id !== hostSocketId) return;
    Object.keys(states).forEach(key => delete states[key]); 
    gamePhase = 'WAITING_FOR_NEXT_GAME';
    Object.values(groups).forEach(group => {
        group.players.forEach(p => p.currentScore = 0);
    });
    io.emit("multiplayer_status_changed", gamePhase);
    socket.broadcast.emit('wait_for_next_game');
    socket.emit('request_game_phase', { fromEndScreen: true });
  });

  socket.on('host_full_reset', () => {
    if (socket.id !== hostSocketId) return;
    resetAllGameData();
    io.emit('force_reload', 'ホストによってゲームがリセットされました。ページをリロードします。');
  });

  socket.on('host_set_group_mode', ({ groupId, gameMode }) => {
    if (socket.id !== hostSocketId) return;
    if (!states[groupId]) states[groupId] = initState(groupId);
    if (states[groupId] && (gameMode === 'normal' || gameMode === 'mask')) {
      states[groupId].gameMode = gameMode;
      console.log(`👑 Host set ${groupId} to ${gameMode} mode.`);
      notifyHostStateChanged();
    }
  });
  
  socket.on('host_export_data', () => {
    if (socket.id !== hostSocketId) return;
    const backupData = { userPresets: {}, rankings: {} };
    if (fs.existsSync(USER_PRESETS_DIR)) {
        const files = fs.readdirSync(USER_PRESETS_DIR);
        files.forEach(file => {
            backupData.userPresets[file] = fs.readFileSync(path.join(USER_PRESETS_DIR, file), 'utf8');
        });
    }
    if (fs.existsSync(RANKINGS_DIR)) {
        const files = fs.readdirSync(RANKINGS_DIR);
        files.forEach(file => {
            backupData.rankings[file] = fs.readFileSync(path.join(RANKINGS_DIR, file), 'utf8');
        });
    }
    socket.emit('export_data_response', backupData);
  });

  socket.on('host_import_data', (data) => {
    if (socket.id !== hostSocketId) return;
    try {
        if (!fs.existsSync(USER_PRESETS_DIR)) fs.mkdirSync(USER_PRESETS_DIR, { recursive: true });
        if (!fs.existsSync(RANKINGS_DIR)) fs.mkdirSync(RANKINGS_DIR, { recursive: true });
        for (const [fileName, content] of Object.entries(data.userPresets || {})) {
            fs.writeFileSync(path.join(USER_PRESETS_DIR, fileName), content);
        }
        for (const [fileName, content] of Object.entries(data.rankings || {})) {
            fs.writeFileSync(path.join(RANKINGS_DIR, fileName), content);
        }
        loadPresets();
        socket.emit('import_data_response', { success: true, message: 'データの読み込みが完了しました。ページをリロードします。' });
    } catch (error) {
        console.error('データインポートエラー:', error);
        socket.emit('import_data_response', { success: false, message: 'データの読み込みに失敗しました。' });
    }
  });
  
  socket.on('host_delete_preset', ({ presetId }) => {
    if (socket.id !== hostSocketId) return;
    if (!presetId || !presetId.startsWith('user_')) return;
    try {
        const fileName = `${presetId.replace('user_', '')}.json`;
        const filePath = path.join(USER_PRESETS_DIR, fileName);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`🗑️ プリセットを削除しました: ${filePath}`);
            loadPresets();
            socket.emit('request_game_phase');
        }
    } catch (error) {
        console.error('プリセットの削除に失敗しました:', error);
    }
  });
  
  socket.on('request_presets', () => {
    const presetsForClient = {};
    for(const [id, data] of Object.entries(questionPresets)) {
        presetsForClient[id] = { category: data.category, name: data.name };
    }
    socket.emit('presets_list', presetsForClient);
  });
  
  socket.on('start_single_play', ({ name, playerId, difficulty, presetId }) => {
    if (players[playerId]) players[playerId].name = name;
    const presetData = questionPresets[presetId];
    if (!presetData) return;
    const singleTorifudas = [];
    const singleYomifudas = [];
    const data = presetData.rawData || presetData.cards;
    const isNewFormat = !!presetData.rawData;
    for (const row of data) {
        if (isNewFormat) {
            if (row.col1.startsWith('def_')) {
                singleTorifudas.push({ id: row.col1, term: row.col2 });
            } else {
                singleYomifudas.push({ answer: row.col1, text: row.col3 });
            }
        } else {
            singleTorifudas.push({ id: `def_${row.number}`, term: row.term });
            singleYomifudas.push({ answer: row.term, text: row.text });
        }
    }
    const totalQuestions = singleYomifudas.length;
    singlePlayStates[socket.id] = {
        name, playerId, difficulty, presetId, allTorifudas: singleTorifudas, allYomifudas: singleYomifudas,
        score: 0, current: null, answered: false, startTime: 0,
        presetName: `${presetData.category} - ${presetData.name}`, totalQuestions
    };
    nextSingleQuestion(socket.id, true);
    io.to(socket.id).emit('single_game_start', singlePlayStates[socket.id]);
  });

  socket.on('single_answer', ({ id }) => {
    const state = singlePlayStates[socket.id];
    if (!state || state.answered) return;
    state.answered = true;
    const answeredTorifuda = state.allTorifudas.find(t => t.id === id);
    if (!answeredTorifuda) return;
    const correct = state.current.answer === answeredTorifuda.term;
    const card = state.current.cards.find(c => c.id === id);
    if (correct) {
        card.correct = true;
        const elapsedTime = Date.now() - state.startTime;
        const timeBonus = Math.max(0, 10000 - elapsedTime);
        const baseScore = 50 + (state.totalQuestions * 1.5);
        state.score += (Math.floor(baseScore + (timeBonus / 100)));
    } else {
        card.incorrect = true;
    }
    io.to(socket.id).emit('single_game_state', state);
    setTimeout(() => nextSingleQuestion(socket.id), 1500);
  });

  socket.on('single_game_timeup', () => {
    const state = singlePlayStates[socket.id];
    if (!state) return;
    const { score, playerId, name, presetId, presetName, difficulty } = state;
    const globalRankingFile = path.join(RANKINGS_DIR, `${presetId}_${difficulty}_global.json`);
    const personalBestFile = path.join(RANKINGS_DIR, `${presetId}_${difficulty}_personal.json`);
    let globalRanking = readRankingFile(globalRankingFile).ranking || [];
    let personalBests = readRankingFile(personalBestFile);
    const oldBest = personalBests[playerId] || 0;
    if (score > oldBest) {
        personalBests[playerId] = score;
        writeRankingFile(personalBestFile, personalBests);
    }
    const personalBest = Math.max(score, oldBest);
    const existingPlayerIndex = globalRanking.findIndex(r => r.playerId === playerId);
    if (existingPlayerIndex > -1) {
        if (score > globalRanking[existingPlayerIndex].score) {
            globalRanking[existingPlayerIndex].score = score;
        }
    } else {
        globalRanking.push({ playerId, name, score });
    }
    globalRanking.sort((a, b) => b.score - a.score);
    globalRanking = globalRanking.slice(0, 10);
    writeRankingFile(globalRankingFile, { ranking: globalRanking });
    globalRanking.forEach(r => {
        if (r.playerId === playerId) r.isMe = true;
    });
    socket.emit('single_game_end', {
        score, personalBest, globalRanking, presetName
    });
    delete singlePlayStates[socket.id];
  });
  
  socket.on("disconnect", () => {
    console.log(`🔌 プレイヤーが切断しました: ${socket.id}`);
    if (socket.id === hostSocketId) {
        console.warn("👑 ホストが一時的に切断しました。復帰を待ちます。");
        hostSocketId = null;
        return;
    }
    const player = getPlayerBySocketId(socket.id);
    if (player) {
      console.log(`👻 ${player.name} がオフラインになりました。復帰を待ちます。`);
    }
    delete singlePlayStates[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

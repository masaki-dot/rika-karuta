// server.js (生存ボーナス機能 復活版 - 全文)

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
    const defaultPresetPath = path.join(DATA_DIR, 'questions.json');
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
    const userFiles = fs.readdirSync(USER_PRESETS_DIR).filter(file => file.endsWith('.json'));
    userFiles.forEach(file => {
        const filePath = path.join(USER_PRESETS_DIR, file);
        const presetId = `user_${path.basename(file, '.json')}`;
        questionPresets[presetId] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

// ★★★修正: 生存ボーナス機能を追加した finalizeGame 関数★★★
function finalizeGame(groupId) {
    const state = states[groupId];
    if (!state || state.locked) return;
    state.locked = true;

    if (state.readTimer) clearTimeout(state.readTimer);
    state.readTimer = null;
    
    console.log(`[${groupId}] ゲーム終了処理を開始します。`);

    // プレイヤーをHPと正解数でソートして、生存順位を決定
    const sortedPlayersByRank = [...state.players].sort((a, b) => {
        if (b.hp !== a.hp) return b.hp - a.hp; // 1. HPが高い順
        return (b.correctCount || 0) - (a.correctCount || 0); // 2. 正解数が多い順
    });

    // 1位と2位のプレイヤーにボーナスポイントを加算
    if (sortedPlayersByRank[0]) {
        const firstPlayerId = sortedPlayersByRank[0].playerId;
        const gPlayer = groups[groupId]?.players.find(p => p.playerId === firstPlayerId);
        if (gPlayer) {
            gPlayer.currentScore = (gPlayer.currentScore || 0) + 200;
            console.log(`[${groupId}] ${gPlayer.name}に1位ボーナス+200点`);
        }
    }
    if (sortedPlayersByRank[1]) {
        const secondPlayerId = sortedPlayersByRank[1].playerId;
        const gPlayer = groups[groupId]?.players.find(p => p.playerId === secondPlayerId);
        if (gPlayer) {
            gPlayer.currentScore = (gPlayer.currentScore || 0) + 100;
            console.log(`[${groupId}] ${gPlayer.name}に2位ボーナス+100点`);
        }
    }
    
    // 最終的なランキングデータを作成
    const finalRanking = state.players.map(pState => {
        const gPlayer = groups[groupId]?.players.find(gp => gp.playerId === pState.playerId);
        const finalScore = gPlayer?.currentScore || 0;
        
        // 累計スコアを更新
        if (gPlayer) {
            gPlayer.totalScore = (gPlayer.totalScore || 0) + finalScore;
        }

        // クライアントに送るデータ
        return {
            ...pState,
            finalScore: finalScore,
            totalScore: gPlayer?.totalScore || finalScore
        };
    });

    // 最終スコアでランキングをソート
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
function processRoundResults(groupId) {
    const state = states[groupId];
    if (!state || state.answered) return; 
    state.answered = true; 
    if (state.readTimer) clearTimeout(state.readTimer);
    state.readTimer = null;
    const point = state.current.point;
    const correctCard = globalTorifudas.find(t => t.term === state.current.answer);
    if (!correctCard) {
        console.error(`[CRITICAL] 正解の取り札が見つかりません: ${state.current.answer}`);
        setTimeout(() => nextQuestion(groupId), 3000);
        return;
    }
    const sortedAnswers = state.answersThisRound.sort((a, b) => a.timestamp - b.timestamp);
    const correctAnswers = sortedAnswers.filter(ans => ans.id === correctCard.id);
    const incorrectPlayerIds = new Set(sortedAnswers.filter(ans => ans.id !== correctCard.id).map(ans => ans.playerId));
    const firstPlace = correctAnswers[0] || null;
    const secondPlace = correctAnswers[1] || null;
    [firstPlace, secondPlace].forEach(winner => {
        if (!winner) return;
        const pState = state.players.find(p => p.playerId === winner.playerId);
        if (pState) pState.correctCount = (pState.correctCount || 0) + 1;
        const gPlayer = groups[groupId]?.players.find(p => p.playerId === winner.playerId);
        if (gPlayer) gPlayer.currentScore = (gPlayer.currentScore || 0) + 10;
    });
    state.players.forEach(p => {
        if (p.hp <= 0) return;
        let totalDamage = 0;
        if (p.playerId !== firstPlace?.playerId) totalDamage += point;
        if (incorrectPlayerIds.has(p.playerId)) totalDamage += point;
        p.hp = Math.max(0, p.hp - totalDamage);
        if (p.hp <= 0 && !state.eliminatedOrder.includes(p.playerId)) state.eliminatedOrder.push(p.playerId);
    });
    state.current.roundResults = { first: firstPlace?.name || null, second: secondPlace?.name || null };
    state.current.cards.forEach(card => {
        const choosers = sortedAnswers.filter(ans => ans.id === card.id).map(ans => ans.name);
        if (choosers.length > 0) card.chosenBy = choosers;
        if (card.id === correctCard.id) card.correctAnswer = true;
        else if (choosers.length > 0) card.incorrect = true;
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
function readRankingFile(filePath) {
    try {
        if (!fs.existsSync(RANKINGS_DIR)) fs.mkdirSync(RANKINGS_DIR, { recursive: true });
        if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) { console.error(`Error reading ranking file ${filePath}:`, err); }
    return {};
}
function writeRankingFile(filePath, data) {
    try {
        if (!fs.existsSync(RANKINGS_DIR)) fs.mkdirSync(RANKINGS_DIR, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (err) { console.error(`Error writing ranking file ${filePath}:`, err); }
}
function nextSingleQuestion(socketId, isFirstQuestion = false) {
    const state = singlePlayStates[socketId];
    if (!state) return;
    const question = state.allYomifudas[Math.floor(Math.random() * state.allYomifudas.length)];
    const correctTorifuda = state.allTorifudas.find(t => t.term === question.answer);
    if (!correctTorifuda) return nextSingleQuestion(socketId);
    const distractors = shuffle([...state.allTorifudas.filter(t => t.id !== correctTorifuda.id)]).slice(0, 3);
    const cards = shuffle([...distractors, correctTorifuda]);
    const originalText = question.text;
    let maskedIndices = [];
    if (state.difficulty === 'hard') {
        let indices = Array.from({length: originalText.length}, (_, i) => i).filter(i => !/\s/.test(originalText[i]));
        shuffle(indices);
        maskedIndices = indices.slice(0, Math.floor(indices.length / 2));
    }
    state.current = { text: originalText, maskedIndices, answer: question.answer, cards: cards.map(c => ({ id: c.id, term: c.term })) };
    state.answered = false;
    state.startTime = Date.now();
    if (!isFirstQuestion) io.to(socketId).emit('single_game_state', state);
}
function notifyHostStateChanged() {
    if (!hostSocketId) return;
    if (hostStateUpdateTimer) return;
    hostStateUpdateTimer = setTimeout(() => {
        if (hostSocketId) io.to(hostSocketId).emit("host_state", getHostState());
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
  socket.on('reconnect_player', ({ playerId, name }) => {
    players[playerId] = { ...players[playerId], socketId: socket.id, name: name || players[playerId]?.name || "未設定" };
    console.log(`🔄 ${players[playerId].name}(${playerId.substring(0,4)})が再接続しました。`);
    if (players[playerId].isHost && playerId === hostPlayerId) {
        hostSocketId = socket.id;
        console.log("👑 ホストが復帰しました:", players[playerId].name);
        socket.emit(gamePhase !== 'INITIAL' ? 'host_reconnect_success' : 'game_phase_response', { phase: gamePhase });
    }
  });
  socket.on('request_game_phase', ({ fromEndScreen = false } = {}) => {
    const presetsForClient = Object.fromEntries(Object.entries(questionPresets).map(([id, data]) => [id, { category: data.category, name: data.name }]));
    socket.emit('game_phase_response', { phase: gamePhase, presets: presetsForClient, fromEndScreen });
  });
  socket.on("set_preset_and_settings", ({ presetId, settings, isNextGame }) => {
    if (socket.id !== hostSocketId || !questionPresets[presetId]) return;
    parseAndSetCards(questionPresets[presetId]);
    globalSettings = { ...settings, maxQuestions: globalYomifudas.length };
    Object.keys(states).forEach(key => delete states[key]);
    if (!isNextGame) {
        Object.keys(groups).forEach(key => delete groups[key]);
        gamePhase = 'GROUP_SELECTION';
        io.emit("multiplayer_status_changed", gamePhase);
    } else {
        gamePhase = 'WAITING_FOR_NEXT_GAME';
    }
    socket.emit('host_setup_done');
  });
  socket.on("set_cards_and_settings", ({ rawData, settings, presetInfo, isNextGame, saveAction, presetId }) => {
    if (socket.id !== hostSocketId) return;
    try {
        if (saveAction) {
            if (!fs.existsSync(USER_PRESETS_DIR)) fs.mkdirSync(USER_PRESETS_DIR, { recursive: true });
            let filePath, dataToSave;
            if (saveAction === 'new') {
                const newPresetId = `${Date.now()}_${presetInfo.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
                filePath = path.join(USER_PRESETS_DIR, `${newPresetId}.json`);
                dataToSave = { category: presetInfo.category, name: presetInfo.name, rawData };
            } else if (presetId?.startsWith('user_')) {
                const fileName = `${presetId.replace('user_', '')}.json`;
                filePath = path.join(USER_PRESETS_DIR, fileName);
                if (fs.existsSync(filePath)) {
                    const existingData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    dataToSave = { ...existingData, rawData: saveAction === 'append' ? existingData.rawData.concat(rawData) : rawData };
                }
            }
            if (filePath && dataToSave) {
                fs.writeFileSync(filePath, JSON.stringify(dataToSave, null, 2));
                loadPresets();
            }
        }
    } catch (err) { console.error('プリセットの保存/更新中にエラーが発生しました:', err); } 
    finally {
        parseAndSetCards({ rawData });
        globalSettings = { ...settings, maxQuestions: globalYomifudas.length };
        Object.keys(states).forEach(key => delete states[key]);
        if (!isNextGame) {
            Object.keys(groups).forEach(key => delete groups[key]);
            gamePhase = 'GROUP_SELECTION';
            io.emit("multiplayer_status_changed", gamePhase);
        } else {
            gamePhase = 'WAITING_FOR_NEXT_GAME';
        }
        socket.emit('host_setup_done');
    }
  });
  socket.on("join", ({ groupId, playerId }) => {
    const player = players[playerId];
    if (!player) return;
    Object.values(groups).forEach(g => g.players = g.players.filter(p => p.playerId !== playerId));
    Array.from(socket.rooms).filter(r => r !== socket.id).forEach(r => socket.leave(r));
    socket.join(groupId);
    if (!groups[groupId]) groups[groupId] = { players: [] };
    if (!states[groupId]) states[groupId] = initState(groupId);
    if (!groups[groupId].players.some(p => p.playerId === playerId)) {
      groups[groupId].players.push({ playerId, name: player.name, totalScore: 0, currentScore: 0 });
    }
    notifyHostStateChanged();
  });
  socket.on("rejoin_game", ({ playerId }) => {
    const groupEntry = Object.entries(groups).find(([, g]) => g.players.some(p => p.playerId === playerId));
    if (groupEntry) {
        const [gId, group] = groupEntry;
        const state = states[gId];
        if (state && !state.locked) {
            socket.join(gId);
            socket.emit('rejoin_game', sanitizeState(state));
            return;
        }
    }
    socket.emit('game_phase_response', { phase: gamePhase });
  });
  socket.on("set_name", ({ groupId, playerId, name }) => {
    if (players[playerId]) players[playerId].name = name;
    const gPlayer = groups[groupId]?.players.find(p => p.playerId === playerId);
    if (gPlayer) gPlayer.name = name;
    const statePlayer = states[groupId]?.players.find(p => p.playerId === playerId);
    if (statePlayer) statePlayer.name = name;
    if (states[groupId]) io.to(groupId).emit("state", sanitizeState(states[groupId]));
    notifyHostStateChanged();
  });
  socket.on("read_done", (groupId) => {
    const player = getPlayerBySocketId(socket.id);
    if (!player) return;
    const state = states[groupId];
    if (!state || !state.current || state.readTimer || state.answered) return;
    state.readDone.add(player.playerId);
    const activePlayersCount = state.players.filter(p => p.hp > 0).length;
    if (state.readDone.size >= Math.ceil(activePlayersCount / 2)) {
        if (state.readTimer) return;
        io.to(groupId).emit("timer_start", { seconds: 30 });
        state.readTimer = setTimeout(() => {
            if (state && !state.answered) processRoundResults(groupId);
        }, 30000);
    }
  });
  socket.on("host_join", ({ playerId }) => {
    if (hostPlayerId && hostPlayerId !== playerId) return;
    hostSocketId = socket.id;
    hostPlayerId = playerId;
    players[playerId] = { ...players[playerId], playerId, socketId: socket.id, isHost: true };
    console.log("👑 ホストが接続しました:", players[playerId]?.name);
  });
  socket.on("host_request_state", () => { if (socket.id === hostSocketId) socket.emit("host_state", getHostState()); });
  socket.on("request_global_ranking", () => {
      const allPlayers = Object.values(groups).flatMap(g => g.players).filter(p => p.name !== "未設定" && typeof p.totalScore === 'number');
      socket.emit("global_ranking", allPlayers.sort((a, b) => b.totalScore - a.totalScore));
  });
  socket.on("host_start", () => {
    if (socket.id !== hostSocketId) return;
    console.log("▶ ホストが全体スタートを実行");
    gamePhase = 'GAME_IN_PROGRESS';
    for (const [groupId, group] of Object.entries(groups)) {
        if (group.players.length === 0) continue;
        const currentGroupMode = states[groupId]?.gameMode || globalSettings.gameMode;
        states[groupId] = initState(groupId);
        states[groupId].gameMode = currentGroupMode;
        group.players.forEach(p => p.currentScore = 0); 
        states[groupId].players = group.players.map(p => ({ playerId: p.playerId, name: p.name, hp: 20, correctCount: 0 }));
        nextQuestion(groupId);
    }
    notifyHostStateChanged();
  });
  socket.on("host_assign_groups", ({ groupCount, topGroupCount, groupSizes }) => {
    if (socket.id !== hostSocketId) return;
    const allPlayers = Object.values(groups).flatMap(g => g.players).filter(p => p.name !== "未設定");
    allPlayers.sort((a, b) => (b.currentScore || 0) - (a.currentScore || 0));
    const numTopPlayers = groupSizes.slice(0, topGroupCount).reduce((sum, size) => sum + size, 0);
    const topPlayers = allPlayers.slice(0, numTopPlayers);
    const otherPlayers = shuffle(allPlayers.slice(numTopPlayers));
    const newGroupsConfig = Array.from({ length: groupCount }, () => []);
    let topPlayerIndex = 0;
    for (let i = 0; i < topGroupCount; i++) {
        for (let j = 0; j < (groupSizes[i] || 0) && topPlayerIndex < topPlayers.length; j++) newGroupsConfig[i].push(topPlayers[topPlayerIndex++]);
    }
    let otherPlayerIndex = 0;
    while (otherPlayerIndex < otherPlayers.length) {
        let placed = false;
        for (let i = topGroupCount; i < groupCount; i++) {
            if (otherPlayerIndex >= otherPlayers.length) break;
            if (newGroupsConfig[i].length < (groupSizes[i] || 0)) {
                newGroupsConfig[i].push(otherPlayers[otherPlayerIndex++]);
                placed = true;
            }
        }
        if (!placed) break;
    }
    const unassignedPlayers = [...topPlayers.slice(topPlayerIndex), ...otherPlayers.slice(otherPlayerIndex)];
    unassignedPlayers.forEach((player, i) => newGroupsConfig[i % groupCount].push(player));
    const allPlayerScores = new Map(allPlayers.map(p => [p.playerId, p.totalScore]));
    Object.keys(groups).forEach(k => delete groups[k]);
    Object.keys(states).forEach(k => delete states[k]);
    newGroupsConfig.forEach((pInGroup, i) => {
        if (pInGroup.length === 0) return;
        const gId = `group${i + 1}`;
        groups[gId] = { players: pInGroup.map(p => ({...p, totalScore: allPlayerScores.get(p.playerId) || 0, currentScore: 0 })) };
        states[gId] = initState(gId);
        pInGroup.forEach(p => {
            const pSocket = io.sockets.sockets.get(players[p.playerId]?.socketId);
            if (pSocket) {
                Array.from(pSocket.rooms).filter(r => r !== pSocket.id).forEach(r => pSocket.leave(r));
                pSocket.join(gId);
                pSocket.emit("assigned_group", gId);
            }
        });
    });
    notifyHostStateChanged();
  });
  socket.on("answer", ({ groupId, playerId, name, id }) => {
    if (!socket.rooms.has(groupId)) return;
    const state = states[groupId];
    if (!state || !state.current || state.answered || state.locked) return;
    if (state.answersThisRound.some(ans => ans.playerId === playerId)) return;
    state.answersThisRound.push({ playerId, name, id, timestamp: Date.now() });
    const activePlayers = state.players.filter(p => p.hp > 0);
    if (state.answersThisRound.length >= activePlayers.length) processRoundResults(groupId);
  });
  socket.on('host_preparing_next_game', () => {
    if (socket.id !== hostSocketId) return;
    Object.keys(states).forEach(key => delete states[key]); 
    gamePhase = 'WAITING_FOR_NEXT_GAME';
    Object.values(groups).forEach(group => group.players.forEach(p => p.currentScore = 0));
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
    if (states[groupId] && ['normal', 'mask'].includes(gameMode)) {
      states[groupId].gameMode = gameMode;
      notifyHostStateChanged();
    }
  });
  socket.on('host_export_data', () => {
    if (socket.id !== hostSocketId) return;
    const backupData = { userPresets: {}, rankings: {} };
    if (fs.existsSync(USER_PRESETS_DIR)) fs.readdirSync(USER_PRESETS_DIR).forEach(file => backupData.userPresets[file] = fs.readFileSync(path.join(USER_PRESETS_DIR, file), 'utf8'));
    if (fs.existsSync(RANKINGS_DIR)) fs.readdirSync(RANKINGS_DIR).forEach(file => backupData.rankings[file] = fs.readFileSync(path.join(RANKINGS_DIR, file), 'utf8'));
    socket.emit('export_data_response', backupData);
  });
  socket.on('host_import_data', (data) => {
    if (socket.id !== hostSocketId) return;
    try {
        if (!fs.existsSync(USER_PRESETS_DIR)) fs.mkdirSync(USER_PRESETS_DIR, { recursive: true });
        if (!fs.existsSync(RANKINGS_DIR)) fs.mkdirSync(RANKINGS_DIR, { recursive: true });
        for (const [fileName, content] of Object.entries(data.userPresets || {})) fs.writeFileSync(path.join(USER_PRESETS_DIR, fileName), content);
        for (const [fileName, content] of Object.entries(data.rankings || {})) fs.writeFileSync(path.join(RANKINGS_DIR, fileName), content);
        loadPresets();
        socket.emit('import_data_response', { success: true, message: 'データの読み込みが完了しました。ページをリロードします。' });
    } catch (error) { socket.emit('import_data_response', { success: false, message: 'データの読み込みに失敗しました。' }); }
  });
  socket.on('host_delete_preset', ({ presetId }) => {
    if (socket.id !== hostSocketId || !presetId?.startsWith('user_')) return;
    try {
        const filePath = path.join(USER_PRESETS_DIR, `${presetId.replace('user_', '')}.json`);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            loadPresets();
            socket.emit('request_game_phase');
        }
    } catch (error) { console.error('プリセットの削除に失敗しました:', error); }
  });
  socket.on('request_presets', () => {
    const presetsForClient = Object.fromEntries(Object.entries(questionPresets).map(([id, data]) => [id, { category: data.category, name: data.name }]));
    socket.emit('presets_list', presetsForClient);
  });
  socket.on('start_single_play', ({ name, playerId, difficulty, presetId }) => {
    if (players[playerId]) players[playerId].name = name;
    const presetData = questionPresets[presetId];
    if (!presetData) return;
    const singleTorifudas = [], singleYomifudas = [];
    (presetData.rawData || presetData.cards).forEach(row => {
        if (presetData.rawData) {
            if (row.col1.startsWith('def_')) singleTorifudas.push({ id: row.col1, term: row.col2 });
            else singleYomifudas.push({ answer: row.col1, text: row.col3 });
        } else {
            singleTorifudas.push({ id: `def_${row.number}`, term: row.term });
            singleYomifudas.push({ answer: row.term, text: row.text });
        }
    });
    singlePlayStates[socket.id] = { name, playerId, difficulty, presetId, allTorifudas: singleTorifudas, allYomifudas: singleYomifudas, score: 0, current: null, answered: false, startTime: 0, presetName: `${presetData.category} - ${presetData.name}`, totalQuestions: singleYomifudas.length };
    nextSingleQuestion(socket.id, true);
    io.to(socket.id).emit('single_game_start', singlePlayStates[socket.id]);
  });
  socket.on('single_answer', ({ id }) => {
    const state = singlePlayStates[socket.id];
    if (!state || state.answered) return;
    state.answered = true;
    const card = state.current.cards.find(c => c.id === id);
    if (state.current.answer === state.allTorifudas.find(t => t.id === id)?.term) {
        card.correct = true;
        const timeBonus = Math.max(0, 10000 - (Date.now() - state.startTime));
        state.score += Math.floor(50 + (state.totalQuestions * 1.5) + (timeBonus / 100));
    } else card.incorrect = true;
    io.to(socket.id).emit('single_game_state', state);
    setTimeout(() => nextSingleQuestion(socket.id), 1500);
  });
  socket.on('single_game_timeup', () => {
    const state = singlePlayStates[socket.id];
    if (!state) return;
    const { score, playerId, name, presetId, presetName, difficulty } = state;
    const globalFile = path.join(RANKINGS_DIR, `${presetId}_${difficulty}_global.json`);
    const personalFile = path.join(RANKINGS_DIR, `${presetId}_${difficulty}_personal.json`);
    let globalRanking = readRankingFile(globalFile).ranking || [];
    let personalBests = readRankingFile(personalFile);
    const oldBest = personalBests[playerId] || 0;
    if (score > oldBest) {
        personalBests[playerId] = score;
        writeRankingFile(personalFile, personalBests);
    }
    const existingIdx = globalRanking.findIndex(r => r.playerId === playerId);
    if (existingIdx > -1) {
        if (score > globalRanking[existingIdx].score) globalRanking[existingIdx].score = score;
    } else globalRanking.push({ playerId, name, score });
    globalRanking.sort((a, b) => b.score - a.score).splice(10);
    writeRankingFile(globalFile, { ranking: globalRanking });
    globalRanking.forEach(r => r.isMe = r.playerId === playerId);
    socket.emit('single_game_end', { score, personalBest: Math.max(score, oldBest), globalRanking, presetName });
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
    if (player) console.log(`👻 ${player.name} がオフラインになりました。復帰を待ちます。`);
    delete singlePlayStates[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

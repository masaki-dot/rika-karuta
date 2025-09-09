// server.js (再接続処理・安定性強化版)

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
let hostData = { socketId: null, hostKey: null, isPaused: false };
let globalTorifudas = [];
let globalYomifudas = [];
let globalSettings = {};
let gamePhase = 'INITIAL';
let questionPresets = {};
let lastGameRanking = [];
let finishedGroups = new Set();

// --- データ管理 ---
const players = {}; 
const groups = {};  
const states = {};  
const singlePlayStates = {};

// --- サーバー初期化処理 ---
function loadPresets() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    
    const data = fs.readFileSync(path.join(__dirname, 'data', 'questions.json'), 'utf8');
    questionPresets = JSON.parse(data);
    console.log('✅ デフォルト問題プリセットを読み込みました。');
  } catch (err) {
    console.error('⚠️ デフォルト問題プリセットの読み込みに失敗しました:', err);
    questionPresets = {};
  }
  
  try {
    if (!fs.existsSync(USER_PRESETS_DIR)) fs.mkdirSync(USER_PRESETS_DIR, { recursive: true });
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

function getPlayerStateInGroup(playerId, state) {
    const playerMasterData = players[playerId];
    if (!playerMasterData) return null;
    return {
        playerId: playerMasterData.playerId,
        name: playerMasterData.name,
        hp: state.players[playerId]?.hp ?? 20,
        correctCount: state.players[playerId]?.correctCount ?? 0,
    };
}


// --- マルチプレイ用ヘルパー ---
function initState(groupId) {
  return {
    groupId,
    players: {}, // { playerId: { hp, correctCount } }
    questionCount: 0,
    maxQuestions: globalSettings.maxQuestions || 10,
    numCards: globalSettings.numCards || 5,
    showSpeed: globalSettings.showSpeed || 1000,
    gameMode: globalSettings.gameMode || 'normal',
    current: null, answered: false, waitingNext: false,
    nextQuestionTimer: null,
    usedQuestions: new Set(), eliminatedOrder: [], locked: false
  };
}

function sanitizeStateForClient(state) {
  if (!state) return null;
  const clientPlayers = groups[state.groupId]?.playerIds.map(pid => getPlayerStateInGroup(pid, state)).filter(Boolean) || [];

  return {
    groupId: state.groupId,
    players: clientPlayers,
    questionCount: state.questionCount,
    maxQuestions: state.maxQuestions,
    gameMode: state.gameMode,
    showSpeed: state.showSpeed,
    current: state.current,
    locked: state.locked,
    answered: state.answered,
  };
}

function getHostState() {
  // プレイヤーが0人のグループをクリーンアップ
  for (const groupId in groups) {
    if (groups[groupId].playerIds.length === 0) {
      delete groups[groupId];
      delete states[groupId];
    }
  }

  const allGroups = {};
  const assignedPlayerIds = new Set();
  for (const [groupId, group] of Object.entries(groups)) {
    const state = states[groupId];
    allGroups[groupId] = {
      locked: state?.locked ?? false,
      gameMode: state?.gameMode ?? globalSettings.gameMode ?? 'normal',
      players: group.playerIds.map(pid => getPlayerStateInGroup(pid, state)).filter(Boolean)
    };
    group.playerIds.forEach(pid => assignedPlayerIds.add(pid));
  }
  
  const unassignedPlayers = Object.values(players)
      .filter(p => p.name !== "未設定" && !p.isHost && !assignedPlayerIds.has(p.playerId))
      .map(p => ({ name: p.name, totalScore: p.totalScore || 0 }));
      
  const globalRanking = Object.values(players)
      .filter(p => p.name !== "未設定" && !p.isHost)
      .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0))
      .slice(0, globalSettings.rankingDisplayCount || 10);

  return { allGroups, unassignedPlayers, globalRanking, isPaused: hostData.isPaused };
}

function finalizeGame(groupId) {
    const state = states[groupId];
    if (!state || state.locked) return;

    if (state.nextQuestionTimer) clearTimeout(state.nextQuestionTimer.timerId);
    state.nextQuestionTimer = null;

    state.locked = true;
    finishedGroups.add(groupId);
    console.log(`[${groupId}] ゲーム終了処理を開始します。`);

    const playersInGroup = groups[groupId].playerIds.map(pid => {
        const pState = getPlayerStateInGroup(pid, state);
        if (pState) {
            const correctCount = pState.correctCount || 0;
            pState.finalScore = (correctCount * 10); // ベーススコア
            return pState;
        }
        return null;
    }).filter(Boolean);

    const rankingInGroup = playersInGroup.sort((a, b) => {
        if (b.hp !== a.hp) return b.hp - a.hp;
        return (b.correctCount || 0) - (a.correctCount || 0);
    });

    rankingInGroup.forEach((p, i) => {
        let bonus = 0;
        if (i === 0) bonus = 200;
        else if (i === 1) bonus = 100;
        p.finalScore += bonus;

        const masterPlayer = players[p.playerId];
        if (masterPlayer) {
            masterPlayer.totalScore = (masterPlayer.totalScore || 0) + p.finalScore;
        }
    });
    
    const activeGroupIds = Object.keys(groups).filter(gId => groups[gId] && groups[gId].playerIds.length > 0);
    if (activeGroupIds.every(gId => finishedGroups.has(gId))) {
        console.log("全グループのゲームが終了しました。最終ランキングを計算します。");
        
        lastGameRanking = [];
        for(const gId of activeGroupIds) {
            if (states[gId] && groups[gId]) {
                 const finalGroupPlayers = groups[gId].playerIds.map(pid => {
                    const p = getPlayerStateInGroup(pid, states[gId]);
                    const rankInfo = rankingInGroup.find(r => r.playerId === pid);
                    if(p && rankInfo){
                        p.finalScore = rankInfo.finalScore;
                    }
                    return p;
                 }).filter(Boolean);

                finalGroupPlayers.forEach(p => {
                    lastGameRanking.push({
                        playerId: p.playerId, name: p.name, finalScore: p.finalScore || 0
                    });
                });
            }
        }
        lastGameRanking.sort((a,b) => b.finalScore - a.finalScore);
        
        const cumulativeRanking = Object.values(players)
            .filter(p => p.name !== "未設定" && !p.isHost)
            .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0))
            .slice(0, globalSettings.rankingDisplayCount || 10);
        
        for(const gId of activeGroupIds) {
            io.to(gId).emit("end", { 
                thisGame: rankingInGroup.filter(p => groups[gId].playerIds.includes(p.playerId)),
                cumulative: cumulativeRanking,
                thisGameOverall: lastGameRanking 
            });
        }
        finishedGroups.clear();
        gamePhase = 'WAITING_FOR_NEXT_GAME';
    }
}

function checkGameEnd(groupId) {
  const state = states[groupId];
  if (!state || state.locked || !groups[groupId]) return;

  const survivors = groups[groupId].playerIds.filter(pid => state.players[pid] && state.players[pid].hp > 0);
  if (survivors.length <= 1) {
    finalizeGame(groupId);
  }
}

function nextQuestion(groupId) {
    const state = states[groupId];
    if (!state || state.locked || hostData.isPaused) return;

    if (state.nextQuestionTimer) clearTimeout(state.nextQuestionTimer.timerId);
    state.nextQuestionTimer = null;
    
    const remainingYomifudas = globalYomifudas.filter(y => !state.usedQuestions.has(y.text));
    
    if (remainingYomifudas.length === 0 || state.questionCount >= state.maxQuestions) {
        return finalizeGame(groupId);
    }
    
    const question = remainingYomifudas[Math.floor(Math.random() * remainingYomifudas.length)];
    state.usedQuestions.add(question.text);

    const correctTorifuda = globalTorifudas.find(t => t.term === question.answer);
    if (!correctTorifuda) {
        console.error(`Error: Correct torifuda not found for answer "${question.answer}"`);
        return nextQuestion(groupId);
    }
    const distractors = shuffle([...globalTorifudas.filter(t => t.id !== correctTorifuda.id)]).slice(0, state.numCards - 1);
    const cards = shuffle([...distractors, correctTorifuda]);

    let point = 1;
    const rand = Math.random();
    if (rand < 0.05) { point = 5; } 
    else if (rand < 0.20) { point = 3; }
    else if (rand < 0.60) { point = 2; }

    const originalText = question.text;
    let maskedIndices = [];
    if (state.gameMode === 'mask') {
        let indices = Array.from({length: originalText.length}, (_, i) => i);
        indices = indices.filter(i => originalText[i] !== ' ' && originalText[i] !== '　');
        shuffle(indices);
        maskedIndices = indices.slice(0, Math.floor(indices.length / 2));
    }
    
    state.current = {
        text: originalText, maskedIndices, answer: question.answer, point,
        cards: cards.map(c => ({ id: c.id, term: c.term }))
    };
    state.questionCount++;
    state.answered = false;

    io.to(groupId).emit("state", sanitizeStateForClient(state));
}

// --- シングルプレイ用ヘルパー ---
function readRankingFile(filePath) {
    try {
        if (!fs.existsSync(RANKINGS_DIR)) fs.mkdirSync(RANKINGS_DIR, { recursive: true });
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (e) {
        console.error(`Error reading ranking file ${filePath}:`, e);
    }
    return {};
}

function writeRankingFile(filePath, data) {
    try {
        if (!fs.existsSync(RANKINGS_DIR)) fs.mkdirSync(RANKINGS_DIR, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error(`Error writing ranking file ${filePath}:`, e);
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
        text: originalText,
        maskedIndices: maskedIndices,
        answer: question.answer,
        cards: cards.map(c => ({ id: c.id, term: c.term }))
    };
    state.answered = false;
    state.startTime = Date.now();
    
    if (!isFirstQuestion) {
        io.to(socketId).emit('single_game_state', state);
    }
}


// --- メインの接続処理 ---
io.on("connection", (socket) => {
  console.log(`✅ プレイヤーが接続しました: ${socket.id}`);

  socket.on('request_new_player_id', () => {
    const playerId = uuidv4();
    players[playerId] = { playerId, socketId: socket.id, name: "未設定", totalScore: 0, isHost: false };
    socket.emit('new_player_id_assigned', playerId);
    socket.emit('initial_setup');
  });

  socket.on('reconnect_player', ({ playerId, name }) => {
    if (players[playerId]) {
      players[playerId].socketId = socket.id;
      if (name) players[playerId].name = name;
    } else {
      players[playerId] = { playerId, socketId: socket.id, name: name || "未設定", totalScore: 0, isHost: false };
    }
    console.log(`🔄 ${players[playerId].name}(${playerId.substring(0,4)})が再接続しました。`);
    // ★★★ 修正点 ★★★ サーバーが直接応答する
    socket.emit('game_phase_response', {phase: gamePhase});
  });

  socket.on('request_game_phase', ({ fromEndScreen = false } = {}) => {
    loadPresets(); 
    const presetsForClient = {};
    for(const [id, data] of Object.entries(questionPresets)) {
        presetsForClient[id] = { category: data.category, name: data.name };
    }
    socket.emit('game_phase_response', { phase: gamePhase, presets: presetsForClient, fromEndScreen });
  });

  socket.on("set_preset_and_settings", ({ presetId, settings, isNextGame }) => {
    if (socket.id !== hostData.socketId) return;
    if (questionPresets[presetId]) {
        parseAndSetCards(questionPresets[presetId]);
        globalSettings = { ...settings, maxQuestions: globalYomifudas.length };
        
        if (!isNextGame) {
            Object.keys(states).forEach(key => delete states[key]);
            Object.keys(groups).forEach(key => delete groups[key]);
            lastGameRanking = [];
            gamePhase = 'GROUP_SELECTION';
            io.emit("multiplayer_status_changed", gamePhase);
            socket.emit('host_setup_done', { isPaused: hostData.isPaused });
        } else {
            Object.keys(states).forEach(key => delete states[key]);
            gamePhase = 'WAITING_FOR_NEXT_GAME';
            io.to(hostData.socketId).emit('host_setup_done', { isPaused: hostData.isPaused });
            io.emit("multiplayer_status_changed", gamePhase);
        }
    }
  });

  socket.on("set_cards_and_settings", ({ rawData, settings, presetInfo, isNextGame, saveAction, presetId }) => {
    if (socket.id !== hostData.socketId) return;

    if (saveAction) {
        try {
            if (!fs.existsSync(USER_PRESETS_DIR)) fs.mkdirSync(USER_PRESETS_DIR, { recursive: true });
            let filePath;
            let finalRawData = [...rawData];

            if (saveAction === 'new') {
                const newPresetId = `${Date.now()}_${presetInfo.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
                filePath = path.join(USER_PRESETS_DIR, `${newPresetId}.json`);
                const dataToSave = { category: presetInfo.category, name: presetInfo.name, rawData };
                fs.writeFileSync(filePath, JSON.stringify(dataToSave, null, 2));
                console.log(`💾 新規プリセットを保存: ${filePath}`);
            } else if (presetId && presetId.startsWith('user_')) {
                const fileName = `${presetId.replace('user_', '')}.json`;
                filePath = path.join(USER_PRESETS_DIR, fileName);
                
                if (fs.existsSync(filePath)) {
                    const existingData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    if (saveAction === 'append') {
                        finalRawData = existingData.rawData.concat(rawData);
                    }
                    
                    const dataToSave = { ...existingData, rawData: finalRawData };
                    fs.writeFileSync(filePath, JSON.stringify(dataToSave, null, 2));
                    console.log(`💾 プリセットを更新 (${saveAction}): ${filePath}`);
                }
            }
        } catch (err) {
            console.error('プリセットの保存/更新に失敗しました:', err);
        }
    }

    parseAndSetCards({ rawData });
    globalSettings = { ...settings, maxQuestions: globalYomifudas.length };
    
    if (!isNextGame) {
        Object.keys(states).forEach(key => delete states[key]);
        Object.keys(groups).forEach(key => delete groups[key]);
        lastGameRanking = [];
        gamePhase = 'GROUP_SELECTION';
        socket.emit('host_setup_done', { isPaused: hostData.isPaused });
        io.emit("multiplayer_status_changed", gamePhase);
    } else {
        Object.keys(states).forEach(key => delete states[key]);
        gamePhase = 'WAITING_FOR_NEXT_GAME';
        io.to(hostData.socketId).emit('host_setup_done', { isPaused: hostData.isPaused });
        io.emit("multiplayer_status_changed", gamePhase);
    }
  });

  socket.on("join", ({ groupId, playerId }) => {
    const player = players[playerId];
    if (!player) return;

    // 既存のグループからプレイヤーを削除
    for (const gId in groups) {
      const index = groups[gId].playerIds.indexOf(playerId);
      if (index > -1) {
        groups[gId].playerIds.splice(index, 1);
      }
    }

    // 新しいグループに参加
    if (!groups[groupId]) groups[groupId] = { playerIds: [] };
    if (!states[groupId]) states[groupId] = initState(groupId);
    if (!groups[groupId].playerIds.includes(playerId)) {
      groups[groupId].playerIds.push(playerId);
    }
    if (!states[groupId].players[playerId]) {
      states[groupId].players[playerId] = { hp: 20, correctCount: 0 };
    }
    
    socket.rooms.forEach(room => { if (room !== socket.id) socket.leave(room); });
    socket.join(groupId);
    
    if(hostData.socketId) io.to(hostData.socketId).emit("host_state", getHostState());
  });

  socket.on("rejoin_game", ({ playerId }) => {
    for (const [gId, group] of Object.entries(groups)) {
        if (group.playerIds.includes(playerId)) {
            socket.join(gId); 
            if (gamePhase === 'GAME_IN_PROGRESS' && states[gId] && !states[gId].locked) {
                socket.emit('rejoin_game', sanitizeStateForClient(states[gId]));
            } else {
                socket.emit("assigned_group", gId);
            }
            return;
        }
    }
    socket.emit('game_phase_response', { phase: gamePhase });
  });

  socket.on("leave_group", ({ groupId, playerId }) => {
    socket.leave(groupId);
    if (groups[groupId]) {
      const index = groups[groupId].playerIds.indexOf(playerId);
      if (index > -1) {
        groups[groupId].playerIds.splice(index, 1);
      }
    }
  });

  socket.on("set_name", ({ playerId, name }) => {
    if (players[playerId]) {
      players[playerId].name = name;
      // プレイヤーが所属するグループの全クライアントに更新を通知
      for (const [gId, group] of Object.entries(groups)) {
        if (group.playerIds.includes(playerId)) {
          io.to(gId).emit("state", sanitizeStateForClient(states[gId]));
          break;
        }
      }
      if (hostData.socketId) io.to(hostData.socketId).emit("host_state", getHostState());
    }
  });
  
  socket.on("read_done", (groupId) => {
    const state = states[groupId];
    if (!state || !state.current || state.nextQuestionTimer || state.answered || hostData.isPaused) return;
    
    io.to(groupId).emit("timer_start", { seconds: 30 });
    
    const timerId = uuidv4();
    const timer = setTimeout(() => {
        if (state.nextQuestionTimer && state.nextQuestionTimer.id === timerId) {
            state.answered = true;
            const correctCard = state.current.cards.find(c => c.term === state.current.answer);
            if (correctCard) correctCard.correctAnswer = true;
            io.to(groupId).emit("state", sanitizeStateForClient(state));
            setTimeout(() => nextQuestion(groupId), 3000);
        }
    }, 30000);

    state.nextQuestionTimer = { id: timerId, timerId: timer };
  });

  socket.on("host_join", ({ playerId, hostKey }) => {
    socket.join('host_room'); 
    let isReconnectingHost = false;
    if (hostKey && hostKey === hostData.hostKey) {
        console.log(`👑 ホストがキー [${hostKey}] を使って復帰しました。`);
        isReconnectingHost = true;
    } else if (!hostData.hostKey) {
        hostData.hostKey = Math.random().toString(36).substring(2, 8).toUpperCase();
        console.log(`👑 新しいホストが参加しました。ホストキー: [${hostData.hostKey}]`);
    } else {
        socket.emit('force_reload', 'すでに別のホストがアクティブです。ページを更新します。');
        return;
    }

    hostData.socketId = socket.id;
    if (players[playerId]) players[playerId].isHost = true;
    socket.emit('host_key_assigned', hostData.hostKey);

    if (isReconnectingHost && (gamePhase !== 'INITIAL')) {
        console.log(`復帰したホスト [${socket.id}] を管理画面に戻します。`);
        socket.emit('host_setup_done', { lastGameRanking, isPaused: hostData.isPaused });
    } else {
        socket.emit('request_game_phase', { fromEndScreen: false });
    }
  });

  socket.on("host_request_state", () => {
    if (socket.id === hostData.socketId) socket.emit("host_state", getHostState());
  });
  
  socket.on("host_start", () => {
    if (socket.id !== hostData.socketId) return;
    console.log("▶ ホストが全体スタートを実行");

    hostData.isPaused = false;
    io.emit('game_paused', hostData.isPaused);
    gamePhase = 'GAME_IN_PROGRESS';
    finishedGroups.clear();
    for (const groupId of Object.keys(groups)) {
        if (groups[groupId].playerIds.length === 0) continue;
        
        const currentGroupMode = states[groupId]?.gameMode || globalSettings.gameMode;
        states[groupId] = initState(groupId);
        states[groupId].gameMode = currentGroupMode;

        groups[groupId].playerIds.forEach(pid => {
            states[groupId].players[pid] = { hp: 20, correctCount: 0 };
        });
        
        nextQuestion(groupId);
    }
  });

  socket.on("host_assign_groups", ({ groupCount, topGroupCount, groupSizes }) => {
    if (socket.id !== hostData.socketId) return;

    const allCurrentPlayers = Object.values(players).filter(p => p.name !== "未設定" && !p.isHost);
    const sortingSource = lastGameRanking.length > 0 ? lastGameRanking.map(p => players[p.playerId]).filter(Boolean) : allCurrentPlayers;
    const scoreKey = lastGameRanking.length > 0 ? 'finalScore' : 'totalScore';
    
    const sortedPlayers = sortingSource
        .sort((a, b) => (b[scoreKey] || 0) - (a[scoreKey] || 0));

    const numTopPlayers = groupSizes.slice(0, topGroupCount).reduce((sum, size) => sum + size, 0);
    const topPlayers = sortedPlayers.slice(0, numTopPlayers);
    const otherPlayers = shuffle(sortedPlayers.slice(numTopPlayers));

    const newGroupsConfig = {};
    for (let i = 1; i <= groupCount; i++) newGroupsConfig[i] = [];

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
        if (!placed) break; // Avoid infinite loop if no space left
    }
    
    const unassignedPlayers = [...topPlayers.slice(topPlayerIndex), ...otherPlayers.slice(otherPlayerIndex)];
    if (unassignedPlayers.length > 0) {
        let unassignedIndex = 0;
        while(unassignedIndex < unassignedPlayers.length) {
            for (let i = 1; i <= groupCount; i++) {
                if (unassignedIndex >= unassignedPlayers.length) break;
                newGroupsConfig[i].push(unassignedPlayers[unassignedIndex]);
                unassignedIndex++;
            }
        }
    }
    
    Object.keys(groups).forEach(k => delete groups[k]);
    Object.keys(states).forEach(k => delete states[k]);

    for (let i = 1; i <= groupCount; i++) {
        const pInGroup = newGroupsConfig[i];
        if (!pInGroup || pInGroup.length === 0) continue;
        const gId = `group${i}`;
        
        groups[gId] = { playerIds: pInGroup.map(p => p.playerId) };
        states[gId] = initState(gId);
        pInGroup.forEach(p => {
            states[gId].players[p.playerId] = { hp: 20, correctCount: 0 };
        });
    }

    for (const [gId, group] of Object.entries(groups)) {
        for (const pid of group.playerIds) {
            const pSocket = io.sockets.sockets.get(players[pid]?.socketId);
            if (pSocket) {
                pSocket.rooms.forEach(room => { if(room !== pSocket.id) pSocket.leave(room); });
                pSocket.join(gId);
                pSocket.emit("assigned_group", gId);
            }
        }
    }
    if (hostData.socketId) io.to(hostData.socketId).emit("host_state", getHostState());
  });

  socket.on("answer", ({ groupId, playerId, name, id }) => {
    const state = states[groupId];
    if (!state || !state.current || state.answered || state.locked || hostData.isPaused) return;
    
    const playerState = state.players[playerId];
    if (!playerState || playerState.hp <= 0) return;

    const answeredTorifuda = globalTorifudas.find(t => t.id === id);
    if (!answeredTorifuda) return;
    const correct = state.current.answer === answeredTorifuda.term;

    if (correct) {
        if(state.nextQuestionTimer) clearTimeout(state.nextQuestionTimer.timerId);
        state.nextQuestionTimer = null;
        state.answered = true;
        playerState.correctCount = (playerState.correctCount || 0) + 1;
        
        const answeredCard = state.current.cards.find(c => c.id === id);
        if (answeredCard) { answeredCard.correct = true; answeredCard.chosenBy = name; }
        
        groups[groupId].playerIds.forEach(pid => {
            if (pid !== playerId && state.players[pid]) {
                const p = state.players[pid];
                p.hp = Math.max(0, p.hp - state.current.point);
            }
        });
        
        io.to(groupId).emit("state", sanitizeStateForClient(state));
        checkGameEnd(groupId);
        if (!state.locked) setTimeout(() => nextQuestion(groupId), 3000);
    } else {
        playerState.hp -= state.current.point;
        if (playerState.hp <= 0) playerState.hp = 0;
        
        const answeredCard = state.current.cards.find(c => c.id === id);
        if (answeredCard) { answeredCard.incorrect = true; answeredCard.chosenBy = name; }
        
        io.to(groupId).emit("state", sanitizeStateForClient(state));
        checkGameEnd(groupId);
    }
  });

  socket.on('host_preparing_next_game', () => {
    if (socket.id !== hostData.socketId) return;
    
    Object.keys(states).forEach(key => delete states[key]); 
    gamePhase = 'WAITING_FOR_NEXT_GAME';
    
    io.emit("multiplayer_status_changed", gamePhase);
    socket.broadcast.emit('wait_for_next_game');
    
    socket.emit('request_game_phase', { fromEndScreen: true });
  });

  socket.on('host_full_reset', () => {
    if (socket.id !== hostData.socketId) return;
    console.log('🚨 ホストによってゲームが完全にリセットされました。');
    hostData = { socketId: null, hostKey: null, isPaused: false };
    globalTorifudas = [];
    globalYomifudas = [];
    globalSettings = {};
    gamePhase = 'INITIAL';
    
    Object.keys(players).forEach(key => delete players[key]);
    Object.keys(groups).forEach(key => delete groups[key]);
    Object.keys(states).forEach(key => delete states[key]);
    lastGameRanking = [];

    io.emit("multiplayer_status_changed", gamePhase);
    io.emit('force_reload', 'ホストによってゲームがリセットされました。ページをリロードします。');
  });

  socket.on('host_toggle_pause', () => {
    if (socket.id !== hostData.socketId) return;
    hostData.isPaused = !hostData.isPaused;
    console.log(`⏸️ ゲームが ${hostData.isPaused ? '一時停止' : '再開'} されました。`);
    io.emit('game_paused', hostData.isPaused);
    io.to(hostData.socketId).emit("host_state", getHostState());

    if (!hostData.isPaused) {
        Object.keys(groups).forEach(groupId => {
            const state = states[groupId];
            if (state && !state.locked && state.current && !state.answered) {
                // 停止中に次の問題に進むべきだった場合、ここで進める
                nextQuestion(groupId);
            }
        });
    }
  });

  socket.on('host_set_group_mode', ({ groupId, gameMode }) => {
    if (socket.id !== hostData.socketId) return;
    if (!states[groupId]) states[groupId] = initState(groupId);
    if (states[groupId] && (gameMode === 'normal' || gameMode === 'mask')) {
      states[groupId].gameMode = gameMode;
      console.log(`👑 Host set ${groupId} to ${gameMode} mode.`);
      socket.emit("host_state", getHostState());
    }
  });
  
  socket.on('host_export_data', () => {
    if (socket.id !== hostData.socketId) return;
    const backupData = { userPresets: {}, rankings: {} };
    try {
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
    } catch(err) {
        console.error("データのエクスポートに失敗しました:", err);
    }
  });

  socket.on('host_import_data', (data) => {
    if (socket.id !== hostData.socketId) return;
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
    if (socket.id !== hostData.socketId) return;
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
        name, playerId, difficulty, presetId,
        allTorifudas: singleTorifudas,
        allYomifudas: singleYomifudas,
        score: 0, current: null, answered: false, startTime: 0,
        presetName: `${presetData.category} - ${presetData.name}`,
        totalQuestions, history: []
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
    
    state.history.push({ 
      questionText: state.current.text,
      answer: state.current.answer,
      yourAnswer: answeredTorifuda.term,
      correct: correct
    });

    io.to(socket.id).emit('single_game_state', state);
    setTimeout(() => nextSingleQuestion(socket.id), 1500);
  });

  socket.on('single_game_timeup', () => {
    const state = singlePlayStates[socket.id];
    if (!state) return;

    const { score, playerId, name, presetId, presetName, difficulty, history } = state;
    
    const globalRankingFile = path.join(RANKINGS_DIR, `${presetId}_${difficulty}_global.json`);
    const personalBestFile = path.join(RANKINGS_DIR, `${presetId}_${difficulty}_personal.json`);

    let globalRankingData = readRankingFile(globalRankingFile);
    let globalRanking = globalRankingData.ranking || [];
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
        score, personalBest, globalRanking, presetName, history
    });

    delete singlePlayStates[socket.id];
  });

  socket.on("disconnect", () => {
    console.log(`🔌 プレイヤーが切断しました: ${socket.id}`);
    if (socket.id === hostData.socketId) {
        hostData.socketId = null;
        if (gamePhase === 'GAME_IN_PROGRESS' && !hostData.isPaused) {
            hostData.isPaused = true;
            io.emit('game_paused', hostData.isPaused);
            console.log(`👻 ホストが切断されたため、ゲームを自動的に一時停止します。`);
        }
        console.log(`👻 ホストがオフラインになりました。キー [${hostData.hostKey}] で復帰を待ちます。`);
    }
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

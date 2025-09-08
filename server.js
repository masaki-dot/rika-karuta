// server.js (HP0バグ修正・完全版)

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
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  
  try {
    const data = fs.readFileSync(path.join(__dirname, 'data', 'questions.json'), 'utf8');
    questionPresets = JSON.parse(data);
    console.log('✅ デフォルト問題プリセットを読み込みました。');
  } catch (err) {
    console.error('⚠️ デフォルト問題プリセットの読み込みに失敗しました:', err);
    questionPresets = {};
  }
  
  if (!fs.existsSync(USER_PRESETS_DIR)) fs.mkdirSync(USER_PRESETS_DIR, { recursive: true });
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
        const masterPlayer = players[p.playerId];
        const statePlayer = state?.players.find(sp => sp.playerId === p.playerId);
        return {
          name: p.name,
          hp: statePlayer?.hp ?? 20,
          correctCount: statePlayer?.correctCount ?? 0,
          totalScore: masterPlayer?.totalScore ?? p.totalScore ?? 0
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
    finishedGroups.add(groupId);
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

        const masterPlayer = players[p.playerId];
        if (masterPlayer && !alreadyUpdated.has(p.playerId)) {
            masterPlayer.totalScore = (masterPlayer.totalScore || 0) + p.finalScore;
            p.totalScore = masterPlayer.totalScore;
            alreadyUpdated.add(p.playerId);
        } else {
            p.totalScore = masterPlayer?.totalScore ?? p.finalScore;
        }
        
        let gPlayer = null;
        for (const gId in groups) {
            const foundPlayer = groups[gId].players.find(gp => gp.playerId === p.playerId);
            if (foundPlayer) {
                gPlayer = foundPlayer;
                break;
            }
        }
        if(gPlayer) gPlayer.totalScore = p.totalScore;
    });
    
    const activeGroupIds = Object.keys(groups).filter(gId => groups[gId] && groups[gId].players.length > 0);
    if (activeGroupIds.every(gId => finishedGroups.has(gId))) {
        console.log("全グループのゲームが終了しました。最終ランキングを計算します。");
        
        lastGameRanking = [];
        for(const gId of activeGroupIds) {
            if (states[gId] && states[gId].players) {
                states[gId].players.forEach(p => {
                    lastGameRanking.push({
                        playerId: p.playerId,
                        name: p.name,
                        finalScore: p.finalScore || 0
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
                thisGame: states[gId].players.sort((a,b) => (b.finalScore || 0) - (a.finalScore || 0)), 
                cumulative: cumulativeRanking,
                thisGameOverall: lastGameRanking 
            });
        }
        finishedGroups.clear();
    }
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
    
    const usedYomifudaTexts = new Set(state.usedQuestions);
    const remainingYomifudas = globalYomifudas.filter(y => !usedYomifudaTexts.has(y.text));
    
    if (remainingYomifudas.length === 0 || state.questionCount >= state.maxQuestions) {
        return finalizeGame(groupId);
    }

    const question = remainingYomifudas[Math.floor(Math.random() * remainingYomifudas.length)];
    state.usedQuestions.push(question.text);

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
        text: originalText,
        maskedIndices: maskedIndices,
        answer: question.answer,
        point,
        cards: cards.map(c => ({ id: c.id, term: c.term }))
    };
    state.questionCount++;
    state.waitingNext = false;
    state.answered = false;
    state.readDone = new Set();
    state.misClicks = [];

    io.to(groupId).emit("state", sanitizeState(state));
}

// --- シングルプレイ用ヘルパー ---
function readRankingFile(filePath) {
    if (!fs.existsSync(RANKINGS_DIR)) fs.mkdirSync(RANKINGS_DIR, { recursive: true });
    if (fs.existsSync(filePath)) {
        try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
        catch (e) { return {}; }
    }
    return {};
}

function writeRankingFile(filePath, data) {
    if (!fs.existsSync(RANKINGS_DIR)) fs.mkdirSync(RANKINGS_DIR, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
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
    players[playerId] = { playerId, socketId: socket.id, name: "未設定", totalScore: 0 };
    socket.emit('new_player_id_assigned', playerId);
  });

  socket.on('reconnect_player', ({ playerId, name }) => {
    if (players[playerId]) {
      players[playerId].socketId = socket.id;
      if (name) players[playerId].name = name;
    } else {
      players[playerId] = { playerId, socketId: socket.id, name: name || "未設定", totalScore: 0 };
    }
    console.log(`🔄 ${players[playerId].name}(${playerId.substring(0,4)})が再接続しました。`);
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
    if (socket.id !== hostSocketId) return;
    if (questionPresets[presetId]) {
        parseAndSetCards(questionPresets[presetId]);
        globalSettings = { ...settings, maxQuestions: globalYomifudas.length };
        
        if (!isNextGame) {
            Object.keys(states).forEach(key => delete states[key]);
            Object.keys(groups).forEach(key => delete groups[key]);
            lastGameRanking = [];
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
        socket.emit('host_setup_done');
        io.emit("multiplayer_status_changed", gamePhase);
    } else {
        Object.keys(states).forEach(key => delete states[key]);
        gamePhase = 'WAITING_FOR_NEXT_GAME';
        io.to(hostSocketId).emit('host_setup_done');
    }
  });

  socket.on("join", ({ groupId, playerId }) => {
    const player = players[playerId];
    if (!player) return;

    for (const gId in groups) {
        if (groups[gId] && groups[gId].players) {
            groups[gId].players = groups[gId].players.filter(p => p.playerId !== playerId);
        }
        if (states[gId] && states[gId].players) {
            states[gId].players = states[gId].players.filter(p => p.playerId !== playerId);
        }
    }

    const socketInstance = io.sockets.sockets.get(player.socketId);
    if (socketInstance) {
        for (const room of socketInstance.rooms) {
            if (room !== socketInstance.id) {
                socketInstance.leave(room);
            }
        }
    }
    
    socket.join(groupId);
    
    if (!groups[groupId]) groups[groupId] = { players: [] };
    if (!states[groupId]) states[groupId] = initState(groupId);

    if (!groups[groupId].players.find(p => p.playerId === playerId)) {
      groups[groupId].players.push({ playerId, name: player.name, totalScore: player.totalScore || 0 });
    }
    
    const state = states[groupId];
    if (!state.players.find(p => p.playerId === playerId)) {
      state.players.push({ playerId, name: player.name, hp: 20, correctCount: 0 });
    }
    
    if(hostSocketId) io.to(hostSocketId).emit("host_state", getHostState());
  });

  socket.on("rejoin_game", ({ playerId }) => {
    for (const [gId, group] of Object.entries(groups)) {
        if (group.players.find(p => p.playerId === playerId)) {
            const state = states[gId];
            if (state && !state.locked) {
                socket.join(gId);
                socket.emit('rejoin_game', sanitizeState(state));
            } else {
                socket.emit('game_phase_response', { phase: gamePhase });
            }
            return;
        }
    }
    socket.emit('game_phase_response', { phase: gamePhase });
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
    if (hostSocketId) io.to(hostSocketId).emit("host_state", getHostState());
  });
  
  socket.on("read_done", (groupId) => {
    const state = states[groupId];
    if (!state || !state.current || state.readTimer || state.answered || state.waitingNext) return;
    
    const latestText = state.current.text;
    io.to(groupId).emit("timer_start", { seconds: 30 });
    
    state.readTimer = setTimeout(() => {
        if (state && !state.answered && !state.waitingNext && state.current?.text === latestText) {
            state.waitingNext = true;
            const correctCard = state.current.cards.find(c => c.term === state.current.answer);
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
      const allPs = Object.values(players)
          .filter(p => p.name !== "未設定" && !p.isHost)
          .map(p => ({ name: p.name, totalScore: p.totalScore || 0 }));
      socket.emit("global_ranking", allPs.sort((a, b) => b.totalScore - a.totalScore));
  });

  socket.on("host_start", () => {
    if (socket.id !== hostSocketId) return;
    console.log("▶ ホストが全体スタートを実行");

    gamePhase = 'GAME_IN_PROGRESS';
    finishedGroups.clear();
    for (const groupId of Object.keys(groups)) {
        if (!groups[groupId] || groups[groupId].players.length === 0) continue;
        
        if (states[groupId] && states[groupId].readTimer) {
            clearTimeout(states[groupId].readTimer);
        }

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

  socket.on("host_assign_groups", ({ groupCount, topGroupCount, groupSizes }) => {
    if (socket.id !== hostSocketId) return;

    const allCurrentPlayers = Object.values(players).filter(p => p.name !== "未設定" && !p.isHost);
    
    const sortingSource = lastGameRanking.length > 0 ? lastGameRanking : allCurrentPlayers;
    const scoreKey = lastGameRanking.length > 0 ? 'finalScore' : 'totalScore';

    const sortedPlayerIds = sortingSource
        .sort((a, b) => (b[scoreKey] || 0) - (a[scoreKey] || 0))
        .map(p => p.playerId);
    
    const allPlayersMap = new Map();
    allCurrentPlayers.forEach(p => allPlayersMap.set(p.playerId, p));
    
    const sortedPlayers = sortedPlayerIds.map(id => allPlayersMap.get(id)).filter(Boolean);

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
        if (!placed) break;
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
    
    Object.keys(states).forEach(k => delete states[k]);
    Object.keys(groups).forEach(k => delete groups[k]);

    for (let i = 1; i <= groupCount; i++) {
        const pInGroup = newGroupsConfig[i];
        if (!pInGroup || pInGroup.length === 0) continue;
        const gId = `group${i}`;
        
        groups[gId] = {
            players: pInGroup.map(p => ({
                playerId: p.playerId,
                name: p.name,
                totalScore: allPlayersMap.get(p.playerId)?.totalScore || 0
            }))
        };
        
        states[gId] = initState(gId);
        states[gId].players = pInGroup.map(p => ({ 
            playerId: p.playerId, name: p.name, hp: 20, score: 0, correctCount: 0 
        }));
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
    if (hostSocketId) io.to(hostSocketId).emit("host_state", getHostState());
  });

  socket.on("answer", ({ groupId, playerId, name, id }) => {
    const state = states[groupId];
    if (!state || !state.current || state.answered || state.locked) return;
    
    const playerState = state.players.find(p => p.playerId === playerId);
    if (!playerState || playerState.hp <= 0) return;

    const answeredTorifuda = globalTorifudas.find(t => t.id === id);
    if (!answeredTorifuda) return;

    const correct = state.current.answer === answeredTorifuda.term;
    const point = state.current.point;

    if (correct) {
        state.answered = true;
        playerState.correctCount = (playerState.correctCount || 0) + 1;
        
        state.current.cards.find(c => c.id === id).correct = true;
        state.current.cards.find(c => c.id === id).chosenBy = name;
        
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
        state.misClicks.push({ name, id });
        state.current.cards.find(c => c.id === id).incorrect = true;
        state.current.cards.find(c => c.id === id).chosenBy = name;

        io.to(groupId).emit("state", sanitizeState(state));
        checkGameEnd(groupId);
    }
  });

  socket.on('host_preparing_next_game', () => {
    if (socket.id !== hostSocketId) return;
    
    Object.keys(states).forEach(key => delete states[key]); 
    gamePhase = 'WAITING_FOR_NEXT_GAME';
    
    io.emit("multiplayer_status_changed", gamePhase);
    socket.broadcast.emit('wait_for_next_game');
    
    socket.emit('request_game_phase', { fromEndScreen: true });
  });

  socket.on('host_full_reset', () => {
    if (socket.id !== hostSocketId) return;
    console.log('🚨 ホストによってゲームが完全にリセットされました。');
    hostSocketId = null;
    globalTorifudas = [];
    globalYomifudas = [];
    globalSettings = {};
    gamePhase = 'INITIAL';
    
    Object.keys(players).forEach(key => delete players[key]);
    Object.keys(groups).forEach(key => delete groups[key]);
    Object.keys(states).forEach(key => delete states[key]);
    lastGameRanking = [];

    io.emit('multiplayer_status_changed', gamePhase);
    io.emit('force_reload', 'ホストによってゲームがリセットされました。ページをリロードします。');
  });

  socket.on('host_set_group_mode', ({ groupId, gameMode }) => {
    if (socket.id !== hostSocketId) return;
    if (!states[groupId]) states[groupId] = initState(groupId);
    if (states[groupId] && (gameMode === 'normal' || gameMode === 'mask')) {
      states[groupId].gameMode = gameMode;
      console.log(`👑 Host set ${groupId} to ${gameMode} mode.`);
      socket.emit("host_state", getHostState());
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
        totalQuestions
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

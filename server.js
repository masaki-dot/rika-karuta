// server.js (ホスト参加フロー修正・究極安定版)

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

// --- ログ出力ヘルパー ---
const log = {
    info: (message) => console.log(`[INFO] ${new Date().toISOString()}: ${message}`),
    warn: (message) => console.warn(`[WARN] ${new Date().toISOString()}: ${message}`),
    error: (message, error) => console.error(`[ERROR] ${new Date().toISOString()}: ${message}`, error || ''),
};

// --- 単一状態管理オブジェクト (Single Source of Truth) ---
let gameState = {
    phase: 'INITIAL', // INITIAL, GROUP_SELECTION, GAME_IN_PROGRESS, WAITING_FOR_NEXT_GAME
    host: {
        playerId: null,
        socketId: null,
        hostKey: null,
        isPaused: false
    },
    settings: {
        numCards: 5,
        showSpeed: 1000,
        gameMode: 'mask',
        rankingDisplayCount: 10,
        maxQuestions: 10,
    },
    players: {}, // { playerId: { name, totalScore, socketId, isHost } }
    groups: {},  // { groupId: { playerIds: [], state: { ... } } }
    gameData: {
        torifudas: [],
        yomifudas: []
    },
    lastGameRanking: []
};

let questionPresets = {};
let singlePlayStates = {};

// --- サーバー初期化処理 ---
function initializeServer() {
    log.info("サーバーを初期化しています...");
    loadPresets();
    log.info("サーバーの初期化が完了しました。");
}
initializeServer();

function loadPresets() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    
    const data = fs.readFileSync(path.join(__dirname, 'data', 'questions.json'), 'utf8');
    questionPresets = JSON.parse(data);
    log.info('デフォルト問題プリセットを読み込みました。');
  } catch (err) {
    log.error('デフォルト問題プリセットの読み込みに失敗しました:', err);
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
    if (userFiles.length > 0) log.info(`ユーザー作成プリセットを ${userFiles.length} 件読み込みました。`);
  } catch(err) {
      log.error('ユーザー作成プリセットの読み込みに失敗しました:', err);
  }
}

// --- ヘルパー関数群 ---
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}
function getPlayerBySocketId(socketId) {
    return Object.values(gameState.players).find(p => p.socketId === socketId);
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
    
    gameState.gameData.torifudas = [...torifudas];
    gameState.gameData.yomifudas = [...yomifudas];
}

function getPlayerStateInGroup(playerId, state) {
    const playerMasterData = gameState.players[playerId];
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
    players: {}, // { playerId: { hp, correctCount } }
    questionCount: 0,
    maxQuestions: gameState.settings.maxQuestions || 10,
    numCards: gameState.settings.numCards,
    gameMode: gameState.settings.gameMode,
    current: null, 
    answered: false,
    nextQuestionTimer: null,
    usedQuestions: new Set(),
    locked: false
  };
}

function sanitizeStateForClient(state) {
  if (!state) return null;
  const clientPlayers = gameState.groups[state.groupId]?.playerIds.map(pid => getPlayerStateInGroup(pid, state)).filter(Boolean) || [];

  return {
    groupId: state.groupId,
    players: clientPlayers,
    questionCount: state.questionCount,
    maxQuestions: state.maxQuestions,
    gameMode: state.gameMode,
    showSpeed: gameState.settings.showSpeed,
    current: state.current,
    locked: state.locked,
    answered: state.answered,
  };
}

function getHostStateForClient() {
  // プレイヤーが0人のグループをクリーンアップ
  for (const groupId in gameState.groups) {
    if (gameState.groups[groupId].playerIds.length === 0) {
      delete gameState.groups[groupId];
    }
  }

  const allGroups = {};
  const assignedPlayerIds = new Set();
  for (const [groupId, group] of Object.entries(gameState.groups)) {
    allGroups[groupId] = {
      locked: group.state.locked,
      gameMode: group.state.gameMode,
      players: group.playerIds.map(pid => {
           const masterPlayer = gameState.players[pid];
           const gamePlayer = group.state.players[pid];
           if (!masterPlayer || !gamePlayer) return null;
           return {
              name: masterPlayer.name,
              hp: gamePlayer.hp,
              correctCount: gamePlayer.correctCount
           };
      }).filter(Boolean)
    };
    group.playerIds.forEach(pid => assignedPlayerIds.add(pid));
  }
  
  const unassignedPlayers = Object.values(gameState.players)
      .filter(p => !p.isHost && !assignedPlayerIds.has(p.playerId))
      .map(p => ({ name: p.name, totalScore: p.totalScore }));

  const globalRanking = Object.values(gameState.players)
      .filter(p => !p.isHost)
      .sort((a, b) => b.totalScore - a.totalScore)
      .slice(0, gameState.settings.rankingDisplayCount);

  return { allGroups, unassignedPlayers, globalRanking, isPaused: gameState.host.isPaused };
}

function finalizeGame(groupId) {
    const group = gameState.groups[groupId];
    if (!group || group.state.locked) return;

    if (group.state.nextQuestionTimer) clearTimeout(group.state.nextQuestionTimer.timerId);
    group.state.nextQuestionTimer = null;
    group.state.locked = true;
    finishedGroups.add(groupId);
    log.info(`[${groupId}] のゲーム終了処理を開始します。`);

    const playersInGroup = group.playerIds.map(pid => {
        const master = gameState.players[pid];
        const gameData = group.state.players[pid];
        return { ...master, ...gameData };
    });

    const rankingInGroup = playersInGroup.sort((a, b) => (b.hp - a.hp) || ((b.correctCount || 0) - (a.correctCount || 0)));

    rankingInGroup.forEach((p, i) => {
        let bonus = 0;
        if (i === 0) bonus = 200;
        else if (i === 1) bonus = 100;
        p.finalScore = (p.correctCount || 0) * 10 + bonus;
        gameState.players[p.playerId].totalScore += p.finalScore;
    });
    
    const activeGroupIds = Object.keys(gameState.groups).filter(gId => gameState.groups[gId].playerIds.length > 0);
    if (activeGroupIds.every(gId => finishedGroups.has(gId))) {
        log.info("全グループのゲームが終了しました。");
        gameState.lastGameRanking = Object.values(gameState.players)
            .filter(p => !p.isHost)
            .map(p => {
                const rankInfo = rankingInGroup.find(r => r.playerId === p.playerId);
                return { playerId: p.playerId, name: p.name, finalScore: rankInfo ? rankInfo.finalScore : 0 };
            })
            .sort((a,b) => b.finalScore - a.finalScore);
        
        const cumulativeRanking = Object.values(gameState.players)
            .filter(p => !p.isHost)
            .sort((a, b) => b.totalScore - a.totalScore)
            .slice(0, gameState.settings.rankingDisplayCount);
        
        for(const gId of activeGroupIds) {
            io.to(gId).emit("end", { 
                thisGame: rankingInGroup.filter(p => gameState.groups[gId].playerIds.includes(p.playerId)),
                cumulative: cumulativeRanking,
                thisGameOverall: gameState.lastGameRanking 
            });
        }
        finishedGroups.clear();
        gameState.phase = 'WAITING_FOR_NEXT_GAME';
    }
}

function checkGameEnd(groupId) {
  const group = gameState.groups[groupId];
  if (!group || group.state.locked) return;

  const survivors = group.playerIds.filter(pid => group.state.players[pid] && group.state.players[pid].hp > 0);
  if (survivors.length <= 1) {
    finalizeGame(groupId);
  }
}

function nextQuestion(groupId) {
    const group = gameState.groups[groupId];
    if (!group || group.state.locked || gameState.host.isPaused) return;

    if (group.state.nextQuestionTimer) clearTimeout(group.state.nextQuestionTimer.timerId);
    group.state.nextQuestionTimer = null;
    
    const remainingYomifudas = gameState.gameData.yomifudas.filter(y => !group.state.usedQuestions.has(y.text));
    if (remainingYomifudas.length === 0 || group.state.questionCount >= group.state.maxQuestions) {
        return finalizeGame(groupId);
    }
    
    const question = remainingYomifudas[Math.floor(Math.random() * remainingYomifudas.length)];
    group.state.usedQuestions.add(question.text);

    const correctTorifuda = gameState.gameData.torifudas.find(t => t.term === question.answer);
    if (!correctTorifuda) {
        log.error(`正解の取り札が見つかりません: ${question.answer}`);
        return nextQuestion(groupId);
    }
    const distractors = shuffle([...gameState.gameData.torifudas.filter(t => t.id !== correctTorifuda.id)]).slice(0, gameState.settings.numCards - 1);
    const cards = shuffle([...distractors, correctTorifuda]);

    let point = 1;
    const rand = Math.random();
    if (rand < 0.05) point = 5;
    else if (rand < 0.20) point = 3;
    else if (rand < 0.60) point = 2;

    const originalText = question.text;
    let maskedIndices = [];
    if (group.state.gameMode === 'mask') {
        let indices = Array.from({length: originalText.length}, (_, i) => i);
        indices = indices.filter(i => originalText[i] !== ' ' && originalText[i] !== '　');
        shuffle(indices);
        maskedIndices = indices.slice(0, Math.floor(indices.length / 2));
    }
    
    group.state.current = {
        text: originalText, maskedIndices, answer: question.answer, point,
        cards: cards.map(c => ({ id: c.id, term: c.term }))
    };
    group.state.questionCount++;
    group.state.answered = false;

    io.to(groupId).emit("state", sanitizeStateForClient(group.state));
}

// --- シングルプレイ用ヘルパー ---
function readRankingFile(filePath) {
    try {
        if (!fs.existsSync(RANKINGS_DIR)) fs.mkdirSync(RANKINGS_DIR, { recursive: true });
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (e) {
        log.error(`ランキングファイルの読み込みに失敗: ${filePath}`, e);
    }
    return {};
}

function writeRankingFile(filePath, data) {
    try {
        if (!fs.existsSync(RANKINGS_DIR)) fs.mkdirSync(RANKINGS_DIR, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (e) {
        log.error(`ランキングファイルの書き込みに失敗: ${filePath}`, e);
    }
}

function nextSingleQuestion(socketId, isFirstQuestion = false) {
    const state = singlePlayStates[socketId];
    if (!state) return;

    const question = state.allYomifudas[Math.floor(Math.random() * state.allYomifudas.length)];
    const correctTorifuda = state.allTorifudas.find(t => t.term === question.answer);
    if (!correctTorifuda) {
        log.error(`シングルプレイ: 正解の取り札が見つかりません: "${question.answer}"`);
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
    
    const socket = io.sockets.sockets.get(socketId);
    if (socket && !isFirstQuestion) {
        socket.emit('single_game_state', state);
    }
}


// --- 接続処理 ---
io.on("connection", (socket) => {
  try {
    log.info(`プレイヤーが接続しました: ${socket.id}`);

    socket.on('request_new_player_id', () => {
        const playerId = uuidv4();
        gameState.players[playerId] = { playerId, socketId: socket.id, name: "未設定", totalScore: 0, isHost: false };
        socket.emit('new_player_id_assigned', playerId);
        socket.emit('initial_setup');
    });

    socket.on('reconnect_player', ({ playerId, name }) => {
        if (gameState.players[playerId]) {
            gameState.players[playerId].socketId = socket.id;
            if (name) gameState.players[playerId].name = name;
        } else {
            gameState.players[playerId] = { playerId, socketId: socket.id, name: name || "未設定", totalScore: 0, isHost: false };
        }
        log.info(`${name}(${playerId.substring(0,4)})が再接続しました。`);
        socket.emit('game_phase_response', {phase: gameState.phase});
    });

    socket.on('request_game_phase', ({ fromEndScreen = false } = {}) => {
        const presetsForClient = Object.fromEntries(Object.entries(questionPresets).map(([id, data]) => [id, { category: data.category, name: data.name }]));
        socket.emit('game_phase_response', { phase: gameState.phase, presets: presetsForClient, fromEndScreen });
    });

    socket.on("host_join", ({ playerId, hostKey }) => {
        // ★★★ 最重要修正点 ★★★
        if (!gameState.host.hostKey) {
            log.info(`新しいホストが参加しました: ${playerId}`);
            gameState.host.hostKey = Math.random().toString(36).substring(2, 8).toUpperCase();
        } else if (hostKey !== gameState.host.hostKey) {
            log.warn(`不正なホストキーでの参加試行を拒否しました: ${playerId}`);
            socket.emit('force_reload', 'ホストキーが違うか、すでに別のゲームが進行中です。');
            return;
        }

        log.info(`ホストとして認証: ${playerId}`);
        gameState.host.playerId = playerId;
        gameState.host.socketId = socket.id;
        if (gameState.players[playerId]) gameState.players[playerId].isHost = true;
        
        socket.join('host_room');
        socket.emit('host_key_assigned', gameState.host.hostKey);

        // 新規ホストか復帰ホストかで表示画面を切り替える
        if (gameState.phase === 'INITIAL') {
            socket.emit('request_game_phase', { fromEndScreen: false });
        } else {
            socket.emit('host_setup_done', { lastGameRanking: gameState.lastGameRanking, isPaused: gameState.host.isPaused });
        }
    });

    socket.on("set_preset_and_settings", ({ presetId, settings, isNextGame }) => {
        if (socket.id !== gameState.host.socketId) return;
        if (questionPresets[presetId]) {
            parseAndSetCards(questionPresets[presetId]);
            gameState.settings = { ...gameState.settings, ...settings };
            
            if (!isNextGame) {
                gameState.groups = {};
                gameState.lastGameRanking = [];
                gameState.phase = 'GROUP_SELECTION';
                io.emit("multiplayer_status_changed", gameState.phase);
                socket.emit('host_setup_done', { isPaused: gameState.host.isPaused });
            } else {
                Object.values(gameState.groups).forEach(g => {
                    if(g && g.groupId) g.state = initState(g.groupId);
                });
                gameState.phase = 'WAITING_FOR_NEXT_GAME';
                io.emit("multiplayer_status_changed", gameState.phase);
                socket.emit('host_setup_done', { isPaused: gameState.host.isPaused });
            }
        }
    });
    
    socket.on("join", ({ groupId, playerId }) => {
        if (!gameState.players[playerId]) return;
        Object.values(gameState.groups).forEach(g => {
            const index = g.playerIds.indexOf(playerId);
            if (index > -1) g.playerIds.splice(index, 1);
        });
        if (!gameState.groups[groupId]) gameState.groups[groupId] = { playerIds: [], state: initState(groupId), groupId };
        if (!gameState.groups[groupId].playerIds.includes(playerId)) gameState.groups[groupId].playerIds.push(playerId);
        if (!gameState.groups[groupId].state.players[playerId]) gameState.groups[groupId].state.players[playerId] = { hp: 20, correctCount: 0 };
        
        socket.rooms.forEach(room => { if (room !== socket.id) socket.leave(room); });
        socket.join(groupId);
        if(gameState.host.socketId) io.to(gameState.host.socketId).emit("host_state", getHostStateForClient());
    });

    socket.on("rejoin_game", ({ playerId }) => {
        for (const [gId, group] of Object.entries(gameState.groups)) {
            if (group.playerIds.includes(playerId)) {
                socket.join(gId); 
                if (gameState.phase === 'GAME_IN_PROGRESS' && group.state && !group.state.locked) {
                    socket.emit('rejoin_game', sanitizeStateForClient(group.state));
                } else {
                    socket.emit("assigned_group", gId);
                }
                return;
            }
        }
        socket.emit('game_phase_response', { phase: gameState.phase });
    });

    socket.on("set_name", ({ playerId, name }) => {
        if (gameState.players[playerId]) {
            gameState.players[playerId].name = name;
            if(gameState.host.socketId) io.to(gameState.host.socketId).emit("host_state", getHostStateForClient());
            for (const group of Object.values(gameState.groups)) {
                if(group.playerIds.includes(playerId)) {
                    io.to(group.groupId).emit("state", sanitizeStateForClient(group.state));
                }
            }
        }
    });

    socket.on("host_start", () => {
        if (socket.id !== gameState.host.socketId) return;
        log.info("ホストが全体スタートを実行");
        gameState.host.isPaused = false;
        io.emit('game_paused', gameState.host.isPaused);
        gameState.phase = 'GAME_IN_PROGRESS';
        finishedGroups.clear();
        for (const groupId in gameState.groups) {
            if (gameState.groups[groupId].playerIds.length > 0) {
                const group = gameState.groups[groupId];
                group.state = initState(groupId);
                group.playerIds.forEach(pid => {
                    group.state.players[pid] = { hp: 20, correctCount: 0 };
                });
                nextQuestion(groupId);
            }
        }
    });
    
    socket.on("answer", ({ groupId, playerId, name, id }) => {
        const group = gameState.groups[groupId];
        if (!group || !group.state.current || group.state.answered || group.state.locked || gameState.host.isPaused) return;
        
        const playerState = group.state.players[playerId];
        if (!playerState || playerState.hp <= 0) return;
    
        const answeredCard = gameState.gameData.torifudas.find(t => t.id === id);
        if (!answeredCard) return;
        const correct = group.state.current.answer === answeredCard.term;
    
        if (correct) {
            if(group.state.nextQuestionTimer) clearTimeout(group.state.nextQuestionTimer.timerId);
            group.state.nextQuestionTimer = null;
            group.state.answered = true;
            playerState.correctCount++;
            
            const cardInGame = group.state.current.cards.find(c => c.id === id);
            if (cardInGame) { cardInGame.correct = true; cardInGame.chosenBy = name; }
            
            group.playerIds.forEach(pid => {
                if (pid !== playerId && group.state.players[pid]) {
                    group.state.players[pid].hp = Math.max(0, group.state.players[pid].hp - group.state.current.point);
                }
            });
            
            io.to(groupId).emit("state", sanitizeStateForClient(group.state));
            checkGameEnd(groupId);
            if (!group.state.locked) setTimeout(() => nextQuestion(groupId), 3000);
        } else {
            playerState.hp = Math.max(0, playerState.hp - group.state.current.point);
            const cardInGame = group.state.current.cards.find(c => c.id === id);
            if (cardInGame) { cardInGame.incorrect = true; cardInGame.chosenBy = name; }
            io.to(groupId).emit("state", sanitizeStateForClient(group.state));
            checkGameEnd(groupId);
        }
    });

    socket.on('host_toggle_pause', () => {
        if (socket.id !== gameState.host.socketId) return;
        gameState.host.isPaused = !gameState.host.isPaused;
        log.info(`ゲームが ${gameState.host.isPaused ? '一時停止' : '再開'} されました。`);
        io.emit('game_paused', gameState.host.isPaused);
        if (!gameState.host.isPaused) {
            Object.keys(gameState.groups).forEach(nextQuestion);
        }
        io.to(gameState.host.socketId).emit("host_state", getHostStateForClient());
    });

    socket.on('host_full_reset', () => {
        if (socket.id !== gameState.host.socketId) return;
        log.warn('ホストによってゲームが完全にリセットされました。');
        gameState = {
            phase: 'INITIAL', host: { playerId: null, socketId: null, hostKey: null, isPaused: false },
            settings: { numCards: 5, showSpeed: 1000, gameMode: 'mask', rankingDisplayCount: 10, maxQuestions: 10 },
            players: {}, groups: {}, gameData: { torifudas: [], yomifudas: [] }, lastGameRanking: []
        };
        io.emit('force_reload', 'ホストによってゲームがリセットされました。ページをリロードします。');
    });

    socket.on("disconnect", () => {
        log.info(`プレイヤーが切断しました: ${socket.id}`);
        if (socket.id === gameState.host.socketId) {
            gameState.host.socketId = null;
            log.warn(`ホストが切断されました。キー [${gameState.host.hostKey}] での復帰を待ちます。`);
        }
        const player = getPlayerBySocketId(socket.id);
        if (player) {
            log.info(`${player.name} がオフラインになりました。`);
            player.socketId = null; // socketIdをnullにしてオフラインを示す
        }
        delete singlePlayStates[socket.id];
    });

    socket.on("host_request_state", () => {
      if (socket.id === gameState.host.socketId) socket.emit("host_state", getHostStateForClient());
    });

    socket.on("host_assign_groups", ({ groupCount, topGroupCount, groupSizes }) => {
        if (socket.id !== gameState.host.socketId) return;
        const allCurrentPlayers = Object.values(gameState.players).filter(p => !p.isHost && p.name !== "未設定");
        const sortingSource = gameState.lastGameRanking.length > 0 ? gameState.lastGameRanking.map(p => gameState.players[p.playerId]).filter(Boolean) : allCurrentPlayers;
        const scoreKey = gameState.lastGameRanking.length > 0 ? 'finalScore' : 'totalScore';
        
        const sortedPlayers = [...sortingSource].sort((a, b) => (b[scoreKey] || 0) - (a[scoreKey] || 0));
    
        const numTopPlayers = groupSizes.slice(0, topGroupCount).reduce((sum, size) => sum + (size || 0), 0);
        const topPlayers = sortedPlayers.slice(0, numTopPlayers);
        const otherPlayers = shuffle(sortedPlayers.slice(numTopPlayers));
    
        const newGroupsConfig = {};
        for (let i = 1; i <= groupCount; i++) newGroupsConfig[i] = [];
    
        let topPlayerIndex = 0;
        for (let i = 1; i <= topGroupCount; i++) {
            const capacity = groupSizes[i - 1] || 0;
            while (newGroupsConfig[i].length < capacity && topPlayerIndex < topPlayers.length) {
                newGroupsConfig[i].push(topPlayers[topPlayerIndex++]);
            }
        }
    
        let otherPlayerIndex = 0;
        while (otherPlayerIndex < otherPlayers.length) {
            let placed = false;
            for (let i = topGroupCount + 1; i <= groupCount; i++) {
                if (otherPlayerIndex >= otherPlayers.length) break;
                if (newGroupsConfig[i].length < (groupSizes[i-1] || 0) ) {
                    newGroupsConfig[i].push(otherPlayers[otherPlayerIndex++]);
                    placed = true;
                }
            }
            if (!placed) { //
                for (let i = 1; i <= groupCount; i++) {
                    if (otherPlayerIndex >= otherPlayers.length) break;
                    newGroupsConfig[i].push(otherPlayers[otherPlayerIndex++]);
                }
            }
        }
        
        gameState.groups = {};
    
        for (let i = 1; i <= groupCount; i++) {
            const pInGroup = newGroupsConfig[i];
            if (!pInGroup || pInGroup.length === 0) continue;
            const gId = `group${i}`;
            
            gameState.groups[gId] = { playerIds: pInGroup.map(p => p.playerId), state: initState(gId), groupId: gId };
            pInGroup.forEach(p => {
                gameState.groups[gId].state.players[p.playerId] = { hp: 20, correctCount: 0 };
            });
        }
    
        for (const [gId, group] of Object.entries(gameState.groups)) {
            for (const pid of group.playerIds) {
                const pSocket = io.sockets.sockets.get(gameState.players[pid]?.socketId);
                if (pSocket) {
                    pSocket.rooms.forEach(room => { if(room !== pSocket.id) pSocket.leave(room); });
                    pSocket.join(gId);
                    pSocket.emit("assigned_group", gId);
                }
            }
        }
        io.to(gameState.host.socketId).emit("host_state", getHostStateForClient());
      });
    
      socket.on('host_preparing_next_game', () => {
        if (socket.id !== gameState.host.socketId) return;
        Object.values(gameState.groups).forEach(g => {
            if (g && g.groupId) g.state = initState(g.groupId);
        }); 
        gameState.phase = 'WAITING_FOR_NEXT_GAME';
        io.emit("multiplayer_status_changed", gameState.phase);
        socket.broadcast.emit('wait_for_next_game');
        socket.emit('request_game_phase', { fromEndScreen: true });
      });
    
      socket.on('host_set_group_mode', ({ groupId, gameMode }) => {
        if (socket.id !== gameState.host.socketId) return;
        if (gameState.groups[groupId]) {
          gameState.groups[groupId].state.gameMode = gameMode;
          log.info(`ホストが ${groupId} のモードを ${gameMode} に変更しました。`);
          io.to(gameState.host.socketId).emit("host_state", getHostStateForClient());
        }
      });
    
      socket.on('host_export_data', () => { /* ... */ });
      socket.on('host_import_data', (data) => { /* ... */ });
      socket.on('host_delete_preset', ({ presetId }) => { /* ... */ });
    
      // --- シングルプレイ用イベント ---
      socket.on('request_presets', () => {
          const presetsForClient = Object.fromEntries(Object.entries(questionPresets).map(([id, data]) => [id, { category: data.category, name: data.name }]));
          socket.emit('presets_list', presetsForClient);
      });
        
      socket.on('start_single_play', ({ name, playerId, difficulty, presetId }) => {
          if (gameState.players[playerId]) gameState.players[playerId].name = name;
          const presetData = questionPresets[presetId];
          if (!presetData) return;
      
          const singleTorifudas = [];
          const singleYomifudas = [];
          const data = presetData.rawData || presetData.cards;
          const isNewFormat = !!presetData.rawData;
      
          for (const row of data) {
              if (isNewFormat) {
                  if (row.col1.startsWith('def_')) singleTorifudas.push({ id: row.col1, term: row.col2 });
                  else singleYomifudas.push({ answer: row.col1, text: row.col3 });
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
          socket.emit('single_game_start', singlePlayStates[socket.id]);
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
      
          socket.emit('single_game_state', state);
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

  } catch (error) {
    log.error(`ソケット通信で予期せぬエラーが発生しました (Socket ID: ${socket.id}):`, error);
  }
});

// サーバー起動
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log.info(`サーバーがポート ${PORT} で起動しました。`);
});

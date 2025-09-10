const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    // 接続が不安定な場合のリコネクション設定を強化
    pingInterval: 10000,
    pingTimeout: 5000,
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
});

app.use(express.static(path.join(__dirname, "public")));

// --- データディレクトリ設定 ---
// Render.comなどの環境では、ファイルシステムは永続的ではないことに注意。
// 永続化が必要な場合は、RenderのDisk機能や外部DB、S3などの利用を検討。
const DATA_DIR = path.join(__dirname, 'data');
const USER_PRESETS_DIR = path.join(DATA_DIR, 'user_presets');
const RANKINGS_DIR = path.join(DATA_DIR, 'rankings');

// --- グローバル状態管理 ---
let hostPlayerId = null; // ホストをplayerIdで管理
let gamePhase = 'INITIAL'; // INITIAL, GROUP_SELECTION, GAME_IN_PROGRESS, WAITING_FOR_NEXT_GAME
let questionPresets = {};
let globalTorifudas = [];
let globalYomifudas = [];
let globalSettings = {};

const players = {}; // { playerId: { socketId, name, totalScore, isHost, isOnline } }
const groups = {};  // { groupId: { players: [{ playerId, name }] } }
const states = {};  // { groupId: => ゲームごとの状態 }
const singlePlayStates = {};

// --- サーバー初期化処理 ---
function initializeServer() {
    // データディレクトリが存在しない場合は作成
    [DATA_DIR, USER_PRESETS_DIR, RANKINGS_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) {
            try {
                fs.mkdirSync(dir, { recursive: true });
                console.log(`✅ Directory created: ${dir}`);
            } catch (error) {
                console.error(`🚨 Failed to create directory ${dir}:`, error);
            }
        }
    });
    loadPresets();
}

function loadPresets() {
    let defaultPresets = {};
    let userPresets = {};

    try {
        const data = fs.readFileSync(path.join(__dirname, 'data', 'questions.json'), 'utf8');
        defaultPresets = JSON.parse(data);
        console.log('✅ デフォルト問題プリセットを読み込みました。');
    } catch (err) {
        console.error('⚠️ デフォルト問題プリセットの読み込みに失敗しました:', err);
    }
    
    try {
        const userFiles = fs.readdirSync(USER_PRESETS_DIR).filter(file => file.endsWith('.json'));
        userFiles.forEach(file => {
            const filePath = path.join(USER_PRESETS_DIR, file);
            const data = fs.readFileSync(filePath, 'utf8');
            const presetId = `user_${path.basename(file, '.json')}`;
            userPresets[presetId] = JSON.parse(data);
        });
        if (userFiles.length > 0) console.log(`✅ ユーザー作成プリセットを ${userFiles.length} 件読み込みました。`);
    } catch(err) {
        console.error('⚠️ ユーザー作成プリセットの読み込みに失敗しました:', err);
    }
    questionPresets = {...defaultPresets, ...userPresets};
}

initializeServer();


// --- ヘルパー関数群 ---
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function getPlayer(playerId) {
    return players[playerId];
}

function getHostSocket() {
    if (!hostPlayerId) return null;
    const host = getPlayer(hostPlayerId);
    if (!host || !host.isOnline) return null;
    return io.sockets.sockets.get(host.socketId);
}

// プレイヤーを全てのグループと状態から削除する (移動や離脱時のクリーンアップ)
function removePlayerFromAllGroups(playerId) {
    for (const groupId in groups) {
        if (groups[groupId] && groups[groupId].players) {
            groups[groupId].players = groups[groupId].players.filter(p => p.playerId !== playerId);
        }
    }
    for (const groupId in states) {
        if (states[groupId] && states[groupId].players) {
            states[groupId].players = states[groupId].players.filter(p => p.playerId !== playerId);
        }
    }
}

function parseAndSetCards(data) {
    const torifudas = [];
    const yomifudas = [];
    const dataToParse = data.rawData || data.cards;
    const isNewFormat = !!data.rawData;

    for (const row of dataToParse) {
        if (isNewFormat) {
            if (row.col1 && row.col1.startsWith('def_')) {
                torifudas.push({ id: row.col1, term: row.col2 });
            } else if(row.col1 && row.col2 && row.col3){
                yomifudas.push({ answer: row.col1, term: row.col2, text: row.col3 });
            }
        } else { // 旧フォーマット
            torifudas.push({ id: `def_${row.number}`, term: row.term });
            yomifudas.push({ answer: row.term, term: row.term, text: row.text });
        }
    }
    globalTorifudas = [...torifudas];
    globalYomifudas = [...yomifudas];
}

// --- マルチプレイ用ゲームロジック ---
function initState(groupId) {
    return {
        groupId,
        players: [],
        questionCount: 0,
        maxQuestions: globalSettings.maxQuestions || 10,
        numCards: globalSettings.numCards || 5,
        showSpeed: globalSettings.showSpeed || 1000,
        gameMode: globalSettings.gameMode || 'normal',
        isPaused: false, // 一時停止フラグ
        current: null, answered: false, waitingNext: false,
        usedQuestions: new Set(), readTimer: null, eliminatedOrder: [], locked: false
    };
}

// クライアントに送る用の安全なstateオブジェクトを生成
function sanitizeState(state) {
    if (!state) return null;
    // current.answerをクライアントに送らないようにする
    const currentForClient = state.current ? {
        text: state.current.text,
        maskedIndices: state.current.maskedIndices,
        point: state.current.point,
        cards: state.current.cards
    } : null;

    return {
        groupId: state.groupId,
        players: state.players,
        questionCount: state.questionCount,
        maxQuestions: state.maxQuestions,
        gameMode: state.gameMode,
        isPaused: state.isPaused,
        current: currentForClient,
        locked: state.locked,
        answered: state.answered,
    };
}

// ホストに送る用の全グループの状態を生成
function getHostState() {
    const result = {};
    for (const [groupId, group] of Object.entries(groups)) {
        const state = states[groupId] || initState(groupId);
        result[groupId] = {
            locked: state.locked,
            isPaused: state.isPaused,
            gameMode: state.gameMode,
            players: group.players.map(p => {
                const playerMaster = getPlayer(p.playerId);
                const statePlayer = state.players.find(sp => sp.playerId === p.playerId);
                return {
                    playerId: p.playerId,
                    name: playerMaster?.name || "取得失敗",
                    hp: statePlayer?.hp ?? 20,
                    correctCount: statePlayer?.correctCount ?? 0,
                    totalScore: playerMaster?.totalScore ?? 0,
                    isOnline: playerMaster?.isOnline ?? false
                };
            })
        };
    }
    return result;
}

// ゲーム終了処理
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

    finalRanking.forEach((p, i) => {
        const playerMaster = getPlayer(p.playerId);
        if (!playerMaster) return;

        const correctCount = p.correctCount || 0;
        let bonus = (i === 0) ? 200 : (i === 1) ? 100 : 0;
        p.finalScore = (correctCount * 10) + bonus;
        
        // 累計スコアをマスターデータに加算
        playerMaster.totalScore = (playerMaster.totalScore || 0) + p.finalScore;
        p.totalScore = playerMaster.totalScore;
    });

    io.to(groupId).emit("end", finalRanking.sort((a, b) => b.finalScore - a.finalScore));
    
    const hostSocket = getHostSocket();
    if (hostSocket) io.to(hostSocket.id).emit("host_state", getHostState());
}

function checkGameEnd(groupId) {
    const state = states[groupId];
    if (!state || state.locked) return;
    const survivors = state.players.filter(p => p.hp > 0);
    if (survivors.length <= 1 && state.players.length > 1) {
        finalizeGame(groupId);
    }
}

// 次の問題を出す処理
function nextQuestion(groupId) {
    const state = states[groupId];
    if (!state || state.locked || state.isPaused) return;

    if (state.readTimer) clearTimeout(state.readTimer);
    state.readTimer = null;

    const remainingYomifudas = globalYomifudas.filter(y => !state.usedQuestions.has(y.text));
    
    if (remainingYomifudas.length === 0 || state.questionCount >= state.maxQuestions) {
        return finalizeGame(groupId);
    }
    
    const question = remainingYomifudas[Math.floor(Math.random() * remainingYomifudas.length)];
    state.usedQuestions.add(question.text);

    const correctTorifuda = globalTorifudas.find(t => t.term === question.answer);
    if (!correctTorifuda) {
        console.error(`Error: Correct torifuda not found for answer "${question.answer}"`);
        return nextQuestion(groupId); // 再帰呼び出しで次の問題へ
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
        let indices = Array.from({length: originalText.length}, (_, i) => i).filter(i => !/\s/.test(originalText[i]));
        shuffle(indices);
        maskedIndices = indices.slice(0, Math.floor(indices.length / 2));
    }
    
    state.current = {
        text: originalText,
        maskedIndices: maskedIndices,
        answer: question.answer, // サーバー側だけで保持
        point,
        cards: cards.map(c => ({ id: c.id, term: c.term }))
    };
    state.questionCount++;
    state.waitingNext = false;
    state.answered = false;
    
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
        let indices = Array.from({length: originalText.length}, (_, i) => i).filter(i => !/\s/.test(originalText[i]));
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


// --- ソケットイベントリスナー ---
io.on("connection", (socket) => {
    console.log(`✅ プレイヤーが接続しました: ${socket.id}`);

    // 新規プレイヤーIDの発行
    socket.on('request_new_player_id', () => {
        const playerId = uuidv4();
        players[playerId] = { playerId, socketId: socket.id, name: "未設定", totalScore: 0, isHost: false, isOnline: true };
        socket.emit('new_player_id_assigned', playerId);
        console.log(`発行: ${playerId.substring(0,8)}`);
    });

    // プレイヤー再接続
    socket.on('reconnect_player', ({ playerId, name }) => {
        if (players[playerId]) {
            players[playerId].socketId = socket.id;
            players[playerId].isOnline = true;
            if (name) players[playerId].name = name;
            console.log(`🔄 ${players[playerId].name}(${playerId.substring(0,8)})が再接続しました。`);

            // ホストとして復帰した場合
            if (players[playerId].isHost && playerId === hostPlayerId) {
                console.log("👑 ホストが復帰しました。");
                socket.emit("host_setup_done"); // ホストUIを表示させる
            }

        } else {
            players[playerId] = { playerId, socketId: socket.id, name: name || "未設定", totalScore: 0, isHost: false, isOnline: true };
            console.log(`新規(再): ${playerId.substring(0,8)}`);
        }
    });
    
    socket.on('request_game_phase', ({ fromEndScreen = false } = {}) => {
        loadPresets();
        const presetsForClient = {};
        for(const [id, data] of Object.entries(questionPresets)) {
            presetsForClient[id] = { category: data.category, name: data.name };
        }
        socket.emit('game_phase_response', { phase: gamePhase, presets: presetsForClient, fromEndScreen, hostPlayerId });
    });

    // ホストが設定を決定
    socket.on("set_cards_and_settings", ({ rawData, settings, isNextGame }) => {
        const player = Object.values(players).find(p => p.socketId === socket.id);
        if (!player || player.playerId !== hostPlayerId) return;

        parseAndSetCards({ rawData });
        globalSettings = { ...settings, maxQuestions: globalYomifudas.length };

        if (!isNextGame) {
            Object.keys(states).forEach(key => delete states[key]);
            Object.keys(groups).forEach(key => delete groups[key]);
            Object.values(players).forEach(p => p.totalScore = 0); 
            gamePhase = 'GROUP_SELECTION';
        } else {
            Object.keys(states).forEach(key => delete states[key]);
            gamePhase = 'WAITING_FOR_NEXT_GAME';
        }
        io.to(socket.id).emit('host_setup_done');
        io.emit("multiplayer_status_changed", gamePhase);
    });

    // プレイヤーがグループに参加
    socket.on("join", ({ groupId, playerId }) => {
        const player = getPlayer(playerId);
        if (!player) return;

        removePlayerFromAllGroups(playerId);
        
        const socketInstance = io.sockets.sockets.get(player.socketId);
        if (socketInstance) {
            socketInstance.rooms.forEach(room => {
                if (room !== socketInstance.id) socketInstance.leave(room);
            });
        }
        
        socket.join(groupId);

        if (!groups[groupId]) groups[groupId] = { players: [] };
        if (!states[groupId]) states[groupId] = initState(groupId);

        if (!groups[groupId].players.some(p => p.playerId === playerId)) {
            groups[groupId].players.push({ playerId, name: player.name });
        }
        if (!states[groupId].players.some(p => p.playerId === playerId)) {
            states[groupId].players.push({ playerId, name: player.name, hp: 20, correctCount: 0 });
        }
        
        const hostSocket = getHostSocket();
        if (hostSocket) io.to(hostSocket.id).emit("host_state", getHostState());
    });
    
    socket.on("rejoin_game", ({ playerId }) => {
        for (const [gId, group] of Object.entries(groups)) {
            if (group.players.some(p => p.playerId === playerId)) {
                const state = states[gId];
                if (state && !state.locked) {
                    socket.join(gId);
                    socket.emit('rejoin_game', sanitizeState(state));
                } else {
                    socket.emit('game_phase_response', { phase: gamePhase, hostPlayerId });
                }
                return;
            }
        }
        socket.emit('game_phase_response', { phase: gamePhase, hostPlayerId });
    });
    
    socket.on("set_name", ({ groupId, playerId, name }) => {
        const player = getPlayer(playerId);
        if (player) player.name = name;
    
        if (groups[groupId]) {
            const gPlayer = groups[groupId].players.find(p => p.playerId === playerId);
            if (gPlayer) gPlayer.name = name;
        }
        if (states[groupId]) {
            const statePlayer = states[groupId].players.find(p => p.playerId === playerId);
            if (statePlayer) statePlayer.name = name;
            io.to(groupId).emit("state", sanitizeState(states[groupId]));
        }
        
        const hostSocket = getHostSocket();
        if (hostSocket) io.to(hostSocket.id).emit("host_state", getHostState());
    });

    socket.on("read_done", (groupId) => {
        const state = states[groupId];
        if (!state || !state.current || state.readTimer || state.answered || state.waitingNext || state.isPaused) return;

        io.to(groupId).emit("timer_start", { seconds: 30 });

        state.readTimer = setTimeout(() => {
            if (state && !state.answered && !state.waitingNext && !state.isPaused) {
                state.waitingNext = true;
                const correctCard = state.current.cards.find(c => c.term === state.current.answer);
                if (correctCard) {
                   const sanitizedCards = state.current.cards.map(c => ({...c, isCorrectAnswer: c.id === correctCard.id}));
                   io.to(groupId).emit("answer_reveal", sanitizedCards);
                }
                setTimeout(() => nextQuestion(groupId), 3000);
            }
        }, 30000);
    });

    socket.on("answer", ({ groupId, playerId, id }) => {
        const state = states[groupId];
        if (!state || !state.current || state.answered || state.locked || state.isPaused) return;

        const playerState = state.players.find(p => p.playerId === playerId);
        const playerMaster = getPlayer(playerId);
        if (!playerState || !playerMaster || playerState.hp <= 0) return;
        
        const answeredTorifuda = globalTorifudas.find(t => t.id === id);
        if (!answeredTorifuda) return;
        
        const correct = state.current.answer === answeredTorifuda.term;
        const point = state.current.point;

        if (correct) {
            state.answered = true;
            if (state.readTimer) clearTimeout(state.readTimer);

            playerState.correctCount = (playerState.correctCount || 0) + 1;
            
            state.players.forEach(p => {
                if (p.playerId !== playerId) p.hp = Math.max(0, p.hp - point);
            });
            
            io.to(groupId).emit("correct_answer", {
                playerId, name: playerMaster.name, cardId: id, updatedPlayers: state.players
            });
            
            checkGameEnd(groupId);
            if (!state.locked) setTimeout(() => nextQuestion(groupId), 3000);

        } else {
            playerState.hp = Math.max(0, playerState.hp - point);
            io.to(groupId).emit("incorrect_answer", {
                playerId, name: playerMaster.name, cardId: id, updatedPlayer: playerState
            });
            checkGameEnd(groupId);
        }
    });

    // --- ホスト専用イベント ---
    socket.on("host_join", ({ playerId }) => {
        const currentHost = getPlayer(hostPlayerId);
        if (currentHost && currentHost.isOnline && currentHost.socketId !== socket.id) {
            socket.emit('error_message', '既に他の人がホストとして参加しています。');
            return;
        }

        if (hostPlayerId && hostPlayerId !== playerId) {
            const oldHost = getPlayer(hostPlayerId);
            if (oldHost) oldHost.isHost = false;
        }

        hostPlayerId = playerId;
        const newHost = getPlayer(playerId);
        if (newHost) {
            newHost.isHost = true;
            console.log(`👑 ホストが参加/交代しました: ${newHost.name} (${playerId.substring(0,8)})`);
            socket.emit('request_game_phase');
        }
    });

    socket.on("host_request_state", () => {
        if (getPlayer(hostPlayerId)?.socketId === socket.id) {
            socket.emit("host_state", getHostState());
        }
    });

    socket.on("host_start", () => {
        if (getPlayer(hostPlayerId)?.socketId !== socket.id) return;
        console.log("▶ ホストが全体スタートを実行");

        gamePhase = 'GAME_IN_PROGRESS';
        for (const groupId of Object.keys(groups)) {
            if (!groups[groupId] || groups[groupId].players.length === 0) continue;
            
            const currentGroupMode = states[groupId]?.gameMode || globalSettings.gameMode;
            states[groupId] = initState(groupId);
            states[groupId].gameMode = currentGroupMode;
            
            states[groupId].players = groups[groupId].players.map(p => {
                const playerMaster = getPlayer(p.playerId);
                return { playerId: p.playerId, name: playerMaster?.name || '不明', hp: 20, correctCount: 0 };
            });
            
            nextQuestion(groupId);
        }
        io.emit("multiplayer_status_changed", gamePhase);
    });

    socket.on("host_assign_groups", ({ groupCount, topGroupCount, groupSizes }) => {
        if (getPlayer(hostPlayerId)?.socketId !== socket.id) return;

        const allPlayersList = Object.values(players)
            .filter(p => p.isOnline && !p.isHost && p.name !== "未設定")
            .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));

        const numTopPlayers = groupSizes.slice(0, topGroupCount).reduce((sum, size) => sum + size, 0);
        const topPlayers = allPlayersList.slice(0, numTopPlayers);
        const otherPlayers = shuffle(allPlayersList.slice(numTopPlayers));

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
        for(let i = topGroupCount + 1; i <= groupCount; i++) {
             const capacity = groupSizes[i-1] || 0;
             while(newGroupsConfig[i].length < capacity && otherPlayerIndex < otherPlayers.length) {
                 newGroupsConfig[i].push(otherPlayers[otherPlayerIndex++]);
             }
        }
        
        const unassignedPlayers = [...topPlayers.slice(topPlayerIndex), ...otherPlayers.slice(otherPlayerIndex)];
        if (unassignedPlayers.length > 0) {
            console.log(`${unassignedPlayers.length}人のプレイヤーが溢れました。空きに追加します。`);
            let unassignedIndex = 0;
            for (let i = 1; i <= groupCount; i++) {
                if (unassignedIndex >= unassignedPlayers.length) break;
                newGroupsConfig[i].push(unassignedPlayers[unassignedIndex++]);
            }
        }

        Object.keys(groups).forEach(k => delete groups[k]);
        Object.keys(states).forEach(k => delete states[k]);

        for (let i = 1; i <= groupCount; i++) {
            const pInGroup = newGroupsConfig[i];
            if (!pInGroup || pInGroup.length === 0) continue;
            const gId = `group${i}`;
            groups[gId] = { players: pInGroup.map(p => ({playerId: p.playerId, name: p.name})) };
            states[gId] = initState(gId);
            states[gId].players = pInGroup.map(p => ({ playerId: p.playerId, name: p.name, hp: 20, correctCount: 0 }));

            for (const p of pInGroup) {
                const player = getPlayer(p.playerId);
                const pSocket = player ? io.sockets.sockets.get(player.socketId) : null;
                if (pSocket) {
                    pSocket.rooms.forEach(room => { if(room !== pSocket.id) pSocket.leave(room); });
                    pSocket.join(gId);
                    pSocket.emit("assigned_group", gId);
                }
            }
        }
        
        socket.emit("host_state", getHostState());
    });
    
    socket.on('host_toggle_pause', (groupId) => {
        if (getPlayer(hostPlayerId)?.socketId !== socket.id) return;
        const state = states[groupId];
        if (!state) return;

        state.isPaused = !state.isPaused;
        console.log(`[${groupId}] is now ${state.isPaused ? 'paused' : 'resumed'}.`);

        if (state.isPaused) {
            if (state.readTimer) {
                clearTimeout(state.readTimer);
                state.readTimer = null;
            }
        } else {
            if (!state.answered && state.current && !state.waitingNext) {
                 // 3秒後に再開
                 setTimeout(() => nextQuestion(groupId), 3000);
            }
        }
        
        io.to(groupId).emit('game_paused_status', state.isPaused);
        socket.emit("host_state", getHostState());
    });

    socket.on('host_preparing_next_game', () => {
        if (getPlayer(hostPlayerId)?.socketId !== socket.id) return;
        Object.keys(states).forEach(key => delete states[key]); 
        gamePhase = 'WAITING_FOR_NEXT_GAME';
        io.emit("multiplayer_status_changed", gamePhase);
        socket.broadcast.emit('wait_for_next_game');
        socket.emit('request_game_phase', { fromEndScreen: true });
    });

    socket.on('host_full_reset', () => {
        if (getPlayer(hostPlayerId)?.socketId !== socket.id) return;
        console.log('🚨 ホストによってゲームが完全にリセットされました。');
        hostPlayerId = null;
        globalTorifudas = [];
        globalYomifudas = [];
        globalSettings = {};
        gamePhase = 'INITIAL';
        Object.keys(players).forEach(key => delete players[key]);
        Object.keys(groups).forEach(key => delete groups[key]);
        Object.keys(states).forEach(key => delete states[key]);
        io.emit('force_reload', 'ホストによってゲームがリセットされました。ページをリロードします。');
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
            allTorifudas: singleTorifudas, allYomifudas: singleYomifudas,
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

        globalRanking.forEach(r => { if (r.playerId === playerId) r.isMe = true; });

        socket.emit('single_game_end', { score, personalBest, globalRanking, presetName });
        delete singlePlayStates[socket.id];
    });

    // --- 切断処理 ---
    socket.on("disconnect", (reason) => {
        console.log(`🔌 プレイヤーが切断しました: ${socket.id}, reason: ${reason}`);
        const disconnectedPlayer = Object.values(players).find(p => p.socketId === socket.id);
        if (disconnectedPlayer) {
            disconnectedPlayer.isOnline = false;
            console.log(`👻 ${disconnectedPlayer.name} がオフラインになりました。`);
            
            // もしホストが切断したら、復帰を待つ
            if (disconnectedPlayer.playerId === hostPlayerId) {
                console.log("⚠️ ホストが切断されました。復帰を待機します。");
            }
            
            const hostSocket = getHostSocket();
            if (hostSocket) io.to(hostSocket.id).emit("host_state", getHostState());
        }
        delete singlePlayStates[socket.id];
    });
});

// --- サーバー起動 ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => { // "0.0.0.0" を追加して外部からのアクセスを許可
    console.log(`✅ Server running on http://0.0.0.0:${PORT}`);
});

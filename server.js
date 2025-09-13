// server.js (ステップ2: 「ひとりでプレイ」対応修正版 - 全文)

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

// (初期化処理、ヘルパー関数は変更なし)
function initializeDirectories() { /* ... */ }
function loadPresets() { /* ... */ }
function shuffle(array) { /* ... */ }
function getPlayerBySocketId(socketId) { /* ... */ }
function parseAndSetCards(data) { /* ... */ }
function resetAllGameData() { /* ... */ }
function initState(groupId) { /* ... */ }
function sanitizeState(state) { /* ... */ }
function getHostState() { /* ... */ }
function finalizeGame(groupId) { /* ... */ }
function checkGameEnd(groupId) { /* ... */ }
function processRoundResults(groupId) { /* ... */ }
function nextQuestion(groupId) { /* ... */ }
function readRankingFile(filePath) { /* ... */ }
function writeRankingFile(filePath, data) { /* ... */ }

// --- シングルプレイ用ヘルパー ---
function nextSingleQuestion(socketId) {
    const state = singlePlayStates[socketId];
    if (!state) return;
    
    // 質問とカードの選択ロジック
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
    
    // stateを更新
    state.current = {
        text: originalText,
        maskedIndices: maskedIndices,
        answer: question.answer,
        cards: cards.map(c => ({ id: c.id, term: c.term }))
    };
    state.answered = false;
    state.startTime = Date.now();

    // 対応するクライアントにstateを送信
    io.to(socketId).emit('single_game_state', state);
}

function notifyHostStateChanged() { /* ... (変更なし) ... */ }


// --- メインの接続処理 ---
io.on("connection", (socket) => {
  console.log(`✅ プレイヤーが接続しました: ${socket.id}`);

    socket.on('request_solo_presets', () => {
    const presetsForClient = Object.fromEntries(
      Object.entries(questionPresets).map(([id, data]) => [id, { category: data.category, name: data.name }])
    );
    // ★専用のイベント名で返信する
    socket.emit('solo_presets_list', presetsForClient);
  });
  socket.on('request_new_player_id', () => {
    const playerId = uuidv4();
    players[playerId] = { playerId, socketId: socket.id, name: "未設定", isHost: false, totalScore: 0 };
    socket.emit('new_player_id_assigned', playerId);
  });

  socket.on('reconnect_player', ({ playerId, name }) => {
    if (players[playerId]) {
      players[playerId].socketId = socket.id;
      if (name) players[playerId].name = name;
    } else {
      players[playerId] = { playerId, socketId: socket.id, name: name || "未設定", isHost: false, totalScore: 0 };
    }
    console.log(`🔄 ${players[playerId].name}(${playerId.substring(0,4)})が再接続しました。`);

    if (players[playerId].isHost && playerId === hostPlayerId) {
        hostSocketId = socket.id;
        console.log("👑 ホストが復帰しました:", players[playerId].name);
        socket.emit('host_reconnect_success'); // 新UIではホスト画面再描画を促す
    }
  });

  // ★新しいイベント 'request_presets_for_upload'
  socket.on('request_presets_for_upload', () => {
    const presetsForClient = Object.fromEntries(
      Object.entries(questionPresets).map(([id, data]) => [id, { category: data.category, name: data.name }])
    );
    socket.emit('presets_for_upload', presetsForClient);
  });

  // ★新しいイベント 'request_presets'
  socket.on('request_presets', () => {
    const presetsForClient = Object.fromEntries(Object.entries(questionPresets).map(([id, data]) => [id, { category: data.category, name: data.name }]));
    socket.emit('presets_list', presetsForClient);
  });

  // (個人戦関連のイベントは変更なし)
  socket.on('host_join', ({ playerId }) => { /* ... */ });
  socket.on("set_preset_and_settings", ({ presetId, settings, isNextGame }) => { /* ... */ });
  socket.on("set_cards_and_settings", ({ rawData, settings, presetInfo, isNextGame, saveAction, presetId }) => { /* ... */ });
  socket.on("join", ({ groupId, playerId }) => { /* ... */ });
  socket.on("rejoin_game", ({ playerId }) => { /* ... */ });
  socket.on("set_name", ({ groupId, playerId, name }) => { /* ... */ });
  socket.on("read_done", (groupId) => { /* ... */ });
  socket.on("host_request_state", () => { /* ... */ });
  socket.on("request_global_ranking", () => { /* ... */ });
  socket.on("host_start", () => { /* ... */ });
  socket.on("host_assign_groups", ({ groupCount, topGroupCount, groupSizes }) => { /* ... */ });
  socket.on("answer", ({ groupId, playerId, name, id }) => { /* ... */ });
  socket.on('host_preparing_next_game', () => { /* ... */ });
  socket.on('host_full_reset', () => { /* ... */ });
  socket.on('host_set_group_mode', ({ groupId, gameMode }) => { /* ... */ });
  socket.on('host_export_data', () => { /* ... */ });
  socket.on('host_import_data', (data) => { /* ... */ });
  socket.on('host_delete_preset', ({ presetId }) => { /* ... */ });


  // ★★★ 「ひとりでプレイ」関連のイベントハンドラを修正 ★★★

  socket.on('start_single_play', ({ name, playerId, difficulty, presetId }) => {
    if (players[playerId]) players[playerId].name = name;
    
    const presetData = questionPresets[presetId];
    if (!presetData) {
        console.error(`Error: Preset with id ${presetId} not found.`);
        return;
    }

    // 問題データをパース
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
    
    // ★ socket.id をキーとしてstateを保存
    singlePlayStates[socket.id] = {
        name, playerId, difficulty, presetId,
        allTorifudas: singleTorifudas,
        allYomifudas: singleYomifudas,
        score: 0, current: null, answered: false, startTime: 0,
        presetName: `${presetData.category} - ${presetData.name}`,
        totalQuestions: singleYomifudas.length
    };

    // ★★★修正: 準備完了後、'single_game_start'を送信してクライアントの画面を切り替える
    // このイベントに初期stateを含める
    io.to(socket.id).emit('single_game_start', singlePlayStates[socket.id]);
    
    // 最初の問題を開始
    nextSingleQuestion(socket.id);
  });

  socket.on('single_answer', ({ id }) => {
    // ★ socket.id を使ってstateを取得
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
    
    // (ランキング処理は変更なし)
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
    globalRanking.sort((a, b) => b.score - a.score).splice(10);
    writeRankingFile(globalRankingFile, { ranking: globalRanking });
    globalRanking.forEach(r => { if (r.playerId === playerId) r.isMe = true; });
    
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
    }
    const player = getPlayerBySocketId(socket.id);
    if (player) {
      console.log(`👻 ${player.name} がオフラインになりました。`);
    }
    // ★ 切断時にシングルプレイのstateを削除
    delete singlePlayStates[socket.id];
  });
});

// (サーバー起動コードは変更なし)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
